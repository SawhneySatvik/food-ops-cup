// T-084a gates — lineage, /v1/draftables, findings:dismiss and the reject reason_code, through the real app
// (member auth → withContext → RLS). Handlers are the real W2 ones (catalogue price, inventory reorder level).
//   (1) a price row changed by an approved draft → the full chain, every hop equal to the planted id
//   (2)(3) planted rejected / stale / failed drafts → reason(+code) / changes / sqlstate
//   (3) /v1/draftables length = `proposal.` lines in MANIFEST.d (counted from the files, not the registry)
//   (4) another outlet's row (and draft) → 404, the owning outlet's manager → 200; a draft's touched rows are filtered per
//       row (R-A 7: an outlet-0 manager never gets the id of an outlet-1 row the same decision touched)
//   dismiss: owner 200, replay → same bytes + 1 audit entry, different request on the same key → 409.
// Synthetic data only.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createLogger } from "@munim/config";
import { CommandResult, snapRef } from "@munim/contracts";
import { RejectReasonCode } from "@munim/contracts/approvals";
import { DraftablesResponse, DraftLineageResponse, RowLineageResponse } from "@munim/contracts/lineage";
import { buildWorld, type TestDb } from "@munim/db";
import type { Hono } from "hono";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppEnv, createApp, TENANT_HEADER } from "../src/app.ts";
import { uuidv7, verifyAuditChain } from "../src/commit/index.ts";
import { svcTx } from "../src/commit/testkit.ts";
import { runTemplate } from "../src/modules/approvals/snapshots.ts";
import { createLocalIdp } from "../src/auth/local-idp.ts";
import { openDb } from "./db.ts";

const idp = createLocalIdp();
let db: TestDb;
let pools: { core: pg.Pool; svc: pg.Pool };
let app: Hono<AppEnv>;

const T = {
  tenant: "", owner: "", staff: "", mgr1: uuidv7(), mgr2: uuidv7(), outlets: ["", ""] as [string, string],
  item: uuidv7(), ing: uuidv7(), run: uuidv7(), finding: uuidv7(), snap: uuidv7(), price0: uuidv7(),
  subs: { owner: `owner-${uuidv7()}`, staff: `staff-${uuidv7()}`, mgr1: `mgr1-${uuidv7()}`, mgr2: `mgr2-${uuidv7()}` },
};
type Who = keyof typeof T.subs;

const own = (command_type: string) => ({ tenant_id: T.tenant, outlet_ids: "*" as const, role: "owner" as const, member_id: T.owner, command_type });
const svc = () => ({ tenant_id: T.tenant, outlet_ids: "*" as const, role: "service" as const });
const inDays = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

type Res = Omit<Response, "json"> & { json(): Promise<any> };
const call = async (method: string, path: string, who: Who, body?: unknown): Promise<Res> =>
  (await app.request(path, {
    method,
    headers: { Authorization: `Bearer ${idp.sign({ sub: T.subs[who] })}`, [TENANT_HEADER]: T.tenant, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })) as Res;
const one = async <R extends pg.QueryResultRow>(sql: string, params: unknown[] = []) => (await db.admin(sql, params)).rows[0] as R;
const count = async (sql: string, params: unknown[] = []) => Number((await one<{ n: string }>(sql, params)).n);

async function draft(command_type: string, payload: Record<string, unknown>, basedOn: string[], o: { finding?: string; run?: string } = {}): Promise<string> {
  const id = uuidv7();
  await db.withContext("munim_svc", svc(), (c) =>
    c.query(`INSERT INTO core.draft (tenant_id, id, outlet_ids, source, finding_id, run_id, command_type, command_payload, based_on)
             VALUES ($1, $2, $3, 'intel:catalogue', $4, $5, $6, $7, $8)`,
      [T.tenant, id, [T.outlets[0]], o.finding ?? null, o.run ?? null, command_type, payload, JSON.stringify(basedOn)]));
  return id;
}
const priceDraft = async (validFrom: string, o: { finding?: string; run?: string } = {}) => {
  const ref = snapRef(T.snap, 0, "suggested_minor");
  return draft("catalogue.price.set.v1", {
    price_id: uuidv7(), item_id: T.item, variant_id: null, outlet_id: T.outlets[0], channel_kind: "counter",
    amount_minor: ref, currency: "INR", tax_class: "restaurant_5", valid_from: validFrom, valid_to: null,
  }, [ref], o);
};
const approve = (id: string, command_type: string) => call("POST", `/v1/drafts/${id}:approve`, "owner", {
  command_id: uuidv7(), idempotency_key: `approve-${uuidv7()}`, type: "drafts.approve.v1", payload: { draft_id: id, command_type, edited_payload: null, reason: null },
});
const reject = (id: string, reason_code?: string, who: Who = "owner") => call("POST", `/v1/drafts/${id}:reject`, who, {
  command_id: uuidv7(), idempotency_key: `reject-${uuidv7()}`, type: "drafts.reject.v1",
  payload: { draft_id: id, reason: "Price is fine for now", ...(reason_code ? { reason_code } : {}) },
});
const lineageOf = (who: Who, row: string) => call("GET", `/v1/lineage?row=${encodeURIComponent(row)}`, who);

beforeAll(async () => {
  db = await openDb();
  const w = await buildWorld(db);
  Object.assign(T, { tenant: w.tenant, owner: w.owner, staff: w.staff, outlets: [w.outlets[0], w.outlets[1]] });
  await db.withContext("munim_core", own("tenancy.member.invite.v1"), async (c) => {
    await c.query(`UPDATE core.member SET idp_sub = $2 WHERE id = $1`, [T.owner, T.subs.owner]);
    await c.query(`UPDATE core.member SET idp_sub = $2 WHERE id = $1`, [T.staff, T.subs.staff]);
    for (const [who, outlet] of [["mgr1", T.outlets[0]], ["mgr2", T.outlets[1]]] as const) {
      await c.query(`INSERT INTO core.member (tenant_id, id, idp_sub, name, email) VALUES ($1, $2, $3, $4, $5)`, [T.tenant, T[who], T.subs[who], `Synthetic ${who}`, `${who}@example.test`]);
      await c.query(`INSERT INTO core.membership (tenant_id, member_id, role, outlet_ids) VALUES ($1, $2, 'manager', $3)`, [T.tenant, T[who], [outlet]]);
    }
  });
  await db.withContext("munim_core", own("catalogue.item.upsert.v1"), (c) =>
    c.query(`INSERT INTO core.item (tenant_id, id, kind, name_key, category) VALUES ($1, $2, 'dish', 'lineage_test_dish', 'mains')`, [T.tenant, T.item]));
  await db.withContext("munim_core", own("inventory.ingredient.upsert.v1"), (c) =>
    c.query(`INSERT INTO core.ingredient (tenant_id, id, name, base_unit) VALUES ($1, $2, 'Synthetic ingredient', 'g')`, [T.tenant, T.ing]));
  await db.withContext("munim_core", own("inventory.reorder_level.set.v1"), (c) =>
    c.query(`INSERT INTO core.reorder_level (tenant_id, id, outlet_id, ingredient_id, min_qty_milli, par_qty_milli) VALUES ($1, $2, $3, $4, 1000, 5000)`, [T.tenant, uuidv7(), T.outlets[0], T.ing]));
  // The price the approved draft will change: open-ended since 2020, written directly (no audit entry of its own).
  await db.withContext("munim_core", own("catalogue.price.set.v1"), (c) =>
    c.query(`INSERT INTO core.price (tenant_id, id, item_id, variant_id, outlet_id, channel_kind, amount_minor, currency, tax_class, valid_from, valid_to)
             VALUES ($1, $2, $3, NULL, $4, 'counter', 20000, 'INR', 'restaurant_5', '2020-01-01', NULL)`, [T.tenant, T.price0, T.item, T.outlets[0]]));
  await db.admin(`INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES
    ('test.price_suggestion', 1, $1, '{"type":"object"}', $2, 'manager')`, [
    `SELECT i.id AS item_id, 25000::bigint AS suggested_minor FROM core.item i WHERE i.id = :item_id::uuid`,
    JSON.stringify([{ name: "item_id", type: "uuid" }, { name: "suggested_minor", type: "integer", numeric_source: "core.price.amount_minor" }]),
  ]);
  // The planted run → snapshot → finding that the approved draft cites.
  await db.withContext("munim_svc", svc(), async (c) => {
    await c.query(`INSERT INTO intel.run (tenant_id, id, trigger, actor, outlet_scope, expires_at) VALUES ($1, $2, 'event', 'watcher:catalogue', $3, now() + interval '1 hour')`, [T.tenant, T.run, [T.outlets[0]]]);
    const { rows } = await runTemplate(c, "test.price_suggestion", 1, { item_id: T.item });
    await c.query(`INSERT INTO evidence.snapshot (tenant_id, id, template_id, template_version, params, run_id, outlet_scope, rows, row_count, sha256)
                   VALUES ($1, $2, 'test.price_suggestion', 1, $3, $4, $5, $6, $7, repeat('0', 64))`,
      [T.tenant, T.snap, { item_id: T.item }, T.run, [T.outlets[0]], JSON.stringify(rows), rows.length]);
    await c.query(`INSERT INTO intel.finding (tenant_id, id, run_id, outlet_ids, pack, type, severity, confidence_bp, envelope, dedupe_key)
                   VALUES ($1, $2, $3, $4, 'catalogue', 'catalogue.price_below_target', 'medium', 9000, '{}', $5)`,
      [T.tenant, T.finding, T.run, [T.outlets[0]], `lineage-test:${T.finding}`]);
  });
  pools = { core: db.pool("munim_core", 8), svc: db.pool("munim_svc", 2) };
  const config = { nodeEnv: "test", redact: (s: string) => s };
  app = await createApp({ pools, idp, storefronts: async () => null, config, log: createLogger(config, () => {}) });
});

afterAll(async () => {
  await pools?.core.end();
  await pools?.svc.end();
  await db?.stop();
});

const planted: { approved: string; failed: string; rejected: string; stale: string } = { approved: "", failed: "", rejected: "", stale: "" };

describe("(1) a price row changed by an approved draft", () => {
  it("returns the chain row → audit → decision → draft → finding → run, each hop equal to the planted id, plus the cited snapshot", async () => {
    planted.approved = await priceDraft(inDays(30), { finding: T.finding, run: T.run });
    const ok = await approve(planted.approved, "catalogue.price.set.v1");
    expect(ok.status).toBe(200);
    const decisionId = (await one<{ id: string }>(`SELECT id FROM core.decision WHERE draft_id = $1`, [planted.approved])).id;

    const r = await lineageOf("owner", `core.price:${T.price0}`);
    expect(r.status).toBe(200);
    const body = RowLineageResponse.parse(await r.json());
    expect(body.row).toEqual({ table: "core.price", id: T.price0 });
    // The price was created without an audit entry; the approved draft's take-over is its one audited change.
    expect(body.chains).toHaveLength(1);
    const chain = body.chains[0]!;
    expect(chain.audit).toMatchObject({ entity: "core.price", entity_id: T.price0, decision_id: decisionId, actor: { member_id: T.owner, role: "owner" } });
    expect(chain.decision).toMatchObject({ decision_id: decisionId, verdict: "approved", decided_by: { member_id: T.owner } });
    expect(chain.draft).toMatchObject({ draft_id: planted.approved, command_type: "catalogue.price.set.v1", outcome: { status: "executed" } });
    expect(chain.finding).toMatchObject({ finding_id: T.finding, pack: "catalogue" });
    expect(chain.run).toMatchObject({ run_id: T.run, trigger: "event" });
    expect(chain.snapshots).toEqual([{ snapshot_id: T.snap, template_id: "test.price_suggestion", template_version: 1, refs: [snapRef(T.snap, 0, "suggested_minor")] }]);
    expect(chain.unverified_refs).toEqual([]);
    // Ids, statuses and refs only: no amount from the audit entry's before/after is echoed.
    expect(JSON.stringify(body)).not.toMatch(/"(amount_minor|valid_to|before|after)"/);
  });

  it("draft lineage shows the same chain up and the touched rows down (old price closed, new price created)", async () => {
    const body = DraftLineageResponse.parse(await (await call("GET", `/v1/drafts/${planted.approved}/lineage`, "owner")).json());
    expect(body.chain.draft).toMatchObject({ draft_id: planted.approved, outcome: { status: "executed", sqlstate: null } });
    expect(body.chain.finding?.finding_id).toBe(T.finding);
    expect(body.chain.run?.run_id).toBe(T.run);
    expect(body.chain.audit).toMatchObject({ entity: "core.draft", entity_id: planted.approved });
    expect(body.touched.map((t) => t.table).sort()).toEqual(["core.price", "core.price"]);
    expect(body.touched.map((t) => t.id)).toContain(T.price0);
  });
});

describe("(2)(3) rejected, stale and failed drafts appear with reason, changes or sqlstate", () => {
  it("failed: the same start date as the price just written → 23P01, lineage shows the sqlstate and failure_reason", async () => {
    planted.failed = await priceDraft(inDays(30), { finding: T.finding, run: T.run });
    expect((await approve(planted.failed, "catalogue.price.set.v1")).status).toBe(422);
    const b = DraftLineageResponse.parse(await (await call("GET", `/v1/drafts/${planted.failed}/lineage`, "owner")).json());
    expect(b.chain.draft!.outcome).toMatchObject({ status: "failed", sqlstate: "23P01", failure_reason: "sqlstate_23p01", changes: [] });
    expect(b.touched).toEqual([]);
  });

  it("rejected: the person's reason and reason_code; the free-text note and the code both come back, 0 executions", async () => {
    planted.rejected = await priceDraft(inDays(90));
    expect((await reject(planted.rejected, "not_needed")).status).toBe(200);
    const b = DraftLineageResponse.parse(await (await call("GET", `/v1/drafts/${planted.rejected}/lineage`, "owner")).json());
    expect(b.chain.draft!.outcome).toMatchObject({ status: "rejected", reason: "Price is fine for now", reason_code: "not_needed", sqlstate: null });
    expect(b.chain.decision).toMatchObject({ verdict: "rejected", reason_code: "not_needed" });
    expect(b.touched).toEqual([]);
  });

  it("reject without a reason_code still works (additive); an unknown code → 422, nothing decided", async () => {
    const d = await priceDraft(inDays(120));
    expect((await reject(d, "because")).status).toBe(422);
    expect(await count(`SELECT count(*) n FROM core.decision WHERE draft_id = $1`, [d])).toBe(0);
    expect((await reject(d)).status).toBe(200);
    const b = DraftLineageResponse.parse(await (await call("GET", `/v1/drafts/${d}/lineage`, "owner")).json());
    expect(b.chain.draft!.outcome).toMatchObject({ status: "rejected", reason_code: null });
    expect(RejectReasonCode.options).toHaveLength(5);
  });

  it("stale: a changed based_on cell → lineage lists the changed ref and the cell it became", async () => {
    const snap = uuidv7();
    await db.withContext("munim_svc", svc(), async (c) => {
      const run = uuidv7();
      await c.query(`INSERT INTO intel.run (tenant_id, id, trigger, actor, outlet_scope, expires_at) VALUES ($1, $2, 'event', 'watcher:events', $3, now() + interval '1 hour')`, [T.tenant, run, [T.outlets[0]]]);
      const { rows } = await runTemplate(c, "inventory.below_reorder", 1, {});
      await c.query(`INSERT INTO evidence.snapshot (tenant_id, id, template_id, template_version, params, run_id, outlet_scope, rows, row_count, sha256)
                     VALUES ($1, $2, 'inventory.below_reorder', 1, '{}', $3, $4, $5, $6, repeat('0', 64))`, [T.tenant, snap, run, [T.outlets[0]], JSON.stringify(rows), rows.length]);
    });
    const rows = (await one<{ rows: Array<{ ingredient_id: string }> }>(`SELECT rows FROM evidence.snapshot WHERE id = $1`, [snap])).rows;
    const at = rows.findIndex((r) => r.ingredient_id === T.ing);
    expect(at).toBeGreaterThanOrEqual(0);
    const onHand = snapRef(snap, at, "on_hand_milli");
    planted.stale = await draft("inventory.reorder_level.set.v1", {
      outlet_id: T.outlets[0], ingredient_id: T.ing, min_qty_milli: snapRef(snap, at, "par_qty_milli"), par_qty_milli: snapRef(snap, at, "par_qty_milli"),
    }, [onHand]);
    await db.withContext("munim_core", own("inventory.stock.receive.v1"), (c) =>
      c.query(`INSERT INTO core.stock_movement (tenant_id, id, outlet_id, ingredient_id, qty_milli, unit, kind) VALUES ($1, $2, $3, $4, 100, 'g', 'receipt')`, [T.tenant, uuidv7(), T.outlets[0], T.ing]));
    expect((await approve(planted.stale, "inventory.reorder_level.set.v1")).status).toBe(409);
    const b = DraftLineageResponse.parse(await (await call("GET", `/v1/drafts/${planted.stale}/lineage`, "owner")).json());
    expect(b.chain.draft!.outcome.status).toBe("stale");
    expect(b.chain.draft!.outcome.changes).toEqual([{ ref: onHand, now_ref: expect.stringMatching(/^⟨snap:/) }]);
    expect(b.chain.decision).toBeNull();
    expect(b.chain.snapshots.map((s) => s.snapshot_id)).toEqual([snap]);
  });
});

describe("(3) /v1/draftables", () => {
  it("length = the number of `proposal.` lines in packages/contracts/MANIFEST.d (counted from the files)", async () => {
    const dir = join(import.meta.dirname, "../../../packages/contracts/MANIFEST.d");
    const names = readdirSync(dir).filter((f) => f.endsWith(".txt")).flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n")).filter((l) => l.startsWith("proposal."));
    expect(names.length).toBeGreaterThan(20);
    const body = DraftablesResponse.parse(await (await call("GET", "/v1/draftables", "staff")).json());
    expect(body.items).toHaveLength(names.length);
    expect(body.items.map((i) => `proposal.${i.command_type}`).sort()).toEqual([...names].sort());
    // The served schema is the proposal one: a numeric leaf is a ref, not a number.
    const price = body.items.find((i) => i.command_type === "catalogue.price.set.v1")!;
    expect(JSON.stringify(price.proposal_schema)).toContain("amount_minor");
  });
});

describe("(4) another outlet's row → 404; the owning outlet → 200", () => {
  it("row lineage: outlet-1 manager 404 on an outlet-0 price, outlet-0 manager 200", async () => {
    expect((await lineageOf("mgr2", `core.price:${T.price0}`)).status).toBe(404);
    expect((await lineageOf("mgr1", `core.price:${T.price0}`)).status).toBe(200);
  });
  it("draft lineage: outlet-1 manager 404, outlet-0 manager 200", async () => {
    expect((await call("GET", `/v1/drafts/${planted.approved}/lineage`, "mgr2")).status).toBe(404);
    expect((await call("GET", `/v1/drafts/${planted.approved}/lineage`, "mgr1")).status).toBe(200);
  });
  it("a tenant-visible row audited under an outlet-0 decision: outlet-1 manager gets the audit hop but NO decision (core.decision's RLS is tenant-wide), outlet-0 manager gets it", async () => {
    const decisionId = (await one<{ id: string }>(`SELECT id FROM core.decision WHERE draft_id = $1`, [planted.approved])).id;
    await db.admin(`INSERT INTO core.audit_log (tenant_id, actor, action, entity, entity_id, decision_id, after, seq, prev_hash, hash, created_at)
                    VALUES ($1, '{"kind":"member","id":"x","role":"owner"}', 'test.touch', 'core.item', $2, $3, '{}', 0, '', '', now())`, [T.tenant, T.item, decisionId]);
    const other = RowLineageResponse.parse(await (await lineageOf("mgr2", `core.item:${T.item}`)).json());
    expect(other.chains).toHaveLength(1);
    expect(other.chains[0]).toMatchObject({ audit: { entity: "core.item", decision_id: decisionId }, decision: null, draft: null, finding: null, run: null, snapshots: [] });
    const mine = RowLineageResponse.parse(await (await lineageOf("mgr1", `core.item:${T.item}`)).json());
    expect(mine.chains[0]!.decision).toMatchObject({ decision_id: decisionId });
    expect(mine.chains[0]!.draft).toMatchObject({ draft_id: planted.approved });
  });
  it("touched rows are filtered per row (R-A 7): outlet-0 manager gets the outlet-0 price but not an outlet-1 price the decision touched; the owner gets both", async () => {
    const decisionId = (await one<{ id: string }>(`SELECT id FROM core.decision WHERE draft_id = $1`, [planted.approved])).id;
    const price1 = uuidv7();
    await db.withContext("munim_core", own("catalogue.price.set.v1"), (c) =>
      c.query(`INSERT INTO core.price (tenant_id, id, item_id, variant_id, outlet_id, channel_kind, amount_minor, currency, tax_class, valid_from, valid_to)
               VALUES ($1, $2, $3, NULL, $4, 'counter', 20000, 'INR', 'restaurant_5', '2020-01-01', NULL)`, [T.tenant, price1, T.item, T.outlets[1]]));
    await db.admin(`INSERT INTO core.audit_log (tenant_id, actor, action, entity, entity_id, decision_id, after, seq, prev_hash, hash, created_at)
                    VALUES ($1, '{"kind":"member","id":"x","role":"owner"}', 'test.touch', 'core.price', $2, $3, '{}', 0, '', '', now())`, [T.tenant, price1, decisionId]);
    const ids = async (who: Who) => DraftLineageResponse.parse(await (await call("GET", `/v1/drafts/${planted.approved}/lineage`, who)).json()).touched.map((t) => t.id);
    const mine = await ids("mgr1");
    expect([mine.includes(T.price0), mine.includes(price1)]).toEqual([true, false]);
    const all = await ids("owner");
    expect([all.includes(T.price0), all.includes(price1)]).toEqual([true, true]);
  });
  it("malformed row param → 400; unknown row, unknown table, a table with no id → 404", async () => {
    for (const bad of ["", "core.price", "core.price:x", "core.price;drop:" + uuidv7(), "public.price:" + uuidv7()]) expect((await lineageOf("owner", bad)).status).toBe(400);
    expect((await lineageOf("owner", `core.price:${uuidv7()}`)).status).toBe(404);
    expect((await lineageOf("owner", `core.no_such_table:${uuidv7()}`)).status).toBe(404);
    expect((await lineageOf("owner", `core.tenant:${T.tenant}`)).status).toBe(404);
  });
});

describe("findings:dismiss", () => {
  const dismissBody = (finding: string, reason_code: string, key = `dismiss-${uuidv7()}`) => ({
    command_id: uuidv7(), idempotency_key: key, type: "findings.dismiss.v1", payload: { finding_id: finding, reason_code },
  });
  const newFinding = async (outlets: string[]) => {
    const id = uuidv7();
    await db.withContext("munim_svc", svc(), (c) => c.query(
      `INSERT INTO intel.finding (tenant_id, id, run_id, outlet_ids, pack, type, severity, confidence_bp, envelope, dedupe_key)
       VALUES ($1, $2, $3, $4, 'catalogue', 'catalogue.price_below_target', 'low', 5000, '{}', $5)`, [T.tenant, id, T.run, outlets, `dismiss-test:${id}`]));
    return id;
  };
  const post = (who: Who, id: string, body: unknown) => call("POST", `/v1/findings/${id}:dismiss`, who, body);

  it("owner → 200, status dismissed, one audit entry carrying the reason code; the row's lineage shows it", async () => {
    const id = await newFinding([T.outlets[0]]);
    const r = await post("owner", id, dismissBody(id, "already_done"));
    expect(r.status).toBe(200);
    expect(CommandResult.parse(await r.json())).toMatchObject({ type: "findings.dismiss.v1", entity_id: id });
    expect((await one<{ status: string }>(`SELECT status FROM intel.finding WHERE id = $1`, [id])).status).toBe("dismissed");
    expect(await count(`SELECT count(*) n FROM core.audit_log WHERE entity = 'intel.finding' AND entity_id = $1 AND after->>'reason_code' = 'already_done'`, [id])).toBe(1);
    const lin = RowLineageResponse.parse(await (await lineageOf("owner", `intel.finding:${id}`)).json());
    expect(lin.chains).toHaveLength(1);
    expect(lin.chains[0]!.audit).toMatchObject({ entity: "intel.finding", actor: { member_id: T.owner } });
    // Dismissed again under a new key: conflict, nothing more written.
    expect((await post("owner", id, dismissBody(id, "other"))).status).toBe(409);
  });

  it("idempotency replay: the same key and request → the same bytes, X-Munim-Replayed, exactly 1 audit entry; the same key with another reason_code → 409", async () => {
    const id = await newFinding([T.outlets[0]]);
    const body = dismissBody(id, "bad_timing", `dismiss-replay-${uuidv7()}`);
    const first = await post("owner", id, body);
    const text = await first.text();
    const again = await post("owner", id, body);
    expect(again.status).toBe(200);
    expect(again.headers.get("X-Munim-Replayed")).toBe("true");
    expect(await again.text()).toBe(text);
    expect(await count(`SELECT count(*) n FROM core.audit_log WHERE entity = 'intel.finding' AND entity_id = $1`, [id])).toBe(1);
    expect((await post("owner", id, { ...body, command_id: uuidv7(), payload: { finding_id: id, reason_code: "other" } })).status).toBe(409);
  });

  it("refusals: staff → 403, other outlet's manager → 404, path/body id mismatch and unknown code → 422, a finding that is not open untouched", async () => {
    const id = await newFinding([T.outlets[0]]);
    expect((await post("staff", id, dismissBody(id, "other"))).status).toBe(403);
    expect((await post("mgr2", id, dismissBody(id, "other"))).status).toBe(404);
    expect((await post("owner", id, dismissBody(uuidv7(), "other"))).status).toBe(422);
    expect((await post("owner", id, dismissBody(id, "not_a_code"))).status).toBe(422);
    expect((await one<{ status: string }>(`SELECT status FROM intel.finding WHERE id = $1`, [id])).status).toBe("open");
    expect((await post("mgr1", id, dismissBody(id, "other"))).status).toBe(200);
  });

  it("a tenant-wide finding needs every outlet: outlet manager → 404 (RLS) , owner → 200", async () => {
    const id = await newFinding([]);
    expect([403, 404]).toContain((await post("mgr1", id, dismissBody(id, "other"))).status);
    expect((await post("owner", id, dismissBody(id, "other"))).status).toBe(200);
  });
});

describe("audit chain", () => {
  it("the tenant's hash chain still verifies after approvals, rejections and dismissals (and has entries)", async () => {
    const v = await verifyAuditChain(svcTx(db), T.tenant);
    expect(v.ok).toBe(true);
    expect(v.rows).toBeGreaterThan(5);
  });
});
