// Per-instance fixed-window rate limit for the credential-free Cares routes (ADR-015 §2.2). A window opens at a key's
// first request and admits `limit` requests; the next one is 429 with Retry-After until the window ends. Per instance:
// N instances admit limit × N (accepted in the ADR; no distributed limiter in v1).
import type { Context, MiddlewareHandler } from "hono";
import { errorBody } from "./errors.ts";
import type { AppEnv } from "./types.ts";

export type Clock = () => number;

/** Keys held before expired windows are swept; the key space is client-chosen, so memory stays bounded. */
const MAX_KEYS = 10_000;

export class FixedWindow {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: Clock;
  constructor(limit: number, windowMs: number, now: Clock = Date.now) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  /** Counts one request for `key`: null when admitted, else the whole seconds until its window ends (≥ 1). */
  hit(key: string): number | null {
    const t = this.now();
    let w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) {
      if (!w && this.windows.size >= MAX_KEYS) this.sweep(t);
      w = { start: t, count: 0 };
      this.windows.set(key, w);
    }
    if (w.count >= this.limit) return Math.max(1, Math.ceil((w.start + this.windowMs - t) / 1000));
    w.count++;
    return null;
  }

  private sweep(t: number) {
    for (const [k, w] of this.windows) if (t - w.start >= this.windowMs) this.windows.delete(k);
    // Every window still open: drop them all rather than grow without bound (the limit resets early, never wrongly refuses).
    if (this.windows.size >= MAX_KEYS) this.windows.clear();
  }
}

/**
 * The client address: the X-Forwarded-For entry `hops` from the right (each trusted proxy appends the address it saw,
 * so entries left of that are client-supplied and spoofable). With hops = 0, or fewer entries than hops, the socket's
 * remote address (@hono/node-server's `incoming`).
 */
export function clientIp(c: Context<AppEnv>, hops: number): string {
  if (hops > 0) {
    const entries = (c.req.header("X-Forwarded-For") ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
    if (entries.length >= hops) return entries[entries.length - hops]!;
  }
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? "unknown";
}

/** 429 `rate_limited` (reason code) with Retry-After once `limiter` refuses the request's key. */
export function rateLimit(limiter: () => FixedWindow, key: (c: Context<AppEnv>) => string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const wait = limiter().hit(key(c));
    if (wait !== null) return c.json(errorBody("unavailable", "rate_limited"), 429, { "Retry-After": String(wait) });
    await next();
  };
}
