import { T, u } from "./_ids.ts";

export const reorderSet = { outlet_id: u(2), ingredient_id: u(40), min_qty_milli: 5000, par_qty_milli: 20000 };

export const SAMPLES: Record<string, unknown> = {
  "inventory.ingredient.upsert.v1": { ingredient_id: u(40), name: "Paneer", base_unit: "kg", shelf_life_days: 4, tracked_by_batch: true },
  "inventory.reorder_level.set.v1": reorderSet,
  "inventory.stock.receive.v1": { outlet_id: u(2), source: "opening", at: T, lines: [{ movement_id: u(45), ingredient_id: u(40), batch_id: null, qty_milli: 8000, unit: "kg", unit_cost: { amount_minor: 32000, currency: "INR" } }] },
};
