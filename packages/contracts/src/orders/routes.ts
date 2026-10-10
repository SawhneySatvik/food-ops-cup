// Orders / POS routes (T-022; BOARD D-2 rider: routes named here). Member auth throughout; storefront placement
// and tracking are T-032's routes over the placeOrder / previewOrder seams.
// Order status changes (accept/reject/preparing/ready/completed/cancel) have no orders.* command seeded yet
// (0014 #41 keeps order-level moves on kitchen.ticket.advance.v1); their route is added when the command is.
import type { Route } from "../shared/routes.ts";

const id = [{ name: "id", uuid: true }];
const command = (path: string, operationId: string, type: string, summary: string, extra: Partial<Route> = {}): Route =>
  ({ surface: "public", method: "post", path, operationId, summary, auth: "member", command: type, response: "command-result", status: 200, conflict: true, ...extra });

export const ROUTES: readonly Route[] = [
  {
    surface: "public",
    method: "post",
    path: "/v1/orders:preview",
    operationId: "previewOrder",
    summary: "Price a cart with core's pricing function; writes nothing; labelled Preview (R40 C1)",
    auth: "member",
    request: "orders.preview.request",
    response: "orders.preview.response",
    status: 200,
  },
  command("/v1/orders", "placeOrder", "orders.place.v1", "orders.place.v1 — core re-prices; client totals are ignored; a preview total that no longer holds is refused (preview_total_changed)", { status: 201 }),
  { surface: "public", method: "get", path: "/v1/orders/{id}", operationId: "getOrder", summary: "One order with its lines and tenders; paid and remaining computed by core in the same read", auth: "member", response: "v1.order", status: 200, pathParams: id },
  { surface: "public", method: "get", path: "/v1/orders/{id}/receipt", operationId: "getOrderReceipt", summary: "The bill per the country pack (tax invoice, or a Sec 9(5) record-only receipt)", auth: "member", response: "v1.order.receipt", status: 200, pathParams: id, conflict: true },
  command("/v1/orders/{id}:push-back", "pushBackOrder", "orders.promise.push_back.v1", "Move the promised time later with a reason code; deals are re-judged at the new time", { pathParams: id }),
  command("/v1/orders/{id}/tenders", "recordTender", "orders.tender.record.v1", "Record a cash / card / UPI payment (recorded only — Munim does not process payments)", { pathParams: id }),
  command("/v1/orders/{id}/voids", "recordVoid", "orders.void.record.v1", "Void a line or the whole order with a reason", { pathParams: id }),
  command("/v1/orders/{id}/refunds", "recordRefund", "orders.refund.record.v1", "Record a refund with a reason, within what was paid and the member's authority", { pathParams: id }),
  command("/v1/pickup-windows", "generatePickupWindows", "orders.pickup_window.generate.v1", "Create pickup slots for a business date (outlet-local times, DST-safe); existing slots are kept"),
  command("/v1/shifts", "openShift", "orders.shift.open.v1", "Open a drawer shift with its float"),
  command("/v1/shifts/{id}:close", "closeShift", "orders.shift.close.v1", "Close a shift with the counted cash; core computes expected cash and variance", { pathParams: id }),
];
