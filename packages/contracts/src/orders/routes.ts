// Orders / POS routes (T-022; BOARD D-2 rider: routes named here). Member auth throughout; storefront placement
// and tracking are T-032's routes over the placeOrder / previewOrder seams.
// Order status changes at the POS: orders.order.accept.v1 / .reject.v1 / .advance.v1 (0015 A4). The kitchen's
// ticket advance (kitchen.ticket.advance.v1) moves orders through the same orders path (W2-R9).
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
  command("/v1/orders/{id}:accept", "acceptOrder", "orders.order.accept.v1", "Accept a placed order", { pathParams: id }),
  command("/v1/orders/{id}:reject", "rejectOrder", "orders.order.reject.v1", "Reject a placed order with a reason code; consumed stock, redeemed points and the pickup slot are given back", { pathParams: id }),
  command("/v1/orders/{id}:advance", "advanceOrder", "orders.order.advance.v1", "Move an order one step (preparing, ready, completed, or cancelled with a reason — refused while payments stand unrefunded); completion derives loyalty earn and the sale's journal entry", { pathParams: id }),
  command("/v1/orders/{id}:push-back", "pushBackOrder", "orders.promise.push_back.v1", "Move the promised time later with a reason code; deals are re-judged at the new time; refused once a payment is recorded", { pathParams: id }),
  command("/v1/orders/{id}/tenders", "recordTender", "orders.tender.record.v1", "Record a cash / card / UPI payment (recorded only — Munim does not process payments)", { pathParams: id }),
  command("/v1/orders/{id}/voids", "recordVoid", "orders.void.record.v1", "Void a line, or the whole order (which cancels it; voids never exceed the total), with a reason; before any payment", { pathParams: id }),
  command("/v1/orders/{id}/refunds", "recordRefund", "orders.refund.record.v1", "Record a refund with a reason, within what was paid and the member's authority", { pathParams: id }),
  command("/v1/pickup-windows", "generatePickupWindows", "orders.pickup_window.generate.v1", "Create pickup slots for a business date (outlet-local times, DST-safe); existing slots are kept"),
  command("/v1/shifts", "openShift", "orders.shift.open.v1", "Open a drawer shift with its float"),
  command("/v1/shifts/{id}:close", "closeShift", "orders.shift.close.v1", "Close a shift with the counted cash; core computes expected cash and variance", { pathParams: id }),
  { surface: "public", method: "get", path: "/v1/shifts/{id}", operationId: "getShift", summary: "One drawer shift: opening float and, once closed, counted cash, expected cash and variance (row fields)", auth: "member", response: "v1.shift", status: 200, pathParams: id },
];
