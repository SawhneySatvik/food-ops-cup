// Customers read route (T-092b; hand list row 22): GET /v1/customers/{id} — one merchant-side record, with the list's
// roles and masking (staff see a masked phone and no email). The customer table is tenant-wide: outlet isolation N/A.
import { Hono } from "hono";
import { requireMember } from "../../auth/resolve.ts";
import { ApiError } from "../../lib/errors.ts";
import { ID, memberOf, methodGuard, readAs } from "../../lib/reads.ts";
import type { AppEnv } from "../../lib/types.ts";
import { getCustomer } from "./reads.ts";

export const readRoutes = methodGuard(
  new Hono<AppEnv>().get(`/v1/customers/:id{${ID}}`, requireMember, async (c) => {
    const m = memberOf(c);
    if (!["owner", "manager", "staff", "judge"].includes(m.role)) throw new ApiError("forbidden");
    const row = await readAs(c, (db) => getCustomer(db, c.req.param("id"), m.role !== "staff"));
    if (!row) throw new ApiError("not_found");
    return c.json(row, 200);
  }),
  [[`/v1/customers/:id{${ID}}`, "GET"]],
);
