// The internal API's writes other than drafts (03-architecture §1.7–§1.8; R25). Each runs on the run's munim_svc
// transaction and writes only operational rows (intel.*, evidence.snapshot) — munim_svc holds no book grant (R26–R29).
// Validation is core's (04 §4): a finding or answer that fails it is STORED as an abstention — the envelope kept is
// `{segments: [], abstained: true, reason_code}`, never the rejected prose — and the shown text is composed from
// i18n by code.
import { FindingsRequest, AnswersRequest, EventsClaimRequest, TracesBatchRequest, WatchClaimRequest } from "@munim/contracts/internal";
import { parseRef, type ReasonCode } from "@munim/contracts";
import { SPECIALIST_REGISTRY } from "@munim/contracts/intel";
import { validateFinding, validateSegments } from "@munim/core-domain/envelope";
import { ApiError } from "../lib/errors.ts";
import type { Queryable } from "../runtoken/index.ts";
import type { Run } from "./auth.ts";
import { dbResolver } from "./resolver.ts";

const MEMBER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function parse<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, raw: unknown): T {
  const r = schema.safeParse(raw);
  if (!r.success) throw new ApiError("invalid_payload");
  return r.data;
}

/** events:claim — durable dedupe: the first claim of an event id wins; any later one is 409 (intel acks and stops). */
export async function claimEvent(c: Queryable, run: Run, raw: unknown) {
  const { event_id } = parse(EventsClaimRequest, raw);
  const r = await c.query<{ claimed_at: Date }>(
    `INSERT INTO intel.event_claim (tenant_id, event_id, run_id) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, event_id) DO NOTHING RETURNING claimed_at`,
    [run.tenantId, event_id, run.runId]);
  if (!r.rows[0]) throw new ApiError("conflict");
  return { event_id, claimed_at: r.rows[0].claimed_at.toISOString() };
}

/** watch:claim — leading-edge debounce per pack: `go` only when the pack's last run is older than the window. One
 *  conditional upsert, so of two concurrent claims exactly one goes. */
export async function claimWatch(c: Queryable, run: Run, raw: unknown, windowMs: number) {
  const { pack } = parse(WatchClaimRequest, raw);
  if (!/^[a-z][a-z0-9_]*$/.test(pack)) throw new ApiError("invalid_payload");
  const r = await c.query<{ prev: Date | null; go: boolean }>(
    `WITH prev AS (SELECT last_run_at FROM intel.watch_state WHERE tenant_id = $1 AND pack = $2),
          up AS (INSERT INTO intel.watch_state (tenant_id, pack, last_run_at, last_run_id) VALUES ($1, $2, now(), $3)
                 ON CONFLICT (tenant_id, pack) DO UPDATE SET last_run_at = excluded.last_run_at, last_run_id = excluded.last_run_id
                 WHERE intel.watch_state.last_run_at <= now() - make_interval(secs => $4::float8 / 1000)
                 RETURNING 1)
     SELECT (SELECT last_run_at FROM prev) AS prev, EXISTS (SELECT 1 FROM up) AS go`,
    [run.tenantId, pack, run.runId, windowMs]);
  const row = r.rows[0]!;
  return { pack, go: row.go, last_run_at: row.prev?.toISOString() ?? null };
}

const FINDING_TYPE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

/** findings — validated, or stored as an abstention. Merges into the open finding of the same dedupe_key (one open
 *  per key, 0012); a failed re-detection never overwrites a valid open finding. Outlets = the run's scope; for a
 *  tenant-wide run, the outlets of the impact snapshot (T-043 note a: one minted for one outlet), else tenant-wide. */
export async function writeFinding(c: Queryable, run: Run, raw: unknown) {
  const req = parse(FindingsRequest, raw);
  // F8: a finding is stamped with a registered specialist (its pack); the type has the DB's dotted form.
  if (!FINDING_TYPE.test(req.type) || !SPECIALIST_REGISTRY.specialists.some((x) => x.id === req.pack && x.kind === "specialist")) throw new ApiError("invalid_payload");
  const id = req.envelope.finding_id;
  const prior = await c.query<{ envelope: { abstained?: boolean; reason_code?: ReasonCode } }>(`SELECT envelope FROM intel.finding WHERE id = $1`, [id]);
  if (prior.rows[0]) {
    const e = prior.rows[0].envelope;
    return { finding_id: id, outcome: e.abstained ? "abstained" : "stored", reason_code: e.abstained ? (e.reason_code ?? null) : null };
  }
  const v = req.envelope.abstained
    ? { ok: false as const, reason_code: req.envelope.reason_code! }
    : await validateFinding(req.envelope, dbResolver(c, run.scope));
  const reason = v.ok ? null : v.reason_code;
  await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('intel.finding:' || $1 || ':' || $2, 0))`, [run.tenantId, req.dedupe_key]);
  const open = await c.query<{ id: string }>(`SELECT id FROM intel.finding WHERE dedupe_key = $1 AND status = 'open'`, [req.dedupe_key]);
  const into = open.rows[0]?.id ?? id;
  const envelope = reason
    ? { finding_id: into, segments: [], impact_ref: null, abstained: true, reason_code: reason }
    : { ...req.envelope, finding_id: into };
  const impact = reason ? null : (parseRef(req.envelope.impact_ref!) as { snapshot_id: string; row: number; column: string });
  if (open.rows[0]) {
    if (reason) return { finding_id: into, outcome: "abstained", reason_code: reason };
    await c.query(
      `UPDATE intel.finding SET severity = $2, confidence_bp = $3, envelope = $4, impact_snapshot_id = $5, impact_row = $6, impact_column = $7 WHERE id = $1`,
      [into, req.severity, req.confidence_bp, envelope, impact!.snapshot_id, impact!.row, impact!.column]);
    return { finding_id: into, outcome: "merged", reason_code: null };
  }
  let outlets = run.scope[0] === "*" ? [] : run.scope;
  if (run.scope[0] === "*" && impact) {
    const s = await c.query<{ outlet_scope: string[] }>(`SELECT outlet_scope::text[] AS outlet_scope FROM evidence.snapshot WHERE id = $1`, [impact.snapshot_id]);
    const scope = s.rows[0]?.outlet_scope ?? ["*"];
    if (!scope.includes("*")) outlets = scope;
  }
  // T-114: a detection about one outlet whose impact snapshot is tenant-wide (its template takes no outlet param) names
  // that outlet; core takes it only as the impact row's own `outlet_id` cell. That keeps it inside the run's scope: the
  // impact cell resolved for this run above, so its snapshot's rows are the run's outlets'.
  if (req.outlet_ids && impact) {
    const o = req.outlet_ids[0]!;
    const cell = await c.query<{ v: string | null }>(`SELECT rows -> $2::int ->> 'outlet_id' AS v FROM evidence.snapshot WHERE id = $1`, [impact.snapshot_id, impact.row]);
    if (cell.rows[0]?.v !== o) throw new ApiError("invalid_payload");
    outlets = [o];
  }
  try {
    await c.query(
      `INSERT INTO intel.finding (tenant_id, id, run_id, outlet_ids, pack, type, severity, impact_snapshot_id, impact_row, impact_column, confidence_bp, envelope, dedupe_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [run.tenantId, id, run.runId, outlets, req.pack, req.type, req.severity,
       impact?.snapshot_id ?? null, impact?.row ?? null, impact?.column ?? null, req.confidence_bp, envelope, req.dedupe_key]);
  } catch (e) {
    // The id, or the open finding of this key, belongs to an outlet this run cannot see.
    if ((e as { code?: unknown }).code === "23505") throw new ApiError("conflict");
    throw e;
  }
  return { finding_id: id, outcome: reason ? "abstained" : "stored", reason_code: reason };
}

/** answers — validated (grammar, ≥ 1 ref per segment, refs resolve), or stored as an abstention. */
export async function writeAnswer(c: Queryable, run: Run, raw: unknown) {
  const { question, envelope: env } = parse(AnswersRequest, raw);
  const prior = await c.query<{ abstained: boolean; reason_code: ReasonCode | null }>(`SELECT abstained, reason_code FROM intel.answer WHERE id = $1`, [env.answer_id]);
  if (prior.rows[0]) return { answer_id: env.answer_id, abstained: prior.rows[0].abstained, reason_code: prior.rows[0].reason_code };
  const v = env.abstained
    ? { ok: false as const, reason_code: env.reason_code! }
    : env.segments.length === 0 ? { ok: false as const, reason_code: "missing_ref" as const } : await validateSegments(env.segments, dbResolver(c, run.scope));
  const reason = v.ok ? null : v.reason_code;
  // An abstention keeps the answer's one-tap follow-up (R47 D5): "dig deeper" is still on offer when the single-agent answer could not verify.
  const stored = reason ? { answer_id: env.answer_id, segments: [], abstained: true, reason_code: reason, ...(env.follow_up ? { follow_up: env.follow_up } : {}) } : env;
  await c.query(
    `INSERT INTO intel.answer (tenant_id, id, run_id, question, asked_by, envelope, abstained, reason_code) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [run.tenantId, env.answer_id, run.runId, question, MEMBER_ID.test(run.actor) ? run.actor : null, stored, reason !== null, reason]);
  return { answer_id: env.answer_id, abstained: reason !== null, reason_code: reason };
}

/** traces:batch — appended in seq order after the run's last seq (gapless, MB014 → 409). Idempotent by seq: an
 *  event already stored under the same seq and id is skipped (a flush retried after a lost response); the same seq
 *  with another id is a conflict. Run and tenant come from the token, never from the events. */
export async function writeTraces(c: Queryable, run: Run, raw: unknown) {
  const { events } = parse(TracesBatchRequest, raw);
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('intel.trace:' || $1 || ':' || $2, 0))`, [run.tenantId, run.runId]);
  const stored = await c.query<{ seq: number; id: string }>(
    `SELECT seq, id FROM intel.trace_event WHERE run_id = $1 AND seq = ANY ($2::int[])`, [run.runId, sorted.map((e) => e.seq)]);
  const have = new Map(stored.rows.map((r) => [r.seq, r.id]));
  if (sorted.some((e) => have.has(e.seq) && have.get(e.seq) !== e.id)) throw new ApiError("conflict");
  const fresh = sorted.filter((e) => !have.has(e.seq));
  if (fresh.length) {
    await c.query(
      `INSERT INTO intel.trace_event (tenant_id, run_id, seq, id, parent_id, kind, actor, payload, at)
       SELECT $1, $2, e.seq, e.id, e.parent_id, e.kind, e.actor, e.payload, e.at
         FROM jsonb_to_recordset($3::jsonb) AS e(seq int, id uuid, parent_id uuid, kind text, actor text, payload jsonb, at timestamptz)
        ORDER BY e.seq`,
      [run.tenantId, run.runId, JSON.stringify(fresh)]);
  }
  const last = await c.query<{ n: number }>(`SELECT coalesce(max(seq), 0) AS n FROM intel.trace_event WHERE run_id = $1`, [run.runId]);
  return { inserted: fresh.length, last_seq: last.rows[0]!.n };
}
