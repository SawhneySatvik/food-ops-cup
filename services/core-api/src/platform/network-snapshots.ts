// The network impact total (T-095b; ADR-015 §2.3). An operator mints it as their own command (R27): the network template
// runs on munim_core with role operator and NO tenant (core.cares_network_impact's op CTE returns no row under a tenant)
// and is stored in platform.network_snapshot (rows, sha256, minter) — never in a tenant's evidence.snapshot. Nothing is
// public until an approved config draft with target `cares_public_impact:<id>` sets published_at (R24, platform/drafts.ts);
// the public routes (modules/cares-network) serve published rows only.
//   POST /platform/v1/network-snapshots   GET /platform/v1/network-snapshots
import { CaresNetworkImpactParams, CaresNetworkSnapshotMint } from "@munim/contracts/cares";
import type { Context } from "hono";
import { canonicalJson, sha256Hex, uuidv7 } from "../commit/index.ts";
import { withContext } from "../lib/db.ts";
import { ApiError } from "../lib/errors.ts";
import type { AppEnv } from "../lib/types.ts";
import { runTemplate } from "../modules/approvals/snapshots.ts";

/** The network templates and their params: the only templates this route mints (all `platform.*`, min_role operator). */
const NETWORK_TEMPLATES: Record<string, { safeParse(v: unknown): { success: boolean; data?: unknown } }> = {
  "platform.cares_network_impact": CaresNetworkImpactParams,
};

type Row = {
  id: string; template_id: string; template_version: number; params: Record<string, unknown>; rows: unknown[]; row_count: number; sha256: string;
  minted_by_operator_id: string; created_at: Date; published_at: Date | null; publish_draft_id: string | null; columns: unknown[];
};
const view = (s: Row) => ({
  snapshot_id: s.id, template_id: s.template_id, template_version: s.template_version, params: s.params, columns: s.columns, rows: s.rows,
  row_count: s.row_count, sha256: s.sha256, created_at: s.created_at.toISOString(), minted_by_operator_id: s.minted_by_operator_id,
  published_at: s.published_at?.toISOString() ?? null, publish_draft_id: s.publish_draft_id,
});
const COLS = `s.id, s.template_id, s.template_version, s.params, s.rows, s.row_count, s.sha256, s.minted_by_operator_id, s.created_at,
  s.published_at, s.publish_draft_id, t.columns`;

/** No tenant_id key: the operator's context only. */
const asOperator = <T>(c: Context<AppEnv>, operatorId: string, fn: Parameters<typeof withContext<T>>[2]) =>
  withContext(c.var.deps.pools.core, { role: "operator", operator_id: operatorId }, fn);

export async function mintNetworkSnapshot(c: Context<AppEnv>, operatorId: string, raw: unknown) {
  const body = CaresNetworkSnapshotMint.safeParse(raw);
  if (!body.success) throw new ApiError("bad_request");
  const { template_id } = body.data;
  const schema = NETWORK_TEMPLATES[template_id];
  if (!schema) throw new ApiError("not_found"); // not on this route's allow-list
  const params = schema.safeParse(body.data.params);
  if (!params.success) throw new ApiError("invalid_payload");
  return asOperator(c, operatorId, async (db) => {
    const t = await db.query<{ version: number }>(
      `SELECT version FROM evidence.snapshot_template WHERE id = $1 AND min_role = 'operator' ORDER BY version DESC LIMIT 1`, [template_id]);
    const version = t.rows[0]?.version;
    if (version === undefined) throw new ApiError("not_found");
    let out: Awaited<ReturnType<typeof runTemplate>>;
    try {
      out = await runTemplate(db, template_id, version, params.data as Record<string, unknown>);
    } catch (e) {
      if (/^22/.test(String((e as { code?: unknown }).code ?? ""))) throw new ApiError("invalid_payload"); // e.g. 2026-02-30
      throw e;
    }
    // The Σ row is always there when the operator context is admitted: no row means the context was not, so nothing is stored.
    if (out.rows.length === 0) throw new Error("network template returned no rows: the operator context was not admitted");
    const id = uuidv7();
    await db.query(
      `INSERT INTO platform.network_snapshot (id, template_id, template_version, params, rows, row_count, sha256, minted_by_operator_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, template_id, version, JSON.stringify(params.data), JSON.stringify(out.rows), out.rows.length, sha256Hex(canonicalJson(out.rows)), operatorId]);
    const r = await db.query<Row>(
      `SELECT ${COLS} FROM platform.network_snapshot s JOIN evidence.snapshot_template t ON t.id = s.template_id AND t.version = s.template_version
        WHERE s.id = $1`, [id]);
    return view(r.rows[0]!);
  });
}

export async function listNetworkSnapshots(c: Context<AppEnv>, operatorId: string) {
  const r = await asOperator(c, operatorId, (db) => db.query<Row>(
    `SELECT ${COLS} FROM platform.network_snapshot s JOIN evidence.snapshot_template t ON t.id = s.template_id AND t.version = s.template_version
      ORDER BY s.created_at DESC, s.id DESC LIMIT 200`));
  return { items: r.rows.map(view) };
}
