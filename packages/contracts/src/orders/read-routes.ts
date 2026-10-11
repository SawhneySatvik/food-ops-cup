// Orders read responses and routes (T-092a/b; hand list rows 1, 2, 21). Row fields only (R26). Pages are
// `{ items, next_cursor }`: the cursor is the last item's id (a uuid), null on the last page.
import { z } from "zod";
import { CurrencyCode, IsoDate, IsoDateTime, MinorAmount, Uuid7 } from "../shared/primitives.ts";
import type { QueryParam, Route } from "../shared/routes.ts";

const OrderStatusValue = z.enum(["placed", "accepted", "rejected", "preparing", "ready", "completed", "cancelled"]);
const Page = <T extends z.ZodType>(item: T) => z.strictObject({ items: z.array(item), next_cursor: Uuid7.nullable() });

const OrderListItem = z.strictObject({
  order_id: Uuid7, outlet_id: Uuid7, channel_id: Uuid7, device_id: Uuid7.nullable(),
  kind: z.enum(["dine_in", "takeaway", "pickup", "delivery"]), table_ref: z.string().nullable(), status: OrderStatusValue,
  business_date: IsoDate, ticket_no: z.int(),
  subtotal_minor: MinorAmount, discount_minor: MinorAmount, tax_minor: MinorAmount, total_minor: MinorAmount, currency: CurrencyCode,
  promised_at: IsoDateTime.nullable(), created_at: IsoDateTime,
}).meta({ title: "OrderListItem" });

const ShiftListItem = z.strictObject({
  shift_id: Uuid7, outlet_id: Uuid7, device_id: Uuid7.nullable(), status: z.enum(["open", "closed"]), opened_by: Uuid7, opened_at: IsoDateTime,
  float_minor: MinorAmount, currency: CurrencyCode, closed_by: Uuid7.nullable(), closed_at: IsoDateTime.nullable(),
  counted_cash_minor: MinorAmount.nullable(), expected_cash_minor: MinorAmount.nullable(), variance_minor: z.int().nullable(),
}).meta({ title: "ShiftListItem" });

const PickupWindowItem = z.strictObject({
  pickup_window_id: Uuid7, outlet_id: Uuid7, starts_at: IsoDateTime, ends_at: IsoDateTime, capacity_orders: z.int().min(1), booked: z.int().min(0),
}).meta({ title: "PickupWindowItem" });

export const READ_SCHEMAS = {
  "v1.orders.list": Page(OrderListItem),
  "v1.shifts.list": Page(ShiftListItem),
  "v1.pickup-windows.list": Page(PickupWindowItem),
};

const uuid = { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" };
const date = { type: "string", format: "date" };
const param = (name: string, schema: Record<string, unknown>, required = false): QueryParam => ({ name, required, schema });
const cursor = param("cursor", uuid);
const limit = param("limit", { type: "integer", minimum: 1, maximum: 200 });

export const READ_ROUTES: readonly Route[] = [
  { surface: "public", method: "get", path: "/v1/orders", operationId: "listOrders", summary: "Orders in the caller's outlet scope, newest first; a shift's orders are those it took a tender for", auth: "member", response: "v1.orders.list", status: 200,
    query: [param("outlet", uuid), param("status", { type: "string", enum: OrderStatusValue.options }), param("table_ref", { type: "string", maxLength: 20 }), param("shift", uuid), param("business_date", date), limit, cursor] },
  { surface: "public", method: "get", path: "/v1/shifts", operationId: "listShifts", summary: "Drawer shifts in the caller's outlet scope, newest first (from / to = the outlet's business day of the opening, local time less its business-day cutoff)", auth: "member", response: "v1.shifts.list", status: 200,
    query: [param("outlet", uuid), param("device", uuid), param("status", { type: "string", enum: ["open", "closed"] }), param("from", date), param("to", date), limit, cursor] },
  { surface: "public", method: "get", path: "/v1/pickup-windows", operationId: "listPickupWindows", summary: "An outlet's pickup slots for a local calendar day, in time order, with capacity and booked", auth: "member", response: "v1.pickup-windows.list", status: 200,
    query: [param("outlet", uuid, true), param("date", date, true), limit, cursor] },
];
