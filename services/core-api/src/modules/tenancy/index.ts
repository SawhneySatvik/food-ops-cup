// Tenancy module (T-020). Mounted by modules/index.ts; exports `router` (full paths) and the provisionTenant seam.
//   POST /v1/onboarding                      tenancy.onboard.v1   signed-in person → owner of a new tenant (id minted by core)
//   GET  /v1/me/tenants                      where this sign-in is an active member
//   GET  /v1/me                              the caller's own member id, name, role and outlet scope (R51 A-2)
//   GET  /v1/tenant · /v1/outlets · /v1/brands · /v1/channels · /v1/devices · /v1/members   (reads, own fields)
//   POST /v1/tenant:update                   tenancy.tenant.update.v1   (country locked after onboarding, R30)
//   POST /v1/outlets · /v1/outlets/{id}:update · /v1/brands · /v1/channels · /v1/devices
//   POST /v1/members:invite                  tenancy.member.invite.v1
//   POST /v1/members:bind                    tenancy.member.bind.v1     (the invitee's first sign-in)
//   POST|GET /v1/storefront-keys · POST /v1/storefront-keys/{id}:revoke
//   POST /platform/v1/demo-sessions          demo.session.start.v1      (operator)
import { createHash } from "node:crypto";
import { CommandEnvelope } from "@munim/contracts";
import { Hono, type Context } from "hono";
import { contextOf, requireMember, requireOperator, TENANT_HEADER } from "../../auth/resolve.ts";
import { type Actor, executeCommand, type CommandHandler, replayHeaders } from "../../commit/index.ts";
import { withContext } from "../../lib/db.ts";
import { ApiError } from "../../lib/errors.ts";
import type { AppEnv } from "../../lib/types.ts";
import {
  bindHandler, brandCreateHandler, channelCreateHandler, demoHandler, deviceRegisterHandler, inviteHandler, onboardHandler,
  outletCreateHandler, outletUpdateHandler, policySetHandler, tenantUpdateHandler, deactivateHandler, roleSetHandler,
} from "./commands.ts";
import { createKey, listKeys, revokeKey } from "./storefront-keys.ts";
import { outletScopeOf } from "@munim/core-domain/authority";
import { readRoutes } from "./routes.ts";

export { provisionTenant } from "./provision.ts";
export type { ProvisionResult, ProvisionSpec } from "./provision.ts";

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID = new RegExp(`^${ID}$`, "i");

async function json(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ApiError("bad_request");
  }
}

function envelope(body: unknown): CommandEnvelope {
  const r = CommandEnvelope.safeParse(body);
  if (!r.success) throw new ApiError("invalid_payload");
  return r.data;
}

/** The verified IdP identity of a request that has no tenant yet (onboarding, discovery, bind). Only onboarding
 *  and bind tie the email to a person, so only they ask the IdP whether it is confirmed (R1-M5). */
async function whoami(c: Context<AppEnv>, needEmailVerified = false): Promise<{ sub: string; email: string | null; email_verified: boolean }> {
  const m = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(c.req.header("Authorization") ?? "");
  if (!m) throw new ApiError("unauthenticated");
  try {
    return await c.var.deps.idp.verify(m[1]!, { needEmailVerified });
  } catch {
    throw new ApiError("unauthenticated");
  }
}

/** The onboarded tenant's id: sha256(sub, idempotency key) in the UUIDv7 layout the contracts require (version and
 *  variant bits set; the other 122 bits are the hash, not a timestamp). */
export function onboardTenantId(sub: string, idempotencyKey: string): string {
  const h = createHash("sha256").update(`munim.onboard\u0000${sub}\u0000${idempotencyKey}`, "utf8").digest();
  h[6] = (h[6]! & 0x0f) | 0x70;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

function reply(c: Context<AppEnv>, out: { body: string; replayed: boolean }, status: 200 | 201 = 200) {
  return c.body(out.body, status, { "Content-Type": "application/json", ...replayHeaders(out) });
}

type MemberP = Extract<AppEnv["Variables"]["principal"], { kind: "member" }>;
const memberOf = (c: Context<AppEnv>): MemberP => {
  const p = c.var.principal;
  if (p.kind !== "member") throw new ApiError("forbidden");
  return p;
};

/** A member's own command: the guard judges role and outlet scope against core.command_authority on book tables; a handler
 *  writing only an operational table (devices) checks the same row itself. */
async function memberCommand(c: Context<AppEnv>, handler: (m: MemberP) => CommandHandler, status: 200 | 201 = 200, check?: (e: CommandEnvelope) => void) {
  const m = memberOf(c);
  const env = envelope(await json(c));
  check?.(env);
  const { deps } = c.var;
  const actor: Actor = { kind: "member", id: m.member_id, role: m.role };
  const out = await executeCommand(
    { tx: (fn) => withContext(deps.pools.core, contextOf(m), fn), tenantId: m.tenant_id, actor, ...(deps.publish ? { publish: deps.publish } : {}) },
    env, handler(m));
  return reply(c, out, status);
}

/** The path's member id must be the payload's (`/v1/members/{id}:<verb>`). */
const samePath = (c: Context<AppEnv>, verb: string) => (e: CommandEnvelope) => {
  if ((e.payload as { member_id?: unknown }).member_id !== c.req.param("action")!.slice(0, -verb.length)) throw new ApiError("invalid_payload");
};

const list = (table: string, cols: string, order = "created_at, id") => async (c: Context<AppEnv>) => {
  const m = memberOf(c);
  const rows = await withContext(c.var.deps.pools.core, contextOf(m), async (db) =>
    (await db.query(`SELECT ${cols} FROM core.${table} ORDER BY ${order}`)).rows);
  return c.json({ [`${table}s`]: rows }, 200);
};

export const router = new Hono<AppEnv>()
  // ---- self-serve onboarding: the caller has a sign-in and no tenant yet ----
  .post("/v1/onboarding", async (c) => {
    const who = await whoami(c, true);
    // The owner's email is the IdP's; an unconfirmed address is not an identity to build a tenant on (F2).
    if (!who.email || !who.email_verified) throw new ApiError("invalid_payload", null, { refs: ["identity:email"] });
    const sent = envelope(await json(c));
    const p = sent.payload as { tenant_id?: unknown; owner_member_id?: unknown };
    if (typeof p.owner_member_id !== "string" || !UUID.test(p.owner_member_id)) throw new ApiError("invalid_payload");
    // R1-m6: the tenant id is core's, never the caller's — a caller-chosen id that already exists would be refused
    // and so tell anyone that the tenant exists. It is derived from who signed in and the envelope's key, so a
    // retry of the same envelope lands on the same tenant (and replays from its command_log); the payload's
    // tenant_id is ignored. The result's entity_id names the new tenant.
    const tenant = onboardTenantId(who.sub, sent.idempotency_key);
    const env: CommandEnvelope = { ...sent, payload: { ...(sent.payload as object), tenant_id: tenant } };
    const { deps } = c.var;
    // The context is the NEW tenant with the new owner: nothing is trusted from the token but who signed in.
    const ctx = { tenant_id: tenant, outlet_ids: "*" as const, role: "owner" as const, member_id: p.owner_member_id };
    const out = await executeCommand(
      { tx: (fn) => withContext(deps.pools.core, ctx, fn), tenantId: tenant, actor: { kind: "member", id: p.owner_member_id, role: "owner" },
        ...(deps.publish ? { publish: deps.publish } : {}) },
      env, onboardHandler({ sub: who.sub, email: who.email }));
    return reply(c, out, 201);
  })
  .get("/v1/me/tenants", async (c) => {
    const who = await whoami(c);
    const r = await c.var.deps.pools.core.query<{ tenant_id: string; tenant_name: string; role: string }>(
      `SELECT tenant_id, tenant_name, role FROM core.memberships_for_sub($1)`, [who.sub]);
    return c.json({ tenants: r.rows }, 200);
  })
  // ---- the invitee's first sign-in: tenant from the invite link (header), identity from the token ----
  .post("/v1/members:bind", async (c) => {
    const who = await whoami(c, true);
    const tenant = c.req.header(TENANT_HEADER);
    // An unverified address must never claim an invite that matches it (B16): 404, same as any other mismatch.
    if (!who.email || !who.email_verified || !tenant || !UUID.test(tenant)) throw new ApiError("not_found");
    const env = envelope(await json(c));
    const member_id = (env.payload as { member_id?: unknown }).member_id;
    if (typeof member_id !== "string" || !UUID.test(member_id)) throw new ApiError("invalid_payload");
    const { deps } = c.var;
    // Who is being claimed, read inside that tenant only; a mismatch of id or email is 404 (gotcha 16).
    const row = await withContext(deps.pools.core, { tenant_id: tenant }, async (db) =>
      (await db.query<{ role: "owner" | "manager" | "staff" | "advisor" | "judge"; outlet_ids: string[] }>(
        `SELECT ms.role, ms.outlet_ids FROM core.member m JOIN core.membership ms ON ms.tenant_id = m.tenant_id AND ms.member_id = m.id
          WHERE m.id = $1 AND m.active AND ms.active AND lower(m.email) = lower($2)`, [member_id, who.email])).rows[0]);
    if (!row) throw new ApiError("not_found");
    const scope = outletScopeOf(row);
    const ctx = { tenant_id: tenant.toLowerCase(), outlet_ids: scope.includes("*") ? "*" as const : scope, role: row.role, member_id };
    const out = await executeCommand(
      { tx: (fn) => withContext(deps.pools.core, ctx, fn), tenantId: tenant.toLowerCase(), actor: { kind: "member", id: member_id, role: row.role },
        ...(deps.publish ? { publish: deps.publish } : {}) },
      env, bindHandler({ sub: who.sub, email: who.email }));
    return reply(c, out);
  })
  // ---- the caller's own membership: everything but the name is the principal requireMember resolved ----
  .get("/v1/me", requireMember, async (c) => {
    const m = memberOf(c);
    const row = await withContext(c.var.deps.pools.core, contextOf(m), async (db) =>
      (await db.query<{ name: string }>(`SELECT name FROM core.member WHERE id = $1`, [m.member_id])).rows[0]);
    if (!row) throw new ApiError("not_found");
    return c.json({ member_id: m.member_id, tenant_id: m.tenant_id, name: row.name, role: m.role, outlet_ids: m.outlet_ids }, 200);
  })
  // ---- settings (members) ----
  .get("/v1/tenant", requireMember, async (c) => {
    const m = memberOf(c);
    const row = await withContext(c.var.deps.pools.core, contextOf(m), async (db) =>
      (await db.query(`SELECT tenant_id, name, country_code, base_currency, fy_start_month, status, is_demo, onboarded_at, home_tz FROM core.tenant`)).rows[0]);
    if (!row) throw new ApiError("not_found");
    return c.json(row, 200);
  })
  .get("/v1/outlets", requireMember, list("outlet",
    "id, name, kind, tz, address, tax_ids, accepting_orders, busy_extra_min, default_prep_min, cancel_window_min, reschedule_window_min, pickup_slot_min, pickup_lead_min, upi_vpa, business_day_cutoff, phone"))
  .get("/v1/brands", requireMember, list("brand", "id, name, outlet_ids, active"))
  .get("/v1/channels", requireMember, list("channel", "id, name, kind, active"))
  .get("/v1/devices", requireMember, list("device", "id, outlet_id, kind, invoice_series, last_seen_at"))
  .get("/v1/members", requireMember, async (c) => {
    const m = memberOf(c);
    if (m.role !== "owner" && m.role !== "judge") throw new ApiError("forbidden");
    const rows = await withContext(c.var.deps.pools.core, contextOf(m), async (db) =>
      (await db.query(
        `SELECT m.id, m.name, m.email, m.active, (m.idp_sub IS NOT NULL) AS signed_in, ms.role, ms.outlet_ids
           FROM core.member m JOIN core.membership ms ON ms.tenant_id = m.tenant_id AND ms.member_id = m.id ORDER BY m.created_at, m.id`)).rows);
    return c.json({ members: rows }, 200);
  })
  .post("/v1/tenant:update", requireMember, (c) => memberCommand(c, () => tenantUpdateHandler))
  .post("/v1/outlets", requireMember, (c) => memberCommand(c, () => outletCreateHandler))
  .post(`/v1/outlets/:action{${ID}:update}`, requireMember, (c) =>
    memberCommand(c, (m) => outletUpdateHandler(m), 200, (e) => {
      if ((e.payload as { outlet_id?: unknown }).outlet_id !== c.req.param("action")!.slice(0, -":update".length)) throw new ApiError("invalid_payload");
    }))
  .post("/v1/policy", requireMember, (c) => memberCommand(c, () => policySetHandler))
  .post("/v1/brands", requireMember, (c) => memberCommand(c, () => brandCreateHandler))
  .post("/v1/channels", requireMember, (c) => memberCommand(c, () => channelCreateHandler))
  .post("/v1/devices", requireMember, (c) => memberCommand(c, (m) => deviceRegisterHandler(m)))
  .post("/v1/members:invite", requireMember, (c) => memberCommand(c, () => inviteHandler))
  .post(`/v1/members/:action{${ID}:set-role}`, requireMember, (c) =>
    memberCommand(c, () => roleSetHandler, 200, samePath(c, ":set-role")))
  .post(`/v1/members/:action{${ID}:deactivate}`, requireMember, (c) =>
    memberCommand(c, () => deactivateHandler, 200, samePath(c, ":deactivate")))
  // ---- storefront keys ----
  .post("/v1/storefront-keys", requireMember, createKey)
  .get("/v1/storefront-keys", requireMember, listKeys)
  .post(`/v1/storefront-keys/:action{${ID}:revoke}`, requireMember, (c) => revokeKey(c, c.req.param("action")!.slice(0, -":revoke".length)))
  // ---- demo session: seeded for the operator role only (code wins over ON1's visitor link — see report) ----
  .post("/platform/v1/demo-sessions", requireOperator, async (c) => {
    const p = c.var.principal;
    if (p.kind !== "operator") throw new ApiError("forbidden");
    const env = envelope(await json(c));
    const tenant = (env.payload as { tenant_id?: unknown }).tenant_id;
    if (typeof tenant !== "string" || !UUID.test(tenant)) throw new ApiError("invalid_payload");
    const { deps } = c.var;
    const ctx = { tenant_id: tenant, outlet_ids: "*" as const, role: "operator" as const, operator_id: p.operator_id };
    const out = await executeCommand(
      { tx: (fn) => withContext(deps.pools.core, ctx, fn), tenantId: tenant, actor: { kind: "operator", id: p.operator_id, role: "operator" },
        ...(deps.publish ? { publish: deps.publish } : {}) },
      env, demoHandler);
    return reply(c, out, 201);
  })
  .route("/", readRoutes);
