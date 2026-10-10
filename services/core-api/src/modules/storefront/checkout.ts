// Checkout (guest and signed-in) and the pricing preview. Everything runs as the shopper: the context is
// contextOf(principal) with the presented coupon codes, the channel is the storefront key's, and the customer is
// the principal's — never a payload field. Guest checkout is ONE request and ONE transaction: the guest's own
// storefront.guest.create.v1, then placeOrder; a refused placement leaves no guest row behind.
import { createHash, randomBytes } from "node:crypto";
import type { CommandEnvelope, ReasonCode } from "@munim/contracts";
import { OrdersPreviewRequest, OrdersPreviewResponse as PreviewSchema } from "@munim/contracts/orders";
import { StorefrontGuestCreateV1, StorefrontOrderPlaceRequest } from "@munim/contracts/storefront";
import type { Principal } from "../../auth/resolve.ts";
import { contextOf } from "../../auth/resolve.ts";
import { executeCommand, publishCommitted, type CommandContext, type CommandHandler, type OutboxRow } from "../../commit/index.ts";
import { withContext } from "../../lib/db.ts";
import { ApiError } from "../../lib/errors.ts";
import type { AppEnv, Deps } from "../../lib/types.ts";
import type { Context } from "hono";
import type { Queryable } from "../../runtoken/index.ts";
import { seam } from "./config.ts";
import { channelKind, outletRow, ownRefusals, type StorefrontKind } from "./read.ts";

export type CustomerPrincipal = Extract<Principal, { kind: "customer" }>;

/** Customer ids are minted per request (requireCustomer); a guest's must survive a client retry of the same
 *  request, so it is derived from the tenant + the place command's idempotency key (UUIDv7-shaped). */
export function guestCustomerId(tenant: string, idempotencyKey: string): string {
  const h = createHash("sha256").update(`storefront.guest:${tenant}:${idempotencyKey}`).digest();
  h[6] = (h[6]! & 0x0f) | 0x70;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** The guest's own command: creates their customer record under the id core-api put on the principal. */
export const guestCreate: CommandHandler = {
  type: "storefront.guest.create.v1",
  async run(c, cmd) {
    const p = StorefrontGuestCreateV1.safeParse(cmd.payload);
    if (!p.success) throw new ApiError("invalid_payload");
    const r = await c.query<{ id: string }>(
      `INSERT INTO core.customer (tenant_id, id, name, phone, email, consent, is_guest)
       VALUES (current_setting('app.tenant_id')::uuid, current_setting('app.customer_id')::uuid, $1, $2, $3, $4, true) RETURNING id`,
      [p.data.name, p.data.phone, p.data.email, p.data.consent]);
    return { entityId: r.rows[0]!.id, audit: [{ entity: "core.customer", entityId: r.rows[0]!.id, after: { is_guest: true } }] };
  },
};

const setRole = (c: Queryable, role: string) => c.query(`SELECT set_config('app.role', $1, true)`, [role]);

function parse<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new ApiError("bad_request");
  return r.data;
}

/** A refusal the shopper sees: the reason code rides on the ApiError; the copy is the web app's (contracts map). */
export const refused = (reason_code: ReasonCode) => new ApiError("conflict", reason_code);

/** Kind must fit the key's channel: a table QR is dine-in with a table; the other shopper channels never dine in. */
function kindFits(kind: string, table_ref: string | null, ck: StorefrontKind): boolean {
  return ck === "table_qr" ? kind === "dine_in" && table_ref !== null : kind !== "dine_in" && table_ref === null;
}

const cmdCtx = (p: CustomerPrincipal, c: Queryable): CommandContext => ({
  tx: (fn) => fn(c),
  tenantId: p.tenant_id,
  actor: { kind: "customer", id: p.customer_id, role: "customer" },
});

export async function previewFlow(deps: Deps, principal: CustomerPrincipal, body: unknown): Promise<ReturnType<typeof PreviewSchema.parse>> {
  const req = parse(OrdersPreviewRequest, body);
  // Key's channel wins; the request's channel_id is overwritten. Redeeming points needs a signed-in profile.
  const request = { ...req, channel_id: principal.channel_id, loyalty_redeem_points: principal.profile ? req.loyalty_redeem_points : 0 };
  return withContext(deps.pools.core, contextOf(principal, { coupon_codes: request.coupon_codes }), async (c) => {
    await channelKind(c, principal.channel_id); // a key on no shopper channel is no storefront: 404
    const outlet = await outletRow(c, request.outlet_id);
    const priced = await seam("previewOrder")(cmdCtx(principal, c), request);
    const own = await ownRefusals(c, { outlet, pickup_window_id: request.pickup_window_id, promised_at: request.promised_at, lines: request.lines });
    return { ...priced, refusals: [...own, ...priced.refusals] };
  });
}

export interface Placed {
  order_id: string;
  status: string;
  ticket_no: number;
  total_minor: number;
  currency: string;
  promised_at: string | null;
  pay_at_counter: true;
  guest_access_token: string | null;
}

export async function placeFlow(c0: Context<AppEnv>, principal: CustomerPrincipal, body: unknown): Promise<{ placed: Placed; replayed: boolean }> {
  const deps = c0.var.deps;
  const req = parse(StorefrontOrderPlaceRequest, body);
  const signedIn = principal.sub !== null;
  if (signedIn === (req.guest !== null)) throw new ApiError("bad_request"); // signed in: no guest block; guest: required.
  const key = req.order.idempotency_key;
  let who: CustomerPrincipal = signedIn ? principal : { ...principal, customer_id: guestCustomerId(principal.tenant_id, key) };
  if (signedIn && !principal.profile) {
    // First sign-in at this merchant: T-035 creates the profile (its own committed command) before placement.
    if (!req.contact) throw new ApiError("bad_request");
    who = { ...principal, customer_id: await seam("ensureProfile")(c0, req.contact), profile: true };
  }
  const token = signedIn ? null : randomBytes(32).toString("base64url");
  const hash = token ? createHash("sha256").update(token, "utf8").digest() : null;
  const outbox: OutboxRow[] = [];

  const result = await withContext(deps.pools.core, contextOf(who, { coupon_codes: req.order.payload.coupon_codes }), async (c) => {
    const ck = await channelKind(c, who.channel_id);
    const p = req.order.payload;
    if (!kindFits(p.kind, p.table_ref, ck)) throw new ApiError("bad_request");
    const outlet = await outletRow(c, p.outlet_id);
    const own = await ownRefusals(c, { outlet, pickup_window_id: p.pickup_window_id, promised_at: p.promised_at, lines: p.lines });
    if (own[0]) throw refused(own[0].reason_code);

    // Rewritten BEFORE executeCommand so the request hash covers what was actually placed. The channel is the
    // key's; there is no POS device or external order reference on a storefront order; points only for a
    // signed-in profile. client_totals stay: recorded for tamper detection, never used for pricing.
    const command: CommandEnvelope = {
      ...req.order,
      payload: { ...p, channel_id: who.channel_id, device_id: null, external_ref: null, loyalty_redeem_points: signedIn ? p.loyalty_redeem_points : 0 },
    };
    const ctx = cmdCtx(who, c);

    if (req.guest) {
      const g = await executeCommand(ctx, req.guest, guestCreate);
      outbox.push(...g.outbox);
      await setRole(c, "customer"); // executeCommand clears the shopper role after its bookkeeping
    }
    const out = await seam("placeOrder")(ctx, command, { guest_access_hash: hash });
    outbox.push(...out.outbox);
    await setRole(c, "customer");
    const row = (
      await c.query<{ id: string; status: string; ticket_no: number; total_minor: string; currency: string; promised_at: Date | null; channel_id: string }>(
        `SELECT id, status, ticket_no, total_minor, currency, promised_at, channel_id FROM core."order" WHERE id = $1`, [p.order_id])
    ).rows[0];
    if (!row) throw new ApiError("internal");
    return { out, row };
  });

  if (deps.publish) await publishCommitted(deps.publish, principal.tenant_id, outbox);
  const { out, row } = result;
  return {
    replayed: out.replayed,
    placed: {
      order_id: row.id,
      status: row.status,
      ticket_no: row.ticket_no,
      total_minor: Number(row.total_minor),
      currency: row.currency,
      promised_at: row.promised_at ? row.promised_at.toISOString() : null,
      pay_at_counter: true,
      // The token exists only in this response; a replay of an already-placed order returns none.
      guest_access_token: out.replayed ? null : token,
    },
  };
}
