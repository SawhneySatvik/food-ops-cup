// Operator-minted snapshots (R40 C4, minted_by_operator_id). Admin aggregates come from migration-authored
// templates whose min_role is 'operator' - nothing else is mintable here, so an operator can never run a
// tenant-level template (orders, stock, ledger) through this route. Minting runs on munim_core under the
// named tenant's RLS context because munim_platform holds no grant on evidence.snapshot or core.*.
import type { Context } from "hono";
import type { Snapshot } from "@munim/contracts";
import { SnapshotMintOperator } from "@munim/contracts/platform";
import { canonicalJson, sha256Hex, uuidv7 } from "../commit/index.ts";
import { withContext } from "../lib/db.ts";
import { ApiError } from "../lib/errors.ts";
import type { AppEnv } from "../lib/types.ts";
import { bindNamedParams, runTemplate } from "../modules/approvals/snapshots.ts";

/** Network-wide templates (ADR-015 §2.3): minted only into platform.network_snapshot with no tenant context, never into
 *  a tenant's evidence.snapshot (core.cares_network_impact also returns 0 rows under a tenant, 0028). */
const NETWORK_ONLY = new Set(["platform.cares_network_impact"]);

export async function mintOperatorSnapshot(c: Context<AppEnv>, operatorId: string, raw: unknown): Promise<Snapshot> {
  const parsed = SnapshotMintOperator.safeParse(raw);
  if (!parsed.success) throw new ApiError("bad_request");
  const { tenant_id, template_id, params } = parsed.data;
  if (NETWORK_ONLY.has(template_id)) throw new ApiError("not_found"); // not on this route's allow-list
  return withContext(c.var.deps.pools.core, { tenant_id, outlet_ids: "*", role: "operator", operator_id: operatorId }, async (db) => {
    const t = await db.query<{ version: number; sql: string; min_role: string }>(
      `SELECT version, sql, min_role FROM evidence.snapshot_template WHERE id = $1 ORDER BY version DESC LIMIT 1`, [template_id]);
    const tpl = t.rows[0];
    if (!tpl || tpl.min_role !== "operator") throw new ApiError("not_found"); // not on the operator allow-list
    const tenant = await db.query(`SELECT 1 FROM core.tenant WHERE tenant_id = $1`, [tenant_id]);
    if (tenant.rowCount === 0) throw new ApiError("not_found");
    const { names } = bindNamedParams(tpl.sql);
    const full: Record<string, unknown> = { ...params, tenant_id };
    if (names.some((n) => !(n in full))) throw new ApiError("bad_request");
    const { columns, rows } = await runTemplate(db, template_id, tpl.version, full);
    const id = uuidv7();
    const ins = await db.query<{ created_at: Date }>(
      `INSERT INTO evidence.snapshot (tenant_id, id, template_id, template_version, params, minted_by_operator_id, outlet_scope, rows, row_count, sha256)
       VALUES ($1, $2, $3, $4, $5, $6, ARRAY['*'], $7, $8, $9) RETURNING created_at`,
      [tenant_id, id, template_id, tpl.version, JSON.stringify(params), operatorId, JSON.stringify(rows), rows.length, sha256Hex(canonicalJson(rows))]);
    return {
      snapshot_id: id, template_id, params, run_id: null, minted_by_member_id: null, minted_by_operator_id: operatorId,
      outlet_scope: ["*"], columns: columns as Snapshot["columns"], rows: rows as Snapshot["rows"], row_count: rows.length,
      sha256: sha256Hex(canonicalJson(rows)), created_at: ins.rows[0]!.created_at.toISOString(),
    };
  });
}
