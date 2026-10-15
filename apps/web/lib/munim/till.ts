// file: lib/munim/till.ts
// The till's logic, with no React: the counter cart (menu entries, chosen options, a note per line), the preview
// request, one frozen place attempt, one frozen tender attempt, and the words for the counter's own refusals.
// No money is computed here: every amount the till shows is a field of a preview, order, tender or receipt
// response. (`qty * 1000` turns the count the person tapped into the API's thousandths; it is not money.)
import { attemptFor, type CommandAttempt } from "./commands";
import { MAX_QTY, NOTE_MAX } from "./checkout";
import { shownName, titleCase } from "./format";
import type { MunimError } from "./client";
import { reasonText, staffWriteErrorText } from "./staff-copy";
import type { Schemas } from "./types";
import { uuidv7 } from "./uuid";

export type MenuEntry = Schemas["V1CatalogueMenu"]["entries"][number];
export type OrderView = Schemas["V1Order"];
export type TillKind = "takeaway" | "dine_in";

/** One cart line as the person built it: a menu entry (item × variant), the chosen option ids, a whole count, and
 *  the note for the kitchen (the message on a cake). Kept in component state only, never in storage. */
export interface TillLine {
  key: string;
  entry: MenuEntry;
  optionIds: string[];
  qty: number;
  note: string | null;
}

/** Where and how the order is taken. `deviceId` is the outlet's POS device (it numbers the invoice), or null. */
export interface TillContext {
  outletId: string;
  channelId: string;
  deviceId: string | null;
  kind: TillKind;
  /** "Eat in" only: the table as typed (1–20 characters), or null. */
  tableRef: string | null;
}

export { MAX_QTY, NOTE_MAX };

export const newTillLine = (entry: MenuEntry, optionIds: string[], note: string | null = null, qty = 1): TillLine =>
  ({ key: uuidv7(), entry, optionIds: [...optionIds].sort(), qty, note: note?.trim().slice(0, NOTE_MAX) || null });

/** Adds a line, or adds its count to an identical line (same entry, options and note). */
export function addLine(lines: readonly TillLine[], line: TillLine): TillLine[] {
  const same = lines.find((l) => l.entry.item_id === line.entry.item_id && l.entry.variant_id === line.entry.variant_id && l.optionIds.join() === line.optionIds.join() && l.note === line.note);
  if (!same) return [...lines, line];
  return lines.map((l) => (l === same ? { ...l, qty: Math.min(l.qty + line.qty, MAX_QTY) } : l));
}

/** Sets a line's count; 0 removes it. */
export const setQty = (lines: readonly TillLine[], key: string, qty: number): TillLine[] =>
  qty <= 0 ? lines.filter((l) => l.key !== key) : lines.map((l) => (l.key === key ? { ...l, qty: Math.min(qty, MAX_QTY) } : l));

/** Why the options sheet cannot add this yet (empty = fine). Mirrors the API's min / max per group, so the till
 *  never meets a 422 for a missing sponge or too many flavours. */
export function entrySelectionProblems(entry: MenuEntry, optionIds: readonly string[]): string[] {
  const out: string[] = [];
  for (const g of entry.option_groups) {
    const label = g.display_name ?? titleCase(g.name_key);
    const n = g.options.filter((o) => optionIds.includes(o.option_id)).length;
    if (n < g.min_select) out.push(g.min_select === 1 ? `Choose a ${label.toLowerCase()}` : `Choose at least ${g.min_select}: ${label}`);
    if (n > g.max_select) out.push(`Choose at most ${g.max_select}: ${label}`);
  }
  return out;
}

/** True when tapping the tile must open the options sheet (any option group, or a note field for this item). */
export const needsSheet = (entry: MenuEntry, hasNoteField: boolean): boolean => entry.option_groups.length > 0 || hasNoteField;

/** "Hazelnut Praline Cake" and "1 kg (serves 8–10) · Eggless" for a line, from the menu entry. */
export function tillLineLabel(line: Pick<TillLine, "entry" | "optionIds">): { name: string; detail: string } {
  const parts: string[] = [];
  const v = line.entry.variant_display_name ?? (line.entry.variant_name_key ? titleCase(line.entry.variant_name_key) : null);
  if (v) parts.push(v);
  for (const g of line.entry.option_groups) for (const o of g.options) if (line.optionIds.includes(o.option_id)) parts.push(shownName(o));
  return { name: shownName(line.entry), detail: parts.join(" · ") };
}

/** The order's brand: the entries' brand when every line is one brand's, else null. */
export function brandOf(lines: readonly TillLine[]): string | null {
  const ids = new Set(lines.map((l) => l.entry.brand_id));
  const [only] = [...ids];
  return ids.size === 1 && only ? only : null;
}

/** The lines as the preview takes them (no line_id, no note: the preview's line schema is strict). */
export const tillLines = (lines: readonly TillLine[]) =>
  lines.map((l) => ({ item_id: l.entry.item_id, variant_id: l.entry.variant_id, option_ids: l.optionIds, qty_milli: l.qty * 1000, barcode: null }));

export function previewBodyFor(ctx: TillContext, lines: readonly TillLine[]): Schemas["OrdersPreviewRequest"] {
  return {
    outlet_id: ctx.outletId, channel_id: ctx.channelId, brand_id: brandOf(lines), kind: ctx.kind,
    pickup_window_id: null, promised_at: null, coupon_codes: [], loyalty_redeem_points: 0, lines: tillLines(lines),
  };
}

export type PlaceAttempt = CommandAttempt<"orders.place.v1", Schemas["OrdersPlaceV1"]>;

/** What the person confirmed: the context, every line and the preview total they saw. */
export const placeFingerprint = (ctx: TillContext, lines: readonly TillLine[], previewTotalMinor: number): string =>
  JSON.stringify([ctx, lines.map((l) => [l.entry.item_id, l.entry.variant_id, l.optionIds, l.qty, l.note]), previewTotalMinor]);

/** One place attempt: reused as-is when the person taps again after a network error, timeout, 429 or 5xx;
 *  rebuilt with new ids after any change to the cart, the kind, the table or the preview total. */
export function placeAttempt(prev: PlaceAttempt | null, ctx: TillContext, lines: readonly TillLine[], previewTotalMinor: number): PlaceAttempt {
  const req = tillLines(lines);
  return attemptFor(prev, placeFingerprint(ctx, lines, previewTotalMinor), "orders.place.v1", () => ({
    order_id: uuidv7(), outlet_id: ctx.outletId, channel_id: ctx.channelId, brand_id: brandOf(lines), device_id: ctx.deviceId, kind: ctx.kind,
    table_ref: ctx.kind === "dine_in" ? ctx.tableRef : null, pickup_window_id: null, promised_at: null, external_ref: null,
    // Line ids belong to the attempt: a line id another order already used is refused (422).
    lines: req.map((r, i) => ({ line_id: uuidv7(), ...r, note: lines[i]!.note })),
    coupon_codes: [], loyalty_redeem_points: 0,
    preview_total_minor: previewTotalMinor, // the server total the person saw; a different re-price is refused (preview_total_changed)
    client_totals: null, // the server ignores client totals
  }));
}

export type TenderAttempt = CommandAttempt<"orders.tender.record.v1", Schemas["OrdersTenderRecordV1"]>;
export type TenderMethod = Schemas["OrdersTenderRecordV1"]["method"];

/** Cash: what was handed over. Core works out the amount applied, the change and the cash rounding. */
export const cashTender = (prev: TenderAttempt | null, orderId: string, tenderedMinor: number, currency: string): TenderAttempt =>
  attemptFor(prev, JSON.stringify([orderId, "cash", tenderedMinor]), "orders.tender.record.v1", () => ({
    tender_id: uuidv7(), order_id: orderId, method: "cash" as const, tendered_minor: tenderedMinor, amount_minor: null, currency, ref: null,
  }));

/** Card or UPI: the amount taken on the terminal (at most what is left to pay) and the slip or UPI reference. */
export const cardTender = (prev: TenderAttempt | null, orderId: string, method: "card" | "upi", amountMinor: number, currency: string, ref: string | null): TenderAttempt =>
  attemptFor(prev, JSON.stringify([orderId, method, amountMinor, ref]), "orders.tender.record.v1", () => ({
    tender_id: uuidv7(), order_id: orderId, method, tendered_minor: null, amount_minor: amountMinor, currency, ref,
  }));

/** The typed-amount box's starting text for a minor amount ("189.00" for 18900 INR). It only moves the decimal point
 *  for the input; parseTyped (refs.ts) moves it back. Never displayed as a figure and never added to anything. */
export function typedFromMinor(minor: number, currency: string): string {
  const digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  return new Intl.NumberFormat("en", { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: false }).format(minor / 10 ** digits);
}

// ---------------------------------------------------------------- reading an order back

/** The menu entry for an order line (item × variant), if the counter menu still has it. */
export const entryFor = (entries: readonly MenuEntry[], itemId: string, variantId: string | null): MenuEntry | undefined =>
  entries.find((e) => e.item_id === itemId && e.variant_id === variantId) ?? entries.find((e) => e.item_id === itemId);

/** Name and "1 kg (serves 8–10) · Eggless" for an order line, from the menu; "Item" when the menu lacks it. */
export function orderLineLabel(entries: readonly MenuEntry[], line: Pick<OrderView["lines"][number], "item_id" | "variant_id" | "option_ids">): { name: string; detail: string } {
  const e = entryFor(entries, line.item_id, line.variant_id);
  return e ? tillLineLabel({ entry: e, optionIds: line.option_ids }) : { name: "Item", detail: "" };
}

/** The tender a command created, read back from the order (amounts, change and rounding are core's). */
export const tenderOf = (order: OrderView, tenderId: string) => order.tenders.find((t) => t.tender_id === tenderId) ?? null;

/** Receipt lines carry an item's name_key only: its display name from the menu, else a label for the key. */
export function itemNames(entries: readonly MenuEntry[]): (nameKey: string) => string {
  const m = new Map(entries.map((e) => [e.name_key, shownName(e)]));
  return (k) => m.get(k) ?? titleCase(k);
}

/** The frozen ids of one status-step attempt (accept, reject, cancel, picked up). The payload is rebuilt from the
 *  same confirmed step and the same from-status, so a retry sends an identical envelope. */
export interface StepIds {
  fingerprint: string;
  command_id: string;
  idempotency_key: string;
}
export const stepIds = (prev: StepIds | null, fingerprint: string): StepIds =>
  prev && prev.fingerprint === fingerprint ? prev : { fingerprint, command_id: uuidv7(), idempotency_key: uuidv7() };

export const KIND_LABEL: Record<string, string> = { takeaway: "Takeaway", dine_in: "Eat in", pickup: "Pickup", delivery: "Delivery" };

/** Reasons for rejecting or cancelling an order (orders.order.reject.v1 / advance to cancelled). Codes, never free
 *  text: the shopper's tracker shows a rejected order's reason title-cased ("Out of stock"). */
export const ORDER_REASONS = [
  { code: "out_of_stock", label: "Out of stock" },
  { code: "kitchen_busy", label: "Kitchen too busy" },
  { code: "customer_asked", label: "Customer asked" },
  { code: "duplicate_order", label: "Placed twice" },
  { code: "outlet_closing", label: "Closing soon" },
] as const;

/** The status steps the counter offers for an order (the kitchen moves the rest through its tickets). */
export function counterSteps(order: Pick<OrderView, "status" | "channel_id">, counterChannelId: string | null): { accept: boolean; reject: boolean; cancel: boolean; pickedUp: boolean } {
  const web = order.channel_id !== counterChannelId;
  return {
    accept: order.status === "placed" && web,
    reject: order.status === "placed" && web,
    cancel: order.status === "placed" || order.status === "accepted",
    pickedUp: order.status === "ready",
  };
}

/** A failed write (place, tender, a status step) in the person's words. A `network` failure may have reached core
 *  (a 15 s timeout counts as one), so it never says "nothing changed": it says the same tap is safe, because the
 *  retry sends the same envelope and core replays it. Everything else is staff-copy's line. */
export const writeErrorText = (e: MunimError): string => staffWriteErrorText(e, "counter");

/** A preview or place refusal in the person's words. */
export const tillRefusalText = (code: string): string => reasonText(code) ?? "This line can't be sold right now. Remove it to continue.";
