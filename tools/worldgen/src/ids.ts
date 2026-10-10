// Client-chosen ids. A UUIDv7-shaped id derived from (seed, world, key): the same key always names the same row,
// so a replay is an idempotent replay and the answer key / verifier can resolve a seed key to a row. The
// 48-bit prefix is hash bytes, not a clock (ids are shaped like v7, not time-ordered).
import { createHash } from "node:crypto";

export function idOf(seed: string, world: string, key: string): string {
  const h = createHash("sha256").update(`${seed}|${world}|${key}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7${h.slice(13, 16)}-${"89ab"[Number.parseInt(h[16]!, 16) & 3]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** An idempotency key: stable per logical command. */
export const idemOf = (seed: string, world: string, key: string): string =>
  `wg-${createHash("sha256").update(`idem|${seed}|${world}|${key}`).digest("hex").slice(0, 32)}`;
