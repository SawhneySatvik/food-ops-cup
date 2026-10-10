// Kitchen rules that need no database: the ticket transition table and the KDS colour verdict (D-2 values).
// Ticket states are the DB set (0004 kitchen_ticket.status, ruling #41); the legality lives here because
// kitchen_ticket is operational (no DB transition table). Order status follows core.order_status_transition.

export type TicketStatus = "queued" | "preparing" | "ready" | "done";
export const TICKET_STATUSES: readonly TicketStatus[] = ["queued", "preparing", "ready", "done"];

/** The only legal moves: one step forward. Skips and reversals are refused (409 illegal_transition). */
export const NEXT: Readonly<Record<TicketStatus, TicketStatus | null>> = {
  queued: "preparing",
  preparing: "ready",
  ready: "done",
  done: null,
};

export const isLegalAdvance = (from: TicketStatus, to: TicketStatus): boolean => NEXT[from] === to;

/** D-2 (screens/kds.md K1): amber from `due_at − 3 min`, red at/after `due_at`. */
export const AMBER_LEAD_MS = 3 * 60 * 1000;
export type Colour = "normal" | "amber" | "red";

/** Colour of a ticket at `now`. Only tickets still in the kitchen's hands (queued, preparing) are coloured: a
 *  ready ticket waiting for pickup is not late kitchen work. No due time → normal. */
export function ticketColour(now: Date, dueAt: Date | null, status: TicketStatus): Colour {
  if (!dueAt || (status !== "queued" && status !== "preparing")) return "normal";
  const t = now.getTime();
  const due = dueAt.getTime();
  if (t >= due) return "red";
  if (t >= due - AMBER_LEAD_MS) return "amber";
  return "normal";
}

/** Order status chain the kitchen walks (each hop is a row of core.order_status_transition). */
export const ORDER_CHAIN = ["placed", "accepted", "preparing", "ready", "completed"] as const;
export type OrderChainStatus = (typeof ORDER_CHAIN)[number];

/** The order status the tickets imply, or null when they imply nothing beyond `accepted`. */
export function impliedOrderStatus(tickets: readonly TicketStatus[]): OrderChainStatus | null {
  if (tickets.length === 0) return null;
  if (tickets.every((s) => s === "done")) return "completed";
  if (tickets.every((s) => s === "ready" || s === "done")) return "ready";
  if (tickets.some((s) => s !== "queued")) return "preparing";
  return null;
}

/** The station a line goes to when its item has no prep_time row for the outlet. */
export const DEFAULT_STATION = "kitchen";
