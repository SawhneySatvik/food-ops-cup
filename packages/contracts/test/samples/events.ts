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
  "munim-event": { ...orderPlaced, time: T_PG },
};
