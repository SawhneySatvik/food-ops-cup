// POS pure logic (T-061). No money arithmetic lives here: every amount on screen is a field core returned (preview,
// order, receipt, tender). This file builds requests, groups the menu, remembers one envelope per user intent, and maps
// a response to what the cashier sees.
import type { Schemas } from "@munim/sdk";
import { newIdempotencyKey } from "../api.ts";
import { uuidv7 } from "@munim/sdk";

export type MenuEntry = Schemas["V1CatalogueMenu"]["entries"][number];
export type Preview = Schemas["OrdersPreviewResponse"];
export type OrderKind = "takeaway" | "dine_in";

export interface CartLine {
  /** The core.order_line id, minted when the line is first added so a retried place resends the same one. */
  lineId: string;
  entry: MenuEntry;
  optionIds: string[];
  qtyMilli: number;
}

export const entryKey = (e: Pick<MenuEntry, "item_id" | "variant_id">): string => `${e.item_id}:${e.variant_id ?? ""}`;
/** "butter_chicken" -> "Butter Chicken": the menu carries a display name when the owner set one, a slug otherwise. */
export const titleCase = (key: string): string => key.split("_").filter(Boolean).map((w) => w[0]!.toUpperCase() + w.slice(1)).join(" ");
export const entryName = (e: MenuEntry): string => {
  const base = e.display_name ?? titleCase(e.name_key);
  const variant = e.variant_display_name ?? (e.variant_name_key ? titleCase(e.variant_name_key) : null);
  return variant ? `${base} · ${variant}` : base;
};

/** Adds one unit: the same item + variant + options raises the quantity, anything else is a new line. */
export function addToCart(cart: CartLine[], entry: MenuEntry, optionIds: string[]): CartLine[] {
  const sig = [...optionIds].sort().join(",");
  const same = cart.find((l) => entryKey(l.entry) === entryKey(entry) && [...l.optionIds].sort().join(",") === sig);
  if (same) return cart.map((l) => (l === same ? { ...l, qtyMilli: l.qtyMilli + 1000 } : l));
  return [...cart, { lineId: uuidv7(), entry, optionIds, qtyMilli: 1000 }];
}

export function stepQty(cart: CartLine[], lineId: string, dir: 1 | -1): CartLine[] {
  return cart.flatMap((l) => {
    if (l.lineId !== lineId) return [l];
    const qty = l.qtyMilli + dir * 1000;
    return qty < 1000 ? [] : [{ ...l, qtyMilli: qty }];
  });
}

interface Where { outletId: string; channelId: string; kind: OrderKind }

export function previewBody(cart: CartLine[], w: Where): Schemas["OrdersPreviewRequest"] {
  return {
    outlet_id: w.outletId, channel_id: w.channelId, brand_id: null, kind: w.kind, pickup_window_id: null, promised_at: null,
    coupon_codes: [], loyalty_redeem_points: 0,
    lines: cart.map((l) => ({ item_id: l.entry.item_id, variant_id: l.entry.variant_id, option_ids: l.optionIds, qty_milli: l.qtyMilli, barcode: null })),
  };
}

/** `previewTotalMinor` is the total core's preview returned and the person saw — passed through, never computed. */
export function placePayload(cart: CartLine[], w: Where & { orderId: string; deviceId: string; table: string; previewTotalMinor: number }): Schemas["OrdersPlaceV1"] {
  return {
    order_id: w.orderId, outlet_id: w.outletId, channel_id: w.channelId, brand_id: null, device_id: w.deviceId, kind: w.kind,
    table_ref: w.kind === "dine_in" && w.table.trim() ? w.table.trim().slice(0, 20) : null,
    pickup_window_id: null, promised_at: null, external_ref: null, coupon_codes: [], loyalty_redeem_points: 0,
    preview_total_minor: w.previewTotalMinor, client_totals: null,
    lines: cart.map((l) => ({ line_id: l.lineId, item_id: l.entry.item_id, variant_id: l.entry.variant_id, option_ids: l.optionIds, qty_milli: l.qtyMilli, barcode: null, note: null })),
  };
}

export function groupByCategory(entries: MenuEntry[], query: string): { category: string; entries: MenuEntry[] }[] {
  const q = query.trim().toLowerCase();
  const out = new Map<string, MenuEntry[]>();
  for (const e of entries) {
    if (q && !entryName(e).toLowerCase().includes(q)) continue;
    out.set(e.category, [...(out.get(e.category) ?? []), e]);
  }
  return [...out].map(([category, list]) => ({ category, entries: list }));
}

/** An option group is satisfied when the picks are within [required ? max(min,1) : min, max]. Returns the first group
 *  that is not, so the sheet can say which. */
export function firstUnmet(groups: MenuEntry["option_groups"], picks: Record<string, string[]>): MenuEntry["option_groups"][number] | null {
  for (const g of groups) {
    const n = (picks[g.option_group_id] ?? []).length;
    if (n < (g.required ? Math.max(g.min_select, 1) : g.min_select) || n > g.max_select) return g;
  }
  return null;
}

/** One envelope per user intent (03-arch §1.6): the same `sig` returns the same command id, idempotency key and entity
 *  id, so a Retry after "No connection" resends byte-identical ids. A different `sig` is a new intent. */
export interface Intent { command_id: string; idempotency_key: string; entity_id: string }
export function createIntents() {
  let cur: { sig: string; intent: Intent } | null = null;
  return {
    get(sig: string): Intent {
      if (!cur || cur.sig !== sig) cur = { sig, intent: { command_id: uuidv7(), idempotency_key: newIdempotencyKey(), entity_id: uuidv7() } };
      return cur.intent;
    },
    clear() { cur = null; },
  };
}

export type Outcome =
  | { kind: "ok"; replayed: boolean }
  | { kind: "off" }
  | { kind: "deny" }
  | { kind: "refused"; copyKey: string; reason: string | null }
  | { kind: "err" };

interface Res { response?: Response; error?: unknown }

/** Maps a finished call to what the cashier sees. Only core's codes pick copy; core's message text is never shown. */
export function classify(res: Res, opts: { overAmountIsInvalid?: boolean } = {}): Outcome {
  const r = res.response;
  if (r && r.ok) return { kind: "ok", replayed: r.headers.get("X-Munim-Replayed") === "true" };
  if (!r) return { kind: "off" };
  if (r.status === 403) return { kind: "deny" };
  const body = (res.error as { error?: { code?: string; reason_code?: string | null } } | undefined)?.error;
  const reason = body?.reason_code ?? null;
  if (reason) return { kind: "refused", copyKey: refuseKey(reason), reason };
  if (body?.code === "invalid_payload" && opts.overAmountIsInvalid) return { kind: "refused", copyKey: "pos.refuse.over_amount", reason: null };
  if (r.status === 409 || r.status === 422) return { kind: "refused", copyKey: "pos.refuse.generic", reason: body?.code ?? null };
  return { kind: "err" };
}

const KNOWN = new Set(["price_above_mrp", "item_unavailable", "item_sold_out", "preview_total_changed", "reason_required", "order_tendered", "cash_below_rounding"]);
export const refuseKey = (reason: string): string => (KNOWN.has(reason) ? `pos.refuse.${reason}` : "pos.refuse.generic");

export const VOID_REASONS = ["wrong_item", "customer_cancelled", "quality", "other"] as const;

/** A thrown fetch (no network) becomes an empty result, which `classify` reads as "off". */
export async function settle<T extends Res>(call: () => Promise<T>): Promise<T | Res> {
  try { return await call(); } catch { return {}; }
}
