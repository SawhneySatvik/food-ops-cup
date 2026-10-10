// Accounts module (T-035; ledger R41, R42). Mounted by modules/index.ts. Storefront key + the customer's own
// token on every route; one login, a separate profile per merchant (the storefront key names the merchant).
//   GET  /v1/account                 profile (404 before the first sign-in here)
//   POST /v1/account:link            customers.account.link.v1   first sign-in → profile; X-Munim-Guest-Token claims that order
//   POST /v1/account/profile         customers.profile.update.v1
//   POST /v1/account/consent         customers.consent.set.v1
//   GET  /v1/account/orders          own orders at this merchant (limit, cursor)
//   GET  /v1/account/orders/{id}     one own order + lines (404 for anyone else's)
//   GET  /v1/account/loyalty         latest balance_after + entries
//   POST /v1/account:export          customers.data.export.v1    → the customer's own rows as JSON
//   POST /v1/account:erase           customers.erasure.request.v1 personal fields anonymised, orders kept
// Seam (W2 brief): `ensureProfile(c, seed) → customer_id` — T-032 calls it before placing a signed-in
// shopper's order. It commits its own customers.account.link.v1 transaction (the guard admits a core.customer
// insert only under that command), so it must run BEFORE the placement transaction, not inside it.
import { createHash } from "node:crypto";
import { commandEnvelopeOf, type CommandEnvelope } from "@munim/contracts";
import {
  CustomersAccountLinkV1, CustomersConsentSetV1, CustomersDataExportV1, CustomersErasureRequestV1, CustomersProfileUpdateV1,
} from "@munim/contracts/accounts";
import { Hono, type Context } from "hono";
import type pg from "pg";
import { contextOf, GUEST_TOKEN_HEADER, requireCustomer, type Principal, type ShopperExtras } from "../../auth/resolve.ts";
import { executeCommand, replayHeaders, uuidv7, type CommandHandler } from "../../commit/index.ts";
import { withContext } from "../../lib/db.ts";
import { ApiError } from "../../lib/errors.ts";
import type { AppEnv } from "../../lib/types.ts";
import {
  consentHandler, DATA_EXPORT, erasureHandler, exportHandler, LINK, linkHandler, profileUpdateHandler,
} from "./handlers.ts";
import { exportOf, loyaltyOf, orderOf, ordersOf, profileOf } from "./read.ts";

type Shopper = Extract<Principal, { kind: "customer" }>;
type SignedIn = Shopper & { sub: string };

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID = new RegExp(`^${ID}$`);

/** A customer signed in with their own token (a guest — no token — gets 401: accounts need a login). */
function signedIn(c: Context<AppEnv>): SignedIn {
  const p = c.var.principal;
  if (p.kind !== "customer") throw new ApiError("forbidden");
  if (p.sub === null) throw new ApiError("unauthenticated");
  return p as SignedIn;
}

/** A signed-in customer whose profile exists at this merchant (404 otherwise: never a hint about others). */
function withProfile(c: Context<AppEnv>): SignedIn {
  const p = signedIn(c);
  if (!p.profile) throw new ApiError("not_found");
  return p;
}

/** The email and its verification come only from the IdP — never from a payload. requireCustomer keeps just
 *  `sub` and never asks for the confirmation, so the bearer is verified again here, asking the IdP whether the
 *  address is confirmed (R1-M5: the first sign-in at a merchant is the one customer request that binds an email
 *  — R41's verified-email merge and email_verified_at depend on it). */
async function tokenEmail(c: Context<AppEnv>, p: SignedIn): Promise<{ email: string | null; verified: boolean }> {
  const m = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(c.req.header("Authorization") ?? "");
  if (!m) throw new ApiError("unauthenticated");
  let id: { sub: string; email: string | null; email_verified: boolean };
  try {
    id = await c.var.deps.idp.verify(m[1]!, { needEmailVerified: true });
  } catch {
    throw new ApiError("unauthenticated");
  }
  if (id.sub !== p.sub) throw new ApiError("unauthenticated");
  const email = id.email !== null && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(id.email) && id.email.length <= 254 ? id.email : null;
  return { email, verified: email !== null && id.email_verified === true };
}

/** hex(sha256(token)) of a presented guest token, or null when none is presented; a malformed one → 404. */
function claimHashOf(c: Context<AppEnv>): string | null {
  const token = c.req.header(GUEST_TOKEN_HEADER);
  if (token === undefined) return null;
  if (token.length < 16 || token.length > 256) throw new ApiError("not_found");
  return createHash("sha256").update(token, "utf8").digest("hex");
}

async function body(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ApiError("bad_request");
  }
}

async function execute(c: Context<AppEnv>, p: Shopper, env: CommandEnvelope, handler: CommandHandler, extras: ShopperExtras = {}) {
  const deps = c.var.deps;
  return executeCommand({
    tx: (fn) => withContext(deps.pools.core, contextOf(p, extras), fn),
    tenantId: p.tenant_id,
    actor: { kind: "customer", id: p.customer_id, role: "customer" },
    ...(deps.publish ? { publish: deps.publish } : {}),
  }, env, handler);
}

const reply = (c: Context<AppEnv>, out: { body: string; replayed: boolean }) =>
  c.body(out.body, 200, { "Content-Type": "application/json", ...replayHeaders(out) });

const isUniqueViolation = (e: unknown) => (e as { code?: unknown } | null)?.code === "23505";

async function link(c: Context<AppEnv>, p: SignedIn, env: CommandEnvelope, claimHash: string | null) {
  const { email, verified } = p.profile ? { email: null, verified: false } : await tokenEmail(c, p);
  const handler = linkHandler({
    tenantId: p.tenant_id, customerId: p.customer_id, profileExists: p.profile, sub: p.sub, email, emailVerified: verified, claimHash,
  });
  return execute(c, p, env, handler, claimHash ? { claim_guest_access_hash: claimHash } : {});
}

/**
 * The seam for T-032: the signed-in shopper's profile id at this merchant, creating the profile on first
 * sign-in by the customer's own customers.account.link.v1 (its own committed transaction — call it before the
 * placement transaction). `seed` is what checkout collected (the profile row needs a name). Updates
 * c.var.principal to profile: true. A guest (no token) → 401.
 */
export async function ensureProfile(c: Context<AppEnv>, seed: { name: string; phone: string | null }): Promise<string> {
  const p = signedIn(c);
  if (p.profile) return p.customer_id;
  const payload = CustomersAccountLinkV1.safeParse(seed);
  if (!payload.success) throw new ApiError("invalid_payload");
  const env: CommandEnvelope = { command_id: uuidv7(), idempotency_key: `account.link.${uuidv7()}`, type: LINK, payload: payload.data };
  let customerId = p.customer_id;
  try {
    await link(c, p, env, null);
  } catch (e) {
    // A concurrent first sign-in won the (tenant_id, idp_sub) unique key: use the profile it created.
    if (!isUniqueViolation(e)) throw e;
    const existing = await withContext(c.var.deps.pools.core, { tenant_id: p.tenant_id }, async (db) =>
      (await db.query<{ id: string }>(`SELECT id FROM core.customer WHERE idp_sub = $1`, [p.sub])).rows[0]?.id);
    if (!existing) throw new ApiError("conflict");
    customerId = existing;
  }
  c.set("principal", { ...p, customer_id: customerId, profile: true });
  return customerId;
}

const LinkEnvelope = commandEnvelopeOf(LINK, CustomersAccountLinkV1);
const ProfileEnvelope = commandEnvelopeOf("customers.profile.update.v1", CustomersProfileUpdateV1);
const ConsentEnvelope = commandEnvelopeOf("customers.consent.set.v1", CustomersConsentSetV1);
const ExportEnvelope = commandEnvelopeOf(DATA_EXPORT, CustomersDataExportV1);
const ErasureEnvelope = commandEnvelopeOf("customers.erasure.request.v1", CustomersErasureRequestV1);

async function envelope<T>(c: Context<AppEnv>, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }): Promise<T> {
  const env = schema.safeParse(await body(c));
  if (!env.success) throw new ApiError("invalid_payload");
  return env.data;
}

const read = <T>(c: Context<AppEnv>, p: Shopper, fn: (db: pg.PoolClient) => Promise<T>) =>
  withContext(c.var.deps.pools.core, contextOf(p), fn);

export const router = new Hono<AppEnv>()
  .get("/v1/account", requireCustomer, async (c) => {
    const p = withProfile(c);
    const profile = await read(c, p, (db) => profileOf(db, p.customer_id));
    if (!profile) throw new ApiError("not_found");
    return c.json(profile, 200);
  })
  .post("/v1/:seg{account:link}", requireCustomer, async (c) => {
    const p = signedIn(c);
    const env = await envelope(c, LinkEnvelope);
    const claimHash = claimHashOf(c);
    // Already linked here and nothing to claim: the handler refuses with 409 (a replay of the first link still
    // returns its stored result).
    try {
      return reply(c, await link(c, p, env as CommandEnvelope, claimHash));
    } catch (e) {
      if (isUniqueViolation(e)) throw new ApiError("conflict"); // a concurrent first sign-in created the profile
      throw e;
    }
  })
  .post("/v1/account/profile", requireCustomer, async (c) => {
    const p = withProfile(c);
    const env = await envelope(c, ProfileEnvelope);
    return reply(c, await execute(c, p, env as CommandEnvelope, profileUpdateHandler(p.customer_id)));
  })
  .post("/v1/account/consent", requireCustomer, async (c) => {
    const p = withProfile(c);
    const env = await envelope(c, ConsentEnvelope);
    return reply(c, await execute(c, p, env as CommandEnvelope, consentHandler(p.customer_id)));
  })
  .get("/v1/account/orders", requireCustomer, async (c) => {
    const p = withProfile(c);
    const limitQ = c.req.query("limit");
    const limit = limitQ === undefined ? 50 : Number(limitQ);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError("bad_request");
    const cursor = c.req.query("cursor") ?? null;
    if (cursor !== null && !UUID.test(cursor)) throw new ApiError("bad_request");
    return c.json(await read(c, p, (db) => ordersOf(db, p.customer_id, limit, cursor)), 200);
  })
  .get(`/v1/account/orders/:id{${ID}}`, requireCustomer, async (c) => {
    const p = withProfile(c);
    const order = await read(c, p, (db) => orderOf(db, p.customer_id, c.req.param("id")));
    if (!order) throw new ApiError("not_found");
    return c.json(order, 200);
  })
  .get("/v1/account/loyalty", requireCustomer, async (c) => {
    const p = withProfile(c);
    return c.json(await read(c, p, (db) => loyaltyOf(db, p.customer_id)), 200);
  })
  .post("/v1/:seg{account:export}", requireCustomer, async (c) => {
    const p = withProfile(c);
    const env = await envelope(c, ExportEnvelope);
    const out = await execute(c, p, env as CommandEnvelope, exportHandler(p.customer_id));
    // The command records the request (idempotent); the export is read afterwards under the customer's own
    // scope, so a replay returns the same command result and a fresh export.
    const data = await read(c, p, (db) => exportOf(db, p.tenant_id, p.customer_id));
    if (!data) throw new ApiError("not_found");
    return c.json({ command: JSON.parse(out.body) as unknown, export: data }, 200, replayHeaders(out));
  })
  .post("/v1/:seg{account:erase}", requireCustomer, async (c) => {
    const p = withProfile(c);
    const env = await envelope(c, ErasureEnvelope);
    return reply(c, await execute(c, p, env as CommandEnvelope, erasureHandler(p.customer_id)));
  });
