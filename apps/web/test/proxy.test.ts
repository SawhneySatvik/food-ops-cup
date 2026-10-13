// The same-origin proxy against a fake core at the HTTP boundary (a real local server): credentials come only from
// the session, storefront calls carry none, paths stay raw, responses stream unbuffered and are never cached.
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

// The session is the cookie jar of a live request; stand in for it here (the token source is tested elsewhere).
vi.mock("../lib/session/index.ts", () => ({
  getSession: async () => ({ token: "member-token", tenantId: "tenant-a", outletId: null, email: null }),
}));

let server: Server;
let seen: { url: string; headers: IncomingHttpHeaders; body: string }[] = [];
let release: () => void = () => {};

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url!, headers: req.headers, body });
      if (req.url!.startsWith("/v1/stream")) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", "set-cookie": "x=1" });
        res.write("event: ready\ndata: {}\n\n");
        release = () => res.end("data: {\"id\":\"1\",\"type\":\"t\",\"data\":{}}\n\n");
        return;
      }
      res.writeHead(200, { "content-type": "application/json", "set-cookie": "leak=1", "x-munim-replayed": "true" });
      res.end("{}");
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  vi.stubEnv("MUNIM_CORE_API_URL", `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
});
afterAll(() => {
  server.close();
  vi.unstubAllEnvs();
});

const { GET, POST } = await import("../app/api/v1/[...path]/route.ts");
const req = (path: string, init: ConstructorParameters<typeof NextRequest>[1] = {}) => new NextRequest(`http://localhost:3160${path}`, init);

test("member call: the session's token and tenant replace anything the browser sent", async () => {
  seen = [];
  const res = await GET(req("/api/v1/tenant?x=1", { headers: { authorization: "Bearer forged", "x-munim-tenant": "tenant-b", cookie: "a=b" } }));
  expect(res.status).toBe(200);
  expect(seen[0]!.url).toBe("/v1/tenant?x=1");
  expect(seen[0]!.headers.authorization).toBe("Bearer member-token");
  expect(seen[0]!.headers["x-munim-tenant"]).toBe("tenant-a");
  expect(seen[0]!.headers.cookie).toBeUndefined();
  expect(res.headers.get("set-cookie")).toBeNull();
  expect(res.headers.get("x-munim-replayed")).toBe("true");
  expect(res.headers.get("cache-control")).toBe("no-store");
});

test("storefront call: the key and guest token pass, no member credential (session's or browser's) is attached", async () => {
  seen = [];
  await GET(req("/api/v1/storefront/outlets", { headers: {
    "x-munim-storefront-key": "sk_test", "x-munim-guest-token": "g1", authorization: "Bearer forged", "x-munim-tenant": "tenant-b",
  } }));
  expect(seen[0]!.headers["x-munim-storefront-key"]).toBe("sk_test");
  expect(seen[0]!.headers["x-munim-guest-token"]).toBe("g1");
  expect(seen[0]!.headers.authorization).toBeUndefined();
  expect(seen[0]!.headers["x-munim-tenant"]).toBeUndefined();
});

test("commands keep the raw path (':approve') and the Idempotency-Key", async () => {
  seen = [];
  await POST(req("/api/v1/drafts/0199e7a0-0000-7000-8000-00000000000a:approve", {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": "k-1", origin: "http://localhost:3160" }, body: "{\"a\":1}",
  }));
  expect(seen[0]!.url).toBe("/v1/drafts/0199e7a0-0000-7000-8000-00000000000a:approve");
  expect(seen[0]!.headers["idempotency-key"]).toBe("k-1");
  expect(seen[0]!.body).toBe("{\"a\":1}");
});

test("a cross-site POST is refused before it reaches core", async () => {
  seen = [];
  const res = await POST(req("/api/v1/snapshots", { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" }));
  expect(res.status).toBe(403);
  expect(seen).toHaveLength(0);
});

test("a same-origin POST from 127.0.0.1 passes even though next dev reports the URL as localhost", async () => {
  seen = [];
  const res = await POST(req("/api/v1/snapshots", { method: "POST", headers: { origin: "http://127.0.0.1:3160", host: "127.0.0.1:3160" }, body: "{}" }));
  expect(res.status).toBe(200);
  expect(seen).toHaveLength(1);
});

test("a cross-site POST is refused even when it claims the page's host header", async () => {
  seen = [];
  const res = await POST(req("/api/v1/snapshots", { method: "POST", headers: { origin: "https://evil.example", host: "127.0.0.1:3160" }, body: "{}" }));
  expect(res.status).toBe(403);
  expect(seen).toHaveLength(0);
});

test("DNS rebinding: Origin and Host both evil.example is refused, writes and reads", async () => {
  seen = [];
  const evil = { origin: "http://evil.example:3160", host: "evil.example:3160" };
  expect((await POST(req("/api/v1/drafts/x:approve", { method: "POST", headers: evil, body: "{}" }))).status).toBe(403);
  expect((await GET(req("/api/v1/tenant", { headers: { host: "evil.example:3160" } }))).status).toBe(403);
  expect(seen).toHaveLength(0);
});

test("Origin: null (sandboxed iframe) is a 403 refusal, not a crash", async () => {
  seen = [];
  const res = await POST(req("/api/v1/snapshots", { method: "POST", headers: { origin: "null", host: "127.0.0.1:3160" }, body: "{}" }));
  expect(res.status).toBe(403);
  expect(seen).toHaveLength(0);
});

test("[::1] and localhost on any port are dev origins", async () => {
  seen = [];
  for (const o of ["http://[::1]:3161", "http://localhost:3999"]) {
    const res = await POST(req("/api/v1/snapshots", { method: "POST", headers: { origin: o, host: new URL(o).host }, body: "{}" }));
    expect(res.status).toBe(200);
  }
  expect(seen).toHaveLength(2);
});

test("production: only MUNIM_WEB_ORIGINS pass, whatever Host says (front ends rewrite it)", async () => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("MUNIM_WEB_ORIGINS", "https://app.munim.example, https://demo.munim.example:8443");
  try {
    seen = [];
    const post = (origin: string, host: string) => POST(req("/api/v1/snapshots", { method: "POST", headers: { origin, host }, body: "{}" }));
    expect((await post("https://app.munim.example", "internal-run-app:8080")).status).toBe(200);
    expect((await post("https://demo.munim.example:8443", "x")).status).toBe(200);
    expect((await post("https://demo.munim.example", "demo.munim.example")).status).toBe(403);
    expect((await post("http://127.0.0.1:3160", "127.0.0.1:3160")).status).toBe(403);
    expect((await post("http://evil.example", "evil.example")).status).toBe(403);
    expect(seen).toHaveLength(2);
  } finally {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("MUNIM_WEB_ORIGINS", "");
  }
});

test("public routes never carry member credentials, with or without a storefront key", async () => {
  seen = [];
  await GET(req("/api/v1/cares-network/impact"));
  await GET(req("/api/v1/cares-network/snapshots/0199e7a0-0000-7000-8000-00000000000a"));
  await GET(req("/api/v1/storefront/outlets"));
  expect(seen).toHaveLength(3);
  for (const s of seen) {
    expect(s.headers.authorization).toBeUndefined();
    expect(s.headers["x-munim-tenant"]).toBeUndefined();
  }
});

test("SSE streams through unbuffered: the first event arrives before core ends the response", async () => {
  const res = await GET(req("/api/v1/stream?topics=inbox:x", { headers: { "last-event-id": "o=3" } }));
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
  const reader = res.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  expect(first).toContain("event: ready");
  expect(seen.at(-1)!.headers["last-event-id"]).toBe("o=3");
  release();
  let rest = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    rest += new TextDecoder().decode(value);
  }
  expect(rest).toContain("\"type\":\"t\"");
});
