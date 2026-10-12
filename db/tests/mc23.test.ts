// M-C23 gates (0020; BOARD W3 rows M-C3 + M-C2 + the F11 standing grant). Expected values are typed by hand here or
// come from tests/manifest.ts (hand-kept); none is read from the migration under test. The isolation, tag and
// intel-cannot-write gates over the seven new tables run in isolation.test.ts / grants.test.ts off the manifest
// (+7 tenant tables: +4 M-C3, +2 M-C2, +1 grant). Red-proofs with a non-zero process exit: tests/redproof-0020.sh.
//   M-C3 (4) ai_policy / ai_budget_cap: munim_svc → 42501; the owner's own command → 1 row + 1 audit row; manager → MB001
//   M-C3 (5) turns gapless (MB014), concurrent asks consecutive; the summary cites only answered, untainted turns
//   M-C3 (6) intel.agent_track_record = the hand values on a finance fixture; 0 rows for kitchen
//   M-C2 (3) steps gapless; (4) investigation_current owned by munim_view_owner; (6) auto needs an approved plan;
//   M-C2 (7) the cost estimate on 4 recorded step spends = the hand value; (8) munim_svc UPDATE: the 5 columns only
//   F11      a step under a revoked grant → MB015 (live → accepted); an auto_step run only with a live grant of its actor
//            covering its scope; a narrowed / removed membership refuses; grants are the creator's own, revoked once
//   plus     scope (M7: viewer ⊇ row), pg_index read-back, the privilege matrix (revoke-then-grant), ai_budget_left min().
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { AppContext, TestDb } from "../src/harness.ts";
import { openDb } from "./db.ts";
import { attempt } from "./gates.ts";
import { EXPECTED_COUNTS } from "./manifest.ts";
import { buildWorld, ownerCtx, uuidv7 as u, type World } from "./world.ts";

let db: TestDb;
let A: World;
let B: World;
let manager: string; // scoped to outlets 1 and 2
let staff: string; // the world's staff member, outlet 1

const owner = (extra: AppContext = {}): AppContext => ownerCtx(A, extra);
const svc = (w: World = A): AppContext => ({ tenant_id: w.tenant, outlet_ids: "*" });
const asManager = (outlets: string[], extra: AppContext = {}): AppContext =>
  ({ tenant_id: A.tenant, outlet_ids: outlets, role: "manager", member_id: manager, ...extra });

beforeAll(async () => {
  db = await openDb();
  A = await buildWorld(db);
  B = await buildWorld(db, { country: "AU" });
  staff = A.staff;
  manager = u();
  await db.withContext("munim_core", owner({ command_type: "tenancy.member.invite.v1" }), async (c) => {
    await c.query(`INSERT INTO core.member (tenant_id, id, name, email) VALUES ($1, $2, 'Manager', 'manager@example.test')`, [A.tenant, manager]);
    await c.query(`INSERT INTO core.membership (tenant_id, member_id, role, outlet_ids) VALUES ($1, $2, 'manager', $3)`,
      [A.tenant, manager, [A.outlets[0], A.outlets[1]]]);
  });
});
afterAll(async () => db?.stop());

const NEW_TABLES = ["core.ai_budget_cap", "core.ai_policy", "core.ai_thread", "core.ai_thread_turn", "core.investigation",
  "core.investigation_grant", "core.investigation_step"];

// ---------------------------------------------------------------------------------------------------------------
describe("M-C3 (2) tags", () => {
  test("the seven new core tables: 2 book (ai_policy, ai_budget_cap) and 5 operational", async () => {
    const r = await db.admin<{ t: string; tag: string }>(`
      SELECT 'core.' || c.relname AS t, obj_description(c.oid, 'pg_class') AS tag FROM pg_class c
       WHERE c.oid = ANY ($1::regclass[]) ORDER BY 1`, [NEW_TABLES]);
    const want: Record<string, string> = {
      "core.ai_budget_cap": "munim:book", "core.ai_policy": "munim:book", "core.ai_thread": "munim:operational",
      "core.ai_thread_turn": "munim:operational", "core.investigation": "munim:operational",
      "core.investigation_grant": "munim:operational", "core.investigation_step": "munim:operational",
    };
    console.log("M-C23 tags:", r.rows.map((x) => `${x.t}=${x.tag}`).join(", "));
    expect(Object.fromEntries(r.rows.map((x) => [x.t, x.tag]))).toEqual(want);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("M-C3 (4) AI policy is the owner's own command only", () => {
  const ceiling = (role: string, ceil: string) =>
    [`INSERT INTO core.ai_policy (tenant_id, id, role, mode_ceiling) VALUES ($1, $2, $3, $4)`, [A.tenant, u(), role, ceil]] as [string, unknown[]];

  test("munim_svc → 42501 on ai_policy and ai_budget_cap", async () => {
    const [sql, p] = ceiling("manager", "plan");
    const a = await attempt(db, "munim_svc", svc(), sql, [...p]);
    const b = await attempt(db, "munim_svc", svc(), `UPDATE core.ai_budget_cap SET monthly_cap_minor = 1`);
    console.log("svc writes:", a?.code, b?.code);
    expect([a?.code, b?.code]).toEqual(["42501", "42501"]);
  });

  test("the owner's own ai_policy.ceiling.set.v1 → 1 row + 1 audit row in one transaction; ai_policy.cap.set.v1 update → 1 audit", async () => {
    const id = u();
    await db.withContext("munim_core", owner({ command_type: "ai_policy.ceiling.set.v1" }), async (c) => {
      await c.query(`INSERT INTO core.ai_policy (tenant_id, id, role, mode_ceiling) VALUES ($1, $2, 'manager', 'plan')`, [A.tenant, id]);
      await c.query(`INSERT INTO core.audit_log (tenant_id, actor, action, entity, entity_id, after) VALUES ($1, $2, 'ai_policy.ceiling.set', 'core.ai_policy', $3, '{"mode_ceiling": "plan"}')`,
        [A.tenant, { kind: "member", id: A.owner }, id]);
    });
    const rows = await db.admin(`SELECT p.origin, (SELECT count(*)::int FROM core.audit_log a WHERE a.tenant_id = p.tenant_id AND a.entity_id = p.id::text) AS audits
                                   FROM core.ai_policy p WHERE p.tenant_id = $1 AND p.id = $2`, [A.tenant, id]);
    console.log("owner ceiling:", JSON.stringify(rows.rows));
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0]!.audits).toBe(1);
    expect(rows.rows[0]!.origin).toEqual({ kind: "command", command_type: "ai_policy.ceiling.set.v1", role: "owner", principal_id: A.owner });
    const e = await attempt(db, "munim_core", owner({ command_type: "ai_policy.cap.set.v1" }),
      `UPDATE core.ai_budget_cap SET monthly_cap_minor = 300000 WHERE tenant_id = $1`, [A.tenant]);
    expect(e).toBeNull();
  });

  test("manager → MB001 (own command, both tables, insert and update; even holding '{*}'); staff → MB001; owner without '{*}' → MB001", async () => {
    const [sql, p] = ceiling("staff", "plan");
    const got = [
      // The role rule alone: a manager context holding every outlet (scope is not what refuses it).
      await attempt(db, "munim_core", { ...asManager([]), outlet_ids: "*", command_type: "ai_policy.ceiling.set.v1" }, sql, [...p]),
      await attempt(db, "munim_core", { ...asManager([]), outlet_ids: "*", command_type: "ai_policy.cap.set.v1" },
        `UPDATE core.ai_budget_cap SET monthly_cap_minor = 1 WHERE tenant_id = $1`, [A.tenant]),
      await attempt(db, "munim_core", asManager([A.outlets[0]], { command_type: "ai_policy.ceiling.set.v1" }), sql, [...p]),
      await attempt(db, "munim_core", asManager([A.outlets[0]], { command_type: "ai_policy.ceiling.set.v1" }),
        `UPDATE core.ai_policy SET mode_ceiling = 'auto' WHERE tenant_id = $1`, [A.tenant]),
      await attempt(db, "munim_core", asManager([A.outlets[0]], { command_type: "ai_policy.cap.set.v1" }),
        `UPDATE core.ai_budget_cap SET monthly_cap_minor = 1 WHERE tenant_id = $1`, [A.tenant]),
      await attempt(db, "munim_core", { tenant_id: A.tenant, outlet_ids: [A.outlets[0]], role: "staff", member_id: staff, command_type: "ai_policy.ceiling.set.v1" }, sql, [...p]),
      await attempt(db, "munim_core", owner({ outlet_ids: [A.outlets[0]], command_type: "ai_policy.ceiling.set.v1" }), sql, [...p]),
    ].map((e) => e?.code);
    console.log("non-owner policy writes:", got);
    expect(got).toEqual(["MB001", "MB001", "MB001", "MB001", "MB001", "MB001", "MB001"]);
  });

  test("the cap is in the tenant's base currency (MB003) and one per tenant (23505)", async () => {
    const cur = await attempt(db, "munim_core", ownerCtx(B, { command_type: "ai_policy.cap.set.v1" }),
      `INSERT INTO core.ai_budget_cap (tenant_id, id, monthly_cap_minor, currency) VALUES ($1, $2, 1, 'INR')`, [B.tenant, u()]);
    const dup = await attempt(db, "munim_core", owner({ command_type: "ai_policy.cap.set.v1" }),
      `INSERT INTO core.ai_budget_cap (tenant_id, id, monthly_cap_minor, currency) VALUES ($1, $2, 1, 'INR')`, [A.tenant, u()]);
    expect([cur?.code, dup?.code]).toEqual(["MB003", "23505"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("M-C3 (5) threads: gapless turns, insert-once, an untainted summary", () => {
  const turn = (thread: string, no: number | null, extra = "") =>
    `INSERT INTO core.ai_thread_turn (tenant_id, thread_id, turn_no, id, member_id${extra ? ", " + extra.split("=")[0] : ""})
     VALUES ('${A.tenant}', '${thread}', ${no === null ? "NULL" : no}, '${u()}', '${A.owner}'${extra ? ", " + extra.split("=")[1] : ""})`;

  test("a gap → MB014; the consecutive number → accepted; NULL → the next number", async () => {
    const gap = await attempt(db, "munim_core", owner(), turn(A.thread, 3));
    const ok = await attempt(db, "munim_core", owner(), turn(A.thread, 2));
    await db.withContext("munim_core", owner(), (c) => c.query(turn(A.thread, null)));
    const nos = (await db.admin(`SELECT turn_no FROM core.ai_thread_turn WHERE tenant_id = $1 AND thread_id = $2 ORDER BY 1`, [A.tenant, A.thread])).rows.map((r) => r.turn_no);
    console.log("turns:", gap?.code, ok, nos);
    expect(gap?.code).toBe("MB014");
    expect(ok).toBeNull();
    expect(nos).toEqual([1, 2, 3]);
  });

  test("two concurrent asks (NULL numbers) → two consecutive turns", async () => {
    const t = u();
    await db.withContext("munim_core", owner(), (c) =>
      c.query(`INSERT INTO core.ai_thread (tenant_id, id, created_by, outlet_scope) VALUES ($1, $2, $3, '{*}')`, [A.tenant, t, A.owner]));
    const a = await db.connect("munim_core");
    const b = await db.connect("munim_core");
    try {
      for (const c of [a, b]) {
        await c.query("BEGIN");
        for (const [k, v] of Object.entries({ tenant_id: A.tenant, outlet_ids: "{*}", role: "owner", member_id: A.owner })) {
          await c.query("SELECT set_config($1, $2, true)", [`app.${k}`, v]);
        }
      }
      await a.query(turn(t, null));
      const pending = b.query(turn(t, null)); // waits on the per-thread lock
      await new Promise((r) => setTimeout(r, 200));
      await a.query("COMMIT");
      await pending;
      await b.query("COMMIT");
    } finally {
      await a.end();
      await b.end();
    }
    const nos = (await db.admin(`SELECT turn_no FROM core.ai_thread_turn WHERE tenant_id = $1 AND thread_id = $2 ORDER BY 1`, [A.tenant, t])).rows.map((r) => r.turn_no);
    expect(nos).toEqual([1, 2]);
  });

  test("turns are insert-once: UPDATE (clearing a taint) → 42501 for munim_core and munim_svc", async () => {
    const a = await attempt(db, "munim_core", owner(), `UPDATE core.ai_thread_turn SET tainted = false WHERE tenant_id = $1`, [A.tenant]);
    const b = await attempt(db, "munim_svc", svc(), `UPDATE core.ai_thread_turn SET tainted = false WHERE tenant_id = $1`, [A.tenant]);
    expect([a?.code, b?.code]).toEqual(["42501", "42501"]);
  });

  test("summary: a segment of a tainted turn → 23514; of an unanswered turn → 23514; of an answered untainted turn → accepted", async () => {
    const t = u();
    const answers = [u(), u()];
    await db.withContext("munim_svc", svc(), async (c) => {
      for (const id of answers) {
        await c.query(`INSERT INTO intel.answer (tenant_id, id, run_id, question, asked_by, envelope, abstained) VALUES ($1, $2, $3, 'q', $4, '{"segments": []}', false)`,
          [A.tenant, id, A.run, A.owner]);
      }
    });
    await db.withContext("munim_core", owner(), async (c) => {
      await c.query(`INSERT INTO core.ai_thread (tenant_id, id, specialist, created_by, outlet_scope) VALUES ($1, $2, 'finance', $3, '{*}')`, [A.tenant, t, A.owner]);
      await c.query(turn(t, null, `answer_id, tainted='${answers[0]}', false`));
      await c.query(turn(t, null, `answer_id, tainted='${answers[1]}', true`));
      await c.query(turn(t, null));
    });
    const set = (no: number) => attempt(db, "munim_core", owner(),
      `UPDATE core.ai_thread SET summary = $3 WHERE tenant_id = $1 AND id = $2`, [A.tenant, t, JSON.stringify([{ turn_no: no, refs: [] }])]);
    const got = [(await set(2))?.code, (await set(3))?.code, (await set(1))?.code ?? "ok"];
    console.log("summary refs (tainted, unanswered, clean):", got);
    expect(got).toEqual(["23514", "23514", "ok"]);
    const shape = await attempt(db, "munim_core", owner(), `UPDATE core.ai_thread SET summary = '[{"turn_no": "1"}]' WHERE tenant_id = $1 AND id = $2`, [A.tenant, t]);
    expect(shape?.code).toBe("23514");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("M-C3 (6) intel.agent_track_record", () => {
  test("finance: 3 approved, 2 rejected, 1 stale, 1 abstained → those hand values (proposed 6); kitchen → 0 rows", async () => {
    const W = await buildWorld(db);
    const drafts = Array.from({ length: 6 }, () => u());
    await db.withContext("munim_svc", svc(W), async (c) => {
      for (const d of drafts) {
        await c.query(`INSERT INTO core.draft (tenant_id, id, source, run_id, command_type, command_payload) VALUES ($1, $2, 'intel:finance', $3, 'inventory.reorder_level.set.v1', '{}')`,
          [W.tenant, d, W.run]);
      }
      await c.query(`INSERT INTO intel.trace_event (tenant_id, run_id, seq, id, kind, actor, payload, at) VALUES ($1, $2, 2, $3, 'abstain', 'specialist:finance', '{}', now())`,
        [W.tenant, W.run, u()]);
      // Not a specialist trace: never counted.
      await c.query(`INSERT INTO intel.trace_event (tenant_id, run_id, seq, id, kind, actor, payload, at) VALUES ($1, $2, 3, $3, 'abstain', 'branch:kitchen', '{}', now())`,
        [W.tenant, W.run, u()]);
    });
    await db.withContext("munim_core", ownerCtx(W, { command_type: "drafts.approve.v1" }), async (c) => {
      for (const d of drafts.slice(0, 3)) {
        await c.query(`UPDATE core.draft SET status = 'executing', exec_txid = txid_current() WHERE tenant_id = $1 AND id = $2`, [W.tenant, d]);
        await c.query(`INSERT INTO core.decision (tenant_id, id, draft_id, verdict, final_payload, decided_by) VALUES ($1, $2, $3, 'approved', '{}', $4)`, [W.tenant, u(), d, W.owner]);
        await c.query(`UPDATE core.draft SET status = 'executed' WHERE tenant_id = $1 AND id = $2`, [W.tenant, d]);
      }
      for (const d of drafts.slice(3, 5)) {
        await c.query(`UPDATE core.draft SET status = 'rejected' WHERE tenant_id = $1 AND id = $2`, [W.tenant, d]);
        await c.query(`INSERT INTO core.decision (tenant_id, id, draft_id, verdict, reason, decided_by) VALUES ($1, $2, $3, 'rejected', 'no', $4)`, [W.tenant, u(), d, W.owner]);
      }
      await c.query(`UPDATE core.draft SET status = 'stale' WHERE tenant_id = $1 AND id = $2`, [W.tenant, drafts[5]]);
    });
    const fin = await mint(ownerCtx(W), "intel.agent_track_record", { specialist: "finance" });
    const kit = await mint(ownerCtx(W), "intel.agent_track_record", { specialist: "kitchen" });
    const all = await mint(ownerCtx(W), "intel.agent_track_record", { specialist: null });
    console.log("track record finance:", JSON.stringify(fin), "kitchen rows:", kit.length, "all rows:", all.length);
    expect(fin).toEqual([{ specialist: "finance", proposed: "6", approved: "3", edited: "0", rejected: "2", stale: "1", abstained: "1" }]);
    expect(kit).toEqual([]);
    // The world's own two drafts are 'intel:inventory_purchasing' (0022 F8 CHECK): both proposed, the second rejected
    // (world.ts step 4), none approved, edited or stale, no abstain traces.
    expect(all).toEqual([...fin, { specialist: "inventory_purchasing", proposed: "2", approved: "0", edited: "0", rejected: "1", stale: "0", abstained: "0" }]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("M-C2 investigations", () => {
  async function newInvestigation(ctx: AppContext, scope: string[] | "*", extra: { mode?: string; approved?: boolean; checklist?: unknown[] } = {}) {
    const id = u();
    await db.withContext("munim_core", ctx, (c) =>
      c.query(`INSERT INTO core.investigation (tenant_id, id, playbook_id, outlet_scope, created_by, mode, checklist, plan_approved_by)
               VALUES ($1, $2, 'margin_fall', $3, $4, $5, $6, $7)`,
        [A.tenant, id, scope === "*" ? ["*"] : scope, ctx.member_id, extra.mode ?? "step", JSON.stringify(extra.checklist ?? []),
         extra.approved ? ctx.member_id : null]));
    return id;
  }
  const step = (inv: string, no: number | null, by = "member", member = A.owner, grant: string | null = null) =>
    [`INSERT INTO core.investigation_step (tenant_id, investigation_id, step_no, member_id, triggered_by, grant_id) VALUES ($1, $2, $3, $4, $5, $6)`,
      [A.tenant, inv, no, member, by, grant]] as [string, unknown[]];

  test("(3) a step gap → MB014; consecutive → accepted", async () => {
    const inv = await newInvestigation(owner(), "*");
    const s1 = await attempt(db, "munim_core", owner(), ...step(inv, 1));
    const gap = await attempt(db, "munim_core", owner(), ...step(inv, 3));
    const s2 = await attempt(db, "munim_core", owner(), ...step(inv, 2));
    const again = await attempt(db, "munim_core", owner(), ...step(inv, 2)); // a second :continue racing the first
    console.log("steps:", s1, gap?.code, s2, again?.code);
    expect([s1, gap?.code, s2, again?.code]).toEqual([null, "MB014", null, "MB014"]);
  });

  test("(4) intel_ro.investigation_current is owned by munim_view_owner, shows the set tenant's rows, no numeric column", async () => {
    const r = await db.admin(`SELECT pg_get_userbyid(c.relowner) AS owner FROM pg_class c WHERE c.oid = 'intel_ro.investigation_current'::regclass`);
    const seen = await db.withContext("munim_intel_ro", svc(), (c) => c.query(`SELECT count(*)::int n FROM intel_ro.investigation_current`));
    const want = await db.admin(`SELECT count(*)::int n FROM core.investigation WHERE tenant_id = $1`, [A.tenant]);
    const numeric = await db.admin(`SELECT count(*)::int n FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
                                     WHERE a.attrelid = 'intel_ro.investigation_current'::regclass AND a.attnum > 0 AND t.typcategory = 'N'`);
    console.log("investigation_current:", r.rows[0]!.owner, seen.rows[0]!.n, "of", want.rows[0]!.n, "numeric cols", numeric.rows[0]!.n);
    expect(r.rows[0]!.owner).toBe("munim_view_owner");
    expect(want.rows[0]!.n).toBeGreaterThanOrEqual(1);
    expect(seen.rows[0]!.n).toBe(want.rows[0]!.n);
    expect(numeric.rows[0]!.n).toBe(0);
  });

  test("(6) mode auto with plan_approved_by NULL → 23514; with it set (the signed-in member) → accepted; set by someone else → MB015", async () => {
    const bad = await attempt(db, "munim_core", owner(),
      `INSERT INTO core.investigation (tenant_id, id, playbook_id, outlet_scope, created_by, mode) VALUES ($1, $2, 'margin_fall', '{*}', $3, 'auto')`, [A.tenant, u(), A.owner]);
    const ok = await attempt(db, "munim_core", owner(),
      `INSERT INTO core.investigation (tenant_id, id, playbook_id, outlet_scope, created_by, mode, plan_approved_by) VALUES ($1, $2, 'margin_fall', '{*}', $3, 'auto', $3)`, [A.tenant, u(), A.owner]);
    const other = await attempt(db, "munim_core", owner(),
      `INSERT INTO core.investigation (tenant_id, id, playbook_id, outlet_scope, created_by, mode, plan_approved_by) VALUES ($1, $2, 'margin_fall', '{*}', $3, 'auto', $4)`, [A.tenant, u(), A.owner, manager]);
    console.log("auto needs plan:", bad?.code, ok, other?.code);
    expect([bad?.code, ok, other?.code]).toEqual(["23514", null, "MB015"]);
  });

  test("(7) cost estimate on 4 recorded step spends = the hand value (112 per step × 5 remaining = 560, 'estimate (computed)')", async () => {
    const W = await buildWorld(db);
    const items = Array.from({ length: 7 }, (_, k) => ({ item_id: `h${k}`, status: k < 2 ? "supported" : "pending", frozen: k < 2, snapshot_ids: [] }));
    const inv = u();
    await db.withContext("munim_core", ownerCtx(W), (c) =>
      c.query(`INSERT INTO core.investigation (tenant_id, id, playbook_id, outlet_scope, created_by, checklist) VALUES ($1, $2, 'margin_fall', '{*}', $3, $4)`,
        [W.tenant, inv, W.owner, JSON.stringify(items)]));
    // Spend per step: 120, 95, 130, and 60 + 41 (two calls in one run) — Σ 446 over 4 steps = 111.5 → 112.
    const spends = [[120], [95], [130], [60, 41]];
    const runs = spends.map(() => u());
    await db.withContext("munim_svc", svc(W), async (c) => {
      for (const [k, r] of runs.entries()) {
        await c.query(`INSERT INTO intel.run (tenant_id, id, trigger, actor, outlet_scope, expires_at) VALUES ($1, $2, 'ask', $3, '{*}', now() + interval '1 hour')`, [W.tenant, r, W.owner]);
        for (const amount of spends[k]!) {
          await c.query(`INSERT INTO intel.intel_spend (tenant_id, id, run_id, role, provider, model_id, input_tokens, output_tokens, amount_minor, currency)
                         VALUES ($1, $2, $3, 'narrate', 'gemini', 'gemini-3.5-flash-lite', 1000, 100, $4, 'INR')`, [W.tenant, u(), r, amount]);
        }
      }
    });
    await db.withContext("munim_core", ownerCtx(W), async (c) => {
      for (const [k, r] of runs.entries()) {
        await c.query(`INSERT INTO core.investigation_step (tenant_id, investigation_id, step_no, member_id, triggered_by, run_id) VALUES ($1, $2, $3, $4, 'member', $5)`,
          [W.tenant, inv, k + 1, W.owner, r]);
      }
    });
    const rows = await mint(ownerCtx(W), "intel.investigation_cost_estimate", { investigation_id: inv });
    console.log("cost estimate:", JSON.stringify(rows));
    expect(rows).toEqual([{ currency: "INR", per_step_minor: "112", steps_in_history: "4", remaining_items: "5", estimate_minor: "560", label: "estimate (computed)" }]);
  });

  test("(8) munim_svc UPDATE of status, checklist, steps_done, stop_reason, updated_at → accepted; created_by, outlet_scope, mode → 42501; INSERT → 42501", async () => {
    const inv = await newInvestigation(owner(), "*");
    const ok = await attempt(db, "munim_svc", svc(),
      `UPDATE core.investigation SET status = 'waiting', checklist = '[]', steps_done = 0, stop_reason = 'waiting', updated_at = now() WHERE tenant_id = $1 AND id = $2`, [A.tenant, inv]);
    const n = await db.admin(`SELECT status, stop_reason FROM core.investigation WHERE tenant_id = $1 AND id = $2`, [A.tenant, inv]);
    const refused = [
      await attempt(db, "munim_svc", svc(), `UPDATE core.investigation SET created_by = created_by WHERE tenant_id = $1`, [A.tenant]),
      await attempt(db, "munim_svc", svc(), `UPDATE core.investigation SET outlet_scope = outlet_scope WHERE tenant_id = $1`, [A.tenant]),
      await attempt(db, "munim_svc", svc(), `UPDATE core.investigation SET mode = mode WHERE tenant_id = $1`, [A.tenant]),
      await attempt(db, "munim_svc", svc(), `INSERT INTO core.investigation (tenant_id, id, playbook_id, outlet_scope, created_by) VALUES ($1, $2, 'x', '{*}', $3)`, [A.tenant, u(), A.owner]),
    ].map((e) => e?.code);
    console.log("svc investigation:", ok, n.rows[0], refused);
    expect(ok).toBeNull();
    expect(n.rows[0]).toEqual({ status: "waiting", stop_reason: "waiting" });
    expect(refused).toEqual(["42501", "42501", "42501", "42501"]);
  });

  test("a terminal investigation takes no step (MB004) and never changes status (MB004); a step past max_steps → MB004", async () => {
    const inv = await newInvestigation(owner(), "*");
    await db.withContext("munim_core", owner(), (c) => c.query(`UPDATE core.investigation SET status = 'cancelled' WHERE tenant_id = $1 AND id = $2`, [A.tenant, inv]));
    const s = await attempt(db, "munim_core", owner(), ...step(inv, 1));
    const back = await attempt(db, "munim_core", owner(), `UPDATE core.investigation SET status = 'open' WHERE tenant_id = $1 AND id = $2`, [A.tenant, inv]);
    const small = u();
    await db.withContext("munim_core", owner(), (c) =>
      c.query(`INSERT INTO core.investigation (tenant_id, id, playbook_id, outlet_scope, created_by, max_steps) VALUES ($1, $2, 'margin_fall', '{*}', $3, 1)`, [A.tenant, small, A.owner]));
    const one = await attempt(db, "munim_core", owner(), ...step(small, 1));
    const two = await attempt(db, "munim_core", owner(), ...step(small, 2));
    expect([s?.code, back?.code, one, two?.code]).toEqual(["MB004", "MB004", null, "MB004"]);
  });

  test("who triggers: a member step by munim_svc → MB015; a member step for another member → MB015; a plan step by the approver → accepted", async () => {
    const inv = await newInvestigation(owner(), "*", { mode: "plan", approved: true });
    const bySvc = await attempt(db, "munim_svc", svc({ ...A }), ...step(inv, 1));
    const other = await attempt(db, "munim_core", owner(), ...step(inv, 1, "member", manager));
    const plan = await attempt(db, "munim_core", owner(), ...step(inv, 1, "plan"));
    expect([bySvc?.code, other?.code, plan]).toEqual(["MB015", "MB015", null]);
  });

  test("M7: an outlet-1 manager sees outlet-1 investigations and threads, not outlet-2 or '{*}' ones, and their steps likewise", async () => {
    const mine = await newInvestigation(asManager([A.outlets[0], A.outlets[1]]), [A.outlets[0]]);
    const theirs = await newInvestigation(asManager([A.outlets[0], A.outlets[1]]), [A.outlets[1]]);
    for (const inv of [mine, theirs]) {
      await db.withContext("munim_core", asManager([A.outlets[0], A.outlets[1]]), (c) =>
        c.query(`INSERT INTO core.investigation_step (tenant_id, investigation_id, step_no, member_id, triggered_by) VALUES ($1, $2, 1, $3, 'member')`, [A.tenant, inv, manager]));
    }
    const seen = await db.withContext("munim_core", asManager([A.outlets[0]]), async (c) => ({
      inv: (await c.query(`SELECT id FROM core.investigation ORDER BY id`)).rows.map((r) => r.id),
      steps: (await c.query(`SELECT investigation_id FROM core.investigation_step ORDER BY 1`)).rows.map((r) => r.investigation_id),
      threads: (await c.query(`SELECT count(*)::int n FROM core.ai_thread`)).rows[0]!.n,
      grants: (await c.query(`SELECT count(*)::int n FROM core.investigation_grant`)).rows[0]!.n,
    }));
    console.log("M7 scope as outlet-1 manager:", JSON.stringify(seen));
    expect(seen).toEqual({ inv: [mine], steps: [mine], threads: 0, grants: 0 }); // the world's thread, investigation and grant are '{*}'
    const wide = await attempt(db, "munim_core", asManager([A.outlets[0]]),
      `INSERT INTO core.investigation (tenant_id, id, playbook_id, outlet_scope, created_by) VALUES ($1, $2, 'margin_fall', '{*}', $3)`, [A.tenant, u(), manager]);
    expect(wide?.code).toBe("42501");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("F11 the standing grant behind Auto", () => {
  let inv: string;
  let grant: string;
  const both = [() => A.outlets[0], () => A.outlets[1]];
  const mctx = () => asManager(both.map((f) => f()));
  const autoStep = (g: string, member = manager) =>
    [`INSERT INTO core.investigation_step (tenant_id, investigation_id, step_no, member_id, triggered_by, grant_id) VALUES ($1, $2, NULL, $3, 'auto', $4)`,
      [A.tenant, inv, member, g]] as [string, unknown[]];
  const autoRun = (g: string | null, scope: string[], actor = manager, trig = "auto_step") =>
    [`INSERT INTO intel.run (tenant_id, id, trigger, actor, outlet_scope, expires_at, grant_id) VALUES ($1, $2, $3, $4, $5, now() + interval '1 hour', $6)`,
      [A.tenant, u(), trig, actor, scope, g]] as [string, unknown[]];
  const setMembership = (outlets: string[], active = true) =>
    db.withContext("munim_core", owner({ command_type: "tenancy.member.role.set.v1" }), (c) =>
      c.query(`UPDATE core.membership SET outlet_ids = $3, active = $4 WHERE tenant_id = $1 AND member_id = $2`, [A.tenant, manager, outlets, active]));

  beforeAll(async () => {
    inv = u();
    grant = u();
    await db.withContext("munim_core", mctx(), async (c) => {
      await c.query(`INSERT INTO core.investigation (tenant_id, id, playbook_id, outlet_scope, created_by) VALUES ($1, $2, 'margin_fall', $3, $4)`,
        [A.tenant, inv, [A.outlets[0]], manager]);
      // Choosing Auto at plan approval: mode, approval and the grant in one request.
      await c.query(`UPDATE core.investigation SET mode = 'auto', plan_approved_by = $3 WHERE tenant_id = $1 AND id = $2`, [A.tenant, inv, manager]);
      await c.query(`INSERT INTO core.investigation_grant (tenant_id, id, investigation_id, member_id, outlet_scope) VALUES ($1, $2, $3, $4, $5)`,
        [A.tenant, grant, inv, manager, [A.outlets[0]]]);
    });
  });

  test("a grant is the creator's own, for exactly the investigation's scope: forged member / other scope / second live grant → refused", async () => {
    const got = [
      await attempt(db, "munim_core", owner(), `INSERT INTO core.investigation_grant (tenant_id, id, investigation_id, member_id, outlet_scope) VALUES ($1, $2, $3, $4, $5)`,
        [A.tenant, u(), inv, manager, [A.outlets[0]]]), // the owner signed in, naming the manager
      await attempt(db, "munim_core", mctx(), `INSERT INTO core.investigation_grant (tenant_id, id, investigation_id, member_id, outlet_scope) VALUES ($1, $2, $3, $4, $5)`,
        [A.tenant, u(), inv, manager, [A.outlets[0], A.outlets[1]]]), // wider than the investigation
      await attempt(db, "munim_core", mctx(), `INSERT INTO core.investigation_grant (tenant_id, id, investigation_id, member_id, outlet_scope) VALUES ($1, $2, $3, $4, $5)`,
        [A.tenant, u(), inv, manager, [A.outlets[0]]]), // a second live grant
      await attempt(db, "munim_svc", svc(), `INSERT INTO core.investigation_grant (tenant_id, id, investigation_id, member_id, outlet_scope) VALUES ($1, $2, $3, $4, $5)`,
        [A.tenant, u(), inv, manager, [A.outlets[0]]]),
    ].map((e) => e?.code);
    console.log("forged grants:", got);
    expect(got).toEqual(["MB015", "MB015", "23505", "42501"]);
  });

  test("an auto step under the live grant (core-worker, munim_svc) → accepted; by munim_core → MB015; for another member → MB015", async () => {
    const ok = await attempt(db, "munim_svc", svc(), ...autoStep(grant));
    const core = await attempt(db, "munim_core", mctx(), ...autoStep(grant));
    const other = await attempt(db, "munim_svc", svc(), ...autoStep(grant, A.owner));
    expect([ok, core?.code, other?.code]).toEqual([null, "MB015", "MB015"]);
  });

  test("an auto_step run: live grant, actor = grantor, scope inside → accepted; outside / '{*}' / other actor / no grant / ask+grant → refused", async () => {
    const got = [
      await attempt(db, "munim_svc", svc(), ...autoRun(grant, [A.outlets[0]])),
      await attempt(db, "munim_svc", svc(), ...autoRun(grant, [A.outlets[1]])),
      await attempt(db, "munim_svc", svc(), ...autoRun(grant, ["*"])),
      await attempt(db, "munim_svc", svc(), ...autoRun(grant, [A.outlets[0]], A.owner)),
      await attempt(db, "munim_svc", svc(), ...autoRun(null, [A.outlets[0]])),
      await attempt(db, "munim_svc", svc(), ...autoRun(grant, [A.outlets[0]], manager, "ask")),
    ].map((e) => e?.code ?? "ok");
    console.log("auto_step runs:", got);
    // No grant: the BEFORE trigger refuses before the CHECK; a grant on an 'ask' run: the CHECK.
    expect(got).toEqual(["ok", "MB015", "MB015", "MB015", "MB015", "23514"]);
  });

  test("a step's run: an auto step links only an auto_step run of its grant; a member step never links one (MB015)", async () => {
    const auto = u();
    const ask = u();
    await db.withContext("munim_svc", svc(), async (c) => {
      await c.query(autoRun(grant, [A.outlets[0]])[0], [A.tenant, auto, "auto_step", manager, [A.outlets[0]], grant]);
      await c.query(autoRun(null, [A.outlets[0]], manager, "ask")[0], [A.tenant, ask, "ask", manager, [A.outlets[0]], null]);
    });
    const autoNo = (await db.admin(`SELECT max(step_no) n FROM core.investigation_step WHERE tenant_id = $1 AND investigation_id = $2 AND triggered_by = 'auto'`, [A.tenant, inv])).rows[0]!.n;
    const link = (run: string, no: number) => attempt(db, "munim_svc", svc(),
      `UPDATE core.investigation_step SET run_id = $3 WHERE tenant_id = $1 AND investigation_id = $2 AND step_no = $4`, [A.tenant, inv, run, no]);
    const wrong = await link(ask, autoNo);
    const right = await link(auto, autoNo);
    const again = await link(ask, autoNo);
    const memberInv = await db.withContext("munim_core", mctx(), async (c) => {
      const id = u();
      await c.query(`INSERT INTO core.investigation (tenant_id, id, playbook_id, outlet_scope, created_by) VALUES ($1, $2, 'margin_fall', $3, $4)`, [A.tenant, id, [A.outlets[0]], manager]);
      return id;
    });
    const memberAuto = await attempt(db, "munim_core", mctx(),
      `INSERT INTO core.investigation_step (tenant_id, investigation_id, step_no, member_id, triggered_by, run_id) VALUES ($1, $2, 1, $3, 'member', $4)`, [A.tenant, memberInv, manager, auto]);
    const untaint = await attempt(db, "munim_svc", svc(),
      `UPDATE core.investigation_step SET tainted = true WHERE tenant_id = $1 AND investigation_id = $2 AND step_no = $3`, [A.tenant, inv, autoNo]);
    const clear = await attempt(db, "munim_svc", svc(),
      `UPDATE core.investigation_step SET tainted = false WHERE tenant_id = $1 AND investigation_id = $2 AND step_no = $3`, [A.tenant, inv, autoNo]);
    expect([wrong?.code, right, again?.code, memberAuto?.code, untaint, clear?.code]).toEqual(["MB015", null, "MB004", "MB015", null, "MB004"]);
  });

  test("membership narrowed → auto step and auto_step run refused (MB015); restored → accepted; membership inactive → refused", async () => {
    await setMembership([A.outlets[1]]);
    const narrowed = [(await attempt(db, "munim_svc", svc(), ...autoStep(grant)))?.code, (await attempt(db, "munim_svc", svc(), ...autoRun(grant, [A.outlets[0]])))?.code];
    await setMembership([A.outlets[0], A.outlets[1]]);
    const restored = [await attempt(db, "munim_svc", svc(), ...autoStep(grant)), await attempt(db, "munim_svc", svc(), ...autoRun(grant, [A.outlets[0]]))];
    await setMembership([A.outlets[0], A.outlets[1]], false);
    const removed = [(await attempt(db, "munim_svc", svc(), ...autoStep(grant)))?.code, (await attempt(db, "munim_svc", svc(), ...autoRun(grant, [A.outlets[0]])))?.code];
    await setMembership([A.outlets[0], A.outlets[1]], true);
    console.log("membership:", narrowed, restored, removed);
    expect(narrowed).toEqual(["MB015", "MB015"]);
    expect(restored).toEqual([null, null]);
    expect(removed).toEqual(["MB015", "MB015"]);
  });

  test("a step and a run under a REVOKED grant → MB015; revoked once, by the signed-in member; a new grant → accepted again", async () => {
    const before = await attempt(db, "munim_svc", svc(), ...autoStep(grant));
    await db.withContext("munim_core", mctx(), (c) =>
      c.query(`UPDATE core.investigation_grant SET revoked_at = now(), revoked_by = $3 WHERE tenant_id = $1 AND id = $2`, [A.tenant, grant, manager]));
    const afterStep = await attempt(db, "munim_svc", svc(), ...autoStep(grant));
    const afterRun = await attempt(db, "munim_svc", svc(), ...autoRun(grant, [A.outlets[0]]));
    const twice = await attempt(db, "munim_core", mctx(),
      `UPDATE core.investigation_grant SET revoked_at = now(), revoked_by = $3 WHERE tenant_id = $1 AND id = $2`, [A.tenant, grant, manager]);
    const svcRevoke = await attempt(db, "munim_svc", svc(), `UPDATE core.investigation_grant SET revoked_at = now() WHERE tenant_id = $1`, [A.tenant]);
    const g2 = u();
    await db.withContext("munim_core", mctx(), (c) =>
      c.query(`INSERT INTO core.investigation_grant (tenant_id, id, investigation_id, member_id, outlet_scope) VALUES ($1, $2, $3, $4, $5)`, [A.tenant, g2, inv, manager, [A.outlets[0]]]));
    const oldStill = await attempt(db, "munim_svc", svc(), ...autoStep(grant));
    const fresh = await attempt(db, "munim_svc", svc(), ...autoStep(g2));
    const history = (await db.admin(`SELECT count(*)::int n, count(*) FILTER (WHERE revoked_at IS NULL)::int live FROM core.investigation_grant WHERE tenant_id = $1 AND investigation_id = $2`, [A.tenant, inv])).rows[0];
    console.log("revoked grant:", before, afterStep?.code, afterRun?.code, twice?.code, svcRevoke?.code, oldStill?.code, fresh, history);
    expect([before, afterStep?.code, afterRun?.code, twice?.code, svcRevoke?.code, oldStill?.code, fresh])
      .toEqual([null, "MB015", "MB015", "MB015", "42501", "MB015", null]);
    expect(history).toEqual({ n: 2, live: 1 });
  });

  test("Auto leaving mode auto (plan) or a terminal status → auto steps refused even under a live grant", async () => {
    const live = (await db.admin(`SELECT id FROM core.investigation_grant WHERE tenant_id = $1 AND investigation_id = $2 AND revoked_at IS NULL`, [A.tenant, inv])).rows[0]!.id;
    await db.withContext("munim_core", mctx(), (c) => c.query(`UPDATE core.investigation SET mode = 'plan' WHERE tenant_id = $1 AND id = $2`, [A.tenant, inv]));
    const planMode = await attempt(db, "munim_svc", svc(), ...autoStep(live));
    // Back to auto as a plant: since 0027 (A1) no role re-enters auto outside the plan approval (tests/ceiling-0027.test.ts).
    await db.admin(`BEGIN; SET LOCAL session_replication_role = replica; UPDATE core.investigation SET mode = 'auto' WHERE tenant_id = '${A.tenant}' AND id = '${inv}'; COMMIT;`);
    await db.withContext("munim_svc", svc(), (c) => c.query(`UPDATE core.investigation SET status = 'cancelled' WHERE tenant_id = $1 AND id = $2`, [A.tenant, inv]));
    const cancelled = await attempt(db, "munim_svc", svc(), ...autoRun(live, [A.outlets[0]]));
    expect([planMode?.code, cancelled?.code]).toEqual(["MB015", "MB015"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("intel.ai_budget_left: effective cap = the lower of the owner cap and the operator limit (F11 O-2)", () => {
  test("3 spends of 100 + 250 + 150 (+ the world's 15); cap 400000 < limit 500000 → left 399485; cap 600000 > limit → left 499485", async () => {
    const W = await buildWorld(db); // world: llm_budget 2026-10 limit 500000 + 1 spend of 15; cap 500000
    await db.withContext("munim_svc", svc(W), async (c) => {
      for (const amount of [100, 250, 150]) {
        await c.query(`INSERT INTO intel.intel_spend (tenant_id, id, run_id, role, provider, model_id, input_tokens, output_tokens, amount_minor, currency, at)
                       VALUES ($1, $2, $3, 'narrate', 'gemini', 'gemini-3.5-flash-lite', 1, 1, $4, 'INR', '2026-10-05T10:00:00Z')`, [W.tenant, u(), W.run, amount]);
      }
    });
    const setCap = (cap: number) => db.withContext("munim_core", ownerCtx(W, { command_type: "ai_policy.cap.set.v1" }), (c) =>
      c.query(`UPDATE core.ai_budget_cap SET monthly_cap_minor = $2 WHERE tenant_id = $1`, [W.tenant, cap]));
    await setCap(400000);
    const low = await mint(ownerCtx(W), "intel.ai_budget_left", { month: "2026-10-01" });
    await setCap(600000);
    const high = await mint(ownerCtx(W), "intel.ai_budget_left", { month: "2026-10-01" });
    console.log("budget left:", JSON.stringify(low), JSON.stringify(high));
    expect(low).toEqual([{ month: "2026-10-01", currency: "INR", owner_cap_minor: "400000", operator_limit_minor: "500000",
      effective_cap_minor: "400000", spent_minor: "515", left_minor: "399485" }]);
    expect(high).toEqual([{ month: "2026-10-01", currency: "INR", owner_cap_minor: "600000", operator_limit_minor: "500000",
      effective_cap_minor: "500000", spent_minor: "515", left_minor: "499485" }]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("catalog read-back", () => {
  // Hand list: name → table, columns in order, unique, predicate (gotcha 1: a same-name index on other columns is red).
  const INDEXES: [string, string, string, boolean, string | null][] = [
    ["ai_thread_created_by_fk_idx", "core.ai_thread", "tenant_id,created_by", false, null],
    ["ai_thread_specialist_idx", "core.ai_thread", "tenant_id,specialist,updated_at", false, null],
    ["ai_thread_turn_pkey", "core.ai_thread_turn", "tenant_id,thread_id,turn_no", true, null],
    ["ai_thread_turn_id_unique", "core.ai_thread_turn", "tenant_id,id", true, null],
    ["ai_thread_turn_answer_unique", "core.ai_thread_turn", "tenant_id,answer_id", true, null],
    ["ai_thread_turn_member_id_fk_idx", "core.ai_thread_turn", "tenant_id,member_id", false, null],
    ["ai_policy_one_per_role", "core.ai_policy", "tenant_id,role", true, null],
    ["ai_budget_cap_one_per_tenant", "core.ai_budget_cap", "tenant_id", true, null],
    ["investigation_created_by_fk_idx", "core.investigation", "tenant_id,created_by", false, null],
    ["investigation_plan_approved_by_fk_idx", "core.investigation", "tenant_id,plan_approved_by", false, null],
    ["investigation_open_auto_idx", "core.investigation", "tenant_id,mode,status", false, "(status = ANY (ARRAY['open'::text, 'waiting'::text]))"],
    ["investigation_grant_investigation_id_fk_idx", "core.investigation_grant", "tenant_id,investigation_id", false, null],
    ["investigation_grant_one_live", "core.investigation_grant", "tenant_id,investigation_id", true, "(revoked_at IS NULL)"],
    ["investigation_grant_member_id_fk_idx", "core.investigation_grant", "tenant_id,member_id", false, null],
    ["investigation_grant_revoked_by_fk_idx", "core.investigation_grant", "tenant_id,revoked_by", false, null],
    ["investigation_step_pkey", "core.investigation_step", "tenant_id,investigation_id,step_no", true, null],
    ["investigation_step_member_id_fk_idx", "core.investigation_step", "tenant_id,member_id", false, null],
    ["investigation_step_grant_id_fk_idx", "core.investigation_step", "tenant_id,grant_id", false, null],
    ["investigation_step_run_id_fk_idx", "core.investigation_step", "tenant_id,run_id", false, null],
    ["investigation_step_summary_answer_id_fk_idx", "core.investigation_step", "tenant_id,summary_answer_id", false, null],
    ["run_grant_id_fk_idx", "intel.run", "tenant_id,grant_id", false, null],
  ];

  test(`pg_index: the ${INDEXES.length} new indexes exist with exactly their columns, uniqueness and predicate`, async () => {
    const r = await db.admin<{ name: string; tbl: string; cols: string; uniq: boolean; pred: string | null }>(`
      SELECT ic.relname AS name, i.indrelid::regclass::text AS tbl, i.indisunique AS uniq, pg_get_expr(i.indpred, i.indrelid) AS pred,
             (SELECT string_agg(a.attname, ',' ORDER BY k.n) FROM unnest(i.indkey) WITH ORDINALITY k(attnum, n)
                JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum) AS cols
        FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid WHERE ic.relname = ANY ($1)`, [INDEXES.map((x) => x[0])]);
    const byName = (a: unknown[], b: unknown[]) => (String(a[0]) < String(b[0]) ? -1 : 1);
    const got = r.rows.map((x) => [x.name, x.tbl, x.cols, x.uniq, x.pred]).sort(byName);
    console.log(`pg_index: ${got.length}/${INDEXES.length} new indexes found`);
    expect(got).toEqual([...INDEXES].sort(byName));
  });

  test("foreign keys in our schemas = the hand count EXPECTED_COUNTS.fk (from the migration text, not the catalog)", async () => {
    const r = await db.admin<{ n: number }>(`SELECT count(*)::int n FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace s ON s.oid = t.relnamespace WHERE c.contype = 'f' AND s.nspname IN ('core', 'evidence', 'intel', 'platform')`);
    console.log(`foreign keys: ${r.rows[0]!.n} (hand count ${EXPECTED_COUNTS.fk})`);
    expect(r.rows[0]!.n).toBe(EXPECTED_COUNTS.fk);
  });

  // Hand matrix (revoke-then-grant): role → privileges per new table. PUBLIC holds nothing.
  const MATRIX: Record<string, Record<string, string>> = {
    "core.ai_thread": { munim_core: "SELECT,INSERT,UPDATE(summary,updated_at)", munim_svc: "SELECT" },
    "core.ai_thread_turn": { munim_core: "SELECT,INSERT", munim_svc: "SELECT" },
    "core.ai_policy": { munim_core: "SELECT,INSERT,UPDATE(mode_ceiling,updated_at)", munim_svc: "SELECT" },
    "core.ai_budget_cap": { munim_core: "SELECT,INSERT,UPDATE(monthly_cap_minor,updated_at)", munim_svc: "SELECT" },
    "core.investigation": {
      munim_core: "SELECT,INSERT,UPDATE(checklist,mode,plan_approved_at,plan_approved_by,status,steps_done,stop_reason,updated_at)",
      munim_svc: "SELECT,UPDATE(checklist,status,steps_done,stop_reason,updated_at)",
      munim_view_owner: "SELECT(checklist,id,mode,outlet_scope,params,playbook_id,status,stop_reason,tenant_id,updated_at)",
    },
    "core.investigation_grant": { munim_core: "SELECT,INSERT,UPDATE(revoked_at,revoked_by)", munim_svc: "SELECT" },
    "core.investigation_step": { munim_core: "SELECT,INSERT,UPDATE(run_id,summary_answer_id,tainted)", munim_svc: "SELECT,INSERT,UPDATE(run_id,summary_answer_id,tainted)" },
  };
  async function matrix(x: TestDb): Promise<Record<string, Record<string, string>>> {
    const r = await x.admin<{ t: string; who: string; priv: string; cols: string | null }>(`
      WITH t AS (SELECT unnest($1::text[])::regclass AS oid),
      tab AS (SELECT t.oid::text AS t, CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS who, a.privilege_type AS priv, NULL::text AS col
                FROM t JOIN pg_class c ON c.oid = t.oid, aclexplode(c.relacl) a WHERE a.grantee <> c.relowner),
      col AS (SELECT t.oid::text, CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END, x.privilege_type, a.attname::text
                FROM t JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum > 0, aclexplode(a.attacl) x)
      SELECT t, who, priv, string_agg(col, ',' ORDER BY col) AS cols FROM (SELECT * FROM tab UNION ALL SELECT * FROM col) u
       GROUP BY t, who, priv ORDER BY t, who, CASE priv WHEN 'SELECT' THEN 1 WHEN 'INSERT' THEN 2 WHEN 'UPDATE' THEN 3 ELSE 4 END`, [Object.keys(MATRIX)]);
    const out: Record<string, Record<string, string>> = {};
    for (const x2 of r.rows) {
      const cell = (out[x2.t] ??= {});
      const p = x2.cols ? `${x2.priv}(${x2.cols})` : x2.priv;
      cell[x2.who] = cell[x2.who] ? `${cell[x2.who]},${p}` : p;
    }
    return out;
  }

  test("privileges on the seven tables = the hand matrix (no PUBLIC, no DELETE/TRUNCATE, UPDATE column-pinned)", async () => {
    const got = await matrix(db);
    console.log("privilege matrix:", JSON.stringify(got));
    expect(got).toEqual(MATRIX);
  });
});

// ---------------------------------------------------------------------------------------------------------------
/** Named params (`:name`) → `$n` as core-api's bindNamedParams (same rules as tests/templates.test.ts). */
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

/** Runs a stored template as core-api's runTemplate does (`… FROM (<sql>) t`, each cell as its text) as munim_core. */
async function mint(ctx: AppContext, id: string, params: Record<string, unknown>): Promise<Record<string, string | null>[]> {
  const t = (await db.admin<{ sql: string }>("SELECT sql FROM evidence.snapshot_template WHERE id = $1 AND version = 1", [id])).rows[0];
  if (!t) throw new Error(`no template ${id}`);
  const { sql, names } = bind(t.sql);
  for (const n of names) if (!(n in params)) throw new Error(`${id}: param ${n} not supplied`);
  return db.withContext("munim_core", ctx, async (c: pg.Client) =>
    (await c.query<{ r: Record<string, string | null> }>(
      `SELECT (SELECT jsonb_object_agg(e.key, e.value #>> '{}') FROM jsonb_each(to_jsonb(t)) e) AS r FROM (${sql}) t LIMIT 500`,
      names.map((n) => params[n]))).rows.map((x) => x.r));
}
