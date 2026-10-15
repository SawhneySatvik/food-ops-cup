// Gates through the real auth → withContext → RLS path:
//   tenant A's token reads ≥ 1 own row and 0 of tenant B's; an outlet-scoped manager reads only that outlet;
//   forged / expired / foreign-key / missing token → 401, valid → 200; wrong tenant → 404;
//   operator and customer lanes resolve from rows (R41: one login, a separate profile per merchant);
//   error bodies carry no SQL text when a query fails.
import { createHash } from "node:crypto";
import { createLogger } from "@munim/config";
import type { TestDb } from "@munim/db";
import type { Hono } from "hono";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type AppEnv, contextOf, createApp, GUEST_TOKEN_HEADER, requireCustomer, requireGuest, requireMember, requireOperator, STOREFRONT_KEY_HEADER,
  storefrontResolver, TENANT_HEADER, withContext,
} from "../src/app.ts";
import { createLocalIdp } from "../src/auth/local-idp.ts";
import { openDb } from "./db.ts";
import { addCustomer, addGuestOrder, buildTenant, type Tenant } from "./world.ts";

const idp = createLocalIdp();
const lines: string[] = [];
let db: TestDb;
let pools: { core: pg.Pool; svc: pg.Pool };
let app: Hono<AppEnv>;
let A: Tenant;
let B: Tenant;
let customerA: string;
let customerB: string;
const OPERATOR_SUB = "operator-sub-1";
const CUSTOMER_SUB = "customer-sub-1";
let KEY_A: string;
let guestA: { order: string; token: string };
let guestB: { order: string; token: string };
const UUID7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const get = (path: string, sub: string | null, tenant?: string, extra: Record<string, string> = {}) =>
  app.request(path, {
    headers: { ...(sub ? { Authorization: `Bearer ${idp.sign({ sub })}` } : {}), ...(tenant ? { [TENANT_HEADER]: tenant } : {}), ...extra },
  });

beforeAll(async () => {
  db = await openDb();
  A = await buildTenant(db, "A");
  B = await buildTenant(db, "B");
  // The same login has a profile at both merchants (R41).
  customerA = await addCustomer(db, A, CUSTOMER_SUB);
  customerB = await addCustomer(db, B, CUSTOMER_SUB);
  await addCustomer(db, A, "someone-else");
  KEY_A = A.storefrontKey;
  guestA = await addGuestOrder(db, A, customerA);
  guestB = await addGuestOrder(db, B, customerB);
  await db.admin(`INSERT INTO platform.operator (id, idp_sub, email) VALUES (gen_random_uuid(), $1, 'ops@example.test')`, [OPERATOR_SUB]);

  pools = { core: db.pool("munim_core", 4), svc: db.pool("munim_svc", 2) };
  const config = { nodeEnv: "test", redact: (s: string) => s };
  app = await createApp({
    pools,
    idp,
    storefronts: storefrontResolver(pools.core),
    config,
    log: createLogger(config, (l) => lines.push(l)),
  });
  // Test-only routes on the same app (same onError, same auth middleware).
  app.get("/v1/_test/bad-query", requireMember, async (c) => {
    await withContext(c.var.deps.pools.core, contextOf(c.var.principal), (q) => q.query("SELECT secret_col FROM core.no_such_table"));
    return c.json({}, 200);
  });
  app.get("/v1/_test/book-write", requireMember, async (c) => {
    // No command_type in context → the book guard refuses (MB001).
    await withContext(c.var.deps.pools.core, contextOf(c.var.principal), (q) =>
      q.query("UPDATE core.outlet SET name = 'renamed' WHERE tenant_id = $1", [c.var.principal.kind === "member" ? c.var.principal.tenant_id : null]));
    return c.json({}, 200);
  });
  app.get("/platform/v1/_test/whoami", requireOperator, (c) => c.json(c.var.principal, 200));
  app.get("/v1/_test/customer", requireCustomer, async (c) => {
    const rows = await withContext(c.var.deps.pools.core, contextOf(c.var.principal), async (q) =>
      (await q.query<{ id: string }>("SELECT id FROM core.customer")).rows);
    const { devices, outlets } = await withContext(c.var.deps.pools.core, contextOf(c.var.principal), async (q) => ({
      devices: (await q.query("SELECT id FROM core.device")).rowCount,
      outlets: (await q.query<{ o: string }>("SELECT current_setting('app.outlet_ids', true) AS o")).rows[0]!.o,
    }));
    return c.json({ principal: c.var.principal, visible: rows.map((r) => r.id), devices, outlets }, 200);
  });
  app.get("/v1/_test/guest", requireGuest, (c) => c.json(c.var.principal, 200));
});
afterAll(async () => {
  await Promise.allSettled([pools.core.end(), pools.svc.end()]);
  await db.stop();
});

type Devices = { devices: Array<{ tenant_id: string; id: string; outlet_id: string }> };

describe("tenant isolation via the probe route", () => {
  it("tenant A's owner reads both own devices and 0 of tenant B's", async () => {
    const res = await get("/v1/_probe/devices", A.ownerSub, A.tenant);
    expect(res.status).toBe(200);
    const { devices } = (await res.json()) as Devices;
    expect(devices.length).toBeGreaterThanOrEqual(1);
    expect(devices.map((d) => d.id).sort()).toEqual([...A.devices].sort());
    expect(devices.filter((d) => d.tenant_id === B.tenant || B.devices.includes(d.id))).toHaveLength(0);
    // B's rows exist (the zero above is RLS, not an empty table): B's owner sees exactly B's two.
    const resB = (await (await get("/v1/_probe/devices", B.ownerSub, B.tenant)).json()) as Devices;
    expect(resB.devices.map((d) => d.id).sort()).toEqual([...B.devices].sort());
  });

  it("tenant A's token naming tenant B → 404 (never 403), unknown or malformed tenant → 404", async () => {
    for (const tenant of [B.tenant, "00000000-0000-0000-0000-000000000000", "not-a-uuid", undefined]) {
      const res = await get("/v1/_probe/devices", A.ownerSub, tenant);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: { code: "not_found", message: "Not found.", reason_code: null } });
    }
  });

  it("an outlet-scoped manager reads only their outlet's device", async () => {
    const res = await get("/v1/_probe/devices", A.managerSub, A.tenant);
    expect(res.status).toBe(200);
    const { devices } = (await res.json()) as Devices;
    expect(devices).toHaveLength(1);
    expect(devices[0]).toEqual({ tenant_id: A.tenant, id: A.devices[0], outlet_id: A.outlets[0] });
  });
});

describe("token verification", () => {
  it("valid → 200; forged, foreign-key, expired, wrong-issuer, missing or garbage → 401", async () => {
    expect((await get("/v1/_probe/devices", A.ownerSub, A.tenant)).status).toBe(200);

    const valid = idp.sign({ sub: A.ownerSub });
    const [h, , s] = valid.split(".");
    const forgedBody = Buffer.from(JSON.stringify({ sub: B.ownerSub, iss: "munim-idp-local", aud: "munim", exp: 9_999_999_999 })).toString("base64url");
    const cases: Record<string, string | null> = {
      forged: `${h}.${forgedBody}.${s}`,
      foreignKey: createLocalIdp().sign({ sub: A.ownerSub }),
      expired: idp.sign({ sub: A.ownerSub }, { ttlSeconds: -1 }),
      wrongIssuer: idp.sign({ sub: A.ownerSub }, { issuer: "someone-else" }),
      algNone: `${Buffer.from('{"alg":"none"}').toString("base64url")}.${forgedBody}.`,
      garbage: "not.a.jwt",
      missing: null,
    };
    for (const [name, token] of Object.entries(cases)) {
      const res = await app.request("/v1/_probe/devices", {
        headers: { [TENANT_HEADER]: A.tenant, ...(token !== null ? { Authorization: `Bearer ${token}` } : {}) },
      });
      expect([name, res.status]).toEqual([name, 401]);
      expect(await res.json()).toEqual({ error: { code: "unauthenticated", message: "Sign in again.", reason_code: null } });
    }
  });
});

describe("operator and customer lanes", () => {
  it("an operator row resolves on /platform; a member's token there → 404", async () => {
    const ok = await get("/platform/v1/_test/whoami", OPERATOR_SUB);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { kind: string }).kind).toBe("operator");
    expect((await get("/platform/v1/_test/whoami", A.ownerSub)).status).toBe(404);
  });

  it("customer token at merchant A resolves A's profile only, with the key's channel; sees exactly that one row and no outlet rows", async () => {
    const res = await get("/v1/_test/customer", CUSTOMER_SUB, undefined, { [STOREFRONT_KEY_HEADER]: KEY_A });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { principal: Record<string, unknown>; visible: string[]; devices: number; outlets: string };
    expect(body.principal).toEqual({ kind: "customer", tenant_id: A.tenant, channel_id: A.channel, customer_id: customerA, profile: true, sub: CUSTOMER_SUB });
    expect(body.principal.customer_id).not.toBe(customerB);
    expect(body.visible).toEqual([customerA]); // A holds several customer rows; RLS shows the caller only theirs
    // No outlet wildcard for customers (W1 fix #31): the context carries an empty outlet set, so no outlet row
    // is reachable whatever the DB's own customer policies do (A has 2 devices).
    expect(body.outlets).toBe("{}");
    expect(body.devices).toBe(0);
  });

  it("no profile here (first sign-in or guest) → core-api mints a fresh UUIDv7 customer id, profile false; bad key → 404", async () => {
    type B = { principal: { customer_id: string; profile: boolean; sub: string | null; channel_id: string }; visible: string[] };
    const first = (await (await get("/v1/_test/customer", "new-customer", undefined, { [STOREFRONT_KEY_HEADER]: KEY_A })).json()) as B;
    const guest1 = (await (await get("/v1/_test/customer", null, undefined, { [STOREFRONT_KEY_HEADER]: KEY_A })).json()) as B;
    const guest2 = (await (await get("/v1/_test/customer", null, undefined, { [STOREFRONT_KEY_HEADER]: KEY_A })).json()) as B;
    for (const b of [first, guest1, guest2]) {
      expect(b.principal.customer_id).toMatch(UUID7);
      expect(b.principal.profile).toBe(false);
      expect(b.principal.channel_id).toBe(A.channel);
      expect(b.visible).toEqual([]);
    }
    expect(first.principal.sub).toBe("new-customer");
    expect(guest1.principal.sub).toBeNull();
    expect(new Set([first, guest1, guest2].map((b) => b.principal.customer_id)).size).toBe(3);
    expect([customerA, customerB]).not.toContain(first.principal.customer_id);
    for (const key of ["wrong", `${KEY_A}x`, B.storefrontKey.slice(0, -1)]) {
      expect((await get("/v1/_test/customer", CUSTOMER_SUB, undefined, { [STOREFRONT_KEY_HEADER]: key })).status).toBe(404);
    }
    expect((await get("/v1/_test/customer", CUSTOMER_SUB)).status).toBe(404);
    // B's key resolves to B: the same login gets B's profile there, never A's.
    const atB = (await (await get("/v1/_test/customer", CUSTOMER_SUB, undefined, { [STOREFRONT_KEY_HEADER]: B.storefrontKey })).json()) as B;
    expect(atB.principal.customer_id).toBe(customerB);
  });

  it("guest token resolves exactly its order at that merchant; wrong token, other merchant's token or no key → 404", async () => {
    const ok = await get("/v1/_test/guest", null, undefined, { [STOREFRONT_KEY_HEADER]: KEY_A, [GUEST_TOKEN_HEADER]: guestA.token });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      kind: "guest", tenant_id: A.tenant, channel_id: A.channel, order_id: guestA.order,
      guest_access_hash: createHash("sha256").update(guestA.token).digest("hex"),
    });
    const bad: Array<Record<string, string>> = [
      { [STOREFRONT_KEY_HEADER]: KEY_A, [GUEST_TOKEN_HEADER]: `${guestA.token.slice(0, -2)}AA` },
      { [STOREFRONT_KEY_HEADER]: KEY_A, [GUEST_TOKEN_HEADER]: guestB.token },
      { [STOREFRONT_KEY_HEADER]: KEY_A },
      { [GUEST_TOKEN_HEADER]: guestA.token },
    ];
    for (const h of bad) expect((await get("/v1/_test/guest", null, undefined, h)).status).toBe(404);
    const atB = await get("/v1/_test/guest", null, undefined, { [STOREFRONT_KEY_HEADER]: B.storefrontKey, [GUEST_TOKEN_HEADER]: guestB.token });
    expect(((await atB.json()) as { order_id: string }).order_id).toBe(guestB.order);
  });
});

describe("error envelope", () => {
  it("a failing query returns the fixed internal body: no SQL text, no driver message", async () => {
    lines.length = 0;
    const res = await get("/v1/_test/bad-query", A.ownerSub, A.tenant);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: { code: "internal", message: "Something went wrong.", reason_code: null } });
    for (const leak of ["no_such_table", "secret_col", "SELECT", "relation", "42P01"]) expect(text).not.toContain(leak);
    // The failure did happen and was logged server-side (the positive half).
    expect(lines.some((l) => l.includes("42P01"))).toBe(true);
  });

  it("a book-guard refusal maps MB001 → 403 book_write_refused, without the trigger's text", async () => {
    const res = await get("/v1/_test/book-write", A.ownerSub, A.tenant);
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      error: { code: "book_write_refused", message: "This change needs a person with authority to make or approve it.", reason_code: "authority_denied" },
    });
    expect(text).not.toMatch(/MB001|core\.outlet|guard/);
  });
});
