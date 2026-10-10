// Kitchen tickets (T-023): creation with the order (the seam T-022 calls), the advance command, the KDS board.
// kitchen_ticket is operational; the order status it drives is a book (core.order / order_event), moved only by
// orders.advanceOrder (W2-R9) inside kitchen.ticket.advance.v1, whose target_tables name exactly those two tables
// (0007) — so a completion here derives the loyalty earn and the sale posting and pairs each order_event (#80).
import type { EventDraft, AuditEntry, CommandHandler, HandlerOutput } from "../../commit/index.ts";
import { uuidv7 } from "../../commit/index.ts";
import { asSystem } from "../../lib/db.ts";
import { ApiError } from "../../lib/errors.ts";
import type { Queryable } from "../../runtoken/index.ts";
import { advanceOrder, mover } from "../orders/index.ts";
import { DEFAULT_STATION, impliedOrderStatus, isLegalAdvance, ORDER_CHAIN, ticketColour, type OrderChainStatus, type TicketStatus } from "./rules.ts";

export interface CreatedTicket {
  ticket_id: string;
  station: string;
  due_at: string;
}

export interface CreateTicketsResult {
  /** false = the outlet is a shop: the kitchen does not apply, nothing was written. */
  applicable: boolean;
  tickets: CreatedTicket[];
  /** For the caller's HandlerOutput: one `munim.kitchen.ticket.created.v1` per ticket (data.outlet_id set). */
  events: EventDraft[];
  audit: AuditEntry[];
}

/**
 * THE SEAM (T-022 calls it inside orders.place.v1's transaction, after the order and its lines exist).
 * One ticket per station the order's lines route to (prep_time rows valid on the order's business date; an item
 * with none goes to 'kitchen'). due_at = the order's promised_at, else now + the station's longest prep time,
 * else now + outlet default prep + busy minutes. Idempotent: an order that already has tickets gets none new.
 * Shops (`outlet.kind = 'store'`): applicable=false, nothing written. Short ticket numbers are the ORDER's
 * `ticket_no` (DB-assigned per outlet and business day, rolling at business_day_cutoff — 0014).
 * The caller must have the order's outlet in app.outlet_ids (kitchen_ticket RLS); the insert runs as the system
 * so a shopper's request can write it (customer_scope is read-only on kitchen tickets).
 */
export async function createTicketsFor(tx: Queryable, orderId: string): Promise<CreateTicketsResult> {
  const o = await tx.query<{
    id: string; outlet_id: string; business_date: string; promised_at: Date | null; kind: string; default_prep_min: number; busy_extra_min: number;
  }>(
    `SELECT o.id, o.outlet_id, o.business_date::text AS business_date, o.promised_at, ou.kind, ou.default_prep_min, ou.busy_extra_min
       FROM core."order" o JOIN core.outlet ou ON ou.tenant_id = o.tenant_id AND ou.id = o.outlet_id
      WHERE o.id = $1`, [orderId]);
  const order = o.rows[0];
  if (!order) throw new ApiError("not_found");
  if (order.kind === "store") return { applicable: false, tickets: [], events: [], audit: [] };

  const existing = await tx.query<{ id: string; station: string; due_at: Date | null }>(
    `SELECT id, station, due_at FROM core.kitchen_ticket WHERE order_id = $1 ORDER BY station`, [orderId]);
  if (existing.rows.length) {
    return { applicable: true, tickets: existing.rows.map((t) => ({ ticket_id: t.id, station: t.station, due_at: (t.due_at ?? new Date(0)).toISOString() })), events: [], audit: [] };
  }

  const lines = (await tx.query<{ item_id: string }>(`SELECT DISTINCT item_id FROM core.order_line WHERE order_id = $1`, [orderId])).rows;
  const prep = (await tx.query<{ item_id: string; station: string; prep_sec: number }>(
    `SELECT item_id, station, prep_sec FROM core.prep_time
      WHERE outlet_id = $1 AND item_id = ANY ($2::uuid[]) AND valid_from <= $3::date AND (valid_to IS NULL OR valid_to > $3::date)`,
    [order.outlet_id, lines.map((l) => l.item_id), order.business_date])).rows;
  // station → longest prep_sec among its lines (null = no configured time)
  const stations = new Map<string, number | null>();
  for (const l of lines) {
    const rows = prep.filter((p) => p.item_id === l.item_id);
    if (rows.length === 0) {
      if (!stations.has(DEFAULT_STATION)) stations.set(DEFAULT_STATION, null);
    } else {
      for (const r of rows) stations.set(r.station, Math.max(stations.get(r.station) ?? 0, r.prep_sec));
    }
  }
  const fallbackSec = (order.default_prep_min + order.busy_extra_min) * 60;

  const tickets: CreatedTicket[] = [];
  const events: EventDraft[] = [];
  const audit: AuditEntry[] = [];
  await asSystem(tx, async () => {
    for (const [station, sec] of [...stations].sort(([a], [b]) => a.localeCompare(b))) {
      const id = uuidv7();
      const ins = await tx.query<{ due_at: Date }>(
        `INSERT INTO core.kitchen_ticket (tenant_id, id, outlet_id, order_id, station, status, due_at)
         VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, 'queued', coalesce($5::timestamptz, now() + make_interval(secs => $6)))
         RETURNING due_at`, [id, order.outlet_id, orderId, station, order.promised_at, sec ?? fallbackSec]);
      tickets.push({ ticket_id: id, station, due_at: ins.rows[0]!.due_at.toISOString() });
      events.push({ type: "munim.kitchen.ticket.created.v1", subject: id, aggregateType: "kitchen_ticket",
        data: { ticket_id: id, order_id: orderId, outlet_id: order.outlet_id, station, status: "queued" } });
      audit.push({ entity: "core.kitchen_ticket", entityId: id, after: { order_id: orderId, station, status: "queued" } });
    }
  });
  return { applicable: true, tickets, events, audit };
}

interface TicketRow { id: string; order_id: string; outlet_id: string; station: string; status: TicketStatus }

/** kitchen.ticket.advance.v1 — one step forward, guarded by `from_status` (a stale or illegal move is 409). */
export const advanceHandler: CommandHandler = {
  type: "kitchen.ticket.advance.v1",
  async run(c, cmd): Promise<HandlerOutput> {
    const p = cmd.payload as { ticket_id: string; from_status: TicketStatus; to_status: TicketStatus };
    if (!isLegalAdvance(p.from_status, p.to_status)) throw new ApiError("illegal_transition");

    // Lock the order first, then the ticket: two stations moving at once serialise here, and the order status
    // below is derived from tickets that include the other station's committed move.
    const pre = await c.query<{ order_id: string }>(`SELECT order_id FROM core.kitchen_ticket WHERE id = $1`, [p.ticket_id]);
    if (!pre.rows[0]) throw new ApiError("not_found");
    const ord = await c.query<{ status: string; outlet_id: string }>(`SELECT status, outlet_id FROM core."order" WHERE id = $1 FOR UPDATE`, [pre.rows[0].order_id]);
    const t = (await c.query<TicketRow>(
      `SELECT id, order_id, outlet_id, station, status FROM core.kitchen_ticket WHERE id = $1 FOR UPDATE`, [p.ticket_id])).rows[0];
    if (!t || !ord.rows[0]) throw new ApiError("not_found");
    if (t.status !== p.from_status) throw new ApiError("illegal_transition");
    // A ticket of a rejected or cancelled order is not work any more.
    if (ord.rows[0].status === "rejected" || ord.rows[0].status === "cancelled") throw new ApiError("illegal_transition");

    await c.query(
      `UPDATE core.kitchen_ticket SET status = $2,
              accepted_at = CASE WHEN $2 = 'preparing' THEN coalesce(accepted_at, now()) ELSE accepted_at END,
              ready_at = CASE WHEN $2 = 'ready' THEN coalesce(ready_at, now()) ELSE ready_at END
        WHERE id = $1`, [p.ticket_id, p.to_status]);

    const all = (await c.query<{ status: TicketStatus }>(`SELECT status FROM core.kitchen_ticket WHERE order_id = $1`, [t.order_id])).rows.map((r) => r.status);
    const target = impliedOrderStatus(all);
    const audit: AuditEntry[] = [{ entity: "core.kitchen_ticket", entityId: p.ticket_id, before: { status: p.from_status }, after: { status: p.to_status } }];
    const events: EventDraft[] = [{ type: "munim.kitchen.ticket.advanced.v1", subject: p.ticket_id, aggregateType: "kitchen_ticket",
      data: { ticket_id: p.ticket_id, order_id: t.order_id, outlet_id: t.outlet_id, station: t.station, status: p.to_status, from_status: p.from_status } }];
    const from = ORDER_CHAIN.indexOf(ord.rows[0].status as OrderChainStatus);
    const to = target ? ORDER_CHAIN.indexOf(target) : -1;
    if (from >= 0 && to > from) {
      const by = await mover(c);
      for (let i = from; i < to; i++) {
        const hop = await advanceOrder(c, { order_id: t.order_id, from_status: ORDER_CHAIN[i]!, to_status: ORDER_CHAIN[i + 1]!, reason_code: null }, by);
        audit.push(...hop.audit);
        events.push(...(hop.events ?? []));
      }
    }
    return { entityId: p.ticket_id, audit, events };
  },
};

export interface BoardTicket {
  ticket_id: string; order_id: string; ticket_no: number; business_date: string; station: string; status: TicketStatus;
  kind: string; table_ref: string | null; channel_kind: string; started_at: string; accepted_at: string | null; ready_at: string | null;
  due_at: string | null; promised_at: string | null; lane: "now" | "later"; surface_at: string | null; colour: "normal" | "amber" | "red";
  lines: Array<{ line_no: number; item_id: string; name_key: string; qty_milli: number; options: Array<{ option_id: string; name_key: string }>; note: string | null }>;
}
export interface Board { outlet_id: string; as_of: string; stations: string[]; tickets: BoardTicket[] }

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const RANK = { red: 0, amber: 1, normal: 2 } as const;

/** The KDS read model at `now`. Every number is a row's own field; the colour is the D-2 verdict (rules.ts). */
export async function buildBoard(c: Queryable, outletId: string, now: Date, station?: string): Promise<Board> {
  const rows = (await c.query<{
    id: string; order_id: string; station: string; status: TicketStatus; accepted_at: Date | null; ready_at: Date | null; due_at: Date | null; created_at: Date;
    ticket_no: number; business_date: string; kind: string; table_ref: string | null; promised_at: Date | null; channel_kind: string; default_prep_min: number;
  }>(
    `SELECT t.id, t.order_id, t.station, t.status, t.accepted_at, t.ready_at, t.due_at, t.created_at,
            o.ticket_no, o.business_date::text AS business_date, o.kind, o.table_ref, o.promised_at, ch.kind AS channel_kind, ou.default_prep_min
       FROM core.kitchen_ticket t
       JOIN core."order" o ON o.tenant_id = t.tenant_id AND o.id = t.order_id
       JOIN core.channel ch ON ch.tenant_id = o.tenant_id AND ch.id = o.channel_id
       JOIN core.outlet ou ON ou.tenant_id = o.tenant_id AND ou.id = o.outlet_id
      WHERE t.outlet_id = $1 AND t.status <> 'done' AND o.status NOT IN ('rejected', 'cancelled', 'completed')`, [outletId])).rows;
  const stations = [...new Set(rows.map((r) => r.station))].sort();
  const kept = station ? rows.filter((r) => r.station === station) : rows;
  const orderIds = [...new Set(kept.map((r) => r.order_id))];
  const lineRows = orderIds.length
    ? (await c.query<{ order_id: string; line_no: number; item_id: string; name_key: string; qty_milli: string; options: Array<{ option_id: string; name_key: string }>; note: string | null; stations: string[] }>(
        `SELECT l.order_id, l.line_no, l.item_id, i.name_key, l.qty_milli::text AS qty_milli, l.note,
                coalesce((SELECT jsonb_agg(jsonb_build_object('option_id', op.id, 'name_key', op.name_key) ORDER BY x.n)
                            FROM jsonb_array_elements_text(l.options) WITH ORDINALITY AS x(id, n)
                            JOIN core.option op ON op.tenant_id = l.tenant_id AND op.id = x.id::uuid), '[]') AS options,
                coalesce((SELECT array_agg(p.station) FROM core.prep_time p
                           WHERE p.outlet_id = l.outlet_id AND p.item_id = l.item_id
                             AND p.valid_from <= o.business_date AND (p.valid_to IS NULL OR p.valid_to > o.business_date)), '{}') AS stations
           FROM core.order_line l
           JOIN core."order" o ON o.tenant_id = l.tenant_id AND o.id = l.order_id
           JOIN core.item i ON i.tenant_id = l.tenant_id AND i.id = l.item_id
          WHERE l.order_id = ANY ($1::uuid[]) ORDER BY l.order_id, l.line_no`, [orderIds])).rows
    : [];
  const tickets: BoardTicket[] = kept.map((r) => {
    const colour = ticketColour(now, r.due_at, r.status);
    const surface = r.promised_at ? new Date(r.promised_at.getTime() - r.default_prep_min * 60_000) : null;
    return {
      ticket_id: r.id, order_id: r.order_id, ticket_no: r.ticket_no, business_date: r.business_date, station: r.station, status: r.status,
      kind: r.kind, table_ref: r.table_ref, channel_kind: r.channel_kind, started_at: (r.accepted_at ?? r.created_at).toISOString(),
      accepted_at: iso(r.accepted_at), ready_at: iso(r.ready_at), due_at: iso(r.due_at), promised_at: iso(r.promised_at),
      lane: surface && surface.getTime() > now.getTime() ? "later" : "now", surface_at: iso(surface), colour,
      lines: lineRows
        .filter((l) => l.order_id === r.order_id && (l.stations.length ? l.stations.includes(r.station) : r.station === DEFAULT_STATION))
        .map((l) => ({ line_no: l.line_no, item_id: l.item_id, name_key: l.name_key, qty_milli: Number(l.qty_milli), options: l.options, note: l.note })),
    };
  });
  // Red first, then amber, then by due time, then ticket number.
  tickets.sort((a, b) => RANK[a.colour] - RANK[b.colour]
    || (a.due_at ?? "9").localeCompare(b.due_at ?? "9") || a.ticket_no - b.ticket_no);
  return { outlet_id: outletId, as_of: now.toISOString(), stations, tickets };
}
