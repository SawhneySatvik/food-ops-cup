// 0026 gates (ledger R47, migrator lane m-1) on canonical worlds + the hand-valued rows below. Every refusal is paired with
// an accept; expected values are hand-kept beside their fixture rows, never read from the SQL:
//   (D1) platform.model_role prices (bigint minor units per 1M tokens): NULL on all six seeded roles; munim_platform sets
//        them (0 = free is legal); a fractional price sent as a parameter → 22P02; negative, half-set or a lower-case
//        currency → 23514; munim_core / munim_svc cannot write them (42501) and read them;
//        munim_intel_ro cannot read them. A model change applies exactly as written: the database never rewrites a price.
//   (D7) core.business_policy negotiation bounds: the owner's own tenancy.policy.set.v1 writes them; each 1..20000 and,
//        when both are set, target ≤ walk-away (23514 otherwise); another role → MB001; another command → MB008; no UPDATE (42501); the
//        world's existing policy row is NULL (unset).
//   (D6) people.labour_vs_demand v2: the excess minutes priced cheapest attending staff first (12,000 where v1's blended rate
//        reads 14,400 and most-expensive-first would read 16,500), per outlet (an order at another outlet in the same slot
//        changes nothing at this one; v1 merged them), one Σ row per (outlet, weekday, slot) first = Σ of the day cells.
//   (D3) purchasing.deal_inputs v3: a recipe-less shop SKU's margin from its lowest current catalogue price in the run's
//        scope (2,727 bp; 1,429 at an as_of where an older price applies; 2,000 when the run covers the cheaper outlet), net
//        of tax in an inclusive pack (AU: 4,000 bp, not 4,545); packaging → NULL with margin_rule_applies false; a unit that
//        does not convert → NULL with the rule still applying; a dish ingredient's nine v2 cells unchanged.
// Red-proofs: db/tests/redproof-0026.sh (each gate red with a non-zero exit).
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { AppContext, TestDb } from "../src/harness.ts";
import { openDb } from "./db.ts";
import { attempt } from "./gates.ts";
import { approveDraft, buildWorld, ownerCtx, uuidv7 as u, type World } from "./world.ts";

let db: TestDb;
let W: World; //  IN
let WA: World; // AU (tax-inclusive prices)

beforeAll(async () => {
  db = await openDb();
  W = await buildWorld(db);
  WA = await buildWorld(db, { country: "AU" });
});
afterAll(async () => db?.stop());

/** Named params → $n, as core-api's bindNamedParams (copied from tests/w3close.test.ts). */
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
/** Runs version `v` as core-api's runTemplate does (cells as text), as the world's owner. */
async function run(w: World, id: string, v: number, p: Record<string, unknown>): Promise<Row[]> {
  const t = (await db.admin<{ sql: string }>("SELECT sql FROM evidence.snapshot_template WHERE id = $1 AND version = $2", [id, v])).rows[0];
  if (!t) throw new Error(`no ${id} v${v}`);
  const { sql, names } = bind(t.sql);
  return db.withContext("munim_core", ownerCtx(w), async (c) => {
    const r = await c.query<{ r: Row }>(`SELECT (SELECT jsonb_object_agg(e.key, e.value #>> '{}') FROM jsonb_each(to_jsonb(t)) e) AS r FROM (${sql}) t LIMIT 500`,
      names.map((n) => p[n]));
    return r.rows.map((y) => y.r);
  });
}

// ---------------------------------------------------------------------------------------------------------------
describe("D1 — platform.model_role prices (operator config draft only)", () => {
  const PRICES = "input_price_per_mtok_minor, output_price_per_mtok_minor, price_currency";
  const plat = (sql: string, params: unknown[] = []) => attempt(db, "munim_platform", {}, sql, params);
  const prices = async (role: string) =>
    (await db.admin<Row>(`SELECT input_price_per_mtok_minor::text i, output_price_per_mtok_minor::text o, price_currency c, model_id m FROM platform.model_role WHERE role = $1`, [role])).rows[0];

  test("the six 0015 roles carry no price (none is invented); munim_svc and munim_core read the columns", async () => {
    for (const role of ["munim_svc", "munim_core"] as const) {
      const r = await db.withContext(role, { tenant_id: W.tenant, outlet_ids: "*" }, (c) =>
        c.query<{ n: string; priced: string }>(`SELECT count(*)::text n, count(*) FILTER (WHERE ${PRICES.split(", ").map((x) => `${x} IS NOT NULL`).join(" OR ")})::text priced FROM platform.model_role`));
      expect(r.rows).toEqual([{ n: "6", priced: "0" }]);
    }
  });

  test("munim_platform sets a price (and 0 = free); negative, half-set or lower-case currency → 23514", async () => {
    expect(await plat(`UPDATE platform.model_role SET input_price_per_mtok_minor = 30, output_price_per_mtok_minor = 250, price_currency = 'USD' WHERE role = 'router'`)).toBeNull();
    expect(await prices("router")).toEqual({ i: "30", o: "250", c: "USD", m: "gemini-3.5-flash-lite" });
    // A fractional price sent the way core sends values (a bound parameter) is refused, never rounded.
    const frac = await plat(`UPDATE platform.model_role SET input_price_per_mtok_minor = $1, output_price_per_mtok_minor = 30, price_currency = 'USD' WHERE role = 'router'`, ["7.5"]);
    expect([frac?.code, await prices("router")]).toEqual(["22P02", { i: "30", o: "250", c: "USD", m: "gemini-3.5-flash-lite" }]);
    expect(await plat(`UPDATE platform.model_role SET input_price_per_mtok_minor = 0, output_price_per_mtok_minor = 0, price_currency = 'USD' WHERE role = 'narrate'`)).toBeNull();
    expect(await prices("narrate")).toEqual({ i: "0", o: "0", c: "USD", m: "gemini-3.5-flash-lite" });
    const refused = [
      await plat(`UPDATE platform.model_role SET input_price_per_mtok_minor = -1, output_price_per_mtok_minor = 30, price_currency = 'USD' WHERE role = 'reason'`),
      await plat(`UPDATE platform.model_role SET input_price_per_mtok_minor = 10 WHERE role = 'reason'`),
      await plat(`UPDATE platform.model_role SET input_price_per_mtok_minor = 10, output_price_per_mtok_minor = 30 WHERE role = 'reason'`),
      await plat(`UPDATE platform.model_role SET input_price_per_mtok_minor = 10, output_price_per_mtok_minor = 30, price_currency = 'usd' WHERE role = 'reason'`),
    ];
    console.log("D1 refusals:", JSON.stringify(refused.map((e) => e && [e.code, /"(model_role_price_[a-z_]+)"/.exec(e.message)?.[1]])));
    expect(refused.map((e) => e && [e.code, /"(model_role_price_[a-z_]+)"/.exec(e.message)?.[1]])).toEqual([
      ["23514", "model_role_price_nonnegative"], ["23514", "model_role_price_all_or_none"], ["23514", "model_role_price_all_or_none"],
      ["23514", "model_role_price_currency_format"]]);
    expect(await prices("reason")).toEqual({ i: null, o: null, c: null, m: "gemini-3.8-flash" });
  });

  test("only munim_platform writes them: munim_core / munim_svc UPDATE → 42501; munim_intel_ro cannot even read them", async () => {
    const set = `UPDATE platform.model_role SET input_price_per_mtok_minor = 1, output_price_per_mtok_minor = 1, price_currency = 'USD' WHERE role = 'vision'`;
    const got = [
      await attempt(db, "munim_core", { tenant_id: W.tenant, outlet_ids: "*" }, set),
      await attempt(db, "munim_svc", { tenant_id: W.tenant, outlet_ids: "*" }, set),
      await attempt(db, "munim_intel_ro", { tenant_id: W.tenant, outlet_ids: "*" }, `SELECT price_currency FROM platform.model_role`),
      await attempt(db, "munim_platform", {}, set),
    ];
    expect(got.map((e) => e?.code ?? "ok")).toEqual(["42501", "42501", "42501", "ok"]);
  });

  test("as signed: a model change keeps exactly the prices its UPDATE writes (re-stated, new, untouched or cleared)", async () => {
    const setPrice = (i: number, o: number, extra = "") =>
      plat(`UPDATE platform.model_role SET input_price_per_mtok_minor = $1, output_price_per_mtok_minor = $2, price_currency = 'USD'${extra} WHERE role = 'extract'`, [i, o]);
    const seen: Array<[string, Row | undefined]> = [];
    await setPrice(30, 250);
    seen.push(["price set", await prices("extract")]);
    await plat(`UPDATE platform.model_role SET input_price_per_mtok_minor = 40 WHERE role = 'extract'`); // one price changed: all three still set, legal
    await plat(`UPDATE platform.model_role SET model_id = 'gemini-3-flash' WHERE role = 'extract'`);
    seen.push(["model changed, price untouched", await prices("extract")]);
    await setPrice(40, 300, `, model_id = 'gemini-3.5-flash-lite'`);
    seen.push(["model changed with a new price", await prices("extract")]);
    await setPrice(40, 300, `, model_id = 'gemini-3-flash'`);
    seen.push(["model changed, the old price re-stated", await prices("extract")]);
    await setPrice(50, 400);
    await plat(`UPDATE platform.model_role SET provider = 'openrouter' WHERE role = 'extract'`);
    seen.push(["provider changed", await prices("extract")]);
    await setPrice(50, 400);
    await plat(`INSERT INTO platform.model_role (role, provider, model_id) VALUES ('extract', 'gemini', 'gemini-3-flash')
                ON CONFLICT (role) DO UPDATE SET provider = excluded.provider, model_id = excluded.model_id, probed_at = NULL`);
    seen.push(["core's apply() upsert with a model change", await prices("extract")]);
    await setPrice(60, 500);
    seen.push(["price-only change", await prices("extract")]);
    await plat(`UPDATE platform.model_role SET model_id = 'gemini-3.5-flash-lite', input_price_per_mtok_minor = NULL, output_price_per_mtok_minor = NULL,
                price_currency = NULL WHERE role = 'extract'`); // core's apply() when a model-change draft omits the price group
    seen.push(["model changed, prices cleared by the UPDATE", await prices("extract")]);
    console.log("D1 as signed:", JSON.stringify(seen));
    const n = { i: null, o: null, c: null };
    expect(seen).toEqual([
      ["price set", { i: "30", o: "250", c: "USD", m: "gemini-3.5-flash-lite" }],
      ["model changed, price untouched", { i: "40", o: "250", c: "USD", m: "gemini-3-flash" }],
      ["model changed with a new price", { i: "40", o: "300", c: "USD", m: "gemini-3.5-flash-lite" }],
      ["model changed, the old price re-stated", { i: "40", o: "300", c: "USD", m: "gemini-3-flash" }],
      ["provider changed", { i: "50", o: "400", c: "USD", m: "gemini-3-flash" }],
      ["core's apply() upsert with a model change", { i: "50", o: "400", c: "USD", m: "gemini-3-flash" }],
      ["price-only change", { i: "60", o: "500", c: "USD", m: "gemini-3-flash" }],
      ["model changed, prices cleared by the UPDATE", { ...n, m: "gemini-3.5-flash-lite" }],
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("D7 — core.business_policy negotiation bounds (the owner's own tenancy.policy.set.v1)", () => {
  const policy = (w: World, ctx: AppContext, target: number | null, walk: number | null, from: string) =>
    attempt(db, "munim_core", ctx, `INSERT INTO core.business_policy (tenant_id, id, valid_from, negotiation_target_bp, negotiation_walkaway_bp, created_by)
                                     VALUES ($1, $2, $3, $4, $5, $6)`, [w.tenant, u(), from, target, walk, w.owner]);
  const own = () => ownerCtx(W, { command_type: "tenancy.policy.set.v1" });

  test("the world's existing policy is unset (NULL: code applies 9500 / 11000), never backfilled", async () => {
    const r = await db.admin<Row>(`SELECT negotiation_target_bp::text t, negotiation_walkaway_bp::text w FROM core.business_policy WHERE tenant_id = $1`, [W.tenant]);
    expect(r.rows).toEqual([{ t: null, w: null }]);
  });

  test("accepts 9000 / 12000 and the edges (1 / 20000, 10500 / 10500, one bound unset); refuses outside them (23514)", async () => {
    const ok = [
      await policy(W, own(), 9000, 12000, "2026-11-01"), await policy(W, own(), 10500, 10500, "2026-11-02"),
      await policy(W, own(), 1, 20000, "2026-11-03"), await policy(W, own(), 20000, null, "2026-11-04"), await policy(W, own(), null, 1, "2026-11-05"),
    ];
    expect(ok).toEqual([null, null, null, null, null]);
    const r = await db.admin<Row>(`SELECT valid_from::text f, negotiation_target_bp::text t, negotiation_walkaway_bp::text w FROM core.business_policy
                                    WHERE tenant_id = $1 AND valid_from >= '2026-11-01' ORDER BY valid_from`, [W.tenant]);
    expect(r.rows).toEqual([{ f: "2026-11-01", t: "9000", w: "12000" }, { f: "2026-11-02", t: "10500", w: "10500" },
      { f: "2026-11-03", t: "1", w: "20000" }, { f: "2026-11-04", t: "20000", w: null }, { f: "2026-11-05", t: null, w: "1" }]);
    const bad = [await policy(W, own(), 0, 11000, "2026-12-01"), await policy(W, own(), 20001, null, "2026-12-01"),
      await policy(W, own(), null, 0, "2026-12-01"), await policy(W, own(), 9500, 20001, "2026-12-01"),
      await policy(W, own(), 11001, 11000, "2026-12-01")];
    expect(bad.map((e) => e && [e.code, /"(business_policy_negotiation_[a-z]+_check)"/.exec(e.message)?.[1]])).toEqual([
      ["23514", "business_policy_negotiation_target_check"], ["23514", "business_policy_negotiation_target_check"],
      ["23514", "business_policy_negotiation_walkaway_check"], ["23514", "business_policy_negotiation_walkaway_check"],
      ["23514", "business_policy_negotiation_order_check"]]);
  });

  test("only the owner's own policy command writes them: manager → MB001, another command → MB008, UPDATE → 42501", async () => {
    const mgr = u();
    await db.withContext("munim_core", ownerCtx(W, { command_type: "tenancy.member.invite.v1" }), async (c) => {
      await c.query(`INSERT INTO core.member (tenant_id, id, name, email) VALUES ($1, $2, 'Manager', 'mgr-0026@example.test')`, [W.tenant, mgr]);
      await c.query(`INSERT INTO core.membership (tenant_id, member_id, role, outlet_ids) VALUES ($1, $2, 'manager', $3)`, [W.tenant, mgr, W.outlets]);
    });
    const got = [
      await policy(W, { tenant_id: W.tenant, outlet_ids: "*", role: "manager", member_id: mgr, command_type: "tenancy.policy.set.v1" }, 9000, 12000, "2027-01-01"),
      await policy(W, ownerCtx(W, { command_type: "catalogue.item.upsert.v1" }), 9000, 12000, "2027-01-02"),
      await attempt(db, "munim_core", own(), `UPDATE core.business_policy SET negotiation_target_bp = 9000 WHERE tenant_id = $1`, [W.tenant]),
      await policy(W, own(), 9000, 12000, "2027-01-03"),
    ];
    console.log("D7 refusals:", JSON.stringify(got.map((e) => e?.code ?? "ok")));
    expect(got.map((e) => e?.code ?? "ok")).toEqual(["MB001", "MB008", "42501", "ok"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("D6 — people.labour_vs_demand v2 (excess at the extra staff's rate, per outlet, Σ rows first)", () => {
  // Outlet 3 (Asia/Kolkata, cutoff 04:00), the 10:00 slot of four Tuesdays. History (the norm): 25 Aug, 1 Sep, 8 Sep — Asha
  // alone 10:00–11:00 (60 min) and one completed order at 10:10 → 60 minutes per order. Tue 15 Sep: Asha (12,000/h) 60 min,
  // Bina (9,000/h) 60 min, Chetan (6,000/h) 10:00–10:30 = 30 min, one order → attended 150, needed 1 × 60 = 60, excess 90.
  //   v2, cheapest first: Chetan 30 min × 6,000 ÷ 60 = 3,000 + Bina 60 min × 9,000 ÷ 60 = 9,000 → 12,000.
  //   v1, blended: (60 × 12,000 + 60 × 9,000 + 30 × 6,000) ÷ 150 = 9,600 / h × 90 ÷ 60 = 14,400.
  //   (most expensive first would read Asha 60 × 200 + Bina 30 × 150 = 16,500.)
  // 8 Sep in the window: norm = median(60, 60) = 60, attended 60 → needed 60, excess 0, cost 0.
  // Outlet 2 gets one order at 10:15 on 15 Sep and no staff: v2 judges it on its own (no norm → NULL); v1 with outlet_id NULL
  // summed it into outlet 3's slot (2 orders → needed 120, excess 30 → 30 × 9,600 ÷ 60 = 4,800).
  const S: Record<string, string> = {};
  beforeAll(async () => {
    const O3 = W.outlets[2];
    S.asha = u(); S.bina = u(); S.chetan = u();
    await db.withContext("munim_core", ownerCtx(W, { command_type: "people.staff.upsert.v1" }), async (c) => {
      for (const [id, name, rate] of [[S.asha, "Asha", 12000], [S.bina, "Bina", 9000], [S.chetan, "Chetan", 6000]] as const) {
        await c.query(`INSERT INTO core.staff (tenant_id, id, outlet_id, name, role_key, pay_basis, wage_rate_minor, ot_multiplier_bp, currency, joined_on)
                       VALUES ($1, $2, $3, $4, 'helper', 'hourly', $5, 15000, $6, '2026-01-01')`, [W.tenant, id, O3, name, rate, W.currency]);
      }
    });
    const shifts: Array<[string, string, string]> = [];
    for (const d of ["2026-08-25", "2026-09-01", "2026-09-08", "2026-09-15"]) shifts.push([S.asha!, `${d}T04:30:00Z`, `${d}T05:30:00Z`]);
    shifts.push([S.bina!, "2026-09-15T04:30:00Z", "2026-09-15T05:30:00Z"], [S.chetan!, "2026-09-15T04:30:00Z", "2026-09-15T05:00:00Z"]);
    await db.withContext("munim_core", ownerCtx(W, { command_type: "people.attendance.record.v1" }), async (c) => {
      for (const [staff, from, to] of shifts) {
        await c.query(`INSERT INTO core.attendance (tenant_id, id, outlet_id, staff_id, clock_in_at, clock_out_at, source, recorded_by)
                       VALUES ($1, $2, $3, $4, $5, $6, 'manual', $7)`, [W.tenant, u(), O3, staff, from, to, W.owner]);
      }
    });
    await approveDraft(db, W, "imports.run.commit.v1", async (q) => {
      const orders: Array<[string, string, string]> = ["2026-08-25", "2026-09-01", "2026-09-08", "2026-09-15"].map((d) => [O3, d, `${d}T04:40:00Z`]);
      orders.push([W.outlets[1], "2026-09-15", "2026-09-15T04:45:00Z"]);
      for (const [o, d, at] of orders) {
        await q(`INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, kind, status, business_date, subtotal_minor, tax_minor, total_minor, currency,
                                            pricing_snapshot, created_at)
                 VALUES ($1, $2, $3, $4, 'takeaway', 'completed', $5, 20000, 0, 20000, $6, '{"synthetic": true}', $7)`,
          [W.tenant, u(), o, W.channel, d, W.currency, at]);
      }
    });
  });
  const P = (outlet: string | null) => ({ outlet_id: outlet, from: "2026-09-08", to: "2026-09-15", slot_minutes: 60 });
  const row = (business_on: string | null, att: number, n: number, needed: number | null, cost: number | null, excess: number | null, outlet = W.outlets[2]) => ({
    business_on, slot_start: "10:00", attended_min: String(att), rostered_min: "0", orders: String(n), forecast_orders: null,
    needed_min: needed === null ? null : String(needed), excess_cost_minor: cost === null ? null : String(cost), outlet_id: outlet, weekday: "tue",
    excess_min: excess === null ? null : String(excess),
  });

  test("hand values at outlet 3: Σ row first (210 attended, 2 orders, 120 needed, 90 excess, 12,000), then 8 Sep and 15 Sep", async () => {
    const got = await run(W, "people.labour_vs_demand", 2, P(W.outlets[2]));
    console.log("D6 v2 outlet 3:", JSON.stringify(got));
    expect(got).toEqual([row(null, 210, 2, 120, 12000, 90), row("2026-09-08", 60, 1, 60, 0, 0), row("2026-09-15", 150, 1, 60, 12000, 90)]);
  });

  test("per outlet: outlet_id NULL gives outlet 3 the same rows, and outlet 2's order its own slot (no norm → NULL)", async () => {
    const all = await run(W, "people.labour_vs_demand", 2, P(null));
    const o2 = all.filter((r) => r.outlet_id === W.outlets[1] && r.slot_start === "10:00");
    expect(all.filter((r) => r.outlet_id === W.outlets[2])).toEqual(await run(W, "people.labour_vs_demand", 2, P(W.outlets[2])));
    expect(o2).toEqual([row(null, 0, 1, null, null, null, W.outlets[1]), row("2026-09-15", 0, 1, null, null, null, W.outlets[1])]);
  });

  test("v1 is unchanged: blended 14,400 at outlet 3, and with outlet_id NULL the two outlets merged (2 orders → 4,800)", async () => {
    const v1 = (await run(W, "people.labour_vs_demand", 1, P(W.outlets[2]))).find((r) => r.business_on === "2026-09-15");
    const merged = (await run(W, "people.labour_vs_demand", 1, P(null))).find((r) => r.business_on === "2026-09-15" && r.slot_start === "10:00");
    expect([v1?.excess_cost_minor, merged?.orders, merged?.needed_min, merged?.excess_cost_minor]).toEqual(["14400", "2", "120", "4800"]);
  });

  test("v2 is the latest, with v1's params and min_role", async () => {
    const r = await db.admin<{ latest: number; same: boolean }>(`
      SELECT (SELECT max(version) FROM evidence.snapshot_template WHERE id = 'people.labour_vs_demand') latest,
             (SELECT a.params_schema = b.params_schema AND a.min_role = b.min_role FROM evidence.snapshot_template a, evidence.snapshot_template b
               WHERE a.id = b.id AND a.id = 'people.labour_vs_demand' AND a.version = 1 AND b.version = 2) same`);
    expect(r.rows).toEqual([{ latest: 2, same: true }]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("D3 — purchasing.deal_inputs v3 (shop SKU margin from the catalogue price; margin_rule_applies)", () => {
  // IN (prices tax-exclusive). Soap: a recipe-less SKU stocking the 'pc' ingredient soap. Prices (no variant):
  //   outlet 1 counter 3,500 · outlet 1 own_site 3,300 · outlet 1 pickup 2,800 valid 1 Jan – 1 Jun 2026 only ·
  //   outlet 1 table_qr 2,000 from 2099 · outlet 2 counter 3,000.
  // A run scoped to outlet 1, quote 2,400 per 'pc':
  //   today: lowest current = 3,300 → (3,300 − 2,400) × 10,000 ÷ 3,300 = 2,727.27 → 2,727
  //   as_of 2026-03-01: pickup 2,800 applies → 400 × 10,000 ÷ 2,800 = 1,428.57 → 1,429
  // A run over every outlet: outlet 2's 3,000 → 600 × 10,000 ÷ 3,000 = 2,000.
  // The same quote in 'kg': 'pc' does not convert → NULL, rule applies. Carry bag (packaging, no item): NULL, rule does not apply.
  // AU (tax-inclusive, gst_10 = 1,000 bp): shelf 1,100 → net 1,100 × 10,000 ÷ 11,000 = 1,000; quote 600 → 4,000 (not 4,545).
  const Q: Record<string, string> = {};
  async function sku(w: World, name: string, prices: Array<[string, string, number, string, string, string | null]>): Promise<string> {
    const ing = u();
    const item = u();
    await db.withContext("munim_core", ownerCtx(w, { command_type: "inventory.ingredient.upsert.v1" }), async (c) => {
      await c.query(`INSERT INTO core.ingredient (tenant_id, id, name, base_unit) VALUES ($1, $2, $3, 'pc')`, [w.tenant, ing, name]);
      if (prices.length === 0) return;
      await c.query("SELECT set_config('app.command_type', 'catalogue.item.upsert.v1', true)");
      await c.query(`INSERT INTO core.item (tenant_id, id, kind, name_key, category, stock_ingredient_id) VALUES ($1, $2, 'sku', $3, 'grocery', $4)`,
        [w.tenant, item, `shop.${name}`, ing]);
      await c.query("SELECT set_config('app.command_type', 'catalogue.price.set.v1', true)");
      for (const [outlet, channel, amount, taxClass, from, to] of prices) {
        await c.query(`INSERT INTO core.price (tenant_id, id, item_id, outlet_id, channel_kind, amount_minor, currency, tax_class, valid_from, valid_to)
                       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [w.tenant, u(), item, outlet, channel, amount, w.currency, taxClass, from, to]);
      }
    });
    return ing;
  }
  async function quote(w: World, scope: string[], ingredient: string, unit: string, price: number): Promise<string> {
    const [runId, id] = [u(), u()];
    await db.withContext("munim_svc", { tenant_id: w.tenant, outlet_ids: "*" }, async (c) => {
      await c.query(`INSERT INTO intel.run (tenant_id, id, trigger, actor, outlet_scope, expires_at) VALUES ($1, $2, 'watch_sweep', 'watcher:inventory', $3, now() + interval '2 hours')`,
        [w.tenant, runId, scope]);
      await c.query(`INSERT INTO intel.supplier_quote (tenant_id, id, run_id, supplier_id, ingredient_id, round, qty_milli, unit, unit_price_minor, currency, payment_days)
                     VALUES ($1, $2, $3, $4, $5, 1, 10000, $6, $7, $8, 15)`, [w.tenant, id, runId, w.supplier, ingredient, unit, price, w.currency]);
    });
    return id;
  }
  beforeAll(async () => {
    const [o1, o2] = W.outlets;
    const soap = await sku(W, "soap", [
      [o1, "counter", 3500, "goods_18", "2026-01-01", null], [o1, "own_site", 3300, "goods_18", "2026-01-01", null],
      [o1, "pickup", 2800, "goods_18", "2026-01-01", "2026-06-01"], [o1, "table_qr", 2000, "goods_18", "2099-01-01", null],
      [o2, "counter", 3000, "goods_18", "2026-01-01", null]]);
    const bag = await sku(W, "carry_bag", []);
    Q.soap = await quote(W, [o1], soap, "pc", 2400);
    Q.soapAll = await quote(W, ["*"], soap, "pc", 2400);
    Q.soapKg = await quote(W, [o1], soap, "kg", 2400);
    Q.bag = await quote(W, [o1], bag, "pc", 50);
    Q.paneer = await quote(W, [o1], W.ingredient, "kg", 30000);
    const tea = await sku(WA, "tea", [[WA.outlets[0], "counter", 1100, "gst_10", "2026-01-01", null]]);
    Q.au = await quote(WA, [WA.outlets[0]], tea, "pc", 600);
  });
  const di = (w: World, quoteId: string, asOf: string | null = null) => run(w, "purchasing.deal_inputs", 3, { quote_id: quoteId, as_of: asOf });
  const pick = (r: Row[]) => r.map((x) => [x.margin_at_quote_bp, x.margin_rule_applies]);

  test("hand values: SKU 2,727 (1,429 at as_of 1 Mar; 2,000 over every outlet); 'kg' NULL / applies; packaging NULL / not; AU net of GST 4,000", async () => {
    const got = {
      soap: pick(await di(W, Q.soap!)), soapAsOf: pick(await di(W, Q.soap!, "2026-03-01")), soapAll: pick(await di(W, Q.soapAll!)),
      soapKg: pick(await di(W, Q.soapKg!)), bag: pick(await di(W, Q.bag!)), au: pick(await di(WA, Q.au!)),
    };
    console.log("D3 v3:", JSON.stringify(got));
    expect(got).toEqual({
      soap: [["2727", "true"]], soapAsOf: [["1429", "true"]], soapAll: [["2000", "true"]],
      soapKg: [[null, "true"]], bag: [[null, "false"]], au: [["4000", "true"]],
    });
  });

  test("v2 reads none of it (no SKU path): NULL margin for the SKU and the packaging alike", async () => {
    const v2 = async (id: string) => (await run(W, "purchasing.deal_inputs", 2, { quote_id: id, as_of: null }))[0]?.margin_at_quote_bp;
    expect([await v2(Q.soap!), await v2(Q.bag!)]).toEqual([null, null]);
  });

  test("a dish ingredient (paneer: the world's dish and a price-less paneer SKU) keeps v2's nine cells; the rule applies", async () => {
    const [v2] = await run(W, "purchasing.deal_inputs", 2, { quote_id: Q.paneer, as_of: null });
    const [v3] = await di(W, Q.paneer!);
    const { margin_rule_applies, ...rest } = v3!;
    expect([rest, margin_rule_applies]).toEqual([v2, "true"]);
  });

  // 0033 (T-127) adds v4 on top (the latest forecast run per outlet), with v3's params, columns and role (forecast-outlet-0033.test.ts).
  test("v3 has v2's params and min_role, v4 (0033) is the latest; margin_at_quote_bp names core.price.amount_minor", async () => {
    const r = await db.admin<{ latest: number; same: boolean; src: boolean }>(`
      SELECT (SELECT max(version) FROM evidence.snapshot_template WHERE id = 'purchasing.deal_inputs') latest,
             (SELECT a.params_schema = b.params_schema AND a.min_role = b.min_role FROM evidence.snapshot_template a, evidence.snapshot_template b
               WHERE a.id = b.id AND a.id = 'purchasing.deal_inputs' AND a.version = 2 AND b.version = 3) same,
             (SELECT (c -> 'numeric_source') ? 'core.price.amount_minor' FROM evidence.snapshot_template t, jsonb_array_elements(t.columns) c
               WHERE t.id = 'purchasing.deal_inputs' AND t.version = 3 AND c ->> 'name' = 'margin_at_quote_bp') src`);
    expect(r.rows).toEqual([{ latest: 4, same: true, src: true }]);
  });
});

describe("both new versions return exactly their declared columns, in order", () => {
  test("labour_vs_demand v2 and deal_inputs v3: the SQL's output fields = the template's columns", async () => {
    const got: Record<string, [string[], string[]]> = {};
    for (const [id, v, p] of [["people.labour_vs_demand", 2, { outlet_id: null, from: "2026-09-08", to: "2026-09-15", slot_minutes: 60 }],
      ["purchasing.deal_inputs", 3, { quote_id: u(), as_of: null }]] as const) {
      const t = (await db.admin<{ sql: string; columns: Array<{ name: string }> }>("SELECT sql, columns FROM evidence.snapshot_template WHERE id = $1 AND version = $2", [id, v])).rows[0]!;
      const { sql, names } = bind(t.sql);
      const fields = await db.withContext("munim_core", ownerCtx(W), async (c) =>
        (await c.query({ text: `SELECT * FROM (${sql}) t LIMIT 0`, values: names.map((n) => (p as Record<string, unknown>)[n]) })).fields.map((f) => f.name));
      got[id] = [fields, t.columns.map((c) => c.name)];
    }
    expect(got["people.labour_vs_demand"]![0]).toEqual(["business_on", "slot_start", "attended_min", "rostered_min", "orders", "forecast_orders",
      "needed_min", "excess_cost_minor", "outlet_id", "weekday", "excess_min"]);
    expect(got["purchasing.deal_inputs"]![0]).toEqual(["quote_total_minor", "quote_payment_days", "budget_left_minor", "open_commit_qty_milli",
      "need_qty_milli", "use_in_shelf_life_qty_milli", "margin_at_quote_bp", "margin_floor_bp", "min_payment_days", "margin_rule_applies"]);
    for (const [fields, declared] of Object.values(got)) expect(fields).toEqual(declared);
  });
});
