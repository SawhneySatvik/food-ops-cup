// Goals module (T-029): goals and tasks. goals.goal.create.v1 and goals.task.create.v1 are draftable (R16) and
// register their execution handlers with approvals; a member's own command is its approval (R27).
import { CommandEnvelope } from "@munim/contracts";
import { Hono, type Context } from "hono";
import { contextOf, requireMember } from "../../auth/resolve.ts";
import { executeCommand, replayHeaders, type CommandHandler } from "../../commit/index.ts";
import { withContext } from "../../lib/db.ts";
import { ApiError } from "../../lib/errors.ts";
import type { AppEnv } from "../../lib/types.ts";
import type { Queryable } from "../../runtoken/index.ts";
import { registerDraftHandler } from "../approvals/index.ts";
import * as cmd from "./commands.ts";
import * as read from "./read.ts";

// Loaded twice in one process (vitest by path, loadRouters by URL): register once.
const ONCE = Symbol.for("munim.goals.draftHandlers");
const g = globalThis as unknown as Record<symbol, boolean | undefined>;
if (!g[ONCE]) {
  for (const h of [cmd.goalCreate, cmd.taskCreate]) registerDraftHandler(h);
  g[ONCE] = true;
}

function member(c: Context<AppEnv>) {
  const p = c.var.principal;
  if (p.kind !== "member") throw new ApiError("forbidden");
  return p;
}

const post = (handler: CommandHandler) => async (c: Context<AppEnv>) => {
  const m = member(c);
  // Not JSON at all = 400; valid JSON that is not a command envelope = 422 invalid_payload (shared/error.ts).
  const raw: unknown = await c.req.json().catch(() => undefined);
  if (raw === undefined) throw new ApiError("bad_request");
  const env = CommandEnvelope.safeParse(raw);
  if (!env.success) throw new ApiError("invalid_payload");
  const { pools, publish } = c.var.deps;
  const out = await executeCommand(
    { tx: (fn) => withContext(pools.core, contextOf(m), fn), tenantId: m.tenant_id, actor: { kind: "member", id: m.member_id, role: m.role },
      ...(publish ? { publish } : {}) },
    env.data, handler);
  return c.body(out.body, 200, { "Content-Type": "application/json", ...replayHeaders(out) });
};

const get = (fn: (q: Queryable, raw: Record<string, string | undefined>) => Promise<object>) => async (c: Context<AppEnv>) => {
  const m = member(c);
  return c.json(await withContext(c.var.deps.pools.core, contextOf(m), (q) => fn(q, c.req.query())), 200);
};

export const router = new Hono<AppEnv>()
  .get("/v1/goals", requireMember, get(read.goals))
  .post("/v1/goals", requireMember, post(cmd.goalCreate))
  .post("/v1/goals/update", requireMember, post(cmd.goalUpdate))
  .get("/v1/tasks", requireMember, get(read.tasks))
  .post("/v1/tasks", requireMember, post(cmd.taskCreate))
  .post("/v1/tasks/update", requireMember, post(cmd.taskUpdate));

export { cmd as handlers };
