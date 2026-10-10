// Finding views (contracts intel `v1.finding`): the stored, core-validated envelope and every ref in it with the
// value core resolves for THIS viewer (R26) — a snapshot cell the member may open (role + outlet scope, R40 C4) or
// a quoted message / claim span read from its source. A ref that does not resolve for the viewer is left out, so
// the renderer shows "cannot verify" for it. Nothing here is model text except the validated envelope itself.
import { anyRefTokens, parseRef } from "@munim/contracts";
import type { Queryable } from "../../runtoken/index.ts";
import { type Cell, cellOf, loadSnapshots, type Member } from "../approvals/index.ts";

export interface FindingRow {
  id: string;
  run_id: string;
  pack: string;
  type: string;
  severity: string;
  status: string;
  confidence_bp: number;
  dedupe_key: string;
  envelope: { segments?: Array<{ text: string }>; impact_ref?: string | null };
  created_at: Date;
  updated_at: Date;
}

export const FINDING_COLUMNS = `f.id, f.run_id, f.pack, f.type, f.severity, f.status, f.confidence_bp, f.dedupe_key, f.envelope, f.created_at, f.updated_at`;

function refsOf(f: FindingRow): string[] {
  const out = (f.envelope.segments ?? []).flatMap((s) => [...s.text.normalize("NFC").matchAll(anyRefTokens())].map((m) => m[0]));
  if (f.envelope.impact_ref) out.push(f.envelope.impact_ref);
  return [...new Set(out)].filter((r) => parseRef(r) !== null);
}

/** Quoted spans of `msg` / `claim` cites, from the source text (the model never types a quotation). */
async function spans(c: Queryable, refs: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const want = refs.map((r) => [r, parseRef(r)!] as const).filter(([, p]) => (p.kind === "msg" || p.kind === "claim") && "span" in p && p.span);
  if (want.length === 0) return out;
  const ids = want.map(([, p]) => (p as { id: string }).id);
  const r = await c.query<{ id: string; text: string }>(
    `SELECT id::text, body AS text FROM core.message WHERE id = ANY ($1::uuid[])
     UNION ALL SELECT id::text, quote FROM intel.claim WHERE id = ANY ($1::uuid[])`, [ids]);
  const text = new Map(r.rows.map((x) => [x.id, x.text]));
  for (const [ref, p] of want) {
    const src = text.get((p as { id: string }).id);
    const [a, b] = (p as { span: [number, number] }).span;
    if (src !== undefined && a < b && b <= src.length) out.set(ref, src.slice(a, b));
  }
  return out;
}

export async function findingViews(c: Queryable, rows: FindingRow[], m: Member) {
  const refs = rows.map(refsOf);
  const snapIds = refs.flat().map((r) => parseRef(r)!).flatMap((p) => (p.kind === "snap" ? [p.snapshot_id] : []));
  const snaps = await loadSnapshots(c, snapIds, m);
  const quoted = await spans(c, refs.flat());
  return rows.map((f, i) => {
    const resolved: Array<{ ref: string; value: Cell }> = [];
    for (const ref of refs[i]!) {
      const cell = cellOf(ref, snaps);
      if (cell) resolved.push({ ref, value: cell.value });
      else if (quoted.has(ref)) resolved.push({ ref, value: quoted.get(ref)! });
    }
    return {
      finding_id: f.id, run_id: f.run_id, pack: f.pack, type: f.type, severity: f.severity, status: f.status,
      confidence_bp: f.confidence_bp, dedupe_key: f.dedupe_key, envelope: f.envelope, resolved_refs: resolved,
      created_at: f.created_at.toISOString(), updated_at: f.updated_at.toISOString(),
    };
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `(updated_at, id)` keyset cursor, as the drafts list (base64url of "<iso>|<uuid>"). */
export function parseCursor(cursor: string | undefined): [string, string] | null {
  if (cursor === undefined) return null;
  const [at, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  if (!at || !id || !UUID.test(id) || Number.isNaN(Date.parse(at))) return null;
  return [at, id];
}
/** SQL for the cursor text of row alias `t` (microseconds, so the keyset never skips a row). */
export const CURSOR_SQL = (t: string) => `to_char(${t}.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || ${t}.id`;
export const makeCursor = (raw: string) => Buffer.from(raw).toString("base64url");

export function parseLimit(limit: string | undefined): number | null {
  const n = limit === undefined ? 50 : Number(limit);
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : null;
}
