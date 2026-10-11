// Customers read route (T-092b; hand list row 22). Its response is the existing `v1.customer` view (CustomerView).
import type { Route } from "../shared/routes.ts";

export const READ_ROUTES: readonly Route[] = [
  { surface: "public", method: "get", path: "/v1/customers/{id}", operationId: "getCustomer", summary: "One merchant-side customer record (owner/manager/staff/judge; staff see a masked phone and no email)",
    auth: "member", response: "v1.customer", status: 200, pathParams: [{ name: "id", uuid: true }] },
];
