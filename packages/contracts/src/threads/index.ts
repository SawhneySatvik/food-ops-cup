// Threads and addressing, core half (ledger R45 F9, T-088a; 04 §12.2). `POST /v1/ask {question, thread_id?}`: core
// parses a leading `@Name` against the registry aliases (deterministic, never a model), runs the ask, and writes the
// turn after the answer is stored. `GET /v1/threads?specialist=`, `GET /v1/threads/{id}`. Thread rows are operational
// (0020), visible when the viewer's outlet scope covers the thread's.
// The signature "{Specialist} · via Manager" is composed by core as an i18n key + the specialist's name key; intel
// never sends signature text (no field for it below).
import { z } from "zod";
import { ResolvedRef } from "../approvals/index.ts";
import { SPECIALIST_REGISTRY } from "../intel/specialists.ts";
import { AnswerEnvelope } from "../shared/envelope.ts";
import { IsoDateTime, OutletScope, Uuid7 } from "../shared/primitives.ts";
import { RefId } from "../shared/refs.ts";
import type { Route } from "../shared/routes.ts";

const ids = SPECIALIST_REGISTRY.specialists.filter((s) => s.kind === "specialist").map((s) => s.id);
/** The eight F8 specialists (0020's CHECK on `specialist` / `addressed_to`). The Manager and Forecast are not. */
export const SpecialistId = z.enum(ids as [string, ...string[]]);

export const AskRequest = z.strictObject({
  question: z.string().trim().min(1).max(2000),
  /** Omitted → a new thread (its specialist = the addressed one, or none for the main conversation). */
  thread_id: Uuid7.optional(),
  /** R47 D5: the member tapped "dig deeper across specialists?" (an answer's `follow_up: dig_deeper`): an unaddressed investigation
   *  fans out across the specialists even when the routing guess is unscored. Changes nothing for any other kind of question. */
  deep: z.boolean().optional(),
});

/** One rolling-summary item: a validated, cited segment of an answered, untainted turn (ids and refs, no prose). */
export const SummaryRef = z.strictObject({
  turn_no: z.int().min(1),
  answer_id: Uuid7,
  segment: z.int().min(0),
  refs: z.array(RefId).min(1),
});

/** The run-frame thread block (04 §1 `thread?{summary_refs, last_turn_ids[≤3], tainted}`). `tainted` = OR over the
 *  last ≤ 3 turns; a tainted turn never enters `summary_refs`, even after it ages out of the last 3 (B1). */
export const ThreadBlock = z.strictObject({
  thread_id: Uuid7,
  summary_refs: z.array(SummaryRef).max(8),
  last_turn_ids: z.array(Uuid7).max(3),
  tainted: z.boolean(),
});

/** Core's composed signature: `key` with `name_key` as the {specialist} parameter. */
export const Signature = z.strictObject({
  key: z.enum(["answer.signature.via_manager", "answer.signature.manager"]),
  specialist: z.union([SpecialistId, z.literal("manager")]),
  name_key: z.string().min(1),
});

export const AnswerView = z.strictObject({
  answer_id: Uuid7,
  /** The stored, core-validated envelope (an abstention when validation failed). */
  envelope: AnswerEnvelope,
  /** Every snapshot-cell ref in the envelope that resolves for this viewer, with its value. */
  resolved_refs: z.array(ResolvedRef),
  signature: Signature,
});

export const TurnView = z.strictObject({
  turn_id: Uuid7,
  turn_no: z.int().min(1),
  member_id: Uuid7,
  addressed_to: SpecialistId.nullable(),
  tainted: z.boolean(),
  /** The member's question, as they sent it (core refuses an answer stored under any other text). */
  question: z.string().nullable(),
  answer: AnswerView.nullable(),
  created_at: IsoDateTime,
});

export const ThreadItem = z.strictObject({
  thread_id: Uuid7,
  specialist: SpecialistId.nullable(),
  created_by: Uuid7,
  outlet_scope: OutletScope,
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
});

export const ThreadView = z.strictObject({
  ...ThreadItem.shape,
  summary: z.array(SummaryRef).max(8),
  turns: z.array(TurnView),
});

export const ThreadsListResponse = z.strictObject({ items: z.array(ThreadItem), next_cursor: z.string().nullable() });

export const AskResponse = z.strictObject({
  thread_id: Uuid7,
  turn: z.strictObject({ turn_id: Uuid7, turn_no: z.int().min(1), addressed_to: SpecialistId.nullable(), tainted: z.boolean() }),
  answer: AnswerView,
});

/** core → intel `/ask` body (the run token rides as the bearer). `answer_id` is core's handle: intel stores its
 *  answer under it through `/internal/intel/v1/answers`. `thread` is core-composed (intel never picks the thread). */
export const IntelAskRequest = z.strictObject({
  answer_id: Uuid7,
  question: z.string().min(1).max(2000),
  addressed_to: SpecialistId.nullable(),
  thread: ThreadBlock.nullable(),
  /** The member's `deep` flag on `POST /v1/ask` (R47 D5); absent = false. */
  deep: z.boolean().optional(),
});
/** intel → core: the stored answer's id and the run's taint (RunState.tainted). No signature, no prose. */
export const IntelAskResponse = z.strictObject({ answer_id: Uuid7, tainted: z.boolean() });

export const SCHEMAS = {
  "v1.ask.request": AskRequest,
  "v1.ask.response": AskResponse,
  "v1.thread": ThreadView,
  "v1.threads.response": ThreadsListResponse,
  "threads.block": ThreadBlock,
  "threads.intel-ask.request": IntelAskRequest,
  "threads.intel-ask.response": IntelAskResponse,
};

const read = (r: Omit<Route, "surface" | "method" | "auth" | "status">): Route => ({ surface: "public", method: "get", auth: "member", status: 200, ...r });

export const ROUTES: readonly Route[] = [
  {
    surface: "public",
    method: "post",
    path: "/v1/ask",
    operationId: "ask",
    summary: "Ask the Manager, or a specialist by a leading @Name; appends a turn to a thread (new or given)",
    auth: "member",
    request: "v1.ask.request",
    response: "v1.ask.response",
    status: 200,
    conflict: true,
  },
  read({
    path: "/v1/threads", operationId: "listThreads", summary: "Threads in the caller's outlet scope; ?specialist= those addressed to that desk",
    response: "v1.threads.response",
    query: [
      { name: "specialist", required: false, schema: { type: "string", enum: [...SpecialistId.options, "manager"] } },
      { name: "cursor", required: false, schema: { type: "string" } },
      { name: "limit", required: false, schema: { type: "integer", minimum: 1, maximum: 100 } },
    ],
  }),
  read({ path: "/v1/threads/{id}", operationId: "getThread", summary: "A thread with its turns, answers and rolling cited summary", response: "v1.thread", pathParams: [{ name: "id", uuid: true }] }),
];
