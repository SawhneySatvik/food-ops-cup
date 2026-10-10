import { S1, T, T_PG, snapRef, u } from "./_ids.ts";

export const reorderSet = { outlet_id: u(2), ingredient_id: u(40), min_qty_milli: 5000, par_qty_milli: 20000 };
const transfer = { transfer_id: u(46), from_outlet_id: u(2), to_outlet_id: u(3), lines: [{ ingredient_id: u(40), batch_id: u(47), qty_milli: 40000, unit: "unit" }] };

export const SAMPLES: Record<string, unknown> = {
  "inventory.ingredient.upsert.v1": { ingredient_id: u(40), name: "Paneer", base_unit: "kg", shelf_life_days: 4, tracked_by_batch: true },
  "inventory.reorder_level.set.v1": reorderSet,
  "inventory.stock.receive.v1": {
    outlet_id: u(2), source: "opening", at: T,
    lines: [
      { movement_id: u(45), ingredient_id: u(40), batch_id: u(47), batch: { batch_code: "B-12", expires_on: "2026-10-14", mrp_minor: 9000 }, qty_milli: 8000, unit: "kg", unit_cost: { amount_minor: 32000, currency: "INR" } },
      { movement_id: u(48), ingredient_id: u(41), batch_id: null, batch: null, qty_milli: 25000, unit: "kg", unit_cost: { amount_minor: 9000, currency: "INR" } },
    ],
  },
  "inventory.waste.record.v1": { waste_id: u(49), outlet_id: u(2), ingredient_id: u(40), batch_id: u(47), qty_milli: 500, unit: "kg", reason: "expired", note: null },
  "inventory.count.submit.v1": { count_id: u(50), outlet_id: u(2), lines: [{ line_id: u(51), ingredient_id: u(40), batch_id: u(47), counted_qty_milli: 4500, unit: "kg" }] },
  "inventory.batch.update.v1": { batch_id: u(47), expires_on: "2026-10-15", mrp_minor: null },
  "inventory.transfer.create.v1": transfer,
  "inventory.transfer.receive.v1": { transfer_id: u(46) },
  "inventory.expired_sale.override.v1": { override_id: u(52), outlet_id: u(2), cart_line_id: u(53), batch_id: u(47), qty_milli: 1000, reason_code: "staff_meal", note: "Used the same day by staff" },
  "proposal.inventory.transfer.create.v1": { ...transfer, lines: [{ ...transfer.lines[0], qty_milli: snapRef(S1, 0, "at_risk_qty_milli") }] },
  "v1.inventory.movements": {
    movements: [{ movement_id: u(45), outlet_id: u(2), ingredient_id: u(40), batch_id: u(47), qty_milli: -1000, unit: "kg", kind: "sale_consumption",
      ref_type: "core.order", ref_id: u(60), unit_cost: null, expired_sale_override_id: null, at: T_PG }],
    next_cursor: null,
  },
  "v1.inventory.batches": { batches: [{ batch_id: u(47), outlet_id: u(2), ingredient_id: u(40), batch_code: "B-12", expires_on: "2026-10-14", received_at: T, mrp: { amount_minor: 9000, currency: "INR" } }] },
};
