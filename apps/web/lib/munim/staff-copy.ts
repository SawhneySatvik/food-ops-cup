// file: lib/munim/staff-copy.ts
// Every staff-screen string about API state, chosen by code. The server's message is never shown (client.ts drops
// it). Switch on `code` first: member refusals such as already_decided or illegal_transition carry no reason_code,
// so client.ts files them under kind "invalid", which is not what the person needs to hear.
import type { MunimError } from "./client";

export type StaffWhere = "counter" | "kitchen" | "home" | "inbox" | "ask" | "cares" | "suppliers" | "sign-in" | "investigations" | "office" | "storefront" | "campaigns";

/** One line for a failed call. Callers handle kind "auth" (401: sign out) and "not_found" (404) themselves. */
export function staffErrorText(e: MunimError, where: StaffWhere): string {
  switch (e.code) {
    case "illegal_transition":
      return where === "kitchen" ? "Someone already moved this ticket. The board has been refreshed." : "This changed on another screen. It has been refreshed.";
    case "already_decided":
      return "Someone else already decided this. It has been refreshed.";
    case "stale_draft":
      return "The numbers behind this changed since it was proposed. It can no longer be approved or rejected; a new proposal will replace it.";
    case "cannot_verify":
      return "Cannot verify — some numbers in this draft no longer trace to their source rows.";
    case "execution_failed":
      return "It was approved but could not be applied. Nothing changed.";
    case "forbidden":
    case "book_write_refused":
      return (e.reasonCode && e.reasonCode !== "authority_denied" && reasonText(e.reasonCode)) || "Your role can't do this. Ask the owner.";
    case "idempotency_conflict":
      return "That didn't go through. Please try again.";
    case "currency_mismatch":
      return "That amount is in the wrong currency.";
    case "sequence_gap":
      return "Someone else ran that step first. It has been refreshed.";
    case "investigation_refused":
      return "This investigation can't take that step any more. It has been refreshed.";
    default:
      break;
  }
  if (e.reasonCode) {
    const r = reasonText(e.reasonCode);
    if (r) return r;
  }
  if (e.kind === "rate_limited") return "Too many requests. Please wait a moment and try again.";
  if (e.kind === "network") return where === "kitchen" ? "Offline. Showing the last board; changes will need a retry." : "No connection. Nothing was changed. Try again.";
  if (e.kind === "server") return where === "ask" ? "Munim can't answer right now." : "Something went wrong on our side. Try again.";
  if (where === "sign-in") return "Sign-in didn't work. Try again.";
  return "That didn't work. Please check and try again.";
}

/** A failed WRITE (any command). A `network` failure may have reached core (a 15 s timeout counts as one), so it
 *  never says "nothing changed": the same tap is safe, because the retry resends the same envelope and core replays it. */
export function staffWriteErrorText(e: MunimError, where: StaffWhere): string {
  return e.kind === "network" ? "The connection dropped before Munim answered. Tap again: it's safe and won't happen twice." : staffErrorText(e, where);
}

/** Reason codes a staff screen can meet, in the person's words; null = use the generic line. */
export function reasonText(code: string): string | null {
  const t: Record<string, string> = {
    authority_denied: "Your role can't do this. Ask the owner.",
    item_sold_out: "An item just sold out. Remove it to continue.",
    item_unavailable: "An item isn't on sale at this counter right now.",
    preview_total_changed: "The total changed since the preview. Check it and try again.",
    price_above_mrp: "An item's price is above its MRP. It can't be sold until the price is fixed.",
    expired_batch: "An item's stock has expired. It can't be sold.",
    refund_first: "This order has payments. Refund them before cancelling.",
    reason_required: "Choose a reason first.",
    cash_below_rounding: "What's left is smaller than the smallest cash step. Take it by card or UPI.",
    order_tendered: "A payment is recorded, so the time can't be moved.",
    not_applicable: "This outlet has no kitchen display.",
    stale_draft: "The numbers behind this changed since it was proposed.",
    unresolved_ref: "Cannot verify — a number did not trace to its source rows.",
    recently_rejected: "A person rejected the same proposal recently.",
    cares_not_available: "Munim Cares isn't available in this country yet.",
    cares_not_enabled: "Munim Cares isn't switched on for this business yet.",
    cares_not_opted_in: "This outlet hasn't joined Munim Cares.",
    recipient_ineligible: "That simulated recipient can't take this food. Choose another.",
    listing_expired: "The pickup time has passed. Choose a later time.",
    cooked_hold_exceeded: "Cooked food can't be held that long. Choose an earlier pickup.",
    line_expired: "An item is past its date.",
    tax_id_missing: "This outlet's tax ids are missing, so a bill can't be printed. The sale is saved.",
    qty_exceeds_on_hand: "That's more than is in stock.",
    qty_exceeds_listed: "That's more than was listed.",
    unit_mismatch: "That unit doesn't match the item's stock unit.",
    rate_limited: "Too many requests. Please wait a moment and try again.",
    // T-128
    mode_above_ceiling: "Your role can't use that mode. The owner sets the highest mode for each role.",
    theme_contrast: "Those colours are too hard to read. Pick colours with stronger contrast.",
    page_version_stale: "Someone saved a newer version while you were editing. Your changes are still here: load the newest, then save again.",
    demo_only: "Recording a message as sent is only for the demo business. Munim never sends messages.",
    demo_protected: "This is switched off on the shared demo business so it keeps working for everyone.",
    no_marketing_consent: "Nobody in this group has agreed to hear from you, so there is no one to send it to.",
    campaign_audience_unscoped: "This message's audience isn't limited to the customers it is about, so it can't be prepared.",
  };
  return t[code] ?? null;
}

/** Why an AI answer abstained (envelope.reason_code). Always shown under "Cannot verify". */
export function abstainText(code: string | null | undefined): string {
  switch (code) {
    case "model_blocked":
      return "Munim's AI is switched off or this month's AI budget is used up.";
    case "not_applicable":
      return "That question doesn't apply to the outlets you can see.";
    case "insufficient_history":
      return "There isn't enough history to answer that yet.";
    case "number_grammar":
    case "unresolved_ref":
    case "cross_tenant_ref":
    case "missing_ref":
      return "Munim couldn't trace every number in its answer to your books, so it didn't answer.";
    default:
      return "Munim couldn't answer that from your books.";
  }
}

export const ROLE_LABEL: Record<string, string> = { owner: "Owner", manager: "Manager", staff: "Staff", advisor: "Advisor", judge: "Judge" };

export const ORDER_STATUS: Record<string, string> = {
  placed: "New",
  accepted: "Accepted",
  preparing: "Preparing",
  ready: "Ready",
  completed: "Picked up",
  rejected: "Not accepted",
  cancelled: "Cancelled",
};
export const TICKET_STATUS: Record<string, string> = { queued: "Waiting", preparing: "Preparing", ready: "Ready", done: "Done" };
/** The next kitchen step and its button text; null = no further step. One step forward only. */
export const TICKET_NEXT: Record<string, { to: "preparing" | "ready" | "done"; label: string } | null> = {
  queued: { to: "preparing", label: "Start" },
  preparing: { to: "ready", label: "Ready" },
  ready: { to: "done", label: "Handed over" },
  done: null,
};
export const TICKET_COLOUR: Record<string, string> = { normal: "On time", amber: "Due soon", red: "Late" };
export const DRAFT_STATUS: Record<string, string> = {
  proposed: "Waiting for you",
  executing: "Applying",
  executed: "Applied",
  failed: "Couldn't apply",
  rejected: "Rejected",
  stale: "Out of date",
};
export const VERDICT: Record<string, string> = { approved: "Approved", edited: "Approved with edits", rejected: "Rejected" };
export const LISTING_STATUS: Record<string, string> = { published: "Waiting for pickup", allocated: "Claimed", closed: "Handed over", withdrawn: "Withdrawn" };
export const PO_STATUS: Record<string, string> = { committed: "Sent", received: "Received", cancelled: "Cancelled" };
export const TENDER_METHOD: Record<string, string> = { cash: "Cash", card: "Card", upi: "UPI" };

/** Reject reasons for drafts and findings (drafts.reject.v1 reason_code, findings.dismiss.v1 reason_code). */
export const REJECT_REASONS = [
  { code: "wrong_numbers", label: "The numbers look wrong" },
  { code: "not_needed", label: "Not needed" },
  { code: "already_done", label: "Already done" },
  { code: "bad_timing", label: "Not now" },
  { code: "other", label: "Something else" },
] as const;

/** Specialist display names (GET /v1/specialists sends name keys only). */
export const SPECIALIST_NAME: Record<string, string> = {
  manager: "Manager",
  catalogue: "Menu & Pricing",
  kitchen: "Kitchen",
  inventory_purchasing: "Stock & Purchasing",
  finance: "Finance",
  people: "People",
  customers: "Customers",
  compliance: "Compliance",
  market: "Market",
};
export const specialistName = (id: string | null | undefined): string => (id ? (SPECIALIST_NAME[id] ?? id) : "Manager");

export const SIMULATED_SUPPLIER = "Simulated supplier";
export const SIMULATED_RECIPIENT = "Simulated recipient";
export const DEMO_SIGN_IN = "Demo sign-in";
export const DEMO_SIGN_IN_OFF = "Demo sign-in is switched off on this site.";
export const CANNOT_VERIFY = "Cannot verify";
