// T-029 gates — goals and tasks through the real app. Goal / task creation is a member's own command (R27) or an
// approved draft (R16); a task may cite a finding; progress is never stored. Expected values are hand-written.
// Synthetic data only.
import { SCHEMAS } from "@munim/contracts/goals";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addTemplate, type Env, snapRef, startEnv, uuidv7 } from "./compliance.kit.ts";

let e: Env;
beforeAll(async () => {
  e = await startEnv("IN");
  await addTemplate(e.db, "test.goal_target", `SELECT 50000000::bigint AS target FROM core.tenant WHERE tenant_id = current_setting('app.tenant_id')::uuid AND :metric::text = :metric::text`,
    [{ name: "metric", type: "text" }, { name: "target", type: "integer", numeric_source: "core.goal.target_value" }]);
});
afterAll(() => e?.stop());

const goal = (over: Record<string, unknown> = {}) => ({
  goal_id: uuidv7(), outlet_id: e.w.outlets[0], metric: "net_sales", target_value: 50000000, period_from: "2026-11-01", due_on: "2026-11-30", basis_snapshot_id: null, ...over,
});
const task = (over: Record<string, unknown> = {}) => ({
  task_id: uuidv7(), outlet_id: e.w.outlets[0], title_key: "goals.task.renew_licence", assignee_member_id: e.w.staff, due_on: "2026-10-20", finding_id: null, ...over,
});

describe("goals", () => {
  it("a manager creates an outlet goal: net_sales takes the business currency, orders takes none", async () => {
    const sales = goal();
    const orders = goal({ metric: "orders", target_value: 1200 });
    expect((await e.cmd("/v1/goals", "mgr1", "goals.goal.create.v1", sales)).status).toBe(200);
    expect((await e.cmd("/v1/goals", "mgr1", "goals.goal.create.v1", orders)).status).toBe(200);
    expect(await e.one(`SELECT metric, target_value::text, currency, created_by FROM core.goal WHERE id = $1`, [sales.goal_id]))
      .toEqual({ metric: "net_sales", target_value: "50000000", currency: "INR", created_by: e.ids.mgr1 });
    expect(await e.one(`SELECT currency FROM core.goal WHERE id = $1`, [orders.goal_id])).toEqual({ currency: null });
    const list = (await (await e.call("GET", `/v1/goals?outlet=${e.w.outlets[0]}&status=active`, "mgr1")).json()).items as Array<{ id: string; target_value: number }>;
    expect(list.filter((g) => g.id === sales.goal_id || g.id === orders.goal_id).map((g) => g.target_value).sort((a, b) => a - b)).toEqual([1200, 50000000]);
  });

  it("refusals: a tenant-wide goal needs a tenant-wide scope; staff cannot set goals; dates must run forward", async () => {
    const wide = goal({ outlet_id: null });
    const m = await e.cmd("/v1/goals", "mgr1", "goals.goal.create.v1", wide);
    expect([m.status, (await m.json()).error.code]).toEqual([403, "book_write_refused"]);
    expect(await e.count(`SELECT count(*) n FROM core.goal WHERE id = $1`, [wide.goal_id])).toBe(0);
    expect((await e.cmd("/v1/goals", "owner", "goals.goal.create.v1", wide)).status).toBe(200);
    const s = await e.cmd("/v1/goals", "staff", "goals.goal.create.v1", goal());
    expect([s.status, (await s.json()).error.code]).toEqual([403, "book_write_refused"]);
    const back = await e.cmd("/v1/goals", "owner", "goals.goal.create.v1", goal({ due_on: "2026-10-01" }));
    expect([back.status, (await back.json()).error.code]).toEqual([422, "invalid_payload"]);
    const zero = await e.cmd("/v1/goals", "owner", "goals.goal.create.v1", goal({ target_value: 0 }));
    expect([zero.status, (await zero.json()).error.code]).toEqual([422, "invalid_payload"]);
  });

  it("an outlet manager does not list another outlet's goals", async () => {
    const other = goal({ outlet_id: e.w.outlets[1] });
    expect((await e.cmd("/v1/goals", "owner", "goals.goal.create.v1", other)).status).toBe(200);
    const ids = ((await (await e.call("GET", "/v1/goals", "mgr1")).json()).items as Array<{ id: string }>).map((g) => g.id);
    expect(ids).not.toContain(other.goal_id);
    const mine = ((await (await e.call("GET", "/v1/goals", "owner")).json()).items as Array<{ id: string }>).map((g) => g.id);
    expect(mine).toContain(other.goal_id);
  });

  it("update: active → achieved once; a closed goal is not reopened (409)", async () => {
    const g = goal();
    await e.cmd("/v1/goals", "mgr1", "goals.goal.create.v1", g);
    expect((await e.cmd("/v1/goals/update", "mgr1", "goals.goal.update.v1", { goal_id: g.goal_id, status: "achieved" })).status).toBe(200);
    const again = await e.cmd("/v1/goals/update", "mgr1", "goals.goal.update.v1", { goal_id: g.goal_id, status: "missed" });
    expect([again.status, (await again.json()).error.code]).toEqual([409, "illegal_transition"]);
    expect(await e.one(`SELECT status FROM core.goal WHERE id = $1`, [g.goal_id])).toEqual({ status: "achieved" });
  });

  it("a goal DRAFT writes nothing until approved; the target is the snapshot cell's, not the payload's", async () => {
    const id = uuidv7();
    const snap = await e.mint("test.goal_target", { metric: "net_sales" }, [e.w.outlets[0]]);
    const ref = snapRef(snap, 0, "target");
    const d = await e.draft("goals.goal.create.v1", { ...goal({ goal_id: id }), target_value: ref }, [ref], [e.w.outlets[0]]);
    expect(await e.count(`SELECT count(*) n FROM core.goal WHERE id = $1`, [id])).toBe(0);
    expect((await e.approve("staff", d, "goals.goal.create.v1")).status).toBe(403);
    expect(await e.count(`SELECT count(*) n FROM core.goal WHERE id = $1`, [id])).toBe(0);
    expect((await e.approve("mgr1", d, "goals.goal.create.v1")).status).toBe(200);
    const row = await e.one<{ target_value: string; origin: { kind: string } }>(`SELECT target_value::text, origin FROM core.goal WHERE id = $1`, [id]);
    expect([row.target_value, row.origin.kind]).toEqual(["50000000", "decision"]);
  });
});

describe("tasks", () => {
  it("a manager assigns a task that cites a finding; an unknown finding or assignee is not_found and writes nothing", async () => {
    const t = task({ finding_id: e.w.finding });
    const r = await e.cmd("/v1/tasks", "mgr1", "goals.task.create.v1", t);
    expect(r.status).toBe(200);
    expect(await e.one(`SELECT finding_id, assignee_member_id, status, created_by FROM core.task WHERE id = $1`, [t.task_id]))
      .toEqual({ finding_id: e.w.finding, assignee_member_id: e.w.staff, status: "open", created_by: e.ids.mgr1 });
    for (const bad of [task({ finding_id: uuidv7() }), task({ assignee_member_id: uuidv7() })]) {
      const x = await e.cmd("/v1/tasks", "mgr1", "goals.task.create.v1", bad);
      expect([x.status, (await x.json()).error.code]).toEqual([404, "not_found"]);
      expect(await e.count(`SELECT count(*) n FROM core.task WHERE id = $1`, [bad.task_id])).toBe(0);
    }
    const s = await e.cmd("/v1/tasks", "staff", "goals.task.create.v1", task());
    expect([s.status, (await s.json()).error.code]).toEqual([403, "book_write_refused"]);
  });

  it("staff completes their own task; not someone else's, and not a reassignment; a manager can reassign; a done task is closed", async () => {
    const mine = task();
    const theirs = task({ assignee_member_id: e.ids.mgr1 });
    await e.cmd("/v1/tasks", "mgr1", "goals.task.create.v1", mine);
    await e.cmd("/v1/tasks", "mgr1", "goals.task.create.v1", theirs);
    const U = "/v1/tasks/update";
    const t = "goals.task.update.v1";
    const nothing = { status: null, assignee_member_id: null, due_on: null };

    const foreign = await e.cmd(U, "staff", t, { task_id: theirs.task_id, ...nothing, status: "done" });
    expect([foreign.status, (await foreign.json()).error.code]).toEqual([403, "forbidden"]);
    const reassign = await e.cmd(U, "staff", t, { task_id: mine.task_id, ...nothing, assignee_member_id: e.ids.mgr1 });
    expect([reassign.status, (await reassign.json()).error.code]).toEqual([403, "forbidden"]);
    const empty = await e.cmd(U, "staff", t, { task_id: mine.task_id, ...nothing });
    expect([empty.status, (await empty.json()).error.code]).toEqual([422, "invalid_payload"]);
    expect(await e.one(`SELECT status, done_by FROM core.task WHERE id = $1`, [theirs.task_id])).toEqual({ status: "open", done_by: null });

    expect((await e.cmd(U, "staff", t, { task_id: mine.task_id, ...nothing, status: "done" })).status).toBe(200);
    expect(await e.one(`SELECT status, done_by, done_at IS NOT NULL AS stamped FROM core.task WHERE id = $1`, [mine.task_id]))
      .toEqual({ status: "done", done_by: e.w.staff, stamped: true });
    const closed = await e.cmd(U, "mgr1", t, { task_id: mine.task_id, ...nothing, due_on: "2026-12-01" });
    expect([closed.status, (await closed.json()).error.code]).toEqual([409, "illegal_transition"]);

    expect((await e.cmd(U, "mgr1", t, { task_id: theirs.task_id, ...nothing, assignee_member_id: e.w.staff, due_on: "2026-10-25" })).status).toBe(200);
    expect(await e.one(`SELECT assignee_member_id, due_on::text FROM core.task WHERE id = $1`, [theirs.task_id])).toEqual({ assignee_member_id: e.w.staff, due_on: "2026-10-25" });

    const open = ((await (await e.call("GET", `/v1/tasks?assignee=${e.w.staff}&status=open`, "mgr1")).json()).items as Array<{ id: string }>).map((x) => x.id);
    expect(open).toContain(theirs.task_id);
    expect(open).not.toContain(mine.task_id);
  });

  it("a task DRAFT (e.g. renew a licence, citing a finding) writes nothing until approved, then is created under the approver", async () => {
    const t = task({ finding_id: e.w.finding });
    const d = await e.draft("goals.task.create.v1", t, [], [e.w.outlets[0]]);
    expect(await e.count(`SELECT count(*) n FROM core.task WHERE id = $1`, [t.task_id])).toBe(0);
    expect((await e.approve("staff", d, "goals.task.create.v1")).status).toBe(403);
    expect(await e.count(`SELECT count(*) n FROM core.task WHERE id = $1`, [t.task_id])).toBe(0);
    expect((await e.approve("mgr1", d, "goals.task.create.v1")).status).toBe(200);
    const row = await e.one<{ finding_id: string; origin: { kind: string; decision_id: string } }>(`SELECT finding_id, origin FROM core.task WHERE id = $1`, [t.task_id]);
    expect([row.finding_id, row.origin.kind]).toEqual([e.w.finding, "decision"]);
    expect((await e.one<{ decided_by: string }>(`SELECT decided_by FROM core.decision WHERE id = $1`, [row.origin.decision_id])).decided_by).toBe(e.ids.mgr1);
  });
});

// B12: the published read schemas (strict) accept what the routes really return.
describe("read shapes parse with the published contracts", () => {
  it("goals and tasks lists", async () => {
    const g = SCHEMAS["v1.goals"].parse(await (await e.call("GET", "/v1/goals", "owner")).json());
    const t = SCHEMAS["v1.tasks"].parse(await (await e.call("GET", "/v1/tasks", "owner")).json());
    expect(g.items.length).toBeGreaterThan(0);
    expect(t.items.length).toBeGreaterThan(0);
    expect(g.items.some((x) => x.metric === "orders" && x.currency === null)).toBe(true);
  });
});

describe("malformed command envelope (R3-M6)", () => {
  it("valid JSON that is not an envelope is 422 invalid_payload; a body that is not JSON is 400 bad_request", async () => {
    const bad = await e.call("POST", "/v1/goals", "owner", { nope: 1 });
    expect(bad.status).toBe(422);
    expect((await bad.json()).error.code).toBe("invalid_payload");
    const none = await e.call("POST", "/v1/goals", "owner");
    expect(none.status).toBe(400);
    expect((await none.json()).error.code).toBe("bad_request");
  });
});
