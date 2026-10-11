// Findings module (T-040): `GET /v1/findings?status=&pack=&cursor=&limit=` — findings in the caller's outlet scope (RLS:
// outlet_ids overlap, 0012), newest first. Written only by intel through /internal/intel/v1/findings after core's
// validator (R25). `POST /v1/findings/{id}:dismiss` (T-084a) is a person's own command with a reason code.
// Mounted by modules/index.ts.
import { CommandEnvelope } from "@munim/contracts";
import { FindingStatus } from "@munim/contracts/intel";
import { Hono, type Context } from "hono";
import { contextOf, requireMember } from "../../auth/resolve.ts";
import { executeCommand, replayHeaders } from "../../commit/index.ts";
import { withContext } from "../../lib/db.ts";
import { ApiError } from "../../lib/errors.ts";
import type { AppEnv } from "../../lib/types.ts";
import { dismiss } from "./dismiss.ts";
import { CURSOR_SQL, FINDING_COLUMNS, type FindingRow, findingViews, makeCursor, parseCursor, parseLimit } from "./read.ts";
import { readRoutes } from "./routes.ts";

export { CURSOR_SQL, FINDING_COLUMNS, type FindingRow, findingViews, makeCursor, parseCursor, parseLimit } from "./read.ts";

function member(c: Context<AppEnv>) {
  const p = c.var.principal;
  if (p.kind !== "member") throw new ApiError("forbidden");
  return p;
}

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export const router = new Hono<AppEnv>().get("/v1/findings", requireMember, async (c) => {
  const m = member(c);
  const q = c.req.query();
  const status = q.status === undefined ? null : FindingStatus.safeParse(q.status);
  const pack = q.pack === undefined ? null : /^[a-z_]{1,40}$/.test(q.pack) ? q.pack : false;
  const limit = parseLimit(q.limit);
  const after = parseCursor(q.cursor);
  if ((status && !status.success) || pack === false || limit === null || (q.cursor !== undefined && !after)) throw new ApiError("bad_request");
  return c.json(await withContext(c.var.deps.pools.core, contextOf(m), async (db) => {
    const r = await db.query<FindingRow & { cursor: string }>(
      `SELECT ${FINDING_COLUMNS}, ${CURSOR_SQL("f")} AS cursor FROM intel.finding f
        WHERE ($1::text IS NULL OR f.status = $1) AND ($5::text IS NULL OR f.pack = $5)
          AND ($2::timestamptz IS NULL OR (f.updated_at, f.id) < ($2::timestamptz, $3::uuid))
        ORDER BY f.updated_at DESC, f.id DESC LIMIT $4`,
      [status?.data ?? null, after?.[0] ?? null, after?.[1] ?? null, limit + 1, pack]);
    const page = r.rows.slice(0, limit);
    return {
      items: await findingViews(db, page, m),
      next_cursor: r.rows.length > limit ? makeCursor(page.at(-1)!.cursor) : null,
    };
  }), 200);
})
  .post(`/v1/findings/:action{${ID}:dismiss}`, requireMember, async (c) => {
    const m = member(c);
    const raw: unknown = await c.req.json().catch(() => undefined);
    if (raw === undefined) throw new ApiError("bad_request");
    const env = CommandEnvelope.safeParse(raw);
    if (!env.success || env.data.payload.finding_id !== c.req.param("action")!.slice(0, -":dismiss".length)) throw new ApiError("invalid_payload");
    const { pools, publish } = c.var.deps;
    const out = await executeCommand(
      { tx: (fn) => withContext(pools.core, contextOf(m), fn), tenantId: m.tenant_id, actor: { kind: "member", id: m.member_id, role: m.role }, ...(publish ? { publish } : {}) },
      env.data, dismiss);
    return c.body(out.body, 200, { "Content-Type": "application/json", ...replayHeaders(out) });
  })
  .route("/", readRoutes);
