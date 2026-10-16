// Checkout (guest and signed-in) and the pricing preview. Everything runs as the shopper: the context is
// contextOf(principal) with the presented coupon codes, the channel is the storefront key's, and the customer is
// the principal's — never a payload field. Guest checkout is ONE request and ONE transaction: the guest's own
// storefront.guest.create.v1, then placeOrder; a refused placement leaves no guest row behind.
import { createHash, randomBytes } from "node:crypto";
import type { CommandEnvelope, ReasonCode, RefusalParams } from "@munim/contracts";
import { OrdersPreviewRequest } from "@munim/contracts/orders";
import { StorefrontGuestCreateV1, StorefrontOrderPlaceRequest, StorefrontPreviewResponse } from "@munim/contracts/storefront";
import type { Principal } from "../../auth/resolve.ts";
import { contextOf } from "../../auth/resolve.ts";
import { executeCommand, publishCommitted, type CommandContext, type CommandHandler, type OutboxRow } from "../../commit/index.ts";
import { asSystem, withContext } from "../../lib/db.ts";
import { ApiError } from "../../lib/errors.ts";
import type { AppEnv, Deps } from "../../lib/types.ts";
import type { Context } from "hono";
import type { Queryable } from "../../runtoken/index.ts";
import { priceLines, type PriceResult, tenantPack } from "../catalogue/index.ts";
import { assertCartBounds } from "../orders/index.ts";
import { seam } from "./config.ts";
import { channelKind, outletRow, ownRefusals, type PackRef, pricedPack, type StorefrontKind } from "./read.ts";

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

/** A refusal the shopper sees: the reason code rides on the ApiError, with its typed parameters when it has any (G-11);
 *  the copy is the web app's (contracts map). */
export const refused = (reason_code: ReasonCode, params?: RefusalParams) => new ApiError("conflict", reason_code, params ? { params } : {});

/** Kind must fit the key's channel: a table QR is dine-in with a table; the other shopper channels never dine in. */
function kindFits(kind: string, table_ref: string | null, ck: StorefrontKind): boolean {
  return ck === "table_qr" ? kind === "dine_in" && table_ref !== null : kind !== "dine_in" && table_ref === null;
}

const cmdCtx = (p: CustomerPrincipal, c: Queryable): CommandContext => ({
  tx: (fn) => fn(c),
  tenantId: p.tenant_id,
  actor: { kind: "customer", id: p.customer_id, role: "customer" },
});

type CartLines = ReadonlyArray<{ item_id: string; variant_id: string | null; option_ids: readonly string[]; qty_milli: number }>;

/** Catalogue's one pricing function (writes nothing) on the shopper's transaction, as placement prices the cart: at `at`,
 *  for the principal's customer id, with the presented coupons. Storefront reads from it what the orders preview body
 *  leaves out: per-line tax components, the order's component totals, and refusal parameters (G-03, G-11). */
const priceDetail = (c: Queryable, p: CustomerPrincipal, o: { outlet_id: string; channel_kind: string; at: string; lines: CartLines; coupon_codes: string[] }) =>
  priceLines(c, { outlet_id: o.outlet_id, channel_kind: o.channel_kind, at: o.at, coupon_codes: o.coupon_codes, customer_id: p.customer_id,
    lines: o.lines.map((l) => ({ item_id: l.item_id, variant_id: l.variant_id, option_ids: l.option_ids, qty_milli: l.qty_milli })) });

/** The parameters of a refusal: a line's item (from the cart as sent), else the pricing function's own (coupon code,
 *  min-spend shortfall) for the next refusal of that code; none for whole-cart refusals (paused, window full). */
const lineParams = (line_no: number, lines: CartLines): RefusalParams | undefined => {
  const l = lines[line_no - 1];
  return l ? { line_no, item_id: l.item_id, variant_id: l.variant_id } : undefined;
};
function withParams(refusals: ReadonlyArray<{ line_no: number | null; reason_code: ReasonCode }>, lines: CartLines, detail: PriceResult) {
  const pool = detail.refusals.filter((r) => r.line_no === null && r.params);
  const take = (code: ReasonCode) => {
    const i = pool.findIndex((d) => d.reason_code === code);
    return i < 0 ? undefined : pool.splice(i, 1)[0]!.params;
  };
  return refusals.map((r) => {
    const params = r.line_no !== null ? lineParams(r.line_no, lines) : take(r.reason_code);
    return params ? { ...r, params } : r;
  });
}

async function windowStart(c: Queryable, id: string): Promise<string> {
  const w = await c.query<{ starts_at: Date }>(`SELECT starts_at FROM core.pickup_window WHERE id = $1`, [id]);
  if (!w.rows[0]) throw new ApiError("invalid_payload");
  return w.rows[0].starts_at.toISOString();
}

export async function previewFlow(deps: Deps, principal: CustomerPrincipal, body: unknown): Promise<ReturnType<typeof StorefrontPreviewResponse.parse>> {
  const req = parse(OrdersPreviewRequest, body);
  assertCartBounds(req.lines);
  // Key's channel wins; the request's channel_id is overwritten. Redeeming points needs a signed-in profile.
  const request = { ...req, channel_id: principal.channel_id, loyalty_redeem_points: principal.profile ? req.loyalty_redeem_points : 0 };
  // One snapshot (REPEATABLE READ, READ ONLY): the preview and the detail read the same committed rows, so a price or
  // coupon committed between them cannot trip the mismatch guard below.
  return withContext(deps.pools.core, contextOf(principal, { coupon_codes: request.coupon_codes }), async (c) => {
    const ck = await channelKind(c, principal.channel_id); // a key on no shopper channel is no storefront: 404
    const outlet = await outletRow(c, request.outlet_id);
    const own = await ownRefusals(c, { outlet, pickup_window_id: request.pickup_window_id, promised_at: request.promised_at, lines: request.lines });
    const priced = await seam("previewOrder")(c, principal, request);
    // At the instant the preview priced the cart (priced_at), so both readings are of one pricing.
    const detail = await priceDetail(c, principal, { outlet_id: request.outlet_id, channel_kind: ck, at: priced.priced_at, lines: request.lines, coupon_codes: request.coupon_codes });
    const pack = await tenantPack(c);
    const lines = priced.lines.map((l) => {
      const d = detail.lines.find((x) => x.line_no === l.line_no);
      const cls = pack.tax.classes.find((x) => x.code === l.tax_class);
      // Two readings of the one pricing function disagreeing is a bug, never a figure to show.
      if (!d || !cls || d.tax_minor !== l.tax_minor || d.tax_class !== l.tax_class) throw new ApiError("internal");
      return { ...l, tax_rate_bp: cls.rate_bp, tax_components: d.components };
    });
    return {
      ...priced, lines,
      tax_components: lines.length ? detail.components : [],
      prices_include_tax: pack.tax.price_display === "inclusive",
      refusals: withParams([...own, ...priced.refusals], request.lines, detail),
    };
  }, { snapshot: true });
}

export interface Placed {
  order_id: string;
  status: string;
  ticket_no: number;
  total_minor: number;
  tax_minor: number;
  /** Null: the order's pack version cannot be read (cannot verify). */
  prices_include_tax: boolean | null;
  currency: string;
  promised_at: string | null;
  pay_at_counter: true;
  guest_access_token: string | null;
}

export async function placeFlow(c0: Context<AppEnv>, principal: CustomerPrincipal, body: unknown): Promise<{ placed: Placed; replayed: boolean }> {
  const deps = c0.var.deps;
  const req = parse(StorefrontOrderPlaceRequest, body);
  assertCartBounds(req.order.payload.lines);
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
  const hash = token ? createHash("sha256").update(token, "utf8").digest("hex") : null;
  const outbox: OutboxRow[] = [];

  const result = await withContext(deps.pools.core, contextOf(who, { coupon_codes: req.order.payload.coupon_codes }), async (c) => {
    const ck = await channelKind(c, who.channel_id);
    const p = req.order.payload;
    if (!kindFits(p.kind, p.table_ref, ck)) throw new ApiError("bad_request");
    const outlet = await outletRow(c, p.outlet_id);
    // A key already used goes straight to executeCommand: the stored result for the same body, 409 idempotency_conflict
    // for another. No refusal is judged first, so a retry is never answered by what changed since (the window it filled,
    // a pause, an item taken off sale, a coupon cap its own use reached). command_log is not the shopper's to read (0014).
    // executeCommand's own key lock, taken first (it is re-entrant in this transaction): a retry racing its original waits
    // for it to commit, then reads its key here.
    await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('core.command_log:' || $1 || ':' || $2, 0))`, [who.tenant_id, key]);
    const placed = await asSystem(c, async () =>
      (await c.query(`SELECT 1 FROM core.command_log WHERE tenant_id = $1 AND idempotency_key = $2`, [who.tenant_id, key])).rows.length > 0);
    const own = placed ? [] : await ownRefusals(c, { outlet, pickup_window_id: p.pickup_window_id, promised_at: p.promised_at, lines: p.lines });
    if (own[0]) throw refused(own[0].reason_code, own[0].line_no === null ? undefined : lineParams(own[0].line_no, p.lines));
    // G-11: the cart's own refusal, with its parameters, before anything is written — priced as placement will price it
    // (at the promise, else the window's start, else now). Placement re-prices under its locks and stays the judge.
    if (!placed) {
      const at = p.promised_at ?? (p.pickup_window_id ? await windowStart(c, p.pickup_window_id) : new Date().toISOString());
      const pre = await priceDetail(c, who, { outlet_id: p.outlet_id, channel_kind: ck, at, lines: p.lines, coupon_codes: p.coupon_codes });
      if (pre.refusals[0]) throw refused(pre.refusals[0].reason_code, pre.refusals[0].params);
    }

    // Rewritten BEFORE executeCommand so the request hash covers what was actually placed. The channel is the
    // key's; there is no POS device or external order reference on a storefront order; points only for a
    // signed-in profile. client_totals stay: recorded for tamper detection, never used for pricing.
    const command: CommandEnvelope = {
      ...req.order,
      payload: { ...p, channel_id: who.channel_id, device_id: null, external_ref: null, loyalty_redeem_points: signedIn ? p.loyalty_redeem_points : 0 },
    };
    const ctx = cmdCtx(who, c);

    // A placed key's guest row exists already: the order command alone decides (a retry that re-minted its guest envelope
    // would otherwise re-insert the same derived customer id → 500).
    if (req.guest && !placed) {
      const g = await executeCommand(ctx, req.guest, guestCreate);
      outbox.push(...g.outbox);
      await setRole(c, "customer"); // executeCommand clears the shopper role after its bookkeeping
    }
    const out = await seam("placeOrder")(ctx, who, command, hash);
    outbox.push(...out.outbox);
    await setRole(c, "customer");
    const row = (
      await c.query<{ id: string; status: string; ticket_no: number; total_minor: string; tax_minor: string; currency: string; promised_at: Date | null; channel_id: string; pack: PackRef }>(
        `SELECT id, status, ticket_no, total_minor, tax_minor, currency, promised_at, channel_id, pricing_snapshot -> 'pack' AS pack FROM core."order" WHERE id = $1`, [p.order_id])
    ).rows[0];
    if (!row) throw new ApiError("internal");
    const pack = await pricedPack(c, row.pack);
    return { out, row, inclusive: pack ? pack.tax.price_display === "inclusive" : null };
  });

  if (deps.publish) await publishCommitted(deps.publish, principal.tenant_id, outbox);
  const { out, row, inclusive } = result;
  return {
    replayed: out.replayed,
    placed: {
      order_id: row.id,
      status: row.status,
      ticket_no: row.ticket_no,
      total_minor: Number(row.total_minor),
      tax_minor: Number(row.tax_minor),
      prices_include_tax: inclusive,
      currency: row.currency,
      promised_at: row.promised_at ? row.promised_at.toISOString() : null,
      pay_at_counter: true,
      // The token exists only in this response; a replay of an already-placed order returns none.
      guest_access_token: out.replayed ? null : token,
    },
  };
}
