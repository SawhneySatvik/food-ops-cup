// POST /internal/intel/v1/drafts (R16, R25, R26; ADR-014 §5.5, §14 C7). Intel proposes; core validates, dedupes
// and stores a `proposed` core.draft — it never executes anything (a named person approves, T-008). All in core, on
// the run's munim_svc transaction (tenant + outlet scope from the token):
//   1. Same draft_id + same body → the original response (byte-identical); same id + another body → 409.
//   0. The pack is a registered specialist that may propose this command type (F8, T-087a registry) — one of its
//      `draftables`, or one of its `workflow_draftables` (DECISIONS 11 Oct, W3.2: emitted by deterministic intel code,
//      never a model tool; contracts DraftsRequest lets such a draft cite no snapshot cell when every numeric leaf is a
//      document span or a quote row) — else 422.
//      Coupon drafts are no specialist's draftable (R-B S1-B, 11 Oct: coupon.set waits for pack §6's executable tightening), so
//      check 0 refuses them. Campaign drafts (R-B S1-D: an approved campaign must never reach customers outside the finding)
//      are the customers pack's workflow draftable since R67, admitted only by check 0d.
//  0d. R67 (founder, 16 Oct): a customers.campaign.create.v1 draft only on a demo business, with its audience the at-risk count
//      of the finding's own churn segment (lib/demo.ts, the one place) — else 422 `campaign_audience_unscoped`, nothing stored.
//  0b. A payroll draft outside the pack's `payroll_scope` → 422 `payroll_out_of_scope` (W3.2; nothing stored).
//  0c. A goals.task.create.v1 draft naming a Cares listing from any pack but people → 422 (ADR-015 §4; nothing stored).
//   2. The validator (04 §4 check 5): payload numbers are refs (the proposal schema refuses a bare number: 422),
//      every ref and every based_on cell resolves for this run → else `abstained` + reason, nothing stored.
//   2b. The number grammar over the payload's PROSE leaves (T-040b, T-080's finding): a model-typed string a person
//      reads on the draft — a supplier-return note, a maintenance vendor note, a campaign name — carries no free
//      digit, number word or quotation, exactly as answer prose (04 §4 check 2) → else `abstained` + `number_grammar`.
//      A prose leaf is a string the proposal schema leaves free: no pattern, format, enum or const (`proseLeafPaths`).
//      Every other string leaf is EXCEPTED, each fixed by its pattern: ids, refs, dates and times, currency and unit
//      codes, i18n keys, slugs, and short codes such as a coupon code (`^[A-Z0-9][A-Z0-9-]{2,31}$`, which may hold
//      digits: a code is an identifier, not a number shown as a fact). Beside it, by an explicit list (IDENTIFIER_LEAVES)
//      because the schema is also the member route's and stays free: a supplier invoice's `invoice_no` (DECISIONS 11 Oct,
//      W3.2) — the number printed on the supplier's page, an identifier a person matches, not a quantity; its
//      `lines[].description` stays prose and is checked. An identifier leaf is excepted only in its own shape (R-A 4:
//      letters, digits and / . _ -, no spaces, ≤ 40 characters); anything else is `number_grammar`, so prose cannot ride
//      in it. imports.* draftables are excepted as a whole: no specialist may propose them (step 0), so intel never
//      reaches this check with one.
//   3. Fingerprint (below). An OPEN draft with it → that draft's id, 0 new rows. A draft a person REJECTED with it
//      within 30 days → `abstained` + `recently_rejected` (the verdict only, never the reason text).
//   4. Insert, with `expected` copied from each based_on cell (approval re-checks them; changed → stale).
// Fingerprint (§5.5: "command_type + target ids + the template id and params of each based_on cell"):
//   - the draft's target outlets;
//   - target ids = uuid leaves of the payload that are a uuid cell of a snapshot the draft cites. New-entity ids
//     (po_id, price_id …) are minted per draft and never sit in a snapshot, so they are left out; ids of existing
//     rows reach a payload only from a snapshot cell (§5.7: the model never types a UUID). INFERENCE;
//   - per based_on cell: template id, version and params, the cited row's key (its uuid / date cells, the way
//     approval matches a re-run row; the index when it has none) and the column. Snapshot ids are NOT in it, so a
//     re-detection on a fresh snapshot of the same rows is the same proposal; another row is another proposal;
//   - the payload's cited rows and spans (`⟨cite:…⟩`, sorted): a workflow draft may cite no snapshot and target no
//     outlet, so without them every document's invoice draft would share one fingerprint (the second would answer with
//     the first's id, and one rejection would bar every invoice for 30 days).
// There is no fingerprint column (ADR §14 C7 keeps this in code): candidates of the same command type are re-hashed
// under a per-(tenant, fingerprint) transaction lock, so two concurrent identical proposals store one row.
import { draftable, type ParsedRef, parseRef } from "@munim/contracts";
import { DraftsRequest } from "@munim/contracts/internal";
import { SPECIALIST_REGISTRY } from "@munim/contracts/intel";
import { checkGrammar, validateDraft } from "@munim/core-domain/envelope";
import { canonicalJson, sha256Hex } from "../commit/index.ts";
import { campaignAudienceScoped } from "../lib/demo.ts";
import { ApiError } from "../lib/errors.ts";
import { payrollScope } from "../modules/people/payroll.ts";
import type { Queryable } from "../runtoken/index.ts";
import type { Run } from "./auth.ts";
import { dbResolver } from "./resolver.ts";

type Body = { draft_id: string; status: "proposed" | "abstained"; reason_code: string | null };
type Cells = Map<string, { template_id: string; template_version: number; params: unknown; rows: Array<Record<string, unknown>>; columns: Array<{ name: string; type: string }> }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PAYROLL = new Set(["people.payroll_draft.create.v1"]);
/** Free-string leaves that are identifiers, not prose (step 2b): excepted from the number grammar by name, in this shape only. */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9/._-]{0,39}$/;
const IDENTIFIER_LEAVES: Record<string, readonly string[]> = { "purchasing.invoice.record.v1": ["invoice_no"] };
const REJECTION_WINDOW = "30 days";

interface Proposal { command_type: string; outlet_ids: string[]; payload: unknown; based_on: string[] }
interface StoredDraft { id: string; source: string; command_type: string; command_payload: unknown; outlet_ids: string[]; finding_id: string | null; evidence: string[]; based_on: unknown[] }

const refsIn = (v: unknown): string[] =>
  typeof v === "string" ? (parseRef(v) ? [v] : []) : Array.isArray(v) ? v.flatMap(refsIn) : v && typeof v === "object" ? Object.values(v).flatMap(refsIn) : [];
const uuidsIn = (v: unknown, path = ""): Array<[string, string]> =>
  typeof v === "string" ? (UUID.test(v) ? [[path, v]] : []) : Array.isArray(v) ? v.flatMap((x, i) => uuidsIn(x, `${path}/${i}`))
    : v && typeof v === "object" ? Object.entries(v).flatMap(([k, x]) => uuidsIn(x, `${path}/${k}`)) : [];
const basedOnRefs = (b: unknown[]) => b.map((e) => (typeof e === "string" ? e : (e as { ref?: unknown } | null)?.ref)).filter((r): r is string => typeof r === "string");
const snapId = (ref: string) => { const p = parseRef(ref); return p?.kind === "snap" ? p.snapshot_id : null; };
/** An evidence RefId ("snap:<id>", "row:core.x:<id>", "doc:<id>" …) as the ref it names. */
const evidenceRef = (e: string): ParsedRef =>
  e.startsWith("snap:") ? { kind: "snapshot", id: e.slice("snap:".length), span: null } : parseRef(`⟨cite:${e}⟩`)!;

/** Snapshots the proposals cite, tenant-wide (RLS): the fingerprint is a comparison, nothing here is shown. */
async function loadCells(c: Queryable, proposals: Proposal[]): Promise<Cells> {
  const ids = [...new Set(proposals.flatMap((p) => [...refsIn(p.payload), ...p.based_on]).map(snapId).filter((x): x is string => x !== null))];
  if (ids.length === 0) return new Map();
  const r = await c.query<{ id: string; template_id: string; template_version: number; params: unknown; rows: Array<Record<string, unknown>>; columns: Array<{ name: string; type: string }> }>(
    `SELECT s.id, s.template_id, s.template_version, s.params, s.rows, t.columns FROM evidence.snapshot s
       JOIN evidence.snapshot_template t ON t.id = s.template_id AND t.version = s.template_version WHERE s.id = ANY ($1::uuid[])`, [ids]);
  return new Map(r.rows.map((s) => [s.id, s]));
}

export function fingerprint(p: Proposal, cells: Cells): string {
  const cited = [...new Set([...refsIn(p.payload), ...p.based_on].map(snapId).filter((x): x is string => x !== null))];
  const known = new Set<string>();
  for (const id of cited) {
    const s = cells.get(id);
    const uuidCols = s?.columns.filter((col) => col.type === "uuid").map((col) => col.name) ?? [];
    for (const row of s?.rows ?? []) for (const col of uuidCols) if (typeof row[col] === "string") known.add(row[col] as string);
  }
  const targets = uuidsIn(p.payload).filter(([, id]) => known.has(id)).map(([path, id]) => `${path}=${id}`).sort();
  const basedOn = p.based_on.map((ref) => {
    const at = parseRef(ref) as { snapshot_id: string; row: number; column: string };
    const s = cells.get(at.snapshot_id);
    const keys = s?.columns.filter((col) => col.type === "uuid" || col.type === "date").map((col) => col.name) ?? [];
    const row = s?.rows[at.row] ?? {};
    return canonicalJson({ template: s?.template_id ?? null, version: s?.template_version ?? null, params: s?.params ?? null,
      row: keys.length ? Object.fromEntries(keys.map((k) => [k, row[k] ?? null])) : at.row, column: at.column });
  }).sort();
  const cites = refsIn(p.payload).filter((r) => parseRef(r)?.kind !== "snap").sort();
  return sha256Hex(canonicalJson({ command_type: p.command_type, outlets: [...p.outlet_ids].sort(), targets, based_on: basedOn, cites }));
}

const asProposal = (d: StoredDraft): Proposal =>
  ({ command_type: d.command_type, outlet_ids: d.outlet_ids, payload: d.command_payload, based_on: basedOnRefs(d.based_on) });

/** The request a stored draft was created from (idempotency compares this with the new request). */
const requestOf = (d: StoredDraft) => ({
  draft_id: d.id, pack: d.source.slice("intel:".length), command_type: d.command_type, payload: d.command_payload,
  outlet_ids: d.outlet_ids, finding_id: d.finding_id, evidence: d.evidence, based_on: basedOnRefs(d.based_on),
});

type JsonSchema = { type?: string | string[]; pattern?: string; format?: string; enum?: unknown[]; const?: unknown;
  properties?: Record<string, JsonSchema>; items?: JsonSchema; additionalProperties?: boolean | JsonSchema; anyOf?: JsonSchema[]; oneOf?: JsonSchema[]; allOf?: JsonSchema[] };
const isFree = (s: JsonSchema) => s.pattern === undefined && s.format === undefined && s.enum === undefined && s.const === undefined;

/** Paths of the free string leaves of a command type's proposal schema: `note`, `lines[].note`, `labels.*`. */
function freeStrings(s: JsonSchema, path: string, out: Set<string>): Set<string> {
  for (const b of [...(s.anyOf ?? []), ...(s.oneOf ?? []), ...(s.allOf ?? [])]) freeStrings(b, path, out);
  const types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
  if (types.includes("string") && isFree(s)) out.add(path);
  const at = (k: string) => (path ? `${path}.${k}` : k);
  for (const [k, v] of Object.entries(s.properties ?? {})) freeStrings(v, at(k), out);
  if (s.items) freeStrings(s.items, `${path}[]`, out);
  if (s.additionalProperties && typeof s.additionalProperties === "object") freeStrings(s.additionalProperties, at("*"), out);
  return out;
}
const PROSE = new Map<string, Set<string>>();
export function proseLeafPaths(commandType: string): Set<string> {
  if (!PROSE.has(commandType)) {
    const d = draftable(commandType);
    const free = d ? freeStrings(d.proposal.toJSONSchema({ unrepresentable: "any", io: "input" }) as JsonSchema, "", new Set()) : new Set<string>();
    for (const leaf of IDENTIFIER_LEAVES[commandType] ?? []) free.delete(leaf);
    PROSE.set(commandType, free);
  }
  return PROSE.get(commandType)!;
}
/** The strings of a value at a path's keys (`note`, `lines[]`, `*`). */
function stringsAt(v: unknown, keys: readonly string[]): string[] {
  if (keys.length === 0) return typeof v === "string" ? [v] : [];
  const [k, ...rest] = keys as [string, ...string[]];
  if (!v || typeof v !== "object") return [];
  if (k === "*") return Object.values(v).flatMap((x) => stringsAt(x, rest));
  const x = (v as Record<string, unknown>)[k.endsWith("[]") ? k.slice(0, -2) : k];
  if (!k.endsWith("[]")) return stringsAt(x, rest);
  return Array.isArray(x) ? x.flatMap((e) => stringsAt(e, rest)) : [];
}
const proseIn = (commandType: string, payload: unknown) => [...proseLeafPaths(commandType)].flatMap((p) => stringsAt(payload, p.split(".")));
const identifiersIn = (commandType: string, payload: unknown) => (IDENTIFIER_LEAVES[commandType] ?? []).flatMap((p) => stringsAt(payload, p.split(".")));

const DRAFT_COLS = `id, source, command_type, command_payload, outlet_ids, finding_id, evidence, based_on`;

/** Returns the response body text: stored drafts answer with exactly these bytes on every replay. */
export async function writeDraft(c: Queryable, run: Run, raw: unknown): Promise<string> {
  const parsed = DraftsRequest.safeParse(raw);
  if (!parsed.success) {
    const type = (raw as { command_type?: unknown } | null)?.command_type;
    throw new ApiError(typeof type === "string" && !draftable(type) ? "unregistered_command_type" : "invalid_payload");
  }
  const req = parsed.data;
  // F8: the proposer is a registered specialist and the command is one it may propose (ADR-014 §3.2 "Can propose");
  // import-only draftables (imports.*) belong to no specialist, so intel can never propose them.
  const specialist = SPECIALIST_REGISTRY.specialists.find((x) => x.id === req.pack && x.kind === "specialist");
  if (!specialist?.draftables.includes(req.command_type) && !specialist?.workflow_draftables.includes(req.command_type)) throw new ApiError("invalid_payload");
  // Payroll is drafted only where the country pack prepares it (`payroll_scope = drafts`, packs/people.md §6); elsewhere
  // the proposal is refused before anything is resolved or stored (P6), as the member route refuses it.
  if (PAYROLL.has(req.command_type) && (await payrollScope(c)) !== "drafts") throw new ApiError("out_of_pack_scope", "payroll_out_of_scope");
  // ADR-015 §4: a task naming a Munim Cares listing comes only from the people pack's overstaffed_slot mapping (deterministic
  // code); any other proposer of goals.task.create.v1 sends null (ontology `fixed`), so a listing id from it is refused.
  if (req.command_type === "goals.task.create.v1" && (req.payload as { cares_listing_id?: unknown }).cares_listing_id != null && req.pack !== "people") {
    throw new ApiError("invalid_payload");
  }
  if (req.command_type === "customers.campaign.create.v1" && !(await campaignAudienceScoped(c, req))) {
    throw new ApiError("invalid_payload", "campaign_audience_unscoped");
  }
  const answer = (b: Body) => JSON.stringify(b);
  // A run proposes only inside its own scope; a tenant-wide draft ([]) needs a run over every outlet.
  if (run.scope[0] !== "*" && (req.outlet_ids.length === 0 || req.outlet_ids.some((o) => !(run.scope as string[]).includes(o)))) throw new ApiError("forbidden");

  const same = await c.query<StoredDraft>(`SELECT ${DRAFT_COLS} FROM core.draft WHERE id = $1`, [req.draft_id]);
  if (same.rows[0]) {
    if (canonicalJson(requestOf(same.rows[0])) !== canonicalJson(req)) throw new ApiError("idempotency_conflict");
    return answer({ draft_id: req.draft_id, status: "proposed", reason_code: null });
  }

  const resolver = dbResolver(c, run.scope);
  const verdict = await validateDraft({ payload: req.payload, based_on: req.based_on }, resolver);
  if (!verdict.ok) return answer({ draft_id: req.draft_id, status: "abstained", reason_code: verdict.reason_code });
  if (proseIn(req.command_type, req.payload).some((t) => !checkGrammar(t).ok)
      || identifiersIn(req.command_type, req.payload).some((t) => !IDENTIFIER.test(t))) return answer({ draft_id: req.draft_id, status: "abstained", reason_code: "number_grammar" });
  for (const e of req.evidence) {
    if ((await resolver.resolve(evidenceRef(e))).status !== "ok") return answer({ draft_id: req.draft_id, status: "abstained", reason_code: "unresolved_ref" });
  }
  if (req.finding_id) {
    const f = await c.query<{ pack: string }>(`SELECT pack FROM intel.finding WHERE id = $1`, [req.finding_id]);
    if (!f.rows[0]) return answer({ draft_id: req.draft_id, status: "abstained", reason_code: "unresolved_ref" });
    if (f.rows[0].pack !== req.pack) throw new ApiError("invalid_payload");
  }

  const proposal: Proposal = { command_type: req.command_type, outlet_ids: req.outlet_ids, payload: req.payload, based_on: req.based_on };
  const own = await loadCells(c, [proposal]);
  const fp = fingerprint(proposal, own);
  await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('core.draft:' || $1 || ':' || $2, 0))`, [run.tenantId, fp]);
  const candidates = await c.query<StoredDraft & { open: boolean }>(
    `SELECT ${DRAFT_COLS.split(", ").map((x) => `r.${x}`).join(", ")}, r.status = 'proposed' AS open FROM core.draft r
      WHERE r.command_type = $1
        AND (r.status = 'proposed'
             OR (r.status = 'rejected' AND EXISTS (SELECT 1 FROM core.decision d WHERE d.draft_id = r.id AND d.verdict = 'rejected'
                                                    AND d.decided_at > now() - $2::interval)))
      ORDER BY r.status = 'proposed' DESC, r.created_at, r.id`, [req.command_type, REJECTION_WINDOW]);
  const cells = await loadCells(c, candidates.rows.map(asProposal));
  const hit = candidates.rows.find((d) => fingerprint(asProposal(d), cells) === fp);
  if (hit?.open) return answer({ draft_id: hit.id, status: "proposed", reason_code: null });
  if (hit) return answer({ draft_id: req.draft_id, status: "abstained", reason_code: "recently_rejected" });

  const basedOn = req.based_on.map((ref) => {
    const at = parseRef(ref) as { snapshot_id: string; row: number; column: string };
    const s = own.get(at.snapshot_id)!;
    return { ref, template_id: s.template_id, params: s.params, expected: s.rows[at.row]![at.column] ?? null };
  });
  try {
    await c.query(
      `INSERT INTO core.draft (tenant_id, id, outlet_ids, source, finding_id, run_id, command_type, command_payload, evidence, based_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [run.tenantId, req.draft_id, req.outlet_ids, `intel:${req.pack}`, req.finding_id, run.runId, req.command_type,
       JSON.stringify(req.payload), JSON.stringify(req.evidence), JSON.stringify(basedOn)]);
  } catch (e) {
    // The id is taken by a draft this run cannot see (another outlet): the same id with another body.
    if ((e as { code?: unknown }).code === "23505") throw new ApiError("idempotency_conflict");
    throw e;
  }
  return answer({ draft_id: req.draft_id, status: "proposed", reason_code: null });
}
