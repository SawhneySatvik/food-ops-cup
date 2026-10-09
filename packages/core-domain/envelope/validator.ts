// Cite-or-abstain validator (04-agent-framework §4 checks 1–5) against a RefResolver port. Syntax and
// grammar run here; whether a ref exists in the run's tenant is the resolver's answer (core-api implements
// it over the database, closed over the run token's tenant — the tenant is never an argument here).
// The verdict carries a reason code and, for a well-formed ref, that ref; never raw model text (a
// malformed token is reported with ref = null).
import { anyRefTokens, parseRef, type ParsedRef, type ReasonCode } from "@munim/contracts";
import { checkGrammar } from "./grammar.ts";

export type Resolution =
  /** `text_length`: length of the source text, for document / message spans. */
  | { status: "ok"; text_length?: number }
  | { status: "missing" }
  | { status: "other_tenant" };

export interface RefResolver {
  resolve(ref: ParsedRef): Promise<Resolution>;
}

export type Verdict = { ok: true } | { ok: false; abstained: true; reason_code: ReasonCode; ref: string | null };

const OK: Verdict = { ok: true };
const abstain = (reason_code: ReasonCode, ref: string | null): Verdict => ({ ok: false, abstained: true, reason_code, ref });
const bareId = (p: ParsedRef) => (p.kind === "snap" ? `snap:${p.snapshot_id}` : `${p.kind}:${p.id}`);
// Any ref delimiter in a payload string: the string must be exactly one well-formed ref (a ref buried
// in other text would escape resolution). Plain digits in strings (barcodes, notes) are not checked here.
const REF_DELIM = /[⟨⟩]/u;

async function resolveRef(token: string, ref: ParsedRef, resolver: RefResolver): Promise<Verdict> {
  const r = await resolver.resolve(ref);
  if (r.status === "missing") return abstain("unresolved_ref", token);
  if (r.status === "other_tenant") return abstain("cross_tenant_ref", token);
  if (ref.kind !== "snap" && ref.span) {
    const [start, end] = ref.span;
    if (r.text_length === undefined || start >= end || end > r.text_length) return abstain("quote_mismatch", token);
  }
  return OK;
}

/** Checks 1–4 over prose segments: grammar, ≥ 1 ref per segment, every ref declared in `refs[]`, every
 *  ref resolves in-tenant (snapshot row/column, cite id, quotation span). */
export async function validateSegments(segments: ReadonlyArray<{ text: string; refs: readonly string[] }>, resolver: RefResolver): Promise<Verdict> {
  const toResolve: Array<[string, ParsedRef]> = [];
  for (const seg of segments) {
    const g = checkGrammar(seg.text);
    if (!g.ok) return g.rule === "malformed_ref" ? abstain("unresolved_ref", null) : abstain("number_grammar", null);
    const tokens = [...seg.text.normalize("NFC").matchAll(anyRefTokens())].map((m) => m[0]);
    if (tokens.length === 0) return abstain("missing_ref", null);
    for (const t of tokens) {
      const p = parseRef(t)!;
      if (!seg.refs.includes(bareId(p))) return abstain("unresolved_ref", t);
      toResolve.push([t, p]);
    }
  }
  for (const [t, p] of toResolve) {
    const v = await resolveRef(t, p, resolver);
    if (!v.ok) return v;
  }
  return OK;
}

async function snapCell(token: string, resolver: RefResolver): Promise<Verdict> {
  const p = parseRef(token);
  if (!p || p.kind !== "snap") return abstain("unresolved_ref", p ? token : null);
  return resolveRef(token, p, resolver);
}

/** Check 5 (findings): prose as above, and `impact_ref` is a snapshot cell that resolves. */
export async function validateFinding(f: { segments: ReadonlyArray<{ text: string; refs: readonly string[] }>; impact_ref: string | null }, resolver: RefResolver): Promise<Verdict> {
  const v = await validateSegments(f.segments, resolver);
  if (!v.ok) return v;
  if (f.impact_ref === null) return abstain("missing_ref", null);
  return snapCell(f.impact_ref, resolver);
}

/** Check 5 (drafts): no numeric leaf in the payload (every number is a ref, R26), every payload ref
 *  resolves, and every `based_on` entry is a resolving snapshot cell. */
export async function validateDraft(d: { payload: unknown; based_on: readonly string[] }, resolver: RefResolver): Promise<Verdict> {
  const refs: string[] = [];
  const walk = (v: unknown): Verdict => {
    if (typeof v === "number" || typeof v === "bigint") return abstain("missing_ref", null);
    if (typeof v === "string" && REF_DELIM.test(v)) {
      if (!parseRef(v)) return abstain("unresolved_ref", null);
      refs.push(v);
    }
    if (Array.isArray(v)) for (const x of v) { const r = walk(x); if (!r.ok) return r; }
    else if (v !== null && typeof v === "object") for (const x of Object.values(v)) { const r = walk(x); if (!r.ok) return r; }
    return OK;
  };
  const shape = walk(d.payload);
  if (!shape.ok) return shape;
  for (const t of refs) {
    const v = await resolveRef(t, parseRef(t)!, resolver);
    if (!v.ok) return v;
  }
  for (const t of d.based_on) {
    const v = await snapCell(t, resolver);
    if (!v.ok) return v;
  }
  return OK;
}
