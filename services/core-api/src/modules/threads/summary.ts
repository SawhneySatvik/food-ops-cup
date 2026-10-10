// The bounded thread context (F9; 04 §12.2; ADR-014 §6.2, §6.4 / review B1). No LLM summarises: the rolling summary is
// the last ≤ 8 validated, cited segments of the thread's answered, UNTAINTED turns (ids and refs only, oldest first),
// recomputed from the turns on every ask. A tainted turn's segments never enter it — not while the turn is in the
// last 3 (where `tainted` already says so) and not after it ages out (where nothing else would). 0020's trigger
// refuses a summary citing a tainted turn as a second line (23514).
// The run-frame block (b-40 serves it; T-088b reads it): summary refs + the last ≤ 3 turn ids + `tainted` = OR of
// those turns.
import type { Queryable } from "../../runtoken/index.ts";

export const SUMMARY_MAX = 8;
export const LAST_TURNS = 3;

export interface SummaryRef { turn_no: number; answer_id: string; segment: number; refs: string[] }
export interface SummaryTurn {
  turn_no: number;
  answer_id: string | null;
  tainted: boolean;
  envelope: { abstained?: boolean; segments?: Array<{ refs?: string[] }> } | null;
}
export interface ThreadBlock { thread_id: string; summary_refs: SummaryRef[]; last_turn_ids: string[]; tainted: boolean }

/** Pure: the summary of `turns` (any order). */
export function buildSummary(turns: SummaryTurn[]): SummaryRef[] {
  const out: SummaryRef[] = [];
  for (const t of [...turns].sort((a, b) => b.turn_no - a.turn_no)) {
    if (t.tainted || !t.answer_id || !t.envelope || t.envelope.abstained) continue;
    const segs = (t.envelope.segments ?? []).map((s, i) => ({ turn_no: t.turn_no, answer_id: t.answer_id!, segment: i, refs: s.refs ?? [] }));
    for (const s of segs.reverse()) {
      if (out.length === SUMMARY_MAX) break;
      if (s.refs.length > 0) out.push(s);
    }
    if (out.length === SUMMARY_MAX) break;
  }
  return out.reverse();
}

/** Recomputes and stores the thread's summary (munim_core, in the ask's transaction). */
export async function refreshSummary(c: Queryable, threadId: string): Promise<SummaryRef[]> {
  const r = await c.query<SummaryTurn>(
    `SELECT t.turn_no, t.answer_id, t.tainted, a.envelope
       FROM core.ai_thread_turn t LEFT JOIN intel.answer a ON a.tenant_id = t.tenant_id AND a.id = t.answer_id
      WHERE t.thread_id = $1`, [threadId]);
  const summary = buildSummary(r.rows);
  await c.query(`UPDATE core.ai_thread SET summary = $2 WHERE id = $1`, [threadId, JSON.stringify(summary)]);
  return summary;
}

/** The run-frame thread block, under the caller's RLS; null when the thread is not visible. */
export async function threadBlock(c: Queryable, threadId: string): Promise<ThreadBlock | null> {
  const t = await c.query<{ summary: SummaryRef[] }>(`SELECT summary FROM core.ai_thread WHERE id = $1`, [threadId]);
  if (!t.rows[0]) return null;
  const last = await c.query<{ id: string; tainted: boolean }>(
    `SELECT id, tainted FROM core.ai_thread_turn WHERE thread_id = $1 ORDER BY turn_no DESC LIMIT ${LAST_TURNS}`, [threadId]);
  return {
    thread_id: threadId,
    summary_refs: t.rows[0].summary,
    last_turn_ids: last.rows.map((x) => x.id).reverse(),
    tainted: last.rows.some((x) => x.tainted),
  };
}
