// Lineage reads (ADR-014 §2.3). Everything is read through the caller's own RLS context: a hop the viewer cannot see
// is null, never an error that names it. Audit entries are joined by (entity, entity_id) and `decision_id`; a row's
// `origin` is never read (gotcha 34). Only ids, statuses, codes and refs leave here: audit before/after is read for
// `status`, `reason_code`, `changes[].ref/now_ref` and `sqlstate` alone, so no amount is echoed (R25).
import { parseRef } from "@munim/contracts";
import type { Queryable } from "../../runtoken/index.ts";
import { loadSnapshots, type Member, resolvedRefs } from "../approvals/index.ts";

interface AuditRow {
  seq: string;
  action: string;
  entity: string;
  entity_id: string;
  actor: { kind?: string; id?: string; role?: string };
  decision_id: string | null;
  created_at: Date;
  after: { status?: string; reason_code?: string; changes?: Array<{ ref: string; now_ref: string | null }>; sqlstate?: string } | null;
}

const AUDIT_COLS = `seq::text, action, entity, entity_id, actor, decision_id, created_at, after`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const auditHop = (a: AuditRow) => ({
  seq: Number(a.seq), action: a.action, entity: a.entity, entity_id: a.entity_id, at: a.created_at.toISOString(),
  actor: { member_id: a.actor.kind === "member" && a.actor.id && UUID.test(a.actor.id) ? a.actor.id : null, kind: a.actor.kind ?? "unknown", role: a.actor.role ?? "unknown" },
  decision_id: a.decision_id,
});

export type Chain = Awaited<ReturnType<typeof chainOf>>;

/** The chain above one audit entry (row lineage) or above one draft (draft lineage). */
export async function chainOf(c: Queryable, m: Member, audit: AuditRow | null, draftId: string | null) {
  let decisionId = audit?.decision_id ?? null;
  let decision: { id: string; draft_id: string; verdict: string; reason: string | null; decided_by: string; name: string | null; decided_at: Date } | undefined;
  if (decisionId || draftId) {
    decision = (await c.query<NonNullable<typeof decision>>(
      `SELECT d.id, d.draft_id, d.verdict, d.reason, d.decided_by, mb.name, d.decided_at
         FROM core.decision d
         -- core.decision's RLS is tenant-wide: joining the draft lets the draft's outlet scope gate the verdict and its note.
         JOIN core.draft dr ON dr.tenant_id = d.tenant_id AND dr.id = d.draft_id
         LEFT JOIN core.member mb ON mb.tenant_id = d.tenant_id AND mb.id = d.decided_by
        WHERE ($1::uuid IS NOT NULL AND d.id = $1) OR ($2::uuid IS NOT NULL AND d.draft_id = $2)`, [decisionId, draftId])).rows[0];
    decisionId = decision?.id ?? decisionId;
  }
  const dId = draftId ?? decision?.draft_id ?? null;
  const draft = dId ? (await c.query<{
    id: string; command_type: string; source: string; outlet_ids: string[]; created_at: Date; status: string; finding_id: string | null;
    run_id: string | null; command_payload: unknown; based_on: unknown[]; failure_reason: string | null;
  }>(`SELECT id, command_type, source, outlet_ids, created_at, status, finding_id, run_id, command_payload, based_on, failure_reason
        FROM core.draft WHERE id = $1`, [dId])).rows[0] : undefined;
  const dAudits = draft ? (await c.query<AuditRow>(
    `SELECT ${AUDIT_COLS} FROM core.audit_log WHERE entity = 'core.draft' AND entity_id = $1 ORDER BY seq`, [draft.id])).rows : [];
  const finding = draft?.finding_id ? (await c.query<{ id: string; run_id: string; pack: string; type: string; status: string; created_at: Date }>(
    `SELECT id, run_id, pack, type, status, created_at FROM intel.finding WHERE id = $1`, [draft.finding_id])).rows[0] : undefined;
  const runId = draft?.run_id ?? finding?.run_id ?? null;
  const run = runId ? (await c.query<{ id: string; trigger: string; actor: string; issued_at: Date }>(
    `SELECT id, trigger, actor, issued_at FROM intel.run WHERE id = $1`, [runId])).rows[0] : undefined;

  // Snapshots the draft cites (based_on + payload refs), through the viewer's own opening rights (R40 C4).
  const refs = draft ? [...new Set([
    ...draft.based_on.map((e) => (typeof e === "string" ? e : (e as { ref?: unknown } | null)?.ref)).filter((r): r is string => typeof r === "string"),
    ...resolvedRefs(draft.command_payload, new Map()).unresolved, // with no snapshots loaded, every ref in the payload

  ])].filter((r) => parseRef(r)?.kind === "snap") : [];
  const bySnap = new Map<string, string[]>();
  for (const r of refs) {
    const id = (parseRef(r) as { snapshot_id: string }).snapshot_id;
    bySnap.set(id, [...(bySnap.get(id) ?? []), r]);
  }
  const opened = await loadSnapshots(c, bySnap.keys(), m);
  const snapshots = [...bySnap].flatMap(([id, rs]) => {
    const s = opened.get(id);
    return s ? [{ snapshot_id: id, template_id: s.template_id, template_version: s.template_version, refs: rs }] : [];
  });
  const unverified = refs.filter((r) => !opened.has((parseRef(r) as { snapshot_id: string }).snapshot_id));

  // The terminal audit entry of the draft's own life (executed / stale / failed), and a rejection's reason code.
  const last = (...s: string[]) => dAudits.filter((a) => a.after?.status && s.includes(a.after.status)).at(-1);
  const stale = last("stale");
  const failed = last("failed");
  const rejected = last("rejected");
  const terminal = last("executed", "failed", "stale");
  return {
    chain: {
      audit: audit ? auditHop(audit) : terminal ? auditHop(terminal) : null,
      decision: decision ? {
        decision_id: decision.id, verdict: decision.verdict, reason: decision.reason, reason_code: rejected?.after?.reason_code ?? null,
        decided_by: { member_id: decision.decided_by, name: decision.name }, decided_at: decision.decided_at.toISOString(),
      } : null,
      draft: draft ? {
        draft_id: draft.id, command_type: draft.command_type, source: draft.source, outlet_ids: draft.outlet_ids, created_at: draft.created_at.toISOString(),
        outcome: {
          status: draft.status,
          reason: decision?.verdict === "rejected" ? decision.reason : null,
          reason_code: rejected?.after?.reason_code ?? null,
          changes: (stale?.after?.changes ?? []).map((ch) => ({ ref: ch.ref, now_ref: ch.now_ref })),
          sqlstate: failed?.after?.sqlstate ?? null,
          failure_reason: draft.failure_reason,
        },
      } : null,
      finding: finding ? { finding_id: finding.id, pack: finding.pack, type: finding.type, status: finding.status, created_at: finding.created_at.toISOString() } : null,
      run: run ? { run_id: run.id, trigger: run.trigger, actor: run.actor, issued_at: run.issued_at.toISOString() } : null,
      snapshots,
      unverified_refs: unverified,
    },
    decisionId,
  };
}

const TABLE = /^(core|intel)\.([a-z][a-z0-9_]*)$/;

/** Which of `ids` in `table` ('<schema>.<table>') the caller's own RLS shows. audit_log is tenant-wide, so a row's
 *  visibility is asked of its own table. A table the role cannot read, or with no uuid `id` column, shows none. */
export async function visibleIds(c: Queryable, table: string, ids: readonly string[]): Promise<Set<string>> {
  const t = TABLE.exec(table);
  if (!t) return new Set();
  const [, schema, name] = t as unknown as [string, string, string];
  const hasId = await c.query(
    `SELECT 1 FROM pg_attribute WHERE attrelid = to_regclass(format('%I.%I', $1::text, $2::text)) AND attname = 'id' AND atttypid = 'uuid'::regtype AND NOT attisdropped`,
    [schema, name]);
  if (hasId.rowCount !== 1) return new Set();
  await c.query("SAVEPOINT lineage_row");
  try {
    return new Set((await c.query<{ id: string }>(`SELECT id::text AS id FROM "${schema}"."${name}" WHERE id = ANY ($1::uuid[])`, [ids])).rows.map((r) => r.id));
  } catch {
    await c.query("ROLLBACK TO SAVEPOINT lineage_row");
    return new Set();
  }
}

/** The rows a decision touched, each only if the caller's RLS shows it (R-A 7: never another outlet's row id). */
export async function touchedBy(c: Queryable, decisionId: string) {
  const r = await c.query<AuditRow>(
    `SELECT ${AUDIT_COLS} FROM core.audit_log WHERE decision_id = $1 AND entity <> 'core.draft' ORDER BY seq`, [decisionId]);
  const shown = new Map<string, Set<string>>();
  for (const table of new Set(r.rows.map((a) => a.entity))) {
    shown.set(table, await visibleIds(c, table, r.rows.filter((a) => a.entity === table).map((a) => a.entity_id)));
  }
  return r.rows.filter((a) => shown.get(a.entity)!.has(a.entity_id))
    .map((a) => ({ table: a.entity, id: a.entity_id, action: a.action, seq: Number(a.seq) }));
}

export async function auditOf(c: Queryable, entity: string, id: string): Promise<AuditRow[]> {
  return (await c.query<AuditRow>(`SELECT ${AUDIT_COLS} FROM core.audit_log WHERE entity = $1 AND entity_id = $2 ORDER BY seq`, [entity, id])).rows;
}
