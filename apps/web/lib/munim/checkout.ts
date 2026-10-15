// lib/munim/checkout.ts: from 01-api-client.md
// Cart -> preview request -> one frozen place request per checkout attempt. No money is computed here: totals
// come only from the preview and order responses.
import type { MunimError } from "./client";
import { titleCase } from "./format";
import type { Schemas } from "./types";
import { uuidv7 } from "./uuid";

type Menu = Schemas["StorefrontMenuResponse"];

/** One cart line as the shopper built it. qty is a whole count; the API wants thousandths (qty_milli). */
export interface CartLine {
  key: string;
  itemId: string;
  variantId: string | null;
  optionIds: string[];
  qty: number;
  /** Free text for the kitchen, e.g. the message on a cake (≤ 200 chars). Sent only when placing; never priced. */
  note: string | null;
}
/** ASAP = both null. A chosen window: its id with promisedAt null (the API then promises the window's start). */
export interface Slot {
  pickupWindowId: string | null;
  promisedAt: string | null;
}
export interface Cart {
  outletId: string;
  lines: CartLine[];
  slot: Slot;
  /** Upper case, ^[A-Z0-9][A-Z0-9-]{2,31}$, at most 5. */
  couponCodes: string[];
}
export interface Contact {
  name: string;
  /** E.164, e.g. "+919812345678"; null when the shopper gave only an email. */
  phone: string | null;
  email: string | null;
  marketing: boolean;
}

export const ASAP: Slot = { pickupWindowId: null, promisedAt: null };
export const COUPON_PATTERN = /^[A-Z0-9][A-Z0-9-]{2,31}$/;
export const E164_PATTERN = /^\+[1-9][0-9]{6,14}$/;
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const NOTE_MAX = 200;

export const newCartLine = (itemId: string, variantId: string | null, optionIds: string[], qty = 1, note: string | null = null): CartLine =>
  ({ key: uuidv7(), itemId, variantId, optionIds: [...optionIds].sort(), qty, note: note?.trim().slice(0, NOTE_MAX) || null });

/** A UI limit per line (the API documents none). */
export const MAX_QTY = 20;

/** Adds a line, merging it into an identical one (same item, variant and options). */
export function addToCart(cart: Cart, line: CartLine): Cart {
  const same = cart.lines.find((l) => l.itemId === line.itemId && l.variantId === line.variantId && l.optionIds.join() === line.optionIds.join() && (l.note ?? null) === (line.note ?? null));
  if (!same) return { ...cart, lines: [...cart.lines, line] };
  return { ...cart, lines: cart.lines.map((l) => (l === same ? { ...l, qty: Math.min(l.qty + line.qty, MAX_QTY) } : l)) };
}

/** The cart badge: how many things, never how much money. */
export const cartCount = (cart: Cart): number => cart.lines.reduce((n, l) => n + l.qty, 0);

/** Why an item-modal selection cannot be added yet (empty = fine). Mirrors the API's checks, so the shopper never
 *  meets a 422 or 409 for a missing variant or option. */
export function selectionProblems(item: Menu["items"][number], variantId: string | null, optionIds: string[]): string[] {
  const out: string[] = [];
  if (item.variants.length > 0) {
    const v = item.variants.find((x) => x.variant_id === variantId);
    if (!v) out.push(`Choose one: ${item.variants.map((x) => x.display_name ?? titleCase(x.name_key)).join(" or ")}`);
    else if (!v.available) out.push(`${v.display_name ?? titleCase(v.name_key)} is sold out`);
  }
  for (const g of item.option_groups) {
    const label = g.display_name ?? titleCase(g.name_key);
    const n = g.options.filter((o) => optionIds.includes(o.option_id)).length;
    if (n < g.min_select) out.push(g.min_select === 1 ? `Choose a ${label.toLowerCase()}` : `Choose at least ${g.min_select}: ${label}`);
    if (n > g.max_select) out.push(`Choose at most ${g.max_select}: ${label}`);
  }
  return out;
}

/** Deal ids a preview line applied, read from its deal_refs ("⟨cite:row:core.deal:<id>⟩"); match them to menu.deals[].deal_id. */
export const dealIdsOf = (refs: readonly string[]): string[] => refs.flatMap((r) => /core\.deal:([0-9a-f-]{36})/.exec(r)?.[1] ?? []);

/** The order's brand: the items' brand when the whole cart is one brand's, else null. */
export function cartBrandId(cart: Cart, menu: Menu): string | null {
  const ids = new Set(cart.lines.map((l) => menu.items.find((i) => i.item_id === l.itemId)?.brand_id ?? null));
  const [only] = [...ids];
  return ids.size === 1 && only ? only : null;
}

export function previewRequest(cart: Cart, menu: Menu): Schemas["OrdersPreviewRequest"] {
  return {
    outlet_id: cart.outletId,
    channel_id: menu.channel_id, // the key's own channel; the server overwrites it anyway
    brand_id: cartBrandId(cart, menu),
    kind: "pickup",
    pickup_window_id: cart.slot.pickupWindowId,
    promised_at: cart.slot.promisedAt,
    coupon_codes: cart.couponCodes,
    loyalty_redeem_points: 0, // guests cannot redeem points
    lines: cart.lines.map((l) => ({ item_id: l.itemId, variant_id: l.variantId, option_ids: l.optionIds, qty_milli: l.qty * 1000, barcode: null })),
  };
}

/** One checkout attempt: the exact place request, built once (ids, keys and consent time included).
 *  After a network failure, timeout, 429 or 5xx, send attempt.body again UNCHANGED: the API answers with the original
 *  order (X-Munim-Replayed: true) and never places twice. After any other error, or any change to the cart, slot,
 *  coupon or contact, build a new attempt. */
export interface Attempt {
  fingerprint: string;
  body: Schemas["StorefrontOrderPlaceRequest"];
}

/** What the shopper confirmed. A different fingerprint means a new attempt. */
export const attemptFingerprint = (cart: Cart, contact: Contact, previewTotalMinor: number): string =>
  JSON.stringify([cart.outletId, cart.lines.map((l) => [l.itemId, l.variantId, l.optionIds, l.qty, l.note ?? null]), cart.slot, cart.couponCodes, contact, previewTotalMinor]);

export function newAttempt(cart: Cart, menu: Menu, contact: Contact, previewTotalMinor: number): Attempt {
  const p = previewRequest(cart, menu);
  return {
    fingerprint: attemptFingerprint(cart, contact, previewTotalMinor),
    body: {
      order: {
        command_id: uuidv7(),
        idempotency_key: uuidv7(),
        type: "orders.place.v1",
        payload: {
          order_id: uuidv7(),
          outlet_id: p.outlet_id,
          channel_id: p.channel_id,
          brand_id: p.brand_id,
          device_id: null,
          kind: "pickup",
          table_ref: null,
          pickup_window_id: p.pickup_window_id,
          promised_at: p.promised_at,
          external_ref: null,
          // Line ids belong to the attempt: a line id already used by a placed order is refused.
          lines: p.lines.map((l, i) => ({ line_id: uuidv7(), item_id: l.item_id, variant_id: l.variant_id, option_ids: l.option_ids, qty_milli: l.qty_milli, barcode: null, note: cart.lines[i]?.note ?? null })),
          coupon_codes: p.coupon_codes,
          loyalty_redeem_points: 0,
          preview_total_minor: previewTotalMinor, // the server total the shopper saw; a different re-price is refused
          client_totals: null, // the server ignores client totals
        },
      },
      guest: {
        command_id: uuidv7(),
        idempotency_key: uuidv7(),
        type: "storefront.guest.create.v1",
        payload: {
          name: contact.name.trim(),
          phone: contact.phone,
          email: contact.email,
          consent: { marketing: contact.marketing, at: new Date().toISOString() }, // frozen with the attempt
        },
      },
      contact: null,
    },
  };
}

/** True when the same attempt may be sent again unchanged. */
export const retryable = (e: MunimError): boolean => e.kind === "network" || e.kind === "rate_limited" || e.kind === "server";
