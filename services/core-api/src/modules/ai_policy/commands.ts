// AI policy commands (T-090). Both books are written only by the owner's own command (0020 command_authority: owner
// only — the book guard refuses manager, staff, advisor and judge with MB001, so no role check is duplicated here).
// Not draftable: intel never proposes its own budget or mode ceilings.
import { AiPolicyCapSetV1, AiPolicyCeilingSetV1 } from "@munim/contracts/ai_policy";
import { type CommandHandler, uuidv7 } from "../../commit/index.ts";
import { ApiError } from "../../lib/errors.ts";
import type { Queryable } from "../../runtoken/index.ts";

const TENANT = `current_setting('app.tenant_id')::uuid`;
const ME = `current_setting('app.member_id')::uuid`;

function parse<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, payload: unknown): T {
  const r = schema.safeParse(payload);
  if (!r.success) throw new ApiError("invalid_payload");
  return r.data;
}

const one = async <T extends object>(c: Queryable, sql: string, params: unknown[]) => (await c.query<T>(sql, params)).rows[0];

export const ceilingSet: CommandHandler = {
  type: "ai_policy.ceiling.set.v1",
  async run(c, cmd) {
    const p = parse(AiPolicyCeilingSetV1, cmd.payload);
    const prior = await one<{ id: string; mode_ceiling: string }>(c, `SELECT id, mode_ceiling FROM core.ai_policy WHERE role = $1 FOR UPDATE`, [p.role]);
    let id = prior?.id;
    if (prior) await c.query(`UPDATE core.ai_policy SET mode_ceiling = $2 WHERE id = $1`, [prior.id, p.mode_ceiling]);
    else {
      id = uuidv7();
      await c.query(`INSERT INTO core.ai_policy (tenant_id, id, role, mode_ceiling, created_by) VALUES (${TENANT}, $1, $2, $3, ${ME})`, [id, p.role, p.mode_ceiling]);
    }
    return { entityId: id!, audit: [{ entity: "core.ai_policy", entityId: id!, before: prior ? { role: p.role, mode_ceiling: prior.mode_ceiling } : undefined, after: { role: p.role, mode_ceiling: p.mode_ceiling } }] };
  },
};

export const capSet: CommandHandler = {
  type: "ai_policy.cap.set.v1",
  async run(c, cmd) {
    const p = parse(AiPolicyCapSetV1, cmd.payload);
    // Written first so the guard's authority verdict (MB001) wins over the limit check; a refusal below rolls it back.
    const prior = await one<{ id: string; monthly_cap_minor: string }>(c, `SELECT id, monthly_cap_minor::text FROM core.ai_budget_cap FOR UPDATE`, []);
    let id = prior?.id;
    let currency: string;
    if (prior) {
      currency = (await one<{ currency: string }>(c, `UPDATE core.ai_budget_cap SET monthly_cap_minor = $2 WHERE id = $1 RETURNING currency`, [prior.id, p.monthly_cap_minor]))!.currency;
    } else {
      id = uuidv7();
      // The business's base currency (R30; MB003 on any other).
      currency = (await one<{ currency: string }>(c,
        `INSERT INTO core.ai_budget_cap (tenant_id, id, monthly_cap_minor, currency, created_by)
         SELECT ${TENANT}, $1, $2, base_currency, ${ME} FROM core.tenant WHERE tenant_id = ${TENANT} RETURNING currency`, [id, p.monthly_cap_minor]))!.currency;
    }
    // F11 O-2: never above the operator's limit for the current UTC month (platform.llm_budget's month basis). The owner
    // cap counts only in the operator budget's currency (intel.ai_budget_left), so a limit in another currency, or none
    // this month, cannot be checked: refused (fail closed on money; INFERENCE, reported for the founder).
    const limit = await one<{ limit_minor: string }>(c,
      `SELECT limit_minor::text FROM platform.llm_budget
        WHERE tenant_id = ${TENANT} AND month = date_trunc('month', now() AT TIME ZONE 'UTC')::date AND currency = $1`, [currency]);
    if (!limit) throw new ApiError("invalid_payload", "platform_budget_missing");
    if (BigInt(p.monthly_cap_minor) > BigInt(limit.limit_minor)) throw new ApiError("invalid_payload", "cap_above_platform_budget");
    return {
      entityId: id!,
      audit: [{ entity: "core.ai_budget_cap", entityId: id!, before: prior ? { monthly_cap_minor: Number(prior.monthly_cap_minor), currency } : undefined, after: { monthly_cap_minor: p.monthly_cap_minor, currency } }],
    };
  },
};
