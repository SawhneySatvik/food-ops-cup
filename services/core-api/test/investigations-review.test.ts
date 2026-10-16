// R-D (W3 close review) fixes in the investigations module, through the real app on embedded Postgres (m-1's canonical
// world); intel mocked at its boundary only (the NarratePort; the fake stores through the REAL internal API).
//   item 2  verdicts redacted per viewer: the owner sees an outlet-1 investigation's verdicts, narration and status; the
//           outlet-1 manager and outlet-1 staff see it (as before) with every item, update and the status `restricted`,
//           0 narration segments and 0 resolved refs (finance.close_status / finance.margin_bridge are advisor+); the
//           manager's list shows `restricted` and ?status= never matches a restricted row; on SSE the manager's
//           `inbox.investigation` events carry `restricted`, the owner's the real status; stop_reason (which can name the
//           verdict: `waiting`) is null wherever the status is restricted, checked on a Plan run stopped at waiting;
//           T-098: `ceiling` alone is shown to the investigation's creator beside a restricted status (SSE: the creating
//           manager's events read restricted/ceiling, a second outlet-1 manager's restricted/null, the owner's the real status)
//   item 4  the ceiling is re-checked before every plan step: the owner's ceiling lowered to `step` mid-plan, or the
//           member demoted to staff mid-plan → 1 step, stop_reason scope (paired: unchanged → 2 steps)
//   item 5  linking the narration moves the investigation (updated_at ≥ the answer's time, so SSE re-reads it); a step's
//           taint comes from the stored answer too: intel stores a non-template answer and its response is lost → tainted
//           (paired: a normal response → untainted)
//   item 6  the plan estimate is minted under the investigation's outlet scope ({o1} → {o1}; whole scope → {*})
// Expected values are hand-written. Synthetic data only.
import { serve } from "@hono/node-server";
import { createLogger } from "@munim/config";
import { InvestigationsListResponse, InvestigationView, NarrateRequest } from "@munim/contracts/investigations";
import { type TestDb, uuidv7 } from "@munim/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalIdp } from "../src/auth/local-idp.ts";
import { createApp, TENANT_HEADER, type Deps } from "../src/app.ts";
import { testKeys } from "../src/commit/testkit.ts";
import { configureInternal } from "../src/internal/index.ts";
import { configureInvestigations, type NarratePort } from "../src/modules/investigations/index.ts";
import { closeStream, configureStream } from "../src/stream/index.ts";
import { openDb } from "./db.ts";
import { buildTenant, type Tenant } from "./world.ts";

const idp = createLocalIdp();
const keys = testKeys();
const SECRET = "rd-test-service-secret-not-real-0123456789abcdef";
const MONTH = `${new Date().toISOString().slice(0, 7)}-01`;
const PARAMS = { period_month: "2026-09-01", compare_month: "2026-08-01" };
let db: TestDb;
let pools: { core: pg.Pool; svc: pg.Pool };
let deps: Deps;
let app: Awaited<ReturnType<typeof createApp>>;
const servers: Array<ReturnType<typeof serve>> = [];

type Res = Omit<Response, "json"> & { json(): Promise<any> };
interface T extends Tenant { staffSub: string; wide: string; wideSub: string }

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
const create = async (t: T, sub: string, mode: string, extra: Record<string, unknown> = {}) => {
  const id = uuidv7();
  expect((await call(t, sub, "/v1/investigations", { investigation_id: id, playbook_id: "margin_fall", params: PARAMS, mode, ...extra })).status).toBe(201);
  return id;
};
const view = async (t: T, sub: string, id: string) => {
  const r = await call(t, sub, `/v1/investigations/${id}`);
  expect(r.status).toBe(200);
  return InvestigationView.parse(await r.json());
};
const row = async (id: string) =>
  (await db.admin<{ status: string; stop_reason: string | null; steps_done: number }>(`SELECT status, stop_reason, steps_done FROM core.investigation WHERE id = $1`, [id])).rows[0]!;
const plantOpen = (id: string) => db.admin(`UPDATE core.investigation SET status = 'open' WHERE id = $1`, [id]);
const plant = (sql: string) => db.admin(`BEGIN; SET LOCAL session_replication_role = replica; ${sql}; COMMIT;`);
const ceiling = (t: T, role: string, mode_ceiling: string) =>
  call(t, t.ownerSub, "/v1/ai/policy/ceiling", { command_id: uuidv7(), idempotency_key: `rd-${uuidv7()}`, type: "ai_policy.ceiling.set.v1", payload: { role, mode_ceiling } });

/** A fake intel storing core's template (optionally reworded), then running `during(n)`; `lose` throws after storing. */
function fakeIntel(o: { during?: (n: number) => Promise<void>; reword?: boolean; lose?: boolean } = {}) {
  let n = 0;
  const port: NarratePort = async (token, raw) => {
    const req = NarrateRequest.parse(raw);
    n++;
    const envelope = { answer_id: req.answer_id, abstained: false, reason_code: null,
      segments: req.items.map((i) => ({ text: o.reword ? `In short: ${i.template}` : i.template, refs: [...new Set(i.cells.map((c) => `snap:${/snap:([^·]+)/.exec(c.ref)![1]}`))] })) };
    const a = await internal(token, "answers", { question: req.question, envelope });
    if (a.status !== 201) throw new Error(`fake intel: answers ${a.status}`);
    await o.during?.(n);
    if (o.lose) throw new Error("connection reset");
    return { answer_id: req.answer_id, tainted: false, source: "model" };
  };
  configureInvestigations(deps, { keys, narrate: port });
}

async function tenant(label: string): Promise<T> {
  const w = await buildTenant(db, label);
  const t: T = { ...w, staffSub: `staff-${label}-${uuidv7()}`, wide: uuidv7(), wideSub: `wide-${label}-${uuidv7()}` };
  await db.withContext("munim_core", { tenant_id: t.tenant, outlet_ids: "*", role: "owner", member_id: t.owner, command_type: "tenancy.member.invite.v1" }, async (c) => {
    await c.query(`UPDATE core.member SET idp_sub = $3 WHERE tenant_id = $1 AND id = $2`, [t.tenant, t.staff, t.staffSub]);
    await c.query(`INSERT INTO core.member (tenant_id, id, idp_sub, name, email) VALUES ($1, $2, $3, 'Outlet Owner', $4)`, [t.tenant, t.wide, t.wideSub, `${t.wideSub}@example.test`]);
    await c.query(`INSERT INTO core.membership (tenant_id, member_id, role, outlet_ids) VALUES ($1, $2, 'owner', $3)`, [t.tenant, t.wide, [t.outlets[0], t.outlets[1]]]);
  });
  await db.admin(`INSERT INTO platform.llm_budget (tenant_id, month, limit_minor, currency) VALUES ($1, $2, 1000000000, $3)
                  ON CONFLICT (tenant_id, month) DO UPDATE SET limit_minor = EXCLUDED.limit_minor, currency = EXCLUDED.currency`, [t.tenant, MONTH, t.currency]);
  return t;
}

beforeAll(async () => {
  db = await openDb();
  pools = { core: db.pool("munim_core", 10), svc: db.pool("munim_svc", 6) };
  const config = { nodeEnv: "test", redact: (s: string) => s };
  deps = { pools, idp, storefronts: async () => null, config, log: createLogger(config, () => {}) };
  configureStream(deps, { connect: () => new pg.Client({ host: "127.0.0.1", port: db.port, database: db.database, user: "munim_core", password: db.password }) });
  app = await createApp(deps);
  configureInternal(deps, { serviceSecret: SECRET, keys, watchWindowMs: 0 });
});

afterAll(async () => {
  for (const s of servers) s.close();
  if (deps) await closeStream(deps);
  await pools?.core.end();
  await pools?.svc.end();
  await db?.stop();
});

type Ev = { type: string; id: string; data: Record<string, unknown> };
async function subscribe(t: T, sub: string, port: number) {
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

describe("R-D item 2: verdicts redacted per viewer", () => {
  let A: T;
  let id: string;
  beforeAll(async () => {
    A = await tenant("redact");
    fakeIntel();
    // A Plan run stopped at `waiting`: its stop_reason names the gate's verdict, so it is redacted with the status.
    id = await create(A, A.ownerSub, "plan", { outlet_scope: [A.outlets[0]] });
    expect((await call(A, A.ownerSub, `/v1/investigations/${id}:approve-plan`, {})).status).toBe(200);
    expect(await row(id)).toMatchObject({ status: "waiting", stop_reason: "waiting", steps_done: 1 });
  });

  it("the owner sees the verdicts, the narration and the status", async () => {
    const v = await view(A, A.ownerSub, id);
    expect([v.status, v.stop_reason]).toEqual(["waiting", "waiting"]);
    expect(v.checklist.find((c) => c.item_id === "data_complete")!.status).toBe("cannot_verify");
    expect(v.checklist.filter((c) => c.status === "restricted").length).toBe(0);
    expect(v.steps[0]!.narration!.envelope.segments.length).toBeGreaterThan(0);
    expect(v.resolved_refs.length).toBeGreaterThan(0);
  });

  it.each([["manager"], ["staff"]])("the outlet-1 %s sees the investigation, but every item, update and the status are restricted; 0 segments, 0 refs", async (who) => {
    const v = await view(A, who === "manager" ? A.managerSub : A.staffSub, id);
    expect([v.investigation_id, v.status, v.stop_reason, v.steps_done]).toEqual([id, "restricted", null, 1]);
    expect(v.checklist.map((c) => [c.status, c.refs.length, c.snapshot_ids.length])).toEqual(Array(7).fill(["restricted", 0, 0]));
    expect(v.steps[0]!.item_updates.every((u) => u.from === "restricted" && u.to === "restricted" && u.refs.length === 0)).toBe(true);
    expect([v.steps[0]!.narration!.envelope.segments.length, v.steps[0]!.narration!.signatures.length, v.resolved_refs.length]).toEqual([0, 0, 0]);
  });

  it("list: the manager's row reads restricted and ?status=waiting does not match it; the owner's does (paired)", async () => {
    const list = async (sub: string, qs: string) =>
      InvestigationsListResponse.parse(await (await call(A, sub, `/v1/investigations${qs}`)).json()).items.filter((i) => i.investigation_id === id);
    expect((await list(A.managerSub, "?limit=100")).map((i) => [i.status, i.stop_reason])).toEqual([["restricted", null]]);
    expect(await list(A.managerSub, "?status=waiting&limit=100")).toEqual([]);
    expect((await list(A.ownerSub, "?status=waiting&limit=100")).map((i) => [i.status, i.stop_reason])).toEqual([["waiting", "waiting"]]);
  });

  it("SSE: the manager's inbox.investigation events carry restricted, the owner's the real status", async () => {
    const server = await new Promise<{ port: number }>((ok) => { servers.push(serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (i) => ok({ port: i.port }))); });
    const owner = await subscribe(A, A.ownerSub, server.port);
    const mgr = await subscribe(A, A.managerSub, server.port);
    await Promise.all([owner.ready, mgr.ready]);
    // A fresh plan, approved while both listen: created, approved, step 1, stopped at waiting.
    const sid = await create(A, A.ownerSub, "plan", { outlet_scope: [A.outlets[0]] });
    const mine = (e: Ev) => e.type === "inbox.investigation" && e.id === sid;
    // A feed sends one event per `updated_at` it reads, so a change that commits before its first read of the new row folds both
    // states into one event: wait for the creation on both before approving, or `>= 2` below races the runner's speed.
    expect(await until(() => owner.events.some(mine) && mgr.events.some(mine), 15_000)).toBe(true);
    expect((await call(A, A.ownerSub, `/v1/investigations/${sid}:approve-plan`, {})).status).toBe(200);
    expect(await until(() => owner.events.some((e) => mine(e) && e.data.stop_reason === "waiting") && mgr.events.filter(mine).length >= 2, 15_000)).toBe(true);
    expect(owner.events.filter(mine).some((e) => e.data.status === "waiting")).toBe(true);
    expect(new Set(mgr.events.filter(mine).map((e) => `${e.data.status}/${e.data.stop_reason}`))).toEqual(new Set(["restricted/null"]));
    owner.close();
    mgr.close();
  });

  it("T-098 SSE: a ceiling stop reads restricted/ceiling to the creating manager, restricted/null to another manager, the real status to the owner", async () => {
    const mgr2Sub = `manager2-${uuidv7()}`;
    await db.withContext("munim_core", { tenant_id: A.tenant, outlet_ids: "*", role: "owner", member_id: A.owner, command_type: "tenancy.member.invite.v1" }, async (c) => {
      const mgr2 = uuidv7();
      await c.query(`INSERT INTO core.member (tenant_id, id, idp_sub, name, email) VALUES ($1, $2, $3, 'Second Manager', $4)`, [A.tenant, mgr2, mgr2Sub, `${mgr2Sub}@example.test`]);
      await c.query(`INSERT INTO core.membership (tenant_id, member_id, role, outlet_ids) VALUES ($1, $2, 'manager', $3)`, [A.tenant, mgr2, [A.outlets[0]]]);
    });
    const server = await new Promise<{ port: number }>((ok) => { servers.push(serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (i) => ok({ port: i.port }))); });
    const owner = await subscribe(A, A.ownerSub, server.port);
    const mgr = await subscribe(A, A.managerSub, server.port);
    const other = await subscribe(A, mgr2Sub, server.port);
    await Promise.all([owner.ready, mgr.ready, other.ready]);
    const cid = await create(A, A.managerSub, "plan");
    // Each viewer must have the creation before the stop commits: a feed sends one event per `updated_at` it reads, so a stop that
    // lands before a feed's first read of the new row folds the two states into one event and the pairs below never both arrive.
    const born = (e: Ev) => e.type === "inbox.investigation" && e.id === cid;
    expect(await until(() => [owner, mgr, other].every((s) => s.events.some(born)), 15_000)).toBe(true);
    // core-worker's ceiling stop, as auto.ts writes it (a plan row keeps its mode; 0027).
    await db.withContext("munim_svc", { tenant_id: A.tenant, outlet_ids: "*" }, (c) =>
      c.query(`UPDATE core.investigation SET stop_reason = 'ceiling' WHERE id = $1`, [cid]));
    const mine = (e: Ev) => e.type === "inbox.investigation" && e.id === cid && e.data.stop_reason !== null;
    const ceil = (e: Ev) => e.type === "inbox.investigation" && e.id === cid && e.data.status === "restricted";
    expect(await until(() => mgr.events.some(mine) && owner.events.some(mine) && other.events.filter(ceil).length >= 2, 15_000)).toBe(true);
    const shown = (s: { events: Ev[] }) => [...new Set(s.events.filter((e) => e.type === "inbox.investigation" && e.id === cid).map((e) => `${e.data.status}/${e.data.stop_reason}`))].sort();
    expect(shown(mgr)).toEqual(["restricted/ceiling", "restricted/null"]);
    expect(shown(other)).toEqual(["restricted/null"]);
    expect(shown(owner)).toEqual(["open/ceiling", "open/null"]);
    owner.close();
    mgr.close();
    other.close();
  });
});

describe("R-D item 4: the ceiling is re-checked before every plan step", () => {
  const run = async (mid: (t: T) => Promise<unknown>) => {
    const A = await tenant(`ceiling-${uuidv7()}`);
    let id = "";
    fakeIntel({ during: async (n) => { if (n === 1) { await plantOpen(id); await mid(A); } } });
    id = await create(A, A.wideSub, "plan");
    expect((await call(A, A.wideSub, `/v1/investigations/${id}:approve-plan`, {})).status).toBe(200);
    return row(id);
  };
  it("unchanged → 2 steps (paired accept)", async () => {
    expect(await run(async () => {})).toMatchObject({ steps_done: 2, stop_reason: "waiting" });
  });
  it("the owner role's ceiling lowered to step mid-plan → 1 step, stop_reason scope", async () => {
    expect(await run(async (A) => expect((await ceiling(A, "owner", "step")).status).toBe(200))).toMatchObject({ status: "open", steps_done: 1, stop_reason: "scope" });
  });
  it("the member demoted to staff mid-plan → 1 step, stop_reason scope", async () => {
    expect(await run((A) => plant(`UPDATE core.membership SET role = 'staff' WHERE tenant_id = '${A.tenant}' AND member_id = '${A.wide}'`)))
      .toMatchObject({ steps_done: 1, stop_reason: "scope" });
  });
});

describe("R-D item 5: narration linking and taint", () => {
  it("linking the narration moves the investigation: updated_at ≥ the answer's created_at", async () => {
    const A = await tenant("link");
    fakeIntel();
    const id = await create(A, A.ownerSub, "step");
    expect((await call(A, A.ownerSub, `/v1/investigations/${id}:continue`, { step_no: 1 })).status).toBe(200);
    const r = (await db.admin<{ moved: boolean; linked: boolean }>(
      `SELECT i.updated_at >= a.created_at AS moved, s.summary_answer_id IS NOT NULL AS linked
         FROM core.investigation i JOIN core.investigation_step s ON s.investigation_id = i.id AND s.step_no = 1
         JOIN intel.answer a ON a.tenant_id = s.tenant_id AND a.id = s.summary_answer_id WHERE i.id = $1`, [id])).rows[0]!;
    expect(r).toEqual({ moved: true, linked: true });
  });
  it("intel stores a reworded answer and its response is lost → the step is tainted; a normal response → untainted (paired)", async () => {
    const A = await tenant("taint");
    const taint = async (o: Parameters<typeof fakeIntel>[0]) => {
      fakeIntel(o);
      const id = await create(A, A.ownerSub, "step");
      expect((await call(A, A.ownerSub, `/v1/investigations/${id}:continue`, { step_no: 1 })).status).toBe(200);
      return (await db.admin<{ tainted: boolean; linked: boolean }>(
        `SELECT tainted, summary_answer_id IS NOT NULL AS linked FROM core.investigation_step WHERE investigation_id = $1`, [id])).rows[0]!;
    };
    expect(await taint({ reword: true, lose: true })).toEqual({ tainted: true, linked: true });
    expect(await taint({ reword: true })).toEqual({ tainted: false, linked: true });
  });
});

describe("R-D item 6: the plan estimate is minted under the investigation's scope", () => {
  it("an outlet-1 plan by the all-outlet owner → the estimate's scope is {o1}; a whole-scope plan → {*}", async () => {
    const A = await tenant("estimate");
    const scopeOf = async (id: string) => (await db.admin<{ s: string[] }>(
      `SELECT outlet_scope::text[] AS s FROM evidence.snapshot WHERE template_id = 'intel.investigation_cost_estimate' AND params ->> 'investigation_id' = $1`, [id])).rows.map((r) => r.s);
    expect(await scopeOf(await create(A, A.ownerSub, "plan", { outlet_scope: [A.outlets[0]] }))).toEqual([[A.outlets[0]]]);
    expect(await scopeOf(await create(A, A.ownerSub, "plan"))).toEqual([["*"]]);
  });
});
