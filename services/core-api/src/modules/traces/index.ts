// Traces (T-040): `GET /v1/traces/{run}?after_seq=&limit=` — a run's trace events in seq order, the back office's
// only input (03-architecture §1.8). Visible exactly when the run is (0014 #37 tenant_via_run). Payloads are ids and
// short labels, as intel wrote them through traces:batch. Mounted by modules/index.ts.
import { Hono, type Context } from "hono";
import { contextOf, requireMember } from "../../auth/resolve.ts";
import { withContext } from "../../lib/db.ts";
import { ApiError } from "../../lib/errors.ts";
import type { AppEnv } from "../../lib/types.ts";

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

function member(c: Context<AppEnv>) {
  const p = c.var.principal;
  if (p.kind !== "member") throw new ApiError("forbidden");
  return p;
}

interface EventRow { run_id: string; id: string; seq: number; parent_id: string | null; actor: string; at: Date; kind: string; payload: Record<string, unknown> }

export const router = new Hono<AppEnv>().get(`/v1/traces/:run{${ID}}`, requireMember, async (c) => {
  const m = member(c);
  const run = c.req.param("run");
  const { after_seq: a, limit: l } = c.req.query();
  const after = a === undefined ? 0 : Number(a);
  const limit = l === undefined ? 100 : Number(l);
  if (!Number.isInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError("bad_request");
  const body = await withContext(c.var.deps.pools.core, contextOf(m), async (db) => {
    if ((await db.query(`SELECT 1 FROM intel.run WHERE id = $1`, [run])).rowCount === 0) return null;
    const r = await db.query<EventRow>(
      `SELECT run_id, id, seq, parent_id, actor, at, kind, payload FROM intel.trace_event WHERE run_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
      [run, after, limit]);
    return {
      run_id: run,
      events: r.rows.map((e) => ({ run_id: e.run_id, id: e.id, seq: e.seq, parent_id: e.parent_id, actor: e.actor, at: e.at.toISOString(), kind: e.kind, payload: e.payload })),
      // A full page may have more behind it; a short page is the end of what the run has written so far.
      next_after_seq: r.rows.length === limit ? r.rows.at(-1)!.seq : null,
    };
  });
  if (!body) throw new ApiError("not_found");
  return c.json(body, 200);
});
