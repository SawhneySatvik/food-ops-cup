// Findings module (T-040): `GET /v1/findings?status=&cursor=&limit=` — findings in the caller's outlet scope (RLS:
// outlet_ids overlap, 0012), newest first. Written only by intel through /internal/intel/v1/findings after core's
// validator (R25); dismissing is T-084a. Mounted by modules/index.ts.
import { FindingStatus } from "@munim/contracts/intel";
import { Hono, type Context } from "hono";
import { contextOf, requireMember } from "../../auth/resolve.ts";
import { withContext } from "../../lib/db.ts";
import { ApiError } from "../../lib/errors.ts";
import type { AppEnv } from "../../lib/types.ts";
import { CURSOR_SQL, FINDING_COLUMNS, type FindingRow, findingViews, makeCursor, parseCursor, parseLimit } from "./read.ts";

export { CURSOR_SQL, FINDING_COLUMNS, type FindingRow, findingViews, makeCursor, parseCursor, parseLimit } from "./read.ts";

function member(c: Context<AppEnv>) {
  const p = c.var.principal;
  if (p.kind !== "member") throw new ApiError("forbidden");
  return p;
}

export const router = new Hono<AppEnv>().get("/v1/findings", requireMember, async (c) => {
  const m = member(c);
  const q = c.req.query();
  const status = q.status === undefined ? null : FindingStatus.safeParse(q.status);
  const limit = parseLimit(q.limit);
  const after = parseCursor(q.cursor);
  if ((status && !status.success) || limit === null || (q.cursor !== undefined && !after)) throw new ApiError("bad_request");
  return c.json(await withContext(c.var.deps.pools.core, contextOf(m), async (db) => {
    const r = await db.query<FindingRow & { cursor: string }>(
      `SELECT ${FINDING_COLUMNS}, ${CURSOR_SQL("f")} AS cursor FROM intel.finding f
        WHERE ($1::text IS NULL OR f.status = $1)
          AND ($2::timestamptz IS NULL OR (f.updated_at, f.id) < ($2::timestamptz, $3::uuid))
        ORDER BY f.updated_at DESC, f.id DESC LIMIT $4`,
      [status?.data ?? null, after?.[0] ?? null, after?.[1] ?? null, limit + 1]);
    const page = r.rows.slice(0, limit);
    return {
      items: await findingViews(db, page, m),
      next_cursor: r.rows.length > limit ? makeCursor(page.at(-1)!.cursor) : null,
    };
  }), 200);
});
