// T-084b and T-089a core gates: investigation routes (list, :cancel), SSE progress on `inbox:<tenant>`, and Plan mode
// (ledger R45 F10, F11; BOARD b-84 T-084b, b-89 T-089a), through the real app on embedded Postgres (m-1's canonical
// world). intel is mocked at its boundary only (the NarratePort): the fake stores its answer — and, where a gate needs
// it, its spend — through the REAL internal API with the run token core minted.
//   T-084b (2)  :cancel → cancelled, then :continue → 409 (a repeat cancel replays; another member → 403)
//   T-084b (1)  :continue twice concurrently → 1 step: test/investigations.test.ts (k), unchanged
//   list        RLS scope, ?status=, cursor paging, bad input 400
//   SSE         progress reaches `inbox:<tenant>` WHILE the approving request runs; ids and categories only; RLS scope
//   (1)  the margin_fall preview: 7 items, the hand-listed specialists, the cost as a resolving snapshot ref of
//        intel.investigation_cost_estimate = hand value; 0 bare digits; "cannot verify" without history or role
//   (2)  on this world (data incomplete) → stops after 1 step at `waiting` (the RG world half: investigations-plan-world)
//   (3)  the cap reached mid-plan → stop_reason budget, 0 further model calls; no operator budget → 0 steps
//   (4)  membership narrowed mid-plan → cancelled (1), stop_reason scope, 0 further steps
//   (5)  a member whose ceiling is `step` → 403 on :approve-plan; raised again → 200 (paired); create checks the ceiling
//   (6)  a planted kill between steps → steps gapless; :continue resumes at steps_done + 1
//   (7)  0 steps after the approving request returned (every started_at ≤ the DB clock read after the response)
//   abstain, idempotency replay of :approve-plan (sequential and concurrent), clause 1 (no book row changes)
// Multi-step plans: on this world every step ends `waiting` (no bank lines), so where a gate needs a second step the
// fake port plants `status = open` on the investigation during step 1's narration (after its commit) — exactly what a
// reopened item leaves (ADR-014 §7.4). The real multi-step run on the RG world is in investigations-plan-world.test.ts.
// Expected values are hand-written; never read from the code under test. Synthetic data only.
import { serve } from "@hono/node-server";
import { createLogger } from "@munim/config";
import { REPLAYED_HEADER } from "@munim/contracts";
import { InvestigationsListResponse, InvestigationView, NarrateRequest } from "@munim/contracts/investigations";
import { type TestDb, uuidv7 } from "@munim/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalIdp } from "../src/auth/local-idp.ts";
import { createApp, TENANT_HEADER, type Deps } from "../src/app.ts";
import { verifyAuditChain } from "../src/commit/index.ts";
import { svcTx, testKeys } from "../src/commit/testkit.ts";
import { configureInternal } from "../src/internal/index.ts";
import { configureInvestigations, type NarratePort } from "../src/modules/investigations/index.ts";
import { closeStream, configureStream } from "../src/stream/index.ts";
import { openDb } from "./db.ts";
import { buildTenant, type Tenant } from "./world.ts";

const idp = createLocalIdp();
const keys = testKeys();
const SECRET = "t089a-test-service-secret-not-real-0123456789abcdef";
const MONTH = `${new Date().toISOString().slice(0, 7)}-01`; // the current UTC month: the operator budget's basis
let db: TestDb;
let pools: { core: pg.Pool; svc: pg.Pool };
let deps: Deps;
let app: Awaited<ReturnType<typeof createApp>>;

type Res = Omit<Response, "json"> & { json(): Promise<any> };
interface T extends Tenant { staffSub: string; wideSub: string; wide: string; wide2Sub: string; wide2: string }

const count = async (sql: string, params: unknown[] = []) => Number((await db.admin<{ n: string }>(sql, params)).rows[0]!.n);
const call = async (t: T, sub: string, path: string, body?: unknown): Promise<Res> =>
  (await app.request(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${idp.sign({ sub })}`, [TENANT_HEADER]: t.tenant, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })) as Res;
const internal = async (token: string, path: string, body: unknown): Promise<Res> =>
  (await app.request(`/internal/intel/v1/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "x-munim-service-secret": SECRET, "content-type": "application/json" },
    body: JSON.stringify(body),
  })) as Res;

const PARAMS = { period_month: "2026-09-01", compare_month: "2026-08-01" };
const create = (t: T, sub: string, mode?: string, extra: Record<string, unknown> = {}, id = uuidv7()) =>
  call(t, sub, "/v1/investigations", { investigation_id: id, playbook_id: "margin_fall", params: PARAMS, ...(mode ? { mode } : {}), ...extra });
const openPlan = async (t: T, sub: string) => {
  const id = uuidv7();
  const r = await create(t, sub, "plan", {}, id);
  expect(r.status).toBe(201);
  return id;
};
const approve = (t: T, sub: string, id: string) => call(t, sub, `/v1/investigations/${id}:approve-plan`, {});
const step = (t: T, sub: string, id: string, step_no: number) => call(t, sub, `/v1/investigations/${id}:continue`, { step_no });
const cancel = (t: T, sub: string, id: string) => call(t, sub, `/v1/investigations/${id}:cancel`, {});
const stepNos = async (id: string) =>
  (await db.admin<{ step_no: number; triggered_by: string }>(`SELECT step_no, triggered_by FROM core.investigation_step WHERE investigation_id = $1 ORDER BY step_no`, [id])).rows;
const row = async (id: string) =>
  (await db.admin<{ status: string; stop_reason: string | null; steps_done: number; plan_approved_by: string | null }>(
    `SELECT status, stop_reason, steps_done, plan_approved_by FROM core.investigation WHERE id = $1`, [id])).rows[0]!;
const errOf = async (r: Res) => (await r.json()).error as { code: string; reason_code: string | null };
const setBudget = (t: T, limit: number) =>
  db.admin(`INSERT INTO platform.llm_budget (tenant_id, month, limit_minor, currency) VALUES ($1, $2, $3, $4)
            ON CONFLICT (tenant_id, month) DO UPDATE SET limit_minor = EXCLUDED.limit_minor, currency = EXCLUDED.currency`, [t.tenant, MONTH, limit, t.currency]);
const command = (t: T, sub: string, path: string, type: string, payload: unknown) =>
  call(t, sub, path, { command_id: uuidv7(), idempotency_key: `t089a-${uuidv7()}`, type, payload });
const ceiling = (t: T, role: string, mode_ceiling: string) => command(t, t.ownerSub, "/v1/ai/policy/ceiling", "ai_policy.ceiling.set.v1", { role, mode_ceiling });
const plantOpen = (id: string) => db.admin(`UPDATE core.investigation SET status = 'open' WHERE id = $1`, [id]);

/** A fake intel: stores core's own template sentences as its answer (or an abstention), optionally records spend, then
 *  runs `during(n)` — inside the approving request, after step n committed. Counts its calls (= model calls). */
function fakeIntel(t: T, o: { spend?: number; abstain?: boolean; during?: (n: number) => Promise<void> } = {}) {
  const calls: Array<ReturnType<typeof NarrateRequest.parse>> = [];
  const port: NarratePort = async (token, raw) => {
    const req = NarrateRequest.parse(raw);
    calls.push(req);
    const envelope = o.abstain
      ? { answer_id: req.answer_id, segments: [], abstained: true, reason_code: "model_blocked" }
      : { answer_id: req.answer_id, segments: req.items.map((i) => ({ text: i.template, refs: [...new Set(i.cells.map((c) => `snap:${/snap:([^·]+)/.exec(c.ref)![1]}`))] })), abstained: false, reason_code: null };
    const a = await internal(token, "answers", { question: req.question, envelope });
    if (a.status !== 201) throw new Error(`fake intel: answers ${a.status}`);
    if (o.spend !== undefined) {
      const s = await internal(token, "spend", { entries: [{ id: uuidv7(), role: "narrate", provider: "gemini", model_id: "recorded/narrate", input_tokens: 10, output_tokens: 10, amount_minor: o.spend, currency: t.currency }] });
      if (s.status !== 201) throw new Error(`fake intel: spend ${s.status}`);
    }
    await o.during?.(calls.length);
    return { answer_id: req.answer_id, tainted: false, source: "model" };
  };
  configureInvestigations(deps, { keys, narrate: port });
  return calls;
}

async function tenant(label: string, budget: number | null = 1_000_000_000): Promise<T> {
  const w = await buildTenant(db, label);
  const t: T = { ...w, staffSub: `staff-${label}-${uuidv7()}`, wideSub: `wide-${label}-${uuidv7()}`, wide: uuidv7(), wide2Sub: `wide2-${label}-${uuidv7()}`, wide2: uuidv7() };
  await db.withContext("munim_core", { tenant_id: t.tenant, outlet_ids: "*", role: "owner", member_id: t.owner, command_type: "tenancy.member.invite.v1" }, async (c) => {
    await c.query(`UPDATE core.member SET idp_sub = $3 WHERE tenant_id = $1 AND id = $2`, [t.tenant, t.staff, t.staffSub]);
    // Two owners scoped to outlets 1 and 2 (an owner role, so the finance templates mint and each step is narrated — the
    // fake port is the hook between steps): the scope gate narrows the first mid-plan; the second is its paired accept.
    for (const [id, sub] of [[t.wide, t.wideSub], [t.wide2, t.wide2Sub]]) {
      await c.query(`INSERT INTO core.member (tenant_id, id, idp_sub, name, email) VALUES ($1, $2, $3, 'Outlet Owner', $4)`, [t.tenant, id, sub, `${sub}@example.test`]);
      await c.query(`INSERT INTO core.membership (tenant_id, member_id, role, outlet_ids) VALUES ($1, $2, 'owner', $3)`, [t.tenant, id, [t.outlets[0], t.outlets[1]]]);
    }
  });
  if (budget !== null) await setBudget(t, budget);
  else await db.admin(`DELETE FROM platform.llm_budget WHERE tenant_id = $1 AND month = $2`, [t.tenant, MONTH]);
  return t;
}

let A: T;
const servers: Array<ReturnType<typeof serve>> = [];

beforeAll(async () => {
  db = await openDb();
  pools = { core: db.pool("munim_core", 10), svc: db.pool("munim_svc", 6) };
  const config = { nodeEnv: "test", redact: (s: string) => s };
  deps = { pools, idp, storefronts: async () => null, config, log: createLogger(config, () => {}) };
  configureStream(deps, { connect: () => new pg.Client({ host: "127.0.0.1", port: db.port, database: db.database, user: "munim_core", password: db.password }) });
  app = await createApp(deps);
  configureInternal(deps, { serviceSecret: SECRET, keys, watchWindowMs: 0 });
  A = await tenant("a");
});

afterAll(async () => {
  for (const s of servers) s.close();
  if (deps) await closeStream(deps);
  await pools?.core.end();
  await pools?.svc.end();
  await db?.stop();
});

describe("T-084b (2): :cancel", () => {
  it(":continue works, :cancel → cancelled, then :continue → 409; a repeat cancel replays; the steps stay 1", async () => {
    fakeIntel(A);
    const id = uuidv7();
    expect((await create(A, A.ownerSub, undefined, {}, id)).status).toBe(201);
    expect((await step(A, A.ownerSub, id, 1)).status).toBe(200);
    const c = await cancel(A, A.ownerSub, id);
    expect([c.status, c.headers.get(REPLAYED_HEADER), InvestigationView.parse(await c.json()).status]).toEqual([200, null, "cancelled"]);
    const r = await step(A, A.ownerSub, id, 2);
    expect([r.status, (await errOf(r)).code]).toEqual([409, "illegal_transition"]);
    const again = await cancel(A, A.ownerSub, id);
    expect([again.status, again.headers.get(REPLAYED_HEADER)]).toEqual([200, "true"]);
    expect((await stepNos(id)).length).toBe(1);
    expect((await row(id)).status).toBe("cancelled");
  });
  it("only the creator cancels (another member of the same scope → 403, nothing changes); a bad body → 422", async () => {
    const id = uuidv7();
    await create(A, A.ownerSub, undefined, {}, id);
    // A judge would see it; the manager does not (outlet 1 only → 404), so the forbidden case uses a second owner-scope reader.
    expect((await cancel(A, A.managerSub, id)).status).toBe(404);
    const mine = uuidv7();
    await create(A, A.managerSub, undefined, {}, mine);
    const r = await cancel(A, A.ownerSub, mine);
    expect([r.status, (await errOf(r)).code]).toEqual([403, "forbidden"]);
    expect((await row(mine)).status).toBe("open");
    expect((await call(A, A.managerSub, `/v1/investigations/${mine}:cancel`, { reason: "x" })).status).toBe(422);
    expect((await cancel(A, A.managerSub, mine)).status).toBe(200);
  });
});

describe("list", () => {
  it("RLS scope: the owner sees the outlet-1 manager's investigation; the manager does not see the owner's all-outlet one", async () => {
    const own = uuidv7();
    const mgr = uuidv7();
    await create(A, A.ownerSub, undefined, {}, own);
    await create(A, A.managerSub, undefined, {}, mgr);
    const ids = async (sub: string, qs = "") => {
      const r = await call(A, sub, `/v1/investigations${qs}`);
      expect(r.status).toBe(200);
      return InvestigationsListResponse.parse(await r.json()).items.map((i) => i.investigation_id);
    };
    const o = await ids(A.ownerSub, "?limit=100");
    expect([o.includes(own), o.includes(mgr)]).toEqual([true, true]);
    const m = await ids(A.managerSub, "?limit=100");
    expect([m.includes(own), m.includes(mgr)]).toEqual([false, true]);
  });
  it("?status= filters; ?limit=1 pages by cursor without repeats; a bad status, limit or cursor → 400", async () => {
    const all = await call(A, A.ownerSub, "/v1/investigations?limit=100");
    const items = InvestigationsListResponse.parse(await all.json()).items;
    const cancelled = InvestigationsListResponse.parse(await (await call(A, A.ownerSub, "/v1/investigations?status=cancelled&limit=100")).json()).items;
    expect(cancelled.length).toBe(items.filter((i) => i.status === "cancelled").length);
    expect(cancelled.length).toBeGreaterThan(0);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 100; i++) {
      const p = InvestigationsListResponse.parse(await (await call(A, A.ownerSub, `/v1/investigations?limit=1${cursor ? `&cursor=${cursor}` : ""}`)).json());
      seen.push(...p.items.map((x) => x.investigation_id));
      cursor = p.next_cursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(items.map((i) => i.investigation_id));
    for (const qs of ["?status=closed", "?limit=0", "?limit=101", "?cursor=@@"]) expect((await call(A, A.ownerSub, `/v1/investigations${qs}`)).status).toBe(400);
  });
});

describe("T-089a create: the mode is checked against the role's ceiling", () => {
  it("staff (ceiling step): plan → 403 mode_above_ceiling, 0 rows; step → 201 (paired)", async () => {
    const id = uuidv7();
    const r = await create(A, A.staffSub, "plan", {}, id);
    expect([r.status, await errOf(r)]).toEqual([403, expect.objectContaining({ code: "forbidden", reason_code: "mode_above_ceiling" })]);
    expect(await count(`SELECT count(*) n FROM core.investigation WHERE id = $1`, [id])).toBe(0);
    expect((await create(A, A.staffSub, "step")).status).toBe(201);
  });
  it("auto: a manager → 403 (above plan); the owner (ceiling auto) → 201, a plan to approve as Auto (T-089b); plan → 201 with a preview", async () => {
    expect((await create(A, A.managerSub, "auto")).status).toBe(403);
    const id = uuidv7();
    expect((await create(A, A.ownerSub, "auto", {}, id)).status).toBe(201);
    expect(await count(`SELECT count(*) n FROM core.investigation WHERE id = $1 AND mode = 'plan' AND plan_approved_by IS NULL`, [id])).toBe(1);
    const p = await create(A, A.ownerSub, "plan");
    const v = InvestigationView.parse(await p.json());
    expect([p.status, v.mode, v.plan?.approved_by, v.steps_done]).toEqual([201, "plan", null, 0]);
    const s = InvestigationView.parse(await (await create(A, A.ownerSub)).json());
    expect([s.mode, s.plan]).toEqual(["step", null]);
  });
  it("a create replay must repeat the mode: the same body replays; another mode under the id → 409", async () => {
    const id = uuidv7();
    await create(A, A.ownerSub, "plan", {}, id);
    const b = await create(A, A.ownerSub, "plan", {}, id);
    expect([b.status, b.headers.get(REPLAYED_HEADER)]).toEqual([201, "true"]);
    const c = await create(A, A.ownerSub, "step", {}, id);
    expect([c.status, (await errOf(c)).code]).toEqual([409, "idempotency_conflict"]);
  });
});

describe("T-089a (1): the plan preview", () => {
  // ADR-014 §7.5's seven items; the specialist per item is the T-083 hand list (BOARD gate 8; derivation in playbooks.ts).
  const HAND = [["data_complete", "finance"], ["supplier_price", "inventory_purchasing"], ["waste", "inventory_purchasing"], ["deals", "catalogue"],
    ["channel_fees", "finance"], ["labour", "people"], ["volume_mix", "catalogue"]];
  const SPEND = 1234;
  let C: T;
  let view: ReturnType<typeof InvestigationView.parse>;
  beforeAll(async () => {
    // History: one narrated Step-mode step of margin_fall whose run recorded SPEND (through the real internal API).
    C = await tenant("cost");
    fakeIntel(C, { spend: SPEND });
    const s = uuidv7();
    await create(C, C.ownerSub, undefined, {}, s);
    expect((await step(C, C.ownerSub, s, 1)).status).toBe(200);
    expect(await count(`SELECT count(*) n FROM core.investigation_step WHERE investigation_id = $1 AND run_id IS NOT NULL`, [s])).toBe(1);
    view = InvestigationView.parse(await (await create(C, C.ownerSub, "plan")).json());
  });
  it("7 items with the hand-listed specialists; the specialists involved, distinct in checklist order", () => {
    expect(view.plan!.items.map((i) => [i.item_id, i.specialist])).toEqual(HAND);
    expect(view.plan!.specialists).toEqual(["finance", "inventory_purchasing", "catalogue", "people"]);
  });
  it("the estimate is a resolving snapshot ref of intel.investigation_cost_estimate: per step × 7 unfrozen items (hand: 1,234 × 7 = 8,638), labelled \"estimate (computed)\"", async () => {
    const e = view.plan!.estimate;
    expect([e.label, e.status]).toEqual(["estimate (computed)", "computed"]);
    const values = new Map(view.resolved_refs.map((r) => [r.ref, r.value]));
    expect(values.get(e.estimate_ref!)).toBe(8638);
    expect(values.get(e.currency_ref!)).toBe(C.currency);
    // The ref is the SQL cell, re-read here: template id, minter and value.
    const [sid, idx] = /^⟨snap:([^·]+)·(\d+)·estimate_minor⟩$/u.exec(e.estimate_ref!)!.slice(1);
    const s = (await db.admin<{ template_id: string; minted_by_member_id: string; v: unknown }>(
      `SELECT template_id, minted_by_member_id, rows -> $2::int -> 'estimate_minor' AS v FROM evidence.snapshot WHERE id = $1`, [sid, Number(idx)])).rows[0]!;
    expect(s).toEqual({ template_id: "intel.investigation_cost_estimate", minted_by_member_id: C.owner, v: 8638 });
  });
  it("0 bare digits in the preview: every number is a ref (ids and refs stripped, nothing numeric is left)", () => {
    expect(bareDigits(view.plan)).toEqual([]);
  });
  it("no spend history yet → \"cannot verify\" with null refs, never 0; a template above the creator's role → \"cannot verify\"", async () => {
    const D = await tenant("nohist");
    const v = InvestigationView.parse(await (await create(D, D.ownerSub, "plan")).json());
    expect(v.plan!.estimate).toEqual({ label: "estimate (computed)", status: "cannot_verify", snapshot_id: null, estimate_ref: null, currency_ref: null });
    expect(bareDigits(v.plan)).toEqual([]);
    // Staff may pick plan once the owner raises their ceiling; the estimate template's min_role is manager (0020).
    expect((await ceiling(C, "staff", "plan")).status).toBe(200);
    const s = InvestigationView.parse(await (await create(C, C.staffSub, "plan")).json());
    expect(s.plan!.estimate.status).toBe("cannot_verify");
    expect((await ceiling(C, "staff", "step")).status).toBe(200);
  });
});

/** Digits left in a JSON value once canonical refs, uuids and timestamps are removed (the number grammar's view). */
function bareDigits(v: unknown): string[] {
  const text = JSON.stringify(v)
    .replace(/⟨[^⟩]*⟩/gu, "")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "")
    .replace(/\d{4}-\d{2}-\d{2}T[0-9:.]+(Z|[+-]\d{2}:\d{2})/g, "");
  return text.match(/\d+/g) ?? [];
}

describe("T-089a (2) on this world, approval and replay", () => {
  it("data incomplete here (no bank lines): the plan stops after 1 step at waiting, 1 model call, triggered_by plan", async () => {
    const calls = fakeIntel(A);
    const id = await openPlan(A, A.ownerSub);
    const r = await approve(A, A.ownerSub, id);
    const v = InvestigationView.parse(await r.json());
    expect([r.status, r.headers.get(REPLAYED_HEADER), v.status, v.stop_reason, v.steps_done, v.plan!.approved_by]).toEqual([200, null, "waiting", "waiting", 1, A.owner]);
    expect(await stepNos(id)).toEqual([{ step_no: 1, triggered_by: "plan" }]);
    expect(calls.length).toBe(1);
    // Idempotency replay: the same approval again answers the current view; no step runs, no model call.
    const b = await approve(A, A.ownerSub, id);
    expect([b.status, b.headers.get(REPLAYED_HEADER), InvestigationView.parse(await b.json()).steps_done]).toEqual([200, "true", 1]);
    expect([(await stepNos(id)).length, calls.length]).toEqual([1, 1]);
    // A member's :continue resumes at steps_done + 1 and clears the plan's stop reason.
    const c = await step(A, A.ownerSub, id, 2);
    expect([c.status, InvestigationView.parse(await c.json()).stop_reason]).toEqual([200, null]);
  });
  it("two concurrent approvals → one run (1 step); the other replays", async () => {
    fakeIntel(A);
    const id = await openPlan(A, A.ownerSub);
    const [a, b] = await Promise.all([approve(A, A.ownerSub, id), approve(A, A.ownerSub, id)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.headers.get(REPLAYED_HEADER), b.headers.get(REPLAYED_HEADER)].sort()).toEqual(["true", null].sort());
    expect((await stepNos(id)).length).toBe(1);
  });
  it("refusals, each with nothing written: not the creator → 403; a Step-mode investigation → 409; cancelled → 409; a bad body → 422", async () => {
    fakeIntel(A);
    const mine = await openPlan(A, A.managerSub);
    expect((await approve(A, A.ownerSub, mine)).status).toBe(403);
    const s = uuidv7();
    await create(A, A.ownerSub, "step", {}, s);
    const r = await approve(A, A.ownerSub, s);
    expect([r.status, (await errOf(r)).code]).toEqual([409, "illegal_transition"]);
    const c = await openPlan(A, A.ownerSub);
    await cancel(A, A.ownerSub, c);
    expect((await approve(A, A.ownerSub, c)).status).toBe(409);
    expect((await call(A, A.ownerSub, `/v1/investigations/${c}:approve-plan`, { steps: 3 })).status).toBe(422);
    for (const id of [mine, s, c]) expect([(await row(id)).plan_approved_by, (await stepNos(id)).length]).toEqual([null, 0]);
  });
});

describe("T-089a (5): a member whose ceiling is step → 403 on :approve-plan", () => {
  it("manager lowered to step by the owner → 403 mode_above_ceiling, nothing approved or run; raised to plan → 200 (paired)", async () => {
    const calls = fakeIntel(A);
    const id = await openPlan(A, A.managerSub);
    expect((await ceiling(A, "manager", "step")).status).toBe(200);
    const r = await approve(A, A.managerSub, id);
    expect([r.status, await errOf(r)]).toEqual([403, expect.objectContaining({ code: "forbidden", reason_code: "mode_above_ceiling" })]);
    expect([(await row(id)).plan_approved_by, (await stepNos(id)).length, calls.length]).toEqual([null, 0, 0]);
    expect((await ceiling(A, "manager", "plan")).status).toBe(200);
    const ok = await approve(A, A.managerSub, id);
    expect([ok.status, (await row(id)).plan_approved_by, (await stepNos(id)).length]).toEqual([200, A.manager, 1]);
  });
});

describe("T-089a (3): the budget", () => {
  let B: T;
  beforeAll(async () => {
    B = await tenant("budget", 1_000_000_000);
  });
  it("paired accept: budget left after step 1 → step 2 runs (2 model calls)", async () => {
    let id = "";
    const calls = fakeIntel(B, { spend: 100, during: async (n) => { if (n === 1) await plantOpen(id); } });
    id = await openPlan(B, B.ownerSub);
    expect((await approve(B, B.ownerSub, id)).status).toBe(200);
    expect([(await stepNos(id)).length, calls.length]).toEqual([2, 2]);
  });
  it("the cap reached by step 1's spend → stop_reason budget after 1 step, 0 further model calls", async () => {
    await setBudget(B, 1_000_000);
    let id = "";
    const calls = fakeIntel(B, { spend: 2_000_000, during: async (n) => { if (n === 1) await plantOpen(id); } });
    id = await openPlan(B, B.ownerSub);
    const v = InvestigationView.parse(await (await approve(B, B.ownerSub, id)).json());
    expect([v.status, v.stop_reason, v.steps_done, calls.length]).toEqual(["open", "budget", 1, 1]);
  });
  it("no operator budget for the month → fails closed: 0 steps, stop_reason budget, 0 model calls", async () => {
    const N = await tenant("nobudget", null);
    const calls = fakeIntel(N);
    const id = await openPlan(N, N.ownerSub);
    const v = InvestigationView.parse(await (await approve(N, N.ownerSub, id)).json());
    expect([v.status, v.stop_reason, v.steps_done, calls.length]).toEqual(["open", "budget", 0, 0]);
  });
});

describe("T-089a (4): membership narrowed mid-plan", () => {
  it("paired accept: an owner scoped to outlets 1–2 keeps access → 2 steps", async () => {
    let id = "";
    fakeIntel(A, { during: async (n) => { if (n === 1) await plantOpen(id); } });
    id = await openPlan(A, A.wide2Sub);
    expect((await approve(A, A.wide2Sub, id)).status).toBe(200);
    expect((await stepNos(id)).length).toBe(2);
  });
  it("narrowed to outlet 1 during step 1 → the next step is cancelled (1 cancelled, stop_reason scope), 1 step, 1 model call; the response is 404", async () => {
    let id = "";
    const calls = fakeIntel(A, {
      during: async (n) => {
        if (n !== 1) return;
        await plantOpen(id);
        await db.admin(`BEGIN; SET LOCAL session_replication_role = replica;
          UPDATE core.membership SET outlet_ids = ARRAY['${A.outlets[0]}']::uuid[] WHERE tenant_id = '${A.tenant}' AND member_id = '${A.wide}'; COMMIT;`);
      },
    });
    id = await openPlan(A, A.wideSub);
    const r = await approve(A, A.wideSub, id);
    expect(r.status).toBe(404);
    expect(await row(id)).toMatchObject({ status: "cancelled", stop_reason: "scope", steps_done: 1 });
    expect(await count(`SELECT count(*) n FROM core.investigation WHERE tenant_id = $1 AND created_by = $2 AND status = 'cancelled'`, [A.tenant, A.wide])).toBe(1);
    expect([(await stepNos(id)).length, calls.length]).toEqual([1, 1]);
  });
});

describe("T-089a (6): a planted kill between steps", () => {
  it("step 2's transaction dies → steps stay gapless [1]; :continue resumes at steps_done + 1", async () => {
    let id = "";
    fakeIntel(A, {
      during: async (n) => {
        if (n !== 1) return;
        await plantOpen(id);
        await db.admin(`CREATE FUNCTION public.t089a_kill() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.investigation_id = '${id}' THEN RAISE EXCEPTION 't089a planted kill'; END IF; RETURN NEW; END $$;
          CREATE TRIGGER t089a_kill BEFORE INSERT ON core.investigation_step FOR EACH ROW EXECUTE FUNCTION public.t089a_kill();`);
      },
    });
    id = await openPlan(A, A.ownerSub);
    const r = await approve(A, A.ownerSub, id);
    await db.admin(`DROP TRIGGER t089a_kill ON core.investigation_step; DROP FUNCTION public.t089a_kill();`);
    expect(r.status).toBe(500);
    expect(await stepNos(id)).toEqual([{ step_no: 1, triggered_by: "plan" }]);
    expect(await row(id)).toMatchObject({ status: "open", steps_done: 1 });
    // The replayed approval runs nothing; the member's :continue {2} is the resumption.
    expect((await approve(A, A.ownerSub, id)).headers.get(REPLAYED_HEADER)).toBe("true");
    expect((await step(A, A.ownerSub, id, 3)).status).toBe(409);
    expect((await step(A, A.ownerSub, id, 2)).status).toBe(200);
    expect((await stepNos(id)).map((s) => s.step_no)).toEqual([1, 2]);
  });
});

describe("T-089a (7): no step after the approving request has returned", () => {
  it("2 plan steps, every started_at ≤ the DB clock read after the response; 0 more steps 1 s later", async () => {
    let id = "";
    fakeIntel(A, { during: async (n) => { if (n === 1) await plantOpen(id); await new Promise((ok) => setTimeout(ok, 150)); } });
    id = await openPlan(A, A.ownerSub);
    expect((await approve(A, A.ownerSub, id)).status).toBe(200);
    const after = (await db.admin<{ t: Date }>(`SELECT clock_timestamp() AS t`)).rows[0]!.t;
    const steps = await db.admin<{ started_at: Date }>(`SELECT started_at FROM core.investigation_step WHERE investigation_id = $1`, [id]);
    expect(steps.rows.length).toBe(2);
    expect(steps.rows.filter((s) => s.started_at > after)).toEqual([]);
    await new Promise((ok) => setTimeout(ok, 1000));
    expect((await stepNos(id)).length).toBe(2);
  });
});

describe("T-089a: an abstained narration stops the plan", () => {
  it("abstained answer on step 1 (status left open) → stop_reason abstain, 1 step, 1 model call", async () => {
    let id = "";
    const calls = fakeIntel(A, { abstain: true, during: async (n) => { if (n === 1) await plantOpen(id); } });
    id = await openPlan(A, A.ownerSub);
    const v = InvestigationView.parse(await (await approve(A, A.ownerSub, id)).json());
    expect([v.status, v.stop_reason, v.steps_done, calls.length]).toEqual(["open", "abstain", 1, 1]);
  });
});

describe("SSE: progress on inbox:<tenant> while the approving request runs", () => {
  interface Ev { id: string; type: string; data: Record<string, unknown> }
  async function subscribe(t: T, sub: string, port: number): Promise<{ events: Ev[]; ready: Promise<void>; close(): void }> {
    const ctrl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/v1/stream?topics=inbox:${t.tenant}`, {
      headers: { Authorization: `Bearer ${idp.sign({ sub })}`, [TENANT_HEADER]: t.tenant }, signal: ctrl.signal,
    });
    expect(res.status).toBe(200);
    const events: Ev[] = [];
    let ok!: () => void;
    const ready = new Promise<void>((r) => (ok = r));
    void (async () => {
      const dec = new TextDecoder();
      let buf = "";
      try {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          buf += dec.decode(chunk, { stream: true });
          for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            if (block.includes("event: ready")) ok();
            const data = /^data: (.*)$/m.exec(block)?.[1];
            if (data && !block.includes("event:")) events.push(JSON.parse(data) as Ev);
          }
        }
      } catch {}
    })();
    return { events, ready, close: () => ctrl.abort() };
  }
  const until = async (f: () => boolean, ms: number) => {
    for (let t = 0; t < ms && !f(); t += 20) await new Promise((ok) => setTimeout(ok, 20));
    return f();
  };

  it("the owner sees step 1 land before the approval returns; categories only; an outlet-1 manager sees none of it", async () => {
    const server = await new Promise<{ port: number }>((ok) => { servers.push(serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (i) => ok({ port: i.port }))); });
    const owner = await subscribe(A, A.ownerSub, server.port);
    const mgr = await subscribe(A, A.managerSub, server.port);
    await Promise.all([owner.ready, mgr.ready]);
    let id = "";
    let midRequest = false;
    const mine = (e: Ev) => e.type === "inbox.investigation" && e.id === id;
    fakeIntel(A, {
      during: async (n) => {
        if (n !== 1) return;
        // Inside the approving request: step 1 has committed; its event must reach the stream now, not after the response.
        midRequest = await until(() => owner.events.some((e) => mine(e) && e.data.status === "waiting"), 5_000);
        await plantOpen(id);
      },
    });
    id = await openPlan(A, A.ownerSub);
    // A feed sends one event per `updated_at` it reads, so a change that commits before its first read of the new row folds
    // both states into one event: see the creation first, or the count below depends on the runner's speed.
    expect(await until(() => owner.events.some(mine), 15_000)).toBe(true);
    expect((await approve(A, A.ownerSub, id)).status).toBe(200);
    expect(midRequest).toBe(true);
    expect(await until(() => owner.events.some((e) => mine(e) && e.data.stop_reason === "waiting"), 5_000)).toBe(true);
    const evs = owner.events.filter(mine);
    expect(evs.length).toBeGreaterThanOrEqual(3); // created, approved, step 1, step 2, stopped (coalesced by the look-back drain)
    for (const e of evs) {
      expect(Object.keys(e.data).sort()).toEqual(["mode", "outlet_scope", "playbook_id", "status", "stop_reason", "updated_at"]);
      expect(bareDigits({ ...e.data, updated_at: null })).toEqual([]);
    }
    expect(mgr.events.filter(mine)).toEqual([]);
    owner.close();
    mgr.close();
  });
});

describe("clause 1: Plan mode writes no book (operational rows, snapshots and answers only)", () => {
  it("create + approve a 2-step plan + cancel: 0 book, audit, command, draft or decision rows change; the audit chain verifies", async () => {
    async function books(): Promise<Record<string, string>> {
      const tables = (await db.admin<{ t: string }>(
        `SELECT format('%I.%I', n.nspname, c.relname) AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind = 'r' AND obj_description(c.oid, 'pg_class') = 'munim:book'
            AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
          ORDER BY 1`)).rows.map((r) => r.t);
      const out: Record<string, string> = {};
      for (const t of [...tables, "core.audit_log", "core.command_log", "core.draft", "core.decision"]) {
        out[t] = (await db.admin<{ h: string }>(`SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${t} x WHERE x.tenant_id = $1`,
          [A.tenant])).rows[0]!.h;
      }
      return out;
    }
    let id = "";
    fakeIntel(A, { spend: 10, during: async (n) => { if (n === 1) await plantOpen(id); } });
    const before = await books();
    id = await openPlan(A, A.ownerSub);
    expect((await approve(A, A.ownerSub, id)).status).toBe(200);
    expect((await stepNos(id)).length).toBe(2);
    await cancel(A, A.ownerSub, id);
    expect(Object.keys(before).length).toBeGreaterThan(20);
    expect(await books()).toEqual(before);
    const v = await verifyAuditChain(svcTx(db), A.tenant);
    expect([v.ok, v.rows > 0]).toEqual([true, true]);
  });
});
