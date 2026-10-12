// Investigations in Step and Plan mode (ledger R45 F1, F10; ADR-014 §7.2–§7.5; T-083, T-084b, T-089a). Core runs the
// playbook (`@munim/core-domain/investigations`): each step mints that step's templates as member snapshots in the
// investigation's outlet scope, judges every verdict in code, writes the step, then asks intel to narrate it.
//   POST /v1/investigations                    {investigation_id, playbook_id, params, outlet_scope?, mode?} → 201
//   GET  /v1/investigations                    ?status=&cursor=&limit= → the caller's visible investigations
//   GET  /v1/investigations/{id}               → the investigation with its steps (and its plan preview in Plan mode)
//   POST /v1/investigations/{id}:continue      {step_no} → 200 (runs exactly that step)
//   POST /v1/investigations/{id}:cancel        {} → 200 (cancelled; any later :continue → 409)
//   POST /v1/investigations/{id}:approve-plan  {mode?} → 200 after the approved steps ran, inside this request (≤ max_steps)
// Mode (F10): the creator picks it within their role's ceiling (core.ai_policy, T-090; above it → 403
// `mode_above_ceiling`). A Plan-mode investigation shows a preview —
// its checklist items, the specialists involved and the estimated AI cost as a snapshot ref of
// `intel.investigation_cost_estimate`, labelled "estimate (computed)" — and runs once its creator approves it. The steps
// stop at `waiting`, an abstained narration, the budget or a scope change (`stop_reason`); a member's `:continue`
// resumes at `steps_done + 1`. Progress streams on `inbox:<tenant>` as `inbox.investigation` events (ids and status).
// Auto (T-089b; F10, F11 O-1) is Plan approved with `{mode: "auto"}`: the approval also gives the creator's standing
// grant, and core-worker then resumes the investigation (steps `triggered_by: "auto"`) when an approved import can
// complete what it waits on, and daily — re-checking the creator's current scope (else cancelled), the role ceiling
// and the month's AI budget before every step. `mode: "auto"` at create opens the plan (shown as `plan` until approved).
// Idempotency without a command log (0020's rows are operational): the client names the investigation id and the
// step it means. The same id / step again by the same member is a replay (`X-Munim-Replayed: true`, the current
// view); another body under that id → 409 `idempotency_conflict`; a step number that is not the next → 409
// `sequence_gap`. Two concurrent `:continue {step_no: n}` therefore make exactly one step.
// Visibility is 0020's scope rule: an investigation outside the viewer's outlet scope is 404 (review M7).
import { z } from "zod";
import { ResolvedRef } from "../approvals/index.ts";
import { SpecialistId } from "../threads/index.ts";
import { AnswerEnvelope } from "../shared/envelope.ts";
import { IsoDate, IsoDateTime, OutletScope, Slug, Uuid7 } from "../shared/primitives.ts";
import { SnapCellRef } from "../shared/refs.ts";
import type { Route } from "../shared/routes.ts";

export const PlaybookId = z.enum(["margin_fall"]);
export const ItemStatus = z.enum(["pending", "supported", "refuted", "cannot_verify"]);
export const InvestigationStatus = z.enum(["open", "waiting", "done", "no_driver_found", "cannot_verify", "cancelled", "exhausted"]);
export const InvestigationMode = z.enum(["step", "plan", "auto"]);
/** As shown to a viewer (R-D "redact per viewer"): an item whose template is above the viewer's role, or whose verdict
 *  snapshots do not open for them, is `restricted` (no verdict, refs or narration); the investigation's own status is
 *  `restricted` unless the viewer may open every template its playbook judges on. */
export const ShownItemStatus = z.enum([...ItemStatus.options, "restricted"]);
export const ShownInvestigationStatus = z.enum([...InvestigationStatus.options, "restricted"]);
/** Why a Plan (or Auto) run stopped; null while it runs, or when it ended in a terminal status. `draft` is reserved:
 *  investigations create no drafts and no draft linking exists in v1 (ADR-014 §7.2), so nothing records it yet.
 *  `ceiling`: the creator's role ceiling no longer allows Auto, so core-worker downgraded the run to Plan (0027; mode
 *  reads `plan`, and the creator's `:continue` steps it). */
export const StopReason = z.enum(["draft", "abstain", "budget", "scope", "waiting", "ceiling"]);

/** A month is named by its first day. */
const Month = IsoDate.refine((d) => d.endsWith("-01"), "the first day of a month");

export const MarginFallParams = z
  .strictObject({ period_month: Month, compare_month: Month })
  .refine((p) => p.compare_month < p.period_month, "compare_month is before period_month");

export const CreateInvestigationRequest = z.strictObject({
  /** The client's id for this investigation (its idempotency key). */
  investigation_id: Uuid7,
  playbook_id: PlaybookId,
  params: MarginFallParams,
  /** Omitted → the creator's whole outlet scope. Must lie inside it (else 404). */
  outlet_scope: OutletScope.optional(),
  /** Omitted → `step`. Above the creator's role ceiling → 403 `mode_above_ceiling`. `auto` opens a plan to approve as Auto. */
  mode: InvestigationMode.optional(),
});

export const ContinueInvestigationRequest = z.strictObject({
  /** The step this request means: `steps_done + 1` when sent (its idempotency key). */
  step_no: z.int().min(1).max(10),
});

/** `:cancel` carries no fields and `:approve-plan` only the mode: the investigation id is the key, and both are set once. */
export const CancelInvestigationRequest = z.strictObject({});
export const ApprovePlanRequest = z.strictObject({
  /** Omitted → `plan`. `auto` needs the role's ceiling at `auto` (403) and an unapproved plan (an approved Plan → 409). */
  mode: z.enum(["plan", "auto"]).optional(),
});

/** "{Specialist}" on an item or a narrated segment, composed by core from the playbook (intel never sends it). */
export const ItemSignature = z.strictObject({
  key: z.literal("investigation.signature.specialist"),
  specialist: SpecialistId,
  name_key: z.string().min(1),
});

export const ChecklistItemView = z.strictObject({
  item_id: Slug,
  label_key: z.string().min(1),
  specialist: SpecialistId,
  signature: ItemSignature,
  status: ShownItemStatus,
  /** A supported item is frozen; only the final re-mint before `done` judges it again. */
  frozen: z.boolean(),
  /** The snapshots its last verdict was judged on. */
  snapshot_ids: z.array(Uuid7),
  /** The cells its verdict read (canonical refs); their values are in the view's `resolved_refs`. */
  refs: z.array(SnapCellRef),
});

export const ItemUpdate = z.strictObject({
  item_id: Slug,
  specialist: SpecialistId,
  from: ShownItemStatus,
  to: ShownItemStatus,
  frozen: z.boolean(),
  /** A frozen item whose verdict flipped at the final re-mint (ADR-014 §7.4). */
  reopened: z.boolean(),
  snapshot_ids: z.array(Uuid7),
  refs: z.array(SnapCellRef),
});

/** The step's narration: one segment per item update, in order; `signatures[i]` signs `envelope.segments[i]`. */
export const StepNarration = z.strictObject({
  answer_id: Uuid7,
  envelope: AnswerEnvelope,
  signatures: z.array(ItemSignature),
});

export const StepView = z.strictObject({
  step_no: z.int().min(1),
  member_id: Uuid7,
  triggered_by: z.enum(["member", "plan", "auto"]),
  started_at: IsoDateTime,
  item_updates: z.array(ItemUpdate),
  tainted: z.boolean(),
  /** null until narrated (or when the narration could not be linked). */
  narration: StepNarration.nullable(),
});

/** The estimated AI cost of a plan: cells of an `intel.investigation_cost_estimate` snapshot (v2, 0025) minted for the
 *  creator when the plan was opened (never a typed number; values in the view's `resolved_refs`). `cannot_verify` (refs
 *  null) when the template has no row — no run-linked step of this playbook has recorded spend yet — or is above the
 *  creator's role. */
export const PlanEstimate = z.strictObject({
  label: z.literal("estimate (computed)"),
  status: z.enum(["computed", "cannot_verify"]),
  snapshot_id: Uuid7.nullable(),
  /** `estimate_minor` = `per_step_minor` × `remaining_steps`: the average spend of a run-linked step of this playbook
   *  (steps with no spend count as 0) × the expected remaining steps (max_steps − steps done, capped by the checklist
   *  items not yet frozen; 0 once the investigation is terminal). One step judges every evaluable item in one call. */
  estimate_ref: SnapCellRef.nullable(),
  currency_ref: SnapCellRef.nullable(),
});

/** What a member approves in Plan mode (F10): the checklist items, the specialists involved, the estimated AI cost. */
export const PlanPreview = z.strictObject({
  items: z.array(z.strictObject({ item_id: Slug, label_key: z.string().min(1), specialist: SpecialistId })).min(1),
  /** Distinct, in checklist order. */
  specialists: z.array(SpecialistId).min(1),
  estimate: PlanEstimate,
  approved_by: Uuid7.nullable(),
  approved_at: IsoDateTime.nullable(),
});

/** One investigation in a list: no checklist, steps or values. */
export const InvestigationItem = z.strictObject({
  investigation_id: Uuid7,
  playbook_id: PlaybookId,
  params: MarginFallParams,
  outlet_scope: OutletScope,
  mode: InvestigationMode,
  status: ShownInvestigationStatus,
  stop_reason: StopReason.nullable(),
  created_by: Uuid7,
  steps_done: z.int().min(0),
  max_steps: z.int().min(1).max(10),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
});

export const InvestigationsListResponse = z.strictObject({ items: z.array(InvestigationItem), next_cursor: z.string().nullable() });

export const InvestigationView = z.strictObject({
  ...InvestigationItem.shape,
  checklist: z.array(ChecklistItemView),
  /** Plan and Auto mode only (null in Step mode). */
  plan: PlanPreview.nullable(),
  steps: z.array(StepView),
  /** Every snapshot-cell ref in the checklist, the steps, the narrations and the plan estimate that resolves for this viewer. */
  resolved_refs: z.array(ResolvedRef),
});

/** One item core asks intel to narrate: its verdict, the cells it may cite and core's template sentence. */
export const NarrateItem = z.strictObject({
  item_id: Slug,
  specialist: SpecialistId,
  verdict: ItemStatus,
  /** The cells the verdict read (canonical refs). intel shows the model handles for them, never values. */
  cells: z.array(z.strictObject({ ref: SnapCellRef, column: Slug })).min(1).max(12),
  /** Core's digit-free sentence citing those cells: the narration when the model's is unusable or not run. */
  template: z.string().min(1).max(2000),
});

/** core → intel `/investigate:narrate` (the step's `ask` run token rides as the bearer). intel stores ONE answer under
 *  `answer_id` with `question` unchanged, one segment per item in order, and makes at most one model call (no tools). */
export const NarrateRequest = z.strictObject({
  answer_id: Uuid7,
  question: z.string().min(1).max(200),
  playbook_id: PlaybookId,
  /** The playbook's owning specialist (04 §12.1): the actor of the narration run's traces. */
  owner: SpecialistId,
  items: z.array(NarrateItem).min(1).max(12),
});

/** intel → core: the stored answer's id, the run's taint (always false here: only core cells reach the model) and
 *  where the prose came from. No signature, no prose. */
export const NarrateResponse = z.strictObject({
  answer_id: Uuid7,
  tainted: z.boolean(),
  source: z.enum(["model", "template"]),
});

export const SCHEMAS = {
  "v1.investigation.create.request": CreateInvestigationRequest,
  "v1.investigation.continue.request": ContinueInvestigationRequest,
  "v1.investigation.cancel.request": CancelInvestigationRequest,
  "v1.investigation.approve-plan.request": ApprovePlanRequest,
  "v1.investigation": InvestigationView,
  "v1.investigations.response": InvestigationsListResponse,
  "investigations.narrate.request": NarrateRequest,
  "investigations.narrate.response": NarrateResponse,
};

const ID = [{ name: "id", uuid: true }];

export const ROUTES: readonly Route[] = [
  {
    surface: "public", method: "post", path: "/v1/investigations", operationId: "createInvestigation",
    summary: "Open an investigation (Step or Plan mode, within the role's ceiling) for a playbook over the caller's outlet scope; the client's id is its idempotency key",
    auth: "member", request: "v1.investigation.create.request", response: "v1.investigation", status: 201, conflict: true,
  },
  {
    surface: "public", method: "get", path: "/v1/investigations", operationId: "listInvestigations",
    summary: "Investigations in the caller's outlet scope, most recently changed first; ?status= one status",
    auth: "member", response: "v1.investigations.response", status: 200,
    query: [
      { name: "status", required: false, schema: { type: "string", enum: [...InvestigationStatus.options] } },
      { name: "cursor", required: false, schema: { type: "string" } },
      { name: "limit", required: false, schema: { type: "integer", minimum: 1, maximum: 100 } },
    ],
  },
  {
    surface: "public", method: "get", path: "/v1/investigations/{id}", operationId: "getInvestigation",
    summary: "An investigation with its checklist, steps and narrations (404 outside the caller's outlet scope)",
    auth: "member", response: "v1.investigation", status: 200, pathParams: ID,
  },
  {
    surface: "public", method: "post", path: "/v1/investigations/{id}:continue", operationId: "continueInvestigation",
    summary: "Run exactly the named next step: mint, judge in code, store, narrate",
    auth: "member", request: "v1.investigation.continue.request", response: "v1.investigation", status: 200, pathParams: ID, conflict: true,
  },
  {
    surface: "public", method: "post", path: "/v1/investigations/{id}:cancel", operationId: "cancelInvestigation",
    summary: "Cancel an open or waiting investigation (its creator); a repeat is a replay, a later :continue is 409",
    auth: "member", request: "v1.investigation.cancel.request", response: "v1.investigation", status: 200, pathParams: ID, conflict: true,
  },
  {
    surface: "public", method: "post", path: "/v1/investigations/{id}:approve-plan", operationId: "approveInvestigationPlan",
    summary: "Approve a Plan-mode investigation (its creator, within the role's ceiling), as Plan or Auto, and run its steps inside this request until a stop",
    auth: "member", request: "v1.investigation.approve-plan.request", response: "v1.investigation", status: 200, pathParams: ID, conflict: true,
  },
];
