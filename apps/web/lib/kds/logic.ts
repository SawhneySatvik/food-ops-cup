// Pure KDS rules (no React): the one-step transition table (mirrors core's kitchen/rules.ts NEXT — core still refuses
// anything else, rule 10), the three-cue state of a ticket, and ordering. Colour comes from core's verdict on the board
// row; the only thing derived here is "now ≥ due_at → late", which is the definition of late and needs no threshold.
import type { Schemas } from "@munim/sdk";

export type Ticket = Schemas["V1KdsBoard"]["tickets"][number];
export type TicketStatus = Ticket["status"];

export const NEXT: Readonly<Record<TicketStatus, TicketStatus | null>> = {
  queued: "preparing",
  preparing: "ready",
  ready: "done",
  done: null,
};

export type Cue = "new" | "in_progress" | "at_risk" | "late" | "ready";

const inKitchenHands = (s: TicketStatus) => s === "queued" || s === "preparing";

/** The ticket's cue at `nowMs` (the server-skew-corrected clock). */
export function cueOf(t: Pick<Ticket, "status" | "colour" | "due_at">, nowMs: number): Cue {
  if (t.status === "ready" || t.status === "done") return "ready";
  const lateNow = t.due_at !== null && nowMs >= Date.parse(t.due_at);
  if (t.colour === "red" || lateNow) return "late";
  if (t.colour === "amber") return "at_risk";
  return t.status === "queued" ? "new" : "in_progress";
}

const RANK: Record<Cue, number> = { late: 0, at_risk: 1, new: 2, in_progress: 3, ready: 4 };

/** Red first, then amber, then oldest first (screens/kds.md K1). */
export function sortTickets(tickets: readonly Ticket[], nowMs: number): Ticket[] {
  return [...tickets].sort((a, b) =>
    RANK[cueOf(a, nowMs)] - RANK[cueOf(b, nowMs)] || Date.parse(a.started_at) - Date.parse(b.started_at) || a.ticket_no - b.ticket_no);
}

export interface Action {
  to: TicketStatus;
  /** i18n key of the button label (and of its aria label, `${key}_aria`). */
  key: "kds.action.start" | "kds.action.ready" | "kds.action.picked_up" | "kds.action.served";
}

export function actionFor(t: Pick<Ticket, "status" | "kind">): Action | null {
  const to = NEXT[t.status];
  if (!to) return null;
  if (to === "preparing") return { to, key: "kds.action.start" };
  if (to === "ready") return { to, key: "kds.action.ready" };
  return { to, key: t.kind === "dine_in" ? "kds.action.served" : "kds.action.picked_up" };
}

/** "paneer_tikka" → "Paneer tikka": the fallback when the menu has no display name. Never passed through t(). */
export const humanize = (nameKey: string): string => {
  const s = nameKey.replace(/[_-]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** The next instant the board's colours may change without an event: the earliest future due_at of a ticket the
 *  kitchen still holds, or null. The board refetches then (plus slack) so the late verdict is core's. */
export function nextDueMs(tickets: readonly Ticket[], nowMs: number): number | null {
  let best: number | null = null;
  for (const t of tickets) {
    if (!t.due_at || !inKitchenHands(t.status) || t.lane === "later") continue;
    const d = Date.parse(t.due_at);
    if (d > nowMs && (best === null || d < best)) best = d;
  }
  return best;
}

/** Station chips: "all" plus the outlet's stations; counts are list lengths. */
export function stationCounts(tickets: readonly Ticket[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tickets) m.set(t.station, (m.get(t.station) ?? 0) + 1);
  return m;
}

const CHANNEL_KEYS: Readonly<Record<string, string>> = {
  counter: "kds.channel.counter", table_qr: "kds.channel.table_qr", pickup: "kds.channel.pickup", own_site: "kds.channel.own_site",
};

/** The i18n key (and vars) for a channel kind: "aggregator:swiggy" → "Delivery · Swiggy"; an unknown kind is humanised. */
export function channelLabel(kind: string): { key: string; vars?: Record<string, string> } | { text: string } {
  const known = CHANNEL_KEYS[kind];
  if (known) return { key: known };
  if (kind.startsWith("aggregator:")) return { key: "kds.channel.aggregator", vars: { name: humanize(kind.slice("aggregator:".length)) } };
  return { text: humanize(kind.replace(/:/g, " · ")) };
}
