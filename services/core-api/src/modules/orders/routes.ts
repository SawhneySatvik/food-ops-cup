// Orders read routes (T-092a/b; hand list rows 1, 2, 21). Rows under the member's own RLS (outlet scope); every
// number is a row field (R26: no aggregate here). Mounted at the end of the module's chain by orders/index.ts.
//   GET /v1/orders?outlet=&status=&table_ref=&shift=&business_date=&limit=&cursor=
//   GET /v1/shifts?outlet=&device=&status=&from=&to=&limit=&cursor=   (from / to = the outlet's business day)
//   GET /v1/pickup-windows?outlet=&date=            (member; the outlet's local calendar day)
import { OrderStatus } from "@munim/contracts/orders";
import { Hono } from "hono";
import { requireMember } from "../../auth/resolve.ts";
import { ApiError } from "../../lib/errors.ts";
import { cursorOf, inScope, int, iso, limitOf, memberOf, methodGuard, optDate, optEnum, optUuid, page, readAs } from "../../lib/reads.ts";
import type { AppEnv } from "../../lib/types.ts";

function outletFilter(c: Parameters<typeof optUuid>[0]): string | null {
  const o = optUuid(c, "outlet");
  if (o !== null) inScope(memberOf(c), o);
  return o;
}

export const readRoutes = methodGuard(
  new Hono<AppEnv>()
    .get("/v1/orders", requireMember, async (c) => {
      const outlet = outletFilter(c);
      const status = optEnum(c, "status", OrderStatus.options);
      const shift = optUuid(c, "shift");
      const date = optDate(c, "business_date");
      const table = c.req.query("table_ref") ?? null;
      if (table !== null && (table.length < 1 || table.length > 20)) throw new ApiError("bad_request");
      const limit = limitOf(c);
      const cursor = cursorOf(c);
      // core.order has no shift column: a shift's orders are the orders it took a tender for.
      const rows = await readAs(c, async (db) => (await db.query<Record<string, any>>(
        `SELECT o.id, o.outlet_id, o.channel_id, o.device_id, o.kind, o.table_ref, o.status, o.business_date::text AS business_date, o.ticket_no,
                o.subtotal_minor, o.discount_minor, o.tax_minor, o.total_minor, o.currency, o.promised_at, o.created_at
           FROM core."order" o
          WHERE ($1::uuid IS NULL OR o.outlet_id = $1) AND ($2::text IS NULL OR o.status = $2) AND ($3::text IS NULL OR o.table_ref = $3)
            AND ($4::date IS NULL OR o.business_date = $4)
            AND ($5::uuid IS NULL OR EXISTS (SELECT 1 FROM core.tender t WHERE t.tenant_id = o.tenant_id AND t.order_id = o.id AND t.shift_id = $5))
            AND ($6::uuid IS NULL OR o.id < $6)
          ORDER BY o.id DESC LIMIT $7`, [outlet, status, table, date, shift, cursor, limit + 1])).rows);
      return c.json(page(rows, limit, (o) => ({
        order_id: o.id, outlet_id: o.outlet_id, channel_id: o.channel_id, device_id: o.device_id, kind: o.kind, table_ref: o.table_ref,
        status: o.status, business_date: o.business_date, ticket_no: o.ticket_no,
        subtotal_minor: Number(o.subtotal_minor), discount_minor: Number(o.discount_minor), tax_minor: Number(o.tax_minor), total_minor: Number(o.total_minor),
        currency: o.currency, promised_at: iso(o.promised_at), created_at: o.created_at.toISOString(),
      })), 200);
    })
    .get("/v1/shifts", requireMember, async (c) => {
      const outlet = outletFilter(c);
      const device = optUuid(c, "device");
      const status = optEnum(c, "status", ["open", "closed"] as const);
      const from = optDate(c, "from");
      const to = optDate(c, "to");
      if (from && to && to < from) throw new ApiError("bad_request");
      const limit = limitOf(c);
      const cursor = cursorOf(c);
      // from / to bound the opening instant by the outlet's BUSINESS day, as the snapshot templates do (0019): local time less the
      // outlet's business_day_cutoff. DST-safe: Postgres does the zone maths.
      const rows = await readAs(c, async (db) => (await db.query<Record<string, any>>(
        `SELECT s.id, s.outlet_id, s.device_id, s.status, s.opened_by, s.opened_at, s.float_minor, s.currency, s.closed_by, s.closed_at,
                s.counted_cash_minor, s.expected_cash_minor, s.variance_minor
           FROM core.shift s JOIN core.outlet ou ON ou.tenant_id = s.tenant_id AND ou.id = s.outlet_id
          WHERE ($1::uuid IS NULL OR s.outlet_id = $1) AND ($2::uuid IS NULL OR s.device_id = $2) AND ($3::text IS NULL OR s.status = $3)
            AND ($4::date IS NULL OR ((s.opened_at AT TIME ZONE ou.tz) - ou.business_day_cutoff)::date >= $4)
            AND ($5::date IS NULL OR ((s.opened_at AT TIME ZONE ou.tz) - ou.business_day_cutoff)::date <= $5)
            AND ($6::uuid IS NULL OR s.id < $6)
          ORDER BY s.id DESC LIMIT $7`, [outlet, device, status, from, to, cursor, limit + 1])).rows);
      return c.json(page(rows, limit, (s) => ({
        shift_id: s.id, outlet_id: s.outlet_id, device_id: s.device_id, status: s.status, opened_by: s.opened_by, opened_at: s.opened_at.toISOString(),
        float_minor: Number(s.float_minor), currency: s.currency, closed_by: s.closed_by, closed_at: iso(s.closed_at),
        counted_cash_minor: int(s.counted_cash_minor), expected_cash_minor: int(s.expected_cash_minor), variance_minor: int(s.variance_minor),
      })), 200);
    })
    // `date` is the outlet's BUSINESS date (local less the cutoff), as orders.pickup_window.generate.v1 interprets it: a 01:00 slot belongs to the day before.
    .get("/v1/pickup-windows", requireMember, async (c) => {
      const outlet = optUuid(c, "outlet");
      const date = optDate(c, "date");
      if (outlet === null || date === null) throw new ApiError("bad_request");
      inScope(memberOf(c), outlet);
      const limit = limitOf(c, 100, 200);
      const cursor = cursorOf(c);
      const rows = await readAs(c, async (db) => (await db.query<Record<string, any>>(
        `SELECT w.id, w.outlet_id, w.starts_at, w.ends_at, w.capacity_orders, w.booked
           FROM core.pickup_window w JOIN core.outlet ou ON ou.tenant_id = w.tenant_id AND ou.id = w.outlet_id
          WHERE w.outlet_id = $1 AND ((w.starts_at AT TIME ZONE ou.tz) - ou.business_day_cutoff)::date = $2::date AND ($3::uuid IS NULL OR (w.starts_at, w.id) > (SELECT x.starts_at, x.id FROM core.pickup_window x WHERE x.id = $3))
          ORDER BY w.starts_at, w.id LIMIT $4`, [outlet, date, cursor, limit + 1])).rows);
      return c.json(page(rows, limit, (w) => ({
        pickup_window_id: w.id, outlet_id: w.outlet_id, starts_at: w.starts_at.toISOString(), ends_at: w.ends_at.toISOString(),
        capacity_orders: w.capacity_orders, booked: w.booked,
      })), 200);
    }),
  [["/v1/orders", "GET, POST"], ["/v1/shifts", "GET, POST"], ["/v1/pickup-windows", "GET, POST"]],
);
