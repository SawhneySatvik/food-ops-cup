// T-095b gates (ADR-015 §2, §8): the public Munim Cares network, the storefront Cares section, the per-client rate limit
// and the operator-minted, draft-published network impact total — through the real app on embedded Postgres. Synthetic
// data only. Expected values are hand-typed from the fixtures (this file's live listings; the canonical world's Cares rows,
// db/src/world.ts addCares: per world, two recorded donation hand-overs of one 200000 milli-g line each, in mumbai).
//   rate limit: injected clock 60th → 200, 61st → 429 + Retry-After, after the window → 200; X-Forwarded-For with
//     HOPS = 1 keys the right-most entry (a spoofed left entry has no effect); storefront limit per IP across keys (70 junk
//     keys from one IP → exactly 60 past the limiter), then per (IP, key); a key-spraying IP never resets another IP's
//     window; at the key cap the oldest window is evicted, never all of them
//   allow-list: every response's keys = the hand-typed list (a planted column fails)
//   storefront: key A shows A's listings and 0 of B's; a bad key and a counter-channel key → 404; never cached
//   network: retired, judge and not-enabled tenants absent; cached 30 s
//   impact: unpublished → 404; published → every value beside a ref that snapshots/{id} resolves (rows + sha256);
//     labels unconditional even with all_synthetic = false
//   mint: the member and intel mints of the operator template are refused (each paired with an accept)
// Red-proof: test/cares-network-redproof.sh (planted source reverts in a scratch copy → non-zero exit).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash, randomBytes } from "node:crypto";
import { createLogger } from "@munim/config";
import { parseRef, Snapshot, STOREFRONT_KEY_HEADER } from "@munim/contracts";
import {
  CaresNetworkCitiesResponse, CaresNetworkImpactResponse, CaresNetworkListing, CaresNetworkListingsResponse, CaresNetworkSnapshotResponse,
  CaresOperatorNetworkSnapshot, CaresOperatorNetworkSnapshotsResponse, CaresStorefrontResponse,
} from "@munim/contracts/cares";
import { buildWorld, ownerCtx, type TestDb, uuidv7, type World } from "@munim/db";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalIdp } from "../src/auth/local-idp.ts";
import { type AppEnv, createApp, type Deps, storefrontResolver, TENANT_HEADER } from "../src/app.ts";
import { canonicalJson, sha256Hex } from "../src/commit/index.ts";
import { svcTx, testKeys } from "../src/commit/testkit.ts";
import { configureInternal } from "../src/internal/index.ts";
import { FixedWindow } from "../src/lib/ratelimit.ts";
import { configureCaresNetwork } from "../src/modules/cares-network/index.ts";
import { mintRunToken } from "../src/runtoken/index.ts";
import { openDb } from "./db.ts";
import { buildTenant, type Tenant } from "./world.ts";
import type { Hono } from "hono";

const idp = createLocalIdp();
const keys = testKeys();
const SECRET = "t095b-test-service-secret-not-real-0123456789abcdef";
const OP_SUB = "cares-network-operator";
let db: TestDb;
let pools: { core: pg.Pool; svc: pg.Pool; platform: pg.Pool };
let app: Hono<AppEnv>;
let A: Tenant, B: Tenant, R: World, J: World, N: World;
let opId: string;
/** Pickup-channel storefront keys (the world's own key sits on the counter channel). */
let KEY_A: string, KEY_B: string;
const live: { A1: string; A2: string; B1: string; R1: string; J1: string; N1: string } = { A1: "", A2: "", B1: "", R1: "", J1: "", N1: "" };

// Hand-typed allow-lists (= the contract's public shapes; never read from the code under test).
const LISTING_KEYS = ["business_name", "city_code", "lines", "listing_id", "outlet_name", "pickup_from", "pickup_to", "recipient_name", "recipient_simulated", "tz"];
const LINE_KEYS = ["expires_on", "food_kind", "label", "label_key", "line_no", "qty_milli", "unit"];
const IMPACT_KEYS = ["as_of", "labels", "note_key", "rows", "snapshot_id", "template_id", "template_version"];
const IMPACT_ROW_KEYS = ["all_synthetic", "businesses", "city_code", "donations", "meals_portions_milli", "volume_ml", "weight_g"];
const SNAPSHOT_KEYS = ["columns", "created_at", "labels", "note_key", "params", "published_at", "row_count", "rows", "sha256", "snapshot_id", "template_id", "template_version"];
const LABELS = { data: "Measured on synthetic data", recipients: "to simulated recipients" };
const sorted = (o: object) => Object.keys(o).sort();

type Res = Omit<Response, "json"> & { json(): Promise<any> };
/** A public request from socket address `ip` (the node adapter's `incoming`), optionally through proxies. */
const pub = (path: string, o: { ip?: string; xff?: string; key?: string } = {}): Promise<Res> =>
  app.request(path, { headers: { ...(o.xff ? { "X-Forwarded-For": o.xff } : {}), ...(o.key !== undefined ? { [STOREFRONT_KEY_HEADER]: o.key } : {}) } },
    { incoming: { socket: { remoteAddress: o.ip ?? "192.0.2.1" } } }) as Promise<Res>;
const asSub = (method: string, path: string, sub: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> =>
  app.request(path, {
    method,
    headers: { Authorization: `Bearer ${idp.sign({ sub })}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...extra },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }) as Promise<Res>;
const operator = (method: string, path: string, body?: unknown) => asSub(method, path, OP_SUB, body);

let clock = Date.UTC(2026, 9, 13, 6, 0, 0);
/** Fresh limiter windows and cache, on the injected clock. */
const reset = (hops = 0, maxKeys?: number) => configureCaresNetwork({ now: () => clock, trustedProxyHops: hops, ...(maxKeys === undefined ? {} : { maxKeys }) });

/** A live donation (one raw line of the world's ingredient, 300000 g-milli) whose pickup starts `hours` from now. */
async function publishLive(w: World, hours: number): Promise<string> {
  const id = uuidv7();
  const recipient = (await db.admin<{ id: string }>(`SELECT recipient_id id FROM core.cares_listing WHERE tenant_id = $1 AND kind = 'donation' LIMIT 1`, [w.tenant])).rows[0]!.id;
  await db.withContext("munim_core", ownerCtx(w, { command_type: "cares.listing.publish.v1" }), async (c) => {
    await c.query(`INSERT INTO core.cares_listing (tenant_id, id, outlet_id, kind, recipient_id, pickup_from, pickup_to, pickup_on, published_by)
                   SELECT $1, $2, $3, 'donation', $4, now() + make_interval(hours => $5), now() + make_interval(hours => $5 + 2),
                          (((now() + make_interval(hours => $5)) AT TIME ZONE ou.tz) - ou.business_day_cutoff)::date, $6
                     FROM core.outlet ou WHERE ou.tenant_id = $1 AND ou.id = $3`, [w.tenant, id, w.outlets[0], recipient, hours, w.owner]);
    await c.query(`INSERT INTO core.cares_listing_line (tenant_id, id, listing_id, line_no, food_kind, ingredient_id, qty_milli, unit)
                   VALUES ($1, $2, $3, 1, 'raw', $4, 300000, 'g')`, [w.tenant, uuidv7(), id, w.ingredient]);
  });
  return id;
}

async function pickupKey(t: Tenant): Promise<string> {
  const key = `sfk_cares_${randomBytes(24).toString("hex")}`;
  const ch = uuidv7();
  await db.withContext("munim_core", ownerCtx(t, { command_type: "tenancy.channel.create.v1" }), (c) =>
    c.query(`INSERT INTO core.channel (tenant_id, id, name, kind) VALUES ($1, $2, 'Pickup', 'pickup')`, [t.tenant, ch]));
  await db.withContext("munim_core", ownerCtx(t), (c) =>
    c.query(`INSERT INTO core.storefront_key (tenant_id, id, channel_id, key_hash) VALUES ($1, $2, $3, $4)`,
      [t.tenant, uuidv7(), ch, createHash("sha256").update(key).digest("hex")]));
  return key;
}

/** Publishes a network snapshot as platform/drafts.ts approve does: a draft targeting it, the target written, then the
 *  draft applied — one munim_platform transaction (0028's deferred draft_applied check). */
async function publishByDraft(snapshotId: string): Promise<string> {
  const draft = uuidv7();
  await db.withContext("munim_platform", {}, async (c) => {
    await c.query(`INSERT INTO platform.config_draft (id, target, patch, proposed_by) VALUES ($1, $2, '{}', $3)`,
      [draft, `cares_public_impact:${snapshotId}`, `operator:${opId}`]);
    await c.query(`UPDATE platform.network_snapshot SET published_at = now(), publish_draft_id = $2 WHERE id = $1`, [snapshotId, draft]);
    await c.query(`UPDATE platform.config_draft SET status = 'applied', decided_by = $2, decided_at = now() WHERE id = $1`, [draft, opId]);
  });
  return draft;
}

beforeAll(async () => {
  db = await openDb();
  A = await buildTenant(db, "a");
  B = await buildTenant(db, "b");
  [R, J, N] = [await buildWorld(db), await buildWorld(db), await buildWorld(db)];
  opId = uuidv7();
  await db.admin(`INSERT INTO platform.operator (id, idp_sub, email) VALUES ($1, $2, 'cares-network-op@example.test')`, [opId, OP_SUB]);
  KEY_A = await pickupKey(A);
  KEY_B = await pickupKey(B);
  live.A1 = await publishLive(A, 2);
  live.A2 = await publishLive(A, 3);
  live.B1 = await publishLive(B, 2);
  live.R1 = await publishLive(R, 2);
  live.J1 = await publishLive(J, 2);
  live.N1 = await publishLive(N, 2);
  // R retired, J gains an active judge, N's enablement turned off by an applied config draft.
  await db.withContext("munim_core", ownerCtx(R, { command_type: "tenancy.tenant.update.v1" }), (c) =>
    c.query(`UPDATE core.tenant SET status = 'retired' WHERE tenant_id = $1`, [R.tenant]));
  await db.withContext("munim_core", ownerCtx(J, { command_type: "tenancy.member.invite.v1" }), async (c) => {
    const judge = uuidv7();
    await c.query(`INSERT INTO core.member (tenant_id, id, name, email, is_ephemeral_judge) VALUES ($1, $2, 'Judge', 'judge@example.test', true)`, [J.tenant, judge]);
    await c.query(`INSERT INTO core.membership (tenant_id, member_id, role) VALUES ($1, $2, 'judge')`, [J.tenant, judge]);
  });
  await db.withContext("munim_platform", {}, async (c) => {
    const d = uuidv7();
    await c.query(`INSERT INTO platform.config_draft (id, target, patch, proposed_by) VALUES ($1, $2, '{"enabled": false}', $3)`, [d, `cares_enablement:${N.tenant}`, `operator:${opId}`]);
    await c.query(`UPDATE platform.cares_enablement SET enabled = false, config_draft_id = $2 WHERE tenant_id = $1`, [N.tenant, d]);
    await c.query(`UPDATE platform.config_draft SET status = 'applied', decided_by = $2, decided_at = now() WHERE id = $1`, [d, opId]);
  });
  pools = { core: db.pool("munim_core", 6), svc: db.pool("munim_svc", 2), platform: db.pool("munim_platform", 2) };
  const config = { nodeEnv: "test", redact: (s: string) => s };
  const deps: Deps = { pools, idp, storefronts: storefrontResolver(pools.core), config, log: createLogger(config, () => {}) } as never;
  app = await createApp(deps);
  configureInternal(deps, { serviceSecret: SECRET, keys });
});

afterAll(async () => {
  configureCaresNetwork();
  await Promise.allSettled([pools?.core.end(), pools?.svc.end(), pools?.platform.end()]);
  await db?.stop();
});

describe("rate limit: 60 a minute per client (ADR-015 §2.2)", () => {
  it("injected clock: the 60th request → 200, the 61st → 429 rate_limited + Retry-After, after the window → 200", async () => {
    reset();
    for (let i = 1; i <= 60; i++) expect((await pub("/v1/cares-network/cities", { ip: "198.51.100.1" })).status, `request ${i}`).toBe(200);
    clock += 15_000;
    const r = await pub("/v1/cares-network/cities", { ip: "198.51.100.1" });
    expect(r.status).toBe(429);
    expect(r.headers.get("Retry-After")).toBe("45");
    expect((await r.json()).error).toMatchObject({ reason_code: "rate_limited" });
    // Another client is unaffected; the limit is across every network route.
    expect((await pub("/v1/cares-network/cities", { ip: "198.51.100.2" })).status).toBe(200);
    expect((await pub("/v1/cares-network/listings", { ip: "198.51.100.1" })).status).toBe(429);
    clock += 45_000;
    expect((await pub("/v1/cares-network/cities", { ip: "198.51.100.1" })).status).toBe(200);
  });

  it("X-Forwarded-For with HOPS = 1 keys the right-most entry; a spoofed left entry has no effect", async () => {
    reset(1);
    for (let i = 1; i <= 60; i++) {
      const r = await pub("/v1/cares-network/cities", { ip: "10.0.0.1", xff: `203.0.113.${i}, 198.51.100.77, 203.0.113.9` });
      expect(r.status, `request ${i}`).toBe(200);
    }
    // New spoofed left entries, same right-most: still the same client.
    expect((await pub("/v1/cares-network/cities", { ip: "10.0.0.1", xff: "1.2.3.4, 5.6.7.8, 203.0.113.9" })).status).toBe(429);
    expect((await pub("/v1/cares-network/cities", { ip: "10.0.0.2", xff: "203.0.113.9" })).status).toBe(429);
    // Same left entries, another right-most (another client behind the proxy) → admitted.
    expect((await pub("/v1/cares-network/cities", { ip: "10.0.0.1", xff: "203.0.113.1, 198.51.100.77, 203.0.113.10" })).status).toBe(200);
  });

  it("HOPS = 0: X-Forwarded-For is ignored, the socket address is the key", async () => {
    reset(0);
    for (let i = 1; i <= 60; i++) expect((await pub("/v1/cares-network/cities", { ip: "10.9.9.9", xff: `203.0.113.${i}` })).status).toBe(200);
    expect((await pub("/v1/cares-network/cities", { ip: "10.9.9.9", xff: "203.0.113.200" })).status).toBe(429);
    expect((await pub("/v1/cares-network/cities", { ip: "10.9.9.8", xff: "203.0.113.200" })).status).toBe(200);
  });

  it("the storefront section is limited per IP across keys, then per (IP, key): another key on the same IP → 429, another IP → 200", async () => {
    reset();
    for (let i = 1; i <= 60; i++) expect((await pub("/v1/storefront/cares", { ip: "198.51.100.30", key: KEY_A })).status, `request ${i}`).toBe(200);
    const r = await pub("/v1/storefront/cares", { ip: "198.51.100.30", key: KEY_A });
    expect(r.status).toBe(429);
    expect(r.headers.get("Retry-After")).toBe("60");
    expect((await pub("/v1/storefront/cares", { ip: "198.51.100.30", key: KEY_B })).status).toBe(429);
    expect((await pub("/v1/storefront/cares", { ip: "198.51.100.31", key: KEY_A })).status).toBe(200);
  });

  it("70 requests with 70 different junk keys from one IP → exactly 60 past the limiter (404), 10 → 429", async () => {
    reset();
    const got: number[] = [];
    for (let i = 1; i <= 70; i++) got.push((await pub("/v1/storefront/cares", { ip: "198.51.100.40", key: `sfk_junk_${i}_${randomBytes(8).toString("hex")}` })).status);
    expect([got.filter((s) => s !== 429).length, got.filter((s) => s === 404).length, got.filter((s) => s === 429).length]).toEqual([60, 60, 10]);
  });

  it("one IP spraying keys past the key cap does not reset another IP's window", async () => {
    reset(0, 50); // a cap below one IP's 60, so the spray would overflow the per-(IP, key) map
    for (let i = 1; i <= 60; i++) expect((await pub("/v1/storefront/cares", { ip: "198.51.100.50", key: KEY_A })).status, `request ${i}`).toBe(200);
    expect((await pub("/v1/storefront/cares", { ip: "198.51.100.50", key: KEY_A })).status).toBe(429);
    for (let i = 1; i <= 70; i++) await pub("/v1/storefront/cares", { ip: "198.51.100.51", key: `sfk_spray_${i}_${randomBytes(8).toString("hex")}` });
    expect((await pub("/v1/storefront/cares", { ip: "198.51.100.50", key: KEY_A })).status).toBe(429);
    expect((await pub("/v1/storefront/cares", { ip: "198.51.100.52", key: KEY_A })).status).toBe(200);
  });

  it("FixedWindow at its key cap evicts the oldest open window, never all of them; a restarted window counts as new", () => {
    let t = 0;
    const w = new FixedWindow(2, 60_000, () => t, 2);
    const run = (k: string, n: number) => Array.from({ length: n }, () => w.hit(k));
    expect(run("A", 3)).toEqual([null, null, 60]); // A exhausted
    t = 1_000;
    expect(run("B", 3)).toEqual([null, null, 60]); // B exhausted
    t = 2_000;
    expect(w.hit("C")).toBeNull(); // a third key at the cap of 2: only A (the oldest) goes
    expect(w.hit("B")).toBe(59); // B is still refused
    // Restart order: A restarts at 60 s, so B (opened at 1 s) is the oldest when C arrives, and A stays refused.
    t = 0;
    const r = new FixedWindow(1, 60_000, () => t, 2);
    expect([r.hit("A"), ((t = 1_000), r.hit("B")), ((t = 60_000), r.hit("A")), ((t = 60_500), r.hit("C")), r.hit("A")]).toEqual([null, null, null, null, 60]);
  });
});

describe("network listings (ADR-015 §2.1)", () => {
  it("cities: the 1 active city of the fixture (mumbai, IN), keys = allow-list", async () => {
    reset();
    const r = await pub("/v1/cares-network/cities");
    expect(r.status).toBe(200);
    expect(r.headers.get("Cache-Control")).toBe("public, max-age=30");
    const body = CaresNetworkCitiesResponse.parse(await r.json());
    expect(body.items).toEqual([{ code: "mumbai", country_code: "IN", name: "Mumbai" }]);
  });

  it("exactly A's 2 and B's 1 live donations; retired, judge and not-enabled tenants absent; keys = allow-list exactly", async () => {
    reset();
    const raw = await (await pub("/v1/cares-network/listings")).json();
    const body = CaresNetworkListingsResponse.parse(raw);
    expect(body.items.map((x) => x.listing_id).sort()).toEqual([live.A1, live.A2, live.B1].sort());
    for (const hidden of [live.R1, live.J1, live.N1]) expect(body.items.map((x) => x.listing_id)).not.toContain(hidden);
    expect(sorted(raw)).toEqual(["items", "next_cursor"]);
    for (const item of raw.items) {
      expect(sorted(item)).toEqual(LISTING_KEYS);
      expect(item.lines).toHaveLength(1);
      for (const l of item.lines) expect(sorted(l)).toEqual(LINE_KEYS);
      expect(item).toMatchObject({ city_code: "mumbai", tz: "Asia/Kolkata", recipient_name: "Lotus Lane Food Bank (simulated)", recipient_simulated: true });
      expect(item.lines[0]).toMatchObject({ line_no: 1, food_kind: "raw", qty_milli: 300000, unit: "g" });
    }
    expect(CaresNetworkListingsResponse.parse(await (await pub("/v1/cares-network/listings?city=melbourne")).json()).items).toEqual([]);
  });

  it("pagination: limit 2 → 2 items and a cursor; the next page → the 1 left, no cursor", async () => {
    reset();
    const p1 = CaresNetworkListingsResponse.parse(await (await pub("/v1/cares-network/listings?limit=2")).json());
    expect(p1.items).toHaveLength(2);
    expect(p1.next_cursor).toBe(p1.items[1]!.listing_id);
    const p2 = CaresNetworkListingsResponse.parse(await (await pub(`/v1/cares-network/listings?limit=2&cursor=${p1.next_cursor}`)).json());
    expect(p2.items).toHaveLength(1);
    expect(p2.next_cursor).toBeNull();
    expect([...p1.items, ...p2.items].map((x) => x.listing_id).sort()).toEqual([live.A1, live.A2, live.B1].sort());
    for (const bad of ["?limit=0", "?limit=51", "?cursor=nope", "?city=Mumbai"]) expect((await pub(`/v1/cares-network/listings${bad}`)).status, bad).toBe(400);
  });

  it("listings/{id}: a live one opens (keys = allow-list); a hidden tenant's, or an unknown id → 404", async () => {
    reset();
    const r = await pub(`/v1/cares-network/listings/${live.B1}`);
    expect(r.status).toBe(200);
    const raw = await r.json();
    expect(sorted(raw)).toEqual(LISTING_KEYS);
    expect(CaresNetworkListing.parse(raw).listing_id).toBe(live.B1);
    for (const id of [live.R1, live.J1, live.N1, uuidv7()]) expect((await pub(`/v1/cares-network/listings/${id}`)).status, id).toBe(404);
  });

  it("network 200s are cached 30 s (a withdrawn listing shows until then); the storefront section is not cached", async () => {
    reset();
    const extra = await publishLive(B, 4);
    const ids = async () => CaresNetworkListingsResponse.parse(await (await pub("/v1/cares-network/listings")).json()).items.map((x) => x.listing_id);
    const sf = async () => CaresStorefrontResponse.parse(await (await pub("/v1/storefront/cares", { key: KEY_B })).json()).items.map((x) => x.listing_id);
    expect(await ids()).toContain(extra);
    expect(await sf()).toContain(extra);
    await db.withContext("munim_core", ownerCtx(B, { command_type: "cares.listing.withdraw.v1" }), (c) =>
      c.query(`UPDATE core.cares_listing SET status = 'withdrawn' WHERE tenant_id = $1 AND id = $2`, [B.tenant, extra]));
    clock += 29_000;
    expect(await ids()).toContain(extra); // cached
    expect(await sf()).not.toContain(extra); // uncached
    clock += 1_001;
    expect(await ids()).not.toContain(extra);
  });
});

describe("storefront Cares section (ADR-015 §2.1)", () => {
  it("key A shows A's 2 live listings and 0 of B's; key B shows B's 1; Cache-Control no-store; keys = allow-list", async () => {
    reset();
    const ra = await pub("/v1/storefront/cares", { key: KEY_A });
    expect(ra.status).toBe(200);
    expect(ra.headers.get("Cache-Control")).toBe("no-store");
    const rawA = await ra.json();
    expect(sorted(rawA)).toEqual(["items"]);
    const a = CaresStorefrontResponse.parse(rawA).items.map((x) => x.listing_id).sort();
    expect(a).toEqual([live.A1, live.A2].sort());
    expect(a.filter((id) => id === live.B1)).toHaveLength(0);
    for (const item of rawA.items) {
      expect(sorted(item)).toEqual(LISTING_KEYS);
      expect(item.tz).toBe("Asia/Kolkata"); // the outlet's zone (buildTenant: IN)
    }
    const b = CaresStorefrontResponse.parse(await (await pub("/v1/storefront/cares", { key: KEY_B })).json()).items.map((x) => x.listing_id);
    expect(b).toEqual([live.B1]);
  });

  it("a bad key, a missing key, and a key on a counter channel → 404 (never 403)", async () => {
    reset();
    for (const key of [`${KEY_A}x`, "short", KEY_A.slice(0, -1), A.storefrontKey, undefined]) {
      const r = await pub("/v1/storefront/cares", key === undefined ? {} : { key });
      expect(r.status, String(key?.slice(0, 12))).toBe(404);
      expect((await r.json()).error.code).toBe("not_found");
    }
  });
});

describe("network impact total (ADR-015 §2.3)", () => {
  let snap: ReturnType<typeof CaresOperatorNetworkSnapshot.parse>;

  it("member and intel mints of the operator template are refused (404); each caller's own template is accepted", async () => {
    const network = { template_id: "platform.cares_network_impact", params: { from: "2026-10-01", to: "2026-10-31", city_code: null } };
    const member = await asSub("POST", "/v1/snapshots", A.ownerSub, network, { [TENANT_HEADER]: A.tenant });
    expect(member.status).toBe(404);
    const memberOk = await asSub("POST", "/v1/snapshots", A.ownerSub, { template_id: "inventory.below_reorder", params: {} }, { [TENANT_HEADER]: A.tenant });
    expect(memberOk.status).toBe(201);
    Snapshot.parse(await memberOk.json());
    const { token } = await mintRunToken({ ...keys, svc: svcTx(db) }, { tenantId: A.tenant, outletScope: ["*"], trigger: "event", actor: "watcher:inventory_purchasing" });
    const intel = (body: unknown) => app.request("/internal/intel/v1/snapshots", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "x-munim-service-secret": SECRET, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect((await intel(network)).status).toBe(404);
    expect((await intel({ template_id: "inventory.below_reorder", params: {} })).status).toBe(201);
    // The operator's tenant-snapshot route refuses it too (network-only: never into a tenant's evidence).
    expect((await operator("POST", "/platform/v1/snapshots", { tenant_id: A.tenant, ...network })).status).toBe(404);
    // A member is not an operator on the network route either.
    expect((await asSub("POST", "/platform/v1/network-snapshots", A.ownerSub, network)).status).toBe(404);
    expect(Number((await db.admin(`SELECT count(*) n FROM evidence.snapshot WHERE template_id = 'platform.cares_network_impact'`)).rows[0]!.n)).toBe(0);
    expect(Number((await db.admin(`SELECT count(*) n FROM platform.network_snapshot`)).rows[0]!.n)).toBe(0);
  });

  it("the operator mints it (201, unpublished): Σ = 2 businesses, 4 donations, 800 g; bad params refused", async () => {
    const r = await operator("POST", "/platform/v1/network-snapshots",
      { template_id: "platform.cares_network_impact", params: { from: "2026-10-01", to: "2026-10-31", city_code: null } });
    expect(r.status).toBe(201);
    snap = CaresOperatorNetworkSnapshot.parse(await r.json());
    expect(snap).toMatchObject({ minted_by_operator_id: opId, published_at: null, publish_draft_id: null, row_count: 2 });
    expect(snap.rows[0]).toEqual({ city_code: null, businesses: 2, donations: 4, meals_portions_milli: 0, weight_g: 800, volume_ml: 0, all_synthetic: false });
    expect(snap.rows[1]).toEqual({ city_code: "mumbai", businesses: 2, donations: 4, meals_portions_milli: 0, weight_g: 800, volume_ml: 0, all_synthetic: false });
    for (const [body, status] of [
      [{ template_id: "platform.cares_network_impact", params: { from: "2026-10-01", to: "2026-10-31" } }, 422],
      [{ template_id: "platform.cares_network_impact", params: { from: "2026-02-30", to: "2026-10-31", city_code: null } }, 422],
      [{ template_id: "inventory.below_reorder", params: {} }, 404],
      [{ params: {} }, 400],
    ] as const) expect((await operator("POST", "/platform/v1/network-snapshots", body)).status, JSON.stringify(body)).toBe(status);
    const list = CaresOperatorNetworkSnapshotsResponse.parse(await (await operator("GET", "/platform/v1/network-snapshots")).json());
    expect(list.items.map((x) => x.snapshot_id)).toEqual([snap.snapshot_id]);
  });

  it("unpublished → impact 404 and snapshots/{id} 404", async () => {
    reset();
    expect((await pub("/v1/cares-network/impact")).status).toBe(404);
    expect((await pub(`/v1/cares-network/snapshots/${snap.snapshot_id}`)).status).toBe(404);
  });

  it("published by an applied config draft → every value beside a ref that snapshots/{id} resolves; sha256 recomputes; labels unconditional", async () => {
    reset();
    const draft = await publishByDraft(snap.snapshot_id);
    const r = await pub("/v1/cares-network/impact");
    expect(r.status).toBe(200);
    const raw = await r.json();
    expect(sorted(raw)).toEqual(IMPACT_KEYS);
    const impact = CaresNetworkImpactResponse.parse(raw);
    expect(impact).toMatchObject({ snapshot_id: snap.snapshot_id, template_id: "platform.cares_network_impact", template_version: 1, as_of: snap.created_at });
    // all_synthetic is false in this fixture, and both labels are still there (DECISIONS 12 Oct ruling).
    expect(impact.rows[0]!.all_synthetic.value).toBe(false);
    expect(impact.labels).toEqual(LABELS);
    expect(impact.note_key).toBe("cares.note.check_local_rules");
    const sr = await pub(`/v1/cares-network/snapshots/${snap.snapshot_id}`);
    expect(sr.status).toBe(200);
    const sraw = await sr.json();
    expect(sorted(sraw)).toEqual(SNAPSHOT_KEYS);
    const opened = CaresNetworkSnapshotResponse.parse(sraw);
    expect(opened.labels).toEqual(LABELS);
    expect(opened.sha256).toBe(sha256Hex(canonicalJson(opened.rows)));
    expect(opened.sha256).toBe(snap.sha256);
    let resolved = 0;
    expect(impact.rows).toHaveLength(2);
    for (const row of impact.rows) {
      expect(sorted(row)).toEqual(IMPACT_ROW_KEYS);
      for (const [col, fact] of Object.entries(row)) {
        if (col === "city_code") continue;
        const ref = parseRef((fact as { ref: string }).ref);
        expect(ref?.kind).toBe("snap");
        if (ref?.kind !== "snap") continue;
        expect(ref.snapshot_id).toBe(snap.snapshot_id);
        expect(ref.column).toBe(col);
        expect(opened.rows[ref.row]![ref.column]).toBe((fact as { value: unknown }).value);
        resolved++;
      }
    }
    expect(resolved).toBe(12); // 2 rows × 6 facts
    expect(impact.rows[0]!.donations.value).toBe(4);
    expect(impact.rows[1]!.city_code).toBe("mumbai");
    // ?city: the network-wide snapshot has a mumbai row → served; no snapshot covers melbourne → 404.
    expect(CaresNetworkImpactResponse.parse(await (await pub("/v1/cares-network/impact?city=mumbai")).json()).snapshot_id).toBe(snap.snapshot_id);
    expect((await pub("/v1/cares-network/impact?city=melbourne")).status).toBe(404);
    const after = CaresOperatorNetworkSnapshotsResponse.parse(await (await operator("GET", "/platform/v1/network-snapshots")).json());
    expect(after.items[0]).toMatchObject({ snapshot_id: snap.snapshot_id, publish_draft_id: draft });
    expect(after.items[0]!.published_at).not.toBeNull();
  });
});
