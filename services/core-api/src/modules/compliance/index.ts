// Compliance module (T-029): licences (kinds from the country pack), checklists and runs, temperature logs,
// assets, AMCs, maintenance. A member's own command is its approval (R27); maintenance scheduling is also
// draftable (R16) and registers its execution handler with approvals. Logs are evidence records — nothing
// here says an outlet "is compliant". Routes carry their full paths.
import { CommandEnvelope } from "@munim/contracts";
import { Hono, type Context } from "hono";
import { requireMember, contextOf } from "../../auth/resolve.ts";
import { executeCommand, replayHeaders, type CommandHandler } from "../../commit/index.ts";
import { withContext } from "../../lib/db.ts";
import { ApiError } from "../../lib/errors.ts";
import type { AppEnv } from "../../lib/types.ts";
import type { Queryable } from "../../runtoken/index.ts";
import { registerDraftHandler } from "../approvals/index.ts";
import * as cmd from "./commands.ts";
import * as read from "./read.ts";

// Loaded twice in one process (vitest by path, loadRouters by URL): register once.
const ONCE = Symbol.for("munim.compliance.draftHandlers");
const g = globalThis as unknown as Record<symbol, boolean | undefined>;
if (!g[ONCE]) {
  for (const h of [cmd.maintenanceSchedule]) registerDraftHandler(h);
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
  .get("/v1/compliance/licences", requireMember, get(read.licences))
  .get("/v1/compliance/licences/expiring", requireMember, get(read.expiringLicences))
  .post("/v1/compliance/licences", requireMember, post(cmd.licenceUpsert))
  .get("/v1/compliance/assets", requireMember, get(read.assets))
  .post("/v1/compliance/assets", requireMember, post(cmd.assetUpsert))
  .get("/v1/compliance/checklists", requireMember, get(read.checklists))
  .post("/v1/compliance/checklists", requireMember, post(cmd.checklistUpsert))
  .get("/v1/compliance/checklist-runs", requireMember, get(read.checklistRuns))
  .post("/v1/compliance/checklist-runs", requireMember, post(cmd.checklistComplete))
  .get("/v1/compliance/temp-logs", requireMember, get(read.tempLogs))
  .post("/v1/compliance/temp-logs", requireMember, post(cmd.tempRecord))
  .get("/v1/compliance/amcs", requireMember, get(read.amcs))
  .post("/v1/compliance/amcs", requireMember, post(cmd.amcRecord))
  .get("/v1/compliance/maintenance", requireMember, get(read.maintenance))
  .post("/v1/compliance/maintenance", requireMember, post(cmd.maintenanceSchedule))
  .post("/v1/compliance/maintenance/record", requireMember, post(cmd.maintenanceRecord));

export { cmd as handlers };
