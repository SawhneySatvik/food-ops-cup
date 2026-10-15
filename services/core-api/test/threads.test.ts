// T-088a gates — threads and addressing, core half (R45 F9), through the real app on embedded Postgres. intel is
// mocked at its boundary only (the AskPort): the fake stores its answer through the REAL internal API with the run
// token core minted (snapshot mint + /answers, so core's validator runs), then returns {answer_id, tainted}.
//   (1) 12 hand-labelled mention cases; unknown / Manager / service → no addressing (the Manager answers)
//   (2) gapless turns under 2 concurrent asks (both land: k+1, k+2); a stale explicit turn_no → MB014 → 409
//   (3) a thread outside the viewer's outlet scope → 404 (GET and ask), paired with accepts
//   (4) a tainted turn inside the last 3 → block tainted: true; the next turn carries it
//   (4b) planted: the tainted turn aged out of the last 3 → 0 of its segments in the summary and tainted: false
//   (5) intel's payloads hold 0 signature strings; the response holds exactly 1 signature, composed by core
//   (6) the routes: ROUTES entries, request/response parse, list ?specialist=
// Expected values are hand-written here, never read back from the code under test. Synthetic data only.
import { createLogger } from "@munim/config";
import { Snapshot } from "@munim/contracts";
import { AskRequest, AskResponse, IntelAskResponse, ROUTES, ThreadView, ThreadsListResponse } from "@munim/contracts/threads";
import { type TestDb, uuidv7 } from "@munim/db";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalIdp } from "../src/auth/local-idp.ts";
import { createApp, TENANT_HEADER, type Deps } from "../src/app.ts";
import { svcTx, testKeys } from "../src/commit/testkit.ts";
import { configureInternal } from "../src/internal/index.ts";
import { fromSqlState } from "../src/lib/errors.ts";
import { addressedTo, buildSummary, configureThreads, refreshSummary, type SummaryTurn, threadBlock } from "../src/modules/threads/index.ts";
import { mintRunToken } from "../src/runtoken/index.ts";
import { openDb } from "./db.ts";
import { buildTenant, type Tenant } from "./world.ts";

const idp = createLocalIdp();
const keys = testKeys();
const SECRET = "t088a-test-service-secret-not-real-0123456789abcdef";
let db: TestDb;
let pools: { core: pg.Pool; svc: pg.Pool };
let deps: Deps;
let app: Awaited<ReturnType<typeof createApp>>;
let A: Tenant;
let B: Tenant;
/** A second manager of A, scoped to outlet 2 only. */
const manager2 = uuidv7();
const manager2Sub = `manager2-${uuidv7()}`;

type Res = Omit<Response, "json"> & { json(): Promise<any> };
const one = async <R extends pg.QueryResultRow>(sql: string, params: unknown[] = []) => (await db.admin(sql, params)).rows[0] as R;
const count = async (sql: string, params: unknown[] = []) => Number((await one<{ n: string }>(sql, params)).n);

const asMember = async (t: Tenant, sub: string, path: string, body?: unknown): Promise<Res> =>
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

// ---- the fake intel (AskPort) ----------------------------------------------------------------------------------------
interface Fake {
  tainted: boolean;
  /** Return this answer id instead of core's handle. */
  answerId?: string;
  /** Store the answer under another run (a token core did not mint for this ask). */
  foreignRun?: Tenant;
  /** Store the answer under another question text than the member's. */
  question?: string;
  /** Extra fields on the port response (e.g. a signature intel must never send). */
  extra?: Record<string, unknown>;
  /** Wait here before answering (concurrency gate). */
  hold?: Promise<void>;
  /** R47 D5: the answer offers this follow-up; `forge`: its cited cell names a snapshot that does not exist (core abstains). */
  followUp?: string;
  forge?: boolean;
  /** Every JSON body the fake sent or returned (gate 5) and every request core sent it. */
  sent: string[];
  received: any[];
}
let fake: Fake = { tainted: false, sent: [], received: [] };

async function fakeIntel(token: string, body: any): Promise<unknown> {
  const f = fake;
  f.received.push(body);
  if (f.hold) await f.hold;
  const tok = f.foreignRun ? (await mintRunToken({ ...keys, svc: svcTx(db) }, { tenantId: f.foreignRun.tenant, outletScope: ["*"], trigger: "ask", actor: f.foreignRun.owner })).token : token;
  const s = await internal(tok, "snapshots", { template_id: "inventory.below_reorder", params: {} });
  if (s.status !== 201) throw new Error(`fake intel: snapshot ${s.status}`);
  const snap = f.forge ? uuidv7() : Snapshot.parse(await s.json()).snapshot_id;
  const answer = {
    question: f.question ?? body.question,
    envelope: {
      answer_id: body.answer_id, abstained: false, ...(f.followUp ? { follow_up: f.followUp } : {}),
      segments: [
        { text: `Stock of ⟨snap:${snap}·0·ingredient_name⟩ is low.`, refs: [`snap:${snap}`] },
        { text: `Its reorder level is ⟨snap:${snap}·0·min_qty_milli⟩.`, refs: [`snap:${snap}`] },
      ],
    },
  };
  f.sent.push(JSON.stringify(answer));
  const a = await internal(tok, "answers", answer);
  if (a.status !== 201) throw new Error(`fake intel: answers ${a.status}`);
  const out = { answer_id: f.answerId ?? body.answer_id, tainted: f.tainted, ...f.extra };
  f.sent.push(JSON.stringify(out));
  return out;
}
const ask = (t: Tenant, sub: string, question: string, thread_id?: string, f: Partial<Fake> = {}, extra: Record<string, unknown> = {}) => {
  fake = { tainted: false, sent: [], received: [], ...f };
  return asMember(t, sub, "/v1/ask", { question, ...(thread_id ? { thread_id } : {}), ...extra });
};
const threads = () => count(`SELECT count(*) n FROM core.ai_thread WHERE tenant_id = $1`, [A.tenant]);
const turns = () => count(`SELECT count(*) n FROM core.ai_thread_turn WHERE tenant_id = $1`, [A.tenant]);

beforeAll(async () => {
  db = await openDb();
  A = await buildTenant(db, "a");
  B = await buildTenant(db, "b");
  await db.withContext("munim_core", { tenant_id: A.tenant, outlet_ids: "*", role: "owner", member_id: A.owner, command_type: "tenancy.member.invite.v1" }, async (c) => {
    await c.query(`INSERT INTO core.member (tenant_id, id, idp_sub, name, email) VALUES ($1, $2, $3, 'Manager two', 'manager2@example.test')`, [A.tenant, manager2, manager2Sub]);
    await c.query(`INSERT INTO core.membership (tenant_id, member_id, role, outlet_ids) VALUES ($1, $2, 'manager', $3)`, [A.tenant, manager2, [A.outlets[1]]]);
  });
  pools = { core: db.pool("munim_core", 8), svc: db.pool("munim_svc", 6) };
  const config = { nodeEnv: "test", redact: (s: string) => s };
  deps = { pools, idp, storefronts: async () => null, config, log: createLogger(config, () => {}) };
  app = await createApp(deps);
  configureInternal(deps, { serviceSecret: SECRET, keys, watchWindowMs: 0 });
});

afterAll(async () => {
  await pools?.core.end();
  await pools?.svc.end();
  await db?.stop();
});

describe("(1) leading @Name addressing — 12 hand-labelled cases", () => {
  const CASES: Array<[string, string | null]> = [
    ["@Finance why did the payout fall short?", "finance"],
    ["@finance why did the payout fall short?", "finance"],
    ["@Menu which dish lost margin?", "catalogue"],
    ["Please email a@b.c about the invoice", null],
    ["@Foo what happened?", null],
    ["  @Kitchen, are tickets slow today?", "kitchen"],
    ["@PEOPLE: who is on overtime?", "people"],
    ["Ask @Finance about the payout", null],
    ["@Manager what happened today?", null],
    ["@forecast next week's covers?", null],
    ["@b.c hello", null],
    ["@inventory_purchasing what is below par?", "inventory_purchasing"],
  ];
  it("there are exactly 12 cases", () => expect(CASES.length).toBe(12));
  it.each(CASES)("%j → %s", (q, want) => expect(addressedTo(q)).toBe(want));
});

describe("the ask path", () => {
  it("unconfigured → 503 and nothing written", async () => {
    const before = [await threads(), await turns()];
    expect((await ask(A, A.ownerSub, "@Finance anything?")).status).toBe(503);
    expect([await threads(), await turns()]).toEqual(before);
    configureThreads(deps, { keys, intel: fakeIntel });
  });

  it("(5) @Finance → a finance thread; the response carries exactly 1 signature, intel's payloads 0", async () => {
    const r = await ask(A, A.ownerSub, "@Finance why is stock low?");
    expect(r.status).toBe(200);
    const text = await r.text();
    const body = AskResponse.parse(JSON.parse(text));
    expect(body.turn).toMatchObject({ turn_no: 1, addressed_to: "finance", tainted: false });
    expect(body.answer.signature).toEqual({ key: "answer.signature.via_manager", specialist: "finance", name_key: "specialist.finance.name" });
    expect(text.match(/"signature"/g)?.length).toBe(1);
    expect(body.answer.resolved_refs.length).toBe(2); // the two cells the fake cited
    expect(fake.received[0]).toMatchObject({ addressed_to: "finance", thread: null });
    expect(fake.sent.length).toBe(2);
    expect(fake.sent.filter((s) => /via Manager|signature/i.test(s)).length).toBe(0);
    expect(await one(`SELECT specialist FROM core.ai_thread WHERE id = $1`, [body.thread_id])).toEqual({ specialist: "finance" });
  });

  it("a plain question → the main conversation, signed by the Manager; in a finance thread an unaddressed turn is finance's", async () => {
    const main = AskResponse.parse(await (await ask(A, A.ownerSub, "What is below reorder?")).json());
    expect(main.turn.addressed_to).toBeNull();
    expect(main.answer.signature.key).toBe("answer.signature.manager");
    const fin = AskResponse.parse(await (await ask(A, A.ownerSub, "@finance first")).json());
    const next = AskResponse.parse(await (await ask(A, A.ownerSub, "and then?", fin.thread_id)).json());
    expect(next.thread_id).toBe(fin.thread_id);
    expect(next.turn).toMatchObject({ turn_no: 2, addressed_to: "finance" });
    expect(fake.received[0].thread.thread_id).toBe(fin.thread_id);
  });

  it("intel returning another answer id, or an answer stored under another run → 503, no turn", async () => {
    const before = await turns();
    expect((await ask(A, A.ownerSub, "q", undefined, { answerId: uuidv7() })).status).toBe(503);
    expect((await ask(A, A.ownerSub, "q", undefined, { foreignRun: A })).status).toBe(503);
    expect(await turns()).toBe(before);
    expect((await ask(A, A.ownerSub, "q")).status).toBe(200); // the accept
  });

  it("(5) a signature on intel's response, or an answer stored under another question text → 503, no turn", async () => {
    const before = await turns();
    expect((await ask(A, A.ownerSub, " q", undefined, { extra: { signature: "Finance · via Manager" } })).status).toBe(503);
    expect((await ask(A, A.ownerSub, " q", undefined, { question: " q 99" })).status).toBe(503);
    expect(await turns()).toBe(before);
    expect((await ask(A, A.ownerSub, " q")).status).toBe(200); // the accept
  });

  it("R47 D5: the member's `deep` flag reaches intel (false when absent; a non-boolean 400s before intel is called)", async () => {
    expect((await ask(A, A.ownerSub, "Look into the margin")).status).toBe(200);
    expect(fake.received.map((b) => b.deep)).toEqual([false]);
    expect((await ask(A, A.ownerSub, "Look into the margin", undefined, {}, { deep: true })).status).toBe(200);
    expect(fake.received.map((b) => b.deep)).toEqual([true]);
    expect((await ask(A, A.ownerSub, "Look into the margin", undefined, {}, { deep: "yes" })).status).toBe(400);
    expect(fake.received).toEqual([]);
  });

  it("R47 D5: an answer's follow_up is stored and served — on a validated answer and on core's own abstention (a forged ref); none when not offered", async () => {
    const view = async (f: Partial<Fake>) => AskResponse.parse(await (await ask(A, A.ownerSub, "Look into the margin", undefined, f)).json()).answer.envelope;
    const [ok, forged, plain] = [await view({ followUp: "dig_deeper" }), await view({ followUp: "dig_deeper", forge: true }), await view({ forge: true })];
    expect([ok.abstained, ok.follow_up]).toEqual([false, "dig_deeper"]);
    expect([forged.abstained, forged.segments, forged.follow_up]).toEqual([true, [], "dig_deeper"]);
    expect([plain.abstained, plain.follow_up]).toEqual([true, undefined]);
  });

  it("bad bodies → 400 (empty question, a non-uuid thread id, an extra field)", async () => {
    for (const b of [{ question: "" }, { question: "x", thread_id: "nope" }, { question: "x", tenant_id: A.tenant }]) {
      expect((await asMember(A, A.ownerSub, "/v1/ask", b)).status).toBe(400);
    }
  });
});

describe("(2) gapless turns", () => {
  it("2 concurrent asks on one thread both land, as k+1 and k+2; the thread's turns have no gap", async () => {
    const t = AskResponse.parse(await (await ask(A, A.ownerSub, "start")).json()).thread_id;
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    fake = { tainted: false, sent: [], received: [], hold };
    const shared = fake;
    const p1 = asMember(A, A.ownerSub, "/v1/ask", { question: "one", thread_id: t });
    const p2 = asMember(A, A.ownerSub, "/v1/ask", { question: "two", thread_id: t });
    while (shared.received.length < 2) await new Promise((r) => setTimeout(r, 10)); // both read the same last turn
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    const nos = [(await r1.json()).turn.turn_no, (await r2.json()).turn.turn_no].sort();
    expect(nos).toEqual([2, 3]);
    const rows = (await db.admin(`SELECT turn_no FROM core.ai_thread_turn WHERE thread_id = $1 ORDER BY turn_no`, [t])).rows.map((x) => x.turn_no);
    expect(rows).toEqual([1, 2, 3]);
  });

  it("a stale explicit turn_no → MB014 → 409 sequence_gap (and the next number is accepted)", async () => {
    const t = AskResponse.parse(await (await ask(A, A.ownerSub, "start")).json()).thread_id;
    const insert = (n: number) => db.withContext("munim_core", { tenant_id: A.tenant, outlet_ids: "*", role: "owner", member_id: A.owner }, (c) =>
      c.query(`INSERT INTO core.ai_thread_turn (tenant_id, thread_id, turn_no, id, member_id) VALUES ($1, $2, $3, $4, $5)`, [A.tenant, t, n, uuidv7(), A.owner]));
    const err = await insert(1).then(() => null, (e: unknown) => e);
    expect((err as { code?: string }).code).toBe("MB014");
    expect(fromSqlState(err)?.status).toBe(409);
    expect(fromSqlState(err)?.code).toBe("sequence_gap");
    await insert(2);
  });
});

describe("(3) outlet scope", () => {
  let t1 = "";
  let tAll = "";
  beforeAll(async () => {
    t1 = AskResponse.parse(await (await ask(A, A.managerSub, "@Kitchen outlet one?")).json()).thread_id;
    tAll = AskResponse.parse(await (await ask(A, A.ownerSub, "all outlets?")).json()).thread_id;
  });
  it("an outlet-1 thread: its manager and the owner → 200; the outlet-2 manager → 404 (GET and ask); another tenant → 404", async () => {
    expect((await asMember(A, A.managerSub, `/v1/threads/${t1}`)).status).toBe(200);
    expect((await asMember(A, A.ownerSub, `/v1/threads/${t1}`)).status).toBe(200);
    expect((await asMember(A, manager2Sub, `/v1/threads/${t1}`)).status).toBe(404);
    const before = await turns();
    expect((await ask(A, manager2Sub, "let me in", t1)).status).toBe(404);
    expect(fake.received.length).toBe(0); // refused before any run
    expect(await turns()).toBe(before);
    expect((await asMember(B, B.ownerSub, `/v1/threads/${t1}`)).status).toBe(404);
    expect((await ask(A, A.ownerSub, "owner appends", t1)).status).toBe(200);
  });
  it("an all-outlet thread → 404 for an outlet-1 manager; its run used the thread's scope", async () => {
    expect((await asMember(A, A.managerSub, `/v1/threads/${tAll}`)).status).toBe(404);
    expect((await ask(A, A.managerSub, "me too", tAll)).status).toBe(404);
    const r = await one<{ s: string[] }>(`SELECT r.outlet_scope::text[] s FROM core.ai_thread_turn t JOIN intel.answer a ON a.id = t.answer_id JOIN intel.run r ON r.id = a.run_id WHERE t.thread_id = $1 AND t.turn_no = 2`, [t1]);
    expect(r.s).toEqual([A.outlets[0]]); // the owner's append ran in the thread's scope, not the owner's '*'
  });
  it("lists only threads the viewer's scope covers", async () => {
    const ids = (sub: string) => asMember(A, sub, "/v1/threads?limit=100").then(async (r) => ThreadsListResponse.parse(await r.json()).items.map((i) => i.thread_id));
    expect(await ids(A.managerSub)).toContain(t1);
    expect(await ids(A.managerSub)).not.toContain(tAll);
    expect(await ids(manager2Sub)).not.toContain(t1);
    expect(await ids(A.ownerSub)).toEqual(expect.arrayContaining([t1, tAll]));
  });
});

describe("(4) taint across turns", () => {
  it("a tainted turn inside the last 3 → block tainted: true, excluded from the summary; the next turn is tainted by the carry", async () => {
    const t = AskResponse.parse(await (await ask(A, A.ownerSub, "@Finance one")).json()).thread_id;
    const second = AskResponse.parse(await (await ask(A, A.ownerSub, "two", t, { tainted: true })).json());
    expect(second.turn.tainted).toBe(true);
    const third = AskResponse.parse(await (await ask(A, A.ownerSub, "three", t, { tainted: false })).json());
    expect(fake.received[0].thread.tainted).toBe(true); // the run started from a tainted excerpt…
    expect(third.turn.tainted).toBe(true); // …so its turn is tainted although intel reported false
    const view = ThreadView.parse(await (await asMember(A, A.ownerSub, `/v1/threads/${t}`)).json());
    expect(view.summary.map((s) => s.turn_no)).toEqual([1, 1]);
    const block = await db.withContext("munim_svc", { tenant_id: A.tenant, outlet_ids: "*", role: "service" }, (c) => threadBlock(c, t));
    expect(block).toEqual({ thread_id: t, summary_refs: view.summary, last_turn_ids: view.turns.map((x) => x.turn_id), tainted: true });
  });
});

// Planted turns (5 turns × 2 cited segments; turn 2 tainted): the hand-computed summary is turns 1, 3, 4, 5 = 8 segments.
function planted(answerIds: string[]): SummaryTurn[] {
  return answerIds.map((id, i) => ({
    turn_no: i + 1, answer_id: id, tainted: i + 1 === 2,
    envelope: { abstained: false, segments: [{ refs: [`snap:${id}`] }, { refs: [`snap:${id}`] }] },
  }));
}

describe("(4b) the tainted turn aged out of the last 3", () => {
  it("pure: 0 segments of turn 2, 8 kept, oldest first", () => {
    const ids = [1, 2, 3, 4, 5].map(() => uuidv7());
    const s = buildSummary(planted(ids));
    expect(s.map((x) => x.turn_no)).toEqual([1, 1, 3, 3, 4, 4, 5, 5]);
    expect(s.filter((x) => x.answer_id === ids[1]).length).toBe(0);
  });
  it("pure: the cap drops the oldest; an abstained or unanswered turn adds nothing", () => {
    const ids = [1, 2, 3, 4, 5, 6].map(() => uuidv7());
    const turns = planted(ids).map((t) => (t.turn_no === 4 ? { ...t, envelope: { abstained: true, segments: [] } } : t.turn_no === 5 ? { ...t, answer_id: null } : t));
    expect(buildSummary(turns).map((x) => `${x.turn_no}.${x.segment}`)).toEqual(["1.0", "1.1", "3.0", "3.1", "6.0", "6.1"]);
    const many = [1, 2, 3, 4, 5, 6].map(() => uuidv7());
    expect(buildSummary(planted(many).map((t) => ({ ...t, tainted: false }))).map((x) => x.turn_no)).toEqual([3, 3, 4, 4, 5, 5, 6, 6]);
  });
  it("stored: summary has 0 segments of turn 2, last_turn_ids = turns 3–5, tainted: false", async () => {
    const thread = uuidv7();
    const { claims } = await mintRunToken({ ...keys, svc: svcTx(db) }, { tenantId: A.tenant, outletScope: ["*"], trigger: "ask", actor: A.owner });
    const answers = [1, 2, 3, 4, 5].map(() => uuidv7());
    const turnIds = [1, 2, 3, 4, 5].map(() => uuidv7());
    await db.withContext("munim_svc", { tenant_id: A.tenant, outlet_ids: "*", role: "service" }, async (c) => {
      for (const id of answers) {
        await c.query(`INSERT INTO intel.answer (tenant_id, id, run_id, question, asked_by, envelope, abstained) VALUES ($1, $2, $3, 'q', $4, $5, false)`,
          [A.tenant, id, claims.run_id, A.owner, { answer_id: id, abstained: false, segments: [{ text: "a", refs: [`snap:${id}`] }, { text: "b", refs: [`snap:${id}`] }] }]);
      }
    });
    const block = await db.withContext("munim_core", { tenant_id: A.tenant, outlet_ids: "*", role: "owner", member_id: A.owner }, async (c) => {
      await c.query(`INSERT INTO core.ai_thread (tenant_id, id, specialist, created_by, outlet_scope) VALUES ($1, $2, 'finance', $3, '{*}')`, [A.tenant, thread, A.owner]);
      for (let i = 0; i < 5; i++) {
        await c.query(`INSERT INTO core.ai_thread_turn (tenant_id, thread_id, turn_no, id, member_id, answer_id, tainted) VALUES ($1, $2, NULL, $3, $4, $5, $6)`,
          [A.tenant, thread, turnIds[i], A.owner, answers[i], i + 1 === 2]);
      }
      await refreshSummary(c, thread);
      return threadBlock(c, thread);
    });
    expect(block!.summary_refs.map((s) => s.turn_no)).toEqual([1, 1, 3, 3, 4, 4, 5, 5]);
    expect(block!.summary_refs.filter((s) => s.answer_id === answers[1]).length).toBe(0);
    expect(block!.last_turn_ids).toEqual(turnIds.slice(2));
    expect(block!.tainted).toBe(false);
  });
});

describe("(6) routes and parsing", () => {
  it("ROUTES: POST /v1/ask, GET /v1/threads, GET /v1/threads/{id}, all member-auth", () => {
    expect(ROUTES.map((r) => `${r.method.toUpperCase()} ${r.path} ${r.auth}`)).toEqual([
      "POST /v1/ask member", "GET /v1/threads member", "GET /v1/threads/{id} member",
    ]);
  });
  it("request / intel-response parse: accepts and refusals", () => {
    expect(AskRequest.safeParse({ question: "@Finance hi" }).success).toBe(true);
    expect(AskRequest.safeParse({ question: "   " }).success).toBe(false);
    expect(AskRequest.safeParse({ question: "x".repeat(2001) }).success).toBe(false);
    expect(IntelAskResponse.safeParse({ answer_id: uuidv7(), tainted: false }).success).toBe(true);
    expect(IntelAskResponse.safeParse({ answer_id: uuidv7(), tainted: false, signature: "Finance · via Manager" }).success).toBe(false);
  });
  it("?specialist=: a finance thread under finance, not under manager; a bad value → 400", async () => {
    const fin = AskResponse.parse(await (await ask(A, A.ownerSub, "@Finance list me")).json()).thread_id;
    const main = AskResponse.parse(await (await ask(A, A.ownerSub, "plain")).json()).thread_id;
    const list = async (s: string) => ThreadsListResponse.parse(await (await asMember(A, A.ownerSub, `/v1/threads?specialist=${s}&limit=100`)).json()).items.map((i) => i.thread_id);
    expect(await list("finance")).toContain(fin);
    expect(await list("finance")).not.toContain(main);
    expect(await list("manager")).toContain(main);
    expect(await list("manager")).not.toContain(fin);
    expect((await asMember(A, A.ownerSub, "/v1/threads?specialist=forecast")).status).toBe(400);
    expect((await asMember(A, A.ownerSub, `/v1/threads/${uuidv7()}`)).status).toBe(404);
  });
});
