// POST /internal/intel/v1/graph:query (T-058 wiring; ADR-014 "Graph port", F7). The five graph templates are core-owned
// SQL (this directory); intel names a template and passes only its arguments. Validation is intel's `check_args`
// exactly (munim_intel/graph/port.py): the template's one id argument (a uuid) and, for a walk, `depth` 1..3 (default
// 3); any other key — a `tenant_id` above all — refuses. `:tenant_id` and `:outlet_ids` are bound from the run token,
// never from the body (bindNamedParams skips comments, so a `:name` in one is not a parameter). The statement runs on
// the run's munim_svc transaction under the token's tenant and outlet scope. The graph tables are tenant-only under RLS,
// so every template reads the graph only through visible.sql's `vnode` / `vedge` (R-A 1: an outlet-scoped run sees no
// other outlet's nodes, edges, staff, customers, findings or claims, and walks through none). Rows: ids, kinds, names,
// hop counts — never a number to display.
import { readFileSync } from "node:fs";
import { GraphQueryRequest } from "@munim/contracts/internal";
import { ApiError } from "../../lib/errors.ts";
import { bindNamedParams } from "../../modules/approvals/snapshots.ts";
import type { OutletScope, Queryable } from "../../runtoken/index.ts";
import type { Run } from "../auth.ts";

const MAX_DEPTH = 3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** template → its id argument and whether it walks (then it also takes `depth`). Same table as intel's port.TEMPLATES. */
const TEMPLATES: Record<string, { idArg: string; walks: boolean }> = {
  price_shock_path: { idArg: "ingredient_id", walks: true },
  dish_margin_drivers: { idArg: "item_id", walks: true },
  supplier_dependency: { idArg: "supplier_id", walks: false },
  claim_support: { idArg: "finding_id", walks: false },
  neighbourhood: { idArg: "entity_id", walks: true },
};
const read = (name: string) => readFileSync(new URL(`./${name}.sql`, import.meta.url), "utf8").trim();
const VISIBLE = read("visible");
// A replacer function: as a string, the fragment's `$'` (the uuid regex) would be read as a replacement pattern.
const SQL = Object.fromEntries(Object.keys(TEMPLATES).map((t) => [t, read(t).replace("{{visible}}", () => VISIBLE)]));

/** The checked arguments (intel's check_args); `invalid_payload` for anything else. */
export function checkArgs(template: string, args: Record<string, unknown>): Record<string, string | number> {
  const t = TEMPLATES[template];
  if (!t) throw new ApiError("invalid_payload");
  const allowed = new Set(t.walks ? [t.idArg, "depth"] : [t.idArg]);
  if (Object.keys(args).some((k) => !allowed.has(k))) throw new ApiError("invalid_payload");
  const id = args[t.idArg];
  if (typeof id !== "string" || !UUID.test(id)) throw new ApiError("invalid_payload");
  if (!t.walks) return { [t.idArg]: id };
  const depth = args.depth ?? MAX_DEPTH;
  if (typeof depth !== "number" || !Number.isInteger(depth) || depth < 1 || depth > MAX_DEPTH) throw new ApiError("invalid_payload");
  return { [t.idArg]: id, depth };
}

/** The statement for a template with checked arguments and the run's tenant and outlet scope bound: `$n` text and values. */
export function graphStatement(template: string, args: Record<string, unknown>, tenantId: string, scope: OutletScope): { text: string; values: unknown[] } {
  const params: Record<string, unknown> = { ...checkArgs(template, args), tenant_id: tenantId, outlet_ids: scope[0] === "*" ? null : scope };
  const { sql, names } = bindNamedParams(SQL[template]!);
  return { text: sql, values: names.map((n) => params[n]) };
}

export async function graphQuery(c: Queryable, run: Pick<Run, "tenantId" | "scope">, raw: unknown): Promise<object> {
  const body = GraphQueryRequest.safeParse(raw);
  if (!body.success) throw new ApiError("invalid_payload");
  const { text, values } = graphStatement(body.data.template, body.data.args, run.tenantId, run.scope);
  return { rows: (await c.query(text, values)).rows };
}
