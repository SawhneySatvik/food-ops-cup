import { PACKS } from "../../src/packs/index.ts";

const ID = "01a12430-bd88-7fcd-ad4a-1e1f4a14470a";
const OP = "01a12430-bd88-7fcd-ad4a-1e1f4a14470b";
const AT = "2026-10-10T10:00:00.000Z";
const tenant = { tenant_id: ID, name: "Synthetic Tenant", country_code: "IN", base_currency: "INR", status: "active", is_demo: false, onboarded_at: AT, created_at: AT };
const pack = { code: "IN", version: 1, effective_from: "2026-04-01", status: "active", created_at: AT };
const plan = { code: "core", name: "Core", limits: { outlets: 3 }, status: "active", created_at: AT };
const flag = { key: "intel.enabled", value_type: "boolean", value: true, description: "AI surfaces on/off", updated_at: AT };
const budget = { tenant_id: ID, month: "2026-10-01", limit_minor: 500000, currency: "INR", spent_minor: 1500 };
const roleRow = { role: "reason", provider: "openrouter", model_id: "meta-llama/llama-3.3-70b-instruct", location: null,
  input_price_per_mtok_minor: 1500, output_price_per_mtok_minor: 6000, price_currency: "INR", probed_at: null, updated_at: AT };
const operator = { id: OP, email: "ops@example.test", active: true, created_at: AT };
const draft = {
  id: ID, target: "model_role:reason", patch: { provider: "openrouter", model_id: "meta-llama/llama-3.3-70b-instruct" }, before: null,
  status: "proposed", proposed_by: `operator:${OP}`, decided_by: null, decided_at: null, reason: null, created_at: AT,
};

export const SAMPLES: Record<string, unknown> = {
  "platform.model-role": { role: "reason", provider: "openrouter", model_id: "meta-llama/llama-3.3-70b-instruct", input_price_per_mtok_minor: 1500, output_price_per_mtok_minor: 6000, price_currency: "INR" },
  "platform.model-role-row": roleRow,
  "platform.tenant": tenant,
  "platform.country-pack-row": pack,
  "platform.country-pack-detail": { ...pack, doc: PACKS.IN },
  "platform.plan": plan,
  "platform.feature-flag": flag,
  "platform.budget": budget,
  "platform.operator": operator,
  "platform.config-draft-propose": { draft_id: ID, target: "model_role:reason", patch: { provider: "gemini", model_id: "gemini-3-flash" } },
  "platform.config-draft-approve": { reason: null },
  "platform.config-draft-reject": { reason: "Not now." },
  "platform.config-draft": draft,
  "platform.snapshot-mint": { tenant_id: ID, template_id: "platform.tenant_outlets", params: {} },
  "platform.tenants": { items: [tenant] },
  "platform.country-packs": { items: [pack] },
  "platform.plans": { items: [plan] },
  "platform.feature-flags": { items: [flag] },
  "platform.budgets": { items: [budget] },
  "platform.model-roles": { items: [roleRow] },
  "platform.operators": { items: [operator] },
  "platform.config-drafts": { items: [draft] },
  "platform.tenant-spend": {
    tenant_id: ID,
    months: [{ month: "2026-10-01", limit_minor: 500000, spent_minor: 1200, currency: "INR" }],
    rows: [{ at: AT, amount_minor: 1200, currency: "INR" }],
    has_more: false,
  },
};
