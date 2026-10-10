// Auth lanes (03-arch §6) as Hono middleware. Each verifies the bearer token through the IdP port, then asks
// Postgres who that identity is — roles and outlet scope come from rows, never from token claims.
//   member:   token + `X-Munim-Tenant` → core.member (idp_sub) ⋈ core.membership (role, outlet scope)
//   operator: token → platform.operator (idp_sub, active)
//   customer: storefront key → (tenant, channel); optional token → that tenant's core.customer by idp_sub (R41)
//   guest:    storefront key + guest access token → the one order whose guest_access_hash matches
// Bad or missing token → 401. A tenant, storefront or profile that does not resolve → 404, so a request can
// never learn that another tenant exists (gotcha 16).
import { createHash, timingSafeEqual } from "node:crypto";
import { GUEST_TOKEN_HEADER, STOREFRONT_KEY_HEADER, TENANT_HEADER } from "@munim/contracts";
import { outletScopeOf } from "@munim/core-domain/authority";
import type { Context, MiddlewareHandler } from "hono";
import type pg from "pg";
import { uuidv7 } from "../commit/index.ts";
import { type AppContext, withContext } from "../lib/db.ts";
import { ApiError } from "../lib/errors.ts";
import type { AppEnv } from "../lib/types.ts";

export { GUEST_TOKEN_HEADER, STOREFRONT_KEY_HEADER, TENANT_HEADER };

export type MemberRole = "owner" | "manager" | "staff" | "advisor" | "judge";
export type Principal =
  | { kind: "member"; tenant_id: string; member_id: string; role: MemberRole; outlet_ids: "*" | string[] }
  | { kind: "operator"; operator_id: string }
  /**
   * A storefront customer. `profile` true: their existing core.customer row at this merchant. `profile` false:
   * no row yet — a guest (`sub` null) or signed in for the first time here — and `customer_id` is minted by
   * core-api (UUIDv7) for the command that creates the row. Never taken from a payload (W1 fix #45).
   */
  | { kind: "customer"; tenant_id: string; channel_id: string; customer_id: string; profile: boolean; sub: string | null }
  /** Holder of one order's guest access token. `guest_access_hash` = hex(sha256(token)); RLS (0014 guest_scope)
   *  shows only that order and its lines, events, tenders and kitchen tickets, and refuses every write. */
  | { kind: "guest"; tenant_id: string; channel_id: string; order_id: string; guest_access_hash: string };

export interface Storefront {
  tenant_id: string;
  channel_id: string;
}
/** Storefront key → (tenant, channel), or null. Never logs the key. */
export type StorefrontResolver = (key: string) => Promise<Storefront | null>;

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest();

/**
 * The production resolver: sha256(key) hex → `core.tenant_for_storefront_key` (munim_crosstenant, EXECUTE
 * munim_core). Only the hash is compared, so lookup time says nothing about the key; a miss is null → 404.
 */
export function storefrontResolver(pool: pg.Pool): StorefrontResolver {
  return async (key) => {
    if (key.length < 16 || key.length > 256) return null;
    const r = await pool.query<Storefront>("SELECT tenant_id, channel_id FROM core.tenant_for_storefront_key($1)", [
      sha256(key).toString("hex"),
    ]);
    return r.rows[0] ?? null;
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bearer(c: Context<AppEnv>): string | null {
  const h = c.req.header("Authorization");
  const m = h ? /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(h) : null;
  return m?.[1] ?? null;
}

async function identity(c: Context<AppEnv>, token: string) {
  try {
    return await c.var.deps.idp.verify(token);
  } catch {
    throw new ApiError("unauthenticated");
  }
}

export const requireMember: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = bearer(c);
  if (!token) throw new ApiError("unauthenticated");
  const { sub } = await identity(c, token);
  const tenant = c.req.header(TENANT_HEADER);
  if (!tenant || !UUID.test(tenant)) throw new ApiError("not_found");
  // Only tenant_id is set: RLS confines the lookup to the named tenant, so a sub that is a member elsewhere
  // reads 0 rows here.
  const rows = await withContext(c.var.deps.pools.core, { tenant_id: tenant }, async (db) =>
    (
      await db.query<{ member_id: string; role: MemberRole; outlet_ids: string[] }>(
        `SELECT m.id AS member_id, ms.role, ms.outlet_ids
           FROM core.member m
           JOIN core.membership ms ON ms.tenant_id = m.tenant_id AND ms.member_id = m.id
          WHERE m.idp_sub = $1 AND m.active AND ms.active`,
        [sub],
      )
    ).rows,
  );
  const m = rows[0];
  if (!m) throw new ApiError("not_found");
  const scope = outletScopeOf(m);
  c.set("principal", {
    kind: "member",
    tenant_id: tenant.toLowerCase(),
    member_id: m.member_id,
    role: m.role,
    outlet_ids: scope.includes("*") ? "*" : scope,
  });
  await next();
};

export const requireOperator: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = bearer(c);
  if (!token) throw new ApiError("unauthenticated");
  const { sub } = await identity(c, token);
  // platform.operator has no RLS; munim_core holds SELECT on (id, idp_sub, active) only.
  const r = await c.var.deps.pools.core.query<{ id: string }>(
    "SELECT id FROM platform.operator WHERE idp_sub = $1 AND active",
    [sub],
  );
  const op = r.rows[0];
  if (!op) throw new ApiError("not_found");
  c.set("principal", { kind: "operator", operator_id: op.id });
  await next();
};

async function storefrontOf(c: Context<AppEnv>) {
  const key = c.req.header(STOREFRONT_KEY_HEADER);
  const sf = key ? await c.var.deps.storefronts(key) : null;
  if (!sf) throw new ApiError("not_found");
  return sf;
}

export const requireCustomer: MiddlewareHandler<AppEnv> = async (c, next) => {
  const sf = await storefrontOf(c);
  const token = bearer(c);
  if (!token && c.req.header("Authorization")) throw new ApiError("unauthenticated");
  let sub: string | null = null;
  let existing: string | undefined;
  if (token) {
    sub = (await identity(c, token)).sub;
    // The profile is looked up only inside the storefront's tenant (R41): one login, one profile per merchant.
    const rows = await withContext(c.var.deps.pools.core, { tenant_id: sf.tenant_id }, async (db) =>
      (await db.query<{ id: string }>("SELECT id FROM core.customer WHERE idp_sub = $1", [sub])).rows,
    );
    existing = rows[0]?.id;
  }
  // No profile yet (guest, or first sign-in here): core-api mints the id; the link / guest-create command
  // (T-035, T-032) creates the row with it — never here.
  c.set("principal", { kind: "customer", ...sf, customer_id: existing ?? uuidv7(), profile: existing !== undefined, sub });
  await next();
};

/** Guest order tracking (W1 fix #47): storefront key + guest token → that one order, or 404 (gotcha 16). */
export const requireGuest: MiddlewareHandler<AppEnv> = async (c, next) => {
  const sf = await storefrontOf(c);
  const token = c.req.header(GUEST_TOKEN_HEADER);
  if (!token || token.length < 16 || token.length > 256) throw new ApiError("not_found");
  const hash = sha256(token);
  const guest_access_hash = hash.toString("hex");
  // Resolved under the guest's own context: guest_scope admits only the order carrying this hash.
  const rows = await withContext(c.var.deps.pools.core, { tenant_id: sf.tenant_id, outlet_ids: [], role: "guest", guest_access_hash }, async (db) =>
    (await db.query<{ id: string; guest_access_hash: Buffer }>(`SELECT id, guest_access_hash FROM core."order"`)).rows,
  );
  const o = rows.length === 1 ? rows[0] : undefined;
  if (!o || o.guest_access_hash.length !== 32 || !timingSafeEqual(o.guest_access_hash, hash)) throw new ApiError("not_found");
  c.set("principal", { kind: "guest", ...sf, order_id: o.id, guest_access_hash });
  await next();
};

/** Request facts that widen a shopper's view (db/README "Shoppers"): only ever from the request core-api is
 *  handling — coupon codes the order presents, or the guest order a signed-in customer is claiming. */
export interface ShopperExtras {
  coupon_codes?: readonly string[];
  /** hex(sha256(guest token)) — only for customers.account.link.v1 (claiming a guest order). */
  claim_guest_access_hash?: string;
}

/** The `SET LOCAL app.*` context for the principal's own requests (03-arch §1.4; db/README "Shoppers"). */
export function contextOf(p: Principal, extras: ShopperExtras = {}): AppContext {
  switch (p.kind) {
    case "member":
      return { tenant_id: p.tenant_id, outlet_ids: p.outlet_ids, role: p.role, member_id: p.member_id };
    case "operator":
      return { role: "operator", operator_id: p.operator_id };
    case "customer":
      // No outlet wildcard (W1 fixes #31, #77): customer_scope decides what a customer sees; the guard refuses
      // a customer under '{*}'. A storefront command sets the order's outlet itself.
      return {
        tenant_id: p.tenant_id,
        outlet_ids: [],
        role: "customer",
        customer_id: p.customer_id,
        ...(extras.coupon_codes?.length ? { coupon_codes: extras.coupon_codes } : {}),
        ...(extras.claim_guest_access_hash ? { guest_access_hash: extras.claim_guest_access_hash } : {}),
      };
    case "guest":
      // Never a customer_id: a token holder sees that one order, not the customer behind it.
      return { tenant_id: p.tenant_id, outlet_ids: [], role: "guest", guest_access_hash: p.guest_access_hash };
  }
}
