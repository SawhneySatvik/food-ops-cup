// Inbox / brief ranking (T-054, 04 §5): deterministic, no model. score = |impact_minor| × confidence_bp × urgency_bp,
// where urgency_bp = the severity's weight + 500 per day open (capped at 14 days). Integer arithmetic only (BigInt),
// so the order never depends on float rounding. `now` is passed in, never read from the wall clock.
//   dedupe:  one item per `dedupe_key` (the highest score wins; a tie goes to the newest update).
//   drafts:  attached to their finding's item; a draft with no open finding is its own item, ranked after every finding.
//   source:  every item carries its specialist (F8): `finding.pack`, or the `intel:<pack>` of a draft-only item.
// Impact is the value of the finding's impact snapshot cell, resolved by the caller from a cell the viewer may open (R26);
// nothing here types a number. A finding with no resolvable impact scores 0 and sorts after every money finding.

export type Severity = "low" | "medium" | "high" | "critical";

export const SEVERITY_BP: Record<Severity, number> = { low: 10_000, medium: 15_000, high: 20_000, critical: 30_000 };
export const AGE_BP_PER_DAY = 500;
export const AGE_CAP_DAYS = 14;
const DAY_MS = 86_400_000;

export interface FindingIn {
  id: string;
  pack: string;
  severity: Severity;
  confidence_bp: number;
  dedupe_key: string;
  /** Resolved impact cell in minor units / quantity; null when the cell does not resolve for this viewer. */
  impact: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface DraftIn {
  id: string;
  finding_id: string | null;
  /** `intel:<pack>` for an agent draft. */
  source: string;
  created_at: Date;
}

export interface RankedItem {
  finding: FindingIn | null;
  drafts: DraftIn[];
  specialist: string | null;
  score: bigint;
}

export function urgencyBp(severity: Severity, createdAt: Date, now: Date): number {
  const days = Math.min(AGE_CAP_DAYS, Math.max(0, Math.floor((now.getTime() - createdAt.getTime()) / DAY_MS)));
  return SEVERITY_BP[severity] + AGE_BP_PER_DAY * days;
}

export function scoreOf(f: FindingIn, now: Date): bigint {
  if (f.impact === null) return 0n;
  return BigInt(Math.abs(f.impact)) * BigInt(f.confidence_bp) * BigInt(urgencyBp(f.severity, f.created_at, now));
}

const SEV_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** Highest score first; then severity, then the older finding, then id — a total order, so the result is reproducible. */
function byRank(a: { f: FindingIn; score: bigint }, b: { f: FindingIn; score: bigint }): number {
  if (a.score !== b.score) return a.score > b.score ? -1 : 1;
  if (a.f.severity !== b.f.severity) return SEV_RANK[b.f.severity] - SEV_RANK[a.f.severity];
  if (a.f.created_at.getTime() !== b.f.created_at.getTime()) return a.f.created_at.getTime() - b.f.created_at.getTime();
  return a.f.id < b.f.id ? -1 : a.f.id > b.f.id ? 1 : 0;
}

const specialistOfSource = (source: string) => (source.startsWith("intel:") ? source.slice("intel:".length) : null);

export function rankInbox(findings: FindingIn[], drafts: DraftIn[], now: Date): RankedItem[] {
  const best = new Map<string, { f: FindingIn; score: bigint }>();
  for (const f of findings) {
    const cand = { f, score: scoreOf(f, now) };
    const cur = best.get(f.dedupe_key);
    if (!cur || cand.score > cur.score || (cand.score === cur.score && f.updated_at > cur.f.updated_at)) best.set(f.dedupe_key, cand);
  }
  const ranked = [...best.values()].sort(byRank);
  const keptIds = new Set(ranked.map((r) => r.f.id));
  // A draft of a finding that lost the dedupe goes with the finding that won it (same key).
  const keyOf = new Map(findings.map((f) => [f.id, f.dedupe_key]));
  const winnerOfKey = new Map(ranked.map((r) => [r.f.dedupe_key, r.f.id]));
  const attached = new Map<string, DraftIn[]>();
  const loose: DraftIn[] = [];
  for (const d of drafts) {
    const key = d.finding_id ? keyOf.get(d.finding_id) : undefined;
    const target = keptIds.has(d.finding_id ?? "") ? d.finding_id : key !== undefined ? winnerOfKey.get(key) : undefined;
    if (target) attached.set(target, [...(attached.get(target) ?? []), d]);
    else loose.push(d);
  }
  const items: RankedItem[] = ranked.map((r) => ({
    finding: r.f,
    drafts: (attached.get(r.f.id) ?? []).sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || (a.id < b.id ? -1 : 1)),
    specialist: r.f.pack,
    score: r.score,
  }));
  loose.sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || (a.id < b.id ? -1 : 1));
  for (const d of loose) items.push({ finding: null, drafts: [d], specialist: specialistOfSource(d.source), score: 0n });
  return items;
}
