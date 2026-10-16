// Storefront keys (T-020). core.storefront_key is operational, and no seeded command covers it, so these
// routes are owner-only by role check and audited directly (no command_log row; the raw key must never reach
// command_log.result, the audit log, the outbox or a log line — only its sha256 is stored). Revoking sets
// revoked_at; core.tenant_for_storefront_key then returns no row, so the key answers 404 at once.
import { createHash, randomBytes } from "node:crypto";
import { StorefrontKeyCreateRequest } from "@munim/contracts/tenancy";
import type { Context } from "hono";
import { contextOf } from "../../auth/resolve.ts";
import { withContext } from "../../lib/db.ts";
import { refuseOnDemo } from "../../lib/demo-guard.ts";
import { ApiError } from "../../lib/errors.ts";
import type { AppEnv } from "../../lib/types.ts";

function owner(c: Context<AppEnv>) {
  const p = c.var.principal;
  if (p.kind !== "member") throw new ApiError("forbidden");
  if ((p.role !== "owner" && p.role !== "judge") || p.outlet_ids !== "*") throw new ApiError("forbidden");
  return p;
}

export async function createKey(c: Context<AppEnv>) {
  const p = owner(c);
  let body: ReturnType<typeof StorefrontKeyCreateRequest.parse>;
  try {
    body = StorefrontKeyCreateRequest.parse(await c.req.json());
  } catch {
    throw new ApiError("invalid_payload");
  }
  const raw = `sfk_${randomBytes(32).toString("base64url")}`;
  const hash = createHash("sha256").update(raw, "utf8").digest("hex");
  const created_at = await withContext(c.var.deps.pools.core, contextOf(p), async (db) => {
    const ch = await db.query(`SELECT 1 FROM core.channel WHERE id = $1 AND active`, [body.channel_id]);
    if (!ch.rows[0]) throw new ApiError("not_found");
    const dup = await db.query(`SELECT 1 FROM core.storefront_key WHERE id = $1`, [body.key_id]);
    if (dup.rows[0]) throw new ApiError("conflict");
    const r = await db.query<{ created_at: Date }>(
      `INSERT INTO core.storefront_key (tenant_id, id, channel_id, key_hash, allowed_origins, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING created_at`,
      [p.tenant_id, body.key_id, body.channel_id, hash, body.allowed_origins, p.member_id]);
    await db.query(
      `INSERT INTO core.audit_log (tenant_id, actor, action, entity, entity_id, after) VALUES ($1, $2, 'tenancy.storefront_key.create', 'core.storefront_key', $3, $4)`,
      [p.tenant_id, { kind: "member", id: p.member_id, role: p.role }, body.key_id, { channel_id: body.channel_id }]);
    return r.rows[0]!.created_at.toISOString();
  });
  return c.json({ key_id: body.key_id, channel_id: body.channel_id, key: raw, created_at }, 201, { "Cache-Control": "no-store" });
}

export async function listKeys(c: Context<AppEnv>) {
  const p = owner(c);
  const rows = await withContext(c.var.deps.pools.core, contextOf(p), async (db) =>
    (await db.query<{ id: string; channel_id: string; allowed_origins: string[]; created_at: Date; revoked_at: Date | null }>(
      `SELECT id, channel_id, allowed_origins, created_at, revoked_at FROM core.storefront_key ORDER BY created_at, id`)).rows);
  return c.json({ keys: rows.map((r) => ({ key_id: r.id, channel_id: r.channel_id, allowed_origins: r.allowed_origins,
    created_at: r.created_at.toISOString(), revoked_at: r.revoked_at?.toISOString() ?? null })) }, 200);
}

export async function revokeKey(c: Context<AppEnv>, id: string) {
  const p = owner(c);
  const at = await withContext(c.var.deps.pools.core, contextOf(p), async (db) => {
    await refuseOnDemo(db, "tenancy.storefront_key.revoke");
    const r = await db.query<{ revoked_at: Date }>(
      `UPDATE core.storefront_key SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING revoked_at`, [id]);
    if (!r.rows[0]) {
      // Already revoked is a success with the stored time; unknown (or another tenant's) is 404.
      const prior = await db.query<{ revoked_at: Date }>(`SELECT revoked_at FROM core.storefront_key WHERE id = $1 AND revoked_at IS NOT NULL`, [id]);
      if (!prior.rows[0]) throw new ApiError("not_found");
      return prior.rows[0].revoked_at;
    }
    await db.query(
      `INSERT INTO core.audit_log (tenant_id, actor, action, entity, entity_id, after) VALUES ($1, $2, 'tenancy.storefront_key.revoke', 'core.storefront_key', $3, '{}')`,
      [p.tenant_id, { kind: "member", id: p.member_id, role: p.role }, id]);
    return r.rows[0].revoked_at;
  });
  return c.json({ key_id: id, revoked_at: at.toISOString() }, 200);
}
