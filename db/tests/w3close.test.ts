// 0025 gates (W3 close, migrator lane m-1) on canonical worlds + the hand-valued rows below. Every refusal is paired with
// an accept; expected values are hand-kept beside their fixture rows, never read from the SQL:
//   (E1) intel.investigation_cost_estimate v2 = per spend currency, round(Σ spend of linked same-playbook steps ÷ linked
//        steps) × expected remaining steps (open/waiting: least(max_steps − steps_done, unfrozen items); terminal: 0). The
//        history holds a linked step with no spend and one with spend only in USD (both in every denominator), and an
//        unlinked step (in none). v1 is unchanged and reads the inflated value. Another playbook → 0 rows; linked steps but
//        no spend anywhere → 0 rows.
//   (N1) core.investigation INSERT (munim_core) and UPDATE (munim_svc) each NOTIFY munim_inbox '<tenant>:<id>' once; an
//        explicit identical pg_notify in the same transaction is still one delivery; a rolled-back update notifies nobody.
//   (G1) munim_platform pages a tenant's spend rows by (at, id); run_id / model_id / SELECT * → 42501; core.ai_budget_cap → 42501.
// Red-proofs: db/tests/redproof-0025.sh (each gate red with a non-zero exit).
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { AppContext, TestDb } from "../src/harness.ts";
import { openDb } from "./db.ts";
import { attempt } from "./gates.ts";
import { buildWorld, ownerCtx, uuidv7 as u, type World } from "./world.ts";

let db: TestDb;
let W: World;
const svc = (): AppContext => ({ tenant_id: W.tenant, outlet_ids: "*" });

beforeAll(async () => {
  db = await openDb();
  W = await buildWorld(db);
});
afterAll(async () => db?.stop());

/** Named params → $n, as core-api's bindNamedParams (copied from tests/w32fix.test.ts). */
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
async function run(id: string, v: number, p: Record<string, unknown>): Promise<Row[]> {
  const t = (await db.admin<{ sql: string }>("SELECT sql FROM evidence.snapshot_template WHERE id = $1 AND version = $2", [id, v])).rows[0];
  if (!t) throw new Error(`no ${id} v${v}`);
  const { sql, names } = bind(t.sql);
  return db.withContext("munim_core", ownerCtx(W), async (c) => {
    const r = await c.query<{ r: Row }>(`SELECT (SELECT jsonb_object_agg(e.key, e.value #>> '{}') FROM jsonb_each(to_jsonb(t)) e) AS r FROM (${sql}) t LIMIT 500`,
      names.map((n) => p[n]));
    return r.rows.map((y) => y.r);
  });
}

// ---------------------------------------------------------------------------------------------------------------
describe("E1 — intel.investigation_cost_estimate v2 (per remaining step)", () => {
  const T: Record<string, string> = {};
  /** 7 checklist items, the first `frozen` of them frozen. */
  const checklist = (frozen: number) =>
    JSON.stringify(Array.from({ length: 7 }, (_, k) => ({ item_id: `h${k}`, status: k < frozen ? "supported" : "pending", frozen: k < frozen, snapshot_ids: [] })));
  const newInv = (playbook: string, cl: string, extra: { status?: string; max_steps?: number; steps_done?: number } = {}) => {
    const id = u();
    return db.withContext("munim_core", ownerCtx(W), (c) =>
      c.query(`INSERT INTO core.investigation (tenant_id, id, playbook_id, outlet_scope, created_by, checklist, status, max_steps, steps_done)
               VALUES ($1, $2, $3, '{*}', $4, $5, $6, $7, $8)`,
        [W.tenant, id, playbook, W.owner, cl, extra.status ?? "open", extra.max_steps ?? 10, extra.steps_done ?? 0])).then(() => id);
  };
  /** Steps on `inv`, one run per entry (null = a step with no run); spends per run as [amount, currency]. */
  async function history(inv: string, steps: Array<Array<[number, string]> | null>) {
    const runs = steps.map((s) => (s === null ? null : u()));
    await db.withContext("munim_svc", svc(), async (c) => {
      for (const [k, r] of runs.entries()) {
        if (r === null) continue;
        await c.query(`INSERT INTO intel.run (tenant_id, id, trigger, actor, outlet_scope, expires_at) VALUES ($1, $2, 'ask', $3, '{*}', now() + interval '1 hour')`, [W.tenant, r, W.owner]);
        for (const [amount, currency] of steps[k]!) {
          await c.query(`INSERT INTO intel.intel_spend (tenant_id, id, run_id, role, provider, model_id, input_tokens, output_tokens, amount_minor, currency)
                         VALUES ($1, $2, $3, 'narrate', 'gemini', 'gemini-3.5-flash-lite', 1000, 100, $4, $5)`, [W.tenant, u(), r, amount, currency]);
        }
      }
    });
    await db.withContext("munim_core", ownerCtx(W), async (c) => {
      for (const [k, r] of runs.entries()) {
        await c.query(`INSERT INTO core.investigation_step (tenant_id, investigation_id, step_no, member_id, triggered_by, run_id) VALUES ($1, $2, $3, $4, 'member', $5)`,
          [W.tenant, inv, k + 1, W.owner, r]);
      }
    });
  }

  beforeAll(async () => {
    // History on margin_fall (+ the world's own margin_fall investigation: 1 step with no run — unlinked).
    //   step 1 INR 120 · step 2 INR 95 · step 3 INR 130 · step 4 INR 60 + 41 (two calls) · step 5 USD 7 only · step 6 a run
    //   with no spend · step 7 no run.
    //   Linked steps = 6 (steps 1–6). INR Σ 446 ÷ 6 = 74.33… → 74. USD Σ 7 ÷ 6 = 1.17 → 1.
    //   (v1, inner join: INR 446 ÷ 4 steps with INR spend = 111.5 → 112; USD 7 ÷ 1 = 7.)
    const H = await newInv("margin_fall", "[]");
    await history(H, [[[120, "INR"]], [[95, "INR"]], [[130, "INR"]], [[60, "INR"], [41, "INR"]], [[7, "USD"]], [], null]);
    T.fresh = await newInv("margin_fall", checklist(0)); //                                    10 − 0, 7 unfrozen → 7 steps
    T.capped = await newInv("margin_fall", checklist(2), { max_steps: 3, steps_done: 1 }); //  3 − 1, 5 unfrozen → 2 steps
    T.waiting = await newInv("margin_fall", checklist(4), { status: "waiting", steps_done: 4 }); // 10 − 4, 3 unfrozen → 3
    T.cancelled = await newInv("margin_fall", checklist(0), { status: "cancelled" }); //        terminal → 0 steps
    T.other = await newInv("stock_gap", checklist(0)); //                                       no history on its playbook
    // A playbook whose only linked step recorded no spend: no currency to state a figure in.
    const Q = await newInv("quiet", "[]");
    await history(Q, [[]]);
    T.quiet = await newInv("quiet", checklist(0));
  });

  const row = (currency: string, per: number, items: number, steps: number, estimate: number) => ({
    currency, per_step_minor: String(per), steps_in_history: "6", remaining_items: String(items), remaining_steps: String(steps),
    estimate_minor: String(estimate), label: "estimate (computed)",
  });

  test("hand values: 74 per step (446 ÷ 6) × 7 = 518 INR and 1 × 7 = 7 USD; the cap 3 − 1 = 2 → 148 / 2; waiting 3 → 222 / 3; cancelled → 0", async () => {
    const got = {
      fresh: await run("intel.investigation_cost_estimate", 2, { investigation_id: T.fresh }),
      capped: await run("intel.investigation_cost_estimate", 2, { investigation_id: T.capped }),
      waiting: await run("intel.investigation_cost_estimate", 2, { investigation_id: T.waiting }),
      cancelled: await run("intel.investigation_cost_estimate", 2, { investigation_id: T.cancelled }),
    };
    console.log("E1 v2:", JSON.stringify(got));
    expect(got).toEqual({
      fresh: [row("INR", 74, 7, 7, 518), row("USD", 1, 7, 7, 7)],
      capped: [row("INR", 74, 5, 2, 148), row("USD", 1, 5, 2, 2)],
      waiting: [row("INR", 74, 3, 3, 222), row("USD", 1, 3, 3, 3)],
      cancelled: [row("INR", 74, 7, 0, 0), row("USD", 1, 7, 0, 0)],
    });
  });

  test("v1 is unchanged (inner join, per item): 112 × 7 = 784 INR, 7 × 7 = 49 USD over 4 / 1 steps", async () => {
    const v1 = await run("intel.investigation_cost_estimate", 1, { investigation_id: T.fresh });
    console.log("E1 v1:", JSON.stringify(v1));
    expect(v1).toEqual([
      { currency: "INR", per_step_minor: "112", steps_in_history: "4", remaining_items: "7", estimate_minor: "784", label: "estimate (computed)" },
      { currency: "USD", per_step_minor: "7", steps_in_history: "1", remaining_items: "7", estimate_minor: "49", label: "estimate (computed)" },
    ]);
  });

  test("another playbook with no history → 0 rows; linked steps with no spend anywhere → 0 rows (never a NULL currency)", async () => {
    const other = await run("intel.investigation_cost_estimate", 2, { investigation_id: T.other });
    const quiet = await run("intel.investigation_cost_estimate", 2, { investigation_id: T.quiet });
    console.log("E1 empty:", other.length, quiet.length);
    expect([other, quiet]).toEqual([[], []]);
  });

  test("v2 is the latest version, with v1's params and min_role", async () => {
    const r = (await db.admin<{ v: number; same: boolean }>(`
      SELECT t2.version AS v, t2.params_schema = t1.params_schema AND t2.min_role = t1.min_role AS same
        FROM evidence.snapshot_template t2 JOIN evidence.snapshot_template t1 ON t1.id = t2.id AND t1.version = 1
       WHERE t2.id = 'intel.investigation_cost_estimate' ORDER BY t2.version DESC LIMIT 1`)).rows[0];
    expect(r).toEqual({ v: 2, same: true });
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("N1 — investigations NOTIFY munim_inbox, ids only", () => {
  test("insert (munim_core) and update (munim_svc) → one '<tenant>:<id>' each; an explicit identical notify adds none; a rollback none", async () => {
    const c = await db.connect("munim_core");
    const got: string[] = [];
    c.on("notification", (n) => {
      if (n.channel === "munim_inbox") got.push(n.payload ?? "");
    });
    await c.query("LISTEN munim_inbox");
    try {
      const id = u();
      const payload = `${W.tenant}:${id}`;
      await db.withContext("munim_core", ownerCtx(W), (q) =>
        q.query(`INSERT INTO core.investigation (tenant_id, id, playbook_id, outlet_scope, created_by) VALUES ($1, $2, 'margin_fall', '{*}', $3)`, [W.tenant, id, W.owner]));
      await db.withContext("munim_svc", svc(), (q) => q.query(`UPDATE core.investigation SET status = 'waiting' WHERE id = $1`, [id]));
      await db.withContext("munim_core", ownerCtx(W), async (q: pg.Client) => {
        await q.query(`UPDATE core.investigation SET status = 'open' WHERE id = $1`, [id]);
        await q.query(`SELECT pg_notify('munim_inbox', $1)`, [payload]); // core-api's notifyInbox, same payload
      });
      await expect(db.withContext("munim_core", ownerCtx(W), async (q) => {
        await q.query(`UPDATE core.investigation SET status = 'waiting' WHERE id = $1`, [id]);
        throw new Error("roll back");
      })).rejects.toThrow("roll back");
      await new Promise((r) => setTimeout(r, 300));
      const mine = got.filter((p) => p.endsWith(id));
      console.log(`NOTIFY munim_inbox (investigation): ${mine.length} — ${mine.join(" | ")}`);
      expect(mine).toEqual([payload, payload, payload]);
      expect(got.every((p) => /^[0-9a-f-]{36}:[0-9a-f-]{36}$/.test(p))).toBe(true);
    } finally {
      await c.end();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("G1 — the operator pages spend rows by (at, id)", () => {
  test("SELECT id, at … ORDER BY at DESC, id DESC → the tenant's rows; run_id, model_id, * and core.ai_budget_cap → 42501", async () => {
    // Three spend rows on the world's run at one instant (one transaction): the id breaks the tie.
    const ids = [u(), u(), u()];
    await db.withContext("munim_svc", svc(), async (c) => {
      for (const id of ids) {
        await c.query(`INSERT INTO intel.intel_spend (tenant_id, id, run_id, role, provider, model_id, input_tokens, output_tokens, amount_minor, currency)
                       VALUES ($1, $2, $3, 'narrate', 'gemini', 'gemini-3.5-flash-lite', 1, 1, 5, 'INR')`, [W.tenant, id, W.run]);
      }
    });
    const op: AppContext = { role: "operator", operator_id: W.operator };
    const page = await db.withContext("munim_platform", op, (c) =>
      c.query<{ id: string }>(`SELECT id, at FROM intel.intel_spend WHERE tenant_id = $1 AND id = ANY ($2::uuid[]) ORDER BY at DESC, id DESC LIMIT 2`, [W.tenant, ids]));
    const refused = [
      await attempt(db, "munim_platform", op, `SELECT run_id FROM intel.intel_spend LIMIT 1`),
      await attempt(db, "munim_platform", op, `SELECT model_id FROM intel.intel_spend LIMIT 1`),
      await attempt(db, "munim_platform", op, `SELECT * FROM intel.intel_spend LIMIT 1`),
      await attempt(db, "munim_platform", op, `SELECT monthly_cap_minor FROM core.ai_budget_cap LIMIT 1`),
    ].map((e) => e?.code);
    console.log("G1 page:", page.rows.map((r) => r.id), "refused:", refused);
    expect(page.rows.map((r) => r.id)).toEqual([...ids].sort().reverse().slice(0, 2));
    expect(refused).toEqual(["42501", "42501", "42501", "42501"]);
  });
});
