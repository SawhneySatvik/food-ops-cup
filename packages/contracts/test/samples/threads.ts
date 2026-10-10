import { envelopeSegments } from "./shared.ts";
import { MEMBER, OUTLET, S1, T, T_PG, snapRef, u } from "./_ids.ts";

const summaryRef = { turn_no: 1, answer_id: u(110), segment: 0, refs: [`snap:${S1}`, `row:core.reorder_level:${u(41)}`] };
const block = { thread_id: u(120), summary_refs: [summaryRef], last_turn_ids: [u(121), u(122)], tainted: false };
const answer = {
  answer_id: u(110),
  envelope: { answer_id: u(110), segments: envelopeSegments, abstained: false, reason_code: null },
  resolved_refs: [{ ref: snapRef(S1, 0, "on_hand_qty_milli"), value: 1500 }],
  signature: { key: "answer.signature.via_manager", specialist: "finance", name_key: "specialist.finance.name" },
};
const item = { thread_id: u(120), specialist: "finance", created_by: MEMBER, outlet_scope: [OUTLET], created_at: T, updated_at: T_PG };

export const SAMPLES: Record<string, unknown> = {
  "v1.ask.request": { question: "@Finance why did the payout fall short last week?", thread_id: u(120) },
  "v1.ask.response": { thread_id: u(120), turn: { turn_id: u(122), turn_no: 2, addressed_to: "finance", tainted: false }, answer },
  "v1.thread": {
    ...item,
    summary: [summaryRef],
    turns: [
      { turn_id: u(121), turn_no: 1, member_id: MEMBER, addressed_to: "finance", tainted: false, question: "@Finance what is short?", answer, created_at: T },
      { turn_id: u(122), turn_no: 2, member_id: MEMBER, addressed_to: "finance", tainted: true, question: "and the reviews?",
        answer: { answer_id: u(111), envelope: { answer_id: u(111), segments: [], abstained: true, reason_code: "missing_ref" }, resolved_refs: [],
          signature: { key: "answer.signature.via_manager", specialist: "finance", name_key: "specialist.finance.name" } }, created_at: T_PG },
    ],
  },
  "v1.threads.response": { items: [item, { ...item, thread_id: u(123), specialist: null, outlet_scope: ["*"] }], next_cursor: null },
  "threads.block": block,
  "threads.intel-ask.request": { answer_id: u(111), question: "@Finance and the reviews?", addressed_to: "finance", thread: block },
  "threads.intel-ask.response": { answer_id: u(111), tainted: true },
};
