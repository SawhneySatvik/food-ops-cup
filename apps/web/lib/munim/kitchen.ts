// file: lib/munim/kitchen.ts
// The kitchen display's logic, with no React: display names for the board's name keys, each line's size (the
// board's lines have no variant, so it comes from the order), the two lanes, what to announce after a refetch, and
// the words for a refused step. Every number on the board is a field of GET /v1/kitchen/board.
import { titleCase } from "./format";
import { staffWriteErrorText } from "./staff-copy";
import type { MunimError } from "./client";
import type { Schemas } from "./types";

export type Board = Schemas["V1KdsBoard"];
export type Ticket = Board["tickets"][number];
type Menu = Schemas["V1CatalogueMenu"];
type Order = Schemas["V1Order"];

/** name_key -> display name, for items and options, from every menu loaded (counter and own-site); else a label
 *  for the key ("item.cardamom_knot" -> "Cardamom knot"). */
export function namesFrom(menus: readonly Menu[]): (nameKey: string) => string {
  const m = new Map<string, string>();
  for (const menu of menus) {
    for (const e of menu.entries) {
      if (e.display_name) m.set(e.name_key, e.display_name);
      for (const g of e.option_groups) for (const o of g.options) if (o.display_name) m.set(o.name_key, o.display_name);
    }
  }
  return (k) => m.get(k) ?? titleCase(k);
}

/** line_no -> the size ("1 kg (serves 8–10)", "Large") for an order's lines that have a variant. */
export function sizesOf(order: Order, menus: readonly Menu[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const l of order.lines) {
    if (!l.variant_id) continue;
    const e = menus.flatMap((m) => m.entries).find((x) => x.item_id === l.item_id && x.variant_id === l.variant_id);
    const name = e ? (e.variant_display_name ?? (e.variant_name_key ? titleCase(e.variant_name_key) : null)) : null;
    if (name) out.set(l.line_no, name);
  }
  return out;
}

/** The board's two lanes, each in core's order (red, amber, due time, ticket number). */
export function boardLanes(board: Board): { now: Ticket[]; later: Ticket[] } {
  return { now: board.tickets.filter((t) => t.lane === "now"), later: board.tickets.filter((t) => t.lane === "later") };
}

/** What changed since the last board, in words for the polite live region: "New ticket 12", "Ticket 9 ready".
 *  The first board of a session announces nothing. */
export function ticketNews(prev: Board | null, next: Board): string[] {
  if (!prev) return [];
  const before = new Map(prev.tickets.map((t) => [t.ticket_id, t]));
  const out: string[] = [];
  for (const t of next.tickets) {
    const was = before.get(t.ticket_id);
    if (!was) out.push(`New ticket ${t.ticket_no}`);
    else if (was.status !== "ready" && t.status === "ready") out.push(`Ticket ${t.ticket_no} ready`);
  }
  return out;
}

const STATION_LABEL: Record<string, string> = { kitchen: "Kitchen", bar: "Bar" };
export const stationLabel = (s: string): string => STATION_LABEL[s] ?? titleCase(s);

/** Copy for a failed ticket step. 404 = the ticket left the board. A `network` failure may have reached core (a 15 s
 *  timeout counts as one), so it says the same tap is safe: the retry sends the same envelope. */
export function stepErrorText(e: MunimError): string {
  if (e.kind === "not_found") return "This ticket isn't on the board any more. The board has been refreshed.";
  return staffWriteErrorText(e, "kitchen");
}
