// Inventory commands and reads (02-schema §2.5, T-024). Movements are append-only; on-hand = Σ qty_milli in the
// ingredient's base unit. Every quantity a person types is in that base unit (core refuses `unit_mismatch`).
import { z } from "zod";
import { IsoDate, IsoDateTime, MinorAmount, Money, NonEmpty, QtyMilli, Slug, Unit, Uuid7 } from "../shared/primitives.ts";
import { defineDraftable } from "../shared/draftables.ts";
import type { Route } from "../shared/routes.ts";
import { MOVEMENT_KIND_VALUES, READ_ROUTES, READ_SCHEMAS } from "./read-routes.ts";

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

/** A new batch received with the line: its printed code, expiry and MRP (store pack). */
export const BatchSpec = z.strictObject({
  batch_code: z.string().min(1).max(64),
  expires_on: IsoDate.nullable(),
  /** Printed MRP per base unit, tenant currency. */
  mrp_minor: MinorAmount.positive().nullable(),
});

/** Opening stock (receipt movements with no purchase order). Goods received against a PO is T-025's GRN
 *  command. `batch_id` + `batch` creates that batch; `batch_id` alone adds to an existing batch of the outlet;
 *  neither is unbatched stock (only for an ingredient not tracked by batch). */
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
        batch: BatchSpec.nullable(),
        qty_milli: QtyMilli.positive(),
        unit: Unit,
        unit_cost: Money,
      }),
    )
    .min(1),
});

/** Waste reasons: the DB set (core.waste_log.reason). `other` needs a note. */
export const WasteReason = z.enum(["temperature", "overprep", "expired", "damaged", "other"]);

export const InventoryWasteRecordV1 = z.strictObject({
  waste_id: Uuid7,
  outlet_id: Uuid7,
  ingredient_id: Uuid7,
  batch_id: Uuid7.nullable(),
  qty_milli: QtyMilli.positive(),
  unit: Unit,
  reason: WasteReason,
  note: z.string().min(1).max(500).nullable(),
});

/** A blind count: the counted quantity only; core computes expected on-hand and the count_adjust movements. */
export const InventoryCountSubmitV1 = z.strictObject({
  count_id: Uuid7,
  outlet_id: Uuid7,
  lines: z
    .array(
      z.strictObject({
        line_id: Uuid7,
        ingredient_id: Uuid7,
        /** Per-batch lines for batch-tracked stock; null counts the unbatched stock. */
        batch_id: Uuid7.nullable(),
        counted_qty_milli: QtyMilli.nonnegative(),
        unit: Unit,
      }),
    )
    .min(1),
});

/** Correct a batch's printed expiry or MRP. */
export const InventoryBatchUpdateV1 = z.strictObject({
  batch_id: Uuid7,
  expires_on: IsoDate.nullable(),
  mrp_minor: MinorAmount.positive().nullable(),
});

export const InventoryTransferCreateV1 = z.strictObject({
  transfer_id: Uuid7,
  from_outlet_id: Uuid7,
  to_outlet_id: Uuid7,
  lines: z
    .array(
      z.strictObject({
        ingredient_id: Uuid7,
        batch_id: Uuid7.nullable(),
        qty_milli: QtyMilli.positive(),
        unit: Unit,
      }),
    )
    .min(1),
});

export const InventoryTransferReceiveV1 = z.strictObject({ transfer_id: Uuid7 });

/** R40 C7: a manager or owner, as themselves, lets one cart line draw up to `qty_milli` from one expired batch.
 *  Exists only where the country pack's `expired_sale_override` is true. Single use, consumed at placement. */
export const InventoryExpiredSaleOverrideV1 = z.strictObject({
  override_id: Uuid7,
  outlet_id: Uuid7,
  /** The order line id the client will place. */
  cart_line_id: Uuid7,
  batch_id: Uuid7,
  qty_milli: QtyMilli.positive(),
  reason_code: Slug,
  note: z.string().min(1).max(500),
});

/** Intel may propose new reorder levels and transfers as drafts (inventory & purchasing pack §6). */
export const REORDER_LEVEL_SET_DRAFT = defineDraftable("inventory.reorder_level.set.v1", InventoryReorderLevelSetV1);
export const TRANSFER_CREATE_DRAFT = defineDraftable("inventory.transfer.create.v1", InventoryTransferCreateV1);

/** Stock movement rows (each number is the row's own field). On-hand totals are snapshot cells, never here. */
export const MovementKind = z.enum(["receipt", "sale_consumption", "waste", "transfer_out", "transfer_in", "count_adjust", "supplier_return", "sale_return", "donation", "surplus_out", "surplus_in", "cares_reversal"]);
export const InventoryMovementsResponse = z.strictObject({
  movements: z.array(
    z.strictObject({
      movement_id: Uuid7,
      outlet_id: Uuid7,
      ingredient_id: Uuid7,
      batch_id: Uuid7.nullable(),
      qty_milli: QtyMilli,
      unit: Unit,
      kind: MovementKind,
      ref_type: z.string().regex(/^core\.[a-z_]+$/).nullable(),
      ref_id: Uuid7.nullable(),
      /** Per one base unit, rounded (kept for existing readers). */
      unit_cost: Money.nullable(),
      /** The cost of 1000 base units — exact for a price per kg / l / 1000 units; value = qty_milli × this ÷ 1,000,000. */
      unit_cost_per_1000: Money.nullable(),
      expired_sale_override_id: Uuid7.nullable(),
      at: IsoDateTime,
    }),
  ),
  /** Pass as `cursor` for the next (older) page; null on the last page. */
  next_cursor: Uuid7.nullable(),
});

export const InventoryBatchesResponse = z.strictObject({
  batches: z.array(
    z.strictObject({
      batch_id: Uuid7,
      outlet_id: Uuid7,
      ingredient_id: Uuid7,
      batch_code: z.string().min(1),
      expires_on: IsoDate.nullable(),
      received_at: IsoDateTime,
      mrp: Money.nullable(),
    }),
  ),
});

export const InventoryReorderLevelsResponse = z.strictObject({
  reorder_levels: z.array(
    z.strictObject({
      reorder_level_id: Uuid7,
      outlet_id: Uuid7,
      ingredient_id: Uuid7,
      min_qty_milli: QtyMilli.nonnegative(),
      par_qty_milli: QtyMilli.nonnegative(),
      updated_at: IsoDateTime,
    }),
  ),
});

export const SCHEMAS = {
  ...READ_SCHEMAS,
  "inventory.ingredient.upsert.v1": InventoryIngredientUpsertV1,
  "inventory.reorder_level.set.v1": InventoryReorderLevelSetV1,
  "inventory.stock.receive.v1": InventoryStockReceiveV1,
  "inventory.waste.record.v1": InventoryWasteRecordV1,
  "inventory.count.submit.v1": InventoryCountSubmitV1,
  "inventory.batch.update.v1": InventoryBatchUpdateV1,
  "inventory.transfer.create.v1": InventoryTransferCreateV1,
  "inventory.transfer.receive.v1": InventoryTransferReceiveV1,
  "inventory.expired_sale.override.v1": InventoryExpiredSaleOverrideV1,
  "proposal.inventory.reorder_level.set.v1": REORDER_LEVEL_SET_DRAFT.proposal,
  "proposal.inventory.transfer.create.v1": TRANSFER_CREATE_DRAFT.proposal,
  "v1.inventory.movements": InventoryMovementsResponse,
  "v1.inventory.batches": InventoryBatchesResponse,
  "v1.inventory.reorder-levels": InventoryReorderLevelsResponse,
};

const uuid = { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$" };
const command = (path: string, operationId: string, type: string, summary: string): Route => ({
  surface: "public", method: "post", path, operationId, summary: `${type} — ${summary}`, auth: "member", command: type,
  response: "command-result", status: 200, conflict: true,
});

export const ROUTES: readonly Route[] = [
  ...READ_ROUTES,
  command("/v1/inventory/ingredients", "upsertIngredient", "inventory.ingredient.upsert.v1", "create or edit an ingredient / stock record"),
  command("/v1/inventory/stock:receive", "receiveOpeningStock", "inventory.stock.receive.v1", "opening stock, optionally into new dated batches"),
  command("/v1/inventory/waste", "recordWaste", "inventory.waste.record.v1", "log waste; core derives the waste movement"),
  command("/v1/inventory/counts", "submitStockCount", "inventory.count.submit.v1", "a blind count; core derives count_adjust movements"),
  command("/v1/inventory/reorder-levels", "setReorderLevel", "inventory.reorder_level.set.v1", "min / par for one ingredient at one outlet (draftable)"),
  command("/v1/inventory/batches:update", "updateBatch", "inventory.batch.update.v1", "correct a batch's expiry or MRP"),
  command("/v1/inventory/transfers", "createTransfer", "inventory.transfer.create.v1", "send stock to another outlet (draftable); both ends in scope"),
  {
    ...command("/v1/inventory/transfers/{id}:receive", "receiveTransfer", "inventory.transfer.receive.v1", "the receiving outlet books the stock in"),
    pathParams: [{ name: "id", uuid: true }],
  },
  command("/v1/inventory/expired-sale-overrides", "issueExpiredSaleOverride", "inventory.expired_sale.override.v1",
    "a manager or owner lets one cart line sell from one expired batch, where the country pack allows it"),
  {
    surface: "public", method: "get", path: "/v1/inventory/movements", operationId: "listStockMovements",
    summary: "Stock movement rows for an outlet, newest first; kind and ref (the source row id) filter (T-092a)", auth: "member", response: "v1.inventory.movements", status: 200,
    query: [
      { name: "outlet", required: true, schema: uuid },
      { name: "ingredient", required: false, schema: uuid },
      { name: "kind", required: false, schema: { type: "string", enum: [...MOVEMENT_KIND_VALUES] } },
      { name: "ref", required: false, schema: uuid },
      { name: "limit", required: false, schema: { type: "integer", minimum: 1, maximum: 500 } },
      { name: "cursor", required: false, schema: uuid },
    ],
  },
  {
    surface: "public", method: "get", path: "/v1/inventory/batches", operationId: "listBatches",
    summary: "Batches at an outlet with expiry and MRP, earliest expiry first", auth: "member", response: "v1.inventory.batches", status: 200,
    query: [
      { name: "outlet", required: true, schema: uuid },
      { name: "ingredient", required: false, schema: uuid },
    ],
  },
  {
    surface: "public", method: "get", path: "/v1/inventory/reorder-levels", operationId: "listReorderLevels",
    summary: "Min / par levels at an outlet", auth: "member", response: "v1.inventory.reorder-levels", status: 200,
    query: [
      { name: "outlet", required: true, schema: uuid },
      { name: "ingredient", required: false, schema: uuid },
    ],
  },
];
