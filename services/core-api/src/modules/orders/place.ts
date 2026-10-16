// Preview and placement (R40 C1, project rule 9). Both run core's one pricing function; client totals are
// never trusted. Preview writes nothing (read-only transaction). Placement re-prices inside orders.place.v1's
// transaction, refuses a preview total that no longer holds (`preview_total_changed`), books the pickup window
// under its row lock, consumes an expired-sale override at most once (0014 #49), records coupon uses, redeems
// loyalty, creates kitchen tickets, and pairs the `placed` order_event with its outbox event (#80).
import { createHash, randomBytes } from "node:crypto";
import type { CommandEnvelope, ReasonCode } from "@munim/contracts";
import { OrdersPlaceV1, OrdersPreviewRequest } from "@munim/contracts/orders";
import { evaluateAuthority } from "@munim/core-domain/authority";
import { orderTax } from "@munim/core-domain/packs";
import type { Principal } from "../../auth/resolve.ts";
import { contextOf } from "../../auth/resolve.ts";
import { type AuditEntry, type CommandHandler, type EventDraft, executeCommand, type ExecuteResult, uuidv7 } from "../../commit/index.ts";
import { withContext } from "../../lib/db.ts";
import { ApiError } from "../../lib/errors.ts";
import type { Deps } from "../../lib/types.ts";
import type { Queryable } from "../../runtoken/index.ts";
import { loadChannel, loadOutlet, type PricedCart, priceCart, saleLine } from "./pricing.ts";
import { seams } from "./seams.ts";

type Shopper = Extract<Principal, { kind: "member" } | { kind: "customer" }>;
export interface OrdersCtx {
  deps: Pick<Deps, "pools" | "publish" | "log">;
  principal: Principal;
}

const refuse = (reason_code: ReasonCode) => new ApiError("conflict", reason_code);

/** Core-owned work inside the request (batch picks, coupon caps, kitchen tickets, the loyalty value): the role
 *  is cleared (a shopper's customer_scope would hide inventory and counters) and the outlet scope narrowed to
 *  the order's one outlet; both are restored after. A role-less context can write no book row (guard → MB001). */
export async function asCore<T>(c: Queryable, outletId: string, fn: () => Promise<T>): Promise<T> {
  const prev = (await c.query<{ r: string | null; o: string | null }>(
    `SELECT current_setting('app.role', true) AS r, current_setting('app.outlet_ids', true) AS o`)).rows[0]!;
  await c.query(`SELECT set_config('app.role', '', true), set_config('app.outlet_ids', $1, true)`, [`{${outletId}}`]);
  const out = await fn();
  await c.query(`SELECT set_config('app.role', $1, true), set_config('app.outlet_ids', $2, true)`, [prev.r ?? "", prev.o ?? ""]);
  return out;
}

/** Runs `fn` under a derivation rule for one source row, then clears it (a leftover `orders.reprice` would
 *  unfreeze the order's money for the rest of the transaction). */
export async function underRule<T>(c: Queryable, rule: string, sourceRef: string, fn: () => Promise<T>): Promise<T> {
  await c.query(`SELECT set_config('app.posting_rule', $1, true), set_config('app.source_ref', $2, true)`, [rule, sourceRef]);
  const out = await fn();
  await c.query(`SELECT set_config('app.posting_rule', '', true), set_config('app.source_ref', '', true)`);
  return out;
}

function shopper(p: Principal): Shopper {
  if (p.kind !== "member" && p.kind !== "customer") throw new ApiError("forbidden");
  if (p.kind === "member" && p.role === "advisor") throw new ApiError("forbidden", "authority_denied");
  return p;
}

async function authorityRow(c: Queryable, type: string, role: string) {
  const r = await c.query<{ command_type: string; allowed_roles: string[]; scope: string; max_amount_minor: string | null; cap: string | null }>(
    `SELECT command_type, allowed_roles, scope, coalesce(role_caps ->> $2, max_amount_minor::text) AS cap, max_amount_minor
       FROM core.command_authority WHERE command_type = $1`, [type, role]);
  const row = r.rows[0];
  return row ? { command_type: row.command_type, allowed_roles: row.allowed_roles, scope: row.scope, max_amount_minor: row.cap === null ? null : Number(row.cap) } : null;
}

/** Role + outlet scope + amount cap from core.command_authority before anything runs (the guard is the backstop;
 *  it does not read caps). The cap is the caller's role's entry in `role_caps` (W2-R3: e.g. refunds — staff
 *  50000, manager 500000, owner and judge absent = uncapped), else the row's own `max_amount_minor`. This checks
 *  one request's amount; a refund's cap over the role's refunds on the order in total is refundHandler's (R1-M3). */
export async function authorise(c: Queryable, p: Extract<Principal, { kind: "member" }>, type: string, outletId: string, amount: number | null = null): Promise<void> {
  const row = await authorityRow(c, type, p.role);
  const v = row && evaluateAuthority(
    { command_type: type, role: p.role, outlet_scope: p.outlet_ids === "*" ? ["*"] : p.outlet_ids, target_outlet_id: outletId, amount_minor: amount }, [row]);
  if (!v?.allow) throw new ApiError("forbidden", "authority_denied");
}

/** The instant deals are judged at: the promise, else the pickup window's start, else now (rule 9). */
async function judgedAt(c: Queryable, outletId: string, promised: string | null, windowId: string | null): Promise<string> {
  if (promised) return new Date(promised).toISOString();
  if (windowId) {
    const w = await c.query<{ starts_at: Date }>(`SELECT starts_at FROM core.pickup_window WHERE id = $1 AND outlet_id = $2`, [windowId, outletId]);
    if (!w.rows[0]) throw new ApiError("invalid_payload");
    return w.rows[0].starts_at.toISOString();
  }
  return new Date().toISOString();
}

const cartLines = (lines: Array<{ item_id: string; variant_id: string | null; option_ids: string[]; qty_milli: number }>) =>
  lines.map((l, i) => ({ line_no: i + 1, item_id: l.item_id, variant_id: l.variant_id, option_ids: l.option_ids, qty_milli: l.qty_milli }));

/** C1 S2-5: a cart's size, judged before any line is read or priced (pricing runs several queries per line, and the storefront
 *  preview prices twice): at most 100 lines, 20 options a line and a million units a line (qty_milli 10⁹). Over → 422. */
export const CART_BOUNDS = { lines: 100, options: 20, qty_milli: 1_000_000_000 } as const;
export function assertCartBounds(lines: ReadonlyArray<{ option_ids: readonly unknown[]; qty_milli: number }>): void {
  if (lines.length > CART_BOUNDS.lines || lines.some((l) => l.option_ids.length > CART_BOUNDS.options || l.qty_milli > CART_BOUNDS.qty_milli)) {
    throw new ApiError("invalid_payload");
  }
}

// ── Preview ────────────────────────────────────────────────────────────────────────────────────────────────

/** The `previewOrder` route: WRITES NOTHING — a READ ONLY transaction, and it is asserted that no transaction id
 *  was assigned. */
export async function previewOrder(ctx: OrdersCtx, request: unknown) {
  const p = shopper(ctx.principal);
  const parsed = OrdersPreviewRequest.safeParse(request);
  if (!parsed.success) throw new ApiError("invalid_payload");
  assertCartBounds(parsed.data.lines);
  return withContext(ctx.deps.pools.core, contextOf(p, { coupon_codes: parsed.data.coupon_codes }), async (c) => {
    await c.query("SET TRANSACTION READ ONLY");
    const out = await previewIn(c, p, parsed.data);
    const tx = await c.query<{ x: string | null }>(`SELECT txid_current_if_assigned()::text AS x`);
    if (tx.rows[0]!.x !== null) throw new ApiError("internal");
    return out;
  });
}

/** The preview on the CALLER's transaction (T-032 storefront: its checkout preview and the reschedule re-price,
 *  which already holds the order's row lock). Reads only — the same pricing placement runs. */
export async function previewIn(c: Queryable, principal: Principal, req: ReturnType<typeof OrdersPreviewRequest.parse>) {
  const p = shopper(principal);
  if (p.kind === "customer" && req.channel_id !== p.channel_id) throw new ApiError("not_found");
  if (p.kind === "member") await authorise(c, p, "orders.place.v1", req.outlet_id);
  await loadOutlet(c, req.outlet_id);
  const channel = await loadChannel(c, req.channel_id);
  const at = await judgedAt(c, req.outlet_id, req.promised_at, req.pickup_window_id);
  const cart = await priceCart(c, { outlet_id: req.outlet_id, channel_kind: channel.kind, at, lines: cartLines(req.lines), coupon_codes: req.coupon_codes,
    customer_id: p.kind === "customer" ? p.customer_id : null });
  return previewBody(cart, at);
}

export function previewBody(cart: PricedCart, at: string) {
  const lines = cart.tax
    ? cart.priced.lines.map((l, i) => {
        const t = cart.tax!.lines[i]!;
        return {
          line_no: l.line_no, item_id: l.item_id, variant_id: l.variant_id, qty_milli: l.qty_milli,
          unit_price_minor: l.unit_price_minor, options_minor: l.options_minor, line_discount_minor: l.line_discount_minor,
          tax_class: l.tax_class, tax_minor: l.tax_minor, line_total_minor: t.total_minor,
          price_ref: l.price_ref, option_refs: l.option_refs, deal_refs: l.deal_refs, coupon_refs: l.coupon_refs,
        };
      })
    : [];
  return {
    label: "preview" as const,
    priced_at: at,
    currency: cart.pack.doc.currency.code,
    tax_rule: { pack_code: cart.pack.doc.code, pack_version: cart.pack.version },
    lines,
    ...cart.totals,
    refusals: cart.refusals.map((r) => ({ line_no: r.line_no ?? null, reason_code: r.reason_code })),
  };
}

// ── Placement ──────────────────────────────────────────────────────────────────────────────────────────────


const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** The orders.place.v1 handler for one principal. `guestHash` = hex sha256 of the one-time guest token (the
 *  raw token never reaches this function, the database or the command log). */
export function placeHandler(p: Shopper, guestHash: string | null): CommandHandler {
  return {
    type: "orders.place.v1",
    async run(c, cmd) {
      const parsed = OrdersPlaceV1.safeParse(cmd.payload);
      if (!parsed.success) throw new ApiError("invalid_payload");
      const o = parsed.data;
      const outlet = await loadOutlet(c, o.outlet_id);
      const channel = await loadChannel(c, o.channel_id);
      if (!channel.active) throw new ApiError("not_found");
      const member = p.kind === "member" ? p : null;
      if (!member) {
        if (p.kind !== "customer" || o.channel_id !== p.channel_id || o.device_id !== null || o.external_ref !== null) throw new ApiError("invalid_payload");
        if (outlet.accepting_orders === "paused") throw refuse("outlet_paused");
      }
      if (channel.kind === "table_qr" && (o.kind !== "dine_in" || o.table_ref === null)) throw new ApiError("invalid_payload");
      if (new Set(o.lines.map((l) => l.line_id)).size !== o.lines.length) throw new ApiError("invalid_payload");
      if (o.loyalty_redeem_points > 0 && !(p.kind === "customer" && p.profile)) throw new ApiError("invalid_payload");

      // Capacity under the window's row lock: concurrent placements serialise here; the loser sees booked = capacity.
      let promised = o.promised_at;
      if (o.pickup_window_id) {
        const w = await c.query<{ starts_at: Date; ends_at: Date; capacity_orders: number; booked: number }>(
          `SELECT starts_at, ends_at, capacity_orders, booked FROM core.pickup_window WHERE id = $1 AND outlet_id = $2 FOR UPDATE`,
          [o.pickup_window_id, o.outlet_id]);
        const win = w.rows[0];
        if (!win) throw new ApiError("invalid_payload");
        if (win.booked >= win.capacity_orders || win.ends_at.getTime() <= Date.now()) throw refuse("window_full");
        await c.query(`UPDATE core.pickup_window SET booked = booked + 1 WHERE id = $1`, [o.pickup_window_id]);
        promised ??= win.starts_at.toISOString();
      }

      const at = await judgedAt(c, o.outlet_id, promised, null);
      const customerId = p.kind === "customer" ? p.customer_id : null;
      const cart = await priceCart(c, { outlet_id: o.outlet_id, channel_kind: channel.kind, at, lines: cartLines(o.lines), coupon_codes: o.coupon_codes, customer_id: customerId });
      if (cart.refusals.length) throw refuse(cart.refusals[0]!.reason_code);
      const pack = cart.pack.doc;

      // FEFO picks for the sale; the sold batch's MRP binds (#61); expired stock is refused unless the pack
      // allows overrides and one is bound to this cart line (R40 C7).
      const picked = await asCore(c, o.outlet_id, () => seams.pickSaleBatches(c, o.outlet_id,
        o.lines.map((l, i) => ({ line_no: i + 1, line_id: l.line_id, item_id: l.item_id, qty_milli: l.qty_milli }))));
      if (picked.refusals.length) throw refuse(picked.refusals[0]!.reason_code);
      // An expired draw stands only where the pack allows overrides, for a member's sale, covered by this cart
      // line's unused override (R40 C7); inventory consumes that override once the lines exist.
      if (picked.picks.some((k) => k.expired && (!pack.expired_sale_override || !member || !k.override_id))) throw refuse("expired_batch");
      for (const k of picked.picks) {
        const l = k.line_no === null ? undefined : cart.priced.lines[k.line_no - 1];
        if (!l || k.mrp_minor === null) continue;
        const one = orderTax(pack, { channel_kind: channel.kind, lines: [{ ...saleLine(l, null), batch: { mrp_minor: k.mrp_minor } }] });
        if (!one.ok && one.refusal.reason_code === "price_above_mrp") throw refuse("price_above_mrp");
      }

      if (o.preview_total_minor !== null && o.preview_total_minor !== cart.totals.total_minor) throw refuse("preview_total_changed");

      const snapshot = {
        pack: { code: pack.code, version: cart.pack.version },
        judged_at: at,
        lines: cart.priced.lines.map((l, i) => ({
          line_id: o.lines[i]!.line_id, line_no: l.line_no, price_ref: l.price_ref, option_refs: l.option_refs, deal_refs: l.deal_refs,
          coupon_refs: l.coupon_refs, tax_class: l.tax_class, unit_price_minor: l.unit_price_minor, options_minor: l.options_minor,
        })),
        // In the order applied: a re-price applies them in this same order (R2-S2-3).
        coupons: cart.priced.coupons.map((k) => ({ coupon_id: k.coupon_id, discount_minor: k.discount_minor })),
        picks: picked.picks,
        loyalty: null as null | { entry_id: string; points: number; value_minor: number },
      };
      const placed = await c.query<{ business_date: string }>(
        `INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, brand_id, device_id, pickup_window_id, kind, table_ref, promised_at,
                                   status, customer_id, subtotal_minor, discount_minor, tax_minor, total_minor, currency, pricing_snapshot,
                                   external_ref, client_totals, guest_access_hash, created_by)
         VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9, 'placed', $10, $11, $12, $13, $14, $15, $16,
                 $17, $18, decode($19, 'hex'), $20) RETURNING business_date::text`,
        [o.order_id, o.outlet_id, o.channel_id, o.brand_id, o.device_id, o.pickup_window_id, o.kind, o.table_ref, promised, customerId,
         cart.totals.subtotal_minor, cart.totals.discount_minor, cart.totals.tax_minor, cart.totals.total_minor, pack.currency.code,
         JSON.stringify(snapshot), o.external_ref, o.client_totals === null ? null : JSON.stringify(o.client_totals), guestHash,
         member?.member_id ?? null]);
      // The order's own business date (set by the database from its outlet clock), not this process's clock (R2-S3-3).
      const bd = placed.rows[0]!.business_date;
      for (const [i, l] of o.lines.entries()) {
        const pl = cart.priced.lines[i]!;
        // The recipe in force on the order's business date (variant's own, else the item's), stamped on the line at
        // insert (its recipe column has no UPDATE grant).
        const rv = await c.query<{ id: string }>(
          `SELECT rv.id FROM core.recipe_version rv JOIN core.item i ON i.tenant_id = rv.tenant_id AND i.id = rv.item_id AND i.kind = 'dish'
            WHERE rv.item_id = $1 AND (rv.variant_id IS NOT DISTINCT FROM $2 OR rv.variant_id IS NULL)
              AND rv.valid_from <= $3::date AND (rv.valid_to IS NULL OR rv.valid_to > $3::date)
            ORDER BY rv.variant_id IS NULL, rv.version DESC LIMIT 1`, [l.item_id, l.variant_id, bd]);
        await c.query(
          `INSERT INTO core.order_line (tenant_id, id, outlet_id, order_id, line_no, item_id, variant_id, options, qty_milli, unit_price_minor,
                                        line_discount_minor, tax_minor, recipe_version_id, note, created_by)
           VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [l.line_id, o.outlet_id, o.order_id, i + 1, l.item_id, l.variant_id, JSON.stringify(l.option_ids), l.qty_milli,
           pl.unit_price_minor + pl.options_minor, pl.line_discount_minor, pl.tax_minor, rv.rows[0]?.id ?? null, l.note, member?.member_id ?? null]);
      }
      const actor = member ? { kind: "member", id: member.member_id } : { kind: "customer", id: customerId };
      await c.query(
        `INSERT INTO core.order_event (tenant_id, id, outlet_id, order_id, kind, to_status, actor)
         VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, 'status', 'placed', $4)`,
        [uuidv7(), o.outlet_id, o.order_id, JSON.stringify(actor)]);

      const overrides = await seams.consumeExpiredOverrides(c, o.order_id);
      await recordCoupons(c, o.outlet_id, o.order_id, customerId, member?.member_id ?? customerId!, pack.currency.code, cart);
      if (o.loyalty_redeem_points > 0) await redeem(c, o.outlet_id, o.order_id, o.loyalty_redeem_points, cart.totals.total_minor, snapshot);

      const audit: AuditEntry[] = [{
        entity: "core.order", entityId: o.order_id,
        after: { status: "placed", outlet_id: o.outlet_id, total_minor: cart.totals.total_minor, lines: o.lines.length },
      }, ...overrides.map((id) => ({ entity: "core.expired_sale_override", entityId: id, before: { used: false }, after: { used: true, order_id: o.order_id } }))];
      const events: EventDraft[] = [{
        type: "munim.orders.order.placed.v1", subject: o.order_id, aggregateType: "order",
        data: { order_id: o.order_id, outlet_id: o.outlet_id, channel_id: o.channel_id, status: "placed", placed_at: new Date().toISOString() },
      }];
      // Stock is consumed at placement (inventory's FEFO pick as sold, overrides already consumed); the rules'
      // source state admits a `placed` order. A cancel / reject gives it back (W2-R6, lifecycle.ts).
      const consumed = await asCore(c, o.outlet_id, () => seams.deriveOrderConsumption(c, o.order_id));
      events.push(...(consumed?.events ?? []));
      const tickets = await asCore(c, o.outlet_id, () => seams.createTicketsFor(c, o.order_id));
      audit.push(...tickets.audit);
      events.push(...tickets.events);
      return { entityId: o.order_id, audit, events };
    },
  };
}

/** Coupon caps are checked under a per-coupon transaction lock (two orders cannot both take the last use). */
async function recordCoupons(c: Queryable, outletId: string, orderId: string, customerId: string | null, appliedBy: string, currency: string, cart: PricedCart) {
  for (const k of cart.priced.coupons) {
    const full = await asCore(c, outletId, async () => {
      await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('core.coupon_use:' || $1, 0))`, [k.coupon_id]);
      const caps = (await c.query<{ global_cap: number | null; per_customer_cap: number | null }>(
        `SELECT global_cap, per_customer_cap FROM core.coupon WHERE id = $1`, [k.coupon_id])).rows[0];
      if (!caps) return true;
      // The one count catalogue's pricing uses (tenant-wide; a cancelled or rejected order's use no longer counts).
      const n = await seams.couponUses(c, k.coupon_id, customerId);
      return (caps.global_cap !== null && n.all >= caps.global_cap) || (caps.per_customer_cap !== null && n.mine >= caps.per_customer_cap);
    });
    if (full) throw refuse("coupon_cap_reached");
    await c.query(
      `INSERT INTO core.coupon_use (tenant_id, id, coupon_id, order_id, customer_id, discount_minor, currency, applied_by)
       VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, $7)`,
      [uuidv7(), k.coupon_id, orderId, customerId, k.discount_minor, currency, appliedBy]);
  }
}

/** Points are a means of payment (INFERENCE — the order's tax and total are unchanged); their value is kept in
 *  the order's pricing snapshot under the `orders.reprice` derivation (the order is `placed`). */
async function redeem(c: Queryable, outletId: string, orderId: string, points: number, total: number, snapshot: { loyalty: unknown }) {
  const r = await seams.loyaltyRedeem(c, orderId, points);
  if (r.value_minor > total) throw new ApiError("loyalty_refused");
  snapshot.loyalty = { entry_id: r.entry_id, points, value_minor: r.value_minor };
  await asCore(c, outletId, () => underRule(c, "orders.reprice", `core.order:${orderId}`, () =>
    c.query(`UPDATE core."order" SET pricing_snapshot = $2 WHERE id = $1`, [orderId, JSON.stringify(snapshot)])));
}

/** The `placeOrder` seam (T-032 storefront calls it with a customer principal). Guest tracking: either T-032
 *  passes `guest_access_hash` (hex sha256 of the token it issued), or a guest (no sign-in) gets a one-time token
 *  minted here on the first response only. Only the sha256 is ever stored (order.guest_access_hash). */
export async function placeOrder(ctx: OrdersCtx, command: CommandEnvelope, opts: { guest_access_hash?: string } = {}): Promise<{ out: ExecuteResult; guest_access_token: string | null }> {
  const p = shopper(ctx.principal);
  const payload = OrdersPlaceV1.safeParse(command.payload);
  if (!payload.success) throw new ApiError("invalid_payload");
  assertCartBounds(payload.data.lines);
  const pool = ctx.deps.pools.core;
  if (p.kind === "member") {
    await withContext(pool, contextOf(p), (c) => authorise(c, p, "orders.place.v1", payload.data.outlet_id));
  }
  // T-032 may issue the token itself and pass only its hash; otherwise a guest gets one minted here.
  if (opts.guest_access_hash !== undefined && (p.kind !== "customer" || !/^[0-9a-f]{64}$/.test(opts.guest_access_hash))) throw new ApiError("invalid_payload");
  const token = p.kind === "customer" && p.sub === null && opts.guest_access_hash === undefined ? randomBytes(32).toString("base64url") : null;
  const hash = opts.guest_access_hash ?? (token === null ? null : sha256(token));
  const actor = p.kind === "member" ? { kind: "member" as const, id: p.member_id, role: p.role } : { kind: "customer" as const, id: p.customer_id, role: "customer" };
  const out = await executeCommand({
    tx: (fn) => withContext(pool, contextOf(p, { coupon_codes: payload.data.coupon_codes }), fn),
    tenantId: p.tenant_id,
    actor,
    ...(ctx.deps.publish ? { publish: ctx.deps.publish } : {}),
    onPublishDeferred: (ids) => ctx.deps.log(`orders: ${ids.length} event(s) left for the sweeper`),
  }, command, placeHandler(p, hash));
  return { out, guest_access_token: out.replayed ? null : token };
}

