// Platform read response and route (T-092b; hand list row 26): one tenant's AI spend, operator-only. Spend rows are the four
// columns munim_platform may read of intel.intel_spend (tenant, amount, currency, time); `months` is the llm_budget_spent view.
import { z } from "zod";
import { CurrencyCode, IsoDate, IsoDateTime, Uuid7 } from "../shared/primitives.ts";
import type { Route } from "../shared/routes.ts";

export const READ_SCHEMAS = {
  "platform.tenant-spend": z.strictObject({
    tenant_id: Uuid7,
    months: z.array(z.strictObject({ month: IsoDate, limit_minor: z.int().min(0), spent_minor: z.int().min(0), currency: CurrencyCode })),
    rows: z.array(z.strictObject({ at: IsoDateTime, amount_minor: z.int().min(0), currency: CurrencyCode })),
    has_more: z.boolean(),
  }),
};

export const READ_ROUTES: readonly Route[] = [
  { surface: "public", method: "get", path: "/platform/v1/budgets/{tenant}/spend", operationId: "getTenantSpend", summary: "A tenant's monthly AI budget and spend rows for one UTC month (default the current), newest first; operator only",
    auth: "operator", response: "platform.tenant-spend", status: 200, pathParams: [{ name: "tenant", uuid: true }],
    query: [{ name: "month", required: false, schema: { type: "string", pattern: "^\\d{4}-(0[1-9]|1[0-2])-01$" } }] },
];
