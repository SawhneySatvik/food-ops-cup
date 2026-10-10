// The one error body every surface returns. Text is composed by core-api from i18n — never raw model
// output. `reason_code` is set when the refusal is one of the named reason codes.
// The text field is `message` (the code wins over the brief's `message_key`, W1 fix #6): core-api resolves
// the i18n key itself and sends the composed text; `code` is the stable machine key.
import { z } from "zod";
import { ReasonCode } from "./reason-codes.ts";

/** Every `code` core-api can return (services/core-api/src/lib/errors.ts types its message and status tables on
 *  this list, so a code added there without being added here fails typecheck). A client can switch on it.
 *  Malformed command envelope or payload (valid JSON, wrong shape) = `invalid_payload` (422); a body that is not
 *  JSON, or a bad query/path value = `bad_request` (400). */
export const ERROR_CODES = [
  "bad_request", "unauthenticated", "forbidden", "not_found", "conflict", "book_write_refused", "country_locked", "currency_mismatch",
  "illegal_transition", "override_refused", "decision_refused", "customer_erased", "command_table_mismatch", "period_closed", "books_unbalanced",
  "loyalty_refused", "claim_quote_mismatch", "out_of_pack_scope", "sequence_gap", "idempotency_conflict", "command_type_mismatch",
  "invalid_payload", "unregistered_command_type", "cannot_verify", "already_decided", "stale_draft", "chart_incomplete", "execution_failed",
  "unavailable", "internal",
] as const;
export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorBody = z
  .strictObject({
    code: ErrorCode,
    message: z.string().min(1).max(500),
    reason_code: ReasonCode.nullable(),
  })
  .meta({ title: "ErrorBody" });
export const ErrorResponse = z.strictObject({ error: ErrorBody });
export type ErrorResponse = z.infer<typeof ErrorResponse>;
