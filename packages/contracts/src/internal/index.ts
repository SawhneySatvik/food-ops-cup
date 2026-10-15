// /internal/intel/v1 request/response bodies (03-architecture §1.7, §1.9; R25). Caller: intel only,
// with a run token AND a service credential. Tenant and outlet scope come only from the run token — no
// body here carries a tenant_id or a run_id (04-agent-framework §11 "tenant binding").
import { z } from "zod";
import { SPECIALIST_REGISTRY } from "../intel/specialists.ts";
import { AnswerEnvelope, FindingEnvelope, Segment } from "../shared/envelope.ts";
import { checkDraftPayload, draftPayload } from "../shared/draftables.ts";
import { BasisPoints, CommandType, CurrencyCode, IanaZone, IsoDate, IsoDateTime, LocalTime, Slug, Unit, Uuid7 } from "../shared/primitives.ts";
import { ReasonCode } from "../shared/reason-codes.ts";
import { parseRef, RefId, SnapCellRef } from "../shared/refs.ts";
import type { Route } from "../shared/routes.ts";
import { MintSnapshotRequest } from "../shared/snapshot.ts";
import { TraceEventInput } from "../shared/trace.ts";

export const EventsClaimRequest = z.strictObject({ event_id: Uuid7 });
/** 200 = first claim, do the work. A repeat claim is 409 (error body) → intel acks and stops. */
export const EventsClaimResponse = z.strictObject({ event_id: Uuid7, claimed_at: IsoDateTime });

export const WatchClaimRequest = z.strictObject({ pack: Slug });
/** Leading-edge debounce: `go` false → another sweep ran recently; do nothing. */
export const WatchClaimResponse = z.strictObject({ pack: Slug, go: z.boolean(), last_run_at: IsoDateTime.nullable() });

/** Response is `snapshot` (shared). Template ids are allow-listed per pack; params are template-defined. */
export const SnapshotsRequest = MintSnapshotRequest;

export const Severity = z.enum(["low", "medium", "high", "critical"]);

export const FindingsRequest = z.strictObject({
  pack: Slug,
  type: Slug,
  severity: Severity,
  /** Model self-assessment, shown as a band, never as a figure (see the T-002 guarantee note). */
  confidence_bp: BasisPoints,
  /** Merges with an open finding of the same key. */
  dedupe_key: z.string().regex(/^[a-z0-9_.:-]{1,200}$/),
  envelope: FindingEnvelope,
  /** T-114: the one outlet a detection is about when its impact snapshot was minted tenant-wide (a template with no outlet
   *  param, e.g. compliance.licence_calendar). Core takes it only inside the run's scope and equal to the impact row's
   *  `outlet_id` cell; absent or null (intel's generated client sends null) → core stamps the outlets as before. */
  outlet_ids: z.array(Uuid7).length(1).nullish(),
});
export const FindingsResponse = z.strictObject({
  finding_id: Uuid7,
  outcome: z.enum(["stored", "merged", "abstained"]),
  reason_code: ReasonCode.nullable(),
});

/** The eight specialist ids of ledger R45 F8 (the registry's `specialist` entries; not the manager, not forecast). */
export const SpecialistId = z.enum(
  SPECIALIST_REGISTRY.specialists.filter((s) => s.kind === "specialist").map((s) => s.id) as [string, ...string[]],
);

export const DraftsRequest = z
  .strictObject({
    draft_id: Uuid7,
    /** The proposing specialist (F8): core stores `source = intel:<pack>`; a cited finding must be of this pack. */
    pack: SpecialistId,
    /** A registered draftable command type (shared/draftables.ts); anything else is refused. */
    command_type: CommandType,
    /** The registered proposal schema: numeric leaves are refs only (R26), no person-edit form. */
    payload: draftPayload("proposal"),
    /** Target outlets; `[]` = tenant-wide (approvable by an owner only, W1 fix #32/#52). */
    outlet_ids: z.array(Uuid7),
    finding_id: Uuid7.nullable(),
    evidence: z.array(RefId).min(1),
    /** The snapshot cells the proposal assumes; core copies their current values into `expected` and
     *  re-checks them at approval (changed → stale, no execution). ≥ 1, except a workflow draft (below). */
    based_on: z.array(SnapCellRef),
  })
  .superRefine(checkDraftPayload("proposal", "payload"))
  .superRefine(checkEmptyBasedOn);

const refLeaves = (v: unknown): string[] =>
  typeof v === "string" ? (parseRef(v) ? [v] : []) : Array.isArray(v) ? v.flatMap(refLeaves) : v && typeof v === "object" ? Object.values(v).flatMap(refLeaves) : [];
/** A document span or a negotiation quote row: a value a person confirms or types (R26), never a snapshot cell. */
const documentOrQuote = (ref: string) => {
  const p = parseRef(ref);
  return p !== null && (p.kind === "doc" || (p.kind === "row" && p.id.startsWith("intel.supplier_quote:")));
};
/** DECISIONS 11 Oct (W3.2): `based_on` may be empty only for a workflow draft of the proposing pack whose every numeric
 *  leaf is a document or quote ref (a document-sourced draft cites no snapshot cell); every other draft cites ≥ 1 cell. */
function checkEmptyBasedOn(v: { pack: string; command_type: string; payload: unknown; based_on: string[] }, ctx: z.RefinementCtx) {
  if (v.based_on.length > 0) return;
  const workflow = SPECIALIST_REGISTRY.specialists.find((s) => s.id === v.pack)?.workflow_draftables.includes(v.command_type) ?? false;
  const refs = refLeaves(v.payload);
  if (!workflow || refs.length === 0 || !refs.every(documentOrQuote))
    ctx.addIssue({ code: "custom", path: ["based_on"], message: "based_on needs >= 1 snapshot cell unless a workflow draft's every numeric leaf is a document or quote ref" });
}
/** Core-side idempotency (ADR-014 §5.5): same id + same body → the original response; same id + another body →
 *  409. An open draft with the same fingerprint → its id (`proposed`, no new row). A fingerprint a person rejected
 *  within 30 days → `abstained` + `recently_rejected` (nothing stored). Other refusals → `abstained` + reason. */
export const DraftsResponse = z.strictObject({ draft_id: Uuid7, status: z.enum(["proposed", "abstained"]), reason_code: ReasonCode.nullable() });

export const AnswersRequest = z.strictObject({
  question: z.string().min(1).max(2000),
  envelope: AnswerEnvelope,
});
export const AnswersResponse = z.strictObject({ answer_id: Uuid7, abstained: z.boolean(), reason_code: ReasonCode.nullable() });

export const TracesBatchRequest = z.strictObject({ events: z.array(TraceEventInput).min(1).max(500) });
export const TracesBatchResponse = z.strictObject({ inserted: z.int().min(0), last_seq: z.int().min(0) });

// ---------------------------------------------------------------------------------------------------------------
// T-040b (ADR-014 §14 C2): the batch writes. Every batch is idempotent by row id — a retry inserts 0 and answers
// `existing`; the same id with another body is 409. Ids are intel's (deterministic per input); `run_id` is the token's.
// A batch is one transaction: one refused row (a quote that is not its source, an id this run cannot see) refuses all.
// ---------------------------------------------------------------------------------------------------------------
const rows = <T extends z.ZodType>(item: T, max = 500) => z.array(item).min(1).max(max);
/** `inserted` rows are new; `existing` were already stored with the same body (a retry). */
export const BatchResponse = z.strictObject({ inserted: z.int().min(0), existing: z.int().min(0) });
const CoreRowRef = z.string().regex(/^core\.[a-z_]+:[0-9a-f-]{36}$/);
const Predicate = z.string().regex(/^[a-z][a-z0-9_]*$/);

export const EntitiesBatchRequest = z.strictObject({
  entities: rows(z.strictObject({
    id: Uuid7,
    kind: z.enum(["business", "outlet", "brand", "channel", "item", "ingredient", "supplier", "person", "customer", "day", "other"]),
    /** The core row this entity stands for (`core.<table>:<uuid>`), or null for an entity known only from claims. */
    core_ref: CoreRowRef.nullable(),
    name: z.string().min(1).max(200),
  })),
});
export const AliasesBatchRequest = z.strictObject({
  /** `normalized` is core's (NFKC, trimmed, single spaces, lower case) — intel does not send it. */
  aliases: rows(z.strictObject({ id: Uuid7, entity_id: Uuid7, alias: z.string().min(1).max(200), source: z.enum(["core", "claim", "import", "member"]) })),
});
export const ChunksBatchRequest = z.strictObject({
  chunks: rows(z.strictObject({
    id: Uuid7,
    /** Exactly one of document_id / message_id. */
    document_id: Uuid7.nullable(),
    message_id: Uuid7.nullable(),
    seq: z.int().min(0),
    char_start: z.int().min(0),
    text: z.string().min(1).max(8000),
  }).refine((c) => !(c.document_id !== null && c.message_id !== null), { message: "at most one of document_id, message_id (neither: a run's own text, e.g. a supplier reply)" })),
});
export const ClaimsBatchRequest = z.strictObject({
  claims: rows(z.strictObject({
    id: Uuid7,
    /** Exactly one of chunk_id / message_id; `quote` must be that source's text at [span_start, span_end) (MB012). */
    chunk_id: Uuid7.nullable(),
    message_id: Uuid7.nullable(),
    span_start: z.int().min(0),
    span_end: z.int().min(1),
    quote: z.string().min(1).max(2000),
    subject_entity_id: Uuid7.nullable(),
    predicate: Predicate,
    object: z.string().min(1).max(500).nullable(),
    object_entity_id: Uuid7.nullable(),
  }).refine((c) => (c.chunk_id === null) !== (c.message_id === null) && c.span_end > c.span_start, { message: "one source, span_end > span_start" })),
});
export const EdgesBatchRequest = z.strictObject({
  edges: rows(z.strictObject({
    id: Uuid7,
    kind: z.enum(["uses", "quoted", "sold", "wasted", "supplies", "works_at", "mentions", "supported_by", "proposes", "about", "contradicts"]),
    src_entity_id: Uuid7,
    dst_entity_id: Uuid7,
    /** Provenance (02-schema §6): a claim, a core row, or both. */
    claim_id: Uuid7.nullable(),
    source_ref: CoreRowRef.nullable(),
    valid_from: IsoDate.nullable(),
    valid_to: IsoDate.nullable(),
  }).refine((e) => e.claim_id !== null || e.source_ref !== null, { message: "claim_id or source_ref" })),
});
/** 768 dimensions (gotcha 26), each component in millionths (`embedding_micro`, an integer: no contract carries a
 *  float). Sets a chunk's embedding once; a chunk that already has one is `existing`. Refused `unavailable` (503)
 *  where the database has no pgvector column (0013 not applied). */
export const EMBEDDING_DIMENSIONS = 768;
export const EmbeddingsBatchRequest = z.strictObject({
  embeddings: rows(z.strictObject({ chunk_id: Uuid7, embedding_micro: z.array(z.int()).length(EMBEDDING_DIMENSIONS) }), 100),
});
/** One new version per page; `body` is cited segments, validated by core as an answer is (grammar, refs resolve). A
 *  page whose body fails is `abstained` with its reason and nothing of it is stored. `version` = the page's next. */
export const WikiBatchRequest = z.strictObject({
  pages: rows(z.strictObject({
    page_id: Uuid7,
    entity_id: Uuid7.nullable(),
    kind: z.string().regex(/^[a-z][a-z0-9_]*$/),
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,119}$/),
    title: z.string().min(1).max(200),
    version_id: Uuid7,
    version: z.int().min(1),
    body: z.array(Segment).max(200),
  }), 50),
});
export const WikiBatchResponse = z.strictObject({
  pages: z.array(z.strictObject({ page_id: Uuid7, version: z.int().min(1), status: z.enum(["stored", "existing", "abstained"]), reason_code: ReasonCode.nullable() })),
});
/** T-052's output: the run row once (repeat it with each further chunk of points), then ≤ 500 points per call. Points
 *  are outlet-scoped (a run sees only its outlets) and each names the snapshot its inputs came from (in the run's scope). */
export const ForecastsBatchRequest = z.strictObject({
  forecast_run: z.strictObject({
    id: Uuid7,
    method: Predicate,
    trained_through: IsoDate,
    horizon_days: z.int().min(1).max(60),
    holdout_days: z.int().min(0),
    wape_bp: z.int().min(0).nullable(),
    baseline_wape_bp: z.int().min(0).nullable(),
    bias_bp: z.int().nullable(),
  }),
  points: z.array(z.strictObject({
    id: Uuid7,
    outlet_id: Uuid7,
    /** null = the outlet's 'other' series. */
    item_id: Uuid7.nullable(),
    business_on: IsoDate,
    /** null = the whole day. */
    slot_start: LocalTime.nullable(),
    method: Predicate,
    qty_milli: z.int().min(0),
    /** lo ≤ qty ≤ hi (the engine's band; with no backtest intel sends lo = hi = qty). */
    lo_qty_milli: z.int().min(0),
    hi_qty_milli: z.int().min(0),
    inputs_snapshot_id: Uuid7,
  })).max(500),
});
export const ForecastsBatchResponse = z.strictObject({ run_inserted: z.boolean(), inserted: z.int().min(0), existing: z.int().min(0) });
/** A field's [start, end) in its source chunk's text, in characters (as Postgres counts them). */
const QuoteSpan = z.tuple([z.int().min(0), z.int().min(1)]).refine(([s, e]) => e > s, { message: "end > start" });
/** Quotes from SIMULATED suppliers only (R22/R23: the DB refuses any other supplier kind). Typed fields from the
 *  no-tools extractor — supplier prose never reaches this table; `terms` holds flags, counts and codes only.
 *  Provenance (DECISIONS 11 Oct, "W3.2 review ruling — quote provenance"): the supplier's reply is an untrusted chunk of
 *  this run (`chunks:batch` first) and each field keeps its span in it, so the approver sees every PO number beside
 *  "from the supplier's reply". Price and quantity always have a span; minimum order and payment days exactly when
 *  non-zero, else null (zero = the reply states none). Core refuses a chunk of another run or a span outside the chunk's text. */
export const QuotesBatchRequest = z.strictObject({
  quotes: rows(z.strictObject({
    id: Uuid7,
    supplier_id: Uuid7,
    ingredient_id: Uuid7,
    round: z.int().min(1).max(3),
    qty_milli: z.int().min(1),
    unit: Unit,
    unit_price_minor: z.int().min(0),
    currency: CurrencyCode,
    min_order_qty_milli: z.int().min(0),
    payment_days: z.int().min(0).max(365),
    terms: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/), z.union([z.boolean(), z.int(), z.string().regex(/^[a-z][a-z0-9_]{0,39}$/)])),
    trace_event_id: Uuid7.nullable(),
    source_chunk_id: Uuid7,
    spans: z.strictObject({
      unit_price_minor: QuoteSpan,
      qty_milli: QuoteSpan,
      min_order_qty_milli: QuoteSpan.nullable(),
      payment_days: QuoteSpan.nullable(),
    }),
  }).refine((q) => (q.min_order_qty_milli === 0) === (q.spans.min_order_qty_milli === null)
    && (q.payment_days === 0) === (q.spans.payment_days === null), { message: "a span exactly for each non-zero field" }), 100),
});
/** Model spend per call (04 §10). Stamped by core at receipt (never backdated out of a month); always recorded,
 *  even past the cap (run tokens are never refused for budget). The currency must be the month's budget currency
 *  (else the tenant's base currency) — spend in another currency would escape the cap. */
export const SpendRequest = z.strictObject({
  entries: rows(z.strictObject({
    id: Uuid7,
    role: z.enum(["router", "reason", "extract", "narrate", "vision", "embed"]),
    provider: z.enum(["gemini", "openai", "openrouter", "nvidia"]),
    model_id: z.string().min(1).max(200),
    input_tokens: z.int().min(0),
    output_tokens: z.int().min(0),
    amount_minor: z.int().min(0),
    currency: CurrencyCode,
  }), 100),
});

// POST graph:query (T-058 wiring; ADR-014 "Graph port", F7): one of five bounded, core-owned graph templates over
// intel.entity / intel.edge, run by core as munim_svc with `:tenant_id` bound from the run token — the tenant is never an
// argument. A template takes exactly its own id argument (a uuid) and, for walks, `depth` 1..3 (default 3); anything else
// refuses (422). Rows are ids, kinds, names and hop counts only — never a number to display.
export const GRAPH_TEMPLATES = ["price_shock_path", "dish_margin_drivers", "supplier_dependency", "claim_support", "neighbourhood"] as const;
export const GraphQueryRequest = z.strictObject({
  template: z.enum(GRAPH_TEMPLATES),
  args: z.record(z.string().regex(/^[a-z_]{1,40}$/), z.union([z.string().max(64), z.int()])),
});
export const GraphQueryResponse = z.strictObject({
  rows: z.array(z.record(z.string(), z.union([z.string(), z.int(), z.null()]))).max(50),
});

// GET run-frame (04 §1 RunFrame; ADR-014 §6.1 block 5, §14 C1): what a run needs that its token does not carry. An
// ask's thread excerpt is not here: it rides only in core's `/ask` body (`threads.block`), bound to the run core mints.
export const RunFrameOutlet = z.strictObject({
  id: Uuid7,
  name: z.string().min(1),
  kind: z.enum(["restaurant", "cloud_kitchen", "store"]),
  tz: IanaZone,
  /** The outlet's business date at the frame's instant (core's one tz module, the outlet's cutoff). */
  business_date: IsoDate,
  /** ADR-015 §4: Munim Cares is on for this outlet — operator enablement on, the business's profile active, the outlet
   *  opted in and active. Absent (older frames) = false. */
  cares_active: z.boolean().default(false),
});
/** The month's AI budget (UTC month, F11 O-2; T-090's effectiveCap). effective cap = the lower of the owner's cap (when set, in the budget's currency)
 *  and the operator's limit; hard_left = effective cap − spent (≤ 0 = `hard`: rules only). No soft threshold is decided yet
 *  (open item), so `level` is ok | hard. Run tokens are never refused for budget. */
export const RunFrameBudget = z.strictObject({
  month: IsoDate,
  currency: CurrencyCode,
  owner_cap_minor: z.int().min(0).nullable(),
  operator_limit_minor: z.int().min(0),
  effective_cap_minor: z.int().min(0),
  spent_minor: z.int().min(0),
  hard_left_minor: z.int(),
  level: z.enum(["ok", "hard"]),
});
/** A country-pack `licence_kinds` entry (rule 7: the kinds are pack data). `unverified` = the pack lists `_unverified`
 *  notes for it: its applicability is not confirmed, so a watcher reports it expiring, never missing (DECISIONS 11 Oct).
 *  No label and no note text: a watcher needs the code only. */
export const RunFrameLicenceKind = z.strictObject({
  code: z.string().regex(/^[a-z][a-z0-9_]*$/),
  holder: z.enum(["business", "outlet"]),
  outlet_kinds: z.array(z.enum(["restaurant", "cloud_kitchen", "store"])).min(1),
  unverified: z.boolean(),
});
export const RunFrameResponse = z.strictObject({
  pack: z.strictObject({ code: z.string().regex(/^[A-Z]{2}$/), version: z.int().min(1) }),
  currency: CurrencyCode,
  /** The pack's monthly-impact ladder L and `detectors.<id>.thresholds` (rule 7: pack data, never code). */
  severity_ladder: z.strictObject({ critical_minor_gte: z.int(), high_minor_gte: z.int(), medium_minor_gte: z.int() }),
  detectors: z.record(z.string(), z.strictObject({ thresholds: z.record(z.string(), z.int()) })),
  /** Outlets in the run's scope, by id. */
  outlets: z.array(RunFrameOutlet),
  /** null: the operator set no budget for this month → rules only. */
  budget: RunFrameBudget.nullable(),
  /** `model` only with AI on (`intel.enabled`), a budget, and level `ok`; else `template` (rule 11). */
  narration: z.enum(["model", "template"]),
  /** The typed kill switch alone (`intel.enabled`; T-127, R58), whatever the budget. With narration `template` it tells AI
   *  switched off (false: no AI answer at all, not even a recorded one) from over the month's budget (true with budget level
   *  `hard`: in live mode each model call is served from its recorded fixture or abstains, T-125). Absent (an older core) = false. */
  ai_enabled: z.boolean().default(false),
  /** R47 D7: the owner's negotiation bounds as basis points of the reference price (target ≤ walk-away); 9500 / 11000 when the owner set none. */
  negotiation: z.strictObject({ target_bp: z.int().min(1).max(20000), walkaway_bp: z.int().min(1).max(20000) }),
  /** The pack's licence kinds, in pack order. */
  licence_kinds: z.array(RunFrameLicenceKind),
  /** The pack's `payroll_scope`: payroll drafts exist only under `drafts` (core refuses one elsewhere, `payroll_out_of_scope`). */
  payroll_scope: z.enum(["drafts", "roster_only"]),
});

// GET brief-items (T-054 wiring): core's ranked inbox for the run's tenant and scope — `rankInbox` (impact × confidence ×
// urgency, deduped, drafts attached), top first. Each item carries the finding's stored, core-validated segment texts and
// its impact cell's canonical ref (null when the cell does not resolve), never the dedupe key (it can hold dates and
// is never shown, review R-B) and never a number. A draft with no open finding is not an item (it ranks last).
export const BriefItem = z.strictObject({
  finding_id: Uuid7,
  pack: SpecialistId,
  severity: Severity,
  type: Slug,
  texts: z.array(z.string().max(2000)).max(200),
  impact_ref: SnapCellRef.nullable(),
  draft_ids: z.array(Uuid7),
});
export const BriefItemsResponse = z.strictObject({ items: z.array(BriefItem).max(50) });

export const SCHEMAS = {
  "internal.events-claim.request": EventsClaimRequest,
  "internal.events-claim.response": EventsClaimResponse,
  "internal.watch-claim.request": WatchClaimRequest,
  "internal.watch-claim.response": WatchClaimResponse,
  "internal.snapshots.request": SnapshotsRequest,
  "internal.findings.request": FindingsRequest,
  "internal.findings.response": FindingsResponse,
  "internal.drafts.request": DraftsRequest,
  "internal.drafts.response": DraftsResponse,
  "internal.answers.request": AnswersRequest,
  "internal.answers.response": AnswersResponse,
  "internal.traces-batch.request": TracesBatchRequest,
  "internal.traces-batch.response": TracesBatchResponse,
  "internal.batch.response": BatchResponse,
  "internal.entities-batch.request": EntitiesBatchRequest,
  "internal.aliases-batch.request": AliasesBatchRequest,
  "internal.chunks-batch.request": ChunksBatchRequest,
  "internal.claims-batch.request": ClaimsBatchRequest,
  "internal.edges-batch.request": EdgesBatchRequest,
  "internal.embeddings-batch.request": EmbeddingsBatchRequest,
  "internal.wiki-batch.request": WikiBatchRequest,
  "internal.wiki-batch.response": WikiBatchResponse,
  "internal.forecasts-batch.request": ForecastsBatchRequest,
  "internal.forecasts-batch.response": ForecastsBatchResponse,
  "internal.quotes-batch.request": QuotesBatchRequest,
  "internal.graph-query.request": GraphQueryRequest,
  "internal.graph-query.response": GraphQueryResponse,
  "internal.spend.request": SpendRequest,
  "internal.run-frame.response": RunFrameResponse,
  "internal.brief-items.response": BriefItemsResponse,
};

const P = "/internal/intel/v1";
const intel = (path: string, operationId: string, summary: string, request: string, response: string, status: 200 | 201, conflict = false): Route => ({
  surface: "internal",
  method: "post",
  path: `${P}/${path}`,
  operationId,
  summary,
  auth: "intel",
  request,
  response,
  status,
  conflict,
});
export const ROUTES: readonly Route[] = [
  intel("events:claim", "claimEvent", "Durable event dedupe; a repeat claim is 409", "internal.events-claim.request", "internal.events-claim.response", 200, true),
  intel("watch:claim", "claimWatch", "Leading-edge debounce for a pack's watcher", "internal.watch-claim.request", "internal.watch-claim.response", 200),
  intel("snapshots", "mintSnapshot", "Run an allow-listed template under the run's tenant and outlet scope", "internal.snapshots.request", "snapshot", 201),
  intel("findings", "writeFinding", "Validated finding (or a stored abstention)", "internal.findings.request", "internal.findings.response", 201),
  intel("drafts", "writeDraft", "Draft proposal; numeric payload fields must be refs", "internal.drafts.request", "internal.drafts.response", 201),
  intel("answers", "writeAnswer", "Validated answer envelope (or a stored abstention)", "internal.answers.request", "internal.answers.response", 201),
  intel("traces:batch", "writeTraces", "Append trace events (at most 500 per call)", "internal.traces-batch.request", "internal.traces-batch.response", 201),
  // ADR-014 §14 C2 (filed under T-040b on the board; served by T-040 for T-041's live role lookup).
  { surface: "internal", method: "get", path: `${P}/model-roles`, operationId: "getModelRoles", summary: "Provider + model per role (R36), read-only",
    auth: "intel", response: "platform.model-roles", status: 200 },
  // T-040b: the batch writes and the run-frame (ADR-014 §14 C1, C2).
  intel("entities:batch", "writeEntities", "Knowledge entities (idempotent by id)", "internal.entities-batch.request", "internal.batch.response", 201, true),
  intel("aliases:batch", "writeAliases", "Entity aliases (idempotent by id)", "internal.aliases-batch.request", "internal.batch.response", 201, true),
  intel("chunks:batch", "writeChunks", "Text chunks of documents and messages (idempotent by id)", "internal.chunks-batch.request", "internal.batch.response", 201, true),
  intel("claims:batch", "writeClaims", "Extracted claims; each quote must be its source span (MB012 refuses the batch)", "internal.claims-batch.request", "internal.batch.response", 201, true),
  intel("edges:batch", "writeEdges", "Graph edges with provenance (idempotent by id)", "internal.edges-batch.request", "internal.batch.response", 201, true),
  intel("embeddings:batch", "writeEmbeddings", "Chunk embeddings, 768-d, set once", "internal.embeddings-batch.request", "internal.batch.response", 201, true),
  intel("wiki:batch", "writeWiki", "Wiki page versions of validated cited segments", "internal.wiki-batch.request", "internal.wiki-batch.response", 201, true),
  intel("forecasts:batch", "writeForecasts", "A forecast run and its points (T-052 output)", "internal.forecasts-batch.request", "internal.forecasts-batch.response", 201, true),
  intel("quotes:batch", "writeQuotes", "Simulated-supplier quotes as typed fields", "internal.quotes-batch.request", "internal.batch.response", 201, true),
  intel("graph:query", "graphQuery", "One bounded graph template under the run's tenant (ids, kinds, names, depth)", "internal.graph-query.request", "internal.graph-query.response", 200),
  intel("spend", "writeSpend", "Model spend per call; always recorded, stamped by core", "internal.spend.request", "internal.batch.response", 201, true),
  { surface: "internal", method: "get", path: `${P}/run-frame`, operationId: "getRunFrame",
    summary: "The run's pack, thresholds, outlets with business dates, AI budget and narration mode",
    auth: "intel", response: "internal.run-frame.response", status: 200 },
  { surface: "internal", method: "get", path: `${P}/brief-items`, operationId: "getBriefItems",
    summary: "The ranked inbox for a brief run: stored finding texts, impact refs, draft ids (no dedupe key)",
    auth: "intel", response: "internal.brief-items.response", status: 200 },
];
