// Draft read paths (D-2 rider: draft get + decided list). Items are DraftView (contracts approvals) plus the
// person's decision; values beside refs come only from snapshot cells the viewer may open (R26, R40 C4).
// A badge is the length of the list returned here, with `has_more` for "N+" — no server count (R40 C3).
import { withContext, type Pools } from "../../lib/db.ts";
import { ApiError } from "../../lib/errors.ts";
import { contextOf } from "../../auth/resolve.ts";
import type { Queryable } from "../../runtoken/index.ts";
import { resolvedRefs, snapshotIdsOf } from "./payload.ts";
import { cellOf, loadSnapshots, type LoadedSnapshot, type Member, snapIdOf } from "./snapshots.ts";

const STATUSES = ["proposed", "executing", "executed", "failed", "rejected", "stale"] as const;
/** `status=decided`: drafts a person decided (stale drafts were never decided — ask for `status=stale`). */
const DECIDED = ["executed", "failed", "rejected"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface DraftRow {
  id: string;
  outlet_ids: string[];
  source: string;
  finding_id: string | null;
  run_id: string | null;
  command_type: string;
  command_payload: Record<string, unknown>;
  evidence: string[];
  based_on: unknown[];
  status: string;
  created_at: Date;
  updated_at: Date;
  cursor: string;
  d_id: string | null;
  verdict: string | null;
  reason: string | null;
  decided_by: string | null;
  decided_by_name: string | null;
  decided_at: Date | null;
}

const SELECT = `
  SELECT r.id, r.outlet_ids, r.source, r.finding_id, r.run_id, r.command_type, r.command_payload, r.evidence, r.based_on,
         r.status, r.created_at, r.updated_at,
         to_char(r.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || r.id AS cursor,
         d.id AS d_id, d.verdict, d.reason, d.decided_by, mb.name AS decided_by_name, d.decided_at
    FROM core.draft r
    LEFT JOIN core.decision d ON d.tenant_id = r.tenant_id AND d.draft_id = r.id
    LEFT JOIN core.member mb ON mb.tenant_id = d.tenant_id AND mb.id = d.decided_by`;

const basedOnRefs = (b: unknown[]) =>
  b.map((e) => (typeof e === "string" ? e : (e as { ref?: unknown } | null)?.ref)).filter((r): r is string => typeof r === "string");

function view(r: DraftRow, snaps: Map<string, LoadedSnapshot>) {
  const { resolved, unresolved } = resolvedRefs(r.command_payload, snaps);
  const basedOn: Array<{ ref: string; template_id: string; params: Record<string, unknown>; expected: unknown }> = [];
  for (const ref of basedOnRefs(r.based_on)) {
    const cell = cellOf(ref, snaps);
    const s = snaps.get(snapIdOf(ref) ?? "");
    // Template, params and expected cell come from the snapshot row, not from the draft.
    if (cell && s) basedOn.push({ ref, template_id: s.template_id, params: s.params, expected: cell.value });
    else unresolved.push(ref);
  }
  return {
    draft: {
      draft_id: r.id,
      command_type: r.command_type,
      payload: r.command_payload,
      resolved_refs: resolved,
      outlet_ids: r.outlet_ids,
      source: r.source,
      finding_id: r.finding_id,
      run_id: r.run_id,
      evidence: r.evidence,
      based_on: basedOn,
      status: r.status,
      created_at: r.created_at.toISOString(),
      updated_at: r.updated_at.toISOString(),
    },
    decision: r.d_id
      ? { decision_id: r.d_id, verdict: r.verdict, reason: r.reason, decided_by: { member_id: r.decided_by, name: r.decided_by_name }, decided_at: r.decided_at!.toISOString() }
      : null,
    /** Refs that do not resolve for this viewer: shown as "cannot verify", and Approve is hidden. */
    unverified_refs: unresolved,
  };
}

async function snapshotsFor(c: Queryable, rows: DraftRow[], m: Member, extra: string[] = []) {
  const ids = rows.flatMap((r) => [...snapshotIdsOf(r.command_payload), ...basedOnRefs(r.based_on).map((x) => snapIdOf(x) ?? "")]);
  return loadSnapshots(c, [...ids, ...extra].filter((x) => UUID.test(x)), m);
}

export interface ListQuery {
  status?: string | undefined;
  outlet?: string | undefined;
  /** T-092a: `intel:<pack>` | `import` | `member`. */
  source?: string | undefined;
  limit?: string | undefined;
  cursor?: string | undefined;
}

export async function listDrafts(pools: Pools, m: Member, q: ListQuery) {
  const status = q.status ?? "proposed";
  const statuses = status === "decided" ? DECIDED : (STATUSES as readonly string[]).includes(status) ? [status] : null;
  const limit = q.limit === undefined ? 50 : Number(q.limit);
  if (!statuses || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new ApiError("bad_request");
  if (q.outlet !== undefined && !UUID.test(q.outlet)) throw new ApiError("bad_request");
  if (q.source !== undefined && !/^(intel:[a-z_]+|import|member)$/.test(q.source)) throw new ApiError("bad_request");
  let after: [string, string] | null = null;
  if (q.cursor !== undefined) {
    const [at, id] = Buffer.from(q.cursor, "base64url").toString("utf8").split("|");
    if (!at || !id || !UUID.test(id) || Number.isNaN(Date.parse(at))) throw new ApiError("bad_request");
    after = [at, id];
  }
  return withContext(pools.core, contextOf(m), async (c) => {
    // RLS already limits drafts to the member's outlets; the outlet filter can only narrow that.
    const r = await c.query<DraftRow>(
      `${SELECT}
        WHERE r.status = ANY ($1::text[])
          AND ($2::uuid IS NULL OR $2::uuid = ANY (r.outlet_ids))
          AND ($6::text IS NULL OR r.source = $6)
          AND ($3::timestamptz IS NULL OR (r.updated_at, r.id) < ($3::timestamptz, $4::uuid))
        ORDER BY r.updated_at DESC, r.id DESC
        LIMIT $5`,
      [statuses, q.outlet ?? null, after?.[0] ?? null, after?.[1] ?? null, limit + 1, q.source ?? null]);
    const page = r.rows.slice(0, limit);
    const snaps = await snapshotsFor(c, page, m);
    const has_more = r.rows.length > limit;
    return {
      items: page.map((row) => view(row, snaps)),
      has_more,
      next_cursor: has_more ? Buffer.from(page.at(-1)!.cursor).toString("base64url") : null,
    };
  });
}

interface AuditRow {
  action: string;
  after: { status?: string; changes?: Array<{ ref: string; now_ref: string | null }>; sqlstate?: string } | null;
  actor: { kind: string; id: string; role: string };
  decision_id: string | null;
  created_at: Date;
}

export async function getDraft(pools: Pools, m: Member, id: string) {
  if (!UUID.test(id)) throw new ApiError("not_found");
  return withContext(pools.core, contextOf(m), async (c) => {
    const r = await c.query<DraftRow>(`${SELECT} WHERE r.id = $1`, [id]);
    const row = r.rows[0];
    if (!row) throw new ApiError("not_found");
    const audits = (await c.query<AuditRow>(
      `SELECT action, after, actor, decision_id, created_at FROM core.audit_log
        WHERE entity = 'core.draft' AND entity_id = $1 ORDER BY seq`, [id])).rows;
    const changeRefs = audits.flatMap((a) => (a.after?.changes ?? []).flatMap((ch) => [ch.ref, ch.now_ref ?? ""]));
    const snaps = await snapshotsFor(c, [row], m, changeRefs.map((x) => snapIdOf(x) ?? ""));
    const cell = (ref: string | null) => (ref ? (cellOf(ref, snaps)?.value ?? null) : null);
    const v = view(row, snaps);
    const history: Array<Record<string, unknown>> = [{ event: "proposed", at: row.created_at.toISOString(), by: row.source }];
    if (v.decision) history.push({ event: v.decision.verdict, at: v.decision.decided_at, by: v.decision.decided_by, reason: v.decision.reason });
    for (const a of audits) {
      if (a.after?.status === "rejected") continue; // the decision entry above already says it
      history.push({
        event: a.after?.status ?? a.action,
        at: a.created_at.toISOString(),
        by: { member_id: a.actor.id, role: a.actor.role },
        decision_id: a.decision_id,
        ...(a.after?.changes ? {
          // What changed (D-stale): each value beside the ref it comes from; null where it no longer resolves.
          changes: a.after.changes.map((ch) => ({ ref: ch.ref, value: cell(ch.ref), now_ref: ch.now_ref, now: cell(ch.now_ref) })),
        } : {}),
        ...(a.after?.sqlstate ? { sqlstate: a.after.sqlstate } : {}),
      });
    }
    return { ...v, history };
  });
}
