import { JWT, T, T_PG, T_Z, u } from "./_ids.ts";

export const orderPlaced = {
  specversion: "1.0",
  id: u(110),
  source: `/tenants/${u(1)}/orders`,
  type: "munim.orders.order.placed.v1",
  subject: u(10),
  time: T,
  datacontenttype: "application/json",
  tenantid: u(1),
  munimrun: JWT,
  data: { order_id: u(10), outlet_id: u(2), channel_id: u(4), status: "placed", placed_at: T_PG },
};

export const SAMPLES: Record<string, unknown> = {
  "munim.orders.order.placed.v1": orderPlaced,
  "munim.inventory.movement.recorded.v1": { ...orderPlaced, id: u(111), source: `/tenants/${u(1)}/inventory`, type: "munim.inventory.movement.recorded.v1", subject: u(46), data: { outlet_id: u(2), movement_ids: [u(46), u(47)], ingredient_ids: [u(40)], kind: "sale_consumption", ref_type: "core.order", ref_id: u(10) } },
  "munim.purchasing.po.committed.v1": { ...orderPlaced, id: u(112), source: `/tenants/${u(1)}/purchasing`, type: "munim.purchasing.po.committed.v1", subject: u(60), time: T_Z, data: { po_id: u(60), supplier_id: u(50), outlet_ids: [u(2)], decision_id: u(91), draft_id: u(90) } },
  "munim.orders.order.status_changed.v1": { ...orderPlaced, id: u(113), type: "munim.orders.order.status_changed.v1", data: { order_id: u(10), outlet_id: u(2), from_status: "ready", to_status: "completed" } },
  "munim.orders.order.promise_changed.v1": { ...orderPlaced, id: u(114), type: "munim.orders.order.promise_changed.v1", data: { order_id: u(10), outlet_id: u(2), reason_code: "kitchen_backlog" } },
  "munim.orders.tender.recorded.v1": { ...orderPlaced, id: u(115), type: "munim.orders.tender.recorded.v1", subject: u(15), data: { tender_id: u(15), order_id: u(10), outlet_id: u(2), method: "upi" } },
  "munim.orders.void.recorded.v1": { ...orderPlaced, id: u(116), type: "munim.orders.void.recorded.v1", subject: u(16), data: { void_id: u(16), order_id: u(10), outlet_id: u(2), reason_code: "wrong_item" } },
  "munim.orders.refund.recorded.v1": { ...orderPlaced, id: u(117), type: "munim.orders.refund.recorded.v1", subject: u(17), data: { refund_id: u(17), order_id: u(10), outlet_id: u(2), method: "cash", reason_code: "cold_food" } },
  "munim.orders.shift.opened.v1": { ...orderPlaced, id: u(118), type: "munim.orders.shift.opened.v1", subject: u(18), data: { shift_id: u(18), outlet_id: u(2), device_id: u(6) } },
  "munim.orders.shift.closed.v1": { ...orderPlaced, id: u(119), type: "munim.orders.shift.closed.v1", subject: u(18), data: { shift_id: u(18), outlet_id: u(2), device_id: null } },
  "munim-event": { ...orderPlaced, time: T_PG },
};
