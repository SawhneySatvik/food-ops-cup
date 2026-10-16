// M-C1d gates (0022, BOARD W3 m-1, ledger R45 F11) on the canonical world. Expected sets come from hand-kept sources:
// db/derivation-rules.json (every rule row), the F8 list (BOARD), the hand list of as_of templates below, hand values.
//   (G1) every rule in derivation-rules.json declares a binding for each of its targets and the database holds exactly
//        those (a rule without one → red); the database refuses a rule row without a binding (NOT NULL / CHECK);
//   (G2) per bound rule (54 rows, the case table's keys = the JSON's): a written row that does not belong to its source
//        → MB001 naming the binding, the matching row → admitted by the derivation branch. Run in a clone whose
//        source_state is relaxed to 'true' so the binding alone decides (the states keep their own gates); plus the two
//        gaps the ticket names (purchasing.payable_from_invoice, inventory.count_adjust) with their real states, and the
//        MB008 path inside an approved import;
//   (S1) the F8 draft source CHECK: intel:inventory → 23514, intel:<each F8 id> / member / import → accepted;
//   (A1) the as_of versions: v2 with as_of NULL and with as_of = today return v1's rows exactly (fixture world); the
//        pinned-date check on the worldgen worlds is db/tests/templates-worlds.ts;
//   (A2) the requested columns: each v2 / list template returns exactly its declared columns (v1's + the A2 ones), the
//        values match independent reads, and the list templates match the owner's rows and an outlet-A manager's;
//   (T1) inventory.count_variance on the canonical world's count = the hand values.
// Red-proofs: db/tests/redproof-0022.sh (each gate red with a non-zero exit) and the in-file RED-PROOF tests.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type AppContext, setContext, type TestDb } from "../src/harness.ts";
import { openDb } from "./db.ts";
import { attempt } from "./gates.ts";
import { addOutletData, type McFixture } from "./mc1a-fixture.ts";
import { addMc1bcData, type McbcFixture } from "./mc1bc-fixture.ts";
import { approveDraft, buildWorld, ownerCtx, uuidv7, type World } from "./world.ts";

type Rule = { rule_id: string; source_table: string; target_tables: string[]; source_state: string; bindings?: Record<string, string> };
const DOC = JSON.parse(readFileSync(new URL("../derivation-rules.json", import.meta.url), "utf8")) as { rules: Rule[] };

/** Entries (rule → target) the file leaves unbound, or bound to a table the rule does not write. */
export function unbound(rules: Rule[]): string[] {
  const out: string[] = [];
  for (const r of rules) {
    for (const t of r.target_tables) {
      const b = r.bindings?.[t];
      if (typeof b !== "string" || !/\bs\./.test(b) || !/\bn\./.test(b)) out.push(`${r.rule_id} ${r.source_table} → ${t}`);
    }
    for (const t of Object.keys(r.bindings ?? {})) if (!r.target_tables.includes(t)) out.push(`${r.rule_id} ${r.source_table} → ${t} (not a target)`);
  }
  return out;
}
const KEYS = DOC.rules.flatMap((r) => r.target_tables.map((t) => `${r.rule_id}|${r.source_table}|${t}`)).sort();

let db: TestDb;
/** A copy of the fresh world for A1 / T1, taken before the G2 tests add counts and invoices states to `db`. */
let F: TestDb;
let w: World;
let T = "";
beforeAll(async () => {
  db = await openDb();
  w = await buildWorld(db);
  T = w.tenant;
  F = await db.clone();
});
afterAll(async () => {
  await F?.stop();
  await db?.stop();
});

/** Named params → $n, as core-api's bindNamedParams (copied from tests/mc1bc.test.ts): literals, quoted identifiers,
 *  dollar quotes and comments are skipped; `::` is a cast. */
function bind(sql: string): { sql: string; names: string[] } {
  const names: string[] = [];
  let out = "";
  let i = 0;
  const to = (end: string, from: number) => {
    const j = sql.indexOf(end, from);
    return j < 0 ? sql.length : j + end.length;
  };
  while (i < sql.length) {
    const ch = sql[i]!;
    let next = i + 1;
    if (ch === "'") next = to("'", i + 1);
    else if (ch === '"') next = to('"', i + 1);
    else if (ch === "-" && sql[i + 1] === "-") next = to("\n", i + 2);
    else if (ch === "$" && /^\$[A-Za-z_]*\$/.test(sql.slice(i))) next = to(/^\$[A-Za-z_]*\$/.exec(sql.slice(i))![0], i + 2);
    else if (ch === ":" && sql[i + 1] === ":") next = i + 2;
    else if (ch === ":") {
      const m = /^:([a-z_][a-z0-9_]*)/.exec(sql.slice(i));
      if (m) {
        if (!names.includes(m[1]!)) names.push(m[1]!);
        out += `$${names.indexOf(m[1]!) + 1}`;
        i += m[0].length;
        continue;
      }
    }
    out += sql.slice(i, next);
    i = next;
  }
  return { sql: out, names };
}

const one = async <R extends pg.QueryResultRow>(x: TestDb, sql: string, params: unknown[] = []) => (await x.admin<R>(sql, params)).rows[0]!;

// ---------------------------------------------------------------------------------------------------------------
describe("G1 — every derivation rule declares its binding", () => {
  test("derivation-rules.json binds every target of every rule, and core.derivation_rule holds exactly those bindings", async () => {
    const want = DOC.rules.flatMap((r) => r.target_tables.map((t) => [r.rule_id, r.source_table, t, r.source_state, r.bindings?.[t] ?? "∅"].join(" | "))).sort();
    const got = (await db.admin("SELECT rule_id, source_table, target_table, source_state, binding FROM core.derivation_rule"))
      .rows.map((r) => [r.rule_id, r.source_table, r.target_table, r.source_state, r.binding].join(" | ")).sort();
    console.log(`G1: ${KEYS.length} rule rows in the file, ${unbound(DOC.rules).length} unbound; ${got.length} in the database`);
    expect(unbound(DOC.rules)).toEqual([]);
    expect(KEYS.length).toBe(58); // 0028 adds 4 (Cares)
    expect(got).toEqual(want);
  });

  test("RED-PROOF: a rule entry with no binding, or one that names only its source → listed", () => {
    const planted: Rule[] = [...DOC.rules, { rule_id: "test.unbound", source_table: "core.order", target_tables: ["core.stock_movement"], source_state: "true" },
      { rule_id: "test.loose", source_table: "core.order", target_tables: ["core.payable"], source_state: "true", bindings: { "core.payable": "s.id IS NOT NULL" } }];
    console.log("RED-PROOF G1:", unbound(planted));
    expect(unbound(planted)).toEqual(["test.unbound core.order → core.stock_movement", "test.loose core.order → core.payable"]);
  });

  test("the database refuses a rule row without a binding (23502) and one that binds nothing of the written row (23514)", async () => {
    const x = await db.clone();
    try {
      const ins = (b: string | null) => x.admin(`INSERT INTO core.derivation_rule (rule_id, source_table, target_table, binding) VALUES ('test.rule', 'core.order', 'core.payable', $1)`, [b])
        .then(() => null, (e: { code?: string }) => e.code);
      const [none, loose, ok] = [await ins(null), await ins("s.id IS NOT NULL"), await ins("n.source_id = s.id")];
      console.log(`G1 database: no binding → ${none}, source-only → ${loose}, bound → ${ok ?? "accepted"}`);
      expect([none, loose, ok]).toEqual(["23502", "23514", null]);
    } finally {
      await x.stop();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
// G2 — a clone where every source_state is 'true': each case's write passes or fails on its binding alone.
type Write = { sql: string; params: unknown[] };
type Step = Write & { rule: string; source: string };
type Case = {
  role?: "munim_core" | "munim_crosstenant";
  extra?: AppContext;
  /** Rows written first in the same transaction (each under its own rule), e.g. the consumption a reversal undoes. */
  prep?: Step[];
  source: string;
  ok: Write & { probe: { table: string; id: string; col?: string; want?: string } };
  bad: Write[];
};

describe("G2 — a derived row must belong to its source (relaxed states)", () => {
  let B: TestDb;
  let cases: Record<string, Case>;

  beforeAll(async () => {
    B = await db.clone();
    await B.admin(`UPDATE core.derivation_rule SET source_state = 'true'`);
    const [o0, o1] = w.outlets;
    const id = async (sql: string, params: unknown[] = []) => (await one<{ id: string }>(B, sql, [T, ...params])).id;
    const own = (cmd: string) => ownerCtx(w, { command_type: cmd });
    // Fixture rows the world does not hold: a second ingredient, two more customers, a SKU line and its restocked return.
    const ing2 = uuidv7();
    const [c2, c3] = [uuidv7(), uuidv7()];
    const skuLine = uuidv7();
    const skuReturn = uuidv7();
    const sku = await id(`SELECT id FROM core.item WHERE tenant_id = $1 AND kind = 'sku'`);
    await B.withContext("munim_core", own("inventory.ingredient.upsert.v1"), (c) =>
      c.query(`INSERT INTO core.ingredient (tenant_id, id, name, base_unit, tracked_by_batch) VALUES ($1, $2, 'Ghee', 'g', false)`, [T, ing2]));
    await B.withContext("munim_core", own("customers.customer.upsert.v1"), async (c) => {
      for (const [cid, name] of [[c2, "Asha"], [c3, "Ravi"]]) await c.query(`INSERT INTO core.customer (tenant_id, id, name) VALUES ($1, $2, $3)`, [T, cid, name]);
    });
    await B.withContext("munim_core", own("orders.place.v1"), (c) =>
      c.query(`INSERT INTO core.order_line (tenant_id, id, outlet_id, order_id, line_no, item_id, qty_milli, unit_price_minor, tax_minor) VALUES ($1, $2, $3, $4, 2, $5, 1000, 9000, 0)`,
        [T, skuLine, o0, w.orders[0], sku]));
    await B.withContext("munim_core", own("orders.sale_return.record.v1"), (c) =>
      c.query(`INSERT INTO core.sale_return (tenant_id, id, outlet_id, order_id, order_line_id, qty_milli, restock, reason_code, note, actor)
               VALUES ($1, $2, $3, $4, $5, 1000, true, 'wrong_item', 'sealed pack', $6)`, [T, skuReturn, o0, w.orders[0], skuLine, w.owner]));

    const [order0, order1] = w.orders;
    const s = (await B.admin<{ id: string }>(`SELECT customer_id id FROM core."order" WHERE id = $1`, [order0])).rows[0]!.id; // the world's customer
    const tender0 = await id(`SELECT id FROM core.tender WHERE tenant_id = $1 AND order_id = $2`, [order0]);
    const grn = await one<{ id: string; line_ing: string; line_batch: string }>(B, `SELECT g.id, l.ingredient_id line_ing, l.batch_id line_batch
      FROM core.goods_received g JOIN core.grn_line l ON l.goods_received_id = g.id WHERE g.tenant_id = $1 AND g.outlet_id = $2`, [T, o0]);
    const inv = await one<{ id: string; supplier_id: string }>(B, `SELECT id, supplier_id FROM core.supplier_invoice WHERE tenant_id = $1 ORDER BY id LIMIT 1`, [T]);
    const st = await one<{ id: string; channel_id: string; outlet_id: string | null; line: string }>(B, `SELECT s.id, s.channel_id, s.outlet_id,
      (SELECT l.id FROM core.settlement_line l WHERE l.settlement_id = s.id ORDER BY l.line_no LIMIT 1) line FROM core.settlement s WHERE s.tenant_id = $1 LIMIT 1`, [T]);
    const refund0 = await id(`SELECT id FROM core.refund WHERE tenant_id = $1 AND order_id = $2`, [order0]);
    const refund1 = await id(`SELECT id FROM core.refund WHERE tenant_id = $1 AND order_id = $2`, [order1]);
    const expense = await id(`SELECT id FROM core.expense WHERE tenant_id = $1 LIMIT 1`);
    const payroll = await id(`SELECT id FROM core.payroll_draft WHERE tenant_id = $1 LIMIT 1`);
    const advance = await id(`SELECT id FROM core.advance WHERE tenant_id = $1 LIMIT 1`);
    const tr = await one<{ id: string; ing: string; batch: string | null }>(B, `SELECT t.id, l.ingredient_id ing, l.batch_id batch
      FROM core.transfer t JOIN core.transfer_line l ON l.transfer_id = t.id WHERE t.tenant_id = $1 AND t.from_outlet_id = $2 AND t.to_outlet_id = $3`, [T, o0, o1]);
    const waste = await one<{ id: string; ing: string; batch: string | null }>(B, `SELECT id, ingredient_id ing, batch_id batch FROM core.waste_log WHERE tenant_id = $1 AND outlet_id = $2`, [T, o0]);
    const ret = await one<{ id: string; ing: string; batch: string | null }>(B, `SELECT r.id, l.ingredient_id ing, l.batch_id batch
      FROM core.supplier_return r JOIN core.supplier_return_line l ON l.supplier_return_id = r.id WHERE r.tenant_id = $1 AND r.outlet_id = $2`, [T, o0]);
    const count = await one<{ id: string; ing: string; batch: string | null }>(B, `SELECT c.id, l.ingredient_id ing, l.batch_id batch
      FROM core.stock_count c JOIN core.stock_count_line l ON l.stock_count_id = c.id WHERE c.tenant_id = $1 AND c.outlet_id = $2`, [T, o0]);
    const bank = await id(`SELECT id FROM core.bank_line WHERE tenant_id = $1 LIMIT 1`);
    const opening = await id(`SELECT id FROM core.journal_entry WHERE tenant_id = $1 AND source_id IS NULL ORDER BY id LIMIT 1`);
    const [line0, line1] = w.orderLines;
    const cu = async (order: string) => id(`SELECT id FROM core.coupon_use WHERE tenant_id = $1 AND order_id = $2`, [order]);
    const [cu0, cu1] = [await cu(order0), await cu(order1)];
    const reservation = await id(`SELECT id FROM core.reservation WHERE tenant_id = $1 LIMIT 1`);
    const bulk = await id(`SELECT id FROM core.bulk_order WHERE tenant_id = $1 LIMIT 1`);
    const otherOutlet = (o: string | null) => (o === o0 ? o1 : o0);

    // Builders: the written row (and its id) per target table.
    const sm = (m: { outlet: string; ing: string; batch: string | null; qty: number; kind: string; ref: string; refId: string; unit?: string }) => {
      const mid = uuidv7();
      return { mid, sql: `INSERT INTO core.stock_movement (tenant_id, id, outlet_id, ingredient_id, batch_id, qty_milli, unit, kind, ref_type, ref_id)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, params: [T, mid, m.outlet, m.ing, m.batch, m.qty, m.unit ?? "g", m.kind, m.ref, m.refId] };
    };
    const okSm = (m: Parameters<typeof sm>[0]) => {
      const x = sm(m);
      return { sql: x.sql, params: x.params, probe: { table: "core.stock_movement", id: x.mid } };
    };
    const je = (eid: string, table: string, src: string, rule: string, reverses: string | null = null): Write => ({
      sql: `INSERT INTO core.journal_entry (tenant_id, id, outlet_id, entry_date, source_type, source_id, posting_rule, reverses_id) VALUES ($1, $2, NULL, current_date, $3, $4, $5, $6)`,
      params: [T, eid, table, src, rule, reverses],
    });
    const posting = (pid: string, entry: string): Write => ({
      sql: `INSERT INTO core.posting (tenant_id, id, journal_entry_id, account_id, amount_minor, currency) VALUES ($1, $2, $3, $4, 100, $5)`,
      params: [T, pid, entry, w.accounts.cash, w.currency],
    });
    const brk = (cols: { channel?: string | null; outlet?: string | null; line?: string | null; order?: string | null; bank?: string | null }) => {
      const bid = uuidv7();
      return { bid, sql: `INSERT INTO core.reconciliation_break (tenant_id, id, kind, channel_id, outlet_id, settlement_line_id, order_id, bank_line_id, amount_minor, currency)
                         VALUES ($1, $2, 'other', $3, $4, $5, $6, $7, 1, $8)`,
        params: [T, bid, cols.channel ?? null, cols.outlet ?? null, cols.line ?? null, cols.order ?? null, cols.bank ?? null, w.currency] };
    };
    const okBrk = (cols: Parameters<typeof brk>[0]) => {
      const x = brk(cols);
      return { sql: x.sql, params: x.params, probe: { table: "core.reconciliation_break", id: x.bid } };
    };
    const loyalty = (lid: string, kind: string, points: number, order: string, reverses: string | null = null, refund: string | null = null): Write => ({
      sql: `INSERT INTO core.loyalty_entry (tenant_id, id, customer_id, kind, points, order_id, reverses_id, refund_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      params: [T, lid, s, kind, points, order, reverses, refund],
    });
    const upd = (table: string, set: string, rowId: string, col: string, want: string): Write & { probe: Case["ok"]["probe"] } => ({
      sql: `UPDATE ${table} SET ${set} WHERE tenant_id = $1 AND id = $2`, params: [T, rowId], probe: { table, id: rowId, col, want },
    });

    cases = {};
    // Finance: an entry naming this rule and this source; a posting on such an entry. Mismatch: another source id /
    // the world's opening entry (no source).
    const FIN: Array<[string, string, string]> = [
      ["finance.post_order", "core.order", order0], ["finance.post_loyalty_redemption", "core.order", order0],
      ["finance.post_tender", "core.tender", tender0], ["finance.post_grn", "core.goods_received", grn.id],
      ["finance.post_supplier_invoice", "core.supplier_invoice", inv.id], ["finance.reverse_supplier_invoice", "core.supplier_invoice", inv.id],
      ["finance.post_settlement", "core.settlement", st.id], ["finance.post_refund", "core.refund", refund0],
      ["finance.post_expense", "core.expense", expense], ["finance.post_payroll", "core.payroll_draft", payroll],
      ["finance.reverse_payroll", "core.payroll_draft", payroll], ["finance.post_advance", "core.advance", advance],
    ];
    for (const [rule, table, src] of FIN) {
      const e1 = uuidv7();
      cases[`${rule}|${table}|core.journal_entry`] = {
        source: `${table}:${src}`,
        ok: { ...je(e1, table, src, rule), probe: { table: "core.journal_entry", id: e1 } },
        bad: [je(uuidv7(), table, randomUUID(), rule), je(uuidv7(), table, src, rule === "finance.post_expense" ? "finance.post_refund" : "finance.post_expense")],
      };
      const e2 = uuidv7();
      const p2 = uuidv7();
      cases[`${rule}|${table}|core.posting`] = {
        source: `${table}:${src}`,
        prep: [{ ...je(e2, table, src, rule), rule, source: `${table}:${src}` }],
        ok: { ...posting(p2, e2), probe: { table: "core.posting", id: p2 } },
        bad: [posting(uuidv7(), opening)],
      };
    }
    // A reversal must reverse an entry of its own source.
    const foreign = uuidv7();
    cases["finance.reverse_supplier_invoice|core.supplier_invoice|core.journal_entry"]!.prep = [
      { ...je(foreign, "core.expense", expense, "finance.post_expense"), rule: "finance.post_expense", source: `core.expense:${expense}` }];
    cases["finance.reverse_supplier_invoice|core.supplier_invoice|core.journal_entry"]!.bad.push(je(uuidv7(), "core.supplier_invoice", inv.id, "finance.reverse_supplier_invoice", foreign));

    // Stock movements.
    const consume = (rule: string): Case => ({
      source: `core.order:${order0}`,
      ok: okSm({ outlet: o0, ing: w.ingredient, batch: null, qty: -1000, kind: "sale_consumption", ref: "core.order", refId: order0 }),
      bad: [sm({ outlet: o1, ing: w.ingredient, batch: null, qty: -1000, kind: "sale_consumption", ref: "core.order", refId: order0 }),
            sm({ outlet: o0, ing: w.ingredient, batch: null, qty: -1000, kind: "sale_consumption", ref: "core.order", refId: order1 })],
    });
    cases["inventory.consume_order|core.order|core.stock_movement"] = consume("inventory.consume_order");
    cases["inventory.consume_sku|core.order|core.stock_movement"] = consume("inventory.consume_sku");
    const consumed = sm({ outlet: o0, ing: w.ingredient, batch: null, qty: -1000, kind: "sale_consumption", ref: "core.order", refId: order0 });
    cases["inventory.reverse_order_consumption|core.order|core.stock_movement"] = {
      source: `core.order:${order0}`,
      prep: [{ sql: consumed.sql, params: consumed.params, rule: "inventory.consume_order", source: `core.order:${order0}` }],
      ok: okSm({ outlet: o0, ing: w.ingredient, batch: null, qty: 1000, kind: "sale_return", ref: "core.order", refId: order0 }),
      bad: [sm({ outlet: o0, ing: ing2, batch: null, qty: 1000, kind: "sale_return", ref: "core.order", refId: order0 })],
    };
    cases["inventory.receive_grn|core.goods_received|core.stock_movement"] = {
      source: `core.goods_received:${grn.id}`,
      ok: okSm({ outlet: o0, ing: grn.line_ing, batch: grn.line_batch, qty: 5000, kind: "receipt", ref: "core.goods_received", refId: grn.id }),
      bad: [sm({ outlet: o0, ing: grn.line_ing, batch: null, qty: 5000, kind: "receipt", ref: "core.goods_received", refId: grn.id }),
            sm({ outlet: o0, ing: ing2, batch: null, qty: 5000, kind: "receipt", ref: "core.goods_received", refId: grn.id })],
    };
    cases["inventory.record_waste|core.waste_log|core.stock_movement"] = {
      source: `core.waste_log:${waste.id}`,
      ok: okSm({ outlet: o0, ing: waste.ing, batch: waste.batch, qty: -100, kind: "waste", ref: "core.waste_log", refId: waste.id }),
      bad: [sm({ outlet: o1, ing: waste.ing, batch: null, qty: -100, kind: "waste", ref: "core.waste_log", refId: waste.id }),
            sm({ outlet: o0, ing: ing2, batch: null, qty: -100, kind: "waste", ref: "core.waste_log", refId: waste.id })],
    };
    cases["inventory.transfer_out|core.transfer|core.stock_movement"] = {
      source: `core.transfer:${tr.id}`,
      ok: okSm({ outlet: o0, ing: tr.ing, batch: tr.batch, qty: -1000, kind: "transfer_out", ref: "core.transfer", refId: tr.id }),
      bad: [sm({ outlet: o1, ing: tr.ing, batch: tr.batch, qty: -1000, kind: "transfer_out", ref: "core.transfer", refId: tr.id })],
    };
    cases["inventory.transfer_in|core.transfer|core.stock_movement"] = {
      source: `core.transfer:${tr.id}`,
      ok: okSm({ outlet: o1, ing: tr.ing, batch: null, qty: 1000, kind: "transfer_in", ref: "core.transfer", refId: tr.id }),
      bad: [sm({ outlet: o0, ing: tr.ing, batch: null, qty: 1000, kind: "transfer_in", ref: "core.transfer", refId: tr.id }),
            sm({ outlet: o1, ing: ing2, batch: null, qty: 1000, kind: "transfer_in", ref: "core.transfer", refId: tr.id })],
    };
    const batchRow = (outlet: string, ing: string) => {
      const bid = uuidv7();
      return { bid, sql: `INSERT INTO core.batch (tenant_id, id, outlet_id, ingredient_id, batch_code) VALUES ($1, $2, $3, $4, $5)`, params: [T, bid, outlet, ing, `T-${bid}`] };
    };
    const nb = batchRow(o1, tr.ing);
    // 0028: the rule creates the destination's batch — an UPDATE of an existing one (outlet and ingredient matching) is not it.
    const tb = batchRow(o1, tr.ing);
    cases["inventory.transfer_in|core.transfer|core.batch"] = {
      source: `core.transfer:${tr.id}`,
      prep: [{ sql: tb.sql, params: tb.params, rule: "inventory.transfer_in", source: `core.transfer:${tr.id}` }],
      ok: { sql: nb.sql, params: nb.params, probe: { table: "core.batch", id: nb.bid } },
      bad: [batchRow(o0, tr.ing), batchRow(o1, ing2), { sql: `UPDATE core.batch SET expires_on = '2026-12-31' WHERE tenant_id = $1 AND id = $2`, params: [T, tb.bid] }],
    };
    cases["inventory.supplier_return|core.supplier_return|core.stock_movement"] = {
      source: `core.supplier_return:${ret.id}`,
      ok: okSm({ outlet: o0, ing: ret.ing, batch: ret.batch, qty: -500, kind: "supplier_return", ref: "core.supplier_return", refId: ret.id }),
      bad: [sm({ outlet: o1, ing: ret.ing, batch: null, qty: -500, kind: "supplier_return", ref: "core.supplier_return", refId: ret.id })],
    };
    cases["inventory.sale_return|core.sale_return|core.stock_movement"] = {
      source: `core.sale_return:${skuReturn}`,
      ok: okSm({ outlet: o0, ing: w.ingredient, batch: null, qty: 1000, kind: "sale_return", ref: "core.sale_return", refId: skuReturn }),
      bad: [sm({ outlet: o0, ing: ing2, batch: null, qty: 1000, kind: "sale_return", ref: "core.sale_return", refId: skuReturn })],
    };
    // 0028 (Cares): the world's outlet-1 hand-over (200 g of its donation line, batch 1) and outlet-1 claim (500 g claimed,
    // 300 g received here by the buyer's own receive command). The world's claim names no real offer, so the receive rule
    // (received = the qty the offerer handed over, read through core.cares_claim_outcome; its own gate is cares-0028 RECV)
    // is switched off in this clone for that one write: G2 judges the bindings alone.
    const ho = await one<{ id: string }>(B, `SELECT id FROM core.cares_handover WHERE tenant_id = $1 AND outlet_id = $2`, [T, o0]);
    const cl = await one<{ id: string; line: string }>(B, `SELECT c.id, l.id line FROM core.cares_claim c JOIN core.cares_claim_line l ON l.claim_id = c.id
      WHERE c.tenant_id = $1 AND c.outlet_id = $2`, [T, o0]);
    // A second line of the same ingredient in kg (1 kg received): each unit is capped by its own lines only.
    const kgLine = uuidv7();
    await B.withContext("munim_core", own("cares.claim.create.v1"), (c) =>
      c.query(`INSERT INTO core.cares_claim_line (tenant_id, id, claim_id, offer_line_id, ingredient_id, qty_milli, unit, unit_price_minor)
               VALUES ($1, $2, $3, $4, $5, 1000, 'kg', 30)`, [T, kgLine, cl.id, uuidv7(), w.ingredient]));
    await B.admin(`ALTER TABLE core.cares_claim_line DISABLE TRIGGER cares_rules`);
    await B.withContext("munim_core", own("cares.claim.receive.v1"), async (c) => {
      await c.query(`UPDATE core.cares_claim_line SET received_qty_milli = 300000 WHERE tenant_id = $1 AND id = $2`, [T, cl.line]);
      await c.query(`UPDATE core.cares_claim_line SET received_qty_milli = 1000 WHERE tenant_id = $1 AND id = $2`, [T, kgLine]);
    });
    await B.admin(`ALTER TABLE core.cares_claim_line ENABLE TRIGGER cares_rules`);
    const b0 = w.batches[0];
    cases["inventory.cares_handover|core.cares_handover|core.stock_movement"] = {
      source: `core.cares_handover:${ho.id}`,
      ok: okSm({ outlet: o0, ing: w.ingredient, batch: b0, qty: -200000, kind: "donation", ref: "core.cares_handover", refId: ho.id }),
      bad: [sm({ outlet: o0, ing: w.ingredient, batch: b0, qty: -200001, kind: "donation", ref: "core.cares_handover", refId: ho.id }),
            sm({ outlet: o0, ing: w.ingredient, batch: b0, qty: -1000, kind: "surplus_out", ref: "core.cares_handover", refId: ho.id }),
            sm({ outlet: o0, ing: ing2, batch: null, qty: -1000, kind: "donation", ref: "core.cares_handover", refId: ho.id }),
            sm({ outlet: o0, ing: w.ingredient, batch: w.batches[1], qty: -1000, kind: "donation", ref: "core.cares_handover", refId: ho.id }),
            sm({ outlet: o1, ing: w.ingredient, batch: null, qty: -1000, kind: "donation", ref: "core.cares_handover", refId: ho.id }),
            // 0.2 kg against a 200 g line: never in another unit than the ingredient's base unit (g).
            sm({ outlet: o0, ing: w.ingredient, batch: b0, qty: -200, kind: "donation", ref: "core.cares_handover", refId: ho.id, unit: "kg" })],
    };
    const handed = sm({ outlet: o0, ing: w.ingredient, batch: b0, qty: -200000, kind: "donation", ref: "core.cares_handover", refId: ho.id });
    cases["inventory.cares_handover_void|core.cares_handover|core.stock_movement"] = {
      source: `core.cares_handover:${ho.id}`,
      prep: [{ sql: handed.sql, params: handed.params, rule: "inventory.cares_handover", source: `core.cares_handover:${ho.id}` }],
      ok: okSm({ outlet: o0, ing: w.ingredient, batch: b0, qty: 200000, kind: "cares_reversal", ref: "core.cares_handover", refId: ho.id }),
      bad: [sm({ outlet: o0, ing: w.ingredient, batch: b0, qty: 200001, kind: "cares_reversal", ref: "core.cares_handover", refId: ho.id }),
            sm({ outlet: o0, ing: w.ingredient, batch: null, qty: 1000, kind: "cares_reversal", ref: "core.cares_handover", refId: ho.id })],
    };
    const kgIn = sm({ outlet: o0, ing: w.ingredient, batch: null, qty: 1000, kind: "surplus_in", ref: "core.cares_claim", refId: cl.id, unit: "kg" });
    cases["inventory.cares_claim_receive|core.cares_claim|core.stock_movement"] = {
      source: `core.cares_claim:${cl.id}`,
      prep: [{ sql: kgIn.sql, params: kgIn.params, rule: "inventory.cares_claim_receive", source: `core.cares_claim:${cl.id}` }],
      ok: okSm({ outlet: o0, ing: w.ingredient, batch: null, qty: 300000, kind: "surplus_in", ref: "core.cares_claim", refId: cl.id }),
      bad: [sm({ outlet: o0, ing: w.ingredient, batch: null, qty: 299999, kind: "surplus_in", ref: "core.cares_claim", refId: cl.id }),
            sm({ outlet: o0, ing: ing2, batch: null, qty: 300000, kind: "surplus_in", ref: "core.cares_claim", refId: cl.id }),
            sm({ outlet: o0, ing: w.ingredient, batch: null, qty: 300000, kind: "receipt", ref: "core.cares_claim", refId: cl.id }),
            sm({ outlet: o1, ing: w.ingredient, batch: null, qty: 300000, kind: "surplus_in", ref: "core.cares_claim", refId: cl.id }),
            // A second 1 kg after the prep's 1 kg: the kg line received 1 kg (the g line's 300000 is no kg allowance).
            sm({ outlet: o0, ing: w.ingredient, batch: null, qty: 1000, kind: "surplus_in", ref: "core.cares_claim", refId: cl.id, unit: "kg" })],
    };
    const careBatch = (outlet: string, ing: string, expires: string) => {
      const bid = uuidv7();
      return { bid, sql: `INSERT INTO core.batch (tenant_id, id, outlet_id, ingredient_id, batch_code, expires_on) VALUES ($1, $2, $3, $4, $5, $6)`,
               params: [T, bid, outlet, ing, `C-${bid}`, expires] };
    };
    const cb = careBatch(o0, w.ingredient, "2026-10-12");
    // A batch the receive created earlier (prep): updating it (its expiry kept, so outlet, ingredient and expiry all match)
    // is not a creation; nor is a new batch carrying an MRP or a supplier.
    const pb = careBatch(o0, w.ingredient, "2026-10-12");
    const mrp = careBatch(o0, w.ingredient, "2026-10-12");
    const sup = careBatch(o0, w.ingredient, "2026-10-12");
    const grnB = careBatch(o0, w.ingredient, "2026-10-12");
    const grnLine = (await one<{ id: string }>(B, `SELECT id FROM core.grn_line WHERE tenant_id = $1 AND goods_received_id = $2 LIMIT 1`, [T, grn.id])).id;
    cases["inventory.cares_claim_receive|core.cares_claim|core.batch"] = {
      source: `core.cares_claim:${cl.id}`,
      prep: [{ sql: pb.sql, params: pb.params, rule: "inventory.cares_claim_receive", source: `core.cares_claim:${cl.id}` }],
      ok: { sql: cb.sql, params: cb.params, probe: { table: "core.batch", id: cb.bid } },
      bad: [careBatch(o0, w.ingredient, "2026-10-13"), careBatch(o1, w.ingredient, "2026-10-12"), careBatch(o0, ing2, "2026-10-12"),
            { sql: `UPDATE core.batch SET expires_on = '2026-10-12' WHERE tenant_id = $1 AND id = $2`, params: [T, pb.bid] },
            { sql: mrp.sql.replace("expires_on)", "expires_on, mrp_minor, currency)").replace("$6)", "$6, 5000, $7)"), params: [...mrp.params, w.currency] },
            { sql: sup.sql.replace("expires_on)", "expires_on, supplier_id)").replace("$6)", "$6, $7)"), params: [...sup.params, inv.supplier_id] },
            { sql: grnB.sql.replace("expires_on)", "expires_on, grn_line_id)").replace("$6)", "$6, $7)"), params: [...grnB.params, grnLine] }],
    };
    cases["inventory.count_adjust|core.stock_count|core.stock_movement"] = {
      source: `core.stock_count:${count.id}`,
      ok: okSm({ outlet: o0, ing: count.ing, batch: count.batch, qty: -100, kind: "count_adjust", ref: "core.stock_count", refId: count.id }),
      bad: [sm({ outlet: o1, ing: count.ing, batch: count.batch, qty: -100, kind: "count_adjust", ref: "core.stock_count", refId: count.id }),
            sm({ outlet: o0, ing: ing2, batch: null, qty: -100, kind: "count_adjust", ref: "core.stock_count", refId: count.id })],
    };
    // The payable of this invoice, to its supplier.
    const pay = (pid: string, src: string, supplier: string): Write => ({
      sql: `INSERT INTO core.payable (tenant_id, id, supplier_id, source_type, source_id, due_on, amount_minor, currency) VALUES ($1, $2, $3, 'core.supplier_invoice', $4, current_date, 100, $5)`,
      params: [T, pid, supplier, src, w.currency],
    });
    const p1 = uuidv7();
    cases["purchasing.payable_from_invoice|core.supplier_invoice|core.payable"] = {
      source: `core.supplier_invoice:${inv.id}`,
      ok: { ...pay(p1, inv.id, inv.supplier_id), probe: { table: "core.payable", id: p1 } },
      bad: [pay(uuidv7(), randomUUID(), inv.supplier_id)],
    };
    // Loyalty.
    const l1 = uuidv7();
    cases["customers.loyalty_earn|core.order|core.loyalty_entry"] = {
      source: `core.order:${order0}`,
      ok: { ...loyalty(l1, "earn", 10, order0), probe: { table: "core.loyalty_entry", id: l1 } },
      bad: [loyalty(uuidv7(), "earn", 10, order1)],
    };
    const [earn0, earn1, rv1] = [uuidv7(), uuidv7(), uuidv7()];
    cases["customers.loyalty_reverse|core.order|core.loyalty_entry"] = {
      source: `core.order:${order0}`,
      prep: [{ ...loyalty(earn0, "earn", 10, order0), rule: "customers.loyalty_earn", source: `core.order:${order0}` },
             { ...loyalty(earn1, "earn", 10, order1), rule: "customers.loyalty_earn", source: `core.order:${order1}` }],
      ok: { ...loyalty(rv1, "reverse", -10, order0, earn0), probe: { table: "core.loyalty_entry", id: rv1 } },
      bad: [loyalty(uuidv7(), "reverse", -10, order1, earn1)],
    };
    const [earn2, earn3, rv2] = [uuidv7(), uuidv7(), uuidv7()];
    cases["customers.loyalty_reverse|core.refund|core.loyalty_entry"] = {
      source: `core.refund:${refund0}`,
      prep: [{ ...loyalty(earn2, "earn", 10, order0), rule: "customers.loyalty_earn", source: `core.order:${order0}` },
             { ...loyalty(earn3, "earn", 10, order1), rule: "customers.loyalty_earn", source: `core.order:${order1}` }],
      ok: { ...loyalty(rv2, "reverse", -10, order0, earn2, refund0), probe: { table: "core.loyalty_entry", id: rv2 } },
      bad: [loyalty(uuidv7(), "reverse", -10, order1, earn3, refund1)],
    };
    // Re-price: the source order, its lines, its coupon uses — not another order's.
    cases["orders.reprice|core.order|core.order"] = {
      source: `core.order:${order0}`,
      ok: upd(`core."order"`, `pricing_snapshot = '{"repriced": true}'`, order0, "pricing_snapshot::text", `{"repriced": true}`),
      bad: [upd(`core."order"`, `pricing_snapshot = '{"repriced": true}'`, order1, "", "")],
    };
    cases["orders.reprice|core.order|core.order_line"] = {
      source: `core.order:${order0}`,
      ok: upd("core.order_line", "unit_price_minor = 32100", line0, "unit_price_minor::text", "32100"),
      bad: [upd("core.order_line", "unit_price_minor = 32100", line1, "", "")],
    };
    cases["orders.reprice|core.order|core.coupon_use"] = {
      source: `core.order:${order0}`,
      ok: upd("core.coupon_use", "discount_minor = 7", cu0, "discount_minor::text", "7"),
      bad: [upd("core.coupon_use", "discount_minor = 7", cu1, "", "")],
    };
    // Reconciliation breaks.
    cases["finance.reconcile_settlement|core.settlement|core.reconciliation_break"] = {
      source: `core.settlement:${st.id}`,
      ok: okBrk({ channel: st.channel_id, outlet: st.outlet_id, line: st.line }),
      bad: [brk({ channel: st.channel_id, outlet: otherOutlet(st.outlet_id), line: st.line }), brk({ channel: st.channel_id, outlet: st.outlet_id, line: null })],
    };
    cases["finance.reconcile_bank|core.bank_line|core.reconciliation_break"] = {
      source: `core.bank_line:${bank}`, ok: okBrk({ bank }), bad: [brk({ bank: null })],
    };
    cases["finance.reconcile_order|core.order|core.reconciliation_break"] = {
      source: `core.order:${order0}`, ok: okBrk({ order: order0 }), bad: [brk({ order: order1 })],
    };
    // The definer functions' rules (run as munim_crosstenant): rows move TO the source customer (c2), guests merge INTO it.
    const xt = { role: "munim_crosstenant" as const };
    for (const rule of ["customers.merge_verified_email", "customers.claim_guest_token"]) {
      cases[`${rule}|core.customer|core.order`] = { ...xt, source: `core.customer:${c2}`,
        ok: upd(`core."order"`, `customer_id = '${c2}'`, order1, "customer_id::text", c2), bad: [upd(`core."order"`, `customer_id = '${c3}'`, order1, "", "")] };
      cases[`${rule}|core.customer|core.coupon_use`] = { ...xt, source: `core.customer:${c2}`,
        ok: upd("core.coupon_use", `customer_id = '${c2}'`, cu1, "customer_id::text", c2), bad: [upd("core.coupon_use", `customer_id = '${c3}'`, cu1, "", "")] };
      cases[`${rule}|core.customer|core.customer`] = { ...xt, source: `core.customer:${c2}`,
        ok: upd("core.customer", `merged_into = '${c2}'`, c3, "merged_into::text", c2), bad: [upd("core.customer", `merged_into = '${s}'`, c3, "", "")] };
    }
    cases["customers.merge_verified_email|core.customer|core.reservation"] = { ...xt, source: `core.customer:${c2}`,
      ok: upd("core.reservation", `customer_id = '${c2}'`, reservation, "customer_id::text", c2), bad: [upd("core.reservation", `customer_id = '${c3}'`, reservation, "", "")] };
    cases["customers.merge_verified_email|core.customer|core.bulk_order"] = { ...xt, source: `core.customer:${c2}`,
      ok: upd("core.bulk_order", `customer_id = '${c2}'`, bulk, "customer_id::text", c2), bad: [upd("core.bulk_order", `customer_id = '${c3}'`, bulk, "", "")] };
    cases["customers.erase_merged_guests|core.customer|core.customer"] = { ...xt, source: `core.customer:${c2}`,
      extra: { command_type: "customers.erasure.request.v1" },
      prep: [{ ...upd("core.customer", `merged_into = '${c2}'`, c3, "", ""), rule: "customers.merge_verified_email", source: `core.customer:${c2}` }],
      ok: upd("core.customer", "erased_at = now()", c3, "(erased_at IS NOT NULL)::text", "true"),
      // A guest merged into someone else (the world's customer) is not the source's to erase.
      bad: [upd("core.customer", "erased_at = now()", s, "", "")] };
  }, 300_000);
  afterAll(async () => B?.stop());

  /** One transaction as `role` (rolled back): prep steps, then `write` under the case's rule and source. */
  async function run(rule: string, k: Case, write: Write, probe?: Case["ok"]["probe"]): Promise<{ err: { code: string; message: string } | null; got: unknown }> {
    const c = await B.connect("admin");
    try {
      await c.query("BEGIN");
      await c.query(`SET LOCAL ROLE ${k.role ?? "munim_core"}`);
      for (const p of k.prep ?? []) {
        await setContext(c, { tenant_id: T, outlet_ids: "*", ...k.extra, posting_rule: p.rule, source_ref: p.source });
        await c.query(p.sql, p.params);
      }
      await setContext(c, { tenant_id: T, outlet_ids: "*", ...k.extra, posting_rule: rule, source_ref: k.source });
      try {
        await c.query(write.sql, write.params);
      } catch (e) {
        const x = e as { code?: string; message: string };
        return { err: { code: x.code ?? "?", message: x.message }, got: null };
      }
      if (!probe) return { err: null, got: null };
      await c.query("RESET ROLE");
      const r = await c.query(`SELECT ${probe.col ?? "origin"} AS v FROM ${probe.table} WHERE tenant_id = $1 AND id = $2`, [T, probe.id]);
      return { err: null, got: r.rows[0]?.v };
    } finally {
      await c.query("ROLLBACK").catch(() => {});
      await c.end();
    }
  }

  test("the case table covers exactly the rule rows of derivation-rules.json", () => {
    console.log(`G2: ${Object.keys(cases).length} cases, ${KEYS.length} rule rows`);
    expect(Object.keys(cases).sort()).toEqual(KEYS);
  });

  test("per rule row: the matching row is admitted as that derivation; every mismatched row → MB001 naming the binding", async () => {
    const fails: string[] = [];
    let refused = 0;
    for (const key of KEYS) {
      const [rule] = key.split("|");
      const k = cases[key]!;
      const ok = await run(rule!, k, k.ok, k.ok.probe);
      const admitted = ok.err === null && (k.ok.probe.col
        ? ok.got === k.ok.probe.want
        : (ok.got as { kind?: string; rule_id?: string } | null)?.kind === "derivation" && (ok.got as { rule_id?: string }).rule_id === rule);
      if (!admitted) fails.push(`${key}: matching row not admitted (${ok.err ? `${ok.err.code} ${ok.err.message}` : JSON.stringify(ok.got)})`);
      for (const [i, bad] of k.bad.entries()) {
        const r = await run(rule!, k, bad);
        if (r.err?.code === "MB001" && r.err.message.includes(`does not belong to the source of ${rule}`)) refused++;
        else fails.push(`${key} mismatch #${i + 1}: ${r.err ? `${r.err.code} ${r.err.message}` : "accepted"}`);
      }
    }
    const nBad = Object.values(cases).reduce((a, k) => a + k.bad.length, 0);
    console.log(`G2: ${KEYS.length - fails.filter((f) => f.includes("matching")).length}/${KEYS.length} matching rows admitted; ${refused}/${nBad} mismatched rows → MB001 (binding)`);
    for (const f of fails) console.log(`  ${f}`);
    expect(fails).toEqual([]);
    expect(refused).toBe(nBad);
    expect(nBad).toBeGreaterThanOrEqual(KEYS.length);
  }, 300_000);
});

// ---------------------------------------------------------------------------------------------------------------
describe("G2 — the two named gaps with their real source states, and the MB008 path", () => {
  test("inventory.count_adjust: a submitted count's own outlet + ingredient → accepted; another outlet or an uncounted ingredient → MB001; inside an approved import → MB008 / accepted", async () => {
    const [o0, o1] = w.outlets;
    const countId = uuidv7();
    const ing2 = uuidv7();
    await db.withContext("munim_core", ownerCtx(w, { command_type: "inventory.ingredient.upsert.v1" }), (c) =>
      c.query(`INSERT INTO core.ingredient (tenant_id, id, name, base_unit, tracked_by_batch) VALUES ($1, $2, 'Ghee', 'g', false)`, [T, ing2]));
    await db.withContext("munim_core", ownerCtx(w, { command_type: "inventory.count.submit.v1" }), async (c) => {
      await c.query(`INSERT INTO core.stock_count (tenant_id, id, outlet_id, counted_by, status) VALUES ($1, $2, $3, $4, 'submitted')`, [T, countId, o0, w.owner]);
      await c.query(`INSERT INTO core.stock_count_line (tenant_id, id, stock_count_id, ingredient_id, expected_qty_milli, counted_qty_milli, unit) VALUES ($1, $2, $3, $4, 1000, 900, 'g')`,
        [T, uuidv7(), countId, w.ingredient]);
    });
    const rule = { tenant_id: T, outlet_ids: "*" as const, posting_rule: "inventory.count_adjust", source_ref: `core.stock_count:${countId}` };
    const mv = (outlet: string, ing: string) => [`INSERT INTO core.stock_movement (tenant_id, id, outlet_id, ingredient_id, qty_milli, unit, kind, ref_type, ref_id)
      VALUES ($1, gen_random_uuid(), $2, $3, -100, 'g', 'count_adjust', 'core.stock_count', $4) RETURNING origin`, [T, outlet, ing, countId]] as [string, unknown[]];
    const ok = await db.withContext("munim_core", rule, (c) => c.query<{ origin: unknown }>(...mv(o0, w.ingredient))).then((r) => r.rows[0]?.origin, (e) => e.code);
    const wrongOutlet = await attempt(db, "munim_core", rule, ...mv(o1, w.ingredient));
    const wrongIng = await attempt(db, "munim_core", rule, ...mv(o0, ing2));
    // An approved import binds no movement (0021 H2): an unbound one falls through to the decision's MB008.
    const inImport = (outlet: string) => approveDraft(db, w, "imports.run.commit.v1", async (q) => {
      await q(`SELECT set_config('app.posting_rule', 'inventory.count_adjust', true), set_config('app.source_ref', $1, true)`, [`core.stock_count:${countId}`]);
      await q(mv(outlet, w.ingredient)[0], [...mv(outlet, w.ingredient)[1]]);
    }).then(() => null, (e: { code?: string }) => e.code);
    const [impBad, impOk] = [await inImport(o1), await inImport(o0)];
    console.log(`count_adjust (real state): own outlet + counted ingredient → ${JSON.stringify(ok)}; outlet B → ${wrongOutlet?.code}; uncounted → ${wrongIng?.code}; in an import: outlet B → ${impBad}, own → ${impOk ?? "accepted"}`);
    expect(ok).toEqual({ kind: "derivation", rule_id: "inventory.count_adjust", source_ref: `core.stock_count:${countId}` });
    expect([wrongOutlet?.code, wrongIng?.code, impBad, impOk]).toEqual(["MB001", "MB001", "MB008", null]);
    expect(wrongOutlet?.message).toContain("does not belong to the source of inventory.count_adjust");
  });

  test("purchasing.payable_from_invoice: an approved invoice's own payable → accepted; a payable naming another invoice → MB001", async () => {
    const inv = await one<{ id: string; supplier_id: string }>(db, `SELECT id, supplier_id FROM core.supplier_invoice WHERE tenant_id = $1 AND status = 'recorded' ORDER BY id LIMIT 1`, [T]);
    expect(await attempt(db, "munim_core", ownerCtx(w, { command_type: "purchasing.invoice.approve.v1" }),
      `UPDATE core.supplier_invoice SET status = 'approved' WHERE tenant_id = $1 AND id = $2`, [T, inv.id])).toBeNull();
    const rule = { tenant_id: T, outlet_ids: "*" as const, posting_rule: "purchasing.payable_from_invoice", source_ref: `core.supplier_invoice:${inv.id}` };
    const pay = (src: string) => [`INSERT INTO core.payable (tenant_id, id, supplier_id, source_type, source_id, due_on, amount_minor, currency)
      VALUES ($1, gen_random_uuid(), $2, 'core.supplier_invoice', $3, current_date, 100, $4)`, [T, inv.supplier_id, src, w.currency]] as [string, unknown[]];
    const other = randomUUID();
    const [ok, bad] = [await attempt(db, "munim_core", rule, ...pay(inv.id)), await attempt(db, "munim_core", rule, ...pay(other))];
    console.log(`payable_from_invoice (real state): own invoice → ${ok?.code ?? "accepted"}; another invoice → ${bad?.code}`);
    expect(ok).toBeNull();
    expect(bad?.code).toBe("MB001");
    expect(bad?.message).toContain("does not belong to the source of purchasing.payable_from_invoice");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("S1 — a draft's source is one of the eight F8 specialists", () => {
  const F8 = ["catalogue", "kitchen", "inventory_purchasing", "finance", "people", "customers", "compliance", "market"];
  test("intel:inventory, intel:manager, intel:forecast → 23514; import, member and intel:<each F8 id> → accepted", async () => {
    const draft = (source: string) => attempt(db, "munim_svc", { tenant_id: T, outlet_ids: "*" },
      `INSERT INTO core.draft (tenant_id, id, outlet_ids, source, run_id, command_type, command_payload) VALUES ($1, gen_random_uuid(), '{}', $2, $3, 'inventory.reorder_level.set.v1', '{}')`,
      [T, source, w.run]);
    const refused = [];
    for (const s of ["intel:inventory", "intel:manager", "intel:forecast"]) refused.push((await draft(s))?.code);
    const accepted = [];
    for (const s of ["import", "member", ...F8.map((p) => `intel:${p}`)]) accepted.push((await draft(s))?.code ?? "accepted");
    console.log(`S1: refused ${JSON.stringify(refused)}; accepted ${accepted.filter((a) => a === "accepted").length}/${accepted.length}`);
    expect(refused).toEqual(["23514", "23514", "23514"]);
    expect(accepted).toEqual(Array(10).fill("accepted"));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// A1 — the hand list of templates 0022 versions for as_of (the M-C1bc list + the three the clock query found); A2 — the
// columns the pack lanes asked for (orchestrator, 11 Oct), by hand: appended after v1's, one rename.
const AS_OF_TEMPLATES = [
  "catalogue.cost_drift", "catalogue.recipe_current", "compliance.energy_per_order", "forecast.slot_profile", "inventory.dead_stock",
  "inventory.expiry_risk", "inventory.shortfall", "market.competitor_gap", "market.goal_baseline", "market.goal_progress",
  "market.signal_uplift", "market.upcoming", "people.advances_open", "purchasing.deal_inputs",
];
const A2_EXTRA: Record<string, string[]> = {
  "inventory.expiry_risk": ["ingredient_id", "unit", "supplier_id"],
  "catalogue.cost_drift": ["price_id", "channel_kind", "tax_class"],
  "catalogue.recipe_current": ["unit"],
  "catalogue.dish_margin": ["price_id", "channel_kind", "tax_class"],
};
const RENAMED: Record<string, Record<string, string>> = { "market.upcoming": { forecast_units: "forecast_orders" } };
const NEW_LISTS = ["inventory.counts", "market.goals", "purchasing.invoices"];

/** 0023 (M-C1e) adds version 2 of these nine (gated in tests/mc1e.test.ts); 0022's version 2s are the rest. Hand-kept. */
const MC1E_V2 = ["finance.settlement_vs_orders", "finance.missing_payouts", "finance.tender_vs_bank", "finance.gst_check", "customers.coupon_current",
  "compliance.licence_calendar", "compliance.log_coverage", "people.overtime_drift", "kitchen.ticket_times"];
/** Later version 2s with their own gates: 0025 intel.investigation_cost_estimate (tests/w3close.test.ts), 0026
 *  people.labour_vs_demand (tests/w3decisions.test.ts), 0033 kitchen.prep_need and forecast.points (tests/forecast-outlet-0033.test.ts),
 *  0035 customers.consented_audience (tests/consent-0035.test.ts). */
const LATER_V2 = ["intel.investigation_cost_estimate", "people.labour_vs_demand", "kitchen.prep_need", "forecast.points", "customers.consented_audience"];

describe("A1 / A2 — version 2 of the templates", () => {
  let fx: McFixture;
  let fy: McbcFixture;
  beforeAll(async () => {
    fx = await addOutletData(F, w);
    fy = await addMc1bcData(F, w, fx);
  }, 300_000);

  const params = (id: string, outlet: string | null = null): Record<string, unknown> => {
    switch (id) {
      case "catalogue.cost_drift": return { outlet_id: outlet, since: "2026-08-01" };
      case "catalogue.recipe_current": return { item_id: fx.dish, outlet_id: outlet };
      case "catalogue.dish_margin": return { outlet_id: outlet, channel_kind: null, from: "2026-07-01", to: fy.today };
      case "compliance.energy_per_order": return { outlet_id: outlet, months: 4 };
      case "forecast.slot_profile": return { outlet_id: outlet, weeks: 12, slot_minutes: 60 };
      case "inventory.dead_stock": return { outlet_id: outlet, days: 30 };
      case "inventory.expiry_risk": return { outlet_id: outlet, days: 7 };
      case "inventory.shortfall": return { outlet_id: outlet, lead_days: 7 };
      case "market.competitor_gap": return { outlet_id: outlet, days: 30 };
      case "market.goal_baseline": return { outlet_id: outlet, metric: "orders", months: 6 };
      case "market.goal_progress": return { goal_id: fy.goals[0] };
      case "market.signal_uplift": return { outlet_id: outlet, kind: "festival", label: null, lookback_days: 365 };
      case "market.upcoming": return { outlet_id: outlet, days: 7 };
      case "people.advances_open": return { outlet_id: outlet };
      case "purchasing.deal_inputs": return { quote_id: fy.quotes[0] };
      case "inventory.counts": return { outlet_id: outlet, from: "2026-01-01", to: "2100-01-01" };
      case "market.goals": return { outlet_id: outlet };
      case "purchasing.invoices": return { from: "2000-01-01", to: "2100-01-01" };
      default: throw new Error(`no params for ${id}`);
    }
  };
  type Out = { fields: string[]; rows: Record<string, unknown>[] };
  /** Runs version `v` with named params bound as core-api does (every named param must be supplied). */
  async function run(id: string, v: number, p: Record<string, unknown>, ctx: AppContext = ownerCtx(w)): Promise<Out> {
    const t = (await F.admin<{ sql: string }>("SELECT sql FROM evidence.snapshot_template WHERE id = $1 AND version = $2", [id, v])).rows[0];
    if (!t) throw new Error(`no ${id} v${v}`);
    const { sql, names } = bind(t.sql);
    for (const n of names) if (!(n in p)) throw new Error(`${id} v${v}: param ${n} not supplied`);
    const r = await F.withContext("munim_core", ctx, (c) => c.query(`SELECT * FROM (${sql}) t`, names.map((n) => p[n])));
    return { fields: r.fields.map((f) => f.name), rows: r.rows };
  }
  /** v2's rows as v1 would print them: v1's columns only, renamed back. */
  const asV1 = (id: string, o: Out, v1Fields: string[]) => JSON.stringify(o.rows.map((r) =>
    Object.fromEntries(Object.entries(r).map(([k, x]) => [RENAMED[id]?.[k] ?? k, x]).filter(([k]) => v1Fields.includes(k as string)))));

  test("exactly the hand list has a version 2: the as_of ones require a nullable as_of beside v1's params; dish_margin keeps v1's", async () => {
    const live = (await F.admin<{ id: string; req: string[]; p: string[] }>(`SELECT t2.id, ARRAY(SELECT jsonb_array_elements_text(t2.params_schema -> 'required') ORDER BY 1) req,
        ARRAY(SELECT jsonb_array_elements_text(t1.params_schema -> 'required') ORDER BY 1) p
      FROM evidence.snapshot_template t2 JOIN evidence.snapshot_template t1 ON t1.id = t2.id AND t1.version = 1
     WHERE t2.version = 2 AND NOT t2.id = ANY ($1) ORDER BY 1`, [[...MC1E_V2, ...LATER_V2]])).rows;
    console.log(`A1: ${live.length} version-2 templates`);
    expect(live.map((r) => r.id)).toEqual([...AS_OF_TEMPLATES, "catalogue.dish_margin"].sort());
    for (const r of live) expect(r.req).toEqual(r.id === "catalogue.dish_margin" ? r.p : [...r.p, "as_of"].sort());
  });

  test("every version 2 and list template returns exactly its declared columns: v1's (one rename) + the A2 ones, in order", async () => {
    const bad: string[] = [];
    for (const [id, v] of [...[...AS_OF_TEMPLATES, "catalogue.dish_margin"].map((i) => [i, 2] as const), ...NEW_LISTS.map((i) => [i, 1] as const)]) {
      const p = { ...params(id), ...(AS_OF_TEMPLATES.includes(id) ? { as_of: null } : {}) };
      const out = await run(id, v, p);
      const decl = (await F.admin<{ n: string[] }>(`SELECT ARRAY(SELECT c ->> 'name' FROM jsonb_array_elements(columns) c) n FROM evidence.snapshot_template WHERE id = $1 AND version = $2`, [id, v])).rows[0]!.n;
      if (JSON.stringify(out.fields) !== JSON.stringify(decl)) bad.push(`${id} v${v}: returns ${out.fields.join(",")}, declares ${decl.join(",")}`);
      if (v === 2) {
        const v1 = (await run(id, 1, params(id))).fields.map((f) => (id === "market.upcoming" && f === "forecast_orders" ? "forecast_units" : f));
        if (JSON.stringify(decl) !== JSON.stringify([...v1, ...(A2_EXTRA[id] ?? [])])) bad.push(`${id}: v2 columns ${decl.join(",")} ≠ v1 + A2`);
      }
    }
    console.log(`A2 columns: ${AS_OF_TEMPLATES.length + 1 + NEW_LISTS.length - bad.length} exact`);
    expect(bad).toEqual([]);
  }, 120_000);

  test("v2 with as_of NULL, and with as_of = today, returns v1's rows exactly (on v1's columns); dish_margin v2 = v1", async () => {
    const today = (await F.admin<{ d: string[]; s: string }>(`SELECT array_agg(DISTINCT ((now() AT TIME ZONE tz) - business_day_cutoff)::date::text) d, current_date::text s
      FROM core.outlet WHERE tenant_id = $1`, [T])).rows[0]!;
    expect(today.d.length).toBe(1);
    const diff: string[] = [];
    let nonEmpty = 0;
    let skipped = 0;
    for (const id of [...AS_OF_TEMPLATES, "catalogue.dish_margin"]) {
      const p = params(id);
      const one = await run(id, 1, p);
      const v1 = JSON.stringify(one.rows);
      if (one.rows.length > 0) nonEmpty++;
      if (id === "catalogue.dish_margin") {
        if (asV1(id, await run(id, 2, p), one.fields) !== v1) diff.push(id);
        continue;
      }
      if (asV1(id, await run(id, 2, { ...p, as_of: null }), one.fields) !== v1) diff.push(`${id} at NULL`);
      // v1 of these three reads the server's current_date (the others the outlet's business date); deal_inputs reads both.
      const day = ["catalogue.cost_drift", "catalogue.recipe_current"].includes(id) ? today.s : today.d[0]!;
      if (id === "purchasing.deal_inputs" && today.s !== today.d[0]) {
        skipped++;
        console.log(`A1 SKIP ${id} at today: the server date ${today.s} ≠ the outlet date ${today.d[0]}`);
        continue;
      }
      if (asV1(id, await run(id, 2, { ...p, as_of: day }), one.fields) !== v1) diff.push(`${id} at ${day}`);
    }
    console.log(`A1: v2 = v1 for ${AS_OF_TEMPLATES.length + 1 - new Set(diff.map((d) => d.split(" ")[0])).size}/${AS_OF_TEMPLATES.length + 1} templates (${nonEmpty} with rows on the fixture; ${skipped} skipped at today)`);
    expect(diff).toEqual([]);
    expect(nonEmpty).toBeGreaterThanOrEqual(6);
  }, 120_000);

  test("A2 values against independent reads: price ids by the counter-first rule, units, the batch's GRN supplier", async () => {
    const bad: string[] = [];
    // The current price per item in the owner's scope on the day: counter first, then the highest (cost_drift's pr rule).
    const priceOn = async (item: string, day: string) => (await F.admin<{ id: string; channel_kind: string; tax_class: string }>(
      `SELECT id, channel_kind, tax_class FROM core.price WHERE tenant_id = $1 AND item_id = $2 AND valid_from <= $3::date AND (valid_to IS NULL OR valid_to > $3::date)
        ORDER BY channel_kind = 'counter' DESC, amount_minor DESC, id LIMIT 1`, [T, item, day])).rows[0];
    let checked = 0;
    for (const r of (await run("catalogue.dish_margin", 2, params("catalogue.dish_margin"))).rows) {
      const want = await priceOn(r.item_id as string, fy.today);
      if ((want?.id ?? null) !== r.price_id || (want?.channel_kind ?? null) !== r.channel_kind || (want?.tax_class ?? null) !== r.tax_class) bad.push(`dish_margin ${r.item_id}`);
      if (want) checked++;
    }
    const sd = (await F.admin<{ d: string }>("SELECT current_date::text d")).rows[0]!.d;
    for (const r of (await run("catalogue.cost_drift", 2, { ...params("catalogue.cost_drift"), as_of: null })).rows) {
      const want = await priceOn(r.item_id as string, sd);
      if (want?.id !== r.price_id || want?.channel_kind !== r.channel_kind || want?.tax_class !== r.tax_class) bad.push(`cost_drift ${r.item_id}`);
      checked++;
    }
    for (const r of (await run("catalogue.recipe_current", 2, { ...params("catalogue.recipe_current"), as_of: null })).rows) {
      const u = (await F.admin<{ unit: string }>(`SELECT unit FROM core.recipe_line WHERE tenant_id = $1 AND recipe_version_id = $2 AND ingredient_id = $3`,
        [T, r.recipe_version_id, r.ingredient_id])).rows.map((x) => x.unit);
      if (!u.includes(r.unit as string)) bad.push(`recipe_current ${r.ingredient_id}`);
      checked++;
    }
    for (const r of (await run("inventory.expiry_risk", 2, { ...params("inventory.expiry_risk"), as_of: null })).rows) {
      const b = (await F.admin<{ ingredient_id: string; unit: string; supplier_id: string | null }>(
        `SELECT b.ingredient_id, g.base_unit AS unit,
                (SELECT gr.supplier_id FROM core.grn_line l JOIN core.goods_received gr ON gr.id = l.goods_received_id
                  WHERE l.batch_id = b.id ORDER BY gr.received_at DESC LIMIT 1) AS supplier_id
           FROM core.batch b JOIN core.ingredient g ON g.id = b.ingredient_id WHERE b.id = $1`, [r.batch_id])).rows[0]!;
      if (b.ingredient_id !== r.ingredient_id || b.unit !== r.unit || (b.supplier_id !== null && b.supplier_id !== r.supplier_id)) bad.push(`expiry_risk ${r.batch_id}`);
      checked++;
    }
    console.log(`A2 values: ${checked} rows checked, ${bad.length} wrong`);
    expect(bad).toEqual([]);
    expect(checked).toBeGreaterThanOrEqual(4);
  }, 120_000);

  test("the list templates: invoices = the non-void invoices; counts and goals = the owner's, and an outlet-A manager sees only outlet A's", async () => {
    // The fixtures' counts are open: one submitted count at each of outlets A and B (and an open one, never listed).
    await F.withContext("munim_core", ownerCtx(w, { command_type: "inventory.count.submit.v1" }), async (c) => {
      // Each its own counted_at (0024: one count per outlet per instant; now() is the transaction's start).
      for (const [i, [o, st]] of ([[fx.A, "submitted"], [fx.B, "submitted"], [fx.A, "open"]] as const).entries()) {
        await c.query(`INSERT INTO core.stock_count (tenant_id, id, outlet_id, counted_by, status, counted_at) VALUES ($1, $2, $3, $4, $5, now() - make_interval(secs => $6))`,
          [T, uuidv7(), o, w.owner, st, i]);
      }
    });
    const inv = (await run("purchasing.invoices", 1, params("purchasing.invoices"))).rows.map((r) => r.supplier_invoice_id).sort();
    const invWant = (await F.admin<{ id: string }>(`SELECT id FROM core.supplier_invoice WHERE tenant_id = $1 AND status <> 'void' ORDER BY id`, [T])).rows.map((r) => r.id);
    const mgr: AppContext = { tenant_id: T, outlet_ids: [fx.A], role: "manager", member_id: fx.managerA };
    const scoped: string[] = [];
    for (const [id, col, table, where] of [["inventory.counts", "count_id", "core.stock_count", "status = 'submitted'"], ["market.goals", "goal_id", "core.goal", "status = 'active'"]] as const) {
      const own = (await run(id, 1, params(id))).rows;
      const want = (await F.admin<{ id: string }>(`SELECT id FROM ${table} WHERE tenant_id = $1 AND ${where} ORDER BY id`, [T])).rows.map((r) => r.id);
      const m = (await run(id, 1, params(id), mgr)).rows;
      const wantA = (await F.admin<{ id: string }>(`SELECT id FROM ${table} WHERE tenant_id = $1 AND ${where} AND (outlet_id = $2${id === "market.goals" ? " OR outlet_id IS NULL" : ""}) ORDER BY id`, [T, fx.A])).rows.map((r) => r.id);
      console.log(`${id}: owner ${own.length} (want ${want.length}), manager A ${m.length} (want ${wantA.length})`);
      if (JSON.stringify(own.map((r) => r[col]).sort()) !== JSON.stringify(want)) scoped.push(`${id} owner`);
      if (JSON.stringify(m.map((r) => r[col]).sort()) !== JSON.stringify(wantA) || m.some((r) => r.outlet_id === fx.B)) scoped.push(`${id} manager`);
      if (want.length === 0 || wantA.length === 0 || wantA.length === want.length) scoped.push(`${id}: the fixture does not separate the scopes (${want.length}, ${wantA.length})`);
    }
    console.log(`purchasing.invoices: ${inv.length} (want ${invWant.length})`);
    expect(inv).toEqual(invWant);
    expect(invWant.length).toBeGreaterThan(0);
    expect(scoped).toEqual([]);
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------------------------
describe("T1 — templates no pack owns", () => {
  test("inventory.count_variance on the canonical world's outlet-1 count: −100,000 g at 40,000 per 1000 g → −4,000; Σ row = −4,000", async () => {
    const x = await db.clone();
    try {
      // The world's own count at outlet 1 (world.ts: one line, expected 5,000,000 g, counted 4,900,000 g).
      const count = (await x.admin<{ id: string }>(`SELECT c.id FROM core.stock_count c JOIN core.stock_count_line l ON l.stock_count_id = c.id
        WHERE c.tenant_id = $1 AND c.outlet_id = $2 AND l.expected_qty_milli = 5000000 AND l.counted_qty_milli = 4900000`, [T, w.outlets[0]])).rows[0]!.id;
      const t = (await x.admin<{ sql: string }>(`SELECT sql FROM evidence.snapshot_template WHERE id = 'inventory.count_variance'`)).rows[0]!;
      const { sql, names } = bind(t.sql);
      expect(names).toEqual(["count_id"]);
      const r = await x.withContext("munim_core", ownerCtx(w), (c) => c.query(sql, [count]));
      const got = r.rows.map((y) => [y.expected_qty_milli, y.counted_qty_milli, y.variance_qty_milli, y.variance_value_minor].map((v) => (v === null ? null : String(v))));
      console.log("count_variance:", JSON.stringify(got));
      // The outlet's receipt cost: 40 per g (world.ts unit_cost_minor 40) = 40,000 per 1000 g; −100,000 × 40,000 ÷ 1,000,000.
      expect(got).toEqual([["5000000", "4900000", "-100000", "-4000"], [null, null, null, "-4000"]]);
    } finally {
      await x.stop();
    }
  });
});
