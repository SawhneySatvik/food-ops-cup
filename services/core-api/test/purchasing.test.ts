// T-025 gates — the purchasing module through the real app (member auth → withContext → RLS → book guard).
//   PO → GRN → invoice → approval chain against a hand-computed fixture (movements, batch, payable, postings);
//   duplicate invoice 409 / new number 201; payable not derivable from a recorded invoice (MB001) and exactly
//   one from the approved one; pooled PO visible to the managers of each listed outlet only; every read model
//   labels a simulated supplier and no real one; draft execution commits a PO under the approver's decision.
// The inventory and finance seams are TEST-ONLY fakes that write through the guard under the seeded rules
// (T-024 / T-026 own the real ones): assertions on movements/postings prove OUR calls (rule id, source ref, same
// transaction), not their derivation logic. The goods-received command is the seeded row (0015 A4).
// Synthetic data only.
import { createLogger } from "@munim/config";
import { CommandResult, snapRef } from "@munim/contracts";
import { InvoiceView, PoView, SCHEMAS } from "@munim/contracts/purchasing";
import { buildWorld, type TestDb } from "@munim/db";
import type { Hono } from "hono";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalIdp } from "../src/auth/local-idp.ts";
import { type AppEnv, createApp, TENANT_HEADER } from "../src/app.ts";
import { uuidv7, verifyAuditChain } from "../src/commit/index.ts";
import { svcTx, testKeys } from "../src/commit/testkit.ts";
import { derivePayable, setSeams } from "../src/modules/purchasing/index.ts";
import { draftHandler } from "../src/modules/approvals/handlers.ts";
import { openDb } from "./db.ts";

const idp = createLocalIdp();
let db: TestDb;
let pools: { core: pg.Pool; svc: pg.Pool };
let app: Hono<AppEnv>;
let restoreSeams: () => void;

const T = {
  tenant: "", owner: "", staff: "", outlets: ["", "", ""] as [string, string, string],
  m1: uuidv7(), m2: uuidv7(), m3: uuidv7(),
  subs: { owner: `owner-${uuidv7()}`, staff: `staff-${uuidv7()}`, m1: `m1-${uuidv7()}`, m2: `m2-${uuidv7()}`, m3: `m3-${uuidv7()}` },
  tomato: uuidv7(), paneer: uuidv7(), real: uuidv7(), sim: uuidv7(),
  acct: { inventory: uuidv7(), grni: uuidv7(), inputTax: uuidv7(), payables: uuidv7() },
};
type Who = keyof typeof T.subs;

// ---- TEST-ONLY seam fakes: write through the guard under the seeded derivation rules ----
const calls: Array<readonly string[]> = [];
const rule = (c: pg.ClientBase, r: string, src: string) => c.query(`SELECT set_config('app.posting_rule', $1, true), set_config('app.source_ref', $2, true)`, [r, src]);
const fakes = {
  async deriveGoodsReceipt(c: pg.ClientBase, grnId: string) {
    calls.push(["derive", grnId]);
    await rule(c, "inventory.receive_grn", `core.goods_received:${grnId}`);
    const lines = await c.query<{ outlet_id: string; ingredient_id: string; batch_id: string | null; qty_milli: string; unit: string; unit_cost_minor: string; currency: string }>(
      `SELECT r.outlet_id, g.ingredient_id, g.batch_id, g.qty_milli, g.unit, g.unit_cost_minor, g.currency
         FROM core.grn_line g JOIN core.goods_received r ON r.id = g.goods_received_id WHERE r.id = $1`, [grnId]);
    for (const l of lines.rows) {
      await c.query(
        `INSERT INTO core.stock_movement (tenant_id, id, outlet_id, ingredient_id, batch_id, qty_milli, unit, kind, ref_type, ref_id, unit_cost_minor, currency)
         VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, 'receipt', 'core.goods_received', $7, $8, $9)`,
        [uuidv7(), l.outlet_id, l.ingredient_id, l.batch_id, l.qty_milli, l.unit, grnId, l.unit_cost_minor, l.currency]);
    }
    await rule(c, "", "");
  },
  async postFor(c: pg.ClientBase, ruleId: string, ref: string) {
    calls.push(["post", ruleId, ref]);
    const [table, id] = ref.split(":") as [string, string];
    const sums = ruleId === "finance.post_grn"
      ? (await c.query<{ a: string }>(`SELECT sum(g.qty_milli * g.unit_cost_minor / 1000)::bigint AS a FROM core.grn_line g WHERE g.goods_received_id = $1`, [id])).rows[0]!.a
      : null;
    const inv = ruleId === "finance.post_supplier_invoice"
      ? (await c.query<{ s: string; t: string }>(`SELECT subtotal_minor AS s, tax_minor AS t FROM core.supplier_invoice WHERE id = $1`, [id])).rows[0]!
      : null;
    const entry = uuidv7();
    await rule(c, ruleId, ref);
    await c.query(`INSERT INTO core.journal_entry (tenant_id, id, entry_date, source_type, source_id, posting_rule, memo_key) VALUES (current_setting('app.tenant_id')::uuid, $1, current_date, $2, $3, $4, 'test.fake')`,
      [entry, table, id, ruleId]);
    const lines: Array<[string, number]> = ruleId === "finance.post_grn"
      ? [[T.acct.inventory, Number(sums)], [T.acct.grni, -Number(sums)]]
      : [[T.acct.grni, Number(inv!.s)], ...(Number(inv!.t) > 0 ? [[T.acct.inputTax, Number(inv!.t)] as [string, number]] : []), [T.acct.payables, -(Number(inv!.s) + Number(inv!.t))]];
    for (const [acct, amt] of lines) {
      await c.query(`INSERT INTO core.posting (tenant_id, id, journal_entry_id, account_id, amount_minor, currency) VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, 'INR')`, [uuidv7(), entry, acct, amt]);
    }
    await rule(c, "", "");
  },
};

const own = (command_type: string) => ({ tenant_id: T.tenant, outlet_ids: "*" as const, role: "owner" as const, member_id: T.owner, command_type });
type Res = Omit<Response, "json"> & { json(): Promise<any> };
const call = async (method: string, path: string, who: Who, body?: unknown): Promise<Res> =>
  (await app.request(path, {
    method,
    headers: { Authorization: `Bearer ${idp.sign({ sub: T.subs[who] })}`, [TENANT_HEADER]: T.tenant, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })) as Res;
const env = (type: string, payload: unknown, key = `k-${uuidv7()}`) => ({ command_id: uuidv7(), idempotency_key: key, type, payload });
const one = async <R extends pg.QueryResultRow>(sql: string, params: unknown[] = []) => (await db.admin(sql, params)).rows[0] as R;
const count = async (sql: string, params: unknown[] = []) => Number((await one<{ n: string }>(sql, params)).n);
const post = (who: Who, path: string, type: string, payload: unknown, key?: string) => call("POST", path, who, env(type, payload, key));
const codeOf = async (r: Res) => (await r.json()).error.code;

const GRN_TYPE = "purchasing.grn.receive.v1";

async function setup() {
  const w = await buildWorld(db);
  Object.assign(T, { tenant: w.tenant, owner: w.owner, staff: w.staff, outlets: [...w.outlets] });
  await db.withContext("munim_core", own("tenancy.member.invite.v1"), async (c) => {
    await c.query(`UPDATE core.member SET idp_sub = $2 WHERE id = $1`, [T.owner, T.subs.owner]);
    await c.query(`UPDATE core.member SET idp_sub = $2 WHERE id = $1`, [T.staff, T.subs.staff]);
    for (const [who, o] of [["m1", T.outlets[0]], ["m2", T.outlets[1]], ["m3", T.outlets[2]]] as const) {
      await c.query(`INSERT INTO core.member (tenant_id, id, idp_sub, name, email) VALUES ($1, $2, $3, $4, $5)`, [T.tenant, T[who], T.subs[who], `Synthetic ${who}`, `${who}@example.test`]);
      await c.query(`INSERT INTO core.membership (tenant_id, member_id, role, outlet_ids) VALUES ($1, $2, 'manager', $3)`, [T.tenant, T[who], [o]]);
    }
  });
  await db.withContext("munim_core", own("inventory.ingredient.upsert.v1"), async (c) => {
    await c.query(`INSERT INTO core.ingredient (tenant_id, id, name, base_unit, tracked_by_batch) VALUES ($1, $2, 'Tomato', 'kg', false), ($1, $3, 'Paneer block', 'kg', true)`, [T.tenant, T.tomato, T.paneer]);
  });
  // The world carries the IN pack's full chart (0015 A12): inventory 1200, GRNI 2050 and supplier payables 2000 are
  // its rows; the IN chart has no input-tax account, so the fixture adds 1500.
  const code = async (c: string) => (await one<{ id: string }>(`SELECT id FROM core.account WHERE tenant_id = $1 AND code = $2`, [T.tenant, c])).id;
  Object.assign(T.acct, { inventory: await code("1200"), grni: await code("2050"), payables: await code("2000") });
  await db.withContext("munim_core", own("finance.account.upsert.v1"), (c) =>
    c.query(`INSERT INTO core.account (tenant_id, id, code, name, type) VALUES ($1, $2, '1500', 'Input tax', 'asset')`, [T.tenant, T.acct.inputTax]));
}

const poPayload = (o: { po?: string; supplier: string; outlets: string[]; lines?: unknown[] }) => ({
  po_id: o.po ?? uuidv7(), supplier_id: o.supplier, outlet_ids: o.outlets, currency: "INR", expected_on: "2026-10-12", negotiation_run_id: null,
  lines: o.lines ?? [{ ingredient_id: T.tomato, qty_milli: 100000, unit: "kg", unit_price_minor: 4000 }, { ingredient_id: T.paneer, qty_milli: 20000, unit: "kg", unit_price_minor: 30000 }],
});

const S = { po1: uuidv7(), poM: uuidv7(), poPool: uuidv7(), poO2: uuidv7(), poO3: uuidv7(), grn1: uuidv7(), grn2: uuidv7(), batch1: uuidv7(),
  inv1: uuidv7(), inv2: uuidv7(), invLines: [uuidv7(), uuidv7()] as [string, string], ret1: uuidv7(), ret2: uuidv7(), poLines: [] as string[] };

beforeAll(async () => {
  db = await openDb();
  await setup();
  pools = { core: db.pool("munim_core", 8), svc: db.pool("munim_svc", 2) };
  const config = { nodeEnv: "test", redact: (s: string) => s };
  app = await createApp({
    pools, idp, storefronts: async () => null, config, log: createLogger(config, (l: unknown) => { if (process.env.DEBUG_LOG) console.error(l); }),
    publish: { publisher: { async publish() {} }, svc: svcTx(db), keys: testKeys() },
  });
  restoreSeams = setSeams(fakes as never);
});

afterAll(async () => {
  restoreSeams?.();
  await pools?.core.end();
  await pools?.svc.end();
  await db?.stop();
});

describe("suppliers: real | simulated, fixed kind, price observations", () => {
  it("staff and an outlet-scoped manager are refused (tenant-scope command); the owner creates both kinds with a price observation", async () => {
    const body = (id: string, name: string, kind: string, days: number, prices: unknown[] = []) => ({
      supplier_id: id, name, kind, a2a_card_url: null, terms: { payment_days: days, notes: null }, prices });
    expect((await post("staff", "/v1/suppliers", "purchasing.supplier.upsert.v1", body(T.real, "Mandi Traders", "real", 15))).status).toBe(403);
    expect((await post("m1", "/v1/suppliers", "purchasing.supplier.upsert.v1", body(T.real, "Mandi Traders", "real", 15))).status).toBe(403);
    expect(await count(`SELECT count(*) n FROM core.supplier WHERE id = $1`, [T.real])).toBe(0);
    const price = [{ price_id: uuidv7(), ingredient_id: T.tomato, unit: "kg", unit_price_minor: 3900, currency: "INR", observed_at: "2026-10-01T09:00:00+05:30", source_ref: "fixture:quote-1" }];
    const ok = await post("owner", "/v1/suppliers", "purchasing.supplier.upsert.v1", body(T.real, "Mandi Traders", "real", 15, price));
    expect(ok.status).toBe(201);
    CommandResult.parse(await ok.json());
    expect((await post("owner", "/v1/suppliers", "purchasing.supplier.upsert.v1", body(T.sim, "Discount Dairy", "simulated", 7))).status).toBe(201);
    expect(await count(`SELECT count(*) n FROM core.supplier_price WHERE supplier_id = $1 AND unit_price_minor = 3900`, [T.real])).toBe(1);
    // a supplier's kind is fixed: relabelling a simulated supplier real is refused, a rename is not
    expect((await post("owner", "/v1/suppliers", "purchasing.supplier.upsert.v1", body(T.sim, "Discount Dairy", "real", 7))).status).toBe(409);
    expect((await post("owner", "/v1/suppliers", "purchasing.supplier.upsert.v1", body(T.sim, "Discount Dairy Co", "simulated", 7))).status).toBe(201);
    expect(await one(`SELECT kind, name FROM core.supplier WHERE id = $1`, [T.sim])).toEqual({ kind: "simulated", name: "Discount Dairy Co" });
  });
});

describe("purchase orders: totals, events, replay, pooled visibility", () => {
  it("owner PO: total computed server-side (hand: 100 kg × 4000 + 20 kg × 30000 = 1,000,000), po.committed event carries outlet_ids; replay is byte-identical", async () => {
    const e = env("purchasing.po.create.v1", poPayload({ po: S.po1, supplier: T.real, outlets: [T.outlets[0]] }), "po1-key-0001");
    const r = await call("POST", "/v1/purchase-orders", "owner", e);
    expect(r.status).toBe(201);
    const first = await r.text();
    expect(CommandResult.parse(JSON.parse(first)).entity_id).toBe(S.po1);
    expect(await one(`SELECT total_minor::int AS t, status, outlet_ids FROM core.purchase_order WHERE id = $1`, [S.po1])).toEqual({ t: 1000000, status: "committed", outlet_ids: [T.outlets[0]] });
    const lines = await db.admin<{ id: string; line_no: number }>(`SELECT id, line_no FROM core.po_line WHERE po_id = $1 ORDER BY line_no`, [S.po1]);
    expect(lines.rows.map((l) => l.line_no)).toEqual([1, 2]);
    S.poLines = lines.rows.map((l) => l.id);
    const ev = await one<{ payload: { data: Record<string, unknown> } }>(`SELECT payload FROM core.outbox WHERE aggregateid = $1 AND type = 'munim.purchasing.po.committed.v1'`, [S.po1]);
    expect(ev.payload.data).toEqual({ po_id: S.po1, supplier_id: T.real, outlet_ids: [T.outlets[0]], decision_id: null, draft_id: null });
    const again = await call("POST", "/v1/purchase-orders", "owner", e);
    expect(again.headers.get("X-Munim-Replayed")).toBe("true");
    expect(await again.text()).toBe(first);
    expect(await count(`SELECT count(*) n FROM core.purchase_order WHERE id = $1`, [S.po1])).toBe(1);
  });

  it("a manager can create a PO inside their outlets, not a pooled PO that reaches another outlet's", async () => {
    const wide = await post("m1", "/v1/purchase-orders", "purchasing.po.create.v1", poPayload({ supplier: T.real, outlets: [T.outlets[0], T.outlets[1]] }));
    expect(wide.status).toBe(403);
    const ok = await post("m1", "/v1/purchase-orders", "purchasing.po.create.v1", poPayload({ po: S.poM, supplier: T.real, outlets: [T.outlets[0]] }));
    expect(ok.status).toBe(201);
    expect(await count(`SELECT count(*) n FROM core.purchase_order WHERE created_by = $1`, [T.m1])).toBe(1);
  });

  it("pooled PO [o1,o2] is visible to the managers of o1 and o2 only; o3's manager sees only their own", async () => {
    const simLines = [{ ingredient_id: T.tomato, qty_milli: 10000, unit: "kg", unit_price_minor: 3600 }];
    for (const [po, outs] of [[S.poPool, [T.outlets[0], T.outlets[1]]], [S.poO2, [T.outlets[1]]], [S.poO3, [T.outlets[2]]]] as const) {
      const r = await post("owner", "/v1/purchase-orders", "purchasing.po.create.v1", poPayload({ po, supplier: T.sim, outlets: [...outs], lines: simLines }));
      expect(r.status).toBe(201);
    }
    // buildWorld holds its own PO in outlet 1: only this file's POs are compared
    const mine = new Set([S.po1, S.poM, S.poPool, S.poO2, S.poO3]);
    const ids = async (who: Who) => (await (await call("GET", "/v1/purchase-orders", who)).json()).items.map((x: { po_id: string }) => x.po_id).filter((id: string) => mine.has(id)).sort();
    expect(await ids("m1")).toEqual([S.po1, S.poM, S.poPool].sort());
    expect(await ids("m2")).toEqual([S.poPool, S.poO2].sort());
    expect(await ids("m3")).toEqual([S.poO3]);
    expect(await ids("owner")).toEqual([S.po1, S.poM, S.poPool, S.poO2, S.poO3].sort());
    expect((await call("GET", `/v1/purchase-orders/${S.poPool}`, "m1")).status).toBe(200);
    expect((await call("GET", `/v1/purchase-orders/${S.poPool}`, "m2")).status).toBe(200);
    expect((await call("GET", `/v1/purchase-orders/${S.poPool}`, "m3")).status).toBe(404);
    expect((await call("GET", `/v1/purchase-orders/${S.poO2}`, "m1")).status).toBe(404);
    const ev = await one<{ payload: { data: { outlet_ids: string[] } } }>(`SELECT payload FROM core.outbox WHERE aggregateid = $1`, [S.poPool]);
    expect(ev.payload.data.outlet_ids.sort()).toEqual([T.outlets[0], T.outlets[1]].sort());
  });
});

describe("goods received → batch, movements, posting", () => {
  it("refusals write nothing: tracked ingredient without a batch, wrong outlet for the PO, a batch on an untracked ingredient", async () => {
    const line = (o: Record<string, unknown>) => ({ grn_line_id: uuidv7(), po_line_id: null, unit: "kg", unit_cost_minor: null, currency: "INR", batch: null, ...o });
    const base = { outlet_id: T.outlets[0], supplier_id: T.real, po_id: S.po1, received_at: null, note: null };
    const before = await count(`SELECT count(*) n FROM core.goods_received`);
    const batch = { batch_id: uuidv7(), batch_code: "X-1", expires_on: "2026-10-20", mrp_minor: null };
    const noBatch = { ...base, grn_id: uuidv7(), lines: [line({ po_line_id: S.poLines[1], ingredient_id: T.paneer, qty_milli: 20000 })] };
    expect((await post("m1", "/v1/goods-received", GRN_TYPE, noBatch)).status).toBe(400);
    const wrongOutlet = { ...base, outlet_id: T.outlets[1], grn_id: uuidv7(), lines: [line({ po_line_id: S.poLines[0], ingredient_id: T.tomato, qty_milli: 100000 })] };
    expect((await post("m2", "/v1/goods-received", GRN_TYPE, wrongOutlet)).status).toBe(400);
    const untrackedBatch = { ...base, grn_id: uuidv7(), lines: [line({ po_line_id: S.poLines[0], ingredient_id: T.tomato, qty_milli: 100000, batch })] };
    expect((await post("m1", "/v1/goods-received", GRN_TYPE, untrackedBatch)).status).toBe(400);
    expect(await count(`SELECT count(*) n FROM core.goods_received`)).toBe(before);
    expect(await count(`SELECT count(*) n FROM core.batch WHERE batch_code = 'X-1'`)).toBe(0);
  });

  it("m1 receives PO1 in full: 2 GRN lines at PO prices, 1 batch, 2 receipt movements, seam calls in order, GRN posting 1,000,000, PO received", async () => {
    calls.length = 0;
    const payload = {
      grn_id: S.grn1, outlet_id: T.outlets[0], supplier_id: T.real, po_id: S.po1, received_at: null, note: "morning delivery",
      lines: [
        { grn_line_id: uuidv7(), po_line_id: S.poLines[0], ingredient_id: T.tomato, qty_milli: 100000, unit: "kg", unit_cost_minor: null, currency: "INR", batch: null },
        { grn_line_id: uuidv7(), po_line_id: S.poLines[1], ingredient_id: T.paneer, qty_milli: 20000, unit: "kg", unit_cost_minor: null, currency: "INR",
          batch: { batch_id: S.batch1, batch_code: "B-100", expires_on: "2026-10-20", mrp_minor: 36000 } },
      ],
    };
    const r = await post("m1", "/v1/goods-received", GRN_TYPE, payload);
    expect(r.status).toBe(201);
    expect(await one(`SELECT received_by, po_id, outlet_id FROM core.goods_received WHERE id = $1`, [S.grn1])).toEqual({ received_by: T.m1, po_id: S.po1, outlet_id: T.outlets[0] });
    expect((await db.admin(`SELECT ingredient_id, qty_milli::int AS q, unit_cost_minor::int AS c, batch_id FROM core.grn_line WHERE goods_received_id = $1 ORDER BY qty_milli DESC`, [S.grn1])).rows)
      .toEqual([{ ingredient_id: T.tomato, q: 100000, c: 4000, batch_id: null }, { ingredient_id: T.paneer, q: 20000, c: 30000, batch_id: S.batch1 }]);
    expect(await one(`SELECT batch_code, expires_on::text AS e, supplier_id, mrp_minor::int AS mrp, outlet_id, ingredient_id FROM core.batch WHERE id = $1`, [S.batch1]))
      .toEqual({ batch_code: "B-100", e: "2026-10-20", supplier_id: T.real, mrp: 36000, outlet_id: T.outlets[0], ingredient_id: T.paneer });
    expect((await db.admin(`SELECT ingredient_id, qty_milli::int AS q, batch_id, kind FROM core.stock_movement WHERE ref_id = $1 ORDER BY qty_milli DESC`, [S.grn1])).rows)
      .toEqual([{ ingredient_id: T.tomato, q: 100000, batch_id: null, kind: "receipt" }, { ingredient_id: T.paneer, q: 20000, batch_id: S.batch1, kind: "receipt" }]);
    expect(calls).toEqual([["derive", S.grn1], ["post", "finance.post_grn", `core.goods_received:${S.grn1}`]]);
    expect((await db.admin(`SELECT p.account_id, p.amount_minor::int AS a FROM core.posting p JOIN core.journal_entry j ON j.id = p.journal_entry_id WHERE j.source_id = $1 ORDER BY p.amount_minor DESC`, [S.grn1])).rows)
      .toEqual([{ account_id: T.acct.inventory, a: 1000000 }, { account_id: T.acct.grni, a: -1000000 }]);
    expect((await one<{ status: string }>(`SELECT status FROM core.purchase_order WHERE id = $1`, [S.po1])).status).toBe("received");
    const ev = await one<{ payload: { data: { movement_ids: string[]; kind: string; ref_id: string } } }>(`SELECT payload FROM core.outbox WHERE type = 'munim.inventory.movement.recorded.v1' AND aggregateid = $1`, [S.grn1]);
    expect(ev.payload.data).toMatchObject({ kind: "receipt", ref_id: S.grn1 });
    expect(ev.payload.data.movement_ids.length).toBe(2);
    // a received PO takes no further receipts
    const again = { ...payload, grn_id: uuidv7(), lines: payload.lines.map((l) => ({ ...l, grn_line_id: uuidv7(), batch: l.batch ? { ...l.batch, batch_id: uuidv7(), batch_code: "B-101" } : null })) };
    expect((await post("m1", "/v1/goods-received", GRN_TYPE, again)).status).toBe(409);
  });

  it("m1 receives the pooled PO at o1 for the simulated supplier: it stays committed (m1's scope does not cover o2)", async () => {
    calls.length = 0;
    const r = await post("m1", "/v1/goods-received", GRN_TYPE, {
      grn_id: S.grn2, outlet_id: T.outlets[0], supplier_id: T.sim, po_id: S.poPool, received_at: null, note: null,
      lines: [{ grn_line_id: uuidv7(), po_line_id: (await one<{ id: string }>(`SELECT id FROM core.po_line WHERE po_id = $1`, [S.poPool])).id, ingredient_id: T.tomato, qty_milli: 10000, unit: "kg", unit_cost_minor: null, currency: "INR", batch: null }],
    });
    expect(r.status).toBe(201);
    expect((await one<{ status: string }>(`SELECT status FROM core.purchase_order WHERE id = $1`, [S.poPool])).status).toBe("committed");
    expect(await count(`SELECT count(*) n FROM core.stock_movement WHERE ref_id = $1 AND qty_milli = 10000`, [S.grn2])).toBe(1);
  });
});

describe("supplier invoices: duplicate refused, approval derives the payable", () => {
  const invPayload = (o: { id: string; supplier: string; no: string; lines?: [string, string]; extra?: Record<string, unknown> }) => ({
    supplier_invoice_id: o.id, supplier_id: o.supplier, invoice_no: o.no, invoice_date: "2026-10-05", po_id: o.supplier === T.real ? S.po1 : null, currency: "INR",
    lines: [
      { line_id: (o.lines ?? S.invLines)[0], po_line_id: o.supplier === T.real ? S.poLines[0] : null, ingredient_id: T.tomato, description: null, qty_milli: 100000, unit: "kg", unit_price_minor: 4000, tax_minor: 0 },
      { line_id: (o.lines ?? S.invLines)[1], po_line_id: o.supplier === T.real ? S.poLines[1] : null, ingredient_id: T.paneer, description: null, qty_milli: 20000, unit: "kg", unit_price_minor: 31500, tax_minor: 31500 },
    ],
    ...o.extra,
  });

  it("records INV-9001: totals are core's (hand: 400,000 + 630,000 = 1,030,000; tax 31,500; total 1,061,500); status recorded, no payable", async () => {
    const r = await post("owner", "/v1/supplier-invoices", "purchasing.invoice.record.v1", invPayload({ id: S.inv1, supplier: T.real, no: "INV-9001" }));
    expect(r.status).toBe(201);
    expect(await one(`SELECT subtotal_minor::int AS s, tax_minor::int AS t, total_minor::int AS tot, status FROM core.supplier_invoice WHERE id = $1`, [S.inv1]))
      .toEqual({ s: 1030000, t: 31500, tot: 1061500, status: "recorded" });
    expect((await db.admin(`SELECT line_total_minor::int AS l FROM core.supplier_invoice_line WHERE supplier_invoice_id = $1 ORDER BY line_no`, [S.inv1])).rows.map((x) => x.l)).toEqual([400000, 661500]);
    expect(await count(`SELECT count(*) n FROM core.payable WHERE source_id = $1`, [S.inv1])).toBe(0);
    // a client-sent total has no place in the schema: a malformed envelope is 422 invalid_payload (one code across modules)
    const withTotal = await post("owner", "/v1/supplier-invoices", "purchasing.invoice.record.v1", invPayload({ id: uuidv7(), supplier: T.real, no: "INV-9100", extra: { total_minor: 1 } }));
    expect([withTotal.status, (await withTotal.json()).error.code]).toEqual([422, "invalid_payload"]);
  });

  it("duplicate number → 409 and no second row; a new number → 201; the same number for another supplier → 201; near-duplicate INV9001 → 201 (a finding, not a refusal)", async () => {
    const dupe = await post("owner", "/v1/supplier-invoices", "purchasing.invoice.record.v1", invPayload({ id: uuidv7(), supplier: T.real, no: "INV-9001", lines: [uuidv7(), uuidv7()] }));
    expect(dupe.status).toBe(409);
    expect((await dupe.json()).error).toMatchObject({ code: "conflict", reason_code: "duplicate_invoice", message: "This supplier invoice number was already recorded." });
    expect(await count(`SELECT count(*) n FROM core.supplier_invoice WHERE supplier_id = $1 AND invoice_no = 'INV-9001'`, [T.real])).toBe(1);
    const fresh = await post("owner", "/v1/supplier-invoices", "purchasing.invoice.record.v1", invPayload({ id: S.inv2, supplier: T.real, no: "INV-9002", lines: [uuidv7(), uuidv7()] }));
    expect(fresh.status).toBe(201);
    expect((await post("owner", "/v1/supplier-invoices", "purchasing.invoice.record.v1", invPayload({ id: uuidv7(), supplier: T.sim, no: "INV-9001", lines: [uuidv7(), uuidv7()] }))).status).toBe(201);
    expect((await post("owner", "/v1/supplier-invoices", "purchasing.invoice.record.v1", invPayload({ id: uuidv7(), supplier: T.real, no: "INV9001", lines: [uuidv7(), uuidv7()] }))).status).toBe(201);
    // staff never see supplier invoices; an outlet manager cannot record one (tenant-scope command)
    expect((await call("GET", "/v1/supplier-invoices", "staff")).status).toBe(403);
    expect((await post("m1", "/v1/supplier-invoices", "purchasing.invoice.record.v1", invPayload({ id: uuidv7(), supplier: T.real, no: "INV-9300", lines: [uuidv7(), uuidv7()] }))).status).toBe(403);
  });

  it("a payable cannot be derived from a recorded invoice (MB001 at the guard, illegal_transition in the module); the approved invoice gives exactly one", async () => {
    const ctx = { tenant_id: T.tenant, outlet_ids: "*" as const, role: "owner" as const, member_id: T.owner };
    const insert = (id: string) => `INSERT INTO core.payable (tenant_id, id, supplier_id, source_type, source_id, due_on, amount_minor, currency)
      SELECT tenant_id, gen_random_uuid(), supplier_id, 'core.supplier_invoice', id, '2026-10-20', total_minor, currency FROM core.supplier_invoice WHERE id = '${id}'`;
    const derive = { ...ctx, posting_rule: "purchasing.payable_from_invoice" as const };
    // recorded: the guard refuses (no command type set, so the verdict is MB001 not the table binding)
    let sqlstate: unknown;
    await db.withContext("munim_core", { ...derive, source_ref: `core.supplier_invoice:${S.inv2}` } as never, (c) => c.query(insert(S.inv2))).catch((e) => { sqlstate = e.code; });
    expect(sqlstate).toBe("MB001");
    let moduleError: unknown;
    await db.withContext("munim_core", ctx, (c) => derivePayable(c, S.inv2)).catch((e) => { moduleError = e.code; });
    expect(moduleError).toBe("illegal_transition");
    expect(await count(`SELECT count(*) n FROM core.payable WHERE source_id = $1`, [S.inv2])).toBe(0);

    // approval is owner/judge only
    calls.length = 0;
    const approve = (who: Who) => call("POST", `/v1/supplier-invoices/${S.inv1}:approve`, who, env("purchasing.invoice.approve.v1", { supplier_invoice_id: S.inv1 }));
    expect((await approve("m1")).status).toBe(403);
    expect(await count(`SELECT count(*) n FROM core.payable WHERE source_id = $1`, [S.inv1])).toBe(0);
    expect((await one<{ status: string }>(`SELECT status FROM core.supplier_invoice WHERE id = $1`, [S.inv1])).status).toBe("recorded");
    const ok = await approve("owner");
    expect(ok.status).toBe(200);
    expect(await one(`SELECT amount_minor::int AS a, due_on::text AS d, status, supplier_id FROM core.payable WHERE source_id = $1`, [S.inv1]))
      .toEqual({ a: 1061500, d: "2026-10-20", status: "open", supplier_id: T.real });
    expect(await count(`SELECT count(*) n FROM core.payable WHERE source_id = $1`, [S.inv1])).toBe(1);
    expect(calls).toEqual([["post", "finance.post_supplier_invoice", `core.supplier_invoice:${S.inv1}`]]);
    expect((await db.admin(`SELECT p.account_id, p.amount_minor::int AS a FROM core.posting p JOIN core.journal_entry j ON j.id = p.journal_entry_id WHERE j.source_id = $1 ORDER BY p.amount_minor DESC`, [S.inv1])).rows)
      .toEqual([{ account_id: T.acct.grni, a: 1030000 }, { account_id: T.acct.inputTax, a: 31500 }, { account_id: T.acct.payables, a: -1061500 }]);
    // approving twice would raise a second payable: refused
    expect((await approve("owner")).status).toBe(409);
    expect(await count(`SELECT count(*) n FROM core.payable WHERE source_id = $1`, [S.inv1])).toBe(1);
    // paired accept at the guard: with the invoice approved the same derivation insert passes (rolled back here)
    const marker = new Error("rolled back");
    const e = await db.withContext("munim_core", { ...derive, source_ref: `core.supplier_invoice:${S.inv1}` } as never, async (c) => { await c.query(insert(S.inv1)); throw marker; }).catch((x) => x);
    expect(e).toBe(marker);
    expect(await count(`SELECT count(*) n FROM core.payable WHERE source_id = $1`, [S.inv1])).toBe(1);
  });

  it("a dispute records overbilling for the owner to send (hand: 20 kg × (31,500 − 30,000) = 30,000); a claim above the line is refused; staff refused", async () => {
    const body = (claimed: number, id = uuidv7()) => ({ dispute_id: id, supplier_invoice_id: S.inv1, basis: "overbilled", lines: [{ invoice_line_id: S.invLines[1], claimed_minor: claimed }] });
    const path = `/v1/supplier-invoices/${S.inv1}:dispute`;
    const entries = () => db.admin<{ rule: string; reverses: boolean; total: number }>(
      `SELECT j.posting_rule AS rule, j.reverses_id IS NOT NULL AS reverses, sum(p.amount_minor) FILTER (WHERE p.amount_minor > 0)::int AS total
         FROM core.journal_entry j JOIN core.posting p ON p.journal_entry_id = j.id WHERE j.source_id = $1 GROUP BY j.tenant_id, j.id ORDER BY j.id`, [S.inv1]).then((r) => r.rows);
    const status = async () => (await one<{ status: string }>(`SELECT status FROM core.supplier_invoice WHERE id = $1`, [S.inv1])).status;
    expect((await call("POST", path, "staff", env("purchasing.invoice.dispute.v1", body(30000)))).status).toBe(403);
    expect((await call("POST", path, "owner", env("purchasing.invoice.dispute.v1", body(700000)))).status).toBe(422);
    // Refused disputes change nothing: still approved, one entry (Dr 1,030,000 + 31,500).
    expect([await status(), await entries()]).toEqual(["approved", [{ rule: "finance.post_supplier_invoice", reverses: false, total: 1061500 }]]);
    const id = uuidv7();
    expect((await call("POST", path, "owner", env("purchasing.invoice.dispute.v1", body(30000, id)))).status).toBe(201);
    expect(await one(`SELECT total_claimed_minor::int AS t, basis, status, supplier_id, counterparty FROM core.dispute WHERE id = $1`, [id]))
      .toEqual({ t: 30000, basis: "overbilled", status: "recorded", supplier_id: T.real, counterparty: "supplier" });
    expect(await count(`SELECT count(*) n FROM core.dispute_line WHERE dispute_id = $1 AND supplier_invoice_line_id = $2`, [id, S.invLines[1]])).toBe(1);
    // 0015 A8 + A6: the invoice is now disputed and its entry reversed (the same 1,061,500 the other way) under the
    // reversal rule; its open payable moves to disputed with it (D2, 0016), audited before/after.
    expect(await status()).toBe("disputed");
    const payable = await one<{ id: string; status: string }>(`SELECT id, status FROM core.payable WHERE source_id = $1`, [S.inv1]);
    expect(payable.status).toBe("disputed");
    expect((await db.admin(`SELECT before, after FROM core.audit_log WHERE entity = 'core.payable' AND entity_id = $1 AND before IS NOT NULL`, [payable.id])).rows)
      .toEqual([{ before: { status: "open" }, after: { status: "disputed" } }]);
    expect(await entries()).toEqual([
      { rule: "finance.post_supplier_invoice", reverses: false, total: 1061500 },
      { rule: "finance.reverse_supplier_invoice", reverses: true, total: 1061500 },
    ]);
    expect((await db.admin(`SELECT origin ->> 'rule_id' AS r FROM core.journal_entry WHERE source_id = $1 AND reverses_id IS NOT NULL`, [S.inv1])).rows).toEqual([{ r: "finance.reverse_supplier_invoice" }]);
    // A second dispute on the disputed invoice records the claim and reverses nothing again.
    expect((await call("POST", path, "owner", env("purchasing.invoice.dispute.v1", body(1000)))).status).toBe(201);
    expect((await entries()).length).toBe(2);
    // D2 follow-up (0017): approved again → the payable is released (disputed → open, audited) and the entry re-posted
    // once. The real finance seam here: the file's fake postFor writes a fresh entry each call, where finance re-posts
    // a reversed entry as the reversal of its reversal.
    restoreSeams();
    try {
      expect((await call("POST", `/v1/supplier-invoices/${S.inv1}:approve`, "owner", env("purchasing.invoice.approve.v1", { supplier_invoice_id: S.inv1 }))).status).toBe(200);
    } finally {
      restoreSeams = setSeams(fakes as never);
    }
    expect(await one(`SELECT status FROM core.payable WHERE id = $1`, [payable.id])).toEqual({ status: "open" });
    expect((await db.admin(`SELECT before, after FROM core.audit_log WHERE entity = 'core.payable' AND entity_id = $1 AND before IS NOT NULL ORDER BY seq`, [payable.id])).rows)
      .toEqual([{ before: { status: "open" }, after: { status: "disputed" } }, { before: { status: "disputed" }, after: { status: "open" } }]);
    expect((await entries()).length).toBe(3);
  });
});

describe("supplier returns: movements out at the received cost", () => {
  it("m1 returns 2 kg of batch B-100: cost 30,000 comes from the receipt (not the payload), movement −2000 kind supplier_return; staff refused; unknown cost → cannot_verify", async () => {
    const body = (id: string, o: Record<string, unknown>) => ({ supplier_return_id: id, outlet_id: T.outlets[0], supplier_id: T.real, goods_received_id: S.grn1, reason_code: "damaged", note: "torn pack",
      lines: [{ batch_id: S.batch1, ingredient_id: T.paneer, qty_milli: 2000, unit: "kg" }], ...o });
    expect((await post("staff", "/v1/supplier-returns", "purchasing.supplier_return.create.v1", body(uuidv7(), {}))).status).toBe(403);
    // the simulated supplier never delivered paneer: nothing to price the return from
    const noCost = await post("m1", "/v1/supplier-returns", "purchasing.supplier_return.create.v1", body(uuidv7(), { supplier_id: T.sim, goods_received_id: null, lines: [{ batch_id: null, ingredient_id: T.paneer, qty_milli: 1000, unit: "kg" }] }));
    expect(noCost.status).toBe(422);
    expect((await noCost.json()).error.reason_code).toBe("cost_price_missing");
    const ok = await post("m1", "/v1/supplier-returns", "purchasing.supplier_return.create.v1", body(S.ret1, {}));
    expect(ok.status).toBe(201);
    expect(await one(`SELECT returned_by, outlet_id FROM core.supplier_return WHERE id = $1`, [S.ret1])).toEqual({ returned_by: T.m1, outlet_id: T.outlets[0] });
    expect(await one(`SELECT qty_milli::int AS q, unit_cost_minor::int AS c, currency FROM core.supplier_return_line WHERE supplier_return_id = $1`, [S.ret1])).toEqual({ q: 2000, c: 30000, currency: "INR" });
    expect(await one(`SELECT qty_milli::int AS q, kind, batch_id, unit_cost_minor::int AS c FROM core.stock_movement WHERE ref_id = $1`, [S.ret1])).toEqual({ q: -2000, kind: "supplier_return", batch_id: S.batch1, c: 30000 });
    // the batch's on-hand after the return: +20000 − 2000
    expect((await one<{ n: string }>(`SELECT sum(qty_milli) n FROM core.stock_movement WHERE batch_id = $1`, [S.batch1])).n).toBe("18000");
    // the simulated supplier's tomato (GRN2, 3,600/kg): return 1 kg
    const sim = await post("m1", "/v1/supplier-returns", "purchasing.supplier_return.create.v1", body(S.ret2, { supplier_id: T.sim, goods_received_id: S.grn2, reason_code: "expired", note: "past date",
      lines: [{ batch_id: null, ingredient_id: T.tomato, qty_milli: 1000, unit: "kg" }] }));
    expect(sim.status).toBe(201);
    expect((await one<{ c: number }>(`SELECT unit_cost_minor::int AS c FROM core.supplier_return_line WHERE supplier_return_id = $1`, [S.ret2])).c).toBe(3600);
  });
});

describe("supplier returns: unit conversion into the ingredient's base unit", () => {
  const flour = uuidv7();
  const retBody = (id: string, ing: string, unit: string, qty: number) => ({ supplier_return_id: id, outlet_id: T.outlets[0], supplier_id: T.real, goods_received_id: null, reason_code: "damaged", note: "hand fixture",
    lines: [{ batch_id: null, ingredient_id: ing, qty_milli: qty, unit }] });

  it("2 kg returned against a gram ingredient received at 8,000 per kg: movement −2,000,000 milli-g (2,000 g), cost 8 per g; a mass↔volume or g→kg mismatch is refused, nothing written", async () => {
    await db.withContext("munim_core", own("inventory.ingredient.upsert.v1"), async (c) => {
      await c.query(`INSERT INTO core.ingredient (tenant_id, id, name, base_unit, tracked_by_batch) VALUES ($1, $2, 'Flour', 'g', false)`, [T.tenant, flour]);
    });
    const grn = await post("m1", "/v1/goods-received", GRN_TYPE, { grn_id: uuidv7(), outlet_id: T.outlets[0], supplier_id: T.real, po_id: null, received_at: null, note: null,
      lines: [{ grn_line_id: uuidv7(), po_line_id: null, ingredient_id: flour, qty_milli: 5000, unit: "kg", unit_cost_minor: 8000, currency: "INR", batch: null }] });
    expect(grn.status).toBe(201);

    const id = uuidv7();
    expect((await post("m1", "/v1/supplier-returns", "purchasing.supplier_return.create.v1", retBody(id, flour, "kg", 2000))).status).toBe(201);
    // R2-S2-8: the cost of 1000 g is exactly the ₹80/kg received (8,000), the per-g column its rounding (8).
    expect(await one(`SELECT qty_milli::int AS q, unit, unit_cost_minor::int AS c, unit_cost_per_1000_minor::int AS k FROM core.supplier_return_line WHERE supplier_return_id = $1`, [id]))
      .toEqual({ q: 2000000, unit: "g", c: 8, k: 8000 });
    expect(await one(`SELECT qty_milli::int AS q, unit, unit_cost_minor::int AS c FROM core.stock_movement WHERE ref_id = $1`, [id])).toEqual({ q: -2000000, unit: "g", c: 8 });

    // the same unit as the base passes through unchanged (paired accept): 500 g
    const same = uuidv7();
    expect((await post("m1", "/v1/supplier-returns", "purchasing.supplier_return.create.v1", retBody(same, flour, "g", 500000))).status).toBe(201);
    expect((await one<{ q: number }>(`SELECT qty_milli::int AS q FROM core.stock_movement WHERE ref_id = $1`, [same])).q).toBe(-500000);

    // refusals: litres against a gram ingredient; grams against a kg ingredient (no down-conversion to a larger unit)
    const bad1 = uuidv7(), bad2 = uuidv7();
    const r1 = await post("m1", "/v1/supplier-returns", "purchasing.supplier_return.create.v1", retBody(bad1, flour, "l", 1000));
    const r2 = await post("m1", "/v1/supplier-returns", "purchasing.supplier_return.create.v1", retBody(bad2, T.paneer, "g", 1000));
    expect([r1.status, r2.status]).toEqual([400, 400]);
    expect(await count(`SELECT count(*) n FROM core.supplier_return WHERE id = ANY($1::uuid[])`, [[bad1, bad2]])).toBe(0);
  });
});

describe("read models: contract shapes and the simulated-supplier label", () => {
  const suppliersIn = (v: unknown, out: Array<{ supplier_id: string; kind: string; label: string | null }> = []) => {
    if (Array.isArray(v)) v.forEach((x) => suppliersIn(x, out));
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (o.supplier && typeof o.supplier === "object") out.push(o.supplier as never);
      if ("kind" in o && "label" in o && "supplier_id" in o) out.push(o as never);
      Object.values(o).forEach((x) => suppliersIn(x, out));
    }
    return out;
  };

  it("every supplier object in every purchasing view carries 'Simulated supplier' iff simulated; each view parses with its contract and shows a simulated row", async () => {
    // Each list response parses whole with its route's contract schema (R3-M5).
    const views: Array<[string, (x: unknown) => unknown]> = [
      ["/v1/suppliers", (x) => SCHEMAS["v1.suppliers"].parse(x).items],
      ["/v1/purchase-orders", (x) => SCHEMAS["v1.purchase-orders"].parse(x).items],
      ["/v1/goods-received", (x) => SCHEMAS["v1.goods-received.list"].parse(x).items],
      ["/v1/supplier-invoices", (x) => SCHEMAS["v1.supplier-invoices"].parse(x).items],
      ["/v1/supplier-returns", (x) => SCHEMAS["v1.supplier-returns"].parse(x).items],
    ];
    const kinds = new Map((await db.admin<{ id: string; kind: string }>(`SELECT id, kind FROM core.supplier`)).rows.map((r) => [r.id, r.kind]));
    for (const [path, parse] of views) {
      const res = await call("GET", path, "owner");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect((parse(body) as unknown[]).length).toBeGreaterThan(0);
      const found = suppliersIn(body);
      expect(found.length).toBeGreaterThan(0);
      for (const s of found) expect(s.label, `${path} ${s.supplier_id}`).toBe(kinds.get(s.supplier_id) === "simulated" ? "Simulated supplier" : null);
      expect(found.some((s) => s.label === "Simulated supplier"), `${path} shows a simulated supplier`).toBe(true);
      expect(found.some((s) => s.label === null), `${path} shows a real supplier`).toBe(true);
    }
    // details too (and the invoice detail carries its derived payable row)
    expect(SCHEMAS["v1.supplier"].parse(await (await call("GET", `/v1/suppliers/${T.sim}`, "owner")).json()).label).toBe("Simulated supplier");
    expect(SCHEMAS["v1.goods-received"].parse(await (await call("GET", `/v1/goods-received/${S.grn1}`, "owner")).json()).grn_id).toBe(S.grn1);
    const d = await (await call("GET", `/v1/purchase-orders/${S.poPool}`, "owner")).json();
    expect(PoView.parse(d).supplier.label).toBe("Simulated supplier");
    const inv = InvoiceView.parse(await (await call("GET", `/v1/supplier-invoices/${S.inv1}`, "owner")).json());
    expect(inv.payable).toMatchObject({ due_on: "2026-10-20", amount_minor: 1061500, status: "open" }); // disputed, then re-opened by the re-approval (D2)
    expect(inv.supplier.label).toBeNull();
    // staff: supplier list without price observations
    const staff = await (await call("GET", "/v1/suppliers", "staff")).json();
    expect(staff.items.every((s: { prices: unknown[] }) => s.prices.length === 0)).toBe(true);
    const owner = await (await call("GET", "/v1/suppliers", "owner")).json();
    expect(owner.items.find((s: { supplier_id: string }) => s.supplier_id === T.real).prices.length).toBe(1);
  });

  it("outlet scoping on receipts and returns: o2's manager sees neither o1 receipt nor o1 return", async () => {
    const mineG = new Set([S.grn1, S.grn2]);
    const grns = async (who: Who) => (await (await call("GET", "/v1/goods-received", who)).json()).items.map((x: { grn_id: string }) => x.grn_id).filter((id: string) => mineG.has(id)).sort();
    expect(await grns("m2")).toEqual([]);
    expect(await grns("m1")).toEqual([S.grn1, S.grn2].sort());
    const rets = async (who: Who) => (await (await call("GET", "/v1/supplier-returns", who)).json()).items.map((x: { supplier_return_id: string }) => x.supplier_return_id).filter((id: string) => id === S.ret1 || id === S.ret2).sort();
    expect(await rets("m2")).toEqual([]);
    expect(await rets("m1")).toEqual([S.ret1, S.ret2].sort());
    expect((await (await call("GET", `/v1/goods-received/${S.grn1}`, "m2")).status)).toBe(404);
  });
});

describe("draft execution and the audit chain", () => {
  it("the three draftable commands have execution handlers; an approved PO draft commits under the approver's decision, event carries decision and draft ids", async () => {
    for (const t of ["purchasing.po.create.v1", "purchasing.invoice.dispute.v1", "purchasing.supplier_return.create.v1"]) expect(draftHandler(t)?.type).toBe(t);
    // TEST-ONLY snapshot template giving a quote's quantity and price (the numbers a PO draft cites as refs)
    await db.admin(`INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES ('test.po_quote', 1, $1, '{"type":"object"}', $2, 'manager')`, [
      `SELECT 50000::bigint AS qty_milli, 3800::bigint AS unit_price_minor`,
      JSON.stringify([{ name: "qty_milli", type: "integer", numeric_source: "core.po_line.qty_milli" }, { name: "unit_price_minor", type: "integer", numeric_source: "core.po_line.unit_price_minor" }]),
    ]);
    const snap = uuidv7();
    await db.withContext("munim_svc", { tenant_id: T.tenant, outlet_ids: "*", role: "service" }, async (c) => {
      const run = uuidv7();
      await c.query(`INSERT INTO intel.run (tenant_id, id, trigger, actor, outlet_scope, expires_at) VALUES ($1, $2, 'event', 'watcher:events', $3, now() + interval '1 hour')`, [T.tenant, run, ["*"]]);
      await c.query(`INSERT INTO evidence.snapshot (tenant_id, id, template_id, template_version, params, run_id, outlet_scope, rows, row_count, sha256)
                     VALUES ($1, $2, 'test.po_quote', 1, '{}', $3, $4, $5, 1, repeat('0', 64))`, [T.tenant, snap, run, ["*"], JSON.stringify([{ qty_milli: 50000, unit_price_minor: 3800 }])]);
    });
    const qty = snapRef(snap, 0, "qty_milli");
    const price = snapRef(snap, 0, "unit_price_minor");
    const po = uuidv7();
    const draftId = uuidv7();
    const payload = { po_id: po, supplier_id: T.sim, outlet_ids: [T.outlets[0]], currency: "INR", expected_on: null, negotiation_run_id: null,
      lines: [{ ingredient_id: T.tomato, qty_milli: qty, unit: "kg", unit_price_minor: price }] };
    await db.withContext("munim_svc", { tenant_id: T.tenant, outlet_ids: "*", role: "service" }, (c) =>
      c.query(`INSERT INTO core.draft (tenant_id, id, outlet_ids, source, command_type, command_payload, based_on) VALUES ($1, $2, $3, 'intel:inventory_purchasing', 'purchasing.po.create.v1', $4, $5)`,
        [T.tenant, draftId, [T.outlets[0]], payload, JSON.stringify([qty, price])]));
    const body = { command_id: uuidv7(), idempotency_key: `approve-${uuidv7()}`, type: "drafts.approve.v1", payload: { draft_id: draftId, command_type: "purchasing.po.create.v1", edited_payload: null, reason: null } };
    const r = await call("POST", `/v1/drafts/${draftId}:approve`, "owner", body);
    expect(r.status).toBe(200);
    // hand: 50 kg × 3,800 = 190,000
    expect(await one(`SELECT total_minor::int AS t, status, origin->>'kind' AS k FROM core.purchase_order WHERE id = $1`, [po])).toEqual({ t: 190000, status: "committed", k: "decision" });
    const ev = await one<{ payload: { data: Record<string, unknown> } }>(`SELECT payload FROM core.outbox WHERE aggregateid = $1`, [po]);
    const dec = await one<{ id: string }>(`SELECT id FROM core.decision WHERE draft_id = $1`, [draftId]);
    expect(ev.payload.data).toEqual({ po_id: po, supplier_id: T.sim, outlet_ids: [T.outlets[0]], decision_id: dec.id, draft_id: draftId });
  });

  it("the audit chain verifies after every purchasing write", async () => {
    const v = await verifyAuditChain(svcTx(db), T.tenant);
    expect(v.ok).toBe(true);
    expect(v.rows).toBeGreaterThan(15);
    expect(await count(`SELECT count(*) n FROM core.audit_log WHERE tenant_id = $1 AND entity IN ('core.payable','core.supplier_invoice','core.goods_received','core.supplier_return','core.dispute')`, [T.tenant])).toBeGreaterThanOrEqual(5);
  });
});
