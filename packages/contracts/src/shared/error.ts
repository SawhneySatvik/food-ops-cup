// The one error body every surface returns. Text is composed by core-api from i18n — never raw model
// output. `reason_code` is set when the refusal is one of the named reason codes.
// The text field is `message` (the code wins over the brief's `message_key`, W1 fix #6): core-api resolves
// the i18n key itself and sends the composed text; `code` is the stable machine key.
import { z } from "zod";
import { ReasonCode } from "./reason-codes.ts";

export const ErrorBody = z
  .strictObject({
    code: z.string().regex(/^[a-z_]+$/),
    message: z.string().min(1).max(500),
    reason_code: ReasonCode.nullable(),
  })
  .meta({ title: "ErrorBody" });
export const ErrorResponse = z.strictObject({ error: ErrorBody });
export type ErrorResponse = z.infer<typeof ErrorResponse>;
