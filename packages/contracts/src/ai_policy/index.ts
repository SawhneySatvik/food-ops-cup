// AI policy (ledger F10 "who", F11 O-2; T-090). Two owner-only books (0020): the highest investigation mode each
// role may pick, and the tenant's monthly AI spend cap. Both change only by the owner's own command — never drafted,
// never by intel. A role with no row has the code default; the effective cap (the lower of the owner's cap and the
// operator's monthly limit) is a snapshot cell of `intel.ai_budget_left`, never a field here.
import { z } from "zod";
import { CurrencyCode, MemberRole, MinorAmount } from "../shared/primitives.ts";
import type { Route } from "../shared/routes.ts";

/** Investigation modes (F10), lowest first: Step < Plan < Auto. */
export const InvestigationMode = z.enum(["step", "plan", "auto"]);
export type InvestigationMode = z.infer<typeof InvestigationMode>;

export const AiPolicyCeilingSetV1 = z.strictObject({
  role: MemberRole,
  mode_ceiling: InvestigationMode,
});

/** In the business's base currency (set by core). Refused above the operator's limit for the current UTC month. */
export const AiPolicyCapSetV1 = z.strictObject({
  monthly_cap_minor: MinorAmount.nonnegative(),
});

export const AiPolicyResponse = z.strictObject({
  /** One entry per role, in MemberRole order. `default` = no row: the code default applies. */
  ceilings: z.array(z.strictObject({ role: MemberRole, mode_ceiling: InvestigationMode, source: z.enum(["default", "set"]) })).length(5),
  /** The owner's cap row (a book value), or null when the owner set none. */
  cap: z.strictObject({ monthly_cap_minor: MinorAmount.nonnegative(), currency: CurrencyCode }).nullable(),
});
export type AiPolicyResponse = z.infer<typeof AiPolicyResponse>;

export const SCHEMAS = {
  "ai_policy.ceiling.set.v1": AiPolicyCeilingSetV1,
  "ai_policy.cap.set.v1": AiPolicyCapSetV1,
  "v1.ai.policy": AiPolicyResponse,
};

const write = (path: string, operationId: string, command: string, summary: string): Route =>
  ({ surface: "public", method: "post", path, operationId, summary: `${command} — ${summary}`, auth: "member", command, response: "command-result", status: 200, conflict: true });

export const ROUTES: readonly Route[] = [
  { surface: "public", method: "get", path: "/v1/ai/policy", operationId: "getAiPolicy", summary: "Per-role investigation-mode ceilings and the owner's monthly AI cap", auth: "member", response: "v1.ai.policy", status: 200 },
  write("/v1/ai/policy/ceiling", "setAiModeCeiling", "ai_policy.ceiling.set.v1", "set the highest investigation mode a role may pick (owner only)"),
  write("/v1/ai/policy/cap", "setAiMonthlyCap", "ai_policy.cap.set.v1", "set the monthly AI spend cap, never above the operator's limit (owner only)"),
];
