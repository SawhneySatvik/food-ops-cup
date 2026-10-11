// Cite-or-abstain output envelopes (03-architecture §1.7, 04-agent-framework §4). Prose carries refs,
// never typed numbers or quotations; core-api validates (number grammar, refs resolve in-tenant, every
// fact-bearing segment carries ≥ 1 ref) and, on failure, stores abstained = true + reason_code.
// The cross-field rules below (abstained ⇔ reason_code; a non-abstained finding has an impact_ref) are
// zod refinements: core-api enforces them; they do not appear in JSON Schema / Pydantic.
import { z } from "zod";
import { Uuid7 } from "./primitives.ts";
import { ReasonCode } from "./reason-codes.ts";
import { RefId, SnapCellRef } from "./refs.ts";

export const Segment = z.strictObject({
  text: z.string().min(1).max(2000),
  /** Bare ids of every ref used in `text` (e.g. "snap:<id>", "row:core.supplier_price:<id>"). */
  refs: z.array(RefId),
});
export type Segment = z.infer<typeof Segment>;

// `reason_code` may be absent or null when not abstained: intel's generated Pydantic models serialise an unset
// Optional as `null`, and a strict `.optional()` refused every such envelope with 422 (T-040, found against T-041's client).
const abstainRule = (e: { abstained: boolean; reason_code?: ReasonCode | null | undefined }, ctx: z.RefinementCtx) => {
  if (e.abstained && e.reason_code == null)
    ctx.addIssue({ code: "custom", path: ["reason_code"], message: "an abstained envelope names a reason_code" });
  if (!e.abstained && e.reason_code != null)
    ctx.addIssue({ code: "custom", path: ["reason_code"], message: "reason_code only on an abstained envelope" });
};

/** A one-tap follow-up offered under an answer (ledger R47 D5). `dig_deeper`: the Manager routed the question as an
 *  investigation without a scored band, so it answered alone instead of fanning out; the member may ask it to dig
 *  deeper across the specialists. Nullish for the same Pydantic reason as `reason_code`. */
export const FollowUp = z.enum(["dig_deeper"]);
export type FollowUp = z.infer<typeof FollowUp>;

/** `{answer_id, segments[{text, refs[]}], abstained, reason_code?, follow_up?}` (03-architecture §1.7). */
export const AnswerEnvelope = z
  .strictObject({
    answer_id: Uuid7,
    segments: z.array(Segment),
    abstained: z.boolean(),
    reason_code: ReasonCode.nullish(),
    follow_up: FollowUp.nullish(),
  })
  .superRefine(abstainRule);
export type AnswerEnvelope = z.infer<typeof AnswerEnvelope>;

/** A finding's prose. `impact_ref` is the snapshot cell holding the finding's money/quantity impact
 *  (04-agent-framework §4 check 5); null only when abstained. */
export const FindingEnvelope = z
  .strictObject({
    finding_id: Uuid7,
    segments: z.array(Segment),
    impact_ref: SnapCellRef.nullable(),
    abstained: z.boolean(),
    reason_code: ReasonCode.nullish(),
  })
  .superRefine((e, ctx) => {
    abstainRule(e, ctx);
    if (!e.abstained && e.impact_ref === null)
      ctx.addIssue({ code: "custom", path: ["impact_ref"], message: "a finding that is not abstained has an impact_ref" });
  });
export type FindingEnvelope = z.infer<typeof FindingEnvelope>;
