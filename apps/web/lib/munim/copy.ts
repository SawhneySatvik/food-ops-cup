// lib/munim/copy.ts: from 01-api-client.md
// Every user-facing string about API state, chosen by code. The server's error.message is never shown.
import type { MunimError, RefusalParams } from "./client";
import type { Schemas } from "./types";

export interface CopyContext {
  /** The display name of a menu item id (from the menu you loaded), or null. */
  itemName: (itemId: string) => string | null;
  /** The display name of cart line N (1-based), or null. */
  lineName: (lineNo: number) => string | null;
  /** The display name of a deal id (your label for its name_key), or null. */
  dealName: (dealId: string) => string | null;
  outletName: string;
  /** next_open from GET .../state, already formatted with formatWhen, or null. */
  nextOpen: string | null;
  money: (minor: number, currency: string) => string;
}

export function refusalText(reason: string, params: RefusalParams, ctx: CopyContext): string {
  const item = (params.item_id ? ctx.itemName(params.item_id) : null) ?? (params.line_no ? ctx.lineName(params.line_no) : null) ?? "An item";
  const deal = (params.deal_id ? ctx.dealName(params.deal_id) : null) ?? "promotional";
  switch (reason) {
    case "window_full":
      return "That pickup time just filled up. Please choose another.";
    case "outlet_paused":
      return ctx.nextOpen ? `${ctx.outletName} stopped taking orders a moment ago. Back at ${ctx.nextOpen}.` : `${ctx.outletName} stopped taking orders a moment ago.`;
    case "item_sold_out":
      return `${item} just sold out. Remove it to continue.`;
    case "item_unavailable":
      return `${item} isn't available right now. Remove it to continue.`;
    case "deal_changed":
      return `The ${deal} deal was updated. Please review your cart.`;
    case "deal_rejudged":
      return params.old_total_minor !== undefined && params.new_total_minor !== undefined && params.currency
        ? `The ${deal} deal isn't available at that time. Your total changed from ${ctx.money(params.old_total_minor, params.currency)} to ${ctx.money(params.new_total_minor, params.currency)}.`
        : `The ${deal} deal isn't available at that time. Please review your total.`;
    case "preview_total_changed":
      return "The total changed since the preview. Review it and try again.";
    case "coupon_invalid":
      return "This coupon isn't valid.";
    case "coupon_expired":
      return "This coupon has expired.";
    case "coupon_out_of_scope":
      return "This coupon isn't valid at this outlet.";
    case "coupon_cap_reached":
      return "This coupon has reached its limit.";
    case "coupon_min_spend":
      return params.shortfall_minor !== undefined && params.currency
        ? `Spend ${ctx.money(params.shortfall_minor, params.currency)} more to use this coupon.`
        : "Spend a little more to use this coupon.";
    case "pickup_time_outside_window":
      return "That pickup time isn't available. Please choose another.";
    case "change_window_closed":
      return "It's too late to change this order online. Please call the outlet.";
    case "guest_cannot_change":
      return "Call the outlet to change this order";
    case "rate_limited":
      return "Too many requests. Please wait a moment and try again.";
    default:
      return "Something in your order needs another look. Please review it and try again.";
  }
}

export type Where = "menu" | "checkout" | "tracker" | "cares";

/** Copy for a failed call. kind "not_found" should send the shopper to the "This link isn't valid." page instead. */
export function errorText(e: MunimError, where: Where, ctx?: CopyContext): string {
  if (e.kind === "refusal" && e.reasonCode && ctx) return refusalText(e.reasonCode, e.params, ctx);
  if (e.kind === "rate_limited") return "Too many requests. Please wait a moment and try again.";
  if (e.kind === "not_found") return "This link isn't valid.";
  if (e.kind === "network") {
    if (where === "checkout") return "No connection. We couldn't confirm your order. Try again: it won't be placed twice.";
    if (where === "tracker") return "You're offline. Showing the last update.";
    return "You're offline. Your cart is kept on this phone.";
  }
  if (where === "checkout") return "Your order was not placed. Please try again.";
  if (where === "tracker") return "Can't load your order right now. It is still placed.";
  if (where === "cares") return "Donations couldn't load right now.";
  return "The menu couldn't load. Please try again.";
}

type Accepting = Schemas["StorefrontAcceptingResponse"];

/** The outlet state line. `nextOpen` is next_open formatted with formatWhen (null: the time part is dropped). */
export function acceptingText(a: Accepting, nextOpen: string | null): string {
  switch (a.state) {
    case "open":
      return "Open";
    case "busy":
      return `Busy — about ${a.busy_extra_min} min extra`;
    case "paused":
      return nextOpen ? `Not taking orders right now. Back at ${nextOpen}.` : "Not taking orders right now.";
    case "closed":
      return nextOpen ? `Closed. Opens ${nextOpen}.` : "Closed.";
    default:
      return "";
  }
}

/** "Ready in about N min": the outlet's prep time plus the busy extra, two row fields shown as returned. */
export const readyInMinutes = (a: Accepting): number => a.default_prep_min + (a.state === "busy" ? a.busy_extra_min : 0);

export const canOrder = (a: Accepting): boolean => a.state === "open" || a.state === "busy";

/** "Pay at the counter — cash, card or UPI." from the API's pay_at_counter_methods (null: the generic line). */
export function payAtCounterText(methods: ReadonlyArray<string> | null): string {
  const names: Record<string, string> = { cash: "cash", card: "card", upi: "UPI" };
  const known = (methods ?? []).map((m) => names[m]).filter((m): m is string => Boolean(m));
  if (known.length === 0) return "Pay at the counter.";
  const list = known.length === 1 ? known[0]! : `${known.slice(0, -1).join(", ")} or ${known[known.length - 1]!}`;
  return `Pay at the counter — ${list}.`;
}

/** Shown wherever payment is mentioned. */
export const RECORDED_ONLY = "Recorded only — Munim does not process payments.";

/** The badge on every screen of a demo business (hard rule 5): the shop always, staff screens when the tenant is_demo. */
export const SAMPLE_DATA = "Sample data";

export const DIET_LABEL: Record<string, string> = { veg: "Veg", non_veg: "Non-veg", egg: "Egg", vegan: "Vegan" };

export const STATUS_LABEL: Record<string, string> = {
  placed: "Placed",
  accepted: "Accepted",
  preparing: "Preparing",
  ready: "Ready",
  completed: "Picked up",
  rejected: "Not accepted",
  cancelled: "Cancelled",
};
