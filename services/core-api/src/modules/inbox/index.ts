// Inbox (T-040): `GET /v1/inbox?cursor=&limit=` — open findings and proposed drafts awaiting a person, in the
// caller's outlet scope (RLS on both tables), newest change first. Ranking (impact × confidence × urgency) is
// `inbox/ranking.ts`'s, not built here. Values beside refs come only from snapshot cells the viewer may open (R26).
// Mounted by modules/index.ts.
import { Hono, type Context } from "hono";
import { contextOf, requireMember } from "../../auth/resolve.ts";
import { withContext } from "../../lib/db.ts";
import { ApiError } from "../../lib/errors.ts";
import type { AppEnv } from "../../lib/types.ts";
import type { Queryable } from "../../runtoken/index.ts";
import { cellOf, loadSnapshots, type Member, resolvedRefs, snapIdOf, snapshotIdsOf } from "../approvals/index.ts";
import { CURSOR_SQL, FINDING_COLUMNS, type FindingRow, findingViews, makeCursor, parseCursor, parseLimit } from "../findings/index.ts";

function member(c: Context<AppEnv>) {
  const p = c.var.principal;
  if (p.kind !== "member") throw new ApiError("forbidden");
  return p;
}

interface DraftRow {
  id: string; outlet_ids: string[]; source: string; finding_id: string | null; run_id: string | null; command_type: string;
  command_payload: Record<string, unknown>; evidence: string[]; based_on: unknown[]; status: string; created_at: Date; updated_at: Date;
}

const basedOnRefs = (b: unknown[]) =>
  b.map((e) => (typeof e === "string" ? e : (e as { ref?: unknown } | null)?.ref)).filter((r): r is string => typeof r === "string");

/** contracts `DraftView`, as GET /v1/drafts builds it: template, params and expected cell come from the snapshot
 *  row, never from the draft; a based_on ref the viewer cannot open is left out. */
async function draftViews(c: Queryable, rows: DraftRow[], m: Member) {
  const ids = rows.flatMap((r) => [...snapshotIdsOf(r.command_payload), ...basedOnRefs(r.based_on).map((x) => snapIdOf(x) ?? "")]).filter(Boolean);
  const snaps = await loadSnapshots(c, ids, m);
  return rows.map((r) => ({
    draft_id: r.id, command_type: r.command_type, payload: r.command_payload, resolved_refs: resolvedRefs(r.command_payload, snaps).resolved,
    outlet_ids: r.outlet_ids, source: r.source, finding_id: r.finding_id, run_id: r.run_id, evidence: r.evidence,
    based_on: basedOnRefs(r.based_on).flatMap((ref) => {
      const cell = cellOf(ref, snaps);
      const s = snaps.get(snapIdOf(ref) ?? "");
      return cell && s ? [{ ref, template_id: s.template_id, params: s.params, expected: cell.value }] : [];
    }),
    status: r.status, created_at: r.created_at.toISOString(), updated_at: r.updated_at.toISOString(),
  }));
}

export const router = new Hono<AppEnv>().get("/v1/inbox", requireMember, async (c) => {
  const m = member(c);
  const q = c.req.query();
  const limit = parseLimit(q.limit);
  const after = parseCursor(q.cursor);
  if (limit === null || (q.cursor !== undefined && !after)) throw new ApiError("bad_request");
  return c.json(await withContext(c.var.deps.pools.core, contextOf(m), async (db) => {
    const page = await db.query<{ kind: "finding" | "draft"; id: string; cursor: string }>(
      `SELECT * FROM (
         SELECT 'finding' AS kind, f.id, f.updated_at, ${CURSOR_SQL("f")} AS cursor FROM intel.finding f WHERE f.status = 'open'
         UNION ALL
         SELECT 'draft', r.id, r.updated_at, ${CURSOR_SQL("r")} FROM core.draft r WHERE r.status = 'proposed') x
        WHERE ($1::timestamptz IS NULL OR (x.updated_at, x.id) < ($1::timestamptz, $2::uuid))
        ORDER BY x.updated_at DESC, x.id DESC LIMIT $3`,
      [after?.[0] ?? null, after?.[1] ?? null, limit + 1]);
    const items = page.rows.slice(0, limit);
    const ofKind = (k: string) => items.filter((i) => i.kind === k).map((i) => i.id);
    const findings = await db.query<FindingRow>(`SELECT ${FINDING_COLUMNS} FROM intel.finding f WHERE f.id = ANY ($1::uuid[])`, [ofKind("finding")]);
    const drafts = await db.query<DraftRow>(
      `SELECT id, outlet_ids, source, finding_id, run_id, command_type, command_payload, evidence, based_on, status, created_at, updated_at
         FROM core.draft WHERE id = ANY ($1::uuid[])`, [ofKind("draft")]);
    const fv = new Map((await findingViews(db, findings.rows, m)).map((v) => [v.finding_id, v]));
    const dv = new Map((await draftViews(db, drafts.rows, m)).map((v) => [v.draft_id, v]));
    return {
      items: items.map((i) => (i.kind === "finding" ? { kind: "finding" as const, finding: fv.get(i.id)! } : { kind: "draft" as const, draft: dv.get(i.id)! })),
      next_cursor: page.rows.length > limit ? makeCursor(items.at(-1)!.cursor) : null,
    };
  }), 200);
});
