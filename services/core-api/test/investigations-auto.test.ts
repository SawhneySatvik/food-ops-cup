// T-089b gates — investigation Auto mode (ledger R45 F10, F11 O-1; BOARD b-89 T-089b) through the real app on embedded
// Postgres (m-1's canonical world) and core-worker's Auto pass (services/core-worker/src/investigations) on munim_svc.
// intel is mocked at its boundary only (the NarratePort): the fake stores core's template sentences through the REAL
// internal API with the run token core minted, and records that token's trigger.
//   approve  `:approve-plan {mode: "auto"}`: the owner → mode auto + 1 live grant (idempotent); a manager (ceiling plan) → 403
//   (1)  an approved bank-statement import resumes exactly the 1 `auto` investigation waiting on bank lines, of 2 open
//        (1 auto + 1 plan); unrelated kinds (market signals, a payout statement) resume 0
//   (6)  two concurrent passes → 1 step, gapless; replaying the pass → 0 more
//   (7)  drafts created by Auto = 0; clause 1: md5 of every book table unchanged by the passes, audit chain verifies
//   daily: nothing waiting → 0 steps; past the day's boundary → the auto one only
//   (2)  creator removed → 0 steps, cancelled, stop_reason scope (paired: the owner's resumes in the same pass)
//   (3)  outlet narrowed → the {o1,o2} investigation is cancelled, 0 new snapshots; the {o1} one steps and its new
//        snapshots count 0 outlet-2 trading days, where the un-narrowed step counted 1 (the planted outlet-2 day)
//   (4)  at the cap → 0 resumptions, stop_reason budget, 0 model calls; the limit raised → 1 step (paired)
//   (5)  ceiling lowered → 0 auto steps, downgraded to Plan: mode plan, stop_reason ceiling (paired: the owner's resumes in
//        the same pass)
//   T-098 ceiling lowered with no new data → the same day: mode plan, stop_reason ceiling, 0 steps, 1 inbox NOTIFY, grant
//        unrevoked but no longer resumed (paired: the owner's Auto stays Auto); the creator's `:continue` then steps once.
//        The creating manager's own view and list keep status `restricted` and every item as before, and now show
//        stop_reason `ceiling` (null before the downgrade, where the reason was `waiting`)
//   role a manager's Auto step mints no template above the manager's role (0 advisor-level snapshots; the owner's > 0)
// Hand counts: on this world the margin_fall gate (data_complete) waits only on `bank_imported` for September and August
// 2026 (no bank lines; no completed orders, so pos_days_closed and settlements_imported are done), so every step ends
// `waiting` and each resumption is exactly 1 step. Expected values are hand-written, never read from the code under test.
// Synthetic data only.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@munim/config";
import { InvestigationView, NarrateRequest } from "@munim/contracts/investigations";
import { PACKS } from "@munim/contracts/packs";
import { type TestDb, uuidv7 } from "@munim/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalIdp } from "../src/auth/local-idp.ts";
import { parsePendingImports } from "../../core-worker/src/imports/index.ts";
import { autoPass } from "../../core-worker/src/investigations/index.ts";
import { createApp, TENANT_HEADER, type Deps } from "../src/app.ts";
import { verifyAuditChain } from "../src/commit/index.ts";
import { svcTx, testKeys } from "../src/commit/testkit.ts";
import { configureInternal } from "../src/internal/index.ts";
import { seedChart } from "../src/modules/finance/index.ts";
import { localBlobStore } from "../src/modules/imports/index.ts";
import { configureInvestigations, type NarratePort, resumeDaily, resumeOnImports } from "../src/modules/investigations/index.ts";
import { openDb } from "./db.ts";
import { buildTenant, type Tenant } from "./world.ts";

const idp = createLocalIdp();
const keys = testKeys();
const SECRET = "t089b-test-service-secret-not-real-0123456789abcdef";
const MONTH = `${new Date().toISOString().slice(0, 7)}-01`;
const FIXTURES = join(import.meta.dirname, "../../core-worker/test/fixtures/imports");
const PARAMS = { period_month: "2026-09-01", compare_month: "2026-08-01" };
let db: TestDb;
let pools: { core: pg.Pool; svc: pg.Pool };
let deps: Deps;
let app: Awaited<ReturnType<typeof createApp>>;
let blobDir: string;

type Res = Omit<Response, "json"> & { json(): Promise<any> };
interface T extends Tenant { wide: string; wideSub: string; owner2: string; owner2Sub: string }

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
const setBudget = (t: T, limit: number) =>
  db.admin(`INSERT INTO platform.llm_budget (tenant_id, month, limit_minor, currency) VALUES ($1, $2, $3, $4)
            ON CONFLICT (tenant_id, month) DO UPDATE SET limit_minor = EXCLUDED.limit_minor, currency = EXCLUDED.currency`, [t.tenant, MONTH, limit, t.currency]);
const command = (t: T, path: string, type: string, payload: unknown) =>
  call(t, t.ownerSub, path, { command_id: uuidv7(), idempotency_key: `t089b-${uuidv7()}`, type, payload });
const ceiling = (t: T, role: string, mode_ceiling: string) => command(t, "/v1/ai/policy/ceiling", "ai_policy.ceiling.set.v1", { role, mode_ceiling });
const steps = async (id: string) =>
  (await db.admin<{ step_no: number; triggered_by: string }>(`SELECT step_no, triggered_by FROM core.investigation_step WHERE investigation_id = $1 ORDER BY step_no`, [id])).rows;
const row = async (id: string) =>
  (await db.admin<{ mode: string; status: string; stop_reason: string | null; steps_done: number }>(
    `SELECT mode, status, stop_reason, steps_done FROM core.investigation WHERE id = $1`, [id])).rows[0]!;
const plant = (sql: string) => db.admin(`BEGIN; SET LOCAL session_replication_role = replica; ${sql}; COMMIT;`);

/** A fake intel: stores core's own template sentences as its answer, optionally records spend; counts its calls and
 *  the trigger of each run token it was handed. */
const calls: Array<{ trigger: string; actor: string }> = [];
let spendPerCall = 0;
const port: NarratePort = async (token, raw) => {
  const req = NarrateRequest.parse(raw);
  const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as { trigger: string; actor: string; tenant_id: string };
  calls.push({ trigger: claims.trigger, actor: claims.actor });
  const envelope = { answer_id: req.answer_id, segments: req.items.map((i) => ({ text: i.template, refs: [...new Set(i.cells.map((c) => `snap:${/snap:([^·]+)/.exec(c.ref)![1]}`))] })), abstained: false, reason_code: null };
  const a = await internal(token, "answers", { question: req.question, envelope });
  if (a.status !== 201) throw new Error(`fake intel: answers ${a.status}`);
  if (spendPerCall > 0) {
    const currency = (await db.admin<{ c: string }>(`SELECT base_currency AS c FROM core.tenant WHERE tenant_id = $1`, [claims.tenant_id])).rows[0]!.c;
    const s = await internal(token, "spend", { entries: [{ id: uuidv7(), role: "narrate", provider: "gemini", model_id: "recorded/narrate", input_tokens: 10, output_tokens: 10, amount_minor: spendPerCall, currency }] });
    if (s.status !== 201) throw new Error(`fake intel: spend ${s.status}`);
  }
  return { answer_id: req.answer_id, tainted: false, source: "model" };
};

const worker = (tenant: string, pass: Parameters<typeof autoPass>[1]) =>
  autoPass({ pool: pools.svc, keys, narrate: port, log: () => {} }, pass, [tenant]);
const onImports = (t: T) => worker(t.tenant, resumeOnImports);
const daily = (t: T, since: Date) => worker(t.tenant, (d, tenant) => resumeDaily(d, tenant, since));
const later = () => new Date(Date.now() + 1000);
/** R47 D4: new data in the investigations' months (PARAMS): one journal entry dated 2026-09-12 whose created_at is now, so it arrived after
 *  every step so far. Planted behind the book guard like the other plants here (a test arrival, not a command). */
const arrive = (t: T) => plant(`INSERT INTO core.journal_entry (tenant_id, id, entry_date, origin) VALUES ('${t.tenant}', '${uuidv7()}', '2026-09-12', '{}')`);

async function tenant(label: string): Promise<T> {
  const w = await buildTenant(db, label);
  const t: T = { ...w, wide: uuidv7(), wideSub: `wide-${label}-${uuidv7()}`, owner2: uuidv7(), owner2Sub: `owner2-${label}-${uuidv7()}` };
  await db.withContext("munim_core", { tenant_id: t.tenant, outlet_ids: "*", role: "owner", member_id: t.owner, command_type: "tenancy.member.invite.v1" }, async (c) => {
    // An owner scoped to outlets 1 and 2 (the narrowing gate) and a second all-outlet owner (the removal gate).
    await c.query(`INSERT INTO core.member (tenant_id, id, idp_sub, name, email) VALUES ($1, $2, $3, 'Outlet Owner', $4)`, [t.tenant, t.wide, t.wideSub, `${t.wideSub}@example.test`]);
    await c.query(`INSERT INTO core.membership (tenant_id, member_id, role, outlet_ids) VALUES ($1, $2, 'owner', $3)`, [t.tenant, t.wide, [t.outlets[0], t.outlets[1]]]);
    await c.query(`INSERT INTO core.member (tenant_id, id, idp_sub, name, email) VALUES ($1, $2, $3, 'Second Owner', $4)`, [t.tenant, t.owner2, t.owner2Sub, `${t.owner2Sub}@example.test`]);
    await c.query(`INSERT INTO core.membership (tenant_id, member_id, role, outlet_ids) VALUES ($1, $2, 'owner', '{}')`, [t.tenant, t.owner2]);
  });
  // Imports post through finance (the pack's chart, as provisioning seeds it) and payouts need the pack's aggregators.
  await db.withContext("munim_core", { tenant_id: t.tenant, outlet_ids: "*", role: "owner", member_id: t.owner, command_type: "finance.account.upsert.v1" }, (c) => seedChart(c, PACKS.IN));
  await db.withContext("munim_core", { tenant_id: t.tenant, outlet_ids: "*", role: "owner", member_id: t.owner, command_type: "tenancy.channel.create.v1" }, (c) =>
    c.query(`INSERT INTO core.channel (tenant_id, id, name, kind) VALUES ($1, $2, 'Synthetic swiggy', 'aggregator:swiggy')`, [t.tenant, uuidv7()]));
  await setBudget(t, 1_000_000_000);
  return t;
}

/** Opens a margin_fall investigation as `sub` and approves it in `mode`; returns its id (each approval runs 1 plan step). */
async function approved(t: T, sub: string, mode: "plan" | "auto", extra: Record<string, unknown> = {}): Promise<string> {
  const id = uuidv7();
  const c = await call(t, sub, "/v1/investigations", { investigation_id: id, playbook_id: "margin_fall", params: PARAMS, mode, ...extra });
  expect(c.status).toBe(201);
  const r = await call(t, sub, `/v1/investigations/${id}:approve-plan`, mode === "auto" ? { mode } : {});
  expect(r.status).toBe(200);
  InvestigationView.parse(await r.json());
  expect(await row(id)).toMatchObject({ mode, status: "waiting", stop_reason: "waiting", steps_done: 1 });
  return id;
}

/** Uploads a fixture file as the owner, parses it on core-worker's job, and approves the commit draft. */
async function importFile(t: T, kind: string, file: string): Promise<void> {
  const bytes = await readFile(join(FIXTURES, file));
  const up = await call(t, t.ownerSub, "/v1/imports/documents", { kind, filename: file, media_type: "text/csv", content_base64: bytes.toString("base64") });
  expect(up.status).toBe(200);
  const runId = (await up.json()).run.import_run_id as string;
  await parsePendingImports({ pool: pools.svc, blobs: localBlobStore(blobDir), log: () => {} }, [t.tenant]);
  const run = await (await call(t, t.ownerSub, `/v1/imports/runs/${runId}`)).json();
  expect(run.status).toBe("previewed");
  const a = await call(t, t.ownerSub, `/v1/drafts/${run.draft_id}:approve`, {
    command_id: uuidv7(), idempotency_key: `t089b-imp-${uuidv7()}`, type: "drafts.approve.v1",
    payload: { draft_id: run.draft_id, command_type: "imports.run.commit.v1", edited_payload: null, reason: null },
  });
  expect(a.status).toBe(200);
  expect(await count(`SELECT count(*) n FROM core.import_run WHERE id = $1 AND status = 'committed'`, [runId])).toBe(1);
}

/** md5 of every book table's rows of the tenant (tables from their munim:book tags), plus audit, commands, drafts, decisions. */
async function books(t: T): Promise<Record<string, string>> {
  const tables = (await db.admin<{ t: string }>(
    `SELECT format('%I.%I', n.nspname, c.relname) AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND obj_description(c.oid, 'pg_class') = 'munim:book'
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
      ORDER BY 1`)).rows.map((r) => r.t);
  const out: Record<string, string> = {};
  for (const tb of [...tables, "core.audit_log", "core.command_log", "core.draft", "core.decision"]) {
    out[tb] = (await db.admin<{ h: string }>(`SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM ${tb} x WHERE x.tenant_id = $1`,
      [t.tenant])).rows[0]!.h;
  }
  return out;
}

beforeAll(async () => {
  db = await openDb();
  pools = { core: db.pool("munim_core", 10), svc: db.pool("munim_svc", 8) };
  blobDir = await mkdtemp(join(tmpdir(), "t089b-blobs-"));
  const config = { nodeEnv: "test", redact: (s: string) => s };
  deps = { pools, idp, storefronts: async () => null, blobs: localBlobStore(blobDir), config, log: createLogger(config, () => {}) };
  app = await createApp(deps);
  configureInternal(deps, { serviceSecret: SECRET, keys, watchWindowMs: 0 });
  configureInvestigations(deps, { keys, narrate: port });
});

afterAll(async () => {
  await pools?.core.end();
  await pools?.svc.end();
  await db?.stop();
  if (blobDir) await rm(blobDir, { recursive: true, force: true });
});

describe("approving Auto", () => {
  it("the owner: create {mode: auto} opens a plan; :approve-plan {mode: auto} → mode auto, 1 live grant of the owner for the scope; a repeat replays", async () => {
    const A = await tenant("approve");
    const id = uuidv7();
    const c = InvestigationView.parse(await (await call(A, A.ownerSub, "/v1/investigations", { investigation_id: id, playbook_id: "margin_fall", params: PARAMS, mode: "auto" })).json());
    expect([c.mode, c.plan?.approved_by, c.steps_done]).toEqual(["plan", null, 0]);
    expect((await call(A, A.ownerSub, "/v1/investigations", { investigation_id: id, playbook_id: "margin_fall", params: PARAMS, mode: "auto" })).headers.get("x-munim-replayed")).toBe("true");
    const r = await call(A, A.ownerSub, `/v1/investigations/${id}:approve-plan`, { mode: "auto" });
    expect([r.status, r.headers.get("x-munim-replayed")]).toEqual([200, null]);
    expect(await row(id)).toMatchObject({ mode: "auto", status: "waiting", stop_reason: "waiting", steps_done: 1 });
    const g = await db.admin<{ member_id: string; scope: string[]; live: boolean }>(
      `SELECT member_id, outlet_scope::text[] AS scope, revoked_at IS NULL AS live FROM core.investigation_grant WHERE investigation_id = $1`, [id]);
    expect(g.rows).toEqual([{ member_id: A.owner, scope: ["*"], live: true }]);
    const again = await call(A, A.ownerSub, `/v1/investigations/${id}:approve-plan`, { mode: "auto" });
    expect([again.status, again.headers.get("x-munim-replayed")]).toEqual([200, "true"]);
    expect([(await steps(id)).length, await count(`SELECT count(*) n FROM core.investigation_grant WHERE investigation_id = $1`, [id])]).toEqual([1, 1]);
  });
  it("a manager (default ceiling plan) → 403 mode_above_ceiling, mode stays plan, 0 grants; an approved Plan is not turned into Auto (409)", async () => {
    const A = await tenant("approve-refusals");
    expect((await call(A, A.managerSub, "/v1/investigations", { investigation_id: uuidv7(), playbook_id: "margin_fall", params: PARAMS, mode: "auto" })).status).toBe(403);
    const id = uuidv7();
    expect((await call(A, A.managerSub, "/v1/investigations", { investigation_id: id, playbook_id: "margin_fall", params: PARAMS, mode: "plan" })).status).toBe(201);
    const r = await call(A, A.managerSub, `/v1/investigations/${id}:approve-plan`, { mode: "auto" });
    expect([r.status, (await r.json()).error.reason_code]).toEqual([403, "mode_above_ceiling"]);
    expect([(await row(id)).mode, await count(`SELECT count(*) n FROM core.investigation_grant WHERE investigation_id = $1`, [id])]).toEqual(["plan", 0]);
    const p = await approved(A, A.ownerSub, "plan");
    expect((await call(A, A.ownerSub, `/v1/investigations/${p}:approve-plan`, { mode: "auto" })).status).toBe(409);
    expect((await row(p)).mode).toBe("plan");
  });
});

describe("T-089b (1), (6), (7), clause 1, daily — the import trigger", () => {
  let A: T;
  let auto: string;
  let plan: string;
  let before: Record<string, string>;
  let drafts = -1;
  beforeAll(async () => {
    A = await tenant("import");
    auto = await approved(A, A.ownerSub, "auto");
    plan = await approved(A, A.ownerSub, "plan");
  });

  it("(1) refusals: no import → 0; a market-signal import and a payout statement (kinds it does not wait on) → 0 resumptions", async () => {
    expect(await onImports(A)).toEqual({ resumed: 0, steps: 0, cancelled: 0, budget: 0, ceiling: 0 });
    await importFile(A, "market_signal", "synthetic_market_1.csv");
    await importFile(A, "payout_statement", "synthetic_swiggy_1.csv");
    expect(await onImports(A)).toEqual({ resumed: 0, steps: 0, cancelled: 0, budget: 0, ceiling: 0 });
    expect([(await steps(auto)).length, (await steps(plan)).length]).toEqual([1, 1]);
  });

  it("(1)+(6) a bank-statement import: two concurrent passes resume exactly the auto one, 1 step (gapless); the plan one 0", async () => {
    await importFile(A, "bank_statement", "synthetic_bank_1.csv");
    before = await books(A);
    drafts = await count(`SELECT count(*) n FROM core.draft WHERE tenant_id = $1`, [A.tenant]);
    calls.length = 0;
    const [x, y] = await Promise.all([onImports(A), onImports(A)]);
    expect(x.steps + y.steps).toBe(1);
    expect(x.resumed + y.resumed).toBe(1);
    expect(await steps(auto)).toEqual([{ step_no: 1, triggered_by: "plan" }, { step_no: 2, triggered_by: "auto" }]);
    expect(await steps(plan)).toEqual([{ step_no: 1, triggered_by: "plan" }]);
    expect(await row(auto)).toMatchObject({ mode: "auto", status: "waiting", stop_reason: "waiting", steps_done: 2 });
    // The step names its grant and its auto_step run (actor = the creator); its snapshots are that run's; it is narrated under it.
    const s = (await db.admin<{ grant_ok: boolean; trig: string; actor: string; snaps: string; member_snaps: string; answer: boolean }>(
      `SELECT s.grant_id = g.id AS grant_ok, r.trigger AS trig, r.actor, r.ended_at IS NOT NULL AS ended,
              (SELECT count(*) FROM evidence.snapshot x WHERE x.run_id = s.run_id) AS snaps,
              (SELECT count(*) FROM evidence.snapshot x WHERE x.run_id = s.run_id AND x.minted_by_member_id IS NOT NULL) AS member_snaps,
              s.summary_answer_id IS NOT NULL AS answer
         FROM core.investigation_step s JOIN core.investigation_grant g ON g.investigation_id = s.investigation_id
         JOIN intel.run r ON r.tenant_id = s.tenant_id AND r.id = s.run_id AND r.grant_id = g.id
        WHERE s.investigation_id = $1 AND s.step_no = 2`, [auto])).rows[0]!;
    expect([s.grant_ok, s.trig, s.actor, Number(s.snaps) > 0, Number(s.member_snaps), s.answer]).toEqual([true, "auto_step", A.owner, true, 0, true]);
    expect(calls).toEqual([{ trigger: "auto_step", actor: A.owner }]);
  });

  it("idempotent replay: the same import seen again → 0 steps", async () => {
    expect(await onImports(A)).toEqual({ resumed: 0, steps: 0, cancelled: 0, budget: 0, ceiling: 0 });
    expect((await steps(auto)).length).toBe(2);
  });

  it("daily: nothing waiting since the day's boundary → 0 steps; past it → the auto one only (1 step)", async () => {
    const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
    expect(await daily(A, today)).toEqual({ resumed: 0, steps: 0, cancelled: 0, budget: 0, ceiling: 0 });
    // R47 D4: past the boundary, but nothing new arrived since step 2 → 0 steps; a journal entry dated in the months arrives → 1.
    expect(await daily(A, later())).toEqual({ resumed: 0, steps: 0, cancelled: 0, budget: 0, ceiling: 0 });
    expect((await steps(auto)).length).toBe(2);
    await arrive(A);
    before = await books(A); // the arrival is the test's plant, not the pass's write: the clause-1 comparison below starts after it
    expect(await daily(A, later())).toEqual({ resumed: 1, steps: 1, cancelled: 0, budget: 0, ceiling: 0 });
    expect([(await steps(auto)).length, (await steps(plan)).length]).toEqual([3, 1]);
    // The step consumed the arrival: the next pass is quiet again.
    expect(await daily(A, later())).toEqual({ resumed: 0, steps: 0, cancelled: 0, budget: 0, ceiling: 0 });
  });

  it("D4: data outside the investigation's months, and a market-signal import, are not new data; a committed bank import is", async () => {
    const B = await tenant("d4-scope");
    const id = await approved(B, B.ownerSub, "auto");
    // A journal entry dated October (the months are Aug and Sep), made now: not read by margin_fall.
    await plant(`INSERT INTO core.journal_entry (tenant_id, id, entry_date, origin) VALUES ('${B.tenant}', '${uuidv7()}', '2026-10-03', '{}')`);
    expect(await daily(B, later())).toEqual({ resumed: 0, steps: 0, cancelled: 0, budget: 0, ceiling: 0 });
    await importFile(B, "bank_statement", "synthetic_bank_1.csv");
    expect(await daily(B, later())).toEqual({ resumed: 1, steps: 1, cancelled: 0, budget: 0, ceiling: 0 });
    expect((await steps(id)).length).toBe(2);
  });

  it("(7) + clause 1: Auto created 0 drafts; the passes changed 0 book, audit, command, draft or decision rows; the audit chain verifies", async () => {
    expect(Object.keys(before).length).toBeGreaterThan(20);
    expect(await books(A)).toEqual(before);
    // Drafts created by the passes: after − before = 0 (before counts the world's and the three import drafts).
    expect(drafts).toBeGreaterThanOrEqual(3);
    expect(await count(`SELECT count(*) n FROM core.draft WHERE tenant_id = $1`, [A.tenant]) - drafts).toBe(0);
    const v = await verifyAuditChain(svcTx(db), A.tenant);
    expect([v.ok, v.rows > 0]).toEqual([true, true]);
  });
});

describe("T-089b (2): creator removed", () => {
  it("→ 0 steps, cancelled, stop_reason scope; the owner's auto investigation resumes in the same pass (paired)", async () => {
    const A = await tenant("removed");
    const gone = await approved(A, A.owner2Sub, "auto");
    const kept = await approved(A, A.ownerSub, "auto");
    await plant(`UPDATE core.membership SET active = false WHERE tenant_id = '${A.tenant}' AND member_id = '${A.owner2}'`);
    await arrive(A);
    expect(await daily(A, later())).toEqual({ resumed: 1, steps: 1, cancelled: 1, budget: 0, ceiling: 0 });
    expect(await row(gone)).toMatchObject({ status: "cancelled", stop_reason: "scope", steps_done: 1 });
    expect((await steps(gone)).length).toBe(1);
    expect(await row(kept)).toMatchObject({ status: "waiting", steps_done: 2 });
  });
});

describe("T-089b (3): outlet narrowed", () => {
  it("the {o1,o2} investigation is cancelled with 0 new snapshots; the {o1} one steps, counting 0 outlet-2 trading days (1 before narrowing)", async () => {
    const A = await tenant("narrowed");
    // One completed September order in outlet 2 with no closed shift: an outlet-2 trading day pos_days_closed counts.
    await plant(`UPDATE core."order" SET status = 'completed', business_date = '2026-09-15' WHERE tenant_id = '${A.tenant}' AND outlet_id = '${A.outlets[1]}'`);
    const both = await approved(A, A.wideSub, "auto", { outlet_scope: [A.outlets[0], A.outlets[1]] });
    const one = await approved(A, A.wideSub, "auto", { outlet_scope: [A.outlets[0]] });
    const posOpen = async (id: string, stepNo: number) => {
      const r = await db.admin<{ n: string; scope: string[] }>(
        `SELECT (x.rows -> 0 ->> 'open_count') AS n, x.outlet_scope::text[] AS scope
           FROM core.investigation_step s JOIN evidence.snapshot x ON x.tenant_id = s.tenant_id AND x.run_id = s.run_id
          WHERE s.investigation_id = $1 AND s.step_no = $2 AND x.template_id = 'finance.close_status' AND x.params ->> 'period_month' = '2026-09-01'
            AND x.rows -> 0 ->> 'item_code' = 'pos_days_closed'`, [id, stepNo]);
      return r.rows.map((x) => [Number(x.n), x.scope]);
    };
    // Un-narrowed: an auto step over {o1,o2} counts the outlet-2 day.
    await arrive(A);
    expect((await daily(A, later())).steps).toBe(2);
    expect(await posOpen(both, 2)).toEqual([[1, [A.outlets[0], A.outlets[1]]]]);
    expect(await posOpen(one, 2)).toEqual([[0, [A.outlets[0]]]]);
    await plant(`UPDATE core.membership SET outlet_ids = ARRAY['${A.outlets[0]}']::uuid[] WHERE tenant_id = '${A.tenant}' AND member_id = '${A.wide}'`);
    const snapsBefore = await count(`SELECT count(*) n FROM evidence.snapshot WHERE tenant_id = $1`, [A.tenant]);
    await arrive(A);
    expect(await daily(A, later())).toEqual({ resumed: 1, steps: 1, cancelled: 1, budget: 0, ceiling: 0 });
    expect(await row(both)).toMatchObject({ status: "cancelled", stop_reason: "scope", steps_done: 2 });
    expect(await posOpen(one, 3)).toEqual([[0, [A.outlets[0]]]]);
    // Every snapshot minted since narrowing is the {o1} step's: none covers outlet 2.
    const since = await db.admin<{ scope: string[] }>(
      `SELECT x.outlet_scope::text[] AS scope FROM evidence.snapshot x JOIN core.investigation_step s ON s.tenant_id = x.tenant_id AND s.run_id = x.run_id
        WHERE s.investigation_id = ANY ($1::uuid[]) AND s.step_no = 3`, [[both, one]]);
    expect(since.rows.length).toBe(await count(`SELECT count(*) n FROM evidence.snapshot WHERE tenant_id = $1`, [A.tenant]) - snapsBefore);
    expect(since.rows.length).toBeGreaterThan(0);
    expect(since.rows.filter((x) => x.scope.includes(A.outlets[1]) || x.scope.includes("*")).length).toBe(0);
  });
});

describe("T-089b (4): at the cap", () => {
  it("→ 0 resumptions, stop_reason budget, 0 model calls; the operator limit raised → 1 step (paired)", async () => {
    const A = await tenant("cap");
    spendPerCall = 500;
    const id = await approved(A, A.ownerSub, "auto");
    spendPerCall = 0;
    await setBudget(A, 500); // spent 500 of 500: the effective cap is reached
    calls.length = 0;
    await arrive(A);
    expect(await daily(A, later())).toEqual({ resumed: 0, steps: 0, cancelled: 0, budget: 1, ceiling: 0 });
    expect(await row(id)).toMatchObject({ status: "waiting", stop_reason: "budget", steps_done: 1 });
    expect(calls.length).toBe(0);
    await setBudget(A, 10_000);
    expect(await daily(A, later())).toEqual({ resumed: 1, steps: 1, cancelled: 0, budget: 0, ceiling: 0 });
    expect(await row(id)).toMatchObject({ status: "waiting", stop_reason: "waiting", steps_done: 2 });
  });
});

describe("T-089b (5) ceiling lowered, and the creator's role on Auto snapshots", () => {
  it("a manager's Auto step mints no advisor-level template (the owner's does); the manager's ceiling lowered → 0 auto steps, downgraded to Plan (stop_reason ceiling); the owner's resumes", async () => {
    const A = await tenant("ceiling");
    expect((await ceiling(A, "manager", "auto")).status).toBe(200);
    const mgr = await approved(A, A.managerSub, "auto");
    const own = await approved(A, A.ownerSub, "auto");
    await arrive(A);
    expect((await daily(A, later())).steps).toBe(2);
    const advisorSnaps = (id: string) => count(
      `SELECT count(*) n FROM core.investigation_step s JOIN evidence.snapshot x ON x.tenant_id = s.tenant_id AND x.run_id = s.run_id
         JOIN evidence.snapshot_template t ON t.id = x.template_id AND t.version = x.template_version
        WHERE s.investigation_id = $1 AND s.triggered_by = 'auto' AND t.min_role IN ('advisor', 'owner')`, [id]);
    expect(await advisorSnaps(mgr)).toBe(0);
    expect(await advisorSnaps(own)).toBeGreaterThan(0);
    expect((await ceiling(A, "manager", "plan")).status).toBe(200);
    await arrive(A);
    expect(await daily(A, later())).toEqual({ resumed: 1, steps: 1, cancelled: 0, budget: 0, ceiling: 1 });
    expect(await steps(mgr)).toEqual([{ step_no: 1, triggered_by: "plan" }, { step_no: 2, triggered_by: "auto" }]);
    expect(await row(mgr)).toMatchObject({ mode: "plan", status: "waiting", stop_reason: "ceiling", steps_done: 2 });
    expect((await steps(own)).length).toBe(3);
  });
});

describe("T-098 ceiling lowered → downgraded to Plan", () => {
  it("no new data: mode plan, stop_reason ceiling, 0 steps, 1 inbox NOTIFY, grant unrevoked and not resumed; the owner's stays Auto; the creator's :continue steps once", async () => {
    const A = await tenant("downgrade");
    expect((await ceiling(A, "manager", "auto")).status).toBe(200);
    const mgr = await approved(A, A.managerSub, "auto");
    const own = await approved(A, A.ownerSub, "auto");
    const mgrView = async () => InvestigationView.parse(await (await call(A, A.managerSub, `/v1/investigations/${mgr}`)).json());
    const before = await mgrView();
    expect([before.status, before.stop_reason]).toEqual(["restricted", null]);
    expect((await ceiling(A, "manager", "plan")).status).toBe(200);
    const listen = await db.connect("admin");
    const got: string[] = [];
    listen.on("notification", (n) => { if (n.channel === "munim_inbox") got.push(n.payload ?? ""); });
    await listen.query("LISTEN munim_inbox");
    let tally: Awaited<ReturnType<typeof daily>> | undefined;
    try {
      calls.length = 0;
      tally = await daily(A, later());
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      await listen.end();
    }
    expect(tally).toEqual({ resumed: 0, steps: 0, cancelled: 0, budget: 0, ceiling: 1 });
    expect(calls.length).toBe(0);
    expect(await row(mgr)).toMatchObject({ mode: "plan", status: "waiting", stop_reason: "ceiling", steps_done: 1 });
    expect(await steps(mgr)).toEqual([{ step_no: 1, triggered_by: "plan" }]);
    expect(got.filter((p) => p === `${A.tenant}:${mgr}`).length).toBe(1);
    expect(await row(own)).toMatchObject({ mode: "auto", status: "waiting", stop_reason: "waiting", steps_done: 1 });
    expect(await count(`SELECT count(*) n FROM core.investigation_grant WHERE investigation_id = $1 AND revoked_at IS NULL`, [mgr])).toBe(1);
    // The view carries the new reason (contracts StopReason): to the owner with the status; to the creating manager beside a
    // status still `restricted`, every item as before (T-098 ruling: `ceiling` names only the owner's change).
    const v = InvestigationView.parse(await (await call(A, A.ownerSub, `/v1/investigations/${mgr}`)).json());
    expect([v.mode, v.status, v.stop_reason]).toEqual(["plan", "waiting", "ceiling"]);
    const after = await mgrView();
    expect([after.mode, after.status, after.stop_reason]).toEqual(["plan", "restricted", "ceiling"]);
    expect(after.checklist).toEqual(before.checklist);
    expect(after.resolved_refs).toEqual(before.resolved_refs);
    const list = (await (await call(A, A.managerSub, "/v1/investigations")).json()) as { items: Array<{ investigation_id: string; status: string; stop_reason: string | null }> };
    expect(list.items.filter((x) => x.investigation_id === mgr).map((x) => [x.status, x.stop_reason])).toEqual([["restricted", "ceiling"]]);
    // Downgraded: no later pass resumes it, new data or not.
    await arrive(A);
    expect(await daily(A, later())).toEqual({ resumed: 1, steps: 1, cancelled: 0, budget: 0, ceiling: 0 });
    expect(await steps(mgr)).toEqual([{ step_no: 1, triggered_by: "plan" }]);
    expect((await steps(own)).length).toBe(2);
    // The creator steps it under Plan.
    const r = await call(A, A.managerSub, `/v1/investigations/${mgr}:continue`, { step_no: 2 });
    expect(r.status).toBe(200);
    InvestigationView.parse(await r.json());
    expect(await steps(mgr)).toEqual([{ step_no: 1, triggered_by: "plan" }, { step_no: 2, triggered_by: "member" }]);
    expect(await row(mgr)).toMatchObject({ mode: "plan", status: "waiting", stop_reason: null, steps_done: 2 });
  });
});
