// T-008 gates — the approvals module through the real app (member auth → withContext → RLS → book guard).
//   concurrent approve + edit-approve → exactly 1 execution; changed based_on cell → stale, 0 executions
//   (unchanged → 1); staff → 403 authority_denied, owner → 200 with the price row written under the decision;
//   manager of another outlet → 404; typed_by ≠ approver → 422; reject without reason → 422, with → 200 and
//   0 handler runs; replayed approve → same bytes, 1 execution; unregistered command type → 422.
// Handlers here are TEST-ONLY stand-ins for the W2 module handlers; each writes only its command's table.
// Synthetic data only.
import { createLogger } from "@munim/config";
import { CommandResult, draftableTypes, snapRef } from "@munim/contracts";
import { DraftDecisionError, DraftDetailResponse, DraftsListResponse, DraftView } from "@munim/contracts/approvals";
import { buildWorld, type TestDb } from "@munim/db";
import type { Hono } from "hono";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppEnv, createApp, TENANT_HEADER } from "../src/app.ts";
import { type CommandHandler, uuidv7, verifyAuditChain } from "../src/commit/index.ts";
import { svcTx, testKeys } from "../src/commit/testkit.ts";
import { createLocalIdp } from "../src/auth/local-idp.ts";
import { registerDraftHandler } from "../src/modules/approvals/index.ts";
import { draftHandler } from "../src/modules/approvals/handlers.ts";
import { bindNamedParams, runTemplate } from "../src/modules/approvals/snapshots.ts";
import { openDb } from "./db.ts";

const idp = createLocalIdp();
let db: TestDb;
let pools: { core: pg.Pool; svc: pg.Pool };
let app: Hono<AppEnv>;
const unregister: Array<() => void> = [];
const slow = new Set<string>(); // price ids whose test handler holds the transaction open (race test)

// The tenant is m-1's buildWorld (MB008-correct); this file adds login subs, two outlet managers, an advisor, and its
// own item / ingredients / reorder levels so it does not depend on the world's book rows.
const T = {
  tenant: "", owner: "", staff: "", mgr1: uuidv7(), mgr2: uuidv7(), advisor: uuidv7(),
  outlets: ["", ""] as [string, string],
  item: uuidv7(), ing: [uuidv7(), uuidv7()] as [string, string], supplier: "",
  worldDrafts: [] as string[],
  subs: { owner: `owner-${uuidv7()}`, staff: `staff-${uuidv7()}`, mgr1: `mgr1-${uuidv7()}`, mgr2: `mgr2-${uuidv7()}`, advisor: `advisor-${uuidv7()}` },
};
type Who = keyof typeof T.subs;

// TEST-ONLY stand-ins, registered only while no real (W2) handler holds the type. Each writes only its command's
// table. Execution counts come from the database (executed-draft audit entries), so they hold for real handlers too.
const priceHandler: CommandHandler = {
  type: "catalogue.price.set.v1",
  async run(c, cmd) {
    const p = cmd.payload as Record<string, unknown>;
    if (slow.has(p.price_id as string)) await c.query("SELECT pg_sleep(0.4)");
    await c.query(
      `INSERT INTO core.price (tenant_id, id, item_id, variant_id, outlet_id, channel_kind, amount_minor, currency, tax_class, valid_from, valid_to)
       VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [p.price_id, p.item_id, p.variant_id, p.outlet_id, p.channel_kind, p.amount_minor, p.currency, p.tax_class, p.valid_from, p.valid_to]);
    return { entityId: p.price_id as string, audit: [{ entity: "core.price", entityId: p.price_id as string, after: { price_id: p.price_id } }] };
  },
};
const reorderHandler: CommandHandler = {
  type: "inventory.reorder_level.set.v1",
  async run(c, cmd) {
    const p = cmd.payload as Record<string, unknown>;
    const r = await c.query<{ id: string }>(
      `UPDATE core.reorder_level SET min_qty_milli = $3, par_qty_milli = $4 WHERE outlet_id = $1 AND ingredient_id = $2 RETURNING id`,
      [p.outlet_id, p.ingredient_id, p.min_qty_milli, p.par_qty_milli]);
    return { entityId: r.rows[0]!.id, audit: [{ entity: "core.reorder_level", entityId: r.rows[0]!.id }] };
  },
};
// Emits a real W1 event so the after-commit publish is observable. Registered only inside its own test.
const poHandler: CommandHandler = {
  type: "purchasing.po.create.v1",
  async run(c, cmd) {
    const p = cmd.payload as { po_id: string; supplier_id: string; outlet_ids: string[]; currency: string; expected_on: string | null;
      lines: Array<{ ingredient_id: string; qty_milli: number; unit: string; unit_price_minor: number }> };
    const total = p.lines.reduce((t, l) => t + Math.round((l.qty_milli * l.unit_price_minor) / 1000), 0);
    await c.query(`INSERT INTO core.purchase_order (tenant_id, id, supplier_id, outlet_ids, currency, total_minor, expected_on)
                   VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6)`, [p.po_id, p.supplier_id, p.outlet_ids, p.currency, total, p.expected_on]);
    for (const [i, l] of p.lines.entries()) {
      await c.query(`INSERT INTO core.po_line (tenant_id, id, po_id, line_no, ingredient_id, qty_milli, unit, unit_price_minor)
                     VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, $7)`, [uuidv7(), p.po_id, i + 1, l.ingredient_id, l.qty_milli, l.unit, l.unit_price_minor]);
    }
    const d = (await c.query<{ id: string; draft_id: string }>(`SELECT id, draft_id FROM core.decision WHERE id = current_setting('app.decision_id')::uuid`)).rows[0]!;
    return {
      entityId: p.po_id,
      audit: [{ entity: "core.purchase_order", entityId: p.po_id }],
      events: [{ type: "munim.purchasing.po.committed.v1", subject: p.po_id, aggregateType: "purchase_order",
        data: { po_id: p.po_id, supplier_id: p.supplier_id, outlet_ids: p.outlet_ids, decision_id: d.id, draft_id: d.draft_id } }],
    };
  },
};
/** Every event the publisher received, and whether its PO row was already COMMITTED (visible to another session). */
const published: Array<{ type: string; data: Record<string, unknown>; committed: boolean }> = [];

const executions = async (type?: string) => count(
  `SELECT count(*) n FROM core.audit_log a JOIN core.draft r ON r.tenant_id = a.tenant_id AND r.id::text = a.entity_id
    WHERE a.tenant_id = $1 AND a.entity = 'core.draft' AND a.after->>'status' = 'executed' AND ($2::text IS NULL OR r.command_type = $2)`,
  [T.tenant, type ?? null]);

const own = (command_type: string) => ({ tenant_id: T.tenant, outlet_ids: "*" as const, role: "owner" as const, member_id: T.owner, command_type });
const svc = { tenant_id: "", outlet_ids: "*" as const, role: "service" as const };

async function setup() {
  const w = await buildWorld(db);
  Object.assign(T, { tenant: w.tenant, owner: w.owner, staff: w.staff, outlets: [w.outlets[0], w.outlets[1]], worldDrafts: [...w.drafts], supplier: w.supplier });
  await db.withContext("munim_core", own("tenancy.member.invite.v1"), async (c) => {
    // buildWorld's owner and staff (staff scoped to outlet 1) get login subs; managers and an advisor join.
    await c.query(`UPDATE core.member SET idp_sub = $2 WHERE id = $1`, [T.owner, T.subs.owner]);
    await c.query(`UPDATE core.member SET idp_sub = $2 WHERE id = $1`, [T.staff, T.subs.staff]);
    for (const [who, role, outlets] of [["mgr1", "manager", [T.outlets[0]]], ["mgr2", "manager", [T.outlets[1]]], ["advisor", "advisor", []]] as const) {
      await c.query(`INSERT INTO core.member (tenant_id, id, idp_sub, name, email) VALUES ($1, $2, $3, $4, $5)`, [T.tenant, T[who], T.subs[who], `Synthetic ${who}`, `${who}@example.test`]);
      await c.query(`INSERT INTO core.membership (tenant_id, member_id, role, outlet_ids) VALUES ($1, $2, $3, $4)`, [T.tenant, T[who], role, outlets]);
    }
  });
  await db.withContext("munim_core", own("catalogue.item.upsert.v1"), (c) =>
    c.query(`INSERT INTO core.item (tenant_id, id, kind, name_key, category) VALUES ($1, $2, 'dish', 'approvals_test_dish', 'mains')`, [T.tenant, T.item]));
  await db.withContext("munim_core", own("inventory.ingredient.upsert.v1"), async (c) => {
    for (const [i, id] of T.ing.entries()) await c.query(`INSERT INTO core.ingredient (tenant_id, id, name, base_unit) VALUES ($1, $2, $3, 'g')`, [T.tenant, id, `Synthetic ingredient ${i + 1}`]);
  });
  await db.withContext("munim_core", own("inventory.reorder_level.set.v1"), async (c) => {
    for (const id of T.ing) {
      await c.query(`INSERT INTO core.reorder_level (tenant_id, id, outlet_id, ingredient_id, min_qty_milli, par_qty_milli) VALUES ($1, $2, $3, $4, 1000, 5000)`,
        [T.tenant, uuidv7(), T.outlets[0], id]);
    }
  });
  // Test-only template (fixture DB clone): a suggested price, keyed by item — exercises :param binding.
  await db.admin(`INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES
    ('test.price_suggestion', 1, $1, '{"type":"object"}', $2, 'manager')`, [
    `SELECT i.id AS item_id, 25000::bigint AS suggested_minor FROM core.item i WHERE i.id = :item_id::uuid AND i.category <> 'x:not_a_param'`,
    JSON.stringify([{ name: "item_id", type: "uuid" }, { name: "suggested_minor", type: "integer", numeric_source: "core.price.amount_minor" }]),
  ]);
}

/** Intel's path: an event run mints a snapshot by running the template (as munim_svc under the tenant). */
async function mint(templateId: string, params: Record<string, unknown>, scope: string[] = ["*"]): Promise<string> {
  const id = uuidv7();
  await db.withContext("munim_svc", { ...svc, tenant_id: T.tenant }, async (c) => {
    const run = uuidv7();
    await c.query(`INSERT INTO intel.run (tenant_id, id, trigger, actor, outlet_scope, expires_at) VALUES ($1, $2, 'event', 'watcher:events', $3, now() + interval '1 hour')`, [T.tenant, run, scope]);
    const { rows } = await runTemplate(c, templateId, 1, params);
    await c.query(`INSERT INTO evidence.snapshot (tenant_id, id, template_id, template_version, params, run_id, outlet_scope, rows, row_count, sha256)
                   VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, repeat('0', 64))`, [T.tenant, id, templateId, params, run, scope, JSON.stringify(rows), rows.length]);
  });
  return id;
}

async function draft(command_type: string, payload: Record<string, unknown>, basedOn: string[] = [], outlets = [T.outlets[0]]): Promise<string> {
  const id = uuidv7();
  await db.withContext("munim_svc", { ...svc, tenant_id: T.tenant }, (c) =>
    c.query(`INSERT INTO core.draft (tenant_id, id, outlet_ids, source, command_type, command_payload, based_on) VALUES ($1, $2, $3, 'intel:catalogue', $4, $5, $6)`,
      [T.tenant, id, outlets, command_type, payload, JSON.stringify(basedOn)]));
  return id;
}

/** A date `n` days from today (UTC), so no draft here goes stale as the calendar moves (R3-M4). */
const inDays = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

let priceSnap: string;
const suggested = () => snapRef(priceSnap, 0, "suggested_minor");
/** Drafts with a valid registered payload (the ones the contract read schemas can parse). */
const contractDrafts = new Set<string>();
async function priceDraft(channel = "counter", validFrom = inDays(30), o: { outlets?: string[]; ref?: string; price?: string } = {}) {
  const price = o.price ?? uuidv7();
  const ref = o.ref ?? suggested();
  const payload: Record<string, unknown> = {
    price_id: price, item_id: T.item, variant_id: null, outlet_id: T.outlets[0], channel_kind: channel,
    amount_minor: ref, currency: "INR", tax_class: "restaurant_5", valid_from: validFrom, valid_to: null,
  };
  const id = await draft("catalogue.price.set.v1", payload, [ref], o.outlets ?? [T.outlets[0]]);
  contractDrafts.add(id);
  return { id, price, payload };
}
/** A 409/422 from approve/reject, parsed with the contract's `drafts.decision-error`. */
const refusal = async (r: Res) => DraftDecisionError.parse(await r.json());

// Response bodies are asserted field by field (and parsed with the contract schemas where one exists).
type Res = Omit<Response, "json"> & { json(): Promise<any> };
const call = async (method: string, path: string, who: Who, body?: unknown): Promise<Res> =>
  (await app.request(path, {
    method,
    headers: { Authorization: `Bearer ${idp.sign({ sub: T.subs[who] })}`, [TENANT_HEADER]: T.tenant, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })) as Res;
const approveBody = (draftId: string, command_type: string, edited: Record<string, unknown> | null = null, key = `approve-${uuidv7()}`) => ({
  command_id: uuidv7(), idempotency_key: key, type: "drafts.approve.v1",
  payload: { draft_id: draftId, command_type, edited_payload: edited, reason: edited ? "Rounded to the menu price" : null },
});
const approve = (who: Who, draftId: string, body = approveBody(draftId, "catalogue.price.set.v1")) => call("POST", `/v1/drafts/${draftId}:approve`, who, body);
const one = async <R extends pg.QueryResultRow>(sql: string, params: unknown[] = []) => (await db.admin(sql, params)).rows[0] as R;
const count = async (sql: string, params: unknown[] = []) => Number((await one<{ n: string }>(sql, params)).n);
const statusOf = async (id: string) => (await one<{ status: string }>(`SELECT status FROM core.draft WHERE id = $1`, [id])).status;

beforeAll(async () => {
  db = await openDb();
  await setup();
  priceSnap = await mint("test.price_suggestion", { item_id: T.item });
  pools = { core: db.pool("munim_core", 8), svc: db.pool("munim_svc", 2) };
  const config = { nodeEnv: "test", redact: (s: string) => s };
  const publisher = {
    async publish(events: ReadonlyArray<{ type: string; data: unknown }>) {
      for (const e of events) {
        const data = e.data as Record<string, unknown>;
        published.push({ type: e.type, data, committed: (await count(`SELECT count(*) n FROM core.purchase_order WHERE id = $1`, [data.po_id])) === 1 });
      }
    },
  };
  app = await createApp({
    pools, idp, storefronts: async () => null, config, log: createLogger(config, () => {}),
    publish: { publisher, svc: svcTx(db), keys: testKeys() },
  });
  // After createApp (which imports the W2 modules that register real handlers): stand-ins fill only free types.
  for (const h of [priceHandler, reorderHandler]) if (!draftHandler(h.type)) unregister.push(registerDraftHandler(h));
});

afterAll(async () => {
  for (const u of unregister) u();
  await pools?.core.end();
  await pools?.svc.end();
  await db?.stop();
});

describe("authority and scope", () => {
  it("staff approving a catalogue.price.set.v1 draft → 403 authority_denied; owner → 200 with the price row written under the decision", async () => {
    const d = await priceDraft();
    const before = await executions();
    const denied = await approve("staff", d.id);
    expect(denied.status).toBe(403);
    // `forbidden` is this module's own check; the DB trigger's MB006 would surface as `decision_refused`.
    expect(await denied.json()).toEqual({ error: { code: "forbidden", message: expect.any(String), reason_code: "authority_denied" } });
    expect(await statusOf(d.id)).toBe("proposed");
    expect(await count(`SELECT count(*) n FROM core.price WHERE id = $1`, [d.price])).toBe(0);
    expect(await executions()).toBe(before);

    const ok = await approve("owner", d.id);
    expect(ok.status).toBe(200);
    const result = CommandResult.parse(await ok.json());
    expect(result).toMatchObject({ type: "catalogue.price.set.v1", entity_id: d.price });
    expect(ok.headers.get("X-Munim-Replayed")).toBeNull();
    const price = await one<{ amount_minor: string; origin: { kind: string; decision_id: string } }>(`SELECT amount_minor, origin FROM core.price WHERE id = $1`, [d.price]);
    // The value executed is the snapshot cell, not anything in the payload text.
    expect(price.amount_minor).toBe("25000");
    expect(price.origin.kind).toBe("decision");
    const dec = await one<{ verdict: string; decided_by: string; draft_id: string }>(`SELECT verdict, decided_by, draft_id FROM core.decision WHERE id = $1`, [price.origin.decision_id]);
    expect(dec).toEqual({ verdict: "approved", decided_by: T.owner, draft_id: d.id });
    expect(await statusOf(d.id)).toBe("executed");
    expect(await executions()).toBe(before + 1);
  });

  it("a manager of another outlet → 404 (not 403) on get and approve; the outlet's own manager sees it", async () => {
    const d = await priceDraft("table_qr");
    expect((await call("GET", `/v1/drafts/${d.id}`, "mgr2")).status).toBe(404);
    const r = await approve("mgr2", d.id);
    expect(r.status).toBe(404);
    expect((await r.json()).error.code).toBe("not_found");
    expect(await statusOf(d.id)).toBe("proposed");
    expect((await call("GET", `/v1/drafts/${d.id}`, "mgr1")).status).toBe(200);
  });

  it("F5: a tenant-wide draft (outlet_ids '{}') needs '*': owner → 200; advisor ('*', no approve role) → 403; outlet manager → 404 (RLS)", async () => {
    const d = await priceDraft("aggregator:swiggy", inDays(30), { outlets: [] });
    expect((await approve("mgr1", d.id)).status).toBe(404); // RLS: an empty outlet set overlaps no outlet scope
    const adv = await approve("advisor", d.id);
    expect([adv.status, (await adv.json()).error]).toEqual([403, { code: "forbidden", message: expect.any(String), reason_code: "authority_denied" }]);
    expect(await statusOf(d.id)).toBe("proposed");
    const ok = await approve("owner", d.id);
    expect(ok.status).toBe(200);
    expect(await statusOf(d.id)).toBe("executed");
  });

  it("ruling #18: a draft citing an outlet-scoped run's snapshot → that outlet's manager verifies and approves (200)", async () => {
    const snap = await mint("test.price_suggestion", { item_id: T.item }, [T.outlets[0]]);
    const d = await priceDraft("aggregator:zomato", inDays(30), { ref: snapRef(snap, 0, "suggested_minor") });
    const view = DraftDetailResponse.parse(await (await call("GET", `/v1/drafts/${d.id}`, "mgr1")).json());
    expect([view.draft.resolved_refs.length, view.unverified_refs]).toEqual([1, []]);
    const ok = await approve("mgr1", d.id);
    expect(ok.status).toBe(200);
    expect((await one<{ decided_by: string }>(`SELECT decided_by FROM core.decision WHERE draft_id = $1`, [d.id])).decided_by).toBe(T.mgr1);
  });
});

describe("template params (#57)", () => {
  it("binds :name outside literals, quoted identifiers, comments and ::casts only", () => {
    const sql = `SELECT ':lit' AS a, E'it\\'s :esc' AS b, $q$:dollar$q$ AS c, "col:x" AS d, x::int, :p1 -- :comment
/* :block */ FROM t WHERE a = :p1 AND b = :p2::uuid AND c = 'it''s :quoted'`;
    expect(bindNamedParams(sql)).toEqual({
      sql: `SELECT ':lit' AS a, E'it\\'s :esc' AS b, $q$:dollar$q$ AS c, "col:x" AS d, x::int, $1 -- :comment
/* :block */ FROM t WHERE a = $1 AND b = $2::uuid AND c = 'it''s :quoted'`,
      names: ["p1", "p2"],
    });
  });
});

describe("edited payloads", () => {
  it("typed_by ≠ approver → 422; typed_by = approver → 200 with verdict edited and the typed value written", async () => {
    const d = await priceDraft("pickup");
    const forged = await approve("owner", d.id, approveBody(d.id, "catalogue.price.set.v1",
      { ...d.payload, amount_minor: { value: 27000, typed_by: T.mgr1 } }));
    expect(forged.status).toBe(422);
    expect((await refusal(forged)).error.code).toBe("invalid_payload");
    // A swapped citation is refused too: an edit may not replace the proposed ref with another cell.
    const swapped = await approve("owner", d.id, approveBody(d.id, "catalogue.price.set.v1", { ...d.payload, amount_minor: snapRef(priceSnap, 0, "item_id") }));
    expect(swapped.status).toBe(422);
    expect(await statusOf(d.id)).toBe("proposed");

    const ok = await approve("owner", d.id, approveBody(d.id, "catalogue.price.set.v1", { ...d.payload, amount_minor: { value: 27000, typed_by: T.owner } }));
    expect(ok.status).toBe(200);
    expect((await one<{ amount_minor: string }>(`SELECT amount_minor FROM core.price WHERE id = $1`, [d.price])).amount_minor).toBe("27000");
    const dec = await one<{ verdict: string; final_payload: { amount_minor: unknown } }>(`SELECT verdict, final_payload FROM core.decision WHERE draft_id = $1`, [d.id]);
    expect(dec).toEqual({ verdict: "edited", final_payload: expect.objectContaining({ amount_minor: { value: 27000, typed_by: T.owner } }) });
  });
});

describe("one winner", () => {
  it("concurrent approve + edit-approve → exactly 1 execution (1 executed draft, 1 decision, 1 price row)", async () => {
    const d = await priceDraft("own_site");
    slow.add(d.price);
    const before = await executions("catalogue.price.set.v1");
    const [a, b] = await Promise.all([
      approve("owner", d.id),
      approve("owner", d.id, approveBody(d.id, "catalogue.price.set.v1", { ...d.payload, amount_minor: { value: 26000, typed_by: T.owner } })),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect((await refusal(loser)).error.code).toBe("already_decided");
    expect(await statusOf(d.id)).toBe("executed");
    expect(await count(`SELECT count(*) n FROM core.decision WHERE draft_id = $1`, [d.id])).toBe(1);
    expect(await count(`SELECT count(*) n FROM core.price WHERE id = $1`, [d.price])).toBe(1);
    expect(await count(`SELECT count(*) n FROM core.price WHERE tenant_id = $1 AND channel_kind = 'own_site'`, [T.tenant])).toBe(1);
    expect((await executions("catalogue.price.set.v1")) - before).toBe(1);
  });
});

describe("based_on re-check", () => {
  async function reorderDraft(ing: string) {
    const snap = await mint("inventory.below_reorder", {});
    const rows = (await one<{ rows: Array<{ ingredient_id: string }> }>(`SELECT rows FROM evidence.snapshot WHERE id = $1`, [snap])).rows;
    const at = rows.findIndex((r) => r.ingredient_id === ing);
    expect(at).toBeGreaterThanOrEqual(0);
    const payload = {
      outlet_id: T.outlets[0], ingredient_id: ing,
      min_qty_milli: snapRef(snap, at, "par_qty_milli"), par_qty_milli: snapRef(snap, at, "par_qty_milli"),
    };
    const onHand = snapRef(snap, at, "on_hand_milli");
    const id = await draft("inventory.reorder_level.set.v1", payload, [onHand]);
    contractDrafts.add(id);
    return { id, onHand };
  }

  it("a changed based_on cell → 409 stale_draft with what changed, status stale, 0 executions", async () => {
    const d = await reorderDraft(T.ing[0]);
    await db.withContext("munim_core", own("inventory.stock.receive.v1"), (c) =>
      c.query(`INSERT INTO core.stock_movement (tenant_id, id, outlet_id, ingredient_id, qty_milli, unit, kind) VALUES ($1, $2, $3, $4, 100, 'g', 'receipt')`,
        [T.tenant, uuidv7(), T.outlets[0], T.ing[0]]));
    const before = await executions();
    const r = await approve("owner", d.id, approveBody(d.id, "inventory.reorder_level.set.v1"));
    expect(r.status).toBe(409);
    const body = await refusal(r);
    expect(body.error).toEqual({ code: "stale_draft", message: expect.any(String), reason_code: "stale_draft" });
    expect(body.changes).toEqual([{ ref: d.onHand, value: 0, now_ref: expect.stringMatching(/^⟨snap:/), now: 100 }]);
    expect(await statusOf(d.id)).toBe("stale");
    // A retry of a stale approve gets the stale outcome again, not "already decided".
    const retry = await approve("owner", d.id, approveBody(d.id, "inventory.reorder_level.set.v1"));
    expect([retry.status, (await refusal(retry)).error.code]).toEqual([409, "stale_draft"]);
    expect(await executions()).toBe(before);
    expect(await count(`SELECT count(*) n FROM core.decision WHERE draft_id = $1`, [d.id])).toBe(0);
    expect(await count(`SELECT count(*) n FROM core.reorder_level WHERE ingredient_id = $1 AND min_qty_milli = 1000`, [T.ing[0]])).toBe(1);
    // The new value traces to a snapshot minted for the approver; the draft's history shows the change.
    const got = DraftDetailResponse.parse(await (await call("GET", `/v1/drafts/${d.id}`, "owner")).json());
    expect(got.history.find((h) => h.event === "stale")!.changes).toEqual([{ ref: d.onHand, value: 0, now_ref: body.changes![0]!.now_ref, now: 100 }]);
  });

  it("an unchanged based_on cell → 200, exactly 1 execution", async () => {
    const d = await reorderDraft(T.ing[1]);
    const before = await executions();
    const r = await approve("owner", d.id, approveBody(d.id, "inventory.reorder_level.set.v1"));
    expect(r.status).toBe(200);
    expect(await statusOf(d.id)).toBe("executed");
    expect(await executions()).toBe(before + 1);
    expect(await count(`SELECT count(*) n FROM core.reorder_level WHERE ingredient_id = $1 AND min_qty_milli = 5000`, [T.ing[1]])).toBe(1);
    // An UPDATE keeps the row's first origin (0014, F3); the change traces through its audit entry's decision.
    expect(await count(
      `SELECT count(*) n FROM core.audit_log a JOIN core.reorder_level l ON l.tenant_id = a.tenant_id AND l.id::text = a.entity_id
         JOIN core.decision d ON d.tenant_id = a.tenant_id AND d.id = a.decision_id
        WHERE a.entity = 'core.reorder_level' AND l.ingredient_id = $1 AND d.draft_id = $2 AND d.decided_by = $3`, [T.ing[1], d.id, T.owner])).toBe(1);
  });
});

describe("reject", () => {
  it("without a reason → 422; with a reason → 200, decision rejected, 0 handler runs", async () => {
    const d = await priceDraft("counter", inDays(90));
    const before = await executions();
    const body = (reason?: string) => ({ command_id: uuidv7(), idempotency_key: `reject-${uuidv7()}`, type: "drafts.reject.v1", payload: { draft_id: d.id, ...(reason === undefined ? {} : { reason }) } });
    const missing = await call("POST", `/v1/drafts/${d.id}:reject`, "owner", body());
    expect(missing.status).toBe(422);
    expect((await call("POST", `/v1/drafts/${d.id}:reject`, "owner", body(""))).status).toBe(422);
    expect(await statusOf(d.id)).toBe("proposed");
    const ok = await call("POST", `/v1/drafts/${d.id}:reject`, "owner", body("Price is fine for now"));
    expect(ok.status).toBe(200);
    expect(CommandResult.parse(await ok.json())).toMatchObject({ type: "drafts.reject.v1", entity_id: d.id });
    expect(await statusOf(d.id)).toBe("rejected");
    expect(await one(`SELECT verdict, reason, decided_by FROM core.decision WHERE draft_id = $1`, [d.id])).toEqual({ verdict: "rejected", reason: "Price is fine for now", decided_by: T.owner });
    expect(await executions()).toBe(before);
    expect(await count(`SELECT count(*) n FROM core.price WHERE id = $1`, [d.price])).toBe(0);
    // A later approve loses: the draft is decided.
    expect((await approve("owner", d.id)).status).toBe(409);
  });
});

describe("idempotency", () => {
  it("a replayed approve (same key) → the same bytes and 1 execution; the same key with a different request → 409", async () => {
    const d = await priceDraft("aggregator:zomato", inDays(240));
    const body = approveBody(d.id, "catalogue.price.set.v1", null, `approve-replay-${uuidv7()}`);
    const before = await executions();
    const first = await approve("owner", d.id, body);
    const firstText = await first.text();
    const again = await approve("owner", d.id, body);
    expect([first.status, again.status]).toEqual([200, 200]);
    expect(await again.text()).toBe(firstText);
    expect(again.headers.get("X-Munim-Replayed")).toBe("true");
    expect(await executions()).toBe(before + 1);
    expect(await count(`SELECT count(*) n FROM core.price WHERE id = $1`, [d.price])).toBe(1);
    const changed = await approve("owner", d.id, { ...body, payload: { ...body.payload, edited_payload: { ...d.payload, amount_minor: { value: 1, typed_by: T.owner } }, reason: "x" } });
    expect(changed.status).toBe(409);
    expect((await refusal(changed)).error.code).toBe("idempotency_conflict");
    // Same executed command, different decision: only the reason differs, or an edit that equals the cell.
    const reason = await approve("owner", d.id, { ...body, payload: { ...body.payload, reason: "another reason" } });
    expect([reason.status, (await refusal(reason)).error.code]).toEqual([409, "idempotency_conflict"]);
    const sameValue = await approve("owner", d.id, { ...body, payload: { ...body.payload, edited_payload: { ...d.payload, amount_minor: { value: 25000, typed_by: T.owner } } } });
    expect([sameValue.status, (await refusal(sameValue)).error.code]).toEqual([409, "idempotency_conflict"]);
    expect(await executions()).toBe(before + 1);
  });

  it("F8: the same key reused on a second draft with an identical command → 409, the second draft untouched", async () => {
    const price = uuidv7();
    const a = await priceDraft("aggregator:swiggy", inDays(120), { price });
    const b = await priceDraft("aggregator:swiggy", inDays(120), { price });
    const body = approveBody(a.id, "catalogue.price.set.v1", null, `approve-reuse-${uuidv7()}`);
    expect((await approve("owner", a.id, body)).status).toBe(200);
    const reused = await approve("owner", b.id, { ...body, payload: { ...body.payload, draft_id: b.id } });
    expect([reused.status, (await refusal(reused)).error.code]).toEqual([409, "idempotency_conflict"]);
    expect(await statusOf(b.id)).toBe("proposed");
    expect(await count(`SELECT count(*) n FROM core.decision WHERE draft_id = $1`, [b.id])).toBe(0);
  });
});

describe("registry", () => {
  it("an unregistered command type → 422 (not draftable)", async () => {
    const notDraftable = await draft("tenancy.outlet.create.v1", { name: "x" });
    const r = await approve("owner", notDraftable, approveBody(notDraftable, "tenancy.outlet.create.v1"));
    expect(r.status).toBe(422);
    expect((await refusal(r)).error.code).toBe("unregistered_command_type");
    // A second type that is still not draftable (a person's own command only).
    const noHandler = await draft("tenancy.brand.create.v1", {});
    const r2 = await approve("owner", noHandler, approveBody(noHandler, "tenancy.brand.create.v1"));
    expect(r2.status).toBe(422);
    expect((await refusal(r2)).error.code).toBe("unregistered_command_type");
    expect(draftableTypes()).not.toContain("tenancy.brand.create.v1");
    expect(await statusOf(notDraftable)).toBe("proposed");
    expect(await statusOf(noHandler)).toBe("proposed");
  });
});

describe("execution failure", () => {
  it("a book refusal during execution → 422 execution_failed, draft failed, nothing written", async () => {
    // Overlaps the price the first test wrote (same item, outlet, channel, open-ended validity).
    const d = await priceDraft("counter", inDays(30));
    const r = await approve("owner", d.id);
    expect(r.status).toBe(422);
    expect((await refusal(r)).error.code).toBe("execution_failed");
    expect(await statusOf(d.id)).toBe("failed");
    // 23P01: the price validity exclusion constraint; recorded as a code on the draft (0014 failure_reason).
    expect((await one<{ failure_reason: string }>(`SELECT failure_reason FROM core.draft WHERE id = $1`, [d.id])).failure_reason).toBe("sqlstate_23p01");
    expect(await count(`SELECT count(*) n FROM core.price WHERE id = $1`, [d.price])).toBe(0);
    const hist = DraftDetailResponse.parse(await (await call("GET", `/v1/drafts/${d.id}`, "owner")).json()).history.map((h) => h.event);
    expect(hist).toEqual(["proposed", "approved", "failed"]);
  });
});

describe("after-commit publish (#12)", () => {
  it("an approved draft's events are published once, after the approving transaction committed", async () => {
    const reg = draftHandler(poHandler.type) ? null : registerDraftHandler(poHandler);
    try {
      const po = uuidv7();
      const payload = { po_id: po, supplier_id: T.supplier, outlet_ids: [T.outlets[0]], currency: "INR", expected_on: null, negotiation_run_id: null,
        lines: [{ ingredient_id: T.ing[0], qty_milli: suggested(), unit: "g", unit_price_minor: suggested() }] };
      const id = await draft("purchasing.po.create.v1", payload, [suggested()]);
      contractDrafts.add(id);
      const before = published.length;
      const r = await approve("owner", id, approveBody(id, "purchasing.po.create.v1"));
      expect(r.status).toBe(200);
      const mine = published.slice(before);
      expect(mine).toEqual([{ type: "munim.purchasing.po.committed.v1", data: expect.objectContaining({ po_id: po, draft_id: id }), committed: true }]);
      expect(await count(`SELECT count(*) n FROM core.outbox WHERE aggregateid = $1 AND published_at IS NOT NULL`, [po])).toBe(1);
    } finally {
      reg?.();
    }
  });
});

describe("read paths", () => {
  it("list: items are DraftView with resolved refs; badge = list length; outlet scope narrows; decided list carries the decision", async () => {
    const d = await priceDraft("aggregator:swiggy");
    const res = await call("GET", "/v1/drafts", "owner");
    expect(res.status).toBe(200);
    const list = await res.json();
    expect(list.items.length).toBeGreaterThanOrEqual(1);
    // buildWorld's and the registry test's drafts carry payloads no registered schema accepts; every other item
    // must parse as the contract's list response.
    DraftsListResponse.parse({ ...list, items: list.items.filter((x: { draft: { draft_id: string } }) => contractDrafts.has(x.draft.draft_id)) });
    for (const it of list.items) expect(it.draft.status).toBe("proposed");
    const mine = list.items.find((x: { draft: { draft_id: string } }) => x.draft.draft_id === d.id);
    DraftView.parse(mine.draft);
    expect(mine.draft.resolved_refs).toEqual([{ path: "/amount_minor", ref: suggested(), value: 25000 }]);
    expect(mine.unverified_refs).toEqual([]);

    // Outlet-2 manager: none of the outlet-1 drafts.
    const other = await (await call("GET", "/v1/drafts", "mgr2")).json();
    expect(other.items).toEqual([]);
    // Owner-visible snapshot of scope {*} does not resolve for an outlet-scoped manager (R40 C4).
    const m1 = await (await call("GET", `/v1/drafts/${d.id}`, "mgr1")).json();
    expect(m1.draft.resolved_refs).toEqual([]);
    expect(m1.unverified_refs).toContain(suggested());

    // Paging: limit 1 → has_more and a cursor that yields a different item.
    const p1 = await (await call("GET", "/v1/drafts?limit=1", "owner")).json();
    expect(p1.items.length).toBe(1);
    expect(p1.has_more).toBe(true);
    const p2 = await (await call("GET", `/v1/drafts?limit=1&cursor=${p1.next_cursor}`, "owner")).json();
    expect(p2.items[0].draft.draft_id).not.toBe(p1.items[0].draft.draft_id);

    const decided = await (await call("GET", "/v1/drafts?status=decided", "owner")).json();
    expect(decided.items.length).toBeGreaterThanOrEqual(1);
    const mineDecided = decided.items.filter((x: { draft: { draft_id: string } }) => contractDrafts.has(x.draft.draft_id));
    expect(mineDecided.length).toBeGreaterThanOrEqual(5);
    DraftsListResponse.parse({ ...decided, items: mineDecided });
    for (const it of decided.items) {
      expect(["executed", "failed", "rejected"]).toContain(it.draft.status);
      expect(it.decision).toMatchObject({ decided_by: { member_id: expect.any(String) }, verdict: expect.stringMatching(/^(approved|edited|rejected)$/) });
    }
    expect((await call("GET", "/v1/drafts?status=bogus", "owner")).status).toBe(400);
  });

  it("every book row written by approvals traces to a decision by the approving member; the audit chain verifies", async () => {
    const orphans = await count(
      `SELECT count(*) n FROM core.price p WHERE p.tenant_id = $1 AND NOT EXISTS (
         SELECT 1 FROM core.decision d WHERE d.tenant_id = p.tenant_id AND d.id = (p.origin->>'decision_id')::uuid
            AND d.decided_by IN ($2, $3)) AND p.item_id = $4`, [T.tenant, T.owner, T.mgr1, T.item]);
    expect(orphans).toBe(0);
    expect(await count(`SELECT count(*) n FROM core.price WHERE tenant_id = $1 AND item_id = $2`, [T.tenant, T.item])).toBeGreaterThanOrEqual(6);
    const v = await verifyAuditChain(svcTx(db), T.tenant);
    expect(v.ok).toBe(true);
    expect(v.rows).toBeGreaterThan(0);
  });
});
