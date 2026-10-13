// Same-origin proxy: browser code calls /api/v1/…; this forwards to core-api's /v1/… with the member's bearer token
// and tenant from httpOnly cookies, so no token ever reaches browser JavaScript. Responses stream through unbuffered
// (SSE /v1/stream included) and are never cached. Storefront calls (X-Munim-Storefront-Key present) and public routes
// go through without any member credential. Origins and hosts are checked against an explicit allow-list
// (lib/origins.ts), never against the request's own Host. Nothing here logs a header, a token or a storefront key.
import type { NextRequest } from "next/server";
import { coreUrl } from "../../../../lib/core.ts";
import { hostAllowed, originAllowed } from "../../../../lib/origins.ts";
import { getSession } from "../../../../lib/session/index.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// The browser's own Authorization and X-Munim-Tenant are never forwarded: both come from the session cookies.
const REQUEST_HEADERS = ["accept", "content-type", "idempotency-key", "last-event-id", "x-munim-storefront-key", "x-munim-guest-token"];
// content-encoding / -length are dropped: fetch has already decoded the body, and the length is the stream's.
const RESPONSE_HEADERS = ["content-type", "cache-control", "content-disposition", "retry-after", "x-munim-replayed", "x-accel-buffering"];

// Public routes never carry a member's credentials, whatever headers arrive: the storefront (key-scoped) and the Munim
// Cares network pages (auth "public").
const PUBLIC = /^\/v1\/(?:storefront|cares-network)\//;

const refusal = (status: number, code: string, message: string) =>
  Response.json({ error: { code, message, reason_code: null } }, { status, headers: { "cache-control": "no-store" } });

async function proxy(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);
  // The raw path, not rebuilt from [...path] segments (that would percent-encode the ':' of /v1/drafts/{id}:approve).
  const path = url.pathname.slice("/api".length);
  if (!path.startsWith("/v1/") || path.includes("..") || path.includes("//")) return refusal(404, "not_found", "Not found.");
  // DNS rebinding: a rebound name (evil.example → 127.0.0.1) is refused for reads and writes alike. Dev only — in
  // production a front end may rewrite Host, so the Origin allow-list below carries the check.
  if (!hostAllowed(req.headers.get("host") ?? url.host)) return refusal(403, "forbidden", "Request refused.");
  if (req.method !== "GET" && req.method !== "HEAD") {
    // Browsers send Origin on every credentialed write; "null" (a sandboxed frame) is not an allowed origin.
    const origin = req.headers.get("origin");
    if (origin !== null && !originAllowed(origin)) return refusal(403, "forbidden", "Cross-site request refused.");
  }

  const headers = new Headers();
  for (const h of REQUEST_HEADERS) {
    const v = req.headers.get(h);
    if (v !== null) headers.set(h, v);
  }
  if (!headers.has("x-munim-storefront-key") && !PUBLIC.test(path)) {
    const session = await getSession();
    if (session) {
      headers.set("authorization", `Bearer ${session.token}`);
      if (session.tenantId) headers.set("x-munim-tenant", session.tenantId);
    }
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${coreUrl()}${path}${url.search}`, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? null : await req.arrayBuffer(),
      signal: req.signal,
      cache: "no-store",
      redirect: "manual",
    });
  } catch {
    if (req.signal.aborted) return new Response(null, { status: 499 });
    return refusal(502, "unavailable", "The Munim service could not be reached.");
  }

  const out = new Headers();
  for (const h of RESPONSE_HEADERS) {
    const v = upstream.headers.get(h);
    if (v !== null) out.set(h, v);
  }
  if (!out.has("cache-control")) out.set("cache-control", "no-store");
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

export { proxy as GET, proxy as POST, proxy as PUT, proxy as PATCH, proxy as DELETE };
