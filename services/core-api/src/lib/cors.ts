// CORS for the browser-facing public routes only (T-099, docs/kit/gaps.md G-09): a storefront or the Cares site on
// another origin calls /v1/storefront/**, /v1/stream and /v1/cares-network/** directly. Member, operator and internal
// routes never get CORS headers (their callers are Munim's own apps, same-origin or server-side).
//   - Allowed origins: an exact list (`MUNIM_CORS_ORIGINS`, comma-separated, parsed by `parseCorsOrigins`); empty = no CORS.
//   - Credentials are headers (bearer token, storefront key, guest token), never cookies, so no Allow-Credentials is sent
//     and the allowed origin is echoed, never `*`.
//   - Preflight (OPTIONS) is answered here, before any router, so a rate limiter never counts it.
//   - Headers are set after the route ran, so a refusal (409), a 404 or a 429 is readable by the page too.
import { GUEST_TOKEN_HEADER, REPLAYED_HEADER, STOREFRONT_KEY_HEADER } from "@munim/contracts";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./types.ts";

const ALLOW_HEADERS = [STOREFRONT_KEY_HEADER, GUEST_TOKEN_HEADER, "Idempotency-Key", "Last-Event-ID", "Content-Type", "Authorization"].join(", ");
const EXPOSE_HEADERS = [REPLAYED_HEADER, "Retry-After"].join(", ");

/** `MUNIM_CORS_ORIGINS` → exact origins (scheme://host[:port], no trailing slash). `*` and blanks are dropped: an
 *  open origin is never configured by accident. */
export function parseCorsOrigins(raw: string | undefined): string[] {
  return [...new Set((raw ?? "").split(",").map((o) => o.trim().replace(/\/+$/, "")).filter((o) => o !== "" && o !== "*"))];
}

/** The public browser routes: /v1/storefront and below, /v1/stream, /v1/cares-network and below. */
export const isCorsPath = (path: string): boolean =>
  path === "/v1/stream" || /^\/v1\/(storefront|cares-network)(\/|$)/.test(path);

export function cors(origins: readonly string[]): MiddlewareHandler<AppEnv> {
  const allowed = new Set(origins);
  return async (c, next) => {
    if (allowed.size === 0 || !isCorsPath(c.req.path)) return next();
    const origin = c.req.header("Origin");
    const ok = origin !== undefined && allowed.has(origin);
    if (c.req.method === "OPTIONS" && ok && c.req.header("Access-Control-Request-Method")) {
      return c.body(null, 204, {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": ALLOW_HEADERS,
        "Access-Control-Max-Age": "600",
        Vary: "Origin",
      });
    }
    await next();
    c.res.headers.append("Vary", "Origin");
    if (ok) {
      c.res.headers.set("Access-Control-Allow-Origin", origin);
      c.res.headers.set("Access-Control-Expose-Headers", EXPOSE_HEADERS);
    }
  };
}
