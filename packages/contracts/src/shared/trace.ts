// Trace events (03-architecture §1.8) — the back office's only input. Payloads carry ids and short
// labels only. `review` (T-002 extension, screens gap G-OFF-3) records a deal-review verdict with a
// typed payload: pass / fail / cannot_verify + reason_code + refs.
import { z } from "zod";
import { IsoDateTime, Uuid7 } from "./primitives.ts";
import { ReasonCode } from "./reason-codes.ts";
import { RefId } from "./refs.ts";

export const TRACE_KINDS = [
  "route",
  "skill_load",
  "subagent_start",
  "subagent_end",
  "tool_call",
  "tool_result",
  "a2a_send",
  "a2a_receive",
  "finding",
  "draft",
  "abstain",
  "error",
  "review",
] as const;
export const TraceKind = z.enum(TRACE_KINDS);

/** One token of at most 200 characters, no whitespace: the same pattern as intel's `check_payload` (trace/buffer.py), so
 *  core refuses a prose payload even if a caller skipped intel's check (defence in depth, rule 8). */
/** A bare number of 4+ digits (or digits and dots: "450000", "4500.50") is refused: a figure must come from a snapshot cell, never ride in a
 *  trace (R25). Short counts ("round" 1, "claims" 3 in intel's negotiate / ingest traces) are legitimate labels, hence the 4-char floor. */
const Label = z.string().regex(/^(?![0-9][0-9.]{3,}$)[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/);
export const TracePayload = z.record(z.string().regex(/^[a-z_][a-z0-9_]*$/), z.union([Label, z.array(Label)]));

/** Deal-review verdict. The review is deterministic (SQL + rules); `fail` and `cannot_verify` name the
 *  rule's reason_code; `pass` has none. `refs` are the snapshot / quote rows the rules read. */
export const ReviewVerdict = z.enum(["pass", "fail", "cannot_verify"]);
export const ReviewPayload = z
  .strictObject({
    verdict: ReviewVerdict,
    reason_code: ReasonCode.nullable(),
    refs: z.array(RefId).min(1),
    /** What was reviewed, e.g. the quote or draft id. */
    subject_id: Uuid7.nullable(),
  })
  .superRefine((p, ctx) => {
    if ((p.verdict === "pass") !== (p.reason_code === null))
      ctx.addIssue({ code: "custom", path: ["reason_code"], message: "reason_code is set exactly when the verdict is not pass" });
  });
export type ReviewPayload = z.infer<typeof ReviewPayload>;

const common = {
  id: Uuid7,
  seq: z.int().min(1),
  parent_id: Uuid7.nullable(),
  /** Agent or branch name. */
  actor: z.string().regex(/^[a-z][a-z0-9_.:-]{0,99}$/),
  at: IsoDateTime,
};
const GENERIC_KINDS = TRACE_KINDS.filter((k) => k !== "review") as Array<Exclude<(typeof TRACE_KINDS)[number], "review">>;

/** As intel sends it in `traces:batch` (run and tenant come from the run token). */
export const TraceEventInput = z.discriminatedUnion("kind", [
  z.strictObject({ ...common, kind: z.enum(GENERIC_KINDS as [string, ...string[]]), payload: TracePayload }),
  z.strictObject({ ...common, kind: z.literal("review"), payload: ReviewPayload }),
]);
export type TraceEventInput = z.infer<typeof TraceEventInput>;

/** As stored (`intel.trace_event`) and replayed by `(run_id, seq)`. */
export const TraceEvent = z.discriminatedUnion("kind", [
  z.strictObject({ run_id: Uuid7, ...common, kind: z.enum(GENERIC_KINDS as [string, ...string[]]), payload: TracePayload }),
  z.strictObject({ run_id: Uuid7, ...common, kind: z.literal("review"), payload: ReviewPayload }),
]);
export type TraceEvent = z.infer<typeof TraceEvent>;
