// file: components/staff/kitchen-ticket.tsx
"use client";
// One kitchen ticket, readable at arm's length: big ticket number, the colour as a word ("Due soon", "Late"), every
// line with its options and the customer's note large and boxed, and one 64 px button for the next step. The board
// (11) lays tickets out in lanes and refetches on every live event.
import { formatQty, formatTime } from "@/lib/munim/format";
import { ORDER_STATUS, TICKET_COLOUR, TICKET_NEXT, TICKET_STATUS } from "@/lib/munim/staff-copy";
import type { Schemas } from "@/lib/munim/types";
import { StatusPill, TICKET_TONE } from "./source";

type Ticket = Schemas["V1KdsBoard"]["tickets"][number];

/** Minutes since the ticket's timer started, from the board's own as_of (never the tablet's clock). */
export const elapsedMin = (t: Ticket, asOf: string): number => Math.max(0, Math.floor((Date.parse(asOf) - Date.parse(t.started_at)) / 60_000));

export function TicketCard({ ticket, asOf, tz, locale, names, busy, onAdvance, sizeOf }: {
  ticket: Ticket;
  asOf: string;
  tz: string;
  locale: string;
  /** Display names by name_key, from GET /v1/catalogue/menu (the board sends name keys only). */
  names: (nameKey: string) => string;
  busy: boolean;
  onAdvance: (t: Ticket, to: "preparing" | "ready" | "done") => void;
  /** The line's size ("1 kg (serves 8–10)"), read from the ticket's order: the board's lines carry no variant. */
  sizeOf?: (lineNo: number) => string | null;
}) {
  const next = TICKET_NEXT[ticket.status];
  const kind = ticket.kind === "pickup" ? "Pickup" : ticket.kind === "dine_in" ? `Table ${ticket.table_ref ?? ""}`.trim() : ticket.kind === "delivery" ? "Delivery" : "Takeaway";
  return (
    <article className="ticket" data-colour={ticket.colour} data-lane={ticket.lane} aria-label={`Ticket ${ticket.ticket_no}, ${TICKET_STATUS[ticket.status]}, ${TICKET_COLOUR[ticket.colour]}`}>
      <header className="ticket-head">
        <div>
          <p className="ticket-no">#{ticket.ticket_no}</p>
          <p className="text-[15px] font-semibold">{kind} · {ticket.channel_kind === "counter" ? "Counter" : "Web"}</p>
        </div>
        <div className="text-right">
          <p className="ticket-timer">{elapsedMin(ticket, asOf)} min</p>
          <p className="text-[15px] font-bold">{TICKET_COLOUR[ticket.colour]}{ticket.due_at ? ` · due ${formatTime(ticket.due_at, tz, locale)}` : ""}</p>
        </div>
      </header>
      <div className="ticket-lines">
        <StatusPill tone={TICKET_TONE[ticket.status]!}>{TICKET_STATUS[ticket.status]}</StatusPill>
        {ticket.lines.map((l) => (
          <div key={l.line_no} className="space-y-1">
            <p className="ticket-line"><span className="ticket-qty">{formatQty(l.qty_milli, locale)}×</span> {names(l.name_key)}{sizeOf?.(l.line_no) && <span className="font-bold"> · {sizeOf?.(l.line_no)}</span>}</p>
            {l.options.length > 0 && <p className="ticket-options">{l.options.map((o) => names(o.name_key)).join(" · ")}</p>}
            {l.note && <p className="ticket-note">“{l.note}”</p>}
          </div>
        ))}
      </div>
      {next && (
        <div className="ticket-actions">
          <button type="button" className={`btn ${next.to === "ready" ? "btn-secondary" : "btn-primary"}`} disabled={busy} onClick={() => onAdvance(ticket, next.to)}>
            {busy ? "Saving…" : next.label}
          </button>
        </div>
      )}
    </article>
  );
}

/** For the counter's order list: the order's status as a pill word. */
export const orderStatusWord = (s: string): string => ORDER_STATUS[s] ?? s;
