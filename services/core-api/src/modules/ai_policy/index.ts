// AI policy module (T-090; ledger F10 "who", F11 O-2): per-role investigation-mode ceilings and the tenant's monthly AI
// cap, both owner-only books changed by the owner's own command. Any member reads the policy (a staff member sees why
// Plan is refused; a manager sees the settings page read-only). The effective cap, operator limit and spend are shown
// as cells of the `intel.ai_budget_left` snapshot, never from this payload.
// Exports for other modules: ceilingFor / assertModeAllowed (investigations, T-083/T-089) and effectiveCap (run-frame, T-040b).
import { CommandEnvelope } from "@munim/contracts";
import { Hono, type Context } from "hono";
import { contextOf, requireMember } from "../../auth/resolve.ts";
import { executeCommand, replayHeaders, type CommandHandler } from "../../commit/index.ts";
import { withContext } from "../../lib/db.ts";
import { ApiError } from "../../lib/errors.ts";
import type { AppEnv } from "../../lib/types.ts";
import * as cmd from "./commands.ts";
import { policy } from "./policy.ts";

export { assertModeAllowed, ceilingFor, DEFAULT_CEILINGS, defaultCeiling, effectiveCap, type EffectiveCap, type Mode } from "./policy.ts";

function member(c: Context<AppEnv>) {
  const p = c.var.principal;
  if (p.kind !== "member") throw new ApiError("forbidden");
  return p;
}

const post = (handler: CommandHandler) => async (c: Context<AppEnv>) => {
  const m = member(c);
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

export const router = new Hono<AppEnv>()
  .get("/v1/ai/policy", requireMember, async (c) => c.json(await withContext(c.var.deps.pools.core, contextOf(member(c)), policy), 200))
  .post("/v1/ai/policy/ceiling", requireMember, post(cmd.ceilingSet))
  .post("/v1/ai/policy/cap", requireMember, post(cmd.capSet));

export { cmd as handlers };
