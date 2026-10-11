// Threads and addressing, core half (ledger R45 F9, T-088a). Mounted by modules/index.ts.
//   POST /v1/ask {question, thread_id?}   → 200 {thread_id, turn, answer} (signed by core)
//   GET  /v1/threads?specialist=&cursor=&limit=   GET /v1/threads/{id}
// The ask, in order:
//   1. core parses a leading `@Name` (mention.ts; never a model); a turn in a specialist thread with no mention is
//      addressed to that thread's specialist.
//   2. an existing thread is read under the member's RLS (outside their scope → 404) with its run-frame block.
//   3. core mints an `ask` run (actor = the member, scope = the thread's — a new thread takes the member's) and
//      pre-assigns the answer id (the handle intel stores its answer under), then calls intel through the AskPort
//      (T-082b serves it). No port configured → 503 and nothing written.
//   4. one munim_core transaction under the member: the answer row must exist, belong to this run AND carry the
//      member's own question (the thread shows it back; intel never rewrites it — clause 2); a new thread is
//      inserted only now (no empty threads on failure); the turn is inserted ONCE with `turn_no` NULL (0020 numbers
//      it gaplessly under a per-thread lock), the answer id and `tainted` = intel's run taint OR the excerpt's taint
//      (a run whose context held a tainted turn is tainted — B1, without trusting intel alone); then the summary
//      is recomputed (summary.ts).
// Threads are operational rows (0020), written in the member's own request as munim_core; munim_svc only reads them.
// The signature is an i18n key + the specialist's name key, composed here; intel's payload has no field for it.
import { anyRefTokens, AnswerEnvelope, parseRef } from "@munim/contracts";
import { AskRequest, IntelAskResponse, SpecialistId } from "@munim/contracts/threads";
import { Hono, type Context } from "hono";
import { contextOf, requireMember } from "../../auth/resolve.ts";
import { uuidv7 } from "../../commit/index.ts";
import { withContext } from "../../lib/db.ts";
import { ApiError } from "../../lib/errors.ts";
import type { AppEnv, Deps } from "../../lib/types.ts";
import { endRun, mintRunTokenIn, type OutletScope, type Queryable, type RunTokenKeys } from "../../runtoken/index.ts";
import { type Cell, cellOf, loadSnapshots, type Member } from "../approvals/index.ts";
import { CURSOR_SQL, makeCursor, parseCursor, parseLimit } from "../findings/index.ts";
import { addressedTo } from "./mention.ts";
import { refreshSummary, type ThreadBlock, threadBlock } from "./summary.ts";

export { addressedTo } from "./mention.ts";
export { ASK_TIMEOUT_MS, createHttpAskPort, type HttpAskPortOptions } from "./askport.ts";
export { buildSummary, refreshSummary, type SummaryRef, type SummaryTurn, type ThreadBlock, threadBlock } from "./summary.ts";

/** core → intel `/ask` with the run token; resolves to intel's JSON body (validated here as `threads.intel-ask.response`). */
export type AskPort = (runToken: string, body: { answer_id: string; question: string; addressed_to: string | null; thread: ThreadBlock | null; deep: boolean }) => Promise<unknown>;
export interface ThreadsConfig { keys: RunTokenKeys; intel: AskPort }

const configs = new WeakMap<Deps, ThreadsConfig>();
/** Wires the ask into one composed app, keyed by that Deps object (as configureInternal). */
export function configureThreads(deps: Deps, cfg: ThreadsConfig): void {
  configs.set(deps, cfg);
}

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

function member(c: Context<AppEnv>): Member {
  const p = c.var.principal;
  if (p.kind !== "member") throw new ApiError("forbidden");
  return p;
}

const svc = <T>(deps: Deps, tenantId: string, scope: OutletScope, fn: (q: Queryable) => Promise<T>) =>
  withContext(deps.pools.svc, { tenant_id: tenantId, outlet_ids: scope[0] === "*" ? "*" : scope, role: "service" }, fn);

export function signatureOf(addressed: string | null) {
  return addressed
    ? { key: "answer.signature.via_manager" as const, specialist: addressed, name_key: `specialist.${addressed}.name` }
    : { key: "answer.signature.manager" as const, specialist: "manager", name_key: "specialist.manager.name" };
}

interface AnswerRow { answer_id: string; envelope: unknown; addressed_to: string | null }

/** The stored envelopes with every snapshot-cell ref this viewer can open (an unresolved ref is left out, so the
 *  renderer shows "cannot verify" for it) and core's signature. */
async function answerViews(c: Queryable, rows: AnswerRow[], m: Member) {
  const envs = rows.map((r) => AnswerEnvelope.parse(r.envelope));
  const refs = envs.map((e) => [...new Set(e.segments.flatMap((s) => [...s.text.normalize("NFC").matchAll(anyRefTokens())].map((x) => x[0])))]);
  const snapIds = refs.flat().map((r) => parseRef(r)).flatMap((p) => (p?.kind === "snap" ? [p.snapshot_id] : []));
  const snaps = await loadSnapshots(c, snapIds, m);
  return rows.map((r, i) => {
    const resolved: Array<{ ref: string; value: Cell }> = [];
    for (const ref of refs[i]!) {
      const cell = cellOf(ref, snaps);
      if (cell) resolved.push({ ref, value: cell.value });
    }
    return { answer_id: r.answer_id, envelope: envs[i]!, resolved_refs: resolved, signature: signatureOf(r.addressed_to) };
  });
}

interface ThreadRow { id: string; specialist: string | null; created_by: string; outlet_scope: string[]; created_at: Date; updated_at: Date }
const THREAD_COLS = `th.id, th.specialist, th.created_by, th.outlet_scope::text[] AS outlet_scope, th.created_at, th.updated_at`;
const itemView = (t: ThreadRow) => ({
  thread_id: t.id, specialist: t.specialist, created_by: t.created_by, outlet_scope: t.outlet_scope,
  created_at: t.created_at.toISOString(), updated_at: t.updated_at.toISOString(),
});

export const router = new Hono<AppEnv>()
  .post("/v1/ask", requireMember, async (c) => {
    const m = member(c);
    const deps = c.var.deps;
    const parsed = AskRequest.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) throw new ApiError("bad_request");
    const { question, thread_id, deep = false } = parsed.data;
    const cfg = configs.get(deps);
    if (!cfg) throw new ApiError("unavailable");
    const ctx = contextOf(m);

    const existing = thread_id === undefined ? null : await withContext(deps.pools.core, ctx, async (q) => {
      const r = await q.query<{ specialist: string | null; outlet_scope: string[] }>(
        `SELECT specialist, outlet_scope::text[] AS outlet_scope FROM core.ai_thread WHERE id = $1`, [thread_id]);
      return r.rows[0] ? { ...r.rows[0], block: (await threadBlock(q, thread_id))! } : null;
    });
    if (thread_id !== undefined && !existing) throw new ApiError("not_found");
    const scope = (existing ? existing.outlet_scope : m.outlet_ids === "*" ? ["*"] : m.outlet_ids) as OutletScope;
    if (scope.length === 0) throw new ApiError("forbidden");
    const addressed = addressedTo(question) ?? existing?.specialist ?? null;
    const block = existing?.block ?? null;

    const answerId = uuidv7();
    const { token, claims } = await svc(deps, m.tenant_id, scope, (q) =>
      mintRunTokenIn(q, cfg.keys, { tenantId: m.tenant_id, outletScope: scope, trigger: "ask", actor: m.member_id }));
    let reported: { answer_id: string; tainted: boolean };
    try {
      const out = IntelAskResponse.safeParse(await cfg.intel(token, { answer_id: answerId, question, addressed_to: addressed, thread: block, deep }));
      if (!out.success || out.data.answer_id !== answerId) throw new ApiError("unavailable");
      reported = out.data;
    } catch (e) {
      if (!(e instanceof ApiError)) deps.log("POST /v1/ask: intel call failed", e);
      throw new ApiError("unavailable");
    } finally {
      await endRun({ svc: (s, fn) => svc(deps, s.tenantId, s.outletScope, fn) }, m.tenant_id, claims.run_id);
    }
    const tainted = reported.tainted || (block?.tainted ?? false);

    return c.json(await withContext(deps.pools.core, ctx, async (q) => {
      const a = await q.query<{ envelope: unknown }>(`SELECT envelope FROM intel.answer WHERE id = $1 AND run_id = $2 AND question = $3`, [answerId, claims.run_id, question]);
      if (!a.rows[0]) throw new ApiError("unavailable");
      const threadId = thread_id ?? uuidv7();
      if (!existing) {
        await q.query(`INSERT INTO core.ai_thread (tenant_id, id, specialist, created_by, outlet_scope) VALUES ($1, $2, $3, $4, $5)`,
          [m.tenant_id, threadId, addressed, m.member_id, scope]);
      }
      const turnId = uuidv7();
      const t = await q.query<{ turn_no: number }>(
        `INSERT INTO core.ai_thread_turn (tenant_id, thread_id, turn_no, id, member_id, answer_id, addressed_to, tainted)
         VALUES ($1, $2, NULL, $3, $4, $5, $6, $7) RETURNING turn_no`,
        [m.tenant_id, threadId, turnId, m.member_id, answerId, addressed, tainted]);
      await refreshSummary(q, threadId);
      const [answer] = await answerViews(q, [{ answer_id: answerId, envelope: a.rows[0].envelope, addressed_to: addressed }], m);
      return { thread_id: threadId, turn: { turn_id: turnId, turn_no: t.rows[0]!.turn_no, addressed_to: addressed, tainted }, answer };
    }), 200);
  })
  .get("/v1/threads", requireMember, async (c) => {
    const m = member(c);
    const q = c.req.query();
    const limit = parseLimit(q.limit);
    const after = parseCursor(q.cursor);
    const specialist = q.specialist;
    if (limit === null || (q.cursor !== undefined && !after) || (specialist !== undefined && specialist !== "manager" && !SpecialistId.safeParse(specialist).success)) {
      throw new ApiError("bad_request");
    }
    return c.json(await withContext(c.var.deps.pools.core, contextOf(m), async (db) => {
      // A desk's threads (as b-87's desk page): the thread's own specialist, or any turn addressed to it.
      // `manager` = the main conversation (threads with no specialist).
      const r = await db.query<ThreadRow & { cursor: string }>(
        `SELECT ${THREAD_COLS}, ${CURSOR_SQL("th")} AS cursor FROM core.ai_thread th
          WHERE ($1::text IS NULL
                 OR ($1 = 'manager' AND th.specialist IS NULL)
                 OR th.specialist = $1
                 OR EXISTS (SELECT 1 FROM core.ai_thread_turn t WHERE t.tenant_id = th.tenant_id AND t.thread_id = th.id AND t.addressed_to = $1))
            AND ($2::timestamptz IS NULL OR (th.updated_at, th.id) < ($2::timestamptz, $3::uuid))
          ORDER BY th.updated_at DESC, th.id DESC LIMIT $4`,
        [specialist ?? null, after?.[0] ?? null, after?.[1] ?? null, limit + 1]);
      const page = r.rows.slice(0, limit);
      return { items: page.map(itemView), next_cursor: r.rows.length > limit ? makeCursor(page.at(-1)!.cursor) : null };
    }), 200);
  })
  .get(`/v1/threads/:id{${ID}}`, requireMember, async (c) => {
    const m = member(c);
    const id = c.req.param("id");
    const out = await withContext(c.var.deps.pools.core, contextOf(m), async (db) => {
      const th = await db.query<ThreadRow & { summary: unknown[] }>(`SELECT ${THREAD_COLS}, th.summary FROM core.ai_thread th WHERE th.id = $1`, [id]);
      if (!th.rows[0]) return null;
      const turns = await db.query<{ id: string; turn_no: number; member_id: string; addressed_to: string | null; tainted: boolean; created_at: Date;
        answer_id: string | null; question: string | null; envelope: unknown }>(
        `SELECT t.id, t.turn_no, t.member_id, t.addressed_to, t.tainted, t.created_at, t.answer_id, a.question, a.envelope
           FROM core.ai_thread_turn t LEFT JOIN intel.answer a ON a.tenant_id = t.tenant_id AND a.id = t.answer_id
          WHERE t.thread_id = $1 ORDER BY t.turn_no`, [id]);
      const answered = turns.rows.filter((t) => t.answer_id && t.envelope);
      const views = await answerViews(db, answered.map((t) => ({ answer_id: t.answer_id!, envelope: t.envelope, addressed_to: t.addressed_to })), m);
      const byId = new Map(views.map((v) => [v.answer_id, v]));
      return {
        ...itemView(th.rows[0]),
        summary: th.rows[0].summary,
        turns: turns.rows.map((t) => ({
          turn_id: t.id, turn_no: t.turn_no, member_id: t.member_id, addressed_to: t.addressed_to, tainted: t.tainted, question: t.question,
          answer: (t.answer_id && byId.get(t.answer_id)) || null, created_at: t.created_at.toISOString(),
        })),
      };
    });
    if (!out) throw new ApiError("not_found");
    return c.json(out, 200);
  });
