// UUIDv7 for client-made ids (command_id, order_id, line_id, …): the API refuses any other version, so
// `crypto.randomUUID()` (v4) will not do. Hand-written (not generated).

/** A fresh UUIDv7 (RFC 9562 §5.7): 48-bit Unix time in ms, version 7, 74 random bits, variant 10. Uses the platform's
 *  `crypto.getRandomValues` (browsers; Node 20+, where Web Crypto is global). */
export function uuidv7(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let ms = Date.now();
  for (let i = 5; i >= 0; i--) {
    b[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
