// Approvals module (T-008): the member routes over core.draft. Mounted by modules/index.ts.
//   GET  /v1/drafts?status=&outlet=&source=&limit=&cursor=   (status: proposed (default) | … | decided)
//   GET  /v1/drafts/{id}
//   POST /v1/drafts/{id}:approve   body: drafts.approve.v1 command envelope
//   POST /v1/drafts/{id}:reject    body: drafts.reject.v1 command envelope
// Draftable command handlers live in their owning modules and register through registerDraftHandler.
import { Hono, type Context } from "hono";
import { requireMember } from "../../auth/resolve.ts";
import { ApiError } from "../../lib/errors.ts";
import type { AppEnv } from "../../lib/types.ts";
import { replayHeaders } from "../../commit/index.ts";
import { approveDraft, type Outcome, rejectDraft } from "./decide.ts";
import { getDraft, listDrafts } from "./read.ts";
import type { Member } from "./snapshots.ts";

export { registerDraftHandler } from "./handlers.ts";
// The snapshot and payload readers other modules use (evidence, findings, inbox — T-040), through this index only.
export { bindNamedParams, type Cell, cellOf, loadSnapshots, type Member, runTemplate, snapIdOf, TEMPLATE_RANK } from "./snapshots.ts";
export { resolvedRefs, snapshotIdsOf } from "./payload.ts";
export { getDraft } from "./read.ts";

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

function member(c: Context<AppEnv>): Member {
  const p = c.var.principal;
  if (p.kind !== "member") throw new ApiError("forbidden");
  return p;
}

async function json(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ApiError("bad_request");
  }
}

async function decide(c: Context<AppEnv>, run: () => Promise<Outcome>) {
  const out = await run();
  // The stored text, so a replay is byte-identical to the first response; replay is signalled by header only.
  return c.body(out.body, 200, { "Content-Type": "application/json", ...replayHeaders(out) });
}

const draftId = (c: Context<AppEnv>, suffix: string) => c.req.param("action")!.slice(0, -suffix.length);

export const router = new Hono<AppEnv>()
  .get("/v1/drafts", requireMember, async (c) =>
    c.json(await listDrafts(c.var.deps.pools, member(c), {
      status: c.req.query("status"), outlet: c.req.query("outlet"), source: c.req.query("source"), limit: c.req.query("limit"), cursor: c.req.query("cursor"),
    }), 200))
  .get(`/v1/drafts/:id{${ID}}`, requireMember, async (c) => c.json(await getDraft(c.var.deps.pools, member(c), c.req.param("id")), 200))
  .post(`/v1/drafts/:action{${ID}:approve}`, requireMember, async (c) =>
    decide(c, async () => approveDraft(c.var.deps, member(c), draftId(c, ":approve"), await json(c))))
  .post(`/v1/drafts/:action{${ID}:reject}`, requireMember, async (c) =>
    decide(c, async () => rejectDraft(c.var.deps, member(c), draftId(c, ":reject"), await json(c))));
