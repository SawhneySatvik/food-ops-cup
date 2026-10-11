// M-C1e gates (0023, BOARD W3 m-1) on the canonical world + the M-C1a and M-C1bc fixtures + the hand-valued rows below.
// Expected values are hand-kept here (each worked out beside its fixture row), never read from the templates' SQL:
//   (C) columns exact: each version 2 returns exactly its declared columns, = version 1's + the requested ones (hand list);
//       min_role = version 1's (hand list); params = version 1's (gst_check: + a nullable outlet_id);
//   (S) outlet scope: an outlet-A manager minting each outlet-scoped version 2 sees exactly the owner's outlet-A rows, and
//       for outlet B exactly what an outlet with no data shows (0 rows of B); licence_calendar lists outlet A only;
//   (V) version 1 kept: each version 2's detail rows, on version 1's columns, are version 1's rows (Σ rows aside);
//   (H) hand values: the settlement line rule (an overpaid, a sub-₹1 and a sub-0.5% line do not count), the tender week Σ
//       (gap days the statement reaches, median × gap days, one shift member), missing payouts per channel (oldest age),
//       gst_check narrowed to one outlet, coupon terms with identity and scope, licences in force / expired / lapsed /
//       missing with the manager rule, log coverage's manager per row, overtime Σ per staff member, ticket times per station
//       and item over every slot; the pack thresholds the finance versions read exist in both seeded packs;
//   (D1) findings.dismiss.v1: under it munim_core sets a finding's status, and no book table admits a row (MB008 / MB001).
// The worldgen answer-key checks (RG-F3, RG-F4 + F7, RG-F5, CK-F3, AU-F3, RG-P1, AU-P1, RG-A5, ST-A5, AU-A5) are in
// tests/templates-worlds.ts. Red-proofs: db/tests/redproof-0023.sh (each gate red with a non-zero exit).
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { AppContext, TestDb } from "../src/harness.ts";
import { openDb } from "./db.ts";
import { attempt } from "./gates.ts";
import { addOutletData, type McFixture } from "./mc1a-fixture.ts";
import { addMc1bcData, type McbcFixture } from "./mc1bc-fixture.ts";
import { approveDraft, buildWorld, ownerCtx, uuidv7, type World } from "./world.ts";

const u = uuidv7;
let db: TestDb;
let w: World;
let fx: McFixture;
let fy: McbcFixture;
let e: Mc1e;
const NO_OUTLET = randomUUID();

/** The nine version 2s, their appended columns and roles (0023 header; hand-kept from the requests). */
const V2: Record<string, { extra: string[]; role: string }> = {
  "finance.settlement_vs_orders": { extra: ["settlement_id", "channel_id"], role: "advisor" },
  "finance.missing_payouts": { extra: ["channel_id"], role: "advisor" },
  "finance.tender_vs_bank": { extra: ["week_start", "gap_days"], role: "advisor" },
  "finance.gst_check": { extra: [], role: "advisor" },
  "customers.coupon_current": { extra: ["code", "kind", "valid_from", "valid_to", "outlet_ids", "active", "requires_customer"], role: "manager" },
  "compliance.licence_calendar": { extra: ["status", "manager_member_id"], role: "manager" },
  "compliance.log_coverage": { extra: ["manager_member_id"], role: "manager" },
  "people.overtime_drift": { extra: [], role: "manager" },
  "kitchen.ticket_times": { extra: [], role: "manager" },
};
/** The column that is NULL exactly on a version 2's Σ / whole-window rows. */
const SIGMA: Record<string, string> = {
  "finance.settlement_vs_orders": "settlement_line_id", "finance.missing_payouts": "order_id", "finance.tender_vs_bank": "business_on",
  "people.overtime_drift": "iso_week", "kitchen.ticket_times": "slot_start",
};

interface Mc1e {
  managerA2: string;
  managerC: string;
  settlementE: string;
  lineE5: string;
  aggE: string;
  aggF: string;
  shift: string;
  shift2: string;
  coupon: string;
  licences: { aTrade: string; aFire: string; bTrade: string };
}

/** Named params → $n, as core-api's bindNamedParams (copied from tests/mc1d.test.ts). */
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

type Row = Record<string, string | null>;
/** Runs version `v` as core-api's runTemplate does (`… FROM (<sql>) t LIMIT 500`, cells as text); fields from the SQL. */
async function run(id: string, v: number, p: Record<string, unknown>, ctx: AppContext = ownerCtx(w), x: TestDb = db): Promise<{ fields: string[]; rows: Row[] }> {
  const t = (await x.admin<{ sql: string }>("SELECT sql FROM evidence.snapshot_template WHERE id = $1 AND version = $2", [id, v])).rows[0];
  if (!t) throw new Error(`no ${id} v${v}`);
  const { sql, names } = bind(t.sql);
  for (const n of names) if (!(n in p)) throw new Error(`${id} v${v}: param ${n} not supplied`);
  return x.withContext("munim_core", ctx, async (c) => {
    const fields = (await c.query({ text: `SELECT * FROM (${sql}) t LIMIT 0`, values: names.map((n) => p[n]) })).fields.map((f) => f.name);
    const r = await c.query<{ r: Row }>(`SELECT (SELECT jsonb_object_agg(e.key, e.value #>> '{}') FROM jsonb_each(to_jsonb(t)) e) AS r FROM (${sql}) t LIMIT 500`,
      names.map((n) => p[n]));
    return { fields, rows: r.rows.map((y) => Object.fromEntries(fields.map((f) => [f, y.r[f] ?? null]))) };
  });
}
const pick = (rows: Row[], cols: string[]) => rows.map((r) => cols.map((c) => r[c]));

/** Params per template (outlet fills outlet_id where the template has it). */
function params(id: string, outlet: string | null): Record<string, unknown> {
  switch (id) {
    case "finance.settlement_vs_orders": return { channel_id: null, from: "2026-09-01", to: "2026-09-30", outlet_id: outlet };
    case "finance.missing_payouts": return { channel_id: null, as_of: "2026-09-30", outlet_id: outlet };
    case "finance.tender_vs_bank": return { outlet_id: outlet, method: "upi", from: "2026-07-13", to: "2026-09-30" };
    case "finance.gst_check": return { period_month: "2026-09-01", outlet_id: outlet };
    case "customers.coupon_current": return { coupon_id: e.coupon };
    case "compliance.licence_calendar": return { as_of: "2026-10-10", required_kinds: ["fssai", "trade_licence", "fire_noc"] };
    case "compliance.log_coverage": return { outlet_id: outlet, from: "2026-10-01", to: "2026-10-10" };
    case "people.overtime_drift": return { outlet_id: outlet, from: "2026-09-28", to: "2026-10-18" };
    case "kitchen.ticket_times": return { outlet_id: outlet, from: "2026-07-01", to: fy.today };
    default: throw new Error(`no params for ${id}`);
  }
}
const v1Params = (id: string, outlet: string | null) => {
  const p = params(id, outlet);
  if (id === "finance.gst_check") delete p.outlet_id;
  return p;
};

/** Hand-valued rows at outlets A and B (book rows under their bound commands, history inside an approved import). */
async function addMc1eData(): Promise<Mc1e> {
  const T = w.tenant;
  const { A, B } = fx;
  const C = w.outlets[2];
  const cur = w.currency;
  const x: Mc1e = {
    managerA2: u(), managerC: u(), settlementE: u(), lineE5: u(), aggE: u(), aggF: u(), shift: u(), shift2: u(), coupon: u(),
    licences: { aTrade: u(), aFire: u(), bTrade: u() },
  };
  const run0 = (await db.admin<{ id: string }>(`SELECT id FROM core.import_run WHERE tenant_id = $1 AND status = 'committed' ORDER BY created_at LIMIT 1`, [T])).rows[0]!.id;
  await db.withContext("munim_core", ownerCtx(w), async (c) => {
    const cmd = (type: string) => c.query("SELECT set_config('app.command_type', $1, true)", [type]);
    // Managers: A2 covers A and B (an area manager: A's own manager, fx.managerA, lists fewer outlets and wins at A); C's
    // manager's membership is inactive (none at C).
    await cmd("tenancy.member.invite.v1");
    await c.query(`INSERT INTO core.member (tenant_id, id, name, email) VALUES ($1, $2, 'Manager A2', 'manager-a2@example.test'), ($1, $3, 'Manager C', 'manager-c@example.test')`,
      [T, x.managerA2, x.managerC]);
    await c.query(`INSERT INTO core.membership (tenant_id, member_id, role, outlet_ids, active) VALUES ($1, $2, 'manager', $3, true), ($1, $4, 'manager', $5, false)`,
      [T, x.managerA2, [A, B], x.managerC, [C]]);
    // Licences (as of 2026-10-10): A trade licence ran out 2026-06-30 (expired, −102 days); A fire NOC only superseded
    // (missing); B trade licence marked lapsed while its date is ahead (expired, 0 days left).
    await cmd("compliance.licence.upsert.v1");
    await c.query(`INSERT INTO core.licence (tenant_id, id, outlet_id, kind, number, valid_from, valid_to, status) VALUES
                     ($1, $2, $3, 'trade_licence', 'TL-A', '2025-01-01', '2026-06-30', 'active'),
                     ($1, $4, $3, 'fire_noc', 'FN-A', '2024-01-01', '2025-01-01', 'superseded'),
                     ($1, $5, $6, 'trade_licence', 'TL-B', '2026-01-01', '2026-12-31', 'lapsed')`,
      [T, x.licences.aTrade, A, x.licences.aFire, x.licences.bTrade, B]);
    // A coupon scoped to A and B, amount 5,000 off, one per customer.
    await cmd("catalogue.coupon.set.v1");
    await c.query(`INSERT INTO core.coupon (tenant_id, id, code, kind, value_minor, currency, min_spend_minor, per_customer_cap, requires_customer, outlet_ids, valid_from, valid_to)
                   VALUES ($1, $2, 'FIXE-50', 'amount', 5000, $3, 20000, 1, true, $4, '2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z')`, [T, x.coupon, cur, [A, B]]);
    // Overtime: the world's cook (hourly 15,000, OT 15,000 bp) also worked W40 at A: rostered 8 h, attended 8.5 h (+30 min).
    const roster = u();
    const shift = u();
    await cmd("people.roster.create.v1");
    await c.query(`INSERT INTO core.roster (tenant_id, id, outlet_id, week_start) VALUES ($1, $2, $3, '2026-09-28')`, [T, roster, A]);
    await c.query(`INSERT INTO core.roster_shift (tenant_id, id, roster_id, outlet_id, staff_id, starts_at, ends_at, role_key)
                   VALUES ($1, $2, $3, $4, $5, '2026-09-29T09:00:00Z', '2026-09-29T17:00:00Z', 'cook')`, [T, shift, roster, A, w.person]);
    await cmd("people.attendance.record.v1");
    await c.query(`INSERT INTO core.attendance (tenant_id, id, outlet_id, staff_id, roster_shift_id, clock_in_at, clock_out_at, source, recorded_by)
                   VALUES ($1, $2, $3, $4, $5, '2026-09-29T09:00:00Z', '2026-09-29T17:30:00Z', 'manual', $6)`, [T, u(), A, w.person, shift, w.owner]);
  });

  await approveDraft(db, w, "imports.run.commit.v1", async (q) => {
    // Settlement PAY-E at A (20–26 Sep, Swiggy, contract 22%), four unmatched order lines (expected = gross − 22% of gross):
    //   L1 gross 50,000, commission 14,000 → net 36,000, expected 39,000, short 3,000 ≥ max(100, ⌈39,000 × 50 ÷ 10,000⌉ = 195): counts
    //   L2 gross 40,000, commission 8,700 → net 31,300, expected 31,200, short −100 (overpaid): does not count
    //   L3 gross 20,000, commission 4,450 → net 15,550, expected 15,600, short 50 < 100 (under ₹1): does not count
    //   L4 gross 100,000, commission 22,300 → net 77,700, expected 78,000, short 300 < ⌈78,000 × 50 ÷ 10,000⌉ = 390: does not count
    //   L5 matched to AGG-E (A, 21 Sep: total 31,500 with 1,500 tax Swiggy collects), the statement's gross 30,000 (under the
    //   order's total), commission 6,600 (22% of the gross) → net 23,400; expected from the ORDER's total 31,500 − 6,600 −
    //   1,500 = 23,400 → short 0 (from the gross it would read 21,900, short −1,500): does not count.
    const lines: Array<[number, number, string | null]> = [[50000, 14000, null], [40000, 8700, null], [20000, 4450, null], [100000, 22300, null],
      [30000, 6600, x.aggE]];
    await q(`INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, kind, status, business_date, subtotal_minor, tax_minor, total_minor, currency,
                                        pricing_snapshot, external_ref, created_at)
             VALUES ($1, $2, $3, $4, 'takeaway', 'completed', '2026-09-21', 30000, 1500, 31500, $5, '{"synthetic": true}', 'AGG-E', '2026-09-21T07:30:00Z'),
                    ($1, $6, $7, $4, 'takeaway', 'completed', '2026-09-15', 19000, 1000, 20000, $5, '{"synthetic": true}', 'AGG-F', '2026-09-15T07:30:00Z')`,
      [T, x.aggE, A, fx.agg, cur, x.aggF, B]);
    await q(`INSERT INTO core.settlement (tenant_id, id, channel_id, outlet_id, period_from, period_to, paid_on, external_ref, net_minor, currency, import_run_id)
             VALUES ($1, $2, $3, $4, '2026-09-20', '2026-09-26', '2026-09-28', 'PAY-E', $5, $6, $7)`,
      [T, x.settlementE, fx.agg, A, lines.reduce((a, [g, k]) => a + g - k, 0), cur, run0]);
    for (const [i, [g, k, order]] of lines.entries()) {
      await q(`INSERT INTO core.settlement_line (tenant_id, id, settlement_id, line_no, line_kind, matched_order_id, gross_minor, commission_minor, net_minor, currency, external_order_ref)
               VALUES ($1, $2, $3, $4, 'order', $5, $6, $7, $8, $9, $10)`, [T, i === 4 ? x.lineE5 : u(), x.settlementE, i + 1, order, g, k, g - k, cur, order ? "AGG-E" : `E-${i + 1}`]);
    }
    // AGG-F (B, 15 Sep: total 20,000, tax 1,000) is in no payout: a missing payout 15 days old on 30 Sep, younger than the
    // August ones (51 days) — the channel's Σ row carries the oldest age.
    // The tender week at A (13–20 Jul, UPI): 100,000 tendered a day on one shift opened by manager A; credits 40,000 on
    // 13–15 (gap 60,000 ≥ the IN pack's 50,000), 100,000 on 16–19, none on 20 (after the statement's last credit: no gap
    // day). Voids 3 a day on 13–15, 1 a day on 16–19, 0 on 20 → the median day 1 (of 3,3,3,1,1,1,1,0).
    await q(`INSERT INTO core.shift (tenant_id, id, outlet_id, status, opened_by, opened_at, float_minor, currency, closed_by, closed_at,
                                     counted_cash_minor, expected_cash_minor, variance_minor)
             VALUES ($1, $2, $3, 'closed', $4, '2026-07-13T02:00:00Z', 0, $5, $4, '2026-07-20T18:00:00Z', 0, 0, 0)`, [T, x.shift, A, fx.managerA, cur]);
    for (let d = 13; d <= 20; d++) {
      const day = `2026-07-${d}`;
      const order = u();
      await q(`INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, kind, status, business_date, subtotal_minor, tax_minor, total_minor, currency,
                                          pricing_snapshot, created_at)
               VALUES ($1, $2, $3, $4, 'takeaway', 'completed', $5, 100000, 0, 100000, $6, '{"synthetic": true}', $7)`,
        [T, order, A, w.channel, day, cur, `${day}T07:30:00Z`]);
      await q(`INSERT INTO core.tender (tenant_id, id, outlet_id, order_id, method, amount_minor, currency, recorded_by, at, shift_id)
               VALUES ($1, $2, $3, $4, 'upi', 100000, $5, $6, $7, $8)`, [T, u(), A, order, cur, fx.managerA, `${day}T07:30:00Z`, x.shift]);
      for (let n = 0; n < (d <= 15 ? 3 : d <= 19 ? 1 : 0); n++) {
        await q(`INSERT INTO core.void (tenant_id, id, outlet_id, order_id, reason_code, note, amount_minor, currency, actor, at)
                 VALUES ($1, $2, $3, $4, 'customer_cancelled', 'fixture', 1000, $5, $6, $7)`, [T, u(), A, order, cur, fx.managerA, `${day}T08:00:00Z`]);
      }
      if (d <= 19) {
        await q(`INSERT INTO core.bank_line (tenant_id, id, outlet_id, account_ref, value_date, amount_minor, currency, method, external_ref, import_run_id)
                 VALUES ($1, $2, $3, 'BANK-FX', $4, $5, $6, 'upi', $7, $8)`, [T, u(), A, day, d <= 15 ? 40000 : 100000, cur, `UTR-E-${d}`, run0]);
      }
    }
    // A second week at A (27–29 Jul): 100,000 tendered and 40,000 credited a day (three gap days), no voids; 27–28 on manager
    // A's shift (x.shift2), 29 on manager A2's (SHIFT3) → the gap days do not share one member: the week's Σ row has none.
    await q(`INSERT INTO core.shift (tenant_id, id, outlet_id, status, opened_by, opened_at, float_minor, currency, closed_by, closed_at,
                                     counted_cash_minor, expected_cash_minor, variance_minor)
             VALUES ($1, $2, $3, 'closed', $4, '2026-07-27T02:00:00Z', 0, $5, $4, '2026-07-28T18:00:00Z', 0, 0, 0),
                    ($1, $6, $3, 'closed', $7, '2026-07-29T02:00:00Z', 0, $5, $7, '2026-07-29T18:00:00Z', 0, 0, 0)`,
      [T, x.shift2, A, fx.managerA, cur, SHIFT3, x.managerA2]);
    for (const d of [27, 28, 29]) {
      const day = `2026-07-${d}`;
      const order = u();
      await q(`INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, kind, status, business_date, subtotal_minor, tax_minor, total_minor, currency,
                                          pricing_snapshot, created_at)
               VALUES ($1, $2, $3, $4, 'takeaway', 'completed', $5, 100000, 0, 100000, $6, '{"synthetic": true}', $7)`,
        [T, order, A, w.channel, day, cur, `${day}T07:30:00Z`]);
      await q(`INSERT INTO core.tender (tenant_id, id, outlet_id, order_id, method, amount_minor, currency, recorded_by, at, shift_id)
               VALUES ($1, $2, $3, $4, 'upi', 100000, $5, $6, $7, $8)`, [T, u(), A, order, cur, fx.managerA, `${day}T07:30:00Z`, d < 29 ? x.shift2 : SHIFT3]);
      await q(`INSERT INTO core.bank_line (tenant_id, id, outlet_id, account_ref, value_date, amount_minor, currency, method, external_ref, import_run_id)
               VALUES ($1, $2, $3, 'BANK-FX', $4, 40000, $5, 'upi', $6, $7)`, [T, u(), A, day, cur, `UTR-E-${d}`, run0]);
    }
    // Kitchen: five orders of the fixture dish at A on 22 Jul (no tenders).
    for (let n = 0; n < 5; n++) {
      await q(`INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, kind, status, business_date, subtotal_minor, tax_minor, total_minor, currency,
                                          pricing_snapshot, created_at)
               VALUES ($1, $2, $3, $4, 'takeaway', 'completed', '2026-07-22', 30000, 0, 30000, $5, '{"synthetic": true}', '2026-07-22T07:30:00Z')`,
        [T, (TICKET_ORDERS[n] = u()), A, w.channel, cur]);
      await q(`INSERT INTO core.order_line (tenant_id, id, outlet_id, order_id, line_no, item_id, qty_milli, unit_price_minor, line_discount_minor, tax_minor, created_at)
               VALUES ($1, $2, $3, $4, 1, $5, 1000, 30000, 0, 0, '2026-07-22T07:30:00Z')`, [T, u(), A, TICKET_ORDERS[n], fx.dish]);
    }
  });
  // Tickets (operational): 07:31Z = 13:01 IST (slot 13:00) taking 600, 900, 1,200 s; 08:05Z = 13:35 IST (slot 13:30) taking
  // 300, 1,500 s; due 12 min (720 s) after acceptance → late: 900, 1,200, 1,500.
  await db.withContext("munim_core", ownerCtx(w), async (c) => {
    for (const [n, [at, sec]] of ([["2026-07-22T07:31:00Z", 600], ["2026-07-22T07:31:00Z", 900], ["2026-07-22T07:31:00Z", 1200],
      ["2026-07-22T08:05:00Z", 300], ["2026-07-22T08:05:00Z", 1500]] as const).entries()) {
      await c.query(`INSERT INTO core.kitchen_ticket (tenant_id, id, outlet_id, order_id, station, status, accepted_at, ready_at, due_at)
                     VALUES ($1, $2, $3, $4, 'tandoor', 'done', $5::timestamptz, $5::timestamptz + make_interval(secs => $6), $5::timestamptz + interval '12 minutes')`,
        [T, u(), A, TICKET_ORDERS[n], at, sec]);
    }
  });
  return x;
}
const TICKET_ORDERS: string[] = [];
const SHIFT3 = u();

beforeAll(async () => {
  db = await openDb();
  w = await buildWorld(db);
  fx = await addOutletData(db, w);
  fy = await addMc1bcData(db, w, fx);
  e = await addMc1eData();
}, 300_000);
afterAll(async () => db?.stop());

const managerA = (): AppContext => ({ tenant_id: w.tenant, outlet_ids: [fx.A], role: "manager", member_id: fx.managerA });

// ---------------------------------------------------------------------------------------------------------------
describe("C — columns, roles and params of the nine version 2s", () => {
  test("exactly the nine have a version 2 from 0023: each returns its declared columns = version 1's + the requested ones; v1's role; v1's params", async () => {
    const bad: string[] = [];
    for (const [id, want] of Object.entries(V2)) {
      const t = (await db.admin<{ v: number; decl: string[]; role: string; p1: object; p2: object }>(`
        SELECT t2.version v, ARRAY(SELECT c ->> 'name' FROM jsonb_array_elements(t2.columns) c) decl, t2.min_role role, t1.params_schema p1, t2.params_schema p2
          FROM evidence.snapshot_template t2 JOIN evidence.snapshot_template t1 ON t1.id = t2.id AND t1.version = 1
         WHERE t2.id = $1 AND t2.version = (SELECT max(version) FROM evidence.snapshot_template WHERE id = $1)`, [id])).rows[0]!;
      const v1 = (await run(id, 1, v1Params(id, fx.A))).fields;
      const v2 = (await run(id, 2, params(id, fx.A))).fields;
      // 0024 (R-A F5) added settlement_vs_orders v3 (same columns, params and role as v2); every other one is still at 2.
      if (t.v !== (id === "finance.settlement_vs_orders" ? 3 : 2)) bad.push(`${id}: latest version ${t.v}`);
      if (JSON.stringify(v2) !== JSON.stringify([...v1, ...want.extra])) bad.push(`${id}: returns ${v2.join(",")}`);
      if (JSON.stringify(t.decl) !== JSON.stringify(v2)) bad.push(`${id}: declares ${t.decl.join(",")}`);
      if (t.role !== want.role) bad.push(`${id}: min_role ${t.role}`);
      const p2 = t.p2 as { required: string[]; properties: Record<string, unknown> };
      const p1 = t.p1 as { required: string[]; properties: Record<string, unknown> };
      const wantReq = id === "finance.gst_check" ? [...p1.required, "outlet_id"] : p1.required;
      if (JSON.stringify(p2.required) !== JSON.stringify(wantReq)) bad.push(`${id}: required ${p2.required.join(",")}`);
      if (id === "finance.gst_check" && JSON.stringify(p2.properties.outlet_id) !== JSON.stringify({ type: ["string", "null"], format: "uuid" })) bad.push(`${id}: outlet_id param`);
    }
    console.log(`C: ${Object.keys(V2).length - new Set(bad.map((b) => b.split(":")[0])).size}/${Object.keys(V2).length} version 2s exact`);
    expect(bad).toEqual([]);
  });

  test("Σ rows come first: every row before the first detail row is a Σ row, and each template has both", async () => {
    const bad: string[] = [];
    for (const [id, col] of Object.entries(SIGMA)) {
      const rows = (await run(id, 2, params(id, null))).rows;
      const first = rows.findIndex((r) => r[col] !== null);
      if (first <= 0 || rows.slice(first).some((r) => r[col] === null)) bad.push(`${id}: Σ rows at ${rows.map((r) => (r[col] === null ? "Σ" : "d")).join("")}`);
    }
    expect(bad).toEqual([]);
  });

  test("the pack thresholds the finance versions read are present in both seeded active packs", async () => {
    const r = await db.admin<{ code: string; a: string | null; b: string | null; c: string | null }>(`
      SELECT cp.code, cp.doc #>> '{detectors,finance.short_payout,thresholds,line_short_minor_gte}' a,
             cp.doc #>> '{detectors,finance.short_payout,thresholds,line_short_bp_gte}' b,
             cp.doc #>> '{detectors,finance.tender_gap,thresholds,gap_minor_gte}' c
        FROM platform.country_pack cp WHERE cp.status = 'active'
         AND cp.version = (SELECT max(v.version) FROM platform.country_pack v WHERE v.code = cp.code AND v.status = 'active') ORDER BY 1`);
    console.log("pack thresholds:", JSON.stringify(r.rows));
    expect(r.rows.map((x) => x.code)).toEqual(["AU", "IN"]);
    for (const x of r.rows) expect([x.a, x.b, x.c].every((v) => v !== null && /^[0-9]+$/.test(v))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("S — outlet scope", () => {
  test("an outlet-A manager sees the owner's outlet-A rows and 0 rows of outlet B, for every outlet-scoped version 2", async () => {
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const bad: string[] = [];
    const ids = Object.keys(V2).filter((id) => !["customers.coupon_current", "compliance.licence_calendar"].includes(id));
    for (const id of ids) {
      const [oa, ob, on] = [await run(id, 2, params(id, fx.A)), await run(id, 2, params(id, fx.B)), await run(id, 2, params(id, NO_OUTLET))];
      if (oa.rows.length < 1 || same(oa.rows, on.rows) || same(ob.rows, on.rows)) {
        bad.push(`${id}: fixture not discriminating (A ${oa.rows.length}, B ${ob.rows.length}, none ${on.rows.length})`);
        continue;
      }
      if (!same((await run(id, 2, params(id, fx.A), managerA())).rows, oa.rows)) bad.push(`${id}: manager's own outlet ≠ owner's view`);
      if (!same((await run(id, 2, params(id, fx.B), managerA())).rows, on.rows)) bad.push(`${id}: manager sees outlet B`);
    }
    // licence_calendar lists outlets itself: the manager gets the owner's outlet-A rows, nothing else.
    const lo = (await run("compliance.licence_calendar", 2, params("compliance.licence_calendar", null))).rows;
    const lm = (await run("compliance.licence_calendar", 2, params("compliance.licence_calendar", null), managerA())).rows;
    if (!same(lm, lo.filter((r) => r.outlet_id === fx.A)) || lm.length !== 3 || !lo.some((r) => r.outlet_id === fx.B)) bad.push("compliance.licence_calendar: manager scope");
    console.log(`S: ${ids.length + 1 - bad.length}/${ids.length + 1} version 2s scoped`);
    expect(bad).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("V — version 1 kept inside version 2", () => {
  test("the detail rows of each version 2, on version 1's columns, are version 1's rows (owner, whole scope and outlet A)", async () => {
    const bad: string[] = [];
    for (const id of Object.keys(V2)) {
      if (id === "compliance.licence_calendar") continue; // `missing` changes meaning: hand values below
      for (const o of [null, fx.A]) {
        const one = await run(id, 1, v1Params(id, o));
        let two = (await run(id, 2, params(id, o))).rows.filter((r) => !SIGMA[id] || r[SIGMA[id]!] !== null);
        if (id === "finance.settlement_vs_orders") {
          // The one line whose statement gross (30,000) is not its order's total (31,500): v2 expects 1,500 more (header F1).
          const [l1, l2] = [one.rows.find((r) => r.settlement_line_id === e.lineE5), two.find((r) => r.settlement_line_id === e.lineE5)];
          if (Number(l2?.expected_net_minor) - Number(l1?.expected_net_minor) !== 1500 || Number(l2?.short_minor) - Number(l1?.short_minor) !== 1500) bad.push(`${id} L5 @ ${o ?? "all"}`);
          one.rows = one.rows.filter((r) => r.settlement_line_id !== e.lineE5);
          two = two.filter((r) => r.settlement_line_id !== e.lineE5);
        }
        // v1's own Σ rows (settlement_vs_orders, missing_payouts: the last row, ids NULL) are not detail rows.
        // gst_check v1 has no outlet param: its outlet-A view is its outlet-A row.
        const v1Detail = ["finance.settlement_vs_orders", "finance.missing_payouts"].includes(id) ? one.rows.slice(0, -1)
          : id === "finance.gst_check" && o ? one.rows.filter((r) => r.outlet_id === o) : one.rows;
        if (JSON.stringify(pick(two, one.fields)) !== JSON.stringify(pick(v1Detail, one.fields))) bad.push(`${id} @ ${o ?? "all"}`);
      }
    }
    // licence_calendar: in-force and never-held rows as v1; v1 called the expired ones missing.
    const l1 = (await run("compliance.licence_calendar", 1, params("compliance.licence_calendar", null))).rows;
    const l2 = (await run("compliance.licence_calendar", 2, params("compliance.licence_calendar", null))).rows;
    for (const [i, r] of l2.entries()) {
      const v = l1[i]!;
      const ok = r.status === "expired" ? v.missing === "true" && v.licence_id === null
        : JSON.stringify(pick([r], ["outlet_id", "kind", "licence_id", "valid_to", "days_left", "missing"])) === JSON.stringify(pick([v], ["outlet_id", "kind", "licence_id", "valid_to", "days_left", "missing"]));
      if (!ok || l1.length !== l2.length) bad.push(`compliance.licence_calendar row ${i}`);
    }
    expect(bad).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("H — hand values", () => {
  test("settlement_vs_orders: the Σ row of a settlement sums only the lines that count (overpaid, sub-₹1 and sub-0.5% lines do not)", async () => {
    const rows = (await run("finance.settlement_vs_orders", 2, params("finance.settlement_vs_orders", fx.A))).rows;
    const pay1 = (await db.admin<{ id: string }>(`SELECT id FROM core.settlement WHERE tenant_id = $1 AND external_ref = 'PAY-1'`, [w.tenant])).rows[0]!.id;
    const cols = ["settlement_id", "channel_id", "settlement_line_id", "matched_order_id", "order_total_minor", "commission_minor", "net_minor",
      "expected_commission_minor", "refund_minor", "expected_net_minor", "short_minor"];
    const sigma = pick(rows.filter((r) => r.settlement_line_id === null), cols);
    console.log("settlement Σ rows:", JSON.stringify(sigma));
    // PAY-1 (8–14 Sep, mc1a-fixture): one matched order, total 31,500 (tax 1,500, Swiggy collects it), commission 8,820 (28%)
    // → expected 31,500 − 6,930 − 1,500 = 23,070, net 22,680, short 390 ≥ max(100, 116): counts. PAY-E: L1 only.
    expect(sigma).toEqual([
      [pay1, fx.agg, null, null, "31500", "8820", "22680", "6930", "0", "23070", "390"],
      [e.settlementE, fx.agg, null, null, "0", "14000", "36000", "11000", "0", "39000", "3000"],
    ]);
    const lines = rows.filter((r) => r.settlement_id === e.settlementE && r.settlement_line_id !== null).map((r) => Number(r.short_minor)).sort((a, b) => a - b);
    expect(lines).toEqual([-100, 0, 50, 300, 3000]);
    // L5: expected net from the matched order's total (31,500), not the statement's gross (30,000).
    expect(pick(rows.filter((r) => r.settlement_line_id === e.lineE5), ["matched_order_id", "order_total_minor", "expected_commission_minor", "expected_net_minor", "short_minor"]))
      .toEqual([[e.aggE, "31500", "6600", "23400", "0"]]);
  });

  test("tender_vs_bank: the week of 13 Jul at A — three gap days the statement reaches, median day × 3, one shift member", async () => {
    const p = { outlet_id: fx.A, method: "upi", from: "2026-07-13", to: "2026-07-20" };
    const rows = (await run("finance.tender_vs_bank", 2, p)).rows;
    const cols = ["business_on", "week_start", "tendered_minor", "credited_minor", "gap_minor", "voids", "void_minor", "outlet_median_voids", "shift_member_id", "gap_days"];
    console.log("tender week:", JSON.stringify(pick(rows, cols)));
    expect(pick(rows.filter((r) => r.business_on === null), cols)).toEqual([[null, "2026-07-13", "300000", "120000", "180000", "9", "9000", "3", fx.managerA, "3"]]);
    // The 20th: tendered, never credited, after the statement's last credit (the 19th) — a day row, never a gap day.
    expect(pick(rows.filter((r) => r.business_on === "2026-07-20"), ["gap_minor", "outlet_median_voids", "week_start", "gap_days"])).toEqual([["100000", "1", null, null]]);
    // The week of 27 Jul: three gap days of 60,000, no voids (median 0), but two members' shifts (27–28 A, 29 A2) → no member.
    const r2 = (await run("finance.tender_vs_bank", 2, { ...p, from: "2026-07-27", to: "2026-07-29" })).rows;
    expect(pick(r2, cols)).toEqual([
      [null, "2026-07-27", "300000", "120000", "180000", "0", "0", "0", null, "3"],
      ["2026-07-27", null, "100000", "40000", "60000", "0", "0", "0", fx.managerA, null],
      ["2026-07-28", null, "100000", "40000", "60000", "0", "0", "0", fx.managerA, null],
      ["2026-07-29", null, "100000", "40000", "60000", "0", "0", "0", e.managerA2, null],
    ]);
  });

  test("missing_payouts: one Σ row per channel — the August aggregator orders at A and B and AGG-F at B, the oldest 51 days", async () => {
    const rows = (await run("finance.missing_payouts", 2, params("finance.missing_payouts", null))).rows;
    // AGG-1-0 and AGG-2-0 (10 Aug, 51 days): total 31,500 each, expected 31,500 − 6,930 − 1,500 (operator's tax) = 23,070 each;
    // AGG-F (15 Sep, 15 days): 20,000 − 4,400 − 1,000 = 14,600. Σ 83,000 / 60,740; the oldest 51.
    expect(pick(rows.filter((r) => r.order_id === null), ["channel_id", "order_total_minor", "expected_net_minor", "days_unsettled"]))
      .toEqual([[fx.agg, "83000", "60740", "51"]]);
    expect(rows.filter((r) => r.order_id !== null).map((r) => r.days_unsettled)).toEqual(["51", "51", "15"]);
  });

  test("gst_check: outlet_id narrows to that outlet's row; NULL is version 1", async () => {
    const a = (await run("finance.gst_check", 2, params("finance.gst_check", fx.A))).rows;
    // A, September: own-liability order tax 1,350 + 1,500 (+ 0 on the SKU and the churn order) = 2,850, all posted.
    expect(pick(a, ["outlet_id", "order_tax_minor", "posted_tax_minor", "diff_minor"])).toEqual([[fx.A, "2850", "2850", "0"]]);
    expect((await run("finance.gst_check", 2, params("finance.gst_check", null))).rows).toEqual((await run("finance.gst_check", 1, v1Params("finance.gst_check", null))).rows);
  });

  test("coupon_current: terms, identity, scope (a JSON array of outlet ids) and validity", async () => {
    const r = (await run("customers.coupon_current", 2, params("customers.coupon_current", null))).rows;
    const vf = (await db.admin<{ f: string; t: string }>(`SELECT to_jsonb(valid_from) #>> '{}' f, to_jsonb(valid_to) #>> '{}' t FROM core.coupon WHERE id = $1`, [e.coupon])).rows[0]!;
    expect(r).toEqual([{ value_minor: "5000", value_bp: null, per_customer_cap: "1", global_cap: null, min_spend_minor: "20000", code: "FIXE-50", kind: "amount",
      valid_from: vf.f, valid_to: vf.t, outlet_ids: `["${fx.A}", "${fx.B}"]`, active: "true", requires_customer: "true" }]);
    expect(Date.parse(vf.f)).toBe(Date.parse("2026-10-01T00:00:00Z"));
    const world = (await run("customers.coupon_current", 2, { coupon_id: (await db.admin<{ id: string }>(`SELECT id FROM core.coupon WHERE code = 'WELCOME10'`)).rows[0]!.id })).rows[0]!;
    expect([world.code, world.kind, world.value_bp, world.outlet_ids, world.requires_customer]).toEqual(["WELCOME10", "percent", "1000", "[]", "false"]);
  });

  test("licence_calendar: in force, expired (ran out / lapsed), missing (never / only superseded); the outlet's manager by the rule", async () => {
    const rows = (await run("compliance.licence_calendar", 2, params("compliance.licence_calendar", null))).rows;
    const fssai = async (n: string) => (await db.admin<{ id: string }>(`SELECT id FROM core.licence WHERE tenant_id = $1 AND number = $2`, [w.tenant, n])).rows[0]!.id;
    const [f1, f2] = [await fssai("LIC-1"), await fssai("LIC-2")];
    const C = w.outlets[2];
    const want = [
      // fssai in force at A and B to 31 Dec (82 days); none at C. Kinds sort fire_noc, fssai, trade_licence.
      [fx.A, "fire_noc", null, null, null, "true", "missing", fx.managerA],
      [fx.A, "fssai", f1, "2026-12-31", "82", "false", "in_force", fx.managerA],
      [fx.A, "trade_licence", e.licences.aTrade, "2026-06-30", "-102", "false", "expired", fx.managerA],
      [fx.B, "fire_noc", null, null, null, "true", "missing", e.managerA2],
      [fx.B, "fssai", f2, "2026-12-31", "82", "false", "in_force", e.managerA2],
      [fx.B, "trade_licence", e.licences.bTrade, "2026-12-31", "0", "false", "expired", e.managerA2],
      [C, "fire_noc", null, null, null, "true", "missing", null],
      [C, "fssai", null, null, null, "true", "missing", null],
      [C, "trade_licence", null, null, null, "true", "missing", null],
    ].sort((a, b) => `${a[0]}${a[1]}`.localeCompare(`${b[0]}${b[1]}`));
    const got = pick(rows, ["outlet_id", "kind", "licence_id", "valid_to", "days_left", "missing", "status", "manager_member_id"]);
    console.log("licence_calendar v2:", JSON.stringify(got.map((r) => r.slice(1))));
    expect(got).toEqual(want);
  });

  test("log_coverage: each row names the manager of its outlet (:outlet_id, else the checklist's own); none for tenant-wide rows", async () => {
    const lists = (await db.admin<{ id: string; outlet_id: string | null }>(`SELECT id, outlet_id FROM core.checklist WHERE tenant_id = $1 AND active ORDER BY id`, [w.tenant])).rows;
    const mgr = (o: string | null) => (o === fx.A ? fx.managerA : o === fx.B ? e.managerA2 : null);
    const all = (await run("compliance.log_coverage", 2, params("compliance.log_coverage", null))).rows;
    expect(pick(all, ["checklist_id", "manager_member_id"])).toEqual([...lists.map((l) => [l.id, mgr(l.outlet_id)]), [null, null]]);
    expect(lists.filter((l) => l.outlet_id === null).length).toBeGreaterThan(0);
    expect(lists.filter((l) => l.outlet_id !== null).length).toBe(2);
    const a = (await run("compliance.log_coverage", 2, params("compliance.log_coverage", fx.A))).rows;
    expect(a.map((r) => r.manager_member_id)).toEqual(a.map(() => fx.managerA));
    expect(a.length).toBeGreaterThan(1);
  });

  test("overtime_drift: one Σ row per staff member over the window, before the week rows", async () => {
    const rows = (await run("people.overtime_drift", 2, params("people.overtime_drift", null))).rows;
    const cols = ["staff_id", "iso_week", "rostered_min", "attended_min", "extra_min", "extra_cost_minor"];
    console.log("overtime v2:", JSON.stringify(pick(rows, cols)));
    // The cook (15,000 an hour, ×1.5): W40 +30 min = 11,250; W41 +60 at A and +60 at B = 45,000 → Σ 150 min, 56,250.
    // Cook B (14,000, ×1.5): W42 +60 = 21,000.
    const sig = pick(rows.filter((r) => r.iso_week === null), cols);
    const want = [[w.person, null, "1440", "1590", "150", "56250"], [fy.staffB, null, "480", "540", "60", "21000"]]
      .sort((a, b) => a[0]!.localeCompare(b[0]!));
    expect(sig).toEqual(want);
  });

  test("ticket_times: per station and item over every slot (slot_start NULL), first; then per slot", async () => {
    const rows = (await run("kitchen.ticket_times", 2, { outlet_id: fx.A, from: "2026-07-22", to: "2026-07-22" })).rows;
    const cols = ["station", "item_id", "slot_start", "tickets", "p50_sec", "p80_sec", "late_tickets", "configured_prep_sec"];
    // 600, 900, 1,200 (13:00) and 300, 1,500 (13:30): p50 / p80 by percentile_disc; late = ready after due (720 s).
    expect(pick(rows, cols)).toEqual([
      ["tandoor", fx.dish, null, "5", "900", "1200", "3", null],
      ["tandoor", fx.dish, "13:00", "3", "900", "1200", "2", null],
      ["tandoor", fx.dish, "13:30", "2", "300", "1500", "1", null],
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("D1 — findings.dismiss.v1", () => {
  test("its row writes no book table: under it a finding's status is set, and a book row → MB008 / MB001", async () => {
    const ctx = ownerCtx(w, { command_type: "findings.dismiss.v1" });
    const ok = await attempt(db, "munim_core", ctx, `UPDATE intel.finding SET status = 'dismissed' WHERE tenant_id = $1 AND id = $2`, [w.tenant, w.finding]);
    const book = await attempt(db, "munim_core", ctx, `INSERT INTO core.licence (tenant_id, id, outlet_id, kind, number, valid_from) VALUES ($1, $2, $3, 'gst', 'GST-D1', '2026-01-01')`,
      [w.tenant, u(), fx.A]);
    const row = (await db.admin(`SELECT allowed_roles, scope, target_tables FROM core.command_authority WHERE command_type = 'findings.dismiss.v1'`)).rows;
    console.log("D1:", JSON.stringify(row), "status update →", ok?.code ?? "ok", "| book insert →", book?.code);
    expect(row).toEqual([{ allowed_roles: ["owner", "manager", "judge"], scope: "outlet", target_tables: [] }]);
    expect(ok).toBeNull();
    expect((await db.admin<{ s: string }>(`SELECT status s FROM intel.finding WHERE id = $1`, [w.finding])).rows[0]!.s).toBe("dismissed");
    expect(["MB008", "MB001"]).toContain(book?.code);
  });
});
