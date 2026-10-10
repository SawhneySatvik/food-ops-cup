// Kitchen contracts (02-schema §2.4 kitchen_ticket, prep_time, prep_list — T-023). Tickets and prep times are
// operational; a prep list is a book (member's own command, or an approved draft — R16, nothing auto-applies).
import { z } from "zod";
import { defineDraftable } from "../shared/draftables.ts";
import { IsoDate, IsoDateTime, NonEmpty, QtyMilli, Unit, Uuid7 } from "../shared/primitives.ts";
import { ReasonCode } from "../shared/reason-codes.ts";
import type { Route } from "../shared/routes.ts";
import { KitchenTicketStatus, Station } from "./events.ts";

export { KitchenTicketStatus, Station };

export const KitchenTicketAdvanceV1 = z.strictObject({
  ticket_id: Uuid7,
  /** Optimistic guard: the update applies only `WHERE status = from_status`; illegal moves → 409. */
  from_status: KitchenTicketStatus,
  to_status: KitchenTicketStatus,
});

/** Expected prep seconds per item and station (core.prep_time, operational; versioned by validity). Intel may
 *  propose it from observed p80 (kitchen pack §6). */
export const KitchenPrepTimeSetV1 = z.strictObject({
  outlet_id: Uuid7,
  item_id: Uuid7,
  station: Station,
  prep_sec: z.int().min(1).max(86400),
  valid_from: IsoDate,
});

/** A prep list for one outlet and business day (core.prep_list + prep_list_line). Quantities are the
 *  `kitchen.prep_need.prep_qty_milli` snapshot cells when intel proposes it. */
export const KitchenPrepListCreateV1 = z.strictObject({
  prep_list_id: Uuid7,
  outlet_id: Uuid7,
  business_date: IsoDate,
  lines: z
    .array(
      z.strictObject({
        ingredient_id: Uuid7,
        qty_milli: QtyMilli.positive(),
        unit: Unit,
      }),
    )
    .min(1)
    .max(200),
});

export const PREP_TIME_SET_DRAFT = defineDraftable("kitchen.prep_time.set.v1", KitchenPrepTimeSetV1);
export const PREP_LIST_CREATE_DRAFT = defineDraftable("kitchen.prep_list.create.v1", KitchenPrepListCreateV1);

// ── KDS read model (screens/kds.md K1). Every number is a row's own field; the colour is core's verdict at
// `as_of` against D-2's thresholds (amber from due_at − 3 min, red at/after due_at). Counts on screen are list
// lengths.
export const TicketColour = z.enum(["normal", "amber", "red"]);

export const KdsTicket = z.strictObject({
  ticket_id: Uuid7,
  order_id: Uuid7,
  /** core.order.ticket_no — daily per outlet, rolls at the outlet's business-day cutoff. */
  ticket_no: z.int().min(1),
  business_date: IsoDate,
  station: Station,
  status: KitchenTicketStatus,
  kind: z.enum(["dine_in", "takeaway", "pickup", "delivery"]),
  table_ref: z.string().nullable(),
  channel_kind: z.string(),
  /** Timer origin: accepted_at once preparing, else the ticket's created_at. */
  started_at: IsoDateTime,
  accepted_at: IsoDateTime.nullable(),
  ready_at: IsoDateTime.nullable(),
  due_at: IsoDateTime.nullable(),
  promised_at: IsoDateTime.nullable(),
  /** `later` = a scheduled order not yet due on the board (surfaces at surface_at). */
  lane: z.enum(["now", "later"]),
  surface_at: IsoDateTime.nullable(),
  colour: TicketColour,
  lines: z.array(
    z.strictObject({
      line_no: z.int().min(1),
      item_id: Uuid7,
      name_key: NonEmpty,
      qty_milli: QtyMilli,
      /** The chosen options, in the order taken, with their names for the station. */
      options: z.array(z.strictObject({ option_id: Uuid7, name_key: NonEmpty })),
      note: z.string().nullable(),
    }),
  ),
});

export const KdsBoardResponse = z.strictObject({
  outlet_id: Uuid7,
  as_of: IsoDateTime,
  stations: z.array(Station),
  tickets: z.array(KdsTicket),
});

export const PrepListState = z.enum(["approved", "waiting", "none", "cannot_verify"]);

/** K3: whether today's prep list exists. No quantities unless approved (a row's own fields). */
export const PrepListResponse = z.strictObject({
  outlet_id: Uuid7,
  business_date: IsoDate,
  state: PrepListState,
  /** `forecast_stale` when state = cannot_verify. */
  reason_code: ReasonCode.nullable(),
  prep_list: z
    .strictObject({
      prep_list_id: Uuid7,
      status: z.enum(["open", "done", "cancelled"]),
      draft_id: Uuid7.nullable(),
      lines: z.array(z.strictObject({ ingredient_id: Uuid7.nullable(), item_id: Uuid7.nullable(), qty_milli: QtyMilli, unit: Unit })),
    })
    .nullable(),
});

export const SCHEMAS = {
  "kitchen.ticket.advance.v1": KitchenTicketAdvanceV1,
  "kitchen.prep_time.set.v1": KitchenPrepTimeSetV1,
  "kitchen.prep_list.create.v1": KitchenPrepListCreateV1,
  "proposal.kitchen.prep_time.set.v1": PREP_TIME_SET_DRAFT.proposal,
  "proposal.kitchen.prep_list.create.v1": PREP_LIST_CREATE_DRAFT.proposal,
  "v1.kds.board": KdsBoardResponse,
  "v1.kitchen.prep_list": PrepListResponse,
};

const uuid = { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" };
export const ROUTES: readonly Route[] = [
  {
    surface: "public", method: "get", path: "/v1/kitchen/board", operationId: "getKdsBoard",
    summary: "Live tickets for an outlet (optionally one station) with elapsed/due and amber/red colour; restaurants and cloud kitchens only",
    auth: "member", response: "v1.kds.board", status: 200,
    query: [
      { name: "outlet", required: true, schema: uuid },
      { name: "station", required: false, schema: { type: "string", pattern: "^[a-z][a-z0-9_]*$" } },
    ],
  },
  {
    surface: "public", method: "post", path: "/v1/kitchen/tickets/{id}:advance", operationId: "advanceKitchenTicket",
    summary: "kitchen.ticket.advance.v1 — queued → preparing → ready → done; a stale from_status or an illegal move is 409",
    auth: "member", command: "kitchen.ticket.advance.v1", response: "command-result", status: 200, conflict: true,
    pathParams: [{ name: "id", uuid: true }],
  },
  {
    surface: "public", method: "post", path: "/v1/kitchen/prep-times", operationId: "setPrepTime",
    summary: "kitchen.prep_time.set.v1 — a manager's own expected prep time (closes the previous one)",
    auth: "member", command: "kitchen.prep_time.set.v1", response: "command-result", status: 200, conflict: true,
  },
  {
    surface: "public", method: "post", path: "/v1/kitchen/prep-lists", operationId: "createPrepList",
    summary: "kitchen.prep_list.create.v1 — a manager's own prep list (intel's proposals arrive as drafts and wait for approval)",
    auth: "member", command: "kitchen.prep_list.create.v1", response: "command-result", status: 200, conflict: true,
  },
  {
    surface: "public", method: "get", path: "/v1/kitchen/prep-list", operationId: "getPrepList",
    summary: "Whether the outlet's prep list for a business date is approved, waiting for approval, absent, or cannot be verified",
    auth: "member", response: "v1.kitchen.prep_list", status: 200,
    query: [
      { name: "outlet", required: true, schema: uuid },
      { name: "business_date", required: true, schema: { type: "string", format: "date" } },
    ],
  },
];
