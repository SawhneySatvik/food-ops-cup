// Tenancy read routes (T-092b; hand list row 20): an outlet's weekly hours and dated overrides (holidays), as rows.
//   GET /v1/outlets/{id}/calendar
// core.outlet_calendar carries an outlet policy; an outlet outside the member's scope is 404 before any row is read.
import { Hono } from "hono";
import { requireMember } from "../../auth/resolve.ts";
import { ApiError } from "../../lib/errors.ts";
import { ID, inScope, memberOf, methodGuard, readAs } from "../../lib/reads.ts";
import type { AppEnv } from "../../lib/types.ts";

export const readRoutes = methodGuard(
  new Hono<AppEnv>()
    .get(`/v1/outlets/:id{${ID}}/calendar`, requireMember, async (c) => {
      const id = c.req.param("id");
      inScope(memberOf(c), id);
      const out = await readAs(c, async (db) => {
        const outlet = (await db.query<{ tz: string }>(`SELECT tz FROM core.outlet WHERE id = $1`, [id])).rows[0];
        if (!outlet) throw new ApiError("not_found");
        const rows = (await db.query<Record<string, any>>(
          `SELECT id, kind, weekday, on_date::text AS on_date, to_char(opens_at, 'HH24:MI') AS opens_at, to_char(closes_at, 'HH24:MI') AS closes_at, closed
             FROM core.outlet_calendar WHERE outlet_id = $1 ORDER BY kind DESC, weekday, on_date, id`, [id])).rows;
        return {
          outlet_id: id, tz: outlet.tz,
          rows: rows.map((r) => ({ calendar_id: r.id, kind: r.kind, weekday: r.weekday, on_date: r.on_date, opens_at: r.opens_at, closes_at: r.closes_at, closed: r.closed })),
        };
      });
      return c.json(out, 200);
    }),
  [[`/v1/outlets/:id{${ID}}/calendar`, "GET"]],
);
