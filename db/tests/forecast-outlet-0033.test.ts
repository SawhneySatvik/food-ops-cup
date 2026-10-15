// 0033 gates (T-127: the latest forecast run per outlet; lane C T-114 report §0 "a one-outlet RFQ resets the other outlet's
// forecast"). The oracle is the world itself, never the migration: the M-C1bc fixture has one run with points at outlets A and B;
// a newer run that covers outlet A alone, with A's points copied unchanged, is what a one-outlet RFQ posts. Nothing about any
// outlet's forecast changed, so every read must be exactly what it was before that run.
//   F1  each of the six new versions, as the owner (every outlet), at outlet A and at outlet B: after the A-only run = before it;
//       with one run covering every outlet the new version = the previous one (nothing else changes);
//   RED the previous version on the same world after the A-only run differs at "every outlet" for every one of the six (B's
//       forecast is gone), so F1 cannot pass on a world where B's forecast does not matter;
//   F2  paired accept: a newer A-only run with A's points doubled is read for A (forecast.points at A = 2 × before) while B keeps
//       the earlier run's points;
//   SCOPE a manager of outlet A gets, at "every outlet", the owner's outlet-A rows of forecast.points (the pick never reaches B).
// Red-proofs: db/tests/redproof-0033.sh (each gate red with a non-zero exit).
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { AppContext, TestDb } from "../src/harness.ts";
import { openDb } from "./db.ts";
import { addOutletData, type McFixture } from "./mc1a-fixture.ts";
import { addMc1bcData, type McbcFixture } from "./mc1bc-fixture.ts";
import { buildWorld, ownerCtx, uuidv7, type World } from "./world.ts";

let db: TestDb;
let w: World;
let fx: McFixture;
let fy: McbcFixture;

/** The six and their new version (hand list, 0033's header). */
const NEW: Record<string, number> = {
  "kitchen.prep_need": 2, "forecast.points": 2, "inventory.shortfall": 3, "inventory.expiry_risk": 3, "purchasing.deal_inputs": 4, "market.upcoming": 3,
};
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Named params → $n, as core-api's bindNamedParams (copied from tests/w3decisions.test.ts). */
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

/** The params of each template at one outlet (null: every outlet in scope). deal_inputs reads its quote's outlet (B's quote). */
function params(id: string, outlet: string | null): Record<string, unknown> {
  const today = fy.today;
  switch (id) {
    case "kitchen.prep_need": return { outlet_id: outlet, business_date: addDays(today, 1) };
    case "forecast.points": return { outlet_id: outlet, from: today, to: addDays(today, 7), item_id: null };
    case "inventory.shortfall": return { outlet_id: outlet, lead_days: 7, as_of: today };
    case "inventory.expiry_risk": return { outlet_id: outlet, days: 7, as_of: today };
    case "purchasing.deal_inputs": return { quote_id: fy.quotes[1], as_of: today };
    case "market.upcoming": return { outlet_id: outlet, days: 7, as_of: today };
    default: throw new Error(`no params for ${id}`);
  }
}

/** Version `v` of `id` as core-api's runTemplate runs it (cells as text, rows in the template's order). */
async function run(id: string, v: number, outlet: string | null, ctx: AppContext = ownerCtx(w)): Promise<string> {
  const t = (await db.admin<{ sql: string }>("SELECT sql FROM evidence.snapshot_template WHERE id = $1 AND version = $2", [id, v])).rows[0];
  if (!t) throw new Error(`no ${id} v${v}`);
  const { sql, names } = bind(t.sql);
  const p = params(id, outlet);
  return db.withContext("munim_core", ctx, async (c) => {
    const r = await c.query<{ r: unknown }>(`SELECT (SELECT jsonb_object_agg(e.key, e.value #>> '{}') FROM jsonb_each(to_jsonb(t)) e) AS r FROM (${sql}) t`,
      names.map((n) => p[n]));
    return JSON.stringify(r.rows.map((y) => y.r));
  });
}

/** A run newer than every other, with outlet A's points of the fixture's latest run times `k` (k = 1: A's forecast unchanged). */
async function newerRunAtA(k: number): Promise<void> {
  await db.withContext("munim_svc", { tenant_id: w.tenant, outlet_ids: "*" }, async (c) => {
    const latest = (await c.query<{ id: string }>(`SELECT id FROM intel.forecast_run ORDER BY created_at DESC, id DESC LIMIT 1`)).rows[0]!.id;
    const id = uuidv7();
    await c.query(`INSERT INTO intel.forecast_run (tenant_id, id, run_id, method, trained_through, horizon_days, holdout_days, created_at)
                   SELECT tenant_id, $2, run_id, method, trained_through, horizon_days, holdout_days, created_at + interval '1 minute'
                     FROM intel.forecast_run WHERE id = $1`, [latest, id]);
    await c.query(`INSERT INTO intel.forecast_point (tenant_id, id, forecast_run_id, outlet_id, item_id, business_on, method, qty_milli, lo_qty_milli, hi_qty_milli, inputs_snapshot_id)
                   SELECT tenant_id, gen_random_uuid(), $2, outlet_id, item_id, business_on, method, qty_milli * $4, lo_qty_milli * $4, hi_qty_milli * $4, inputs_snapshot_id
                     FROM intel.forecast_point WHERE forecast_run_id = $1 AND outlet_id = $3`, [latest, id, fx.A, k]);
  });
}

const reads = async (v: (id: string) => number) => {
  const out: Record<string, string> = {};
  for (const id of Object.keys(NEW)) for (const [name, o] of [["all", null], ["A", fx.A], ["B", fx.B]] as const) out[`${id} ${name}`] = await run(id, v(id), o);
  return out;
};

let before: Record<string, string>;
let previousBefore: Record<string, string>;

beforeAll(async () => {
  db = await openDb();
  w = await buildWorld(db);
  fx = await addOutletData(db, w);
  fy = await addMc1bcData(db, w, fx);
  before = await reads((id) => NEW[id]!);
  previousBefore = await reads((id) => NEW[id]! - 1);
}, 300_000);
afterAll(async () => db?.stop());

describe("F1 the latest run per outlet", () => {
  test("one run covering every outlet: the new version reads exactly what the previous one reads", () => {
    const differ = Object.keys(before).filter((k) => before[k] !== previousBefore[k]);
    console.log(`F1 one run: ${Object.keys(before).length} reads, ${differ.length} differ`);
    expect(differ).toEqual([]);
  });

  test("a newer run at outlet A alone, A's points unchanged: every read of the new version is what it was before", async () => {
    await newerRunAtA(1);
    const after = await reads((id) => NEW[id]!);
    const previous = await reads((id) => NEW[id]! - 1);
    const changed = Object.keys(after).filter((k) => after[k] !== before[k]);
    // RED evidence on the same world: the previous version at "every outlet" lost B's forecast, for each of the six.
    const lost = Object.keys(NEW).filter((id) => previous[`${id} all`] !== before[`${id} all`]);
    console.log(`F1 A-only run: new version changed [${changed.join("; ")}]; previous version changed at every outlet for [${lost.join(", ")}]`);
    expect(changed).toEqual([]);
    expect(lost).toEqual(Object.keys(NEW));
    // Not vacuous: B's forecast is in the reads (forecast.points at B has rows).
    expect(JSON.parse(before["forecast.points B"]!).length).toBeGreaterThan(0);
  });
});

describe("F2 a newer run is read for its own outlet", () => {
  test("A's points doubled in a newer A-only run: forecast.points at A doubles, B keeps its points", async () => {
    await newerRunAtA(2);
    const qty = (s: string) => (JSON.parse(s) as Array<{ qty_milli: string }>).map((r) => Number(r.qty_milli));
    const a = qty(await run("forecast.points", 2, fx.A));
    const b = await run("forecast.points", 2, fx.B);
    console.log(`F2: A ${a.slice(0, 2).join(",")}… (before ${qty(before["forecast.points A"]!).slice(0, 2).join(",")}…); B unchanged ${b === before["forecast.points B"]}`);
    expect(a).toEqual(qty(before["forecast.points A"]!).map((x) => 2 * x));
    expect(b).toBe(before["forecast.points B"]);
  });
});

describe("SCOPE a scoped minter", () => {
  test("a manager of outlet A reads, at every outlet, the owner's outlet-A rows of forecast.points", async () => {
    const manager = { ...ownerCtx(w), role: "manager", member_id: fx.managerA, outlet_ids: [fx.A] };
    const mine = await run("forecast.points", 2, null, manager);
    const ownersA = await run("forecast.points", 2, fx.A);
    console.log(`SCOPE: manager A ${JSON.parse(mine).length} rows, owner at A ${JSON.parse(ownersA).length}`);
    expect(JSON.parse(mine).length).toBeGreaterThan(0);
    expect(mine).toBe(ownersA);
  });
});
