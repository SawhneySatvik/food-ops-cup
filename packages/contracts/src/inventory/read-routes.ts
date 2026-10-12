// Inventory read responses and routes (T-092a; hand list rows 7-10). Rows only: on-hand totals and count variance are
// snapshot templates (R26). Quantities are milli-units of the row's own unit.
import { z } from "zod";
import { IsoDate, IsoDateTime, QtyMilli, Unit, Uuid7 } from "../shared/primitives.ts";
import type { QueryParam, Route } from "../shared/routes.ts";

const Page = <T extends z.ZodType>(item: T) => z.strictObject({ items: z.array(item), next_cursor: Uuid7.nullable() });
const uuid = { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" };
const date = { type: "string", format: "date" };
const param = (name: string, schema: Record<string, unknown>, required = false): QueryParam => ({ name, required, schema });
const cursor = param("cursor", uuid);
const limit = param("limit", { type: "integer", minimum: 1, maximum: 200 });
const read = (path: string, operationId: string, summary: string, response: string, extra: Partial<Route> = {}): Route =>
  ({ surface: "public", method: "get", path, operationId, summary, auth: "member", response, status: 200, ...extra });

const IngredientItem = z.strictObject({
  ingredient_id: Uuid7, name: z.string(), base_unit: Unit, shelf_life_days: z.int().min(1).nullable(), tracked_by_batch: z.boolean(), active: z.boolean(),
}).meta({ title: "IngredientItem" });

const WasteItem = z.strictObject({
  waste_id: Uuid7, outlet_id: Uuid7, ingredient_id: Uuid7, batch_id: Uuid7.nullable(), qty_milli: QtyMilli, unit: Unit,
  reason: z.enum(["temperature", "overprep", "expired", "damaged", "other"]),
  /** The recorder's free-text note: untrusted, rendered as text. */
  note: z.string().nullable(), recorded_by: Uuid7, at: IsoDateTime, business_date: IsoDate,
}).meta({ title: "WasteItem" });

const countLines = z.array(z.strictObject({
  count_line_id: Uuid7, ingredient_id: Uuid7, batch_id: Uuid7.nullable(), expected_qty_milli: QtyMilli, counted_qty_milli: QtyMilli, unit: Unit,
}));
const count = { stock_count_id: Uuid7, outlet_id: Uuid7, counted_by: Uuid7, counted_at: IsoDateTime, status: z.enum(["open", "submitted", "cancelled"]), lines: countLines };
const CountItem = z.strictObject(count).meta({ title: "StockCountItem" });

const TransferItem = z.strictObject({
  transfer_id: Uuid7, from_outlet_id: Uuid7, to_outlet_id: Uuid7, status: z.enum(["sent", "received", "cancelled"]), sent_by: Uuid7, sent_at: IsoDateTime,
  received_by: Uuid7.nullable(), received_at: IsoDateTime.nullable(),
  lines: z.array(z.strictObject({ transfer_line_id: Uuid7, ingredient_id: Uuid7, batch_id: Uuid7.nullable(), qty_milli: QtyMilli, unit: Unit })),
}).meta({ title: "TransferItem" });

export const READ_SCHEMAS = {
  "v1.inventory.ingredients": Page(IngredientItem),
  "v1.inventory.waste": Page(WasteItem),
  "v1.inventory.counts": Page(CountItem),
  "v1.inventory.count": z.strictObject(count),
  "v1.inventory.transfers": Page(TransferItem),
};

export const MOVEMENT_KIND_VALUES = ["receipt", "sale_consumption", "waste", "transfer_out", "transfer_in", "count_adjust", "supplier_return", "sale_return", "donation", "surplus_out", "surplus_in", "cares_reversal"] as const;

export const READ_ROUTES: readonly Route[] = [
  read("/v1/inventory/ingredients", "listIngredients", "Ingredients (tenant-wide); q matches the name; outlet is checked against the caller's scope", "v1.inventory.ingredients", { query: [param("outlet", uuid), param("q", { type: "string", maxLength: 100 }), limit, cursor] }),
  read("/v1/inventory/waste", "listWaste", "An outlet's waste log; business_date = the outlet's local day less its business-day cutoff", "v1.inventory.waste", { query: [param("outlet", uuid, true), param("business_date", date), limit, cursor] }),
  read("/v1/inventory/counts", "listStockCounts", "Stock counts with their lines (expected beside counted), newest first", "v1.inventory.counts", { query: [param("outlet", uuid), param("status", { type: "string", enum: ["open", "submitted", "cancelled"] }), limit, cursor] }),
  read("/v1/inventory/counts/{id}", "getStockCount", "One stock count with its lines", "v1.inventory.count", { pathParams: [{ name: "id", uuid: true }] }),
  read("/v1/inventory/transfers", "listTransfers", "Transfers visible from either end (outlet = from or to), with their lines", "v1.inventory.transfers", { query: [param("outlet", uuid), param("status", { type: "string", enum: ["sent", "received", "cancelled"] }), limit, cursor] }),
];
