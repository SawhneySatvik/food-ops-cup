// Munim Cares public network (T-095b; ADR-015 §2). No credential: every route is read-only and rate-limited per client
// address (60 a minute, lib/ratelimit.ts). Listings come only from core.cares_network_listings (SECURITY DEFINER, exact
// column grants; it filters tenants itself) called on munim_core with no app.* context; impact and snapshots only from
// a published platform.network_snapshot. Every response key is picked by name below (the allow-list) — no tenant id,
// no cost or price. 200s are cached in-process for 30 s, keyed only by the validated query (nothing tenant-specific
// exists to share); the storefront section (modules/storefront/cares.ts) is never cached.
//   GET /v1/cares-network/cities | listings?city=&cursor=&limit= | listings/{id} | impact?city= | snapshots/{id}
import { createHash } from "node:crypto";
import { snapRef, STOREFRONT_KEY_HEADER } from "@munim/contracts";
import { CityCode } from "@munim/contracts/cares";
import { Hono, type Context } from "hono";
import type pg from "pg";
import { ApiError } from "../../lib/errors.ts";
import { type Clock, clientIp, FixedWindow, rateLimit } from "../../lib/ratelimit.ts";
import type { AppEnv } from "../../lib/types.ts";
import type { Queryable } from "../../runtoken/index.ts";

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID = new RegExp(`^${ID}$`);
const TTL_MS = 30_000;
const MAX_CACHED = 1_000;
export const NETWORK_IMPACT_TEMPLATE = "platform.cares_network_impact";
/** Hard rule 5, DECISIONS 12 Oct 2026: on every impact response, unconditionally — `all_synthetic` never gates them. */
export const IMPACT_LABELS = { data: "Measured on synthetic data", recipients: "to simulated recipients" } as const;
export const NOTE_KEY = "cares.note.check_local_rules";

// ---- wiring (server.ts passes the proxy hops from the config module, MUNIM_TRUSTED_PROXY_HOPS; a gate injects the clock,
// the hops and the key cap; state resets with it)
let hops = 0;
let now: Clock = Date.now;
const limiter = (maxKeys?: number) => new FixedWindow(60, 60_000, () => now(), maxKeys);
let networkLimiter = limiter();
let storefrontIpLimiter = limiter();
let storefrontLimiter = limiter();
const cache = new Map<string, { expires: number; body: unknown }>();

export function configureCaresNetwork(o: { now?: Clock; trustedProxyHops?: number; maxKeys?: number } = {}): void {
  now = o.now ?? Date.now;
  if (o.trustedProxyHops !== undefined) hops = o.trustedProxyHops;
  networkLimiter = limiter(o.maxKeys);
  storefrontIpLimiter = limiter(o.maxKeys);
  storefrontLimiter = limiter(o.maxKeys);
  cache.clear();
}

/** Per client address, across all network routes. */
const networkLimit = rateLimit([() => networkLimiter, (c) => clientIp(c, hops)]);
/** Per client address first (so keys made up per request cannot multiply one address's budget, nor flood the key map
 *  past its cap), then per (client address, sha256 of the storefront key); the key itself is never kept or logged. */
export const storefrontCaresLimit = rateLimit(
  [() => storefrontIpLimiter, (c) => clientIp(c, hops)],
  [() => storefrontLimiter, (c) => `${clientIp(c, hops)}|${createHash("sha256").update(c.req.header(STOREFRONT_KEY_HEADER) ?? "", "utf8").digest("hex")}`],
);

async function cached(c: Context<AppEnv>, key: string, load: () => Promise<unknown>) {
  const t = now();
  const hit = cache.get(key);
  let body = hit && hit.expires > t ? hit.body : undefined;
  if (body === undefined) {
    body = await load(); // a miss throws (404) and is not cached
    if (cache.size >= MAX_CACHED) for (const [k, v] of cache) if (v.expires <= t) cache.delete(k);
    if (cache.size >= MAX_CACHED) cache.clear();
    cache.set(key, { expires: t + TTL_MS, body });
  }
  return c.json(body as object, 200, { "Cache-Control": "public, max-age=30" });
}

// ---- listings (also the storefront section)
type ListingRow = {
  listing_id: string; city_code: string; business_name: string; outlet_name: string; pickup_from: Date; pickup_to: Date; outlet_tz: string;
  recipient_name: string; recipient_simulated: boolean;
  lines: Array<{ line_no: number; food_kind: string; label_key: string | null; label: string | null; qty_milli: number; unit: string; expires_on: string | null }> | null;
};

/** The allow-list: exactly the contract's CaresNetworkListing keys, each a row's own field (R26). */
function listingOf(r: ListingRow) {
  return {
    listing_id: r.listing_id,
    city_code: r.city_code,
    business_name: r.business_name,
    outlet_name: r.outlet_name,
    pickup_from: r.pickup_from.toISOString(),
    pickup_to: r.pickup_to.toISOString(),
    tz: r.outlet_tz,
    recipient_name: r.recipient_name,
    recipient_simulated: r.recipient_simulated,
    lines: (r.lines ?? []).map((l) => ({
      line_no: l.line_no, food_kind: l.food_kind, label_key: l.label_key, label: l.label, qty_milli: l.qty_milli, unit: l.unit, expires_on: l.expires_on,
    })),
  };
}

/** Live donations from the network function (≤ 50 a call). `tenant` is only ever a storefront key's verified tenant. */
export async function networkListings(q: Queryable, o: { city?: string | null; tenant?: string | null; listing?: string | null; after?: string | null; limit?: number }) {
  const r = await q.query<ListingRow>(
    `SELECT listing_id, city_code, business_name, outlet_name, pickup_from, pickup_to, outlet_tz, recipient_name, recipient_simulated, lines
       FROM core.cares_network_listings($1, $2, $3, $4, $5)`,
    [o.city ?? null, o.tenant ?? null, o.listing ?? null, o.after ?? null, o.limit ?? 50]);
  return r.rows.map(listingOf);
}

function query(c: Context<AppEnv>, name: string, ok: (v: string) => boolean): string | null {
  const v = c.req.query(name);
  if (v === undefined) return null;
  if (!ok(v)) throw new ApiError("bad_request");
  return v;
}
const city = (c: Context<AppEnv>) => query(c, "city", (v) => CityCode.safeParse(v).success);

// ---- impact and snapshots: published platform.network_snapshot rows only
type StoredSnapshot = {
  id: string; template_id: string; template_version: number; params: Record<string, unknown>; rows: Array<Record<string, string | number | boolean | null>>;
  row_count: number; sha256: string; created_at: Date; published_at: Date; columns: Array<Record<string, unknown>>;
};
const FACTS = ["businesses", "donations", "meals_portions_milli", "weight_g", "volume_ml", "all_synthetic"] as const;

/** The latest published network total: with `city`, one minted for that city or a network-wide one with a row for it. */
async function impact(pool: pg.Pool, cityCode: string | null) {
  const r = await pool.query<StoredSnapshot>(
    `SELECT s.id, s.template_id, s.template_version, s.rows, s.created_at
       FROM platform.network_snapshot s
      WHERE s.published_at IS NOT NULL AND s.template_id = $1
        AND CASE WHEN $2::text IS NULL THEN s.params->>'city_code' IS NULL
                 ELSE s.params->>'city_code' = $2::text
                      OR (s.params->>'city_code' IS NULL AND s.rows @> jsonb_build_array(jsonb_build_object('city_code', $2::text))) END
      ORDER BY s.created_at DESC, s.id DESC LIMIT 1`, [NETWORK_IMPACT_TEMPLATE, cityCode]);
  const s = r.rows[0];
  if (!s) throw new ApiError("not_found");
  return {
    snapshot_id: s.id,
    as_of: s.created_at.toISOString(),
    template_id: s.template_id,
    template_version: s.template_version,
    // Row i of the response is row i of the stored snapshot, so each ref opens at GET snapshots/{id}.
    rows: s.rows.map((row, i) => ({
      city_code: row.city_code ?? null,
      ...Object.fromEntries(FACTS.map((col) => [col, { value: row[col], ref: snapRef(s.id, i, col) }])),
    })),
    labels: IMPACT_LABELS,
    note_key: NOTE_KEY,
  };
}

async function publishedSnapshot(pool: pg.Pool, id: string) {
  const r = await pool.query<StoredSnapshot>(
    `SELECT s.id, s.template_id, s.template_version, s.params, s.rows, s.row_count, s.sha256, s.created_at, s.published_at, t.columns
       FROM platform.network_snapshot s
       JOIN evidence.snapshot_template t ON t.id = s.template_id AND t.version = s.template_version
      WHERE s.id = $1 AND s.published_at IS NOT NULL`, [id]);
  const s = r.rows[0];
  if (!s) throw new ApiError("not_found");
  return {
    snapshot_id: s.id, template_id: s.template_id, template_version: s.template_version, params: s.params, columns: s.columns,
    rows: s.rows, row_count: s.row_count, sha256: s.sha256, created_at: s.created_at.toISOString(), published_at: s.published_at.toISOString(),
    labels: IMPACT_LABELS, note_key: NOTE_KEY,
  };
}

export const router = new Hono<AppEnv>();
router.use("/v1/cares-network/*", networkLimit);
router
  .get("/v1/cares-network/cities", (c) =>
    cached(c, "cities", async () => {
      // The operator's directory of active cities (platform data, no tenant row behind it).
      const r = await c.var.deps.pools.core.query<{ code: string; country_code: string; name: string }>(
        `SELECT code, country_code, name FROM platform.cares_city WHERE status = 'active' ORDER BY code`);
      return { items: r.rows.map((x) => ({ code: x.code, country_code: x.country_code, name: x.name })) };
    }))
  .get("/v1/cares-network/listings", (c) => {
    const cityCode = city(c);
    const cursor = query(c, "cursor", (v) => UUID.test(v));
    const limit = Number(query(c, "limit", (v) => /^[1-9][0-9]?$/.test(v) && Number(v) <= 50) ?? 50);
    return cached(c, `listings|${cityCode ?? ""}|${cursor ?? ""}|${limit}`, async () => {
      const items = await networkListings(c.var.deps.pools.core, { city: cityCode, after: cursor, limit });
      return { items, next_cursor: items.length === limit ? items[items.length - 1]!.listing_id : null };
    });
  })
  .get(`/v1/cares-network/listings/:id{${ID}}`, (c) =>
    cached(c, `listing|${c.req.param("id")}`, async () => {
      const [item] = await networkListings(c.var.deps.pools.core, { listing: c.req.param("id"), limit: 1 });
      if (!item) throw new ApiError("not_found");
      return item;
    }))
  .get("/v1/cares-network/impact", (c) => {
    const cityCode = city(c);
    return cached(c, `impact|${cityCode ?? ""}`, () => impact(c.var.deps.pools.core, cityCode));
  })
  .get(`/v1/cares-network/snapshots/:id{${ID}}`, (c) =>
    cached(c, `snapshot|${c.req.param("id")}`, () => publishedSnapshot(c.var.deps.pools.core, c.req.param("id"))));
