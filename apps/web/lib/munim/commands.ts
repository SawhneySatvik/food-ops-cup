// file: lib/munim/commands.ts
// Every write a staff screen makes is a command envelope: { command_id, idempotency_key, type, payload }. The tenant
// and the person are never in the body; core takes them from the verified token. One attempt = one frozen envelope:
// a retry after a network error, timeout, 429 or 5xx sends the SAME envelope (core answers with the stored result
// and X-Munim-Replayed: true); any change to what the person confirmed is a new attempt with new ids.
import type { MunimError } from "./client";
import { uuidv7 } from "./uuid";

export interface Envelope<T extends string, P> {
  command_id: string;
  idempotency_key: string;
  type: T;
  payload: P;
}

/** A fresh envelope: new command_id and idempotency_key (UUIDv7, which fits ^[A-Za-z0-9_.:-]{8,100}$). */
export const envelope = <T extends string, P>(type: T, payload: P): Envelope<T, P> => ({ command_id: uuidv7(), idempotency_key: uuidv7(), type, payload });

/** One attempt: the envelope plus a fingerprint of what the person confirmed. Keep it in component state (or
 *  sessionStorage) until it succeeds or fails for good. */
export interface CommandAttempt<T extends string, P> {
  fingerprint: string;
  body: Envelope<T, P>;
}

/** Reuses `prev` when the person confirmed the same thing again (a retry); else builds a new attempt.
 *  `build` runs only for a new attempt, so ids made inside it (order_id, line ids, tender_id) stay frozen too. */
export function attemptFor<T extends string, P>(prev: CommandAttempt<T, P> | null, fingerprint: string, type: T, build: () => P): CommandAttempt<T, P> {
  return prev && prev.fingerprint === fingerprint ? prev : { fingerprint, body: envelope(type, build()) };
}

/** True when the same envelope may be sent again unchanged. Every other failure ends the attempt. */
export const retryable = (e: MunimError): boolean => e.kind === "network" || e.kind === "rate_limited" || e.kind === "server";
