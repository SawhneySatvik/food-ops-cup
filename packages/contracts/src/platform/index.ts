// Platform config (02-schema §1; R21, R24, R36). Operator-owned; merchants never see providers. Every change
// is a `platform.config_draft` approved by a named operator and audited (R24); an operator's own command is
// its approval (R27). A role's provider + model changes only through an approved draft (T-031).
// `/platform/v1/tenants:provision` is declared by the tenancy contracts (T-020), not here.
import { z } from "zod";
import { CountryCode, CurrencyCode, Email, IsoDate, IsoDateTime, NonEmpty, Slug, Uuid7 } from "../shared/primitives.ts";
import type { Route } from "../shared/routes.ts";
import { TemplateParams } from "../shared/snapshot.ts";
import { READ_ROUTES, READ_SCHEMAS } from "./read-routes.ts";

export const MODEL_ROLES = ["router", "reason", "extract", "narrate", "vision", "embed"] as const;
export const MODEL_PROVIDERS = ["gemini", "openai", "openrouter", "nvidia"] as const;
export const ModelRoleName = z.enum(MODEL_ROLES);
export const ModelProvider = z.enum(MODEL_PROVIDERS);

/** platform.model_role — one row per role. The provider is checked against MODEL_PROVIDERS and the model
 *  family by the platform API (an unknown provider or any gemini-2.5 id is a refusal, not a type error). */
export const ModelRole = z.strictObject({
  role: ModelRoleName,
  provider: ModelProvider,
  /** The provider's model identifier, e.g. "meta/llama-3.3-70b-instruct". */
  model_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/),
  /** R47 D1: the operator's price per 1M tokens, minor units of `price_currency`. All three or none; none = unpriced,
   *  and a live role with no price refuses live calls. */
  input_price_per_mtok_minor: z.int().min(0).optional(),
  output_price_per_mtok_minor: z.int().min(0).optional(),
  price_currency: CurrencyCode.optional(),
});
export type ModelRole = z.infer<typeof ModelRole>;

export const ModelRoleRow = z.strictObject({
  role: ModelRoleName,
  provider: ModelProvider,
  model_id: z.string(),
  location: z.string().nullable(),
  /** R47 D1: null on all three = unpriced. */
  input_price_per_mtok_minor: z.int().min(0).nullable(),
  output_price_per_mtok_minor: z.int().min(0).nullable(),
  price_currency: CurrencyCode.nullable(),
  probed_at: IsoDateTime.nullable(),
  updated_at: IsoDateTime,
});

export const TenantRow = z.strictObject({
  tenant_id: Uuid7,
  name: z.string(),
  country_code: CountryCode,
  base_currency: CurrencyCode,
  status: z.string(),
  is_demo: z.boolean(),
  onboarded_at: IsoDateTime.nullable(),
  created_at: IsoDateTime,
});

export const CountryPackRow = z.strictObject({
  code: CountryCode,
  version: z.int().min(1),
  effective_from: IsoDate,
  status: z.enum(["draft", "active", "retired"]),
  created_at: IsoDateTime,
});
export const CountryPackDetail = z.strictObject({ ...CountryPackRow.shape, doc: z.record(z.string(), z.unknown()) });

export const PlanRow = z.strictObject({
  code: z.string(),
  name: z.string(),
  limits: z.record(z.string(), z.unknown()),
  status: z.enum(["active", "retired"]),
  created_at: IsoDateTime,
});

export const FeatureFlagRow = z.strictObject({
  key: z.string(),
  value_type: z.enum(["boolean", "integer", "text"]),
  value: z.union([z.boolean(), z.int(), z.string()]),
  description: z.string(),
  updated_at: IsoDateTime,
});

/** `spent_minor` is a row of the `platform.llm_budget_spent` view (a sum over intel.intel_spend). */
export const BudgetRow = z.strictObject({
  tenant_id: Uuid7,
  month: IsoDate,
  limit_minor: z.int().min(0),
  currency: CurrencyCode,
  spent_minor: z.int().min(0),
});

export const OperatorRow = z.strictObject({ id: Uuid7, email: Email, active: z.boolean(), created_at: IsoDateTime });

/** Targets: `model_role:<role>` {provider, model_id[, input_price_per_mtok_minor, output_price_per_mtok_minor, price_currency]} · `feature_flag:<key>` {value} ·
 *  `llm_budget:<tenant_id>` {month, limit_minor, currency} · `country_pack:<CODE>` {effective_from, doc} (a new
 *  version) · `plan:<code>` {name, limits, status}. The patch is checked per target when proposed and again when applied. */
export const ConfigDraftPropose = z.strictObject({
  /** Optional client id: the same id and body replays the original draft. */
  draft_id: Uuid7.optional(),
  target: z.string().regex(/^[a-z_]+(:[A-Za-z0-9_.-]+)?$/),
  patch: z.record(z.string(), z.unknown()),
});
export const ConfigDraftReject = z.strictObject({ reason: z.string().min(1).max(500) });
export const ConfigDraftApprove = z.strictObject({ reason: z.string().min(1).max(500).nullable().optional() });

export const ConfigDraftView = z.strictObject({
  id: Uuid7,
  target: z.string(),
  patch: z.record(z.string(), z.unknown()),
  /** The target's current values, for the before/after diff (null when the target has no row yet). */
  before: z.record(z.string(), z.unknown()).nullable(),
  status: z.enum(["proposed", "applied", "rejected", "stale"]),
  proposed_by: z.string(),
  decided_by: Uuid7.nullable(),
  decided_at: IsoDateTime.nullable(),
  reason: z.string().nullable(),
  created_at: IsoDateTime,
});

/** Operator-minted snapshot (R40 C4): only templates whose min_role is operator; the tenant is named
 *  explicitly because an operator has no tenant of their own. */
export const SnapshotMintOperator = z.strictObject({ tenant_id: Uuid7, template_id: Slug, params: TemplateParams });

const list = <T extends z.ZodType>(item: T) => z.strictObject({ items: z.array(item) });
export const TenantList = list(TenantRow);
export const CountryPackList = list(CountryPackRow);
export const PlanList = list(PlanRow);
export const FeatureFlagList = list(FeatureFlagRow);
export const BudgetList = list(BudgetRow);
export const ModelRoleList = list(ModelRoleRow);
export const OperatorList = list(OperatorRow);
export const ConfigDraftList = list(ConfigDraftView);

export const SCHEMAS = {
  ...READ_SCHEMAS,
  "platform.model-role": ModelRole,
  "platform.model-role-row": ModelRoleRow,
  "platform.tenant": TenantRow,
  "platform.country-pack-row": CountryPackRow,
  "platform.country-pack-detail": CountryPackDetail,
  "platform.plan": PlanRow,
  "platform.feature-flag": FeatureFlagRow,
  "platform.budget": BudgetRow,
  "platform.operator": OperatorRow,
  "platform.config-draft-propose": ConfigDraftPropose,
  "platform.config-draft-approve": ConfigDraftApprove,
  "platform.config-draft-reject": ConfigDraftReject,
  "platform.config-draft": ConfigDraftView,
  "platform.snapshot-mint": SnapshotMintOperator,
  "platform.tenants": TenantList,
  "platform.country-packs": CountryPackList,
  "platform.plans": PlanList,
  "platform.feature-flags": FeatureFlagList,
  "platform.budgets": BudgetList,
  "platform.model-roles": ModelRoleList,
  "platform.operators": OperatorList,
  "platform.config-drafts": ConfigDraftList,
};

const get = (path: string, operationId: string, summary: string, response: string, extra: Partial<Route> = {}): Route =>
  ({ surface: "public", method: "get", path, operationId, summary, auth: "operator", response, status: 200, ...extra });

export const ROUTES: readonly Route[] = [
  ...READ_ROUTES,
  get("/platform/v1/tenants", "listTenants", "Tenants from platform.tenant_registry (no tenant business data)", "platform.tenants"),
  get("/platform/v1/country-packs", "listCountryPacks", "Country pack versions", "platform.country-packs"),
  get("/platform/v1/country-packs/{code}/{version}", "getCountryPack", "One country pack version with its document", "platform.country-pack-detail",
    { pathParams: [{ name: "code", uuid: false }, { name: "version", uuid: false }] }),
  get("/platform/v1/plans", "listPlans", "Plans and limits", "platform.plans"),
  get("/platform/v1/feature-flags", "listFeatureFlags", "Feature flags (intel.enabled is the AI kill switch)", "platform.feature-flags"),
  get("/platform/v1/budgets", "listBudgets", "Per-tenant monthly AI budgets with spent from platform.llm_budget_spent", "platform.budgets"),
  get("/platform/v1/model-roles", "listModelRoles", "Provider + model per role (R36)", "platform.model-roles"),
  get("/platform/v1/operators", "listOperators", "Operators", "platform.operators"),
  get("/platform/v1/config-drafts", "listConfigDrafts", "Config drafts (status: proposed (default) | applied | rejected | stale | all)", "platform.config-drafts",
    { query: [{ name: "status", required: false, schema: { type: "string", enum: ["proposed", "applied", "rejected", "stale", "all"] } }] }),
  get("/platform/v1/config-drafts/{id}", "getConfigDraft", "One config draft (404 for an unknown id)", "platform.config-draft", { pathParams: [{ name: "id", uuid: true }] }),
  { surface: "public", method: "post", path: "/platform/v1/config-drafts", operationId: "proposeConfigDraft", summary: "Propose a platform config change (nothing applies until approved)",
    auth: "operator", request: "platform.config-draft-propose", response: "platform.config-draft", status: 201, conflict: true },
  { surface: "public", method: "post", path: "/platform/v1/config-drafts/{id}:approve", operationId: "approveConfigDraft", summary: "Approve and apply a config draft (an operator's own command is its approval, R27)",
    auth: "operator", request: "platform.config-draft-approve", response: "platform.config-draft", status: 200, pathParams: [{ name: "id", uuid: true }], conflict: true },
  { surface: "public", method: "post", path: "/platform/v1/config-drafts/{id}:reject", operationId: "rejectConfigDraft", summary: "Reject a config draft with a reason",
    auth: "operator", request: "platform.config-draft-reject", response: "platform.config-draft", status: 200, pathParams: [{ name: "id", uuid: true }], conflict: true },
  { surface: "public", method: "post", path: "/platform/v1/snapshots", operationId: "mintOperatorSnapshot", summary: "Mint an operator snapshot of an operator-level template (R40 C4)",
    auth: "operator", request: "platform.snapshot-mint", response: "snapshot", status: 201 },
];
