// Approvals (03-architecture §1.6, 02-schema §2.12; R15, R16, R26, R27). Intel proposes; a named person
// approves (as proposed or edited) or rejects; core re-checks authority on the FINAL payload and the
// `based_on` cells (changed → `stale`, 0 executions). Nothing auto-applies.
// Generic over command types: the payload is validated against the draftable registry
// (shared/draftables.ts), which each module fills from its own index.ts. This module names no module.
// T-008 owns this module from W1's approvals ticket on.
import { z } from "zod";
import { checkDraftPayload, draftPayload, draftable, draftableTypes } from "../shared/draftables.ts";
import { CommandType, IsoDateTime, Slug, UUID7_PATTERN, Uuid7 } from "../shared/primitives.ts";
import { ReasonCode } from "../shared/reason-codes.ts";
import { Ref, RefId, SnapCellRef } from "../shared/refs.ts";
import type { Route } from "../shared/routes.ts";
import { Cell, TemplateParams } from "../shared/snapshot.ts";

export { draftable, draftableTypes };

export const DraftsApproveV1 = z
  .strictObject({
    draft_id: Uuid7,
    /** Must equal the draft's command type and be a registered draftable. */
    command_type: CommandType,
    /** null = approve as proposed (verdict `approved`); a payload = verdict `edited`. Edited numeric
     *  fields carry `{value, typed_by}` (typed_by must be the approving member); untouched ones keep the
     *  proposed ref. Validated against the registered editable schema of `command_type`. */
    edited_payload: draftPayload("editable").nullable(),
    reason: z.string().min(1).max(500).nullable(),
  })
  .superRefine(checkDraftPayload("editable", "edited_payload"));

/** Why a person turned a proposal (or a finding) down (ADR-014 §8, §14 C4). Additive: `reason` stays the required note.
 *  The code is the only part intel may ever see; the note is untrusted text (R25). */
export const REJECT_REASON_CODES = ["wrong_numbers", "not_needed", "already_done", "bad_timing", "other"] as const;
export const RejectReasonCode = z.enum(REJECT_REASON_CODES);

export const DraftsRejectV1 = z.strictObject({
  draft_id: Uuid7,
  reason: z.string().min(1).max(500),
  reason_code: RejectReasonCode.optional(),
});

export const DraftStatus = z.enum(["proposed", "executing", "executed", "failed", "rejected", "stale"]);

/** A ref with the value core resolved for it (snapshot cell or quoted span), for the renderer. */
export const ResolvedRef = z.strictObject({ ref: Ref, value: Cell });

/** `GET /v1/inbox` draft item. Payload numbers are refs or person edits; their values are in resolved_refs. */
export const DraftView = z
  .strictObject({
    draft_id: Uuid7,
    command_type: CommandType,
    payload: draftPayload("editable"),
    /** JSON Pointer into payload → resolved value, shown beside the field (R26). */
    resolved_refs: z.array(z.strictObject({ path: z.string().regex(/^(\/[^/]+)+$/), ref: Ref, value: Cell })),
    /** `[]` = tenant-wide draft (owner-only approval). */
    outlet_ids: z.array(Uuid7),
    source: z.string().regex(/^(intel:[a-z_]+|import|member)$/),
    finding_id: Uuid7.nullable(),
    run_id: Uuid7.nullable(),
    evidence: z.array(RefId),
    based_on: z.array(z.strictObject({ ref: SnapCellRef, template_id: Slug, params: TemplateParams, expected: Cell })),
    status: DraftStatus,
    created_at: IsoDateTime,
    updated_at: IsoDateTime,
  })
  .superRefine(checkDraftPayload("editable", "payload"));

// ── Read responses (T-008 `GET /v1/drafts`, `GET /v1/drafts/{id}`) ─────────────────────────────────────
export const Verdict = z.enum(["approved", "edited", "rejected"]);
export const Decision = z.strictObject({
  decision_id: Uuid7,
  verdict: Verdict,
  reason: z.string().nullable(),
  decided_by: z.strictObject({ member_id: Uuid7, name: z.string().nullable() }),
  decided_at: IsoDateTime,
});

/** A draft as a member sees it: the view, the person's decision, and every ref that does not resolve for
 *  THIS viewer (shown as "cannot verify"; Approve is hidden while any remain). */
export const DraftItem = z.strictObject({
  draft: DraftView,
  decision: Decision.nullable(),
  unverified_refs: z.array(z.string().min(1).max(300)),
});

/** List: a badge is the length of `items`; `has_more` renders "N+" (R40 C3) — no server count. */
export const DraftsListResponse = z.strictObject({
  items: z.array(DraftItem),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
});

/** A changed `based_on` cell: the value it had (with its ref) and the value now (cited by a snapshot
 *  minted for the approver); `now_ref` / `now` are null where the cell no longer resolves. */
export const StaleChange = z.strictObject({ ref: SnapCellRef, value: Cell, now_ref: SnapCellRef.nullable(), now: Cell });

const HistoryActor = z.union([
  /** The draft's source, e.g. "intel:inventory_purchasing" | "import" | "member". */
  z.string().min(1),
  z.strictObject({ member_id: Uuid7, name: z.string().nullable() }),
  z.strictObject({ member_id: Uuid7, role: z.string().min(1) }),
]);
export const DraftHistoryEntry = z.strictObject({
  /** proposed | approved | edited | rejected | executing | executed | failed | stale | … */
  event: z.string().regex(/^[a-z_.]+$/),
  at: IsoDateTime,
  by: HistoryActor,
  reason: z.string().nullable().optional(),
  decision_id: Uuid7.nullable().optional(),
  changes: z.array(StaleChange).optional(),
  sqlstate: z.string().regex(/^[0-9A-Z]{5}$/).optional(),
});

export const DraftDetailResponse = z.strictObject({
  draft: DraftView,
  decision: Decision.nullable(),
  unverified_refs: z.array(z.string().min(1).max(300)),
  history: z.array(DraftHistoryEntry).min(1),
});

/** Error codes of the approve / reject routes. `already_decided` (409): another person decided first. */
export const APPROVAL_ERROR_CODES = [
  "invalid_payload",
  "unregistered_command_type",
  "cannot_verify",
  "already_decided",
  "stale_draft",
  "idempotency_conflict",
  "execution_failed",
] as const;
export const ApprovalErrorCode = z.enum(APPROVAL_ERROR_CODES);

/** Error body of approve / reject: the shared `{error}` plus, for `stale_draft`, the cells that changed
 *  (`changes`) and, for `cannot_verify`, the refs that did not resolve (`refs`). */
export const DraftDecisionError = z.strictObject({
  error: z
    .strictObject({
      code: ApprovalErrorCode,
      message: z.string().min(1).max(500),
      reason_code: ReasonCode.nullable(),
    })
    .meta({ title: "DraftDecisionErrorBody" }),
  changes: z.array(StaleChange).optional(),
  refs: z.array(z.string().min(1).max(300)).optional(),
});

export const SCHEMAS = {
  "drafts.approve.v1": DraftsApproveV1,
  "drafts.reject.v1": DraftsRejectV1,
  "v1.draft": DraftView,
  "v1.drafts.response": DraftsListResponse,
  "v1.draft.detail": DraftDetailResponse,
  "drafts.decision-error": DraftDecisionError,
};

const uuid = { type: "string", pattern: `^${UUID7_PATTERN}$` };
export const ROUTES: readonly Route[] = [
  {
    surface: "public",
    method: "get",
    path: "/v1/drafts",
    operationId: "listDrafts",
    summary: "Drafts in the caller's outlet scope (status: proposed (default) | executing | executed | failed | rejected | stale | decided)",
    auth: "member",
    response: "v1.drafts.response",
    status: 200,
    query: [
      { name: "status", required: false, schema: { type: "string", enum: ["proposed", "executing", "executed", "failed", "rejected", "stale", "decided"] } },
      { name: "outlet", required: false, schema: uuid },
      { name: "source", required: false, schema: { type: "string", pattern: "^(intel:[a-z_]+|import|member)$" } },
      { name: "limit", required: false, schema: { type: "integer", minimum: 1, maximum: 100 } },
      { name: "cursor", required: false, schema: { type: "string" } },
    ],
  },
  { surface: "public", method: "get", path: "/v1/drafts/{id}", operationId: "getDraft", summary: "One draft with its decision and history", auth: "member", response: "v1.draft.detail", status: 200, pathParams: [{ name: "id", uuid: true }] },
  { surface: "public", method: "post", path: "/v1/drafts/{id}:approve", operationId: "approveDraft", summary: "drafts.approve.v1 — approve as proposed or edited (payload draft_id must equal the path id)", auth: "member", command: "drafts.approve.v1", response: "command-result", status: 200, pathParams: [{ name: "id", uuid: true }], conflict: true, errors: "drafts.decision-error" },
  { surface: "public", method: "post", path: "/v1/drafts/{id}:reject", operationId: "rejectDraft", summary: "drafts.reject.v1 — reject with a reason (payload draft_id must equal the path id)", auth: "member", command: "drafts.reject.v1", response: "command-result", status: 200, pathParams: [{ name: "id", uuid: true }], conflict: true, errors: "drafts.decision-error" },
];
