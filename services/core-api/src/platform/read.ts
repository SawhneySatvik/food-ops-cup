// Operator reads of platform config. Only platform.* objects: tenant_registry (a view over core.tenant with no
// business data) and llm_budget_spent (budgets with spend summed from intel.intel_spend). Nothing here, and
// nothing munim_platform may select, reaches a tenant's books.
import type { Queryable } from "../runtoken/index.ts";

const TS = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export async function tenants(c: Queryable) {
  const r = await c.query(`SELECT tenant_id, name, country_code, base_currency, status, is_demo, ${TS("onboarded_at")} AS onboarded_at, ${TS("created_at")} AS created_at
                             FROM platform.tenant_registry ORDER BY created_at, tenant_id`);
  return { items: r.rows };
}

export async function countryPacks(c: Queryable) {
  const r = await c.query(`SELECT code, version, effective_from::text AS effective_from, status, ${TS("created_at")} AS created_at FROM platform.country_pack ORDER BY code, version`);
  return { items: r.rows };
}

export async function countryPack(c: Queryable, code: string, version: number) {
  const r = await c.query(`SELECT code, version, effective_from::text AS effective_from, status, ${TS("created_at")} AS created_at, doc FROM platform.country_pack WHERE code = $1 AND version = $2`, [code, version]);
  return r.rows[0] ?? null;
}

export async function plans(c: Queryable) {
  const r = await c.query(`SELECT code, name, limits, status, ${TS("created_at")} AS created_at FROM platform.plan ORDER BY code`);
  return { items: r.rows };
}

export async function featureFlags(c: Queryable) {
  const r = await c.query(`SELECT key, value_type, value, description, ${TS("updated_at")} AS updated_at FROM platform.feature_flag ORDER BY key`);
  return { items: r.rows };
}

export async function budgets(c: Queryable) {
  const r = await c.query<{ tenant_id: string; month: string; limit_minor: string; currency: string; spent_minor: string }>(
    `SELECT tenant_id, month::text AS month, limit_minor::text AS limit_minor, currency, spent_minor::text AS spent_minor FROM platform.llm_budget_spent ORDER BY month DESC, tenant_id`);
  return { items: r.rows.map((x) => ({ ...x, limit_minor: Number(x.limit_minor), spent_minor: Number(x.spent_minor) })) };
}

export async function modelRoles(c: Queryable) {
  // R47 D1: the operator's prices ride with the role (null = unpriced). bigint arrives as text; the contract wants a number.
  const r = await c.query(`SELECT role, provider, model_id, location, input_price_per_mtok_minor::text AS input_price_per_mtok_minor,
    output_price_per_mtok_minor::text AS output_price_per_mtok_minor, price_currency, ${TS("probed_at")} AS probed_at, ${TS("updated_at")} AS updated_at
    FROM platform.model_role ORDER BY role`);
  const num = (v: string | null) => (v === null ? null : Number(v));
  return { items: r.rows.map((x) => ({ ...x, input_price_per_mtok_minor: num(x.input_price_per_mtok_minor), output_price_per_mtok_minor: num(x.output_price_per_mtok_minor) })) };
}

export async function operators(c: Queryable) {
  const r = await c.query(`SELECT id, email, active, ${TS("created_at")} AS created_at FROM platform.operator ORDER BY email, id`);
  return { items: r.rows };
}

/** One tenant's AI budget months (limit, spend summed from intel.intel_spend) and that month's spend rows, newest first (T-092b).
 *  munim_platform may select only (tenant_id, amount_minor, currency, at) of intel.intel_spend: no run, model or role column
 *  is read here. Null when the tenant is not in the registry. */
export async function tenantSpend(c: Queryable, tenant: string, month: string | null) {
  if (!(await c.query(`SELECT 1 FROM platform.tenant_registry WHERE tenant_id = $1`, [tenant])).rows[0]) return null;
  const months = await c.query<{ month: string; limit_minor: string; currency: string; spent_minor: string }>(
    `SELECT month::text AS month, limit_minor::text AS limit_minor, currency, spent_minor::text AS spent_minor FROM platform.llm_budget_spent
      WHERE tenant_id = $1 ORDER BY month DESC`, [tenant]);
  const rows = await c.query<{ at: Date; amount_minor: string; currency: string }>(
    `SELECT at, amount_minor::text AS amount_minor, currency FROM intel.intel_spend
      WHERE tenant_id = $1 AND (at AT TIME ZONE 'UTC') >= coalesce($2::date, date_trunc('month', now() AT TIME ZONE 'UTC')::date)
        AND (at AT TIME ZONE 'UTC') < coalesce($2::date, date_trunc('month', now() AT TIME ZONE 'UTC')::date) + interval '1 month'
      ORDER BY at DESC LIMIT 501`, [tenant, month]);
  return {
    tenant_id: tenant,
    months: months.rows.map((x) => ({ month: x.month, limit_minor: Number(x.limit_minor), spent_minor: Number(x.spent_minor), currency: x.currency })),
    rows: rows.rows.slice(0, 500).map((x) => ({ at: x.at.toISOString(), amount_minor: Number(x.amount_minor), currency: x.currency })),
    has_more: rows.rows.length > 500,
  };
}
