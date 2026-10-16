// Lane B2 gates for running core-api as request-scoped functions (env-root.ts, the tick route):
//   tick   /internal/cron/v1/tick: 404 when unconfigured, without a bearer, with a wrong one (gotcha 16); 200 with the
//          right one, running every core-worker job once for an aligned slot (an aged outbox row gets published);
//          a repeated call for that slot runs nothing (T-117: every job "already-ran", a newly aged row stays unpublished);
//          one tick at a time cluster-wide (the lock held elsewhere → ran:false, nothing runs)
//   stream composeCoreApi's streamMaxAgeMs reaches the stream: the server ends it with a max_age reconnect hint at
//          that age, and the SDK reader reconnects (red-proven by removing the wiring — see the lane B2 report)
//   pools  poolMax clamps every app pool
//   ask    composeCoreApi's askTimeoutMs (MUNIM_ASK_TIMEOUT_S) is how long POST /v1/ask waits for an intel that never answers
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { createLogger } from "@munim/config";
import { buildWorld, type TestDb, type World } from "@munim/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { openStream } from "../../../packages/sdk/src/stream.ts";
import { Worker } from "../../core-worker/src/worker.ts";
import { createLocalIdp } from "../src/auth/local-idp.ts";
import { TENANT_HEADER } from "../src/app.ts";
import { configureTick } from "../src/cron/index.ts";
import { composeCoreApi, type CoreApi } from "../src/server.ts";
import { openDb } from "./db.ts";

const SECRET = "tick-secret-for-tests-0123456789";
const idp = createLocalIdp();
let db: TestDb;
let w: World;
const ownerSub = `owner-b2-${randomUUID()}`;
const lines: string[] = [];
const closers: Array<() => Promise<void> | void> = [];
const url = (role: string) => `postgres://${role}:${db.password}@127.0.0.1:${db.port}/${db.database}`;

async function compose(extra: { streamMaxAgeMs?: number; poolMax?: number; askTimeoutMs?: number; intelUrl?: string } = {}): Promise<{ api: CoreApi; base: string }> {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const config = { nodeEnv: "test", redact: (s: string) => s };
  const api = await composeCoreApi({
    coreUrl: url("munim_core"), svcUrl: url("munim_svc"), listenUrl: url("munim_core"), idp, config,
    log: createLogger(config, (l) => lines.push(l)),
    keys: { privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString() },
    intelUrl: "http://127.0.0.1:9", serviceSecret: "service-secret-for-tests-0123", ...extra,
  });
  const port = await new Promise<number>((resolve) => {
    const server = serve({ fetch: api.app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => resolve(info.port));
    closers.push(() => new Promise<void>((r) => server.close(() => r())));
  });
  closers.push(() => api.close());
  return { api, base: `http://127.0.0.1:${port}` };
}

beforeAll(async () => {
  db = await openDb();
  w = await buildWorld(db);
  await db.withContext("munim_core", { tenant_id: w.tenant, outlet_ids: "*", role: "owner", member_id: w.owner, command_type: "tenancy.member.invite.v1" },
    (c) => c.query(`UPDATE core.member SET idp_sub = $3 WHERE tenant_id = $1 AND id = $2`, [w.tenant, w.owner, ownerSub]));
});
afterAll(async () => {
  for (const c of closers.reverse()) await c();
  await db?.stop();
});

describe("tick route", () => {
  const published: string[] = [];
  const worker = () => {
    const wk = new Worker({
      connectionString: url("munim_svc"), log: () => {},
      publisher: { publish: async (row) => void published.push(row.id) },
      minter: { mint: async () => ({ run_id: randomUUID(), token: "t" }), end: async () => {} },
      intel: { call: async () => {} },
    });
    closers.push(() => wk.stop(1_000).then(() => {}));
    return wk;
  };

  it("404 until configured; then 404 without a bearer, with a wrong one or a different scheme; 200 with the right one", async () => {
    const { api } = await compose();
    expect((await api.app.request("/internal/cron/v1/tick", { headers: { Authorization: `Bearer ${SECRET}` } })).status).toBe(404);
    const wk = worker();
    configureTick(api.deps, { secret: SECRET, tick: (now) => wk.tick(now, { periodMinutes: 1440, budgetMs: 30_000 }) });
    for (const headers of [{}, { Authorization: "Bearer wrong-secret-0123456789abcd" }, { Authorization: `Basic ${SECRET}` }, { Authorization: `Bearer ${SECRET}x` },
      { Authorization: `bearer ${SECRET}` }, { "X-Munim-Service-Secret": SECRET }] as Array<Record<string, string>>) {
      const r = await api.app.request("/internal/cron/v1/tick", { method: "POST", headers });
      expect(r.status, JSON.stringify(headers)).toBe(404);
      expect(await r.text()).not.toContain(SECRET);
    }
    const ok = await api.app.request("/internal/cron/v1/tick", { headers: { Authorization: `Bearer ${SECRET}` } });
    expect(ok.status).toBe(200);
    expect((await ok.json() as { ran: boolean }).ran).toBe(true);
    expect(() => configureTick(api.deps, { secret: "short", tick: async () => ({}) })).toThrow(/too short/);
  });

  it("runs every core-worker job once for the aligned slot: an aged outbox row is published", async () => {
    // The first test's tick claimed this slot already (core.tick_claim, T-117): start from an empty ledger.
    await db.admin("TRUNCATE core.tick_claim");
    const { api } = await compose();
    const wk = worker();
    configureTick(api.deps, { secret: SECRET, tick: (now) => wk.tick(now, { periodMinutes: 1440, budgetMs: 30_000 }) });
    const row = randomUUID();
    await db.withContext("munim_svc", { tenant_id: w.tenant, role: "service" }, (c) => c.query(
      `INSERT INTO core.outbox (tenant_id, id, aggregatetype, aggregateid, type, payload, created_at)
       VALUES ($1, $2, 'order', 'x', 'munim.orders.order.placed.v1', '{}'::jsonb, now() - interval '5 minutes')`, [w.tenant, row]));
    const before = Date.now();
    const r = await api.app.request("/internal/cron/v1/tick", { method: "POST", headers: { Authorization: `Bearer ${SECRET}` } });
    const body = await r.json() as { ran: boolean; prev: string; at: string; jobs: Record<string, string> };
    console.log(`tick: ${JSON.stringify(body)}`);
    expect(r.status).toBe(200);
    expect(body.ran).toBe(true);
    expect(body.jobs).toEqual({ "outbox-sweep": "ok", "fanout-watch": "ok", "fanout-brief": "ok", nightly: "ok" });
    const at = Date.parse(body.at);
    expect(at % 3_600_000).toBe(0); // floored to the hour
    expect(before - at).toBeLessThan(3_600_000);
    expect(at - Date.parse(body.prev)).toBe(86_400_000); // a daily window: consecutive daily ticks tile
    expect(published).toContain(row);
    const { rows } = await db.admin<{ p: Date | null }>(`SELECT published_at AS p FROM core.outbox WHERE id = $1`, [row]);
    expect(rows[0]!.p).not.toBeNull();

    // A repeated call (a scheduler retry, a manual call) in the same slot runs nothing.
    const later = randomUUID();
    await db.withContext("munim_svc", { tenant_id: w.tenant, role: "service" }, (c) => c.query(
      `INSERT INTO core.outbox (tenant_id, id, aggregatetype, aggregateid, type, payload, created_at)
       VALUES ($1, $2, 'order', 'x', 'munim.orders.order.placed.v1', '{}'::jsonb, now() - interval '5 minutes')`, [w.tenant, later]));
    const again = await api.app.request("/internal/cron/v1/tick", { method: "POST", headers: { Authorization: `Bearer ${SECRET}` } });
    const replay = await again.json() as { ran: boolean; at: string; jobs: Record<string, string> };
    console.log(`tick again: ${JSON.stringify(replay)}`);
    expect(again.status).toBe(200);
    expect(replay).toMatchObject({ ran: true, at: body.at,
      jobs: { "outbox-sweep": "already-ran", "fanout-watch": "already-ran", "fanout-brief": "already-ran", nightly: "already-ran" } });
    expect(published).not.toContain(later);
  });

  it("one tick at a time: with the lock held elsewhere nothing runs (ran:false)", async () => {
    const wk = worker();
    const holder = new pg.Client({ connectionString: url("munim_svc") });
    await holder.connect();
    onTestFinished(() => holder.end());
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended('core-worker:tick', 0))");
    const r = await wk.tick(new Date(), { periodMinutes: 15, budgetMs: 5_000 });
    expect(r).toMatchObject({ ran: false, jobs: {} });
    expect(Date.parse(r.at) - Date.parse(r.prev)).toBe(15 * 60_000);
    await holder.query("ROLLBACK");
    expect((await wk.tick(new Date(), { periodMinutes: 15, budgetMs: 5_000 })).ran).toBe(true);
  });
});

describe("stream lifetime from the wiring", () => {
  it("streamMaxAgeMs ends the stream with a max_age reconnect hint at that age, and the SDK reconnects", async () => {
    const { base } = await compose({ streamMaxAgeMs: 800 });
    const headers = { Authorization: `Bearer ${idp.sign({ sub: ownerSub })}`, [TENANT_HEADER]: w.tenant };
    const t0 = Date.now();
    const res = await fetch(`${base}/v1/stream?topics=kds:${w.outlets[0]}`, { headers });
    expect(res.status).toBe(200);
    const text = await res.text(); // resolves only when the server ends the stream
    const age = Date.now() - t0;
    console.log(`stream ended after ${age} ms`);
    expect(text).toContain("event: ready");
    expect(text).toContain(`event: reconnect\ndata: ${JSON.stringify({ reason: "max_age" })}`);
    expect(age).toBeGreaterThanOrEqual(700);
    expect(age).toBeLessThan(5_000);

    const states: string[] = [];
    const h = openStream({
      baseUrl: base, topics: [`kds:${w.outlets[0]}`], token: () => idp.sign({ sub: ownerSub }), headers: () => ({ [TENANT_HEADER]: w.tenant }),
      onEvent: () => {}, onState: (s) => states.push(s), initialDelayMs: 50, maxDelayMs: 500,
    });
    onTestFinished(() => h.close());
    const deadline = Date.now() + 8_000;
    while (states.filter((s) => s === "open").length < 3 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(states.filter((s) => s === "open").length).toBeGreaterThanOrEqual(3);
  });
});

describe("ask timeout from the wiring", () => {
  it("askTimeoutMs is how long POST /v1/ask waits for intel: an intel that never answers is 503 at that age, not at 90 s", async () => {
    // An intel that takes the request and never answers.
    const held: Array<() => void> = [];
    const intel = serve({ fetch: () => new Promise<Response>((resolve) => held.push(() => resolve(new Response(null, { status: 599 })))), port: 0, hostname: "127.0.0.1" });
    const port = await new Promise<number>((resolve) => intel.once("listening", () => resolve((intel.address() as { port: number }).port)));
    closers.push(() => new Promise<void>((r) => { held.forEach((f) => f()); intel.close(() => r()); }));
    const { base } = await compose({ askTimeoutMs: 1_500, intelUrl: `http://127.0.0.1:${port}` });
    const t0 = Date.now();
    const res = await fetch(`${base}/v1/ask`, {
      method: "POST", body: JSON.stringify({ question: "Why did butter waste go up?" }),
      headers: { Authorization: `Bearer ${idp.sign({ sub: ownerSub })}`, [TENANT_HEADER]: w.tenant, "content-type": "application/json" },
    });
    const age = Date.now() - t0;
    expect([res.status, ((await res.json()) as { error: { code: string } }).error.code]).toEqual([503, "unavailable"]);
    expect(age).toBeGreaterThanOrEqual(1_400);
    expect(age).toBeLessThan(10_000);
  });
});

describe("pool ceiling", () => {
  it("poolMax clamps every app pool; unset keeps each pool's own size", async () => {
    const clamped = (await compose({ poolMax: 3 })).api.deps.pools;
    expect([clamped.core.options.max, clamped.svc.options.max]).toEqual([3, 3]);
    const own = (await compose()).api.deps.pools;
    expect([own.core.options.max, own.svc.options.max]).toEqual([10, 5]);
  });
});
