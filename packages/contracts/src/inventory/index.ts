// Inventory setup commands (02-schema §2.5). Movements are append-only; on-hand = Σ qty_milli.
import { z } from "zod";
import { IsoDateTime, Money, NonEmpty, QtyMilli, Unit, Uuid7 } from "../shared/primitives.ts";
import { defineDraftable } from "../shared/draftables.ts";
import type { Route } from "../shared/routes.ts";

export const InventoryIngredientUpsertV1 = z.strictObject({
  ingredient_id: Uuid7,
  name: NonEmpty,
  base_unit: Unit,
  shelf_life_days: z.int().positive().nullable(),
  tracked_by_batch: z.boolean(),
});

export const InventoryReorderLevelSetV1 = z.strictObject({
  outlet_id: Uuid7,
  ingredient_id: Uuid7,
  min_qty_milli: QtyMilli.nonnegative(),
  par_qty_milli: QtyMilli.nonnegative(),
});

/** W1: opening stock (receipt movements with no purchase order). Goods received against a PO is
 *  T-025's GRN command. */
export const InventoryStockReceiveV1 = z.strictObject({
  outlet_id: Uuid7,
  source: z.literal("opening"),
  at: IsoDateTime,
  lines: z
    .array(
      z.strictObject({
        movement_id: Uuid7,
        ingredient_id: Uuid7,
        batch_id: Uuid7.nullable(),
        qty_milli: QtyMilli.positive(),
        unit: Unit,
        unit_cost: Money,
      }),
    )
    .min(1),
});

/** Intel may propose new reorder levels as a draft (inventory & purchasing pack). */
export const REORDER_LEVEL_SET_DRAFT = defineDraftable("inventory.reorder_level.set.v1", InventoryReorderLevelSetV1);

export const SCHEMAS = {
  "inventory.ingredient.upsert.v1": InventoryIngredientUpsertV1,
  "inventory.reorder_level.set.v1": InventoryReorderLevelSetV1,
  "inventory.stock.receive.v1": InventoryStockReceiveV1,
  "proposal.inventory.reorder_level.set.v1": REORDER_LEVEL_SET_DRAFT.proposal,
};
export const ROUTES: readonly Route[] = [];
