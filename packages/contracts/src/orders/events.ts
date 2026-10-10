// Order events (03-architecture §1.6; W1 fix #80): every core.order_event row is paired with one of these
// outbox events in the same transaction, so shopper feeds (`order:<id>`) and the kitchen stream wake on
// `munim_outbox`. Data: ids and categorical fields only — never amounts, reasons or free text.
// Each carries data.outlet_id (stream `kds:` topics and the narrowest run scope, ruling #18).
// Registered in `@munim/contracts/events` SCHEMAS (the outbox type map) and the MunimEvent union (W2 B1).
import { z } from "zod";
import { cloudEvent } from "../shared/cloudevents.ts";
import { Slug, Uuid7 } from "../shared/primitives.ts";

const Status = z.enum(["placed", "accepted", "rejected", "preparing", "ready", "completed", "cancelled"]);
const Method = z.enum(["cash", "card", "upi"]);

export const OrderStatusChangedV1 = cloudEvent(
  "munim.orders.order.status_changed.v1",
  "orders",
  z.strictObject({ order_id: Uuid7, outlet_id: Uuid7, from_status: Status, to_status: Status }),
);

export const OrderPromiseChangedV1 = cloudEvent(
  "munim.orders.order.promise_changed.v1",
  "orders",
  z.strictObject({ order_id: Uuid7, outlet_id: Uuid7, reason_code: Slug }),
);

export const TenderRecordedV1 = cloudEvent(
  "munim.orders.tender.recorded.v1",
  "orders",
  z.strictObject({ tender_id: Uuid7, order_id: Uuid7, outlet_id: Uuid7, method: Method }),
);

export const VoidRecordedV1 = cloudEvent(
  "munim.orders.void.recorded.v1",
  "orders",
  z.strictObject({ void_id: Uuid7, order_id: Uuid7, outlet_id: Uuid7, reason_code: Slug }),
);

export const RefundRecordedV1 = cloudEvent(
  "munim.orders.refund.recorded.v1",
  "orders",
  z.strictObject({ refund_id: Uuid7, order_id: Uuid7, outlet_id: Uuid7, method: Method, reason_code: Slug }),
);

export const ShiftOpenedV1 = cloudEvent(
  "munim.orders.shift.opened.v1",
  "orders",
  z.strictObject({ shift_id: Uuid7, outlet_id: Uuid7, device_id: Uuid7.nullable() }),
);

export const ShiftClosedV1 = cloudEvent(
  "munim.orders.shift.closed.v1",
  "orders",
  z.strictObject({ shift_id: Uuid7, outlet_id: Uuid7, device_id: Uuid7.nullable() }),
);

/** type → schema, for `@munim/contracts/events` to spread into its SCHEMAS (and MunimEvent union). */
export const ORDER_EVENT_SCHEMAS = {
  "munim.orders.order.status_changed.v1": OrderStatusChangedV1,
  "munim.orders.order.promise_changed.v1": OrderPromiseChangedV1,
  "munim.orders.tender.recorded.v1": TenderRecordedV1,
  "munim.orders.void.recorded.v1": VoidRecordedV1,
  "munim.orders.refund.recorded.v1": RefundRecordedV1,
  "munim.orders.shift.opened.v1": ShiftOpenedV1,
  "munim.orders.shift.closed.v1": ShiftClosedV1,
} as const;
