// Command envelope (03-architecture §1.6) as sent on the wire: `{command_id, idempotency_key, type,
// payload}`. Tenant and actor are NOT in the body — core-api takes them from the verified identity and
// stores them on core.command_log. Same key + same request hash → original result; different hash → 409.
import { z } from "zod";
import { CommandType, IsoDateTime, Uuid7 } from "./primitives.ts";

export const IdempotencyKey = z.string().regex(/^[A-Za-z0-9_.:-]{8,100}$/);

/** Generic form: `payload` is validated by core against the schema registered under `type`. */
export const CommandEnvelope = z.strictObject({
  command_id: Uuid7,
  idempotency_key: IdempotencyKey,
  type: CommandType,
  payload: z.record(z.string(), z.unknown()),
});
export type CommandEnvelope = z.infer<typeof CommandEnvelope>;

/** Typed form for one command type. */
export function commandEnvelopeOf<T extends string, P extends z.ZodType>(type: T, payload: P) {
  return z.strictObject({ command_id: Uuid7, idempotency_key: IdempotencyKey, type: z.literal(type), payload });
}

/** What a committed command returns — stored once in core.command_log and served byte-identically on
 *  every replay. Whether a response is a replay is the `X-Munim-Replayed: true` response header
 *  (REPLAYED_HEADER), never a body field (the stored body cannot change between first and replay). */
export const CommandResult = z.strictObject({
  command_id: Uuid7,
  type: CommandType,
  /** The primary entity the command created or changed. */
  entity_id: Uuid7,
  committed_at: IsoDateTime,
});
export type CommandResult = z.infer<typeof CommandResult>;
