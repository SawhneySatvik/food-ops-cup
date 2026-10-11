// M-C1bc fixture (0021): on top of the canonical world and the M-C1a fixture, the outlet data the remaining packs'
// templates read that neither has in BOTH outlets A (1) and B (2) — so every outlet-scoped template has rows in A and in
// B and outlet C (3) has none (manager-scope gate). Written like buildWorld: each book row under the command bound to its
// table, history rows inside an approved imports.run.commit.v1 draft, intel rows as munim_svc. Synthetic data only.
//   kitchen tickets (timed) on the M-C1a fixture's recent orders; two forecast runs (an older one for accuracy, the
//   latest for the days ahead); per outlet: a negotiation run with quotes, a segment snapshot, an advance, an attendance
//   for the outlet's own staff, completed orders of the world's customer (churn), anonymous coupon uses, a batch expiring
//   in 3 days, market signals (past, ahead, competitor price).
import type pg from "pg";
import type { TestDb } from "../src/harness.ts";
import type { McFixture } from "./mc1a-fixture.ts";
import { approveDraft, ownerCtx, uuidv7, type World } from "./world.ts";

export interface McbcFixture {
  /** Outlet A's business date today (Asia/Kolkata / the pack zone, cutoff applied) and the Monday of the recent orders' week. */
  today: string;
  recent: string;
  recentWeek: string;
  /** Per outlet [A, B]: */
  runs: [string, string];
  quotes: [string, string];
  snapshots: [string, string];
  counts: [string, string];
  goals: [string, string];
  /** The week (Monday) of the churn orders' anonymous coupon uses. */
  couponWeek: string;
  coupon: string;
  staffB: string;
}

const u = uuidv7;
type Q = (sql: string, params?: unknown[]) => Promise<pg.QueryResult>;

export async function addMc1bcData(db: TestDb, w: World, f: McFixture): Promise<McbcFixture> {
  const T = w.tenant;
  const { A, B } = f;
  const cur = w.currency;
  const one = async <R extends pg.QueryResultRow>(sql: string, params: unknown[] = []) => (await db.admin<R>(sql, params)).rows[0]!;
  const today = (await one<{ d: string }>(`SELECT to_char(((now() AT TIME ZONE tz) - business_day_cutoff)::date, 'YYYY-MM-DD') d FROM core.outlet WHERE id = $1`, [A])).d;
  const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const monday = (d: string) => addDays(d, -((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7));
  // The M-C1a fixture's order of three days ago at each outlet (fixture dish, counter channel).
  const recentOrders = (await db.admin<{ id: string; outlet_id: string; d: string }>(
    `SELECT o.id, o.outlet_id, to_char(o.business_date, 'YYYY-MM-DD') d FROM core."order" o JOIN core.order_line l ON l.order_id = o.id
      WHERE o.tenant_id = $1 AND l.item_id = $2 AND o.status = 'completed' AND o.business_date > now()::date - 10 ORDER BY o.outlet_id = $3 DESC`,
    [T, f.dish, A])).rows;
  const recent = recentOrders[0]!.d;
  const counts = (await db.admin<{ id: string; outlet_id: string }>(`SELECT id, outlet_id FROM core.stock_count WHERE tenant_id = $1`, [T])).rows;
  const goals = (await db.admin<{ id: string; outlet_id: string }>(`SELECT id, outlet_id FROM core.goal WHERE tenant_id = $1 AND outlet_id IS NOT NULL`, [T])).rows;
  const coupon = (await one<{ id: string }>(`SELECT id FROM core.coupon WHERE tenant_id = $1`, [T])).id;
  const staffB = (await one<{ id: string }>(`SELECT id FROM core.staff WHERE tenant_id = $1 AND outlet_id = $2`, [T, B])).id;
  const importRun = (await one<{ id: string }>(`SELECT id FROM core.import_run WHERE tenant_id = $1 ORDER BY created_at LIMIT 1`, [T])).id;
  const byOutlet = <R extends { outlet_id: string; id: string }>(rows: R[]): [string, string] =>
    [rows.find((r) => r.outlet_id === A)!.id, rows.find((r) => r.outlet_id === B)!.id];
  const x: McbcFixture = {
    today, recent, recentWeek: monday(recent), runs: [u(), u()], quotes: [u(), u()], snapshots: [u(), u()], counts: byOutlet(counts),
    goals: byOutlet(goals), couponWeek: "2026-09-21", coupon, staffB,
  };

  // 1. Kitchen tickets with both timestamps on the recent orders (operational rows; outlet A slower than B).
  await db.withContext("munim_core", ownerCtx(w), async (c) => {
    for (const o of recentOrders) {
      const sec = o.outlet_id === A ? 900 : 600;
      await c.query(`INSERT INTO core.kitchen_ticket (tenant_id, id, outlet_id, order_id, station, status, accepted_at, ready_at, due_at)
                     VALUES ($1, $2, $3, $4, 'tandoor', 'done', $5::timestamptz, $5::timestamptz + make_interval(secs => $6), $5::timestamptz + interval '12 minutes')`,
        [T, u(), o.outlet_id, o.id, `${o.d}T07:31:00Z`, sec]);
    }
  });

  // 2. Book rows per outlet: an expiring batch with stock, an advance (B's staff), attendance for B's staff, coupon uses.
  await db.withContext("munim_core", ownerCtx(w), async (c) => {
    const q: Q = (sql, params) => c.query(sql, params);
    const cmd = (type: string) => q("SELECT set_config('app.command_type', $1, true)", [type]);
    await cmd("inventory.stock.receive.v1");
    for (const [o, qty] of [[A, 40000], [B, 25000]] as const) {
      const batch = u();
      await q(`INSERT INTO core.batch (tenant_id, id, outlet_id, ingredient_id, batch_code, expires_on) VALUES ($1, $2, $3, $4, 'FX-EXP', $5)`,
        [T, batch, o, f.flour, addDays(today, 3)]);
      await q(`INSERT INTO core.stock_movement (tenant_id, id, outlet_id, ingredient_id, batch_id, qty_milli, unit, kind, unit_cost_per_1000_minor, currency)
               VALUES ($1, $2, $3, $4, $5, $6, 'kg', 'receipt', 4400000, $7)`, [T, u(), o, f.flour, batch, qty, cur]);
    }
    await cmd("people.advance.record.v1");
    await q(`INSERT INTO core.advance (tenant_id, id, staff_id, kind, amount_minor, currency, on_date, recorded_by) VALUES ($1, $2, $3, 'given', 500000, $4, '2026-09-15', $5)`,
      [T, u(), staffB, cur, w.owner]);
    const roster = u();
    const shift = u();
    await cmd("people.roster.create.v1");
    await q(`INSERT INTO core.roster (tenant_id, id, outlet_id, week_start) VALUES ($1, $2, $3, '2026-10-12')`, [T, roster, B]);
    await q(`INSERT INTO core.roster_shift (tenant_id, id, roster_id, outlet_id, staff_id, starts_at, ends_at, role_key)
             VALUES ($1, $2, $3, $4, $5, '2026-10-13T04:00:00Z', '2026-10-13T12:00:00Z', 'cook')`, [T, shift, roster, B, staffB]);
    await cmd("people.attendance.record.v1");
    await q(`INSERT INTO core.attendance (tenant_id, id, outlet_id, staff_id, roster_shift_id, clock_in_at, clock_out_at, source, recorded_by)
             VALUES ($1, $2, $3, $4, $5, '2026-10-13T04:00:00Z', '2026-10-13T13:00:00Z', 'manual', $6)`, [T, u(), B, staffB, shift, w.owner]);
  });

  // 3. Completed orders of the world's customer (two per outlet, a week apart; the second carries an anonymous coupon
  //    use), through an approved import as history rows.
  const churn: Array<[string, string]> = [];
  await approveDraft(db, w, "imports.run.commit.v1", async (q) => {
    for (const [k, o] of [[1, A], [2, B]] as const) {
      for (const d of ["2026-09-20", "2026-09-27"]) {
        const id = u();
        churn.push([id, d]);
        await q(`INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, kind, status, business_date, subtotal_minor, tax_minor, total_minor, currency,
                                            pricing_snapshot, customer_id, created_at)
                 VALUES ($1, $2, $3, $4, 'takeaway', 'completed', $5, $6, 0, $6, $7, '{"synthetic": true}', $8, $9)`,
          [T, id, o, w.channel, d, 20000 * k, cur, w.customer, `${d}T08:00:00Z`]);
      }
    }
  });
  await db.withContext("munim_core", ownerCtx(w, { command_type: "orders.place.v1" }), async (c) => {
    for (const [id, d] of churn) {
      if (d !== "2026-09-27") continue;
      await c.query(`INSERT INTO core.coupon_use (tenant_id, id, coupon_id, order_id, customer_id, discount_minor, currency, applied_by)
                     VALUES ($1, $2, $3, $4, NULL, 1500, $5, $6)`, [T, u(), coupon, id, cur, w.owner]);
    }
  });

  // 4. Market signals (only through an approved import, 0014): a past festival on a day with orders, one ahead, and a
  //    competitor price, per outlet.
  await approveDraft(db, w, "imports.run.commit.v1", async (q) => {
    for (const o of [A, B]) {
      await q(`INSERT INTO core.market_signal (tenant_id, id, outlet_id, on_date, kind, label, source, import_run_id)
               VALUES ($1, $2, $3, '2026-09-10', 'festival', 'festival.fixture', 'calendar.csv', $4),
                      ($1, $5, $3, $6, 'festival', 'festival.fixture', 'calendar.csv', $4)`, [T, u(), o, importRun, u(), addDays(today, 5)]);
      await q(`INSERT INTO core.market_signal (tenant_id, id, outlet_id, on_date, kind, label, item_id, value_minor, currency, source, import_run_id)
               VALUES ($1, $2, $3, $4, 'competitor_price', 'competitor.fixture', $5, 27000, $6, 'survey.csv', $7)`,
        [T, u(), o, addDays(today, -2), f.dish, cur, importRun]);
    }
  });

  // 5. intel rows (munim_svc): forecast runs and points, a negotiation run per outlet with its quotes, segment snapshots.
  await db.withContext("munim_svc", { tenant_id: T, outlet_ids: "*" }, async (c) => {
    const q: Q = (sql, params) => c.query(sql, params);
    const older = u();
    const latest = u();
    await q(`INSERT INTO intel.forecast_run (tenant_id, id, run_id, method, trained_through, horizon_days, holdout_days, created_at)
             VALUES ($1, $2, $4, 'weighted_seasonal_v1', '2026-09-01', 14, 28, now() - interval '1 day'), ($1, $3, $4, 'weighted_seasonal_v1', $5, 7, 28, now())`,
      [T, older, latest, w.run, addDays(today, -1)]);
    for (const [k, o] of [[1, A], [2, B]] as const) {
      for (const method of ["weighted_seasonal_v1", "seasonal_naive"]) {
        await q(`INSERT INTO intel.forecast_point (tenant_id, id, forecast_run_id, outlet_id, item_id, business_on, method, qty_milli, lo_qty_milli, hi_qty_milli, inputs_snapshot_id)
                 VALUES ($1, $2, $3, $4, $5, '2026-09-10', $6, $7, 0, $7, $8)`, [T, u(), older, o, f.dish, method, 3000 * k, w.snapshot]);
        for (let d = 1; d <= 7; d++) {
          await q(`INSERT INTO intel.forecast_point (tenant_id, id, forecast_run_id, outlet_id, item_id, business_on, method, qty_milli, lo_qty_milli, hi_qty_milli, inputs_snapshot_id)
                   VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $8, $9)`, [T, u(), latest, o, f.dish, addDays(today, d), method, 40000 * k, w.snapshot]);
        }
      }
    }
    for (const [k, o] of [[0, A], [1, B]] as const) {
      await q(`INSERT INTO intel.run (tenant_id, id, trigger, actor, outlet_scope, expires_at) VALUES ($1, $2, 'watch_sweep', 'watcher:inventory', $3, now() + interval '2 hours')`,
        [T, x.runs[k], [o]]);
      await q(`INSERT INTO intel.supplier_quote (tenant_id, id, run_id, supplier_id, ingredient_id, round, qty_milli, unit, unit_price_minor, currency, payment_days)
               VALUES ($1, $2, $3, $4, $5, 1, 20000, 'kg', $6, $7, 15)`, [T, x.quotes[k], x.runs[k], w.supplier, f.flour, 4200 + 100 * k, cur]);
      await q(`INSERT INTO evidence.snapshot (tenant_id, id, template_id, template_version, run_id, outlet_scope, rows, row_count, sha256)
               VALUES ($1, $2, 'customers.churn_segments', 1, $3, $4, $5, 1, repeat('0', 64))`,
        [T, x.snapshots[k], x.runs[k], [o], JSON.stringify([{ customer_id: w.customer, segment: "at_risk" }])]);
    }
  });
  return x;
}
