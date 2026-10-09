// The one error body (packages/contracts/src/shared/error.ts: {error: {code, message, reason_code}}).
// `message` comes from the fixed table below, chosen by code — never from an exception, SQL error or model
// output (One Guarantee: error channels carry no untrusted text).
import type { ErrorResponse, ReasonCode } from "@munim/contracts";
import type { ContentfulStatusCode } from "hono/utils/http-status";

const MESSAGES = {
  bad_request: "The request is not valid.",
  unauthenticated: "Sign in again.",
  forbidden: "You are not allowed to do this.",
  not_found: "Not found.",
  conflict: "This changed since you loaded it.",
  book_write_refused: "This change needs a person with authority to make or approve it.",
  country_locked: "Country, currency and financial year are fixed after onboarding.",
  currency_mismatch: "Amounts must be in the business's currency.",
  illegal_transition: "That status change is not allowed from the current status.",
  override_refused: "This override cannot be used.",
  decision_refused: "Only the signed-in approver, with authority for this change, can decide it.",
  customer_erased: "This customer profile has been erased.",
  command_table_mismatch: "This action cannot change that record.",
  period_closed: "That period is closed; post it in an open period.",
  books_unbalanced: "The entry does not balance.",
  loyalty_refused: "There are not enough loyalty points for this.",
  claim_quote_mismatch: "The quoted text does not match its source.",
  out_of_pack_scope: "This is not available in your country pack.",
  sequence_gap: "Out of sequence; retry.",
  // Commit helper (T-005)
  idempotency_conflict: "This request key was already used for a different request.",
  command_type_mismatch: "This command does not belong to this route.",
  // Approvals (contracts `drafts.decision-error`, T-008)
  invalid_payload: "This proposal or your changes are not valid.",
  unregistered_command_type: "This kind of proposal cannot be approved here.",
  cannot_verify: "Cannot verify: a number in this proposal no longer traces to its source rows.",
  already_decided: "This proposal was already decided.",
  stale_draft: "This proposal is out of date: the numbers it relied on have changed.",
  execution_failed: "Approved, but it could not be applied. Nothing was changed.",
  unavailable: "The service is unavailable.",
  internal: "Something went wrong.",
} as const;
export type ErrorCode = keyof typeof MESSAGES;
export const ERROR_CODES = Object.keys(MESSAGES) as ErrorCode[];

const STATUS: Record<ErrorCode, ContentfulStatusCode> = {
  bad_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  book_write_refused: 403,
  country_locked: 409,
  currency_mismatch: 422,
  illegal_transition: 409,
  override_refused: 403,
  decision_refused: 403,
  customer_erased: 409,
  command_table_mismatch: 403,
  period_closed: 409,
  books_unbalanced: 422,
  loyalty_refused: 409,
  claim_quote_mismatch: 422,
  out_of_pack_scope: 422,
  sequence_gap: 409,
  idempotency_conflict: 409,
  command_type_mismatch: 422,
  invalid_payload: 422,
  unregistered_command_type: 422,
  cannot_verify: 422,
  already_decided: 409,
  stale_draft: 409,
  execution_failed: 422,
  unavailable: 503,
  internal: 500,
};

/** Fields a route's documented error schema adds beside `error` (e.g. `drafts.decision-error`: `changes`, `refs`).
 *  Core-composed ids and cells only — never exception or model text. */
export type ErrorExtra = { changes?: unknown[]; refs?: string[] };

export class ApiError extends Error {
  override name = "ApiError";
  readonly status: ContentfulStatusCode;
  readonly code: ErrorCode;
  readonly reason_code: ReasonCode | null;
  readonly extra: ErrorExtra;
  constructor(code: ErrorCode, reason_code: ReasonCode | null = null, extra: ErrorExtra = {}) {
    super(code);
    this.code = code;
    this.reason_code = reason_code;
    this.extra = extra;
    this.status = STATUS[code];
  }
  body(): ErrorResponse & ErrorExtra {
    return { ...errorBody(this.code, this.reason_code), ...this.extra };
  }
}

export function errorBody(code: ErrorCode, reason_code: ReasonCode | null = null): ErrorResponse {
  return { error: { code, message: MESSAGES[code], reason_code } };
}

// Database refusals (db/README "SQLSTATEs"): the trigger's verdict is mapped to a code; its text is not used.
const SQLSTATES: Record<string, { code: ErrorCode; reason_code: ReasonCode | null }> = {
  MB001: { code: "book_write_refused", reason_code: "authority_denied" },
  MB002: { code: "country_locked", reason_code: null },
  MB003: { code: "currency_mismatch", reason_code: null },
  MB004: { code: "illegal_transition", reason_code: null },
  MB005: { code: "override_refused", reason_code: null },
  MB006: { code: "decision_refused", reason_code: "authority_denied" },
  MB007: { code: "customer_erased", reason_code: null },
  MB008: { code: "command_table_mismatch", reason_code: "authority_denied" },
  MB009: { code: "period_closed", reason_code: "period_closed" },
  MB010: { code: "books_unbalanced", reason_code: null },
  MB011: { code: "loyalty_refused", reason_code: null },
  MB012: { code: "claim_quote_mismatch", reason_code: "quote_mismatch" },
  MB013: { code: "out_of_pack_scope", reason_code: null },
  MB014: { code: "sequence_gap", reason_code: null },
};

/** The ApiError for a Munim SQLSTATE (MB001–MB014), or null for anything else. */
export function fromSqlState(err: unknown): ApiError | null {
  const state = (err as { code?: unknown } | null)?.code;
  const hit = typeof state === "string" ? SQLSTATES[state] : undefined;
  return hit ? new ApiError(hit.code, hit.reason_code) : null;
}
