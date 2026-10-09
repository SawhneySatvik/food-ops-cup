// @munim/contracts (root export) — shared types every module builds on: ids, money, time, refs and their
// parser regexes, number-grammar data, reason codes, envelopes, the draft payload rule, run-token claims,
// the CloudEvents envelope, trace events, the command envelope, snapshots and the error body.
import { CommandEnvelope, CommandResult } from "./command.ts";
import { CloudEvent } from "./cloudevents.ts";
import { PersonEdit } from "./draft.ts";
import { AnswerEnvelope, FindingEnvelope } from "./envelope.ts";
import { ErrorResponse } from "./error.ts";
import { IsoDateTime, Money, Uuid7 } from "./primitives.ts";
import { ReasonCode } from "./reason-codes.ts";
import { Ref, RefId } from "./refs.ts";
import type { Route } from "./routes.ts";
import { RunTokenClaims } from "./run-token.ts";
import { Snapshot } from "./snapshot.ts";
import { ReviewPayload, TraceEvent } from "./trace.ts";

export * from "./primitives.ts";
export * from "./refs.ts";
export * from "./grammar/index.ts";
export * from "./reason-codes.ts";
export * from "./envelope.ts";
export * from "./draft.ts";
export * from "./draftables.ts";
export * from "./run-token.ts";
export * from "./cloudevents.ts";
export * from "./trace.ts";
export * from "./command.ts";
export * from "./snapshot.ts";
export * from "./error.ts";
export type * from "./routes.ts";

export const SCHEMAS = {
  uuid7: Uuid7,
  "iso-datetime": IsoDateTime,
  money: Money,
  ref: Ref,
  "ref-id": RefId,
  "reason-code": ReasonCode,
  "answer-envelope": AnswerEnvelope,
  "finding-envelope": FindingEnvelope,
  "person-edit": PersonEdit,
  "run-token-claims": RunTokenClaims,
  cloudevent: CloudEvent,
  "trace-event": TraceEvent,
  "trace-review-payload": ReviewPayload,
  "command-envelope": CommandEnvelope,
  "command-result": CommandResult,
  snapshot: Snapshot,
  error: ErrorResponse,
};
export const ROUTES: readonly Route[] = [];
