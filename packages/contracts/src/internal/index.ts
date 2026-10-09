// /internal/intel/v1 W1 request/response bodies (03-architecture §1.7, §1.9; R25). Caller: intel only,
// with a run token AND a service credential. Tenant and outlet scope come only from the run token — no
// body here carries a tenant_id (04-agent-framework §11 "tenant binding").
import { z } from "zod";
import { AnswerEnvelope, FindingEnvelope } from "../shared/envelope.ts";
import { checkDraftPayload, draftPayload } from "../shared/draftables.ts";
import { BasisPoints, CommandType, IsoDateTime, Slug, Uuid7 } from "../shared/primitives.ts";
import { ReasonCode } from "../shared/reason-codes.ts";
import { RefId, SnapCellRef } from "../shared/refs.ts";
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
});
export const FindingsResponse = z.strictObject({
  finding_id: Uuid7,
  outcome: z.enum(["stored", "merged", "abstained"]),
  reason_code: ReasonCode.nullable(),
});

export const DraftsRequest = z
  .strictObject({
    draft_id: Uuid7,
    /** A registered draftable command type (shared/draftables.ts); anything else is refused. */
    command_type: CommandType,
    /** The registered proposal schema: numeric leaves are refs only (R26), no person-edit form. */
    payload: draftPayload("proposal"),
    /** Target outlets; `[]` = tenant-wide (approvable by an owner only, W1 fix #32/#52). */
    outlet_ids: z.array(Uuid7),
    finding_id: Uuid7.nullable(),
    evidence: z.array(RefId).min(1),
    /** The snapshot cells the proposal assumes; core copies their current values into `expected` and
     *  re-checks them at approval (changed → stale, no execution). */
    based_on: z.array(SnapCellRef).min(1),
  })
  .superRefine(checkDraftPayload("proposal", "payload"));
export const DraftsResponse = z.strictObject({ draft_id: Uuid7, status: z.enum(["proposed", "abstained"]), reason_code: ReasonCode.nullable() });

export const AnswersRequest = z.strictObject({
  question: z.string().min(1).max(2000),
  envelope: AnswerEnvelope,
});
export const AnswersResponse = z.strictObject({ answer_id: Uuid7, abstained: z.boolean(), reason_code: ReasonCode.nullable() });

export const TracesBatchRequest = z.strictObject({ events: z.array(TraceEventInput).min(1).max(500) });
export const TracesBatchResponse = z.strictObject({ inserted: z.int().min(0), last_seq: z.int().min(0) });

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
];
