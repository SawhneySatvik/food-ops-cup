// Inventory read routes (T-092a; hand list rows 7-10). Rows under the member's RLS (stock counts, waste and movements are
// outlet-scoped; transfers are visible from either end; ingredients are tenant-wide, so outlet isolation does not apply
// to them). No on-hand or variance figure is computed here: those are snapshot templates (R26).
//   GET /v1/inventory/ingredients?outlet=&q=&limit=&cursor=
//   GET /v1/inventory/waste?outlet=&business_date=&limit=&cursor=       (business date = the outlet's local day less its cutoff)
//   GET /v1/inventory/counts?outlet=&status=&limit=&cursor= · GET /v1/inventory/counts/{id}  (with its lines)
//   GET /v1/inventory/transfers?outlet=&status=&limit=&cursor=          (outlet = either end; each with its lines)
import { Hono } from "hono";
import { requireMember } from "../../auth/resolve.ts";
import { ApiError } from "../../lib/errors.ts";
import { cursorOf, ID, inScope, iso, limitOf, memberOf, methodGuard, optDate, optEnum, optUuid, page, readAs } from "../../lib/reads.ts";
import type { AppEnv } from "../../lib/types.ts";

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

const countLine = (l: Record<string, any>) => ({
  count_line_id: l.id, ingredient_id: l.ingredient_id, batch_id: l.batch_id, expected_qty_milli: Number(l.expected_qty_milli),
  counted_qty_milli: Number(l.counted_qty_milli), unit: l.unit,
});
const COUNT = `SELECT id, outlet_id, counted_by, counted_at, status FROM core.stock_count`;
const countView = (r: Record<string, any>, lines: Array<Record<string, any>>) => ({
  stock_count_id: r.id, outlet_id: r.outlet_id, counted_by: r.counted_by, counted_at: r.counted_at.toISOString(), status: r.status, lines: lines.map(countLine),
});
const COUNT_LINES = `SELECT id, stock_count_id, ingredient_id, batch_id, expected_qty_milli, counted_qty_milli, unit FROM core.stock_count_line`;

export const readRoutes = methodGuard(
  new Hono<AppEnv>()
    .get("/v1/inventory/ingredients", requireMember, async (c) => {
      const outlet = optUuid(c, "outlet");
      if (outlet !== null) inScope(memberOf(c), outlet);
      const q = c.req.query("q")?.trim() ?? "";
      if (q.length > 100) throw new ApiError("bad_request");
      const limit = limitOf(c);
      const cursor = cursorOf(c);
      const rows = await readAs(c, async (db) => (await db.query<Record<string, any>>(
        `SELECT id, name, base_unit, shelf_life_days, tracked_by_batch, active FROM core.ingredient
          WHERE ($1 = '' OR name ILIKE $2) AND ($3::uuid IS NULL OR id < $3) ORDER BY id DESC LIMIT $4`,
        [q, `%${escapeLike(q)}%`, cursor, limit + 1])).rows);
      return c.json(page(rows, limit, (i) => ({
        ingredient_id: i.id, name: i.name, base_unit: i.base_unit, shelf_life_days: i.shelf_life_days, tracked_by_batch: i.tracked_by_batch, active: i.active,
      })), 200);
    })
    .get("/v1/inventory/waste", requireMember, async (c) => {
      const outlet = optUuid(c, "outlet");
      if (outlet === null) throw new ApiError("bad_request");
      inScope(memberOf(c), outlet);
      const date = optDate(c, "business_date");
      const limit = limitOf(c);
      const cursor = cursorOf(c);
      const rows = await readAs(c, async (db) => (await db.query<Record<string, any>>(
        `SELECT w.id, w.outlet_id, w.ingredient_id, w.batch_id, w.qty_milli, w.unit, w.reason, w.note, w.recorded_by, w.at,
                ((w.at AT TIME ZONE ou.tz) - ou.business_day_cutoff)::date::text AS business_date
           FROM core.waste_log w JOIN core.outlet ou ON ou.tenant_id = w.tenant_id AND ou.id = w.outlet_id
          WHERE w.outlet_id = $1 AND ($2::date IS NULL OR ((w.at AT TIME ZONE ou.tz) - ou.business_day_cutoff)::date = $2)
            AND ($3::uuid IS NULL OR w.id < $3)
          ORDER BY w.id DESC LIMIT $4`, [outlet, date, cursor, limit + 1])).rows);
      return c.json(page(rows, limit, (w) => ({
        waste_id: w.id, outlet_id: w.outlet_id, ingredient_id: w.ingredient_id, batch_id: w.batch_id, qty_milli: Number(w.qty_milli), unit: w.unit,
        reason: w.reason, note: w.note, recorded_by: w.recorded_by, at: w.at.toISOString(), business_date: w.business_date,
      })), 200);
    })
    .get("/v1/inventory/counts", requireMember, async (c) => {
      const outlet = optUuid(c, "outlet");
      if (outlet !== null) inScope(memberOf(c), outlet);
      const status = optEnum(c, "status", ["open", "submitted", "cancelled"] as const);
      const limit = limitOf(c);
      const cursor = cursorOf(c);
      const out = await readAs(c, async (db) => {
        const rows = (await db.query<Record<string, any>>(
          `${COUNT} WHERE ($1::uuid IS NULL OR outlet_id = $1) AND ($2::text IS NULL OR status = $2) AND ($3::uuid IS NULL OR id < $3)
            ORDER BY id DESC LIMIT $4`, [outlet, status, cursor, limit + 1])).rows;
        const shown = rows.slice(0, limit);
        const lines = (await db.query<Record<string, any>>(`${COUNT_LINES} WHERE stock_count_id = ANY ($1::uuid[]) ORDER BY id`, [shown.map((r) => r.id)])).rows;
        return page(rows, limit, (r) => countView(r, lines.filter((l) => l.stock_count_id === r.id)));
      });
      return c.json(out, 200);
    })
    .get(`/v1/inventory/counts/:id{${ID}}`, requireMember, async (c) => {
      const out = await readAs(c, async (db) => {
        const r = (await db.query<Record<string, any>>(`${COUNT} WHERE id = $1`, [c.req.param("id")])).rows[0];
        if (!r) throw new ApiError("not_found");
        return countView(r, (await db.query<Record<string, any>>(`${COUNT_LINES} WHERE stock_count_id = $1 ORDER BY id`, [r.id])).rows);
      });
      return c.json(out, 200);
    })
    .get("/v1/inventory/transfers", requireMember, async (c) => {
      const outlet = optUuid(c, "outlet");
      if (outlet !== null) inScope(memberOf(c), outlet);
      const status = optEnum(c, "status", ["sent", "received", "cancelled"] as const);
      const limit = limitOf(c);
      const cursor = cursorOf(c);
      const out = await readAs(c, async (db) => {
        const rows = (await db.query<Record<string, any>>(
          `SELECT id, from_outlet_id, to_outlet_id, status, sent_by, sent_at, received_by, received_at FROM core.transfer
            WHERE ($1::uuid IS NULL OR from_outlet_id = $1 OR to_outlet_id = $1) AND ($2::text IS NULL OR status = $2) AND ($3::uuid IS NULL OR id < $3)
            ORDER BY id DESC LIMIT $4`, [outlet, status, cursor, limit + 1])).rows;
        const shown = rows.slice(0, limit);
        const lines = (await db.query<Record<string, any>>(
          `SELECT id, transfer_id, ingredient_id, batch_id, qty_milli, unit FROM core.transfer_line WHERE transfer_id = ANY ($1::uuid[]) ORDER BY id`,
          [shown.map((r) => r.id)])).rows;
        return page(rows, limit, (t) => ({
          transfer_id: t.id, from_outlet_id: t.from_outlet_id, to_outlet_id: t.to_outlet_id, status: t.status, sent_by: t.sent_by,
          sent_at: t.sent_at.toISOString(), received_by: t.received_by, received_at: iso(t.received_at),
          lines: lines.filter((l) => l.transfer_id === t.id).map((l) => ({
            transfer_line_id: l.id, ingredient_id: l.ingredient_id, batch_id: l.batch_id, qty_milli: Number(l.qty_milli), unit: l.unit,
          })),
        }));
      });
      return c.json(out, 200);
    }),
  [
    ["/v1/inventory/ingredients", "GET, POST"], ["/v1/inventory/waste", "GET, POST"], ["/v1/inventory/counts", "GET, POST"],
    [`/v1/inventory/counts/:id{${ID}}`, "GET"], ["/v1/inventory/transfers", "GET, POST"],
  ],
);
