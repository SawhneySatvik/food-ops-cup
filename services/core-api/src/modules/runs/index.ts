// Runs (T-040): the back-office run picker (G-OFF-1) and "which run produced this finding". Visibility is
// intel.run's RLS (0014 #37): a run whose outlet scope the member covers; a '{*}' run only to owner / advisor /
// judge holding every outlet. Mounted by modules/index.ts.
//   GET /v1/runs?finding=&cursor=&limit=   newest first; ?finding= → at most the one run behind that finding
//   GET /v1/runs/{id}
import { Hono, type Context } from "hono";
import { contextOf, requireMember } from "../../auth/resolve.ts";
import { withContext } from "../../lib/db.ts";
import { ApiError } from "../../lib/errors.ts";
import type { AppEnv } from "../../lib/types.ts";
import { makeCursor, parseCursor, parseLimit } from "../findings/index.ts";

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID = new RegExp(`^${ID}$`);

function member(c: Context<AppEnv>) {
  const p = c.var.principal;
  if (p.kind !== "member") throw new ApiError("forbidden");
  return p;
}

interface RunRow { id: string; trigger: string; actor: string; outlet_scope: string[]; issued_at: Date; expires_at: Date; ended_at: Date | null }

const view = (r: RunRow) => ({
  run_id: r.id, trigger: r.trigger, actor: r.actor, outlet_scope: r.outlet_scope, issued_at: r.issued_at.toISOString(),
  expires_at: r.expires_at.toISOString(), ended_at: r.ended_at?.toISOString() ?? null,
});

const COLS = `r.id, r.trigger, r.actor, r.outlet_scope, r.issued_at, r.expires_at, r.ended_at`;
const CURSOR = `to_char(r.issued_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || r.id`;

export const router = new Hono<AppEnv>()
  .get("/v1/runs", requireMember, async (c) => {
    const m = member(c);
    const q = c.req.query();
    const limit = parseLimit(q.limit);
    const after = parseCursor(q.cursor);
    if (limit === null || (q.cursor !== undefined && !after) || (q.finding !== undefined && !UUID.test(q.finding))) throw new ApiError("bad_request");
    return c.json(await withContext(c.var.deps.pools.core, contextOf(m), async (db) => {
      // ?finding= joins the finding under the member's own RLS too: a finding outside their scope names no run.
      const r = await db.query<RunRow & { cursor: string }>(
        `SELECT ${COLS}, ${CURSOR} AS cursor FROM intel.run r
          WHERE ($1::uuid IS NULL OR EXISTS (SELECT 1 FROM intel.finding f WHERE f.id = $1 AND f.run_id = r.id))
            AND ($2::timestamptz IS NULL OR (r.issued_at, r.id) < ($2::timestamptz, $3::uuid))
          ORDER BY r.issued_at DESC, r.id DESC LIMIT $4`,
        [q.finding ?? null, after?.[0] ?? null, after?.[1] ?? null, limit + 1]);
      const page = r.rows.slice(0, limit);
      return { items: page.map(view), next_cursor: r.rows.length > limit ? makeCursor(page.at(-1)!.cursor) : null };
    }), 200);
  })
  .get(`/v1/runs/:id{${ID}}`, requireMember, async (c) => {
    const m = member(c);
    const r = await withContext(c.var.deps.pools.core, contextOf(m), (db) =>
      db.query<RunRow>(`SELECT ${COLS} FROM intel.run r WHERE r.id = $1`, [c.req.param("id")]));
    if (!r.rows[0]) throw new ApiError("not_found");
    return c.json(view(r.rows[0]), 200);
  });
