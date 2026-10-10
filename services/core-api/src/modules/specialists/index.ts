// Specialist desks (T-087b, ledger R45 F8/F9). `GET /v1/specialists` lists the team (8 specialists + the Manager; the
// Forecast service has no desk). `GET /v1/specialists/{id}` is a desk page: open findings (`pack`), proposed drafts
// (`source = intel:<id>`), threads addressed to it, and the track record as a snapshot MINTED for this viewer
// (`intel.agent_track_record`, member minimum role manager): the response carries the snapshot id and one cell ref per
// count, never a count (clause 2). Every row list is read under the viewer's RLS, so outlet scope is the database's.
// Mounted by modules/index.ts.
import { SPECIALIST_REGISTRY } from "@munim/contracts/intel";
import { snapRef } from "@munim/contracts";
import { TRACK_RECORD_COUNTS } from "@munim/contracts/specialists";
import { Hono, type Context } from "hono";
import { contextOf, requireMember } from "../../auth/resolve.ts";
import { withContext } from "../../lib/db.ts";
import { ApiError } from "../../lib/errors.ts";
import type { AppEnv } from "../../lib/types.ts";
import { getDraft } from "../approvals/index.ts";
import { mintSnapshot } from "../evidence/index.ts";
import { FINDING_COLUMNS, type FindingRow, findingViews } from "../findings/index.ts";

/** Newest-first cap per list; a desk page is not a paged feed (the inbox and /v1/findings page). */
const DESK_LIMIT = 20;

const team = SPECIALIST_REGISTRY.specialists.filter((s) => s.kind !== "service");

function member(c: Context<AppEnv>) {
  const p = c.var.principal;
  if (p.kind !== "member") throw new ApiError("forbidden");
  return p;
}

export const router = new Hono<AppEnv>()
  .get("/v1/specialists", requireMember, (c) => {
    member(c);
    return c.json({ items: team }, 200);
  })
  .get("/v1/specialists/:id", requireMember, async (c) => {
    const m = member(c);
    const entry = team.find((s) => s.id === c.req.param("id"));
    if (!entry) throw new ApiError("not_found");
    const pools = c.var.deps.pools;
    const scope = m.outlet_ids === "*" ? ["*" as const] as ["*"] : m.outlet_ids;

    const part = await withContext(pools.core, contextOf(m), async (db) => {
      // Kitchen is off for store outlets (kitchen.md §1): on a scope with no non-store outlet the desk is empty, not an error.
      const applicable = entry.id !== "kitchen" ||
        (await db.query<{ ok: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM core.outlet WHERE kind <> 'store' AND ($1::uuid[] IS NULL OR id = ANY ($1::uuid[]))) AS ok`,
          [m.outlet_ids === "*" ? null : m.outlet_ids])).rows[0]!.ok;
      if (!applicable) return { applicable, findings: [], draftIds: [], threads: [], track: null };
      const f = await db.query<FindingRow>(
        `SELECT ${FINDING_COLUMNS} FROM intel.finding f WHERE f.pack = $1 AND f.status = 'open' ORDER BY f.updated_at DESC, f.id DESC LIMIT $2`,
        [entry.id, DESK_LIMIT]);
      const d = await db.query<{ id: string }>(
        `SELECT id FROM core.draft WHERE source = $1 AND status = 'proposed' ORDER BY updated_at DESC, id DESC LIMIT $2`,
        ["intel:" + entry.id, DESK_LIMIT]);
      const t = await db.query<{ thread_id: string; last: Date }>(
        `SELECT t.id AS thread_id, greatest(t.updated_at, max(u.created_at)) AS last
           FROM core.ai_thread t LEFT JOIN core.ai_thread_turn u ON u.tenant_id = t.tenant_id AND u.thread_id = t.id
          WHERE t.specialist = $1 OR EXISTS (SELECT 1 FROM core.ai_thread_turn a WHERE a.tenant_id = t.tenant_id AND a.thread_id = t.id AND a.addressed_to = $1)
          GROUP BY t.id, t.updated_at ORDER BY 2 DESC, t.id DESC LIMIT $2`, [entry.id, DESK_LIMIT]);
      let track: { snapshot_id: string; cells: Record<string, string> | null } | null = null;
      if (entry.kind === "specialist") {
        try {
          const snap = await mintSnapshot(db, m.tenant_id, { kind: "member", member_id: m.member_id, role: m.role, scope }, "intel.agent_track_record", { specialist: entry.id });
          track = { snapshot_id: snap.snapshot_id, cells: snap.rows.length === 0 ? null : Object.fromEntries(TRACK_RECORD_COUNTS.map((k) => [k, snapRef(snap.snapshot_id, 0, k)])) };
        } catch (e) {
          // Below the template's minimum role (manager) the allow-list says not found: the desk simply has no track record for this viewer.
          if (!(e instanceof ApiError && e.code === "not_found")) throw e;
        }
      }
      return {
        applicable, findings: await findingViews(db, f.rows, m), draftIds: d.rows.map((r) => r.id),
        threads: t.rows.map((r) => ({ thread_id: r.thread_id, last_activity_at: r.last.toISOString() })), track,
      };
    });
    const drafts = [];
    for (const id of part.draftIds) drafts.push((await getDraft(pools, m, id)).draft);
    return c.json({ specialist: entry, applicable: part.applicable, findings: part.findings, drafts, track_record: part.track, threads: part.threads }, 200);
  });
