// The one error body (packages/contracts/src/shared/error.ts: {error: {code, message, reason_code}}).
// `message` comes from the fixed table below, chosen by code — never from an exception, SQL error or model
// output (One Guarantee: error channels carry no untrusted text).
import { ERROR_CODES as CONTRACT_ERROR_CODES, type ErrorCode, type ErrorResponse, type ReasonCode, type RefusalParams } from "@munim/contracts";
import type { ContentfulStatusCode } from "hono/utils/http-status";

// `Record<ErrorCode, string>` (the contracts enum): a code missing here, or one not in the enum, fails typecheck.
const MESSAGES: Record<ErrorCode, string> = {
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
  investigation_refused: "This investigation step is not allowed any more — check its mode, grant and your outlet access.",
  // Commit helper (T-005)
  idempotency_conflict: "This request key was already used for a different request.",
  command_type_mismatch: "This command does not belong to this route.",
  // Approvals (contracts `drafts.decision-error`, T-008)
  invalid_payload: "This proposal or your changes are not valid.",
  unregistered_command_type: "This kind of proposal cannot be approved here.",
  cannot_verify: "Cannot verify: a number in this proposal no longer traces to its source rows.",
  already_decided: "This proposal was already decided.",
  stale_draft: "This proposal is out of date: the numbers it relied on have changed.",
  // Finance: the tenant's chart has no active account for a role a posting rule needs (AccountMissing).
  chart_incomplete: "The chart of accounts is missing an account this needs. Add it in Finance settings.",
  execution_failed: "Approved, but it could not be applied. Nothing was changed.",
  unavailable: "The service is unavailable.",
  internal: "Something went wrong.",
};
export type { ErrorCode };

/** Fixed customer-facing text for the refusals a shopper or counter sees (storefront O2/O3 copy, B13). Chosen by
 *  reason code; parameters ({item}, {time}…) are resolved by the web app from the `order.refuse.*` keys. */
const REASON_MESSAGES: Partial<Record<ReasonCode, string>> = {
  window_full: "That pickup time just filled up. Please choose another.",
  outlet_paused: "This outlet stopped taking orders a moment ago.",
  item_sold_out: "An item just sold out. Remove it to continue.",
  deal_rejudged: "A deal is not available at that time, so your total changed.",
  coupon_invalid: "This coupon is not valid.",
  coupon_cap_reached: "This coupon has reached its limit.",
  coupon_min_spend: "Spend a little more to use this coupon.",
  coupon_expired: "This coupon has expired.",
  coupon_out_of_scope: "This coupon does not apply to this order.",
  change_window_closed: "It's too late to change this order online. Please call the outlet.",
  not_applicable: "This does not apply here.",
  item_unavailable: "This item is not available.",
  reason_required: "A reason is required.",
  deal_changed: "A deal was updated. Please review your cart.",
  duplicate_invoice: "This supplier invoice number was already recorded.",
  guest_cannot_change: "Call the outlet to change this order",
  refund_first: "Refund the payments on this order before cancelling it.",
  order_tendered: "A payment is recorded on this order, so its time can't change.",
  cash_below_rounding: "Less than the smallest cash amount is due; take it by card or UPI.",
  price_above_mrp: "This price is above the printed maximum retail price.",
  expired_batch: "This stock is past its expiry date and cannot be sold.",
  preview_total_changed: "The total changed since the preview. Review it and try again.",
  unit_mismatch: "The unit does not match the ingredient's base unit.",
  tax_id_missing: "A tax registration number is needed for this.",
  period_closed: "That period is closed; post it in an open period.",
  model_blocked: "AI is switched off for this business.",
  buyer_identity_required: "The buyer's name or tax number is needed for this sale.",
  unknown_tax_class: "That tax class is not recognised.",
  unknown_channel: "That sales channel is not recognised.",
  // T-090 (F10, F11 O-2). Copy carries no amount: the limit and spend are snapshot cells (intel.ai_budget_left).
  mode_above_ceiling: "Your role cannot use this investigation mode. The owner sets the highest mode for each role.",
  cap_above_platform_budget: "The monthly AI cap cannot be above the platform's AI budget for this month.",
  platform_budget_missing: "The platform has not set this month's AI budget in your business currency, so a cap cannot be set yet.",
  // T-099 (G-12).
  pickup_time_outside_window: "That pickup time is outside the pickup window you chose.",
};
export const ERROR_CODES: readonly ErrorCode[] = CONTRACT_ERROR_CODES;

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
  investigation_refused: 409,
  idempotency_conflict: 409,
  command_type_mismatch: 422,
  invalid_payload: 422,
  unregistered_command_type: 422,
  cannot_verify: 422,
  already_decided: 409,
  stale_draft: 409,
  chart_incomplete: 409,
  execution_failed: 422,
  unavailable: 503,
  internal: 500,
};

/** Fields a route's documented error schema adds beside `error` (e.g. `drafts.decision-error`: `changes`, `refs`).
 *  Core-composed ids and cells only — never exception or model text. */
export type ErrorExtra = { changes?: unknown[]; refs?: string[]; params?: RefusalParams };

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
  return { error: { code, message: (reason_code && REASON_MESSAGES[reason_code]) || MESSAGES[code], reason_code } };
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
  MB015: { code: "investigation_refused", reason_code: null },
};

/** The ApiError for a Munim SQLSTATE (MB001–MB015), or null for anything else. */
export function fromSqlState(err: unknown): ApiError | null {
  const state = (err as { code?: unknown } | null)?.code;
  const hit = typeof state === "string" ? SQLSTATES[state] : undefined;
  return hit ? new ApiError(hit.code, hit.reason_code) : null;
}
