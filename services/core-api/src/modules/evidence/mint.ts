// Snapshot minting and reading (R25, R26, R40 C4; 03-architecture §1.7). One path for both minters: an intel run
// (`POST /internal/intel/v1/snapshots`, munim_svc under the run token's tenant and outlet scope) and a member
// (`POST /v1/snapshots`, munim_core under the member's own context). The template is a migration-authored row;
// its SQL runs under the transaction's RLS, so rows never exceed the minter's scope. Tenant and outlet scope come
// only from the verified token: params are checked against the template's params_schema, a `tenant_id` param is
// refused, and an outlet named in params must lie inside the minter's scope (never trusted alone).
import type { Snapshot } from "@munim/contracts";
import { canonicalJson, sha256Hex, uuidv7 } from "../../commit/index.ts";
import { ApiError } from "../../lib/errors.ts";
import type { OutletScope, Queryable } from "../../runtoken/index.ts";
import { TEMPLATE_RANK, bindNamedParams, runTemplate } from "../approvals/index.ts";

/** INFERENCE (as approvals/snapshots.ts): advisor reads at staff level, judge has owner rights in its demo tenant. */
// One ladder for every min_role check (0019): staff < manager < advisor < owner. A second copy here ranked advisor =
// staff, letting staff and managers mint advisor-level finance and payroll templates (M-C1bc finding).
const RANK = TEMPLATE_RANK;

export type Minter =
  /** `actor`: the run token's (a member id, or "watcher:<pack>" / "brief" for a run no person started). */
  | { kind: "run"; run_id: string; actor: string; scope: OutletScope }
  | { kind: "member"; member_id: string; role: string; scope: OutletScope };

type ParamsSchema = { properties?: Record<string, { enum?: unknown[] }>; required?: string[]; additionalProperties?: boolean };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Outlet ids a param names (`outlet_id`, `outlet_ids`, or any `*_outlet_id`). */
function outletParams(params: Record<string, unknown>): string[] {
  return Object.entries(params)
    .filter(([k]) => k === "outlet_ids" || k === "outlet_id" || k.endsWith("_outlet_id"))
    .flatMap(([, v]) => (Array.isArray(v) ? v : [v]))
    .filter((v): v is string => typeof v === "string");
}

function checkParams(schema: ParamsSchema, sqlNames: string[], params: Record<string, unknown>, scope: OutletScope): void {
  if ("tenant_id" in params) throw new ApiError("invalid_payload");
  const props = schema.properties ?? {};
  for (const [k, v] of Object.entries(params)) {
    if (schema.additionalProperties === false && !(k in props)) throw new ApiError("invalid_payload");
    const allowed = props[k]?.enum;
    if (allowed && !allowed.includes(v)) throw new ApiError("invalid_payload");
  }
  for (const k of [...(schema.required ?? []), ...sqlNames]) if (!(k in params)) throw new ApiError("invalid_payload");
  const outlets = outletParams(params);
  if (outlets.some((o) => !UUID.test(o))) throw new ApiError("invalid_payload");
  if (scope[0] !== "*" && outlets.some((o) => !(scope as string[]).includes(o))) throw new ApiError("forbidden");
}

/** Runs the latest version of an allow-listed template and stores the snapshot. Operator-only templates and
 *  (for a member) templates above the member's role are not on this caller's allow-list: 404. */
export async function mintSnapshot(c: Queryable, tenantId: string, minter: Minter, templateId: string, params: Record<string, unknown>): Promise<Snapshot> {
  const t = await c.query<{ version: number; sql: string; params_schema: ParamsSchema; min_role: string }>(
    `SELECT version, sql, params_schema, min_role FROM evidence.snapshot_template WHERE id = $1 ORDER BY version DESC LIMIT 1`, [templateId]);
  const tpl = t.rows[0];
  if (!tpl || tpl.min_role === "operator") throw new ApiError("not_found");
  if (minter.kind === "member" && (RANK[minter.role] ?? 0) < (RANK[tpl.min_role] ?? 99)) throw new ApiError("not_found");
  // C1 S2-4: a run a member started (Ask, Request quotes, an Auto step) reads no template above that member's CURRENT role, as
  // the member's own mint would not; an inactive member reads none. A watcher's or the brief's run has no person to rank.
  if (minter.kind === "run" && UUID.test(minter.actor)) {
    const r = await c.query<{ role: string }>(
      `SELECT ms.role FROM core.membership ms JOIN core.member m ON m.tenant_id = ms.tenant_id AND m.id = ms.member_id
        WHERE ms.member_id = $1 AND ms.active AND m.active`, [minter.actor]);
    const role = r.rows[0]?.role;
    if (!role || (RANK[role] ?? 0) < (RANK[tpl.min_role] ?? 99)) throw new ApiError("not_found");
  }
  checkParams(tpl.params_schema, bindNamedParams(tpl.sql).names, params, minter.scope);
  let out: Awaited<ReturnType<typeof runTemplate>>;
  try {
    out = await runTemplate(c, templateId, tpl.version, params);
  } catch (e) {
    // A param value the template cannot cast (22xxx: bad uuid, date, integer) is the caller's input, not a fault.
    if (/^22/.test(String((e as { code?: unknown }).code ?? ""))) throw new ApiError("invalid_payload");
    throw e;
  }
  const id = uuidv7();
  const scope = minter.scope[0] === "*" ? ["*"] : [...minter.scope];
  const sha256 = sha256Hex(canonicalJson(out.rows));
  const r = await c.query<{ created_at: Date }>(
    `INSERT INTO evidence.snapshot (tenant_id, id, template_id, template_version, params, run_id, minted_by_member_id, outlet_scope, rows, row_count, sha256)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING created_at`,
    [tenantId, id, templateId, tpl.version, JSON.stringify(params), minter.kind === "run" ? minter.run_id : null,
     minter.kind === "member" ? minter.member_id : null, scope, JSON.stringify(out.rows), out.rows.length, sha256]);
  return {
    snapshot_id: id, template_id: templateId, params: params as Snapshot["params"],
    run_id: minter.kind === "run" ? minter.run_id : null, minted_by_member_id: minter.kind === "member" ? minter.member_id : null,
    minted_by_operator_id: null, outlet_scope: scope as Snapshot["outlet_scope"], columns: out.columns as Snapshot["columns"],
    rows: out.rows as Snapshot["rows"], row_count: out.rows.length, sha256, created_at: r.rows[0]!.created_at.toISOString(),
  };
}

interface SnapshotRow {
  id: string; template_id: string; params: Snapshot["params"]; run_id: string | null; minted_by_member_id: string | null;
  minted_by_operator_id: string | null; outlet_scope: string[]; columns: Snapshot["columns"]; rows: Snapshot["rows"];
  row_count: number; sha256: string; created_at: Date; min_role: string;
}

/** A stored snapshot as the member may open it (R40 C4): the template's minimum role and an outlet scope the
 *  member covers. Anything else — another tenant (RLS), a wider scope, a higher role — is null (404). */
export async function readSnapshot(c: Queryable, id: string, m: { role: string; outlet_ids: "*" | string[] }): Promise<Snapshot | null> {
  const r = await c.query<SnapshotRow>(
    `SELECT s.id, s.template_id, s.params, s.run_id, s.minted_by_member_id, s.minted_by_operator_id, s.outlet_scope, t.columns, s.rows,
            s.row_count, s.sha256, s.created_at, t.min_role
       FROM evidence.snapshot s JOIN evidence.snapshot_template t ON t.id = s.template_id AND t.version = s.template_version
      WHERE s.id = $1`, [id]);
  const s = r.rows[0];
  if (!s || (RANK[m.role] ?? 0) < (RANK[s.min_role] ?? 99)) return null;
  if (m.outlet_ids !== "*" && (s.outlet_scope.includes("*") || !s.outlet_scope.every((o) => m.outlet_ids.includes(o)))) return null;
  return {
    snapshot_id: s.id, template_id: s.template_id, params: s.params, run_id: s.run_id, minted_by_member_id: s.minted_by_member_id,
    minted_by_operator_id: s.minted_by_operator_id, outlet_scope: s.outlet_scope as Snapshot["outlet_scope"], columns: s.columns,
    rows: s.rows, row_count: s.row_count, sha256: s.sha256, created_at: s.created_at.toISOString(),
  };
}
