// W1 domain events (03-architecture §1.6) as CloudEvents 1.0. Written to core.outbox in the command's
// transaction; published after commit. Data: ids and categorical fields only (shared/cloudevents.ts).
import { z } from "zod";
import { cloudEvent } from "../shared/cloudevents.ts";
import { IsoDateTime, Uuid7 } from "../shared/primitives.ts";
import type { Route } from "../shared/routes.ts";
import {
  CARES_EVENT_SCHEMAS, CaresClaimCreatedV1, CaresClaimDecidedV1, CaresHandoverRecordedV1, CaresHandoverVoidedV1, CaresListingClosedV1, CaresListingPublishedV1,
} from "../cares/events.ts";
import { KitchenTicketAdvancedV1, KitchenTicketCreatedV1 } from "../kitchen/events.ts";
import {
  ORDER_EVENT_SCHEMAS, OrderPromiseChangedV1, OrderStatusChangedV1, RefundRecordedV1, ShiftClosedV1, ShiftOpenedV1, TenderRecordedV1, VoidRecordedV1,
} from "../orders/events.ts";

export const OrderPlacedV1 = cloudEvent(
  "munim.orders.order.placed.v1",
  "orders",
  z.strictObject({
    order_id: Uuid7,
    outlet_id: Uuid7,
    channel_id: Uuid7,
    status: z.literal("placed"),
    placed_at: IsoDateTime,
  }),
);

/** The DB set (core.stock_movement.kind, 0005 widened by 0028 with the Cares kinds): returns are `supplier_return` / `sale_return` (W1 fix #42). */
export const MovementKind = z.enum(["receipt", "sale_consumption", "waste", "transfer_out", "transfer_in", "count_adjust", "supplier_return", "sale_return", "donation", "surplus_out", "surplus_in", "cares_reversal"]);

export const MovementRecordedV1 = cloudEvent(
  "munim.inventory.movement.recorded.v1",
  "inventory",
  z.strictObject({
    outlet_id: Uuid7,
    /** One event per movement batch (02-schema §2.5). */
    movement_ids: z.array(Uuid7).min(1),
    ingredient_ids: z.array(Uuid7).min(1),
    kind: MovementKind,
    /** The DB form `core.<table>` (core.stock_movement.ref_type check), e.g. "core.order" (W1 fix #38). */
    ref_type: z.string().regex(/^core\.[a-z_]+$/),
    ref_id: Uuid7,
  }),
);

export const PoCommittedV1 = cloudEvent(
  "munim.purchasing.po.committed.v1",
  "purchasing",
  z.strictObject({
    po_id: Uuid7,
    supplier_id: Uuid7,
    outlet_ids: z.array(Uuid7).min(1),
    /** The approval that committed it; null when a member created the PO directly (own command, R27). */
    decision_id: Uuid7.nullable(),
    draft_id: Uuid7.nullable(),
  }),
);

/** Every domain event, discriminated on `type` (what intel `/events` accepts). The Munim Cares events (ADR-015 §5) are
 *  registered here, not in the cares module, because core-api's outbox parses each stored row against this registry. */
export const MunimEvent = z.discriminatedUnion("type", [
  OrderPlacedV1, MovementRecordedV1, PoCommittedV1, KitchenTicketCreatedV1, KitchenTicketAdvancedV1,
  OrderStatusChangedV1, OrderPromiseChangedV1, TenderRecordedV1, VoidRecordedV1, RefundRecordedV1, ShiftOpenedV1, ShiftClosedV1,
  CaresListingPublishedV1, CaresListingClosedV1, CaresHandoverRecordedV1, CaresHandoverVoidedV1, CaresClaimCreatedV1, CaresClaimDecidedV1,
]);
export type MunimEvent = z.infer<typeof MunimEvent>;

export const SCHEMAS = {
  "munim.orders.order.placed.v1": OrderPlacedV1,
  "munim.inventory.movement.recorded.v1": MovementRecordedV1,
  "munim.purchasing.po.committed.v1": PoCommittedV1,
  "munim.kitchen.ticket.created.v1": KitchenTicketCreatedV1,
  "munim.kitchen.ticket.advanced.v1": KitchenTicketAdvancedV1,
  ...ORDER_EVENT_SCHEMAS,
  ...CARES_EVENT_SCHEMAS,
  "munim-event": MunimEvent,
};
export const ROUTES: readonly Route[] = [];
