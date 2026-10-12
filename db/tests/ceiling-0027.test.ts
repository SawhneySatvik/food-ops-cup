// 0027 gates (T-098, ledger R45 F10: a lowered ceiling downgrades a running Auto investigation to Plan; migrator lane fx-98).
// Expected values are typed by hand here; none is read from the migration under test. Every refusal is paired with an accept.
//   C1   stop_reason 'ceiling' accepted; a value outside the list → 23514
//   C2   munim_svc `SET stop_reason = 'ceiling'` on an auto row → accepted, mode reads back `plan` (approval kept); on a plan or
//        step row the mode is left alone
//   priv munim_svc writes no mode itself: auto → plan, plan → auto, step → auto, auto → step → 42501 each, rows unchanged;
//        the privilege sets of munim_core and munim_svc on core.investigation are 0020's, exactly
//   G    after the downgrade the standing grant (still revoked_at NULL) authorises nothing: auto step and auto_step run →
//        MB015 (both accepted on a live Auto row); the creator's own member step → accepted
//   CHK  stop_reason 'ceiling' never on an auto row: inserting one → 23514; with the CHECK alone a downgraded row could not
//        go back while the reason stands (A1 refuses it first)
//   A1   Auto only in the update that approves the plan: the approval (plan_approved_by NULL → the signed-in member, mode
//        auto) → accepted; an already approved plan → auto, a step row → auto, a downgraded row → auto (its reason kept or
//        cleared) → MB004, each by munim_core, rows unchanged
// Red-proofs: db/tests/redproof-0027.sh (each gate red with a non-zero exit).
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { AppContext, TestDb } from "../src/harness.ts";
import { openDb } from "./db.ts";
import { attempt } from "./gates.ts";
import { buildWorld, ownerCtx, uuidv7 as u, type World } from "./world.ts";

let db: TestDb;
let A: World;
let manager: string; // scoped to outlets 1 and 2

const owner = (extra: AppContext = {}): AppContext => ownerCtx(A, extra);
const svc = (): AppContext => ({ tenant_id: A.tenant, outlet_ids: "*" });
const mctx = (): AppContext => ({ tenant_id: A.tenant, outlet_ids: [A.outlets[0]!, A.outlets[1]!], role: "manager", member_id: manager });

beforeAll(async () => {
  db = await openDb();
  A = await buildWorld(db);
  manager = u();
  await db.withContext("munim_core", owner({ command_type: "tenancy.member.invite.v1" }), async (c) => {
    await c.query(`INSERT INTO core.member (tenant_id, id, name, email) VALUES ($1, $2, 'Manager', 'manager-0027@example.test')`, [A.tenant, manager]);
    await c.query(`INSERT INTO core.membership (tenant_id, member_id, role, outlet_ids) VALUES ($1, $2, 'manager', $3)`,
      [A.tenant, manager, [A.outlets[0], A.outlets[1]]]);
  });
});
afterAll(async () => db?.stop());

/** The manager's investigation on outlet 1 in `mode`; `auto` = approved as Auto with its standing grant (as approveAuto). */
async function investigation(mode: "step" | "plan" | "auto"): Promise<{ id: string; grant: string | null }> {
  const id = u();
  const grant = mode === "auto" ? u() : null;
  await db.withContext("munim_core", mctx(), async (c) => {
    await c.query(`INSERT INTO core.investigation (tenant_id, id, playbook_id, outlet_scope, created_by, mode) VALUES ($1, $2, 'margin_fall', $3, $4, $5)`,
      [A.tenant, id, [A.outlets[0]], manager, mode === "auto" ? "plan" : mode]);
    if (mode === "auto") {
      await c.query(`UPDATE core.investigation SET mode = 'auto', plan_approved_by = $3 WHERE tenant_id = $1 AND id = $2`, [A.tenant, id, manager]);
      await c.query(`INSERT INTO core.investigation_grant (tenant_id, id, investigation_id, member_id, outlet_scope) VALUES ($1, $2, $3, $4, $5)`,
        [A.tenant, grant, id, manager, [A.outlets[0]]]);
    }
  });
  return { id, grant };
}
const row = async (id: string) =>
  (await db.admin<{ mode: string; stop_reason: string | null; plan_approved_by: string | null }>(
    `SELECT mode, stop_reason, plan_approved_by FROM core.investigation WHERE id = $1`, [id])).rows[0]!;
const ceilingStop = (id: string) =>
  attempt(db, "munim_svc", svc(), `UPDATE core.investigation SET stop_reason = 'ceiling' WHERE tenant_id = $1 AND id = $2`, [A.tenant, id]);
const autoStep = (inv: string, grant: string) =>
  [`INSERT INTO core.investigation_step (tenant_id, investigation_id, step_no, member_id, triggered_by, grant_id) VALUES ($1, $2, NULL, $3, 'auto', $4)`,
    [A.tenant, inv, manager, grant]] as [string, unknown[]];
const autoRun = (grant: string) =>
  [`INSERT INTO intel.run (tenant_id, id, trigger, actor, outlet_scope, expires_at, grant_id) VALUES ($1, $2, 'auto_step', $3, $4, now() + interval '1 hour', $5)`,
    [A.tenant, u(), manager, [A.outlets[0]], grant]] as [string, unknown[]];

// ---------------------------------------------------------------------------------------------------------------
describe("C1 stop_reason 'ceiling'", () => {
  test("'ceiling' accepted (munim_core, a plan row); 'lowered' → 23514", async () => {
    const { id } = await investigation("plan");
    const ok = await attempt(db, "munim_core", mctx(), `UPDATE core.investigation SET stop_reason = 'ceiling' WHERE tenant_id = $1 AND id = $2`, [A.tenant, id]);
    const bad = await attempt(db, "munim_core", mctx(), `UPDATE core.investigation SET stop_reason = 'lowered' WHERE tenant_id = $1 AND id = $2`, [A.tenant, id]);
    console.log("stop_reason ceiling / lowered:", ok?.code ?? "ok", bad?.code);
    expect(ok).toBeNull();
    expect(bad?.code).toBe("23514");
    expect(await row(id)).toMatchObject({ mode: "plan", stop_reason: "ceiling" });
  });
});

describe("C2 munim_svc's ceiling stop downgrades Auto to Plan", () => {
  test("auto row: SET stop_reason = 'ceiling' → accepted, mode plan, the plan approval kept; plan and step rows keep their mode", async () => {
    const auto = await investigation("auto");
    const plan = await investigation("plan");
    const step = await investigation("step");
    const got = [await ceilingStop(auto.id), await ceilingStop(plan.id), await ceilingStop(step.id)].map((e) => e?.code ?? "ok");
    const rows = [await row(auto.id), await row(plan.id), await row(step.id)];
    console.log("svc ceiling stops:", got, JSON.stringify(rows));
    expect(got).toEqual(["ok", "ok", "ok"]);
    expect(rows).toEqual([
      { mode: "plan", stop_reason: "ceiling", plan_approved_by: manager },
      { mode: "plan", stop_reason: "ceiling", plan_approved_by: null },
      { mode: "step", stop_reason: "ceiling", plan_approved_by: null },
    ]);
  });
});

describe("munim_svc writes no mode itself", () => {
  test("auto → plan, plan → auto, step → auto, auto → step, each → 42501, rows unchanged; status → accepted (paired)", async () => {
    const auto = await investigation("auto");
    const plan = await investigation("plan");
    const step = await investigation("step");
    const set = (id: string, to: string) =>
      attempt(db, "munim_svc", svc(), `UPDATE core.investigation SET mode = $3 WHERE tenant_id = $1 AND id = $2`, [A.tenant, id, to]);
    const got = [await set(auto.id, "plan"), await set(plan.id, "auto"), await set(step.id, "auto"), await set(auto.id, "step")].map((e) => e?.code);
    const ok = await attempt(db, "munim_svc", svc(), `UPDATE core.investigation SET status = 'waiting' WHERE tenant_id = $1 AND id = $2`, [A.tenant, auto.id]);
    console.log("svc mode writes:", got, "status write:", ok?.code ?? "ok");
    expect(got).toEqual(["42501", "42501", "42501", "42501"]);
    expect(ok).toBeNull();
    expect([(await row(auto.id)).mode, (await row(plan.id)).mode, (await row(step.id)).mode]).toEqual(["auto", "plan", "step"]);
  });

  test("privileges on core.investigation: munim_core and munim_svc exactly as 0020 granted them; no other runtime role writes", async () => {
    const r = await db.admin<{ who: string; priv: string; cols: string | null }>(`
      SELECT who, priv, string_agg(col, ',' ORDER BY col) AS cols FROM (
        SELECT pg_get_userbyid(a.grantee) AS who, a.privilege_type AS priv, NULL::text AS col
          FROM pg_class c, aclexplode(c.relacl) a WHERE c.oid = 'core.investigation'::regclass AND a.grantee <> c.relowner
        UNION ALL
        SELECT pg_get_userbyid(x.grantee), x.privilege_type, at.attname::text
          FROM pg_attribute at, aclexplode(at.attacl) x WHERE at.attrelid = 'core.investigation'::regclass AND at.attnum > 0) u
       WHERE who IN ('munim_core', 'munim_svc', 'munim_intel', 'munim_intel_ro', 'munim_platform') AND priv IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
       GROUP BY who, priv ORDER BY who, priv`);
    const got = r.rows.map((x) => `${x.who}:${x.priv}${x.cols ? `(${x.cols})` : ""}`);
    console.log("investigation write privileges:", got);
    expect(got).toEqual([
      "munim_core:INSERT",
      "munim_core:UPDATE(checklist,mode,plan_approved_at,plan_approved_by,status,steps_done,stop_reason,updated_at)",
      "munim_svc:UPDATE(checklist,status,steps_done,stop_reason,updated_at)",
    ]);
  });
});

describe("G the standing grant after the downgrade", () => {
  test("live Auto: auto step and auto_step run accepted; downgraded: both → MB015, grant revoked_at NULL; the creator's member step → accepted", async () => {
    const live = await investigation("auto");
    const before = [await attempt(db, "munim_svc", svc(), ...autoStep(live.id, live.grant!)), await attempt(db, "munim_svc", svc(), ...autoRun(live.grant!))];
    const down = await investigation("auto");
    expect(await ceilingStop(down.id)).toBeNull();
    const after = [await attempt(db, "munim_svc", svc(), ...autoStep(down.id, down.grant!)), await attempt(db, "munim_svc", svc(), ...autoRun(down.grant!))];
    const grant = (await db.admin<{ revoked_at: Date | null }>(`SELECT revoked_at FROM core.investigation_grant WHERE id = $1`, [down.grant])).rows[0]!;
    const member = await attempt(db, "munim_core", mctx(),
      `INSERT INTO core.investigation_step (tenant_id, investigation_id, step_no, member_id, triggered_by) VALUES ($1, $2, 1, $3, 'member')`, [A.tenant, down.id, manager]);
    console.log("grant before / after downgrade:", before.map((e) => e?.code ?? "ok"), after.map((e) => e?.code), "member step:", member?.code ?? "ok");
    expect(before).toEqual([null, null]);
    expect(after.map((e) => e?.code)).toEqual(["MB015", "MB015"]);
    expect(grant.revoked_at).toBeNull();
    expect(member).toBeNull();
  });
});

describe("CHK stop_reason 'ceiling' is never on an auto row", () => {
  test("an auto row inserted with 'ceiling' → 23514; the same row with another reason → accepted", async () => {
    const ins = (reason: string) => attempt(db, "munim_core", mctx(),
      `INSERT INTO core.investigation (tenant_id, id, playbook_id, outlet_scope, created_by, mode, plan_approved_by, stop_reason) VALUES ($1, $2, 'margin_fall', $3, $4, 'auto', $4, $5)`,
      [A.tenant, u(), [A.outlets[0]], manager, reason]);
    const bad = await ins("ceiling");
    const ok = await ins("waiting");
    console.log("auto insert with ceiling / waiting:", bad?.code, ok?.code ?? "ok");
    expect(bad?.code).toBe("23514");
    expect(ok).toBeNull();
  });
});

describe("A1 Auto is entered only in the update that approves the plan", () => {
  const toAuto = (id: string, extra = "") =>
    attempt(db, "munim_core", mctx(), `UPDATE core.investigation SET mode = 'auto'${extra} WHERE tenant_id = $1 AND id = $2`, [A.tenant, id]);

  test("the approval (plan_approved_by NULL → the signed-in member, mode auto, as approveAuto) → accepted", async () => {
    const { id } = await investigation("plan");
    const ok = await attempt(db, "munim_core", mctx(),
      `UPDATE core.investigation SET plan_approved_by = $3, mode = 'auto', stop_reason = NULL WHERE tenant_id = $1 AND id = $2`, [A.tenant, id, manager]);
    console.log("approval into auto:", ok?.code ?? "ok");
    expect(ok).toBeNull();
    expect(await row(id)).toMatchObject({ mode: "auto", plan_approved_by: manager });
  });

  test("an approved plan → auto, a step row → auto, a downgraded row → auto (reason kept / cleared) → MB004 each, rows unchanged", async () => {
    const approved = await investigation("plan");
    await db.withContext("munim_core", mctx(), (c) =>
      c.query(`UPDATE core.investigation SET plan_approved_by = $3 WHERE tenant_id = $1 AND id = $2`, [A.tenant, approved.id, manager]));
    const step = await investigation("step");
    const down = await investigation("auto");
    expect(await ceilingStop(down.id)).toBeNull();
    const got = [
      await toAuto(approved.id),
      await toAuto(step.id),
      await toAuto(down.id),
      await toAuto(down.id, ", stop_reason = NULL"),
    ].map((e) => e?.code);
    console.log("re-entering auto:", got);
    expect(got).toEqual(["MB004", "MB004", "MB004", "MB004"]);
    expect([(await row(approved.id)).mode, (await row(step.id)).mode, (await row(down.id)).mode]).toEqual(["plan", "step", "plan"]);
    expect((await row(down.id)).stop_reason).toBe("ceiling");
  });
});
