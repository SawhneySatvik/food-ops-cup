// AI policy reads and enforcement helpers (T-090; ledger F10 "who", F11 O-2). Every function takes a Queryable already
// inside the caller's SET LOCAL context: the tenant comes from that context (RLS on core.ai_policy, core.ai_budget_cap
// and platform.llm_budget), never from an argument. Consumers: investigations (T-083 / T-089, ceilings) and the
// run-frame (T-040b, the budget). Nothing here refuses a run token for budget: the caller turns `left_minor ≤ 0`
// into the rules-only path (04 §10, rule 11).
import type { ReasonCode } from "@munim/contracts";
import type { AiPolicyResponse, InvestigationMode } from "@munim/contracts/ai_policy";
import type { MemberRole } from "../../auth/resolve.ts";
import { ApiError } from "../../lib/errors.ts";
import type { Queryable } from "../../runtoken/index.ts";
import { runTemplate } from "../approvals/index.ts";

export type Role = MemberRole;
export type Mode = InvestigationMode;

/** No row = this default; no row is ever backfilled (0020). owner/manager/staff are ledger F10. advisor `step` and
 *  judge `plan` are INFERENCE (open item O-3): advisors are read-only finance users (R27); a judge on Auto would spend
 *  the founder's money unattended. 0020 names core-domain as their home; they live here, their one reader. */
export const DEFAULT_CEILINGS: Readonly<Record<Role, Mode>> = { owner: "auto", manager: "plan", staff: "step", advisor: "step", judge: "plan" };

const RANK: Record<Mode, number> = { step: 1, plan: 2, auto: 3 };

export const defaultCeiling = (role: Role): Mode => DEFAULT_CEILINGS[role];

/** The highest mode `role` may pick in the context's tenant: the owner's row, else the default. */
export async function ceilingFor(q: Queryable, role: Role): Promise<Mode> {
  const r = await q.query<{ mode_ceiling: Mode }>(`SELECT mode_ceiling FROM core.ai_policy WHERE role = $1`, [role]);
  return r.rows[0]?.mode_ceiling ?? defaultCeiling(role);
}

/** Throws 403 `mode_above_ceiling` when `mode` is above the member's role ceiling. */
export async function assertModeAllowed(q: Queryable, member: { role: Role }, mode: Mode): Promise<void> {
  if (RANK[mode] > RANK[await ceilingFor(q, member.role)]) throw new ApiError("forbidden", "mode_above_ceiling" satisfies ReasonCode);
}

export interface EffectiveCap {
  month: string;
  currency: string;
  /** null = the owner set no cap, or set it in a currency other than the operator budget's (it does not apply). */
  owner_cap_minor: number | null;
  operator_limit_minor: number;
  effective_cap_minor: number;
  spent_minor: number;
  /** Negative when overspent. */
  left_minor: number;
}

/** The month's budget through the `intel.ai_budget_left` template itself (latest version), so the numbers equal any
 *  snapshot a person is shown. `month` is YYYY-MM or any date in it; omitted = the current UTC month (the operator
 *  budget's month basis). null = the operator set no budget for that month. Needs a tenant context. */
export async function effectiveCap(q: Queryable, month?: string): Promise<EffectiveCap | null> {
  const m = /^(\d{4}-\d{2})(-\d{2})?$/.exec(month ?? "");
  if (month !== undefined && !m) throw new Error(`effectiveCap: month '${month}' is not YYYY-MM or YYYY-MM-DD`);
  const first = m ? `${m[1]}-01` : (await q.query<{ d: string }>(`SELECT to_char(date_trunc('month', now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS d`)).rows[0]!.d;
  const v = await q.query<{ version: number }>(`SELECT max(version) AS version FROM evidence.snapshot_template WHERE id = 'intel.ai_budget_left'`);
  const { rows } = await runTemplate(q, "intel.ai_budget_left", v.rows[0]!.version, { month: first });
  if (rows.length > 1) throw new Error("effectiveCap: more than one budget row in a tenant context");
  const r = rows[0];
  if (!r) return null;
  const n = (k: string) => Number(r[k]);
  return {
    month: String(r.month), currency: String(r.currency), owner_cap_minor: r.owner_cap_minor === null ? null : n("owner_cap_minor"),
    operator_limit_minor: n("operator_limit_minor"), effective_cap_minor: n("effective_cap_minor"), spent_minor: n("spent_minor"), left_minor: n("left_minor"),
  };
}

/** GET /v1/ai/policy: the five roles' ceilings (row or default) and the owner's cap row. */
export async function policy(q: Queryable): Promise<AiPolicyResponse> {
  const set = new Map((await q.query<{ role: Role; mode_ceiling: Mode }>(`SELECT role, mode_ceiling FROM core.ai_policy`)).rows.map((r) => [r.role, r.mode_ceiling]));
  const cap = (await q.query<{ monthly_cap_minor: string; currency: string }>(`SELECT monthly_cap_minor::text, currency FROM core.ai_budget_cap`)).rows[0];
  return {
    ceilings: (Object.keys(DEFAULT_CEILINGS) as Role[]).map((role) => {
      const row = set.get(role);
      return { role, mode_ceiling: row ?? defaultCeiling(role), source: row ? "set" as const : "default" as const };
    }),
    cap: cap ? { monthly_cap_minor: Number(cap.monthly_cap_minor), currency: cap.currency } : null,
  };
}
