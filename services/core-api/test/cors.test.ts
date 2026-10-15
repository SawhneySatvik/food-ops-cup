// CORS (T-099, docs/kit/gaps.md G-09; orchestrator rider): only /v1/storefront/**, /v1/stream and /v1/cares-network/**,
// only for the listed origins, never `*`, never credentials; preflight answered before any router, so the Cares rate
// limiter (60 a minute per client, lib/ratelimit.ts) never counts it; refusals, 404s and the 429 stay readable.
// Hand values: limit 60 (ADR-015 §2.2); the six allowed request headers and two exposed headers as written in the ticket.
import { createHash } from "node:crypto";
import { createLogger } from "@munim/config";
import { ownerCtx, type TestDb, uuidv7 } from "@munim/db";
import type { Hono } from "hono";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalIdp } from "../src/auth/local-idp.ts";
import { type AppEnv, createApp, parseCorsOrigins, STOREFRONT_KEY_HEADER, storefrontResolver, TENANT_HEADER } from "../src/app.ts";
import { openDb } from "./db.ts";
import { buildTenant, type Tenant } from "./world.ts";

const ORIGIN = "https://spice-route.example.test";
const idp = createLocalIdp();
let db: TestDb;
let pools: { core: pg.Pool; svc: pg.Pool };
let app: Hono<AppEnv>;
let off: Hono<AppEnv>;
let W: Tenant;
let KEY: string;

const ACAO = "access-control-allow-origin";
const cors = (r: Response) => [...r.headers.keys()].filter((k) => k.startsWith("access-control-")).sort();

beforeAll(async () => {
  db = await openDb();
  W = await buildTenant(db, "C");
  const ch = uuidv7();
  KEY = `sfk_C_${uuidv7().replaceAll("-", "")}${uuidv7().replaceAll("-", "")}`;
  await db.withContext("munim_core", ownerCtx(W, { command_type: "tenancy.channel.create.v1" }), (c) =>
    c.query(`INSERT INTO core.channel (tenant_id, id, name, kind) VALUES ($1, $2, 'Pickup', 'pickup')`, [W.tenant, ch]));
  await db.withContext("munim_core", ownerCtx(W), (c) =>
    c.query(`INSERT INTO core.storefront_key (tenant_id, id, channel_id, key_hash) VALUES ($1, $2, $3, $4)`, [W.tenant, uuidv7(), ch, createHash("sha256").update(KEY).digest("hex")]));
  pools = { core: db.pool("munim_core", 4), svc: db.pool("munim_svc", 2) };
  const config = { nodeEnv: "test", redact: (s: string) => s };
  const deps = { pools, idp, storefronts: storefrontResolver(pools.core), config, log: createLogger(config, () => {}) };
  app = await createApp(deps, { corsOrigins: parseCorsOrigins(` ${ORIGIN}/ , *, https://laneway.example.test`) });
  off = await createApp(deps);
});
afterAll(async () => {
  await pools.core.end();
  await pools.svc.end();
  await db.stop();
});

const get = (a: Hono<AppEnv>, path: string, origin: string | null, extra: Record<string, string> = {}) =>
  a.request(path, { headers: { ...(origin ? { Origin: origin } : {}), [STOREFRONT_KEY_HEADER]: KEY, ...extra } });
const preflight = (a: Hono<AppEnv>, path: string, origin: string, method = "POST") =>
  a.request(path, { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": method, "Access-Control-Request-Headers": "x-munim-storefront-key, idempotency-key" } });

describe("G-09 CORS", () => {
  it("parseCorsOrigins: trims, drops trailing slashes, `*` and blanks", () => {
    expect(parseCorsOrigins(` ${ORIGIN}/ , *, , https://laneway.example.test`)).toEqual([ORIGIN, "https://laneway.example.test"]);
    expect(parseCorsOrigins(undefined)).toEqual([]);
  });

  it("an allowed origin on a storefront read: its own origin echoed, X-Munim-Replayed and Retry-After exposed, Vary: Origin, no credentials", async () => {
    const r = await get(app, "/v1/storefront/outlets", ORIGIN);
    expect(r.status).toBe(200);
    expect(cors(r)).toEqual([ACAO, "access-control-expose-headers"]);
    expect([r.headers.get(ACAO), r.headers.get("access-control-expose-headers"), r.headers.get("vary")]).toEqual([ORIGIN, "X-Munim-Replayed, Retry-After", "Origin"]);
  });

  it("preflight from an allowed origin: 204 with the six request headers, GET/POST, and no credentials", async () => {
    const r = await preflight(app, "/v1/storefront/orders", ORIGIN);
    expect(r.status).toBe(204);
    expect(cors(r)).toEqual(["access-control-allow-headers", "access-control-allow-methods", ACAO, "access-control-max-age"]);
    expect(r.headers.get(ACAO)).toBe(ORIGIN);
    expect(r.headers.get("access-control-allow-headers")).toBe("X-Munim-Storefront-Key, X-Munim-Guest-Token, Idempotency-Key, Last-Event-ID, Content-Type, Authorization");
    expect(r.headers.get("access-control-allow-methods")).toBe("GET, POST, OPTIONS");
    expect((await preflight(app, "/v1/stream", ORIGIN, "GET")).status).toBe(204);
  });

  it("a listed origin's 404 (bad key) still carries the CORS headers", async () => {
    const r = await app.request("/v1/storefront/outlets", { headers: { Origin: ORIGIN, [STOREFRONT_KEY_HEADER]: "sfk_not_a_real_key_000000000000000000" } });
    expect([r.status, r.headers.get(ACAO)]).toEqual([404, ORIGIN]);
  });

  it("a non-listed origin gets no CORS header (read and preflight); neither does a member route, even from a listed origin", async () => {
    const other = await get(app, "/v1/storefront/outlets", "https://evil.example.test");
    expect([other.status, cors(other)]).toEqual([200, []]);
    const pf = await preflight(app, "/v1/storefront/orders", "https://evil.example.test");
    expect([pf.status === 204, cors(pf)]).toEqual([false, []]);
    const m = await app.request(`/v1/catalogue/menu?outlet=${W.outlets[0]}&channel_kind=pickup`, {
      headers: { Origin: ORIGIN, Authorization: `Bearer ${idp.sign({ sub: W.ownerSub })}`, [TENANT_HEADER]: W.tenant } });
    expect([m.status, cors(m)]).toEqual([200, []]);
    const mp = await preflight(app, "/v1/catalogue/items", ORIGIN);
    expect([mp.status === 204, cors(mp)]).toEqual([false, []]);
  });

  it("no configured origins: no CORS header anywhere", async () => {
    expect(cors(await get(off, "/v1/storefront/outlets", ORIGIN))).toEqual([]);
    expect(cors(await preflight(off, "/v1/storefront/orders", ORIGIN))).toEqual([]);
  });

  it("preflights to /v1/cares-network/listings are not counted by the limiter: after 70, exactly 60 GETs pass, the 61st is a readable 429", async () => {
    for (let i = 0; i < 70; i++) expect((await preflight(app, "/v1/cares-network/listings", ORIGIN, "GET")).status).toBe(204);
    let ok = 0;
    let last: Response | null = null;
    for (let i = 0; i < 61; i++) {
      last = await app.request("/v1/cares-network/listings", { headers: { Origin: ORIGIN } });
      if (last.status === 200) ok++;
    }
    console.log(`G-09 limiter: ${ok} GETs passed after 70 preflights; the next was ${last!.status}`);
    expect(ok).toBe(60);
    expect([last!.status, last!.headers.get(ACAO), Number(last!.headers.get("retry-after")) >= 1]).toEqual([429, ORIGIN, true]);
  });
});
