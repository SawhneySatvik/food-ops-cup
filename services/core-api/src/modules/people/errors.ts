// Database refusals a people handler turns into a client error. Text is never copied (lib/errors.ts).
import { ApiError, fromSqlState } from "../../lib/errors.ts";

/** MB001–MB014 → their code; exclusion / unique → conflict; FK / check / not-null → invalid_payload. null = not ours. */
export function dbRefusal(e: unknown): ApiError | null {
  if (e instanceof ApiError) return e;
  const mb = fromSqlState(e);
  if (mb) return mb;
  const s = (e as { code?: unknown } | null)?.code;
  if (s === "23P01" || s === "23505") return new ApiError("conflict");
  if (s === "23503" || s === "23514" || s === "23502" || s === "22P02" || s === "22007" || s === "22008") return new ApiError("invalid_payload");
  return null;
}
