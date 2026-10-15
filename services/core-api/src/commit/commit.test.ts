// T-005 gates on embedded Postgres: idempotent replay (byte-identical body), 409 on a reused key, the
// advisory lock under concurrency, app.command_type set for the book guard, rollback on handler error,
// 20 commands → 20 audit rows that verify, tamper → the verifier names the seq, and post-commit publishing
// through the Publisher port (the HTTP adapter's end-to-end gates: test/publisher-http-e2e.test.ts).
import { buildWorld, startTestDb, type TestDb } from "@munim/db";
import { CommandResult, REPLAYED_HEADER, type CloudEvent, type CommandEnvelope } from "@munim/contracts";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mintRunToken, verifyRunToken } from "../runtoken/index.ts";
import { verifyAuditChain } from "./audit.ts";
import { uuidv7 } from "./canonical.ts";
import { CommandTypeMismatch, executeCommand, IdempotencyConflict, replayHeaders, type CommandHandler, type CoreTx, type EventDraft } from "./execute.ts";
import { createRowPublisher, eventOutletScope, OutboxRowInvalid, outboxRowToCloudEvent, publishCommitted, StoredEvent, type Publisher } from "./outbox.ts";
import { ownerContext, ownerTx, provisionTenant, svcTx, testKeys, type Tenant } from "./testkit.ts";

let db: TestDb;
let A: Tenant;

beforeAll(async () => {
  db = await startTestDb();
  A = await provisionTenant(db);
}, 120_000);
afterAll(async () => db?.stop());

/** Synthetic outlet named by the fixture's outlet-specific event (ids only; no FK from event data). */
const EVENT_OUTLET = uuidv7();

/** A second synthetic outlet for the multi-outlet fixture event. */
const EVENT_OUTLET_2 = uuidv7();

/** Fixture events of registered contract types (events/index.ts): one naming `outlet_id`, one naming
 *  `outlet_ids` (two outlets). Every registered W1 type names at least one outlet. */
function fixtureEvent(kind: "outlet" | "outlets", subject: string): EventDraft {
  return kind === "outlet"
    ? { type: "munim.orders.order.placed.v1", subject, aggregateType: "order",
        data: { order_id: subject, outlet_id: EVENT_OUTLET, channel_id: uuidv7(), status: "placed", placed_at: new Date().toISOString() } }
    : { type: "munim.purchasing.po.committed.v1", subject, aggregateType: "purchase_order",
        data: { po_id: subject, supplier_id: uuidv7(), outlet_ids: [EVENT_OUTLET, EVENT_OUTLET_2], decision_id: null, draft_id: null } };
}

/** A real book write: creates a channel (core.channel is munim:book) as the owner's own command, and emits
 *  one fixture event (`events` overrides it). */
function channelHandler(calls: { n: number } = { n: 0 }, events?: (id: string) => EventDraft[]): CommandHandler {
  return { type: "tenancy.channel.create.v1", run: async (c, cmd) => {
    calls.n++;
    const id = uuidv7();
    await c.query(`INSERT INTO core.channel (tenant_id, id, name, kind) VALUES (current_setting('app.tenant_id')::uuid, $1, $2, 'counter')`,
      [id, String(cmd.payload.name)]);
    return {
      entityId: id,
      audit: [{ entity: "core.channel", entityId: id, after: { name: cmd.payload.name, kind: "counter" } }],
      events: events ? events(id) : [fixtureEvent("outlet", id)],
    };
  } };
}

function cmd(name: string, key = `key-${uuidv7()}`): CommandEnvelope {
  return { command_id: uuidv7(), idempotency_key: key, type: "tenancy.channel.create.v1", payload: { name, z: 1, a: [1, { b: 2, a: 1 }] } };
}

const count = async (sql: string, params: unknown[]) => Number((await db.admin<{ n: string }>(sql, params)).rows[0]!.n);

describe("idempotency", () => {
  test("replay → byte-identical body, handler ran once, one command_log row; RED-PROOF without the stored row → body differs", async () => {
    const calls = { n: 0 };
    const c1 = cmd("Counter");
    const first = await executeCommand(ownerContext(db, A), c1, channelHandler(calls));
    const replay = await executeCommand(ownerContext(db, A), structuredClone(c1), channelHandler(calls));
    console.log(`replay: first ${first.body.length} bytes, replay ${replay.body.length} bytes, identical=${first.body === replay.body}, handler runs=${calls.n}`);
    expect(replay.body).toBe(first.body);
    expect([first.replayed, replay.replayed]).toEqual([false, true]);
    expect(calls.n).toBe(1);
    expect(CommandResult.parse(JSON.parse(first.body)).command_id).toBe(c1.command_id);
    // Replay is signalled only by the header (contracts REPLAYED_HEADER); the stored body has no such field.
    expect(first.body).not.toContain("replayed");
    expect([replayHeaders(first), replayHeaders(replay)]).toEqual([{}, { [REPLAYED_HEADER]: "true" }]);
    expect(replay.outbox).toEqual([]);
    expect(first.outbox).toHaveLength(1);
    expect(await count(`SELECT count(*) AS n FROM core.command_log WHERE tenant_id = $1 AND idempotency_key = $2`, [A.tenant, c1.idempotency_key])).toBe(1);

    // RED-PROOF: remove the stored result (superuser) — the "replay" now re-executes and its body differs.
    await db.admin(`DELETE FROM core.command_log WHERE tenant_id = $1 AND idempotency_key = $2`, [A.tenant, c1.idempotency_key]);
    const rerun = await executeCommand(ownerContext(db, A), structuredClone(c1), channelHandler(calls));
    console.log(`RED-PROOF replay: identical=${rerun.body === first.body}, handler runs=${calls.n}`);
    expect(rerun.body).not.toBe(first.body);
    expect(calls.n).toBe(2);
  });

  test("same key + different request → 409 idempotency_conflict, nothing written; control: a fresh key succeeds", async () => {
    const c1 = cmd("Pickup");
    await executeCommand(ownerContext(db, A), c1, channelHandler());
    const audit = await count(`SELECT count(*) AS n FROM core.audit_log WHERE tenant_id = $1`, [A.tenant]);
    const calls = { n: 0 };
    const changed = { ...c1, payload: { ...c1.payload, name: "Pickup 2" } };
    const err = await executeCommand(ownerContext(db, A), changed, channelHandler(calls)).catch((e: unknown) => e);
    console.log(`different hash: ${(err as IdempotencyConflict).status} ${(err as IdempotencyConflict).code}`);
    expect(err).toBeInstanceOf(IdempotencyConflict);
    expect((err as IdempotencyConflict).status).toBe(409);
    expect((err as IdempotencyConflict).code).toBe("idempotency_conflict");
    expect(calls.n).toBe(0);
    expect(await count(`SELECT count(*) AS n FROM core.audit_log WHERE tenant_id = $1`, [A.tenant])).toBe(audit);
    // A different person with the same key and body is a different request too.
    const otherId = uuidv7();
    const other = await executeCommand({ tx: ownerTx(db, A, { member_id: otherId }), tenantId: A.tenant, actor: { kind: "member", id: otherId, role: "owner" } },
      c1, channelHandler(calls)).catch((e: unknown) => e);
    expect(other).toBeInstanceOf(IdempotencyConflict);
    // Control: the changed request under its own key is accepted.
    const ok = await executeCommand(ownerContext(db, A), { ...changed, idempotency_key: `key-${uuidv7()}` }, channelHandler(calls));
    expect(ok.replayed).toBe(false);
    expect(calls.n).toBe(1);
  });

  test("8 concurrent identical requests → handler runs once, 8 identical bodies, exactly 1 not replayed", async () => {
    const calls = { n: 0 };
    const c1 = cmd("Concurrent");
    const results = await Promise.all([...Array(8).keys()].map(() => executeCommand(ownerContext(db, A), structuredClone(c1), channelHandler(calls))));
    expect(calls.n).toBe(1);
    expect(new Set(results.map((r) => r.body)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
  });
});

describe("transaction", () => {
  test("app.command_type is set for the book guard (origin stamped); RED-PROOF: the same insert without it → MB001", async () => {
    const r = await executeCommand(ownerContext(db, A), cmd("Guarded"), channelHandler());
    const id = (JSON.parse(r.body) as CommandResult).entity_id;
    const origin = (await db.admin<{ origin: Record<string, string> }>(`SELECT origin FROM core.channel WHERE tenant_id = $1 AND id = $2`, [A.tenant, id])).rows[0]!.origin;
    expect(origin).toMatchObject({ kind: "command", command_type: "tenancy.channel.create.v1", role: "owner", principal_id: A.owner });
    const err = await ownerTx(db, A)((c) => channelHandler().run(c, cmd("Unguarded"))).catch((e: { code?: string }) => e);
    console.log(`RED-PROOF command_type: raw insert without app.command_type → ${(err as { code?: string }).code}`);
    expect((err as { code?: string }).code).toBe("MB001");
  });

  test("a handler runs only under its own command type; RED-PROOF: the guard alone lets staff close a shift under the open type", async () => {
    // core.shift is in the target_tables of both orders.shift.open.v1 (staff may run it) and
    // orders.shift.close.v1 (manager and up), so MB008 cannot tell them apart — only the handler binding can.
    const w = await buildWorld(db);
    const staffCtx = { tenant_id: w.tenant, outlet_ids: [w.outlets[0]], role: "staff", member_id: w.staff };
    const staffActor = { kind: "member" as const, id: w.staff, role: "staff" };
    const openShift: CommandHandler = { type: "orders.shift.open.v1", run: async (c) => {
      const id = uuidv7();
      await c.query(`INSERT INTO core.shift (tenant_id, id, outlet_id, opened_by, float_minor, currency) VALUES ($1, $2, $3, $4, 100000, $5)`,
        [w.tenant, id, w.outlets[0], w.staff, w.currency]);
      return { entityId: id, audit: [{ entity: "core.shift", entityId: id, after: { status: "open" } }] };
    } };
    const closeShift = (shift: string): CommandHandler => ({ type: "orders.shift.close.v1", run: async (c) => {
      const r = await c.query(`UPDATE core.shift SET status = 'closed', closed_by = $3, closed_at = now(),
                                     counted_cash_minor = 100000, expected_cash_minor = 100000, variance_minor = 0 WHERE tenant_id = $1 AND id = $2`,
        [w.tenant, shift, w.staff]);
      if (r.rowCount !== 1) throw new Error("no shift closed");
      return { entityId: shift, audit: [{ entity: "core.shift", entityId: shift, after: { status: "closed" } }] };
    } });
    const shiftCmd = (type: string): CommandEnvelope => ({ command_id: uuidv7(), idempotency_key: `key-${uuidv7()}`, type, payload: {} });
    const staffTx: CoreTx = (fn) => db.withContext("munim_core", staffCtx, fn);
    const status = async (id: string) => (await db.admin<{ status: string }>(`SELECT status FROM core.shift WHERE tenant_id = $1 AND id = $2`, [w.tenant, id])).rows[0]!.status;

    const s1 = (JSON.parse((await executeCommand({ tx: staffTx, tenantId: w.tenant, actor: staffActor }, shiftCmd("orders.shift.open.v1"), openShift)).body) as CommandResult).entity_id;
    const s2 = (JSON.parse((await executeCommand({ tx: staffTx, tenantId: w.tenant, actor: staffActor }, shiftCmd("orders.shift.open.v1"), openShift)).body) as CommandResult).entity_id;
    // RED-PROOF: app.command_type = the staff-allowed open type, running the close handler's write → admitted.
    await db.withContext("munim_core", { ...staffCtx, command_type: "orders.shift.open.v1" }, (c) => closeShift(s1).run(c, shiftCmd("orders.shift.open.v1")));
    console.log(`RED-PROOF command binding: guard alone let staff close shift → status ${await status(s1)}`);
    expect(await status(s1)).toBe("closed");
    // executeCommand refuses the same smuggle before touching the database.
    const err = await executeCommand({ tx: staffTx, tenantId: w.tenant, actor: staffActor }, shiftCmd("orders.shift.open.v1"), closeShift(s2))
      .catch((e: unknown) => e);
    console.log(`command binding: executeCommand → ${(err as CommandTypeMismatch).status} ${(err as CommandTypeMismatch).code}, shift ${await status(s2)}`);
    expect(err).toBeInstanceOf(CommandTypeMismatch);
    expect((err as CommandTypeMismatch).status).toBe(422);
    expect(await status(s2)).toBe("open");
    // And under its own type the guard refuses staff (manager and up only).
    const own = await executeCommand({ tx: staffTx, tenantId: w.tenant, actor: staffActor }, shiftCmd("orders.shift.close.v1"), closeShift(s2))
      .catch((e: { code?: string }) => e);
    expect((own as { code?: string }).code).toMatch(/^MB00[18]$/);
    expect(await status(s2)).toBe("open");
  });

  test("ctx identity must match the SET LOCAL identity (actor, tenant, decision) or nothing is written", async () => {
    const audit = () => count(`SELECT count(*) AS n FROM core.audit_log WHERE tenant_id = $1`, [A.tenant]);
    const before = await audit();
    const wrongActor = await executeCommand({ ...ownerContext(db, A), actor: { kind: "member", id: uuidv7(), role: "owner" } }, cmd("X"), channelHandler())
      .catch((e: Error) => e.message);
    const wrongRole = await executeCommand({ ...ownerContext(db, A), actor: { kind: "member", id: A.owner, role: "manager" } }, cmd("X"), channelHandler())
      .catch((e: Error) => e.message);
    const wrongDecision = await executeCommand({ ...ownerContext(db, A), decisionId: uuidv7() }, cmd("X"), channelHandler()).catch((e: Error) => e.message);
    for (const m of [wrongActor, wrongRole, wrongDecision]) expect(m).toContain("does not match the transaction's SET LOCAL identity");
    expect(await audit()).toBe(before);
  });

  test("F7: event data is parsed against its registered type schema at write time; RED-PROOF: the generic envelope schema accepts what it refuses", async () => {
    const outbox = () => count(`SELECT count(*) AS n FROM core.outbox WHERE tenant_id = $1`, [A.tenant]);
    const before = await outbox();
    const withAmount = (id: string): EventDraft => {
      const e = fixtureEvent("outlet", id);
      return { ...e, data: { ...e.data, total_minor: 125000 } };
    };
    const numericLeaf = (id: string): EventDraft => {
      const e = fixtureEvent("outlet", id);
      return { ...e, data: { ...e.data, outlet_id: 42 } };
    };
    const unknownType = (id: string): EventDraft => ({ type: "munim.tenancy.channel.created.v1", subject: id, aggregateType: "channel", data: { channel_id: id } });
    const errs: string[] = [];
    for (const ev of [withAmount, numericLeaf, unknownType]) {
      errs.push(await executeCommand(ownerContext(db, A), cmd("Bad event"), channelHandler(undefined, (id) => [ev(id)])).then(() => "accepted", (e: Error) => e.name === "ZodError" ? "ZodError" : e.message));
    }
    console.log(`F7: extra amount key → ${errs[0]} | numeric outlet_id → ${errs[1]} | unknown type → ${errs[2]}`);
    expect(errs.slice(0, 2)).toEqual(["ZodError", "ZodError"]);
    expect(errs[2]).toContain("has no registered contract schema");
    expect(await outbox()).toBe(before);
    // RED-PROOF: the envelope-only check (the pre-F7 write path) passes all three.
    const envelope = (e: EventDraft) => ({ specversion: "1.0", id: uuidv7(), time: new Date().toISOString(), datacontenttype: "application/json",
      tenantid: A.tenant, source: `/tenants/${A.tenant}/${e.type.split(".")[1]}`, type: e.type, subject: e.subject, data: e.data });
    const generic = [withAmount, numericLeaf, unknownType].map((ev) => StoredEvent.safeParse(envelope(ev(uuidv7()))).success);
    console.log(`RED-PROOF F7: generic envelope schema accepts ${generic.filter(Boolean).length}/3`);
    expect(generic).toEqual([true, true, true]);
  });

  test("a handler error rolls back audit, outbox and command_log", async () => {
    const before = await count(`SELECT (SELECT count(*) FROM core.audit_log WHERE tenant_id = $1) + (SELECT count(*) FROM core.outbox WHERE tenant_id = $1)
                                       + (SELECT count(*) FROM core.command_log WHERE tenant_id = $1) AS n`, [A.tenant]);
    const failing: CommandHandler = { type: "tenancy.channel.create.v1", run: async (c, k) => {
      await channelHandler().run(c, k);
      throw new Error("handler failed after writing");
    } };
    await expect(executeCommand(ownerContext(db, A), cmd("Doomed"), failing)).rejects.toThrow("handler failed");
    expect(before).toBeGreaterThan(0);
    expect(await count(`SELECT (SELECT count(*) FROM core.audit_log WHERE tenant_id = $1) + (SELECT count(*) FROM core.outbox WHERE tenant_id = $1)
                               + (SELECT count(*) FROM core.command_log WHERE tenant_id = $1) AS n`, [A.tenant])).toBe(before);
  });
});

describe("audit chain", () => {
  test("20 commands → 20 audit rows, verifier ok; tamper one row as munim_migrator → verifier reports that seq", async () => {
    const B = await provisionTenant(db);
    for (let i = 0; i < 20; i++) await executeCommand(ownerContext(db, B), cmd(`Channel ${i}`), channelHandler());
    const rows = await count(`SELECT count(*) AS n FROM core.audit_log WHERE tenant_id = $1`, [B.tenant]);
    const v = await verifyAuditChain(svcTx(db), B.tenant);
    console.log(`audit: ${rows} rows in core.audit_log; verifier ${JSON.stringify(v)}`);
    expect(rows).toBe(20);
    expect(v).toEqual({ ok: true, rows: 20, firstBadSeq: null });

    // Runtime roles cannot rewrite history at all.
    const denied = await db.withContext("munim_core", { tenant_id: B.tenant }, (c) =>
      c.query(`UPDATE core.audit_log SET action = 'x' WHERE tenant_id = $1 AND seq = 7`, [B.tenant])).catch((e: { code?: string }) => e);
    expect((denied as { code?: string }).code).toBe("42501");

    // RED-PROOF: the table owner rewrites seq 7's `after` (hash left as stored).
    const x = await db.clone();
    try {
      const c = await x.connect("admin");
      try {
        await c.query("BEGIN");
        await c.query("SET LOCAL ROLE munim_migrator");
        await c.query(`SELECT set_config('app.tenant_id', $1, true)`, [B.tenant]);
        const u = await c.query(`UPDATE core.audit_log SET after = '{"name": "Channel 6", "kind": "pickup"}' WHERE tenant_id = $1 AND seq = 7`, [B.tenant]);
        expect(u.rowCount).toBe(1);
        await c.query("COMMIT");
      } finally {
        await c.end();
      }
      const bad = await verifyAuditChain(svcTx(x), B.tenant);
      console.log(`RED-PROOF audit tamper (seq 7 as munim_migrator): ${JSON.stringify(bad)}`);
      expect(bad).toEqual({ ok: false, rows: 20, firstBadSeq: 7 });
      await x.admin(`DELETE FROM core.audit_log WHERE tenant_id = $1 AND seq IN (7, 12)`, [B.tenant]);
      const gap = await verifyAuditChain(svcTx(x), B.tenant);
      console.log(`RED-PROOF audit delete (seq 7, 12): ${JSON.stringify(gap)}`);
      expect(gap).toEqual({ ok: false, rows: 18, firstBadSeq: 8 });
    } finally {
      await x.stop();
    }
  });
});

describe("post-commit publishing (Publisher port)", () => {
  const keys = testKeys();

  test("the transaction's events are published with a verifiable run token and marked published_at", async () => {
    const got: CloudEvent[] = [];
    const publisher: Publisher = { publish: async (events) => void got.push(...events) };
    const r = await executeCommand(ownerContext(db, A, { publish: { publisher, svc: svcTx(db), keys } }), cmd("Published"), channelHandler());
    const id = (JSON.parse(r.body) as CommandResult).entity_id;
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ type: "munim.orders.order.placed.v1", subject: id, tenantid: A.tenant, source: `/tenants/${A.tenant}/orders` });
    const v = await verifyRunToken({ ...keys, svc: svcTx(db) }, got[0]!.munimrun);
    expect(v.ok && v.claims).toMatchObject({ tenant_id: A.tenant, trigger: "event", actor: "watcher:events", outlet_scope: [EVENT_OUTLET] });
    expect(await count(`SELECT count(*) AS n FROM core.outbox WHERE tenant_id = $1 AND id = $2 AND published_at IS NOT NULL`, [A.tenant, got[0]!.id])).toBe(1);
  });

  test("sweeper path: createRowPublisher re-encodes a stored row with a fresh event run; a row whose envelope disagrees is refused", async () => {
    const r = await executeCommand(ownerContext(db, A), cmd("Swept"), channelHandler()); // no publish deps → left unpublished
    const id = (JSON.parse(r.body) as CommandResult).entity_id;
    const row = (await db.admin<{ tenant_id: string; id: string; payload: unknown }>(
      `SELECT tenant_id::text, id::text, payload FROM core.outbox WHERE tenant_id = $1 AND aggregateid = $2`, [A.tenant, id])).rows[0]!;
    const got: CloudEvent[] = [];
    await createRowPublisher({ publisher: { publish: async (e) => void got.push(...e) }, svc: svcTx(db), keys }).publish(row);
    expect(got.map((e) => e.id)).toEqual([row.id]);
    const v = await verifyRunToken({ ...keys, svc: svcTx(db) }, got[0]!.munimrun);
    expect(v.ok && v.claims).toMatchObject({ tenant_id: A.tenant, trigger: "event", actor: "watcher:events" });
    expect(() => outboxRowToCloudEvent({ ...row, id: uuidv7() }, got[0]!.munimrun)).toThrow(OutboxRowInvalid);
  });

  test("sweeper path: a contract-invalid row rejects with a PoisonRowError-shaped OutboxRowInvalid before any run is minted or sent; control: a valid row mints one run", async () => {
    const runs = () => count(`SELECT count(*) AS n FROM intel.run WHERE tenant_id = $1`, [A.tenant]);
    let sent = 0;
    const rp = createRowPublisher({ publisher: { publish: async (e) => { sent += e.length; } }, svc: svcTx(db), keys });
    const r = await executeCommand(ownerContext(db, A), cmd("Poison source"), channelHandler());
    const good = { tenant_id: A.tenant, id: r.outbox[0]!.id, payload: r.outbox[0]!.payload };
    const base = await runs();
    await rp.publish(good);
    expect([await runs() - base, sent]).toEqual([1, 1]);
    const poisoned = [
      { ...good, payload: { ...(good.payload as object), type: "munim.tenancy.channel.created.v1" } },
      { ...good, payload: { ...(good.payload as { data: object }), data: { ...(good.payload as { data: object }).data, total_minor: 1 } } },
      { ...good, id: uuidv7() },
    ];
    const errs = await Promise.all(poisoned.map((p) => rp.publish(p).then(() => null, (e: unknown) => e)));
    console.log(`poison rows: ${errs.map((e) => `${(e as Error).name}/${(e as OutboxRowInvalid).reason}`).join(", ")}; runs minted ${await runs() - base - 1}, sent ${sent - 1}`);
    for (const e of errs) {
      expect(e).toBeInstanceOf(OutboxRowInvalid);
      expect(e).toMatchObject({ name: "PoisonRowError", reason: "contract_invalid" });
    }
    expect([await runs() - base, sent]).toEqual([1, 1]);
  });

  test("ruling #18: event runs take the narrowest covering outlet scope (outlet_id → [it], outlet_ids → those, neither → ['*']) on the request and sweeper paths; RED-PROOF: ['*'] tokens on outlet events fail the check", async () => {
    const got: CloudEvent[] = [];
    const publisher: Publisher = { publish: async (events) => void got.push(...events) };
    const deps = { publisher, svc: svcTx(db), keys };
    const verify = { ...keys, svc: svcTx(db) };
    const scopeOf = async (e: CloudEvent) => { const v = await verifyRunToken(verify, e.munimrun); return v.ok ? v.claims.outlet_scope : null; };
    /** The gate's check, computed independently from the delivered event's data. */
    const expectedScope = (e: CloudEvent) => {
      const d = e.data as { outlet_id?: string; outlet_ids?: string[] };
      return d.outlet_id ? [d.outlet_id] : d.outlet_ids?.length ? d.outlet_ids : ["*"];
    };
    const scopeOk = async (e: CloudEvent) => JSON.stringify(await scopeOf(e)) === JSON.stringify(expectedScope(e));
    await executeCommand(ownerContext(db, A, { publish: deps }), cmd("Outlet event"), channelHandler(undefined, (id) => [fixtureEvent("outlet", id)]));
    await executeCommand(ownerContext(db, A, { publish: deps }), cmd("Outlets event"), channelHandler(undefined, (id) => [fixtureEvent("outlets", id)]));
    const swept = await executeCommand(ownerContext(db, A), cmd("Swept outlets event"), channelHandler(undefined, (id) => [fixtureEvent("outlets", id)]));
    await createRowPublisher(deps).publish({ tenant_id: A.tenant, id: swept.outbox[0]!.id, payload: swept.outbox[0]!.payload });
    const scopes = await Promise.all(got.map(scopeOf));
    console.log(`run scopes: outlet_id event ${JSON.stringify(scopes[0])}, outlet_ids event ${JSON.stringify(scopes[1])}, swept outlet_ids event ${JSON.stringify(scopes[2])}`);
    expect(scopes).toEqual([[EVENT_OUTLET], [EVENT_OUTLET, EVENT_OUTLET_2], [EVENT_OUTLET, EVENT_OUTLET_2]]);
    expect(await Promise.all(got.map(scopeOk))).toEqual([true, true, true]);
    // Neither field (no registered W1 type lacks both, so the pure function is checked directly).
    expect(eventOutletScope({ data: { po_id: uuidv7() } })).toEqual(["*"]);
    expect(eventOutletScope({ data: { outlet_ids: [] } })).toEqual(["*"]);
    // RED-PROOF: the same outlet_id and outlet_ids events carrying a tenant-wide run token fail the check.
    const wide = await mintRunToken(verify, { tenantId: A.tenant, outletScope: ["*"], trigger: "event", actor: "watcher:events" });
    const forced = await Promise.all([got[0]!, got[1]!].map((e) => scopeOk({ ...e, munimrun: wide.token })));
    console.log(`RED-PROOF run scope: outlet_id event with ['*'] → ${forced[0]}, outlet_ids event with ['*'] → ${forced[1]}`);
    expect(forced).toEqual([false, false]);
  });

  test("outer transaction (approvals): outbox rows come back, invisible until the outer commit, then published by publishCommitted; RED-PROOF: publishing inside the outer tx delivers uncommitted rows that then stay unpublished", async () => {
    const got: CloudEvent[] = [];
    const deps = { publisher: { publish: async (events: readonly CloudEvent[]) => void got.push(...events) } as Publisher, svc: svcTx(db), keys };
    const unpublished = (id: string) => count(`SELECT count(*) AS n FROM core.outbox WHERE tenant_id = $1 AND id = $2 AND published_at IS NULL`, [A.tenant, id]);
    const committed = (id: string) => count(`SELECT count(*) AS n FROM core.outbox WHERE tenant_id = $1 AND id = $2`, [A.tenant, id]);

    // Right: executeCommand inside an outer transaction without `publish`; publish after the outer commit.
    let visibleBeforeCommit = -1;
    const r = await ownerTx(db, A)(async (c) => {
      const inner = await executeCommand({ ...ownerContext(db, A), tx: (fn) => fn(c) }, cmd("Inside approval"), channelHandler());
      visibleBeforeCommit = await committed(inner.outbox[0]!.id);
      return inner;
    });
    expect(r.outbox).toHaveLength(1);
    expect(visibleBeforeCommit).toBe(0);
    await publishCommitted(deps, A.tenant, r.outbox);
    console.log(`outer tx: rows returned ${r.outbox.length}, visible before outer commit ${visibleBeforeCommit}, delivered ${got.length}, unpublished after ${await unpublished(r.outbox[0]!.id)}`);
    expect(got.map((e) => e.id)).toEqual([r.outbox[0]!.id]);
    expect(await unpublished(r.outbox[0]!.id)).toBe(0);

    // RED-PROOF: `publish` inside the outer transaction fires before that commit.
    got.length = 0;
    const bad = await ownerTx(db, A)((c) =>
      executeCommand({ ...ownerContext(db, A), tx: (fn) => fn(c), publish: deps }, cmd("Published too early"), channelHandler()));
    console.log(`RED-PROOF outer tx: delivered ${got.length} before commit, unpublished after commit ${await unpublished(bad.outbox[0]!.id)}`);
    expect(got).toHaveLength(1);
    expect(await unpublished(bad.outbox[0]!.id)).toBe(1);
  });

  test("publisher failure → the request still succeeds, the row stays unpublished, ids reported", async () => {
    const publisher: Publisher = { publish: async () => { throw new Error("intel down"); } };
    let deferred: string[] = [];
    const r = await executeCommand(ownerContext(db, A, {
      publish: { publisher, svc: svcTx(db), keys },
      onPublishDeferred: (ids) => { deferred = ids; },
    }), cmd("Unpublished"), channelHandler());
    expect(r.replayed).toBe(false);
    expect(deferred).toHaveLength(1);
    expect(await count(`SELECT count(*) AS n FROM core.outbox WHERE tenant_id = $1 AND id = $2 AND published_at IS NULL`, [A.tenant, deferred[0]])).toBe(1);
  });
});

describe("customer requests (0014 F4: customers cannot read or write command_log, audit_log, outbox)", () => {
  test("a customer-placed order writes command_log/audit/outbox rows, the customer context still reads 0 of them, replay works; RED-PROOF: the same bookkeeping under the customer role → 42501", async () => {
    const w = await buildWorld(db);
    const custCtx = { tenant_id: w.tenant, outlet_ids: [] as string[], role: "customer", customer_id: w.customer };
    const custTx: CoreTx = (fn) => db.withContext("munim_core", custCtx, fn);
    const actor = { kind: "customer" as const, id: w.customer, role: "customer" };
    const place: CommandHandler = { type: "orders.place.v1", run: async (c) => {
      const id = uuidv7();
      await c.query(`INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, kind, status, subtotal_minor, tax_minor, total_minor, currency, pricing_snapshot, customer_id)
                     VALUES ($1, $2, $3, $4, 'pickup', 'placed', 1000, 0, 1000, $5, '{}', $6)`, [w.tenant, id, w.outlets[0], w.channel, w.currency, w.customer]);
      return {
        entityId: id,
        audit: [{ entity: "core.order", entityId: id, after: { status: "placed" } }],
        events: [{ type: "munim.orders.order.placed.v1", subject: id, aggregateType: "order",
          data: { order_id: id, outlet_id: w.outlets[0], channel_id: w.channel, status: "placed", placed_at: new Date().toISOString() } }],
      };
    } };
    const got: CloudEvent[] = [];
    const c1: CommandEnvelope = { command_id: uuidv7(), idempotency_key: `key-${uuidv7()}`, type: "orders.place.v1", payload: {} };
    const ctx = { tx: custTx, tenantId: w.tenant, actor, publish: { publisher: { publish: async (e: readonly CloudEvent[]) => void got.push(...e) }, svc: svcTx(db), keys: testKeys() } };
    const first = await executeCommand(ctx, c1, place);
    const replay = await executeCommand(ctx, structuredClone(c1), place);
    const order = (JSON.parse(first.body) as CommandResult).entity_id;

    const counts = {
      command_log: await count(`SELECT count(*) AS n FROM core.command_log WHERE tenant_id = $1 AND idempotency_key = $2`, [w.tenant, c1.idempotency_key]),
      audit: await count(`SELECT count(*) AS n FROM core.audit_log WHERE tenant_id = $1 AND entity_id = $2 AND actor->>'kind' = 'customer' AND actor->>'id' = $3`, [w.tenant, order, w.customer]),
      outbox: await count(`SELECT count(*) AS n FROM core.outbox WHERE tenant_id = $1 AND aggregateid = $2 AND published_at IS NOT NULL`, [w.tenant, order]),
    };
    const seen = await custTx(async (c) => {
      const n = async (sql: string) => Number((await c.query<{ n: string }>(sql, [w.tenant])).rows[0]!.n);
      return {
        command_log: await n(`SELECT count(*) AS n FROM core.command_log WHERE tenant_id = $1`),
        audit: await n(`SELECT count(*) AS n FROM core.audit_log WHERE tenant_id = $1`),
        outbox: await n(`SELECT count(*) AS n FROM core.outbox WHERE tenant_id = $1`),
        own_order: Number((await c.query<{ n: string }>(`SELECT count(*) AS n FROM core."order" WHERE tenant_id = $1 AND id = $2`, [w.tenant, order])).rows[0]!.n),
      };
    });
    console.log(`customer order: written ${JSON.stringify(counts)}, events delivered ${got.length}; customer context reads ${JSON.stringify(seen)}; replay identical=${replay.body === first.body} replayed=${replay.replayed}`);
    expect(counts).toEqual({ command_log: 1, audit: 1, outbox: 1 });
    expect(got).toHaveLength(1);
    expect(seen).toEqual({ command_log: 0, audit: 0, outbox: 0, own_order: 1 });
    expect([replay.body === first.body, replay.replayed]).toEqual([true, true]);

    // RED-PROOF: the same three bookkeeping writes without clearing the customer role.
    const codes: string[] = [];
    for (const sql of [
      `INSERT INTO core.audit_log (tenant_id, actor, action, entity, entity_id) VALUES ($1, '{"kind":"customer"}', 'orders.place.v1', 'core.order', '${order}')`,
      `INSERT INTO core.outbox (tenant_id, id, aggregatetype, aggregateid, type, payload) VALUES ($1, '${uuidv7()}', 'order', '${order}', 'munim.orders.order.placed.v1', '{}')`,
      `INSERT INTO core.command_log (tenant_id, idempotency_key, command_id, command_type, actor, request_hash, result) VALUES ($1, 'key-${uuidv7()}', '${uuidv7()}', 'orders.place.v1', '{}', '${"0".repeat(64)}', '{}')`,
    ]) {
      codes.push(await custTx((c) => c.query(sql, [w.tenant])).then(() => "accepted", (e: { code?: string }) => e.code ?? "?"));
    }
    console.log(`RED-PROOF customer bookkeeping without clearing app.role: audit ${codes[0]}, outbox ${codes[1]}, command_log ${codes[2]}`);
    expect(codes).toEqual(["42501", "42501", "42501"]);
  });
});
