// Investigations in Step mode (ledger R45 F1, F10; ADR-014 §7.2–§7.5; T-083). Core runs the playbook
// (`@munim/core-domain/investigations`): each `:continue` mints that step's templates as member snapshots in the
// investigation's outlet scope, judges every verdict in code, writes the step, then asks intel to narrate it.
//   POST /v1/investigations                 {investigation_id, playbook_id, params, outlet_scope?} → 201
//   GET  /v1/investigations/{id}            → the investigation with its steps
//   POST /v1/investigations/{id}:continue   {step_no} → 200 (runs exactly that step)
// Idempotency without a command log (0020's rows are operational): the client names the investigation id and the
// step it means. The same id / step again by the same member is a replay (`X-Munim-Replayed: true`, the current
// view); another body under that id → 409 `idempotency_conflict`; a step number that is not the next → 409
// `sequence_gap`. Two concurrent `:continue {step_no: n}` therefore make exactly one step.
// Visibility is 0020's scope rule: an investigation outside the viewer's outlet scope is 404 (review M7).
// T-084b adds the list route, `:cancel` and SSE; T-089a adds `mode`.
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
});

export const ContinueInvestigationRequest = z.strictObject({
  /** The step this request means: `steps_done + 1` when sent (its idempotency key). */
  step_no: z.int().min(1).max(10),
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
  status: ItemStatus,
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
  from: ItemStatus,
  to: ItemStatus,
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

export const InvestigationView = z.strictObject({
  investigation_id: Uuid7,
  playbook_id: PlaybookId,
  params: MarginFallParams,
  outlet_scope: OutletScope,
  mode: z.enum(["step", "plan", "auto"]),
  status: InvestigationStatus,
  stop_reason: z.enum(["draft", "abstain", "budget", "scope", "waiting"]).nullable(),
  created_by: Uuid7,
  steps_done: z.int().min(0),
  max_steps: z.int().min(1).max(10),
  checklist: z.array(ChecklistItemView),
  steps: z.array(StepView),
  /** Every snapshot-cell ref in the checklist, the steps and the narrations that resolves for this viewer. */
  resolved_refs: z.array(ResolvedRef),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
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
  "v1.investigation": InvestigationView,
  "investigations.narrate.request": NarrateRequest,
  "investigations.narrate.response": NarrateResponse,
};

const ID = [{ name: "id", uuid: true }];

export const ROUTES: readonly Route[] = [
  {
    surface: "public", method: "post", path: "/v1/investigations", operationId: "createInvestigation",
    summary: "Open an investigation (Step mode) for a playbook over the caller's outlet scope; the client's id is its idempotency key",
    auth: "member", request: "v1.investigation.create.request", response: "v1.investigation", status: 201, conflict: true,
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
];
