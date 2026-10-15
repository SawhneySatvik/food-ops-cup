// T-020 gates — tenancy + onboarding through the real app (IdP → withContext → RLS → book guard).
//   onboarding 3 kinds × 2 countries → hand-typed default row counts; retry of one envelope → 1 tenant;
//   country/currency change after onboarding → 409 country_locked (before onboarding it must fit the old pack's rows: 422);
//   invite → first sign-in binds idp_sub exactly once; storefront key stored only as sha256, revoked → 404;
//   manager of outlet A cannot update outlet B (MB001 → 403, twin: outlet A 200).
// Every command is a seeded core.command_authority row (0015 A4 seeds tenancy.onboard.v1 and tenancy.member.bind.v1).
// Expected values are typed by hand. Synthetic data only.
import { createHash } from "node:crypto";
import { createLogger } from "@munim/config";
import { SCHEMAS } from "@munim/contracts/tenancy";
import type { TestDb } from "@munim/db";
import { uuidv7 } from "@munim/db";
import { Hono } from "hono";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalIdp } from "../src/auth/local-idp.ts";
import { type AppEnv, ApiError, createApp, requireCustomer, storefrontResolver, TENANT_HEADER, withContext } from "../src/app.ts";
import { executeCommand } from "../src/commit/index.ts";
import { provisionTenant } from "../src/modules/tenancy/index.ts";
import { openDb } from "./db.ts";

const idp = createLocalIdp();
let db: TestDb;
let pools: { core: pg.Pool; svc: pg.Pool };
let app: Hono<AppEnv>;
let probe: Hono<AppEnv>;

type Res = Omit<Response, "json"> & { json(): Promise<any> };
const tok = (sub: string, email?: string, verified = true) => idp.sign({ sub, ...(email ? { email, email_verified: verified } : {}) });
const call = async (method: string, path: string, token: string | null, body?: unknown, tenant?: string): Promise<Res> =>
  (await app.request(path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(tenant ? { [TENANT_HEADER]: tenant } : {}), "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })) as Res;
const env = (type: string, payload: Record<string, unknown>, key = `k-${uuidv7()}`) => ({ command_id: uuidv7(), idempotency_key: key, type, payload });
const one = async <R extends pg.QueryResultRow>(sql: string, params: unknown[] = []) => (await db.admin(sql, params)).rows[0] as R;
const count = async (sql: string, params: unknown[] = []) => Number((await one<{ n: string }>(sql, params)).n);

const IN_FSSAI = "12345678901234";

interface Biz { tenant: string; owner: string; outlet: string; sub: string; email: string; token: string }
function onboardBody(b: Pick<Biz, "tenant" | "owner" | "outlet">, o: { kind?: string; country?: string; outlet?: Record<string, unknown>; key?: string } = {}) {
  return env("tenancy.onboard.v1", {
    tenant_id: b.tenant, owner_member_id: b.owner, outlet_id: b.outlet, owner_name: "Synthetic Owner", business_name: "Synthetic Biz",
    kind: o.kind ?? "restaurant", country_code: o.country ?? "IN",
    outlet: { name: "Main outlet", address: "1 Synthetic Street", tax_ids: {}, ...(o.outlet ?? {}) },
  }, o.key);
}
async function onboard(o: { kind?: string; country?: string; outlet?: Record<string, unknown> } = {}): Promise<Biz> {
  const sub = `owner-${uuidv7()}`;
  const email = `${sub}@example.test`;
  const b: Biz = { tenant: uuidv7(), owner: uuidv7(), outlet: uuidv7(), sub, email, token: tok(sub, email) };
  const r = await call("POST", "/v1/onboarding", b.token, onboardBody(b, o));
  expect(r.status).toBe(201);
  // R1-m6: core mints the tenant id; the one sent in the payload is ignored.
  b.tenant = (await r.json()).entity_id;
  expect(await count(`SELECT count(*) n FROM core.tenant WHERE tenant_id = $1`, [b.tenant])).toBe(1);
  return b;
}

describe("onboarding requires a verified email (F2)", () => {
  it("an unverified identity is refused 422 and no tenant exists; the same envelope with a verified token creates one", async () => {
    const sub = `owner-${uuidv7()}`, email = `${sub}@example.test`;
    const b: Biz = { tenant: uuidv7(), owner: uuidv7(), outlet: uuidv7(), sub, email, token: tok(sub, email, false) };
    const body = onboardBody(b, {});
    const refused = await call("POST", "/v1/onboarding", b.token, body);
    expect(refused.status).toBe(422);
    expect((await refused.json()).error.code).toBe("invalid_payload");
    // The tenant id is minted by core, so "no tenant exists" is read off the person: no member row for this sign-in.
    expect(await count(`SELECT count(*) n FROM core.member WHERE idp_sub = $1`, [sub])).toBe(0);
    const made = await call("POST", "/v1/onboarding", tok(sub, email, true), body);
    expect(made.status).toBe(201);
    const minted = (await made.json()).entity_id as string;
    expect(await count(`SELECT count(*) n FROM core.member WHERE idp_sub = $1 AND tenant_id = $2`, [sub, minted])).toBe(1);
    expect(await count(`SELECT count(*) n FROM core.tenant WHERE tenant_id = $1`, [minted])).toBe(1);
  });
});

beforeAll(async () => {
  db = await openDb();
  pools = { core: db.pool("munim_core", 8), svc: db.pool("munim_svc", 2) };
  const config = { nodeEnv: "test", redact: (s: string) => s };
  const deps = { pools, idp, storefronts: storefrontResolver(pools.core), config, log: createLogger(config, () => {}) };
  app = await createApp(deps);
  probe = new Hono<AppEnv>();
  probe.use(async (c, next) => { c.set("deps", deps); await next(); });
  probe.onError((err, c) => (err instanceof ApiError ? c.json(err.body(), err.status) : c.json({}, 500)));
  probe.get("/probe", requireCustomer, (c) => c.json({ ok: true }));
});

afterAll(async () => {
  await pools?.core.end();
  await pools?.svc.end();
  await db?.stop();
});

describe("defaults by kind × country (operator seam: tenancy.provision.v1 is seeded)", () => {
  // Hand-typed expectations. channels = own channels + the pack's aggregators; devices = POS (+ KDS where there is a kitchen line).
  const IN_AGG = ["aggregator:swiggy", "aggregator:zomato"];
  const AU_AGG = ["aggregator:doordash", "aggregator:ubereats"];
  const cases = [
    { kind: "restaurant", country: "IN", channels: 6, devices: 2, outletKind: "restaurant", prep: 15, lead: 20, agg: IN_AGG, cur: "INR", fy: 4, tz: "Asia/Kolkata", accounts: 22 },
    { kind: "cloud_kitchen", country: "IN", channels: 4, devices: 2, outletKind: "cloud_kitchen", prep: 20, lead: 30, agg: IN_AGG, cur: "INR", fy: 4, tz: "Asia/Kolkata", accounts: 22 },
    { kind: "shop", country: "IN", channels: 3, devices: 1, outletKind: "store", prep: 5, lead: 15, agg: [], cur: "INR", fy: 4, tz: "Asia/Kolkata", accounts: 22 },
    { kind: "restaurant", country: "AU", channels: 6, devices: 2, outletKind: "restaurant", prep: 15, lead: 20, agg: AU_AGG, cur: "AUD", fy: 7, tz: "Australia/Melbourne", accounts: 23 },
    { kind: "cloud_kitchen", country: "AU", channels: 4, devices: 2, outletKind: "cloud_kitchen", prep: 20, lead: 30, agg: AU_AGG, cur: "AUD", fy: 7, tz: "Australia/Melbourne", accounts: 23 },
    { kind: "shop", country: "AU", channels: 3, devices: 1, outletKind: "store", prep: 5, lead: 15, agg: [], cur: "AUD", fy: 7, tz: "Australia/Melbourne", accounts: 23 },
  ] as const;

  it.each(cases)("$kind / $country → expected rows", async (x) => {
    const T = uuidv7(), owner = uuidv7(), outlet = uuidv7(), operator = uuidv7();
    const result = await executeCommand(
      { tx: (fn) => withContext(pools.core, { tenant_id: T, outlet_ids: "*", role: "operator", operator_id: operator }, fn),
        tenantId: T, actor: { kind: "operator", id: operator, role: "operator" } },
      env("tenancy.provision.v1", {}),
      {
        type: "tenancy.provision.v1",
        async run(c) {
          const r = await provisionTenant(c, {
            tenant_id: T, name: "Synthetic Biz", country_code: x.country, kind: x.kind, is_demo: false, onboarded: true,
            owner: { member_id: owner, name: "Synthetic Owner", email: "owner@example.test", idp_sub: null, role: "owner" },
            outlet: { outlet_id: outlet, name: "Main", address: "1 Synthetic Street", tax_ids: {} },
          });
          return { entityId: r.tenant_id, audit: [{ entity: "core.tenant", entityId: T }] };
        },
      });
    expect(result.replayed).toBe(false);
    expect(await count(`SELECT count(*) n FROM core.tenant WHERE tenant_id = $1 AND country_code = $2 AND base_currency = $3 AND fy_start_month = $4 AND onboarded_at IS NOT NULL AND NOT is_demo`,
      [T, x.country, x.cur, x.fy])).toBe(1);
    expect(await count(`SELECT count(*) n FROM core.outlet WHERE tenant_id = $1 AND kind = $2 AND tz = $3 AND default_prep_min = $4 AND pickup_lead_min = $5`,
      [T, x.outletKind, x.tz, x.prep, x.lead])).toBe(1);
    expect(await count(`SELECT count(*) n FROM core.channel WHERE tenant_id = $1`, [T])).toBe(x.channels);
    expect((await db.admin(`SELECT kind FROM core.channel WHERE tenant_id = $1 AND kind LIKE 'aggregator:%' ORDER BY kind`, [T])).rows.map((r) => r.kind)).toEqual([...x.agg]);
    expect(await count(`SELECT count(*) n FROM core.device WHERE tenant_id = $1`, [T])).toBe(x.devices);
    expect(await count(`SELECT count(*) n FROM core.device WHERE tenant_id = $1 AND kind = 'pos' AND invoice_series = 'POS1'`, [T])).toBe(1);
    expect(await count(`SELECT count(*) n FROM core.outlet_calendar WHERE tenant_id = $1 AND kind = 'weekly' AND opens_at = '09:00' AND closes_at = '22:00'`, [T])).toBe(7);
    expect(await count(`SELECT count(*) n FROM core.brand WHERE tenant_id = $1`, [T])).toBe(1);
    // chart: the pack's accounts, hand-counted from IN.json / AU.json (IN 22, AU 23); the 5 structural codes (1110, 1250, 2050, 4900, 6900) are all in the packs already
    expect(await count(`SELECT count(*) n FROM core.account WHERE tenant_id = $1`, [T])).toBe(x.accounts);
    expect(await count(`SELECT count(*) n FROM core.member WHERE tenant_id = $1`, [T])).toBe(1);
    expect(await count(`SELECT count(*) n FROM core.membership WHERE tenant_id = $1 AND role = 'owner'`, [T])).toBe(1);
    // W2-R4: one business policy with the loyalty defaults (1 point per 1,000 minor, 10 per point), in force from the epoch (R47 D9: so a first
    // target can be dated back over imported history), with no targets and no negotiation bounds.
    expect(await count(`SELECT count(*) n FROM core.business_policy WHERE tenant_id = $1 AND loyalty_earn_per_minor = 1000 AND loyalty_point_value_minor = 10
                          AND valid_from = '2000-01-01' AND labour_target_bp IS NULL AND target_margin_bp IS NULL AND negotiation_target_bp IS NULL`, [T])).toBe(1);
    // Every book row was stamped by the operator's own command (the guard's origin), not by anything else.
    expect(await count(`SELECT count(*) n FROM core.channel WHERE tenant_id = $1 AND origin->>'command_type' = 'tenancy.provision.v1'`, [T])).toBe(x.channels);
  });
});

describe("POST /v1/onboarding", () => {
  it("restaurant/IN and shop/AU through the route: owner signed in at once, same rows as the table above", async () => {
    const a = await onboard({ kind: "restaurant", country: "IN", outlet: { tax_ids: { FSSAI: IN_FSSAI } } });
    expect(await count(`SELECT count(*) n FROM core.channel WHERE tenant_id = $1`, [a.tenant])).toBe(6);
    expect(await count(`SELECT count(*) n FROM core.device WHERE tenant_id = $1`, [a.tenant])).toBe(2);
    expect(await count(`SELECT count(*) n FROM core.account WHERE tenant_id = $1`, [a.tenant])).toBe(22);
    expect(await count(`SELECT count(*) n FROM core.outlet WHERE tenant_id = $1 AND tax_ids->>'FSSAI' = $2`, [a.tenant, IN_FSSAI])).toBe(1);
    expect(await count(`SELECT count(*) n FROM core.member WHERE tenant_id = $1 AND id = $2 AND idp_sub = $3 AND email = $4`, [a.tenant, a.owner, a.sub, a.email])).toBe(1);
    expect(await count(`SELECT count(*) n FROM core.tenant WHERE tenant_id = $1 AND onboarded_at IS NOT NULL AND created_by = $2`, [a.tenant, a.owner])).toBe(1);
    // The audit entry names the person who asked, not an operator.
    expect(await count(`SELECT count(*) n FROM core.audit_log WHERE tenant_id = $1 AND actor->>'id' = $2 AND actor->>'kind' = 'member'`, [a.tenant, a.owner])).toBe(3);
    expect(await count(`SELECT count(*) n FROM core.account WHERE tenant_id = $1 AND origin->>'command_type' = 'tenancy.onboard.v1'`, [a.tenant])).toBe(22);
    const s = await onboard({ kind: "shop", country: "AU", outlet: { tax_ids: { ABN: "12345678901" } } });
    expect(await count(`SELECT count(*) n FROM core.channel WHERE tenant_id = $1`, [s.tenant])).toBe(3);
    expect(await count(`SELECT count(*) n FROM core.device WHERE tenant_id = $1`, [s.tenant])).toBe(1);
    expect(await count(`SELECT count(*) n FROM core.account WHERE tenant_id = $1`, [s.tenant])).toBe(23);
    expect(await count(`SELECT count(*) n FROM core.tenant WHERE tenant_id = $1 AND base_currency = 'AUD' AND fy_start_month = 7`, [s.tenant])).toBe(1);
    // requireMember works on the very next request.
    expect((await call("GET", "/v1/tenant", a.token, undefined, a.tenant)).status).toBe(200);
  });

  it("the same envelope twice → one tenant, X-Munim-Replayed on the second, byte-identical body", async () => {
    const b: Biz = { tenant: uuidv7(), owner: uuidv7(), outlet: uuidv7(), sub: `o-${uuidv7()}`, email: "retry@example.test", token: "" };
    b.token = tok(b.sub, b.email);
    const body = onboardBody(b, { key: `retry-${uuidv7()}` });
    const first = await call("POST", "/v1/onboarding", b.token, body);
    const second = await call("POST", "/v1/onboarding", b.token, body);
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(second.headers.get("X-Munim-Replayed")).toBe("true");
    expect(first.headers.get("X-Munim-Replayed")).toBeNull();
    const firstText = await first.text();
    expect(await second.text()).toBe(firstText);
    // R1-m6: a replay returns the same minted id, and it is not the client's.
    const minted = JSON.parse(firstText).entity_id as string;
    expect(minted).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(minted).not.toBe(b.tenant);
    expect((await (await call("POST", "/v1/onboarding", b.token, body)).json()).entity_id).toBe(minted);
    expect(await count(`SELECT count(*) n FROM core.tenant WHERE tenant_id = $1`, [minted])).toBe(1);
    expect(await count(`SELECT count(*) n FROM core.tenant WHERE tenant_id = $1`, [b.tenant])).toBe(0);
    expect(await count(`SELECT count(*) n FROM core.member WHERE idp_sub = $1`, [b.sub])).toBe(1);
    expect(await count(`SELECT count(*) n FROM core.channel WHERE tenant_id = $1`, [minted])).toBe(6);
    // The same person with a NEW idempotency key gets a new tenant of their own.
    const again = await call("POST", "/v1/onboarding", b.token, onboardBody({ tenant: b.tenant, owner: uuidv7(), outlet: uuidv7() }, { key: `retry2-${uuidv7()}` }));
    expect(again.status).toBe(201);
    expect((await again.json()).entity_id).not.toBe(minted);
  });

  it("R1-m6: sending an existing tenant's id is not a takeover and not an error — 201, a fresh tenant of the caller's own, same response shape", async () => {
    const a = await onboard();
    const before = await count(`SELECT count(*) n FROM core.member WHERE tenant_id = $1`, [a.tenant]);
    const fresh = await call("POST", "/v1/onboarding", tok(`f-${uuidv7()}`, "f@example.test"), onboardBody({ tenant: uuidv7(), owner: uuidv7(), outlet: uuidv7() }));
    expect(fresh.status).toBe(201);
    const freshBody = await fresh.json();
    const sub = `x-${uuidv7()}`;
    const intruder = { tenant: a.tenant, owner: uuidv7(), outlet: uuidv7() };
    const r = await call("POST", "/v1/onboarding", tok(sub, "x@example.test"), onboardBody(intruder));
    expect(r.status).toBe(201);
    const body = await r.json();
    expect(Object.keys(body).sort()).toEqual(Object.keys(freshBody).sort());
    expect(body.entity_id).not.toBe(a.tenant);
    expect(await count(`SELECT count(*) n FROM core.member WHERE tenant_id = $1`, [a.tenant])).toBe(before);
    expect(await count(`SELECT count(*) n FROM core.member WHERE tenant_id = $1 AND idp_sub = $2 AND id = $3`, [body.entity_id, sub, intruder.owner])).toBe(1);
  });

  it("refusals paired with accepts: bad FSSAI 422 (0 rows), missing FSSAI accepted; zone outside the pack 422; unknown country 422; no token 401", async () => {
    const bad = { tenant: uuidv7(), owner: uuidv7(), outlet: uuidv7() };
    const sub = `o-${uuidv7()}`;
    const t = tok(sub, "bad@example.test");
    const nobody = () => count(`SELECT count(*) n FROM core.member WHERE idp_sub = $1`, [sub]);
    const r1 = await call("POST", "/v1/onboarding", t, onboardBody(bad, { outlet: { tax_ids: { FSSAI: "123" } } }));
    expect(r1.status).toBe(422);
    expect((await r1.json()).refs).toEqual(["tax_id:FSSAI"]);
    expect(await nobody()).toBe(0);
    const r2 = await call("POST", "/v1/onboarding", t, onboardBody(bad, { outlet: { tz: "Australia/Sydney" } }));
    expect(r2.status).toBe(422);
    const r3 = await call("POST", "/v1/onboarding", t, onboardBody(bad, { country: "ZZ" }));
    expect(r3.status).toBe(422);
    expect((await r3.json()).error.code).toBe("out_of_pack_scope");
    expect(await nobody()).toBe(0);
    expect((await call("POST", "/v1/onboarding", null, onboardBody(bad))).status).toBe(401);
    // accepts: no tax ids at all (ON3 "optional") and a valid pack zone
    const ok = await call("POST", "/v1/onboarding", t, onboardBody(bad, { outlet: { tz: "Asia/Kolkata" } }));
    expect(ok.status).toBe(201);
    const minted = (await ok.json()).entity_id as string;
    expect(await nobody()).toBe(1);
    expect(await count(`SELECT count(*) n FROM core.outlet WHERE tenant_id = $1 AND tax_ids = '{}'::jsonb`, [minted])).toBe(1);
  });

  it("GET /v1/me/tenants lists the tenants this sign-in belongs to (and none for a stranger)", async () => {
    const a = await onboard();
    const r = await call("GET", "/v1/me/tenants", a.token);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ tenants: [{ tenant_id: a.tenant, tenant_name: "Synthetic Biz", role: "owner" }] });
    expect(await (await call("GET", "/v1/me/tenants", tok(`nobody-${uuidv7()}`, "n@example.test"))).json()).toEqual({ tenants: [] });
    expect((await call("GET", "/v1/me/tenants", null)).status).toBe(401);
  });
});

describe("country is fixed at onboarding (R30)", () => {
  it("after onboarding: country change → 409 country_locked, nothing moved; name and home_tz changes accepted", async () => {
    const a = await onboard();
    const r = await call("POST", "/v1/tenant:update", a.token, env("tenancy.tenant.update.v1", { country_code: "AU" }), a.tenant);
    expect(r.status).toBe(409);
    expect((await r.json()).error.code).toBe("country_locked");
    expect(await count(`SELECT count(*) n FROM core.tenant WHERE tenant_id = $1 AND country_code = 'IN' AND base_currency = 'INR' AND fy_start_month = 4`, [a.tenant])).toBe(1);
    // currency / fy are not even accepted as fields
    expect((await call("POST", "/v1/tenant:update", a.token, env("tenancy.tenant.update.v1", { base_currency: "AUD" }), a.tenant)).status).toBe(422);
    // twin: allowed settings
    const ok = await call("POST", "/v1/tenant:update", a.token, env("tenancy.tenant.update.v1", { name: "Renamed Biz", home_tz: "Asia/Kolkata" }), a.tenant);
    expect(ok.status).toBe(200);
    expect(await count(`SELECT count(*) n FROM core.tenant WHERE tenant_id = $1 AND name = 'Renamed Biz' AND home_tz = 'Asia/Kolkata'`, [a.tenant])).toBe(1);
  });

  it("before onboarding a country change must fit the rows already made from the old pack (422), then the lock refuses it (409)", async () => {
    const T = uuidv7(), owner = uuidv7(), outlet = uuidv7(), operator = uuidv7(), sub = `p-${uuidv7()}`;
    await executeCommand(
      { tx: (fn) => withContext(pools.core, { tenant_id: T, outlet_ids: "*", role: "operator", operator_id: operator }, fn),
        tenantId: T, actor: { kind: "operator", id: operator, role: "operator" } },
      env("tenancy.provision.v1", {}),
      { type: "tenancy.provision.v1", async run(c) {
        await provisionTenant(c, { tenant_id: T, name: "Pending Biz", country_code: "IN", kind: "restaurant", is_demo: false, onboarded: false,
          owner: { member_id: owner, name: "Owner", email: "pending@example.test", idp_sub: sub, role: "owner" },
          outlet: { outlet_id: outlet, name: "Main", address: "1 Synthetic Street", tax_ids: {} } });
        return { entityId: T, audit: [{ entity: "core.tenant", entityId: T }] };
      } });
    const t = tok(sub, "pending@example.test");
    // Asia/Kolkata and the Swiggy/Zomato channels do not exist in the AU pack: refused, nothing moved.
    const r = await call("POST", "/v1/tenant:update", t, env("tenancy.tenant.update.v1", { country_code: "AU" }), T);
    expect(r.status).toBe(422);
    expect((await r.json()).error.code).toBe("out_of_pack_scope");
    expect(await count(`SELECT count(*) n FROM core.tenant WHERE tenant_id = $1 AND country_code = 'IN' AND base_currency = 'INR' AND onboarded_at IS NULL`, [T])).toBe(1);
    // finishing onboarding fixes the country: now it is the database that refuses (409), not the handler
    expect((await call("POST", "/v1/tenant:update", t, env("tenancy.tenant.update.v1", { complete_onboarding: true }), T)).status).toBe(200);
    const locked = await call("POST", "/v1/tenant:update", t, env("tenancy.tenant.update.v1", { country_code: "AU" }), T);
    expect(locked.status).toBe(409);
    expect((await locked.json()).error.code).toBe("country_locked");
  });
});

describe("the T-031 operator route over the seam (wire shape: no outlet)", () => {
  it("tenants:provision creates tenant + owner + chart (not onboarded); the owner binds, adds an outlet, completes onboarding, then the country is locked", async () => {
    const op = uuidv7(), opSub = `op2-${uuidv7()}`;
    await db.admin(`INSERT INTO platform.operator (id, idp_sub, email) VALUES ($1, $2, 'op2@example.test')`, [op, opSub]);
    const T = uuidv7(), owner = uuidv7(), sub = `own-${uuidv7()}`, email = "provisioned@example.test";
    const r = await call("POST", "/platform/v1/tenants:provision", tok(opSub, "op2@example.test"), env("tenancy.provision.v1",
      { tenant_id: T, name: "Provisioned Biz", country_code: "AU", is_demo: false, owner: { member_id: owner, name: "Provisioned Owner", email } }));
    expect(r.status).toBe(201);
    expect(await count(`SELECT count(*) n FROM core.tenant WHERE tenant_id = $1 AND country_code = 'AU' AND base_currency = 'AUD' AND onboarded_at IS NULL`, [T])).toBe(1);
    expect(await count(`SELECT count(*) n FROM core.account WHERE tenant_id = $1`, [T])).toBe(23);
    expect(await count(`SELECT count(*) n FROM core.outlet WHERE tenant_id = $1`, [T])).toBe(0);
    // the owner signs in for the first time → bind, then set up the outlet and finish
    const t = tok(sub, email);
    expect((await call("POST", "/v1/members:bind", t, env("tenancy.member.bind.v1", { member_id: owner }), T)).status).toBe(200);
    const outlet = uuidv7();
    expect((await call("POST", "/v1/outlets", t, env("tenancy.outlet.create.v1", { outlet_id: outlet, name: "Cafe", kind: "restaurant", tz: "Australia/Sydney", address: "1 Synthetic St", tax_ids: { ABN: "12345678901" } }), T)).status).toBe(200);
    expect((await call("POST", "/v1/tenant:update", t, env("tenancy.tenant.update.v1", { complete_onboarding: true }), T)).status).toBe(200);
    expect(await count(`SELECT count(*) n FROM core.tenant WHERE tenant_id = $1 AND onboarded_at IS NOT NULL`, [T])).toBe(1);
    expect((await call("POST", "/v1/tenant:update", t, env("tenancy.tenant.update.v1", { country_code: "IN" }), T)).status).toBe(409);
  });
});

describe("members: invite → first sign-in binds idp_sub exactly once", () => {
  it("binds once; a second subject is refused; a different email is 404; the same subject again is a no-op; then requireMember resolves", async () => {
    const a = await onboard();
    const mgr = uuidv7();
    const inv = await call("POST", "/v1/members:invite", a.token,
      env("tenancy.member.invite.v1", { member_id: mgr, name: "Invited Manager", email: "Mgr@Example.test", role: "manager", outlet_ids: [a.outlet] }), a.tenant);
    expect(inv.status).toBe(200);
    expect(await count(`SELECT count(*) n FROM core.member WHERE tenant_id = $1 AND id = $2 AND idp_sub IS NULL AND email = 'mgr@example.test'`, [a.tenant, mgr])).toBe(1);
    const bind = (token: string, key?: string) => call("POST", "/v1/members:bind", token, env("tenancy.member.bind.v1", { member_id: mgr }, key), a.tenant);

    const subA = `mgr-${uuidv7()}`, subB = `other-${uuidv7()}`;
    // wrong email → 404 and still unbound
    expect((await bind(tok(subA, "someone-else@example.test"))).status).toBe(404);
    expect(await count(`SELECT count(*) n FROM core.member WHERE id = $1 AND idp_sub IS NULL`, [mgr])).toBe(1);
    // B16: the matching email but NOT verified by the IdP → 404, still unbound (accept for the verified token follows)
    expect((await bind(tok(subA, "mgr@example.test", false))).status).toBe(404);
    expect(await count(`SELECT count(*) n FROM core.member WHERE id = $1 AND idp_sub IS NULL`, [mgr])).toBe(1);
    // the invited person signs in with a verified email → bound
    expect((await bind(tok(subA, "mgr@example.test"))).status).toBe(200);
    expect(await count(`SELECT count(*) n FROM core.member WHERE id = $1 AND idp_sub = $2`, [mgr, subA])).toBe(1);
    // a second subject with the same email → refused, binding unchanged
    expect((await bind(tok(subB, "mgr@example.test"))).status).toBe(409);
    expect(await count(`SELECT count(*) n FROM core.member WHERE id = $1 AND idp_sub = $2`, [mgr, subA])).toBe(1);
    expect(await count(`SELECT count(*) n FROM core.member WHERE tenant_id = $1 AND idp_sub = $2`, [a.tenant, subB])).toBe(0);
    // the same subject again (new key) → idempotent, still exactly one bound row
    expect((await bind(tok(subA, "mgr@example.test"))).status).toBe(200);
    expect(await count(`SELECT count(*) n FROM core.member WHERE tenant_id = $1 AND idp_sub = $2`, [a.tenant, subA])).toBe(1);
    // the manager is now a resolvable member with their invited scope
    expect((await call("GET", "/v1/outlets", tok(subA), undefined, a.tenant)).status).toBe(200);
    expect((await call("GET", "/v1/me/tenants", tok(subA))).status).toBe(200);
    // authority: staff cannot invite (a manager cannot either)
    const dup = await call("POST", "/v1/members:invite", a.token,
      env("tenancy.member.invite.v1", { member_id: uuidv7(), name: "Dup", email: "mgr@example.test", role: "staff", outlet_ids: [a.outlet] }), a.tenant);
    expect(dup.status).toBe(409);
    const byManager = await call("POST", "/v1/members:invite", tok(subA),
      env("tenancy.member.invite.v1", { member_id: uuidv7(), name: "Nope", email: "nope@example.test", role: "staff", outlet_ids: [a.outlet] }), a.tenant);
    expect(byManager.status).toBe(403);
  });
});

describe("members: role set and deactivate (tenancy.member.role.set.v1 / .deactivate.v1, owner only)", () => {
  it("owner promotes staff → manager (200, membership changed, audited); a manager cannot (403); the owner cannot change themselves (409); deactivate ends sign-in", async () => {
    const a = await onboard();
    const staff = uuidv7(), mgr = uuidv7();
    const staffSub = `staff-${uuidv7()}`, mgrSub = `mgr-${uuidv7()}`;
    for (const [id, sub, role, email] of [[staff, staffSub, "staff", "staff.rs@example.test"], [mgr, mgrSub, "manager", "mgr.rs@example.test"]] as const) {
      expect((await call("POST", "/v1/members:invite", a.token,
        env("tenancy.member.invite.v1", { member_id: id, name: `Synthetic ${role}`, email, role, outlet_ids: [a.outlet] }), a.tenant)).status).toBe(200);
      expect((await call("POST", "/v1/members:bind", tok(sub, email), env("tenancy.member.bind.v1", { member_id: id }), a.tenant)).status).toBe(200);
    }
    const setRole = (token: string, member_id: string, role: string, outlet_ids: string[], path = member_id) =>
      call("POST", `/v1/members/${path}:set-role`, token, env("tenancy.member.role.set.v1", { member_id, role, outlet_ids }), a.tenant);
    const roleOf = (id: string) => one<{ role: string; outlet_ids: string[] }>(`SELECT role, outlet_ids FROM core.membership WHERE member_id = $1`, [id]);

    // Refusals first: the manager is not the owner (guard: MB001 → 403); a manager role needs an outlet (422); the
    // owner on themselves (409); a path that is not the payload's member (422). Nothing changes.
    expect((await setRole(tok(mgrSub), staff, "manager", [a.outlet])).status).toBe(403);
    expect((await setRole(a.token, staff, "manager", [])).status).toBe(422);
    expect((await setRole(a.token, a.owner, "advisor", [])).status).toBe(409);
    expect((await setRole(a.token, staff, "manager", [a.outlet], mgr)).status).toBe(422);
    expect(await roleOf(staff)).toEqual({ role: "staff", outlet_ids: [a.outlet] });
    // Accept: the owner promotes staff to manager of the same outlet.
    expect((await setRole(a.token, staff, "manager", [a.outlet])).status).toBe(200);
    expect(await roleOf(staff)).toEqual({ role: "manager", outlet_ids: [a.outlet] });
    expect(await one(`SELECT entity, before, after FROM core.audit_log WHERE tenant_id = $1 AND action = 'tenancy.member.role.set.v1'`, [a.tenant]))
      .toEqual({ entity: "core.membership", before: { role: "staff", outlet_ids: [a.outlet] }, after: { role: "manager", outlet_ids: [a.outlet] } });

    const deactivate = (token: string, member_id: string) =>
      call("POST", `/v1/members/${member_id}:deactivate`, token, env("tenancy.member.deactivate.v1", { member_id }), a.tenant);
    // Refusals: the manager cannot (403); the owner cannot deactivate themselves (409). The manager still resolves.
    expect((await deactivate(tok(staffSub), mgr)).status).toBe(403);
    expect((await deactivate(a.token, a.owner)).status).toBe(409);
    expect((await call("GET", "/v1/outlets", tok(mgrSub), undefined, a.tenant)).status).toBe(200);
    // Accept: deactivated → the sign-in no longer resolves to a member here; a second deactivate is 409.
    expect((await deactivate(a.token, mgr)).status).toBe(200);
    expect(await one(`SELECT m.active AS member, ms.active AS membership FROM core.member m JOIN core.membership ms ON ms.member_id = m.id WHERE m.id = $1`, [mgr]))
      .toEqual({ member: false, membership: false });
    expect((await call("GET", "/v1/outlets", tok(mgrSub), undefined, a.tenant)).status).toBe(404); // no active membership here: not revealed
    expect((await deactivate(a.token, mgr)).status).toBe(409);
  });
});

describe("storefront keys", () => {
  it("the raw key is returned once and never stored; revoked → 404 at once; non-owner and foreign channel refused", async () => {
    const a = await onboard();
    const other = await onboard();
    const channel = (await one<{ id: string }>(`SELECT id FROM core.channel WHERE tenant_id = $1 AND kind = 'own_site'`, [a.tenant])).id;
    const keyId = uuidv7();
    const r = await call("POST", "/v1/storefront-keys", a.token, { key_id: keyId, channel_id: channel, allowed_origins: ["https://shop.example.test"] }, a.tenant);
    expect(r.status).toBe(201);
    const { key } = SCHEMAS["tenancy.storefront-key.created"].parse(await r.json());
    expect(key).toMatch(/^sfk_[A-Za-z0-9_-]{43}$/);
    // stored: exactly sha256(key) hex; the raw value is nowhere in the tenant's rows
    const hash = createHash("sha256").update(key).digest("hex");
    expect(await count(`SELECT count(*) n FROM core.storefront_key WHERE id = $1 AND key_hash = $2 AND revoked_at IS NULL`, [keyId, hash])).toBe(1);
    expect(await count(`SELECT count(*) n FROM core.audit_log WHERE tenant_id = $1 AND (audit_log::text LIKE '%' || $2 || '%')`, [a.tenant, key])).toBe(0);
    expect(await count(`SELECT count(*) n FROM core.command_log WHERE tenant_id = $1 AND (command_log::text LIKE '%' || $2 || '%')`, [a.tenant, key])).toBe(0);
    expect(await count(`SELECT count(*) n FROM core.outbox WHERE tenant_id = $1 AND (outbox::text LIKE '%' || $2 || '%')`, [a.tenant, key])).toBe(0);
    expect(await count(`SELECT count(*) n FROM core.storefront_key WHERE storefront_key::text LIKE '%' || $1 || '%'`, [key])).toBe(0);
    // the list never carries key material
    const listed = await (await call("GET", "/v1/storefront-keys", a.token, undefined, a.tenant)).json();
    expect(JSON.stringify(listed)).not.toContain(key);
    expect(JSON.stringify(SCHEMAS["tenancy.storefront-key.list"].parse(listed))).toContain(keyId);
    // it resolves: requireCustomer on the key → 200
    const via = (k: string) => probe.request("/probe", { headers: { "X-Munim-Storefront-Key": k } });
    expect((await via(key)).status).toBe(200);
    // revoke → 404 at once; revoking twice is a stable success
    const rv = await call("POST", `/v1/storefront-keys/${keyId}:revoke`, a.token, undefined, a.tenant);
    expect(rv.status).toBe(200);
    SCHEMAS["tenancy.storefront-key.revoked"].parse(await rv.json());
    expect((await via(key)).status).toBe(404);
    expect((await call("POST", `/v1/storefront-keys/${keyId}:revoke`, a.token, undefined, a.tenant)).status).toBe(200);
    // another tenant's owner cannot revoke or see it
    expect((await call("POST", `/v1/storefront-keys/${keyId}:revoke`, other.token, undefined, other.tenant)).status).toBe(404);
    // a channel of another tenant → 404; a manager → 403
    const foreign = (await one<{ id: string }>(`SELECT id FROM core.channel WHERE tenant_id = $1 AND kind = 'own_site'`, [other.tenant])).id;
    expect((await call("POST", "/v1/storefront-keys", a.token, { key_id: uuidv7(), channel_id: foreign, allowed_origins: [] }, a.tenant)).status).toBe(404);
    const mId = uuidv7(), mSub = `m-${uuidv7()}`, mEmail = `${mSub}@example.test`;
    await call("POST", "/v1/members:invite", a.token, env("tenancy.member.invite.v1", { member_id: mId, name: "Mgr", email: mEmail, role: "manager", outlet_ids: [a.outlet] }), a.tenant);
    await call("POST", "/v1/members:bind", tok(mSub, mEmail), env("tenancy.member.bind.v1", { member_id: mId }), a.tenant);
    expect((await call("POST", "/v1/storefront-keys", tok(mSub, mEmail), { key_id: uuidv7(), channel_id: channel, allowed_origins: [] }, a.tenant)).status).toBe(403);
    expect(await count(`SELECT count(*) n FROM core.storefront_key WHERE tenant_id = $1`, [a.tenant])).toBe(1);
  });
});

describe("outlet authority (MB001)", () => {
  it("manager of outlet A: updates A (200), cannot update B (403 book_write_refused, B unchanged); staff cannot update at all", async () => {
    const a = await onboard();
    const outletB = uuidv7();
    expect((await call("POST", "/v1/outlets", a.token, env("tenancy.outlet.create.v1",
      { outlet_id: outletB, name: "Second outlet", kind: "restaurant", tz: "Asia/Kolkata", address: "2 Synthetic Street", tax_ids: {} }), a.tenant)).status).toBe(200);
    expect(await count(`SELECT count(*) n FROM core.outlet_calendar WHERE tenant_id = $1 AND outlet_id = $2`, [a.tenant, outletB])).toBe(7);
    const invite = async (role: string) => {
      const id = uuidv7(), sub = `${role}-${uuidv7()}`, email = `${sub}@example.test`;
      expect((await call("POST", "/v1/members:invite", a.token, env("tenancy.member.invite.v1", { member_id: id, name: role, email, role, outlet_ids: [a.outlet] }), a.tenant)).status).toBe(200);
      expect((await call("POST", "/v1/members:bind", tok(sub, email), env("tenancy.member.bind.v1", { member_id: id }), a.tenant)).status).toBe(200);
      return { token: tok(sub, email), id };
    };
    const mgrInv = await invite("manager");
    const mgr = mgrInv.token, mgrId = mgrInv.id;
    const staff = (await invite("staff")).token;
    const upd = (token: string, outlet: string, fields: Record<string, unknown>) =>
      call("POST", `/v1/outlets/${outlet}:update`, token, env("tenancy.outlet.update.v1", { outlet_id: outlet, ...fields }), a.tenant);

    const okA = await upd(mgr, a.outlet, { accepting_orders: "busy", busy_extra_min: 10, business_day_cutoff: "03:00", upi_vpa: "cafe@okbank" });
    expect(okA.status).toBe(200);
    expect(await count(`SELECT count(*) n FROM core.outlet WHERE id = $1 AND accepting_orders = 'busy' AND busy_extra_min = 10 AND business_day_cutoff = '03:00' AND upi_vpa = 'cafe@okbank'`, [a.outlet])).toBe(1);
    const noB = await upd(mgr, outletB, { accepting_orders: "paused", name: "Hijacked" });
    expect(noB.status).toBe(403);
    expect((await noB.json()).error.code).toBe("book_write_refused");
    expect(await count(`SELECT count(*) n FROM core.outlet WHERE id = $1 AND accepting_orders = 'open' AND name = 'Second outlet'`, [outletB])).toBe(1);
    // The refusal is the database's own: the guard (MB001), not the handler's fallback.
    const asMgr = { tenant_id: a.tenant, outlet_ids: [a.outlet], role: "manager" as const, member_id: mgrId, command_type: "tenancy.outlet.update.v1" };
    await expect(db.withContext("munim_core", asMgr, (c) => c.query(`UPDATE core.outlet SET accepting_orders = 'paused' WHERE id = $1`, [outletB])))
      .rejects.toMatchObject({ code: "MB001" });
    await expect(db.withContext("munim_core", asMgr, (c) => c.query(`UPDATE core.outlet SET accepting_orders = 'open' WHERE id = $1`, [a.outlet]))).resolves.toBeDefined();
    // hours only, other outlet: still refused (nothing changes)
    expect((await upd(mgr, outletB, { hours: { opens: "10:00", closes: "20:00" } })).status).toBe(403);
    expect(await count(`SELECT count(*) n FROM core.outlet_calendar WHERE outlet_id = $1 AND opens_at = '09:00'`, [outletB])).toBe(7);
    // twin: hours on A change all 7 days
    expect((await upd(mgr, a.outlet, { hours: { opens: "10:00", closes: "20:00" } })).status).toBe(200);
    expect(await count(`SELECT count(*) n FROM core.outlet_calendar WHERE outlet_id = $1 AND opens_at = '10:00' AND closes_at = '20:00'`, [a.outlet])).toBe(7);
    // R1-M2: each of the 7 calendar rows is audited on its own, as it was and as it is (hand: 09:00–22:00 → 10:00–20:00).
    const cal = (await db.admin<{ before: { opens_at: string; closes_at: string; weekday: number }; after: { opens_at: string; closes_at: string; weekday: number } }>(
      `SELECT l.before, l.after FROM core.audit_log l JOIN core.outlet_calendar k ON k.tenant_id = l.tenant_id AND k.id::text = l.entity_id
        WHERE l.tenant_id = $1 AND l.entity = 'core.outlet_calendar' AND k.outlet_id = $2 ORDER BY (l.after->>'weekday')::int`, [a.tenant, a.outlet])).rows;
    expect(cal.map((r) => [r.before.weekday, r.before.opens_at, r.before.closes_at, r.after.weekday, r.after.opens_at, r.after.closes_at]))
      .toEqual([0, 1, 2, 3, 4, 5, 6].map((d) => [d, "09:00:00", "22:00:00", d, "10:00:00", "20:00:00"]));
    // staff: role not listed → 403
    expect((await upd(staff, a.outlet, { accepting_orders: "paused" })).status).toBe(403);
    // devices: manager registers on A, not on B; a KDS with an invoice series is a 422
    const dev = (token: string, outlet: string, kind: string, series: string | null) =>
      call("POST", "/v1/devices", token, env("tenancy.device.register.v1", { device_id: uuidv7(), outlet_id: outlet, kind, invoice_series: series }), a.tenant);
    expect((await dev(mgr, a.outlet, "pos", "POS2")).status).toBe(200);
    expect((await dev(mgr, outletB, "pos", "POS3")).status).toBe(403);
    expect((await dev(mgr, a.outlet, "kds", "POS4")).status).toBe(422);
    expect(await count(`SELECT count(*) n FROM core.device WHERE tenant_id = $1 AND invoice_series IN ('POS2', 'POS3', 'POS4')`, [a.tenant])).toBe(1);
  });
});

describe("brands, channels", () => {
  it("owner adds a brand and an in-pack aggregator channel; an aggregator outside the pack is 422", async () => {
    const a = await onboard();
    const b = uuidv7(), ch = uuidv7();
    expect((await call("POST", "/v1/brands", a.token, env("tenancy.brand.create.v1", { brand_id: b, name: "Second brand", outlet_ids: [a.outlet] }), a.tenant)).status).toBe(200);
    expect(await count(`SELECT count(*) n FROM core.brand WHERE tenant_id = $1`, [a.tenant])).toBe(2);
    expect((await call("POST", "/v1/channels", a.token, env("tenancy.channel.create.v1", { channel_id: uuidv7(), name: "Uber", kind: "aggregator:ubereats" }), a.tenant)).status).toBe(422);
    expect((await call("POST", "/v1/channels", a.token, env("tenancy.channel.create.v1", { channel_id: ch, name: "Magicpin", kind: "aggregator:swiggy" }), a.tenant)).status).toBe(200);
    expect(await count(`SELECT count(*) n FROM core.channel WHERE tenant_id = $1`, [a.tenant])).toBe(7);
  });
});

describe("tenancy.policy.set.v1: the owner's labour and margin targets (a person's own, audited command)", () => {
  it("owner sets targets as a new dated version (old closed, loyalty carried); a replay is one row; manager 403, same-day 409, bad bp 422", async () => {
    const a = await onboard();
    const mgr = uuidv7(), subM = `mgr-${uuidv7()}`;
    expect((await call("POST", "/v1/members:invite", a.token, env("tenancy.member.invite.v1", { member_id: mgr, name: "Invited Manager", email: "polmgr@example.test", role: "manager", outlet_ids: [a.outlet] }), a.tenant)).status).toBe(200);
    expect((await call("POST", "/v1/members:bind", tok(subM, "polmgr@example.test"), env("tenancy.member.bind.v1", { member_id: mgr }), a.tenant)).status).toBe(200);
    const set = (token: string, payload: Record<string, unknown>, key?: string) => call("POST", "/v1/policy", token, env("tenancy.policy.set.v1", payload, key), a.tenant);
    const base = { outlet_id: null, valid_from: "2099-01-01", labour_target_bp: 3000, target_margin_bp: 6500 };
    const rows = () => db.admin(`SELECT valid_from::text vf, valid_to::text vt, labour_target_bp l, target_margin_bp m, loyalty_earn_per_minor::int e FROM core.business_policy WHERE tenant_id = $1 AND outlet_id IS NULL ORDER BY valid_from`, [a.tenant]).then((r) => r.rows);
    // refusals first: a manager is not the owner; the new version must start after the one in force; basis points are 0..10000; one target at least
    expect((await set(tok(subM, "polmgr@example.test"), base)).status).toBe(403);
    expect((await set(a.token, { ...base, valid_from: "2000-01-01" })).status).toBe(409);
    expect((await set(a.token, { ...base, labour_target_bp: 10001 })).status).toBe(422);
    expect((await set(a.token, { outlet_id: null, valid_from: "2099-01-01" })).status).toBe(422);
    expect(await rows()).toHaveLength(1);
    // accept: the owner; the same envelope again replays (one new row, X-Munim-Replayed)
    const body = env("tenancy.policy.set.v1", base);
    const first = await call("POST", "/v1/policy", a.token, body, a.tenant);
    const second = await call("POST", "/v1/policy", a.token, body, a.tenant);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(second.headers.get("X-Munim-Replayed")).toBe("true");
    const after = await rows();
    expect(after).toHaveLength(2);
    expect(after[0]).toMatchObject({ vt: "2099-01-01", l: null, m: null, e: 1000 });
    expect(after[1]).toMatchObject({ vf: "2099-01-01", vt: null, l: 3000, m: 6500, e: 1000 });
    // a second version setting one target carries the other over
    expect((await set(a.token, { outlet_id: null, valid_from: "2099-02-01", labour_target_bp: 2800 })).status).toBe(200);
    expect((await rows()).at(-1)).toMatchObject({ vf: "2099-02-01", l: 2800, m: 6500 });
    expect((await set(a.token, { outlet_id: null, valid_from: "2099-03-01", target_margin_bp: 7000 })).status).toBe(200);
    expect((await rows()).at(-1)).toMatchObject({ vf: "2099-03-01", l: 2800, m: 7000 });
    // audited under the owner: one entry per row touched
    expect(await count(`SELECT count(*) n FROM core.audit_log WHERE tenant_id = $1 AND action = 'tenancy.policy.set.v1' AND actor->>'id' = $2`, [a.tenant, a.owner])).toBe(6);
  });
});

describe("tenancy.policy.set.v1: the owner's negotiation bounds (R47 D7)", () => {
  it("target ≤ walk-away on the effective pair (the other bound or its 9500/11000 default); one bound carries over; out-of-range 422", async () => {
    const a = await onboard();
    const set = (payload: Record<string, unknown>) => call("POST", "/v1/policy", a.token, env("tenancy.policy.set.v1", { outlet_id: null, ...payload }), a.tenant);
    const rows = () => db.admin(`SELECT valid_from::text vf, negotiation_target_bp t, negotiation_walkaway_bp w, labour_target_bp l FROM core.business_policy WHERE tenant_id = $1 AND outlet_id IS NULL ORDER BY valid_from`, [a.tenant]).then((r) => r.rows);
    // refusals: target above the default walk-away; walk-away below the default target; crossed pair; zero; above 20,000 — none writes a row
    for (const bad of [{ negotiation_target_bp: 11001 }, { negotiation_walkaway_bp: 9499 }, { negotiation_target_bp: 10500, negotiation_walkaway_bp: 10400 },
      { negotiation_target_bp: 0 }, { negotiation_walkaway_bp: 20001 }]) {
      expect([JSON.stringify(bad), (await set({ valid_from: "2099-01-01", ...bad })).status]).toEqual([JSON.stringify(bad), 422]);
    }
    expect(await rows()).toHaveLength(1);
    // accepts: the defaults themselves; a pair; then one bound alone carries the other over
    expect((await set({ valid_from: "2099-01-01", negotiation_target_bp: 9500, negotiation_walkaway_bp: 11000 })).status).toBe(200);
    expect((await set({ valid_from: "2099-02-01", negotiation_target_bp: 9000, negotiation_walkaway_bp: 10500 })).status).toBe(200);
    expect((await set({ valid_from: "2099-03-01", negotiation_walkaway_bp: 12000 })).status).toBe(200);
    expect((await set({ valid_from: "2099-04-01", labour_target_bp: 3000 })).status).toBe(200); // a labour-only version carries both bounds
    expect((await rows()).map((r) => [r.t, r.w, r.l])).toEqual([[null, null, null], [9500, 11000, null], [9000, 10500, null], [9000, 12000, null], [9000, 12000, 3000]]);
  });
});

describe("tenancy.policy.set.v1: the deal review's margin floor and minimum payment days (R47 D3)", () => {
  it("floor ≤ target margin, given together or against the carried-over target; floor and days carry over; out of range 422", async () => {
    const a = await onboard();
    const set = (payload: Record<string, unknown>) => call("POST", "/v1/policy", a.token, env("tenancy.policy.set.v1", { outlet_id: null, ...payload }), a.tenant);
    const rows = () => db.admin(`SELECT valid_from::text vf, margin_floor_bp f, min_payment_days d, target_margin_bp m FROM core.business_policy WHERE tenant_id = $1 AND outlet_id IS NULL ORDER BY valid_from`, [a.tenant]).then((r) => r.rows);
    // refusals: a floor above the target in one command; floor and days out of range — none writes a row
    for (const bad of [{ target_margin_bp: 6500, margin_floor_bp: 6501 }, { margin_floor_bp: 10001 }, { margin_floor_bp: -1 }, { min_payment_days: -1 }, { min_payment_days: 1.5 }, { min_payment_days: 366 }, { min_payment_days: 2147483648 }]) {
      expect([JSON.stringify(bad), (await set({ valid_from: "2099-01-01", ...bad })).status]).toEqual([JSON.stringify(bad), 422]);
    }
    expect(await rows()).toHaveLength(1);
    // accepts: the target, then the floor and days alone (the target carries over), then the floor at the target itself
    expect((await set({ valid_from: "2099-01-01", target_margin_bp: 6500 })).status).toBe(200);
    expect((await set({ valid_from: "2099-02-01", margin_floor_bp: 1500, min_payment_days: 7 })).status).toBe(200);
    // refused against the CARRIED-OVER target (6500), not only one given in the same command
    expect((await set({ valid_from: "2099-03-01", margin_floor_bp: 6501 })).status).toBe(422);
    expect((await set({ valid_from: "2099-03-01", margin_floor_bp: 6500 })).status).toBe(200);
    expect((await set({ valid_from: "2099-04-01", labour_target_bp: 3000 })).status).toBe(200); // a labour-only version carries floor and days
    expect((await rows()).map((r) => [r.f, r.d, r.m])).toEqual([[null, null, null], [null, null, 6500], [1500, 7, 6500], [6500, 7, 6500], [6500, 7, 6500]]);
    const audit = await db.admin(`SELECT after FROM core.audit_log WHERE tenant_id = $1 AND action = 'tenancy.policy.set.v1' AND after ? 'margin_floor_bp' ORDER BY seq`, [a.tenant]);
    expect(audit.rows.map((r) => [r.after.margin_floor_bp, r.after.min_payment_days])).toEqual([[null, null], [1500, 7], [6500, 7], [6500, 7]]);
  });
});

describe("demo.session.start.v1 (operator)", () => {
  it("an operator starts an ephemeral judge on a fresh demo tenant; a member token cannot", async () => {
    const op = uuidv7(), opSub = `op-${uuidv7()}`;
    await db.admin(`INSERT INTO platform.operator (id, idp_sub, email) VALUES ($1, $2, 'op@example.test')`, [op, opSub]);
    const T = uuidv7(), judge = uuidv7(), outlet = uuidv7();
    const body = env("demo.session.start.v1", { tenant_id: T, member_id: judge, outlet_id: outlet, kind: "restaurant", country_code: "IN", idp_sub: null, judge_label: "Judge 7f3a (demo)" });
    const owner = await onboard();
    expect((await call("POST", "/platform/v1/demo-sessions", owner.token, body)).status).toBe(404);
    expect(await count(`SELECT count(*) n FROM core.tenant WHERE tenant_id = $1`, [T])).toBe(0);
    const r = await call("POST", "/platform/v1/demo-sessions", tok(opSub, "op@example.test"), body);
    expect(r.status).toBe(201);
    expect(await count(`SELECT count(*) n FROM core.tenant WHERE tenant_id = $1 AND is_demo AND onboarded_at IS NOT NULL`, [T])).toBe(1);
    expect(await count(`SELECT count(*) n FROM core.member m JOIN core.membership ms ON ms.tenant_id = m.tenant_id AND ms.member_id = m.id
                         WHERE m.tenant_id = $1 AND m.id = $2 AND m.is_ephemeral_judge AND m.name = 'Judge 7f3a (demo)' AND ms.role = 'judge'`, [T, judge])).toBe(1);
    expect(await count(`SELECT count(*) n FROM core.channel WHERE tenant_id = $1`, [T])).toBe(6);
    expect(await count(`SELECT count(*) n FROM core.audit_log WHERE tenant_id = $1 AND actor->>'kind' = 'operator' AND actor->>'id' = $2`, [T, op])).toBe(2);
  });
});

// R51 A-2: GET /v1/me returns the caller's own membership. Expected values are the ids and scopes this test created.
describe("GET /v1/me (the caller's own member id, name, role and outlet scope)", () => {
  it("owner '*'; manager exactly their outlet; advisor invited with [] = '*'; staff with no outlets []; judge; other tenant 404; no token 401", async () => {
    const a = await onboard();
    const b = await onboard();
    const outletB = uuidv7();
    expect((await call("POST", "/v1/outlets", a.token, env("tenancy.outlet.create.v1",
      { outlet_id: outletB, name: "Second outlet", kind: "restaurant", tz: "Asia/Kolkata", address: "2 Synthetic Street", tax_ids: {} }), a.tenant)).status).toBe(200);
    const me = async (token: string, tenant: string) => {
      const r = await call("GET", "/v1/me", token, undefined, tenant);
      expect(r.status).toBe(200);
      return SCHEMAS["v1.me"].parse(await r.json());
    };
    const invite = async (role: string, name: string, outlet_ids: string[]) => {
      const id = uuidv7(), sub = `${role}-${uuidv7()}`, email = `${sub}@example.test`;
      expect((await call("POST", "/v1/members:invite", a.token, env("tenancy.member.invite.v1", { member_id: id, name, email, role, outlet_ids }), a.tenant)).status).toBe(200);
      expect((await call("POST", "/v1/members:bind", tok(sub, email), env("tenancy.member.bind.v1", { member_id: id }), a.tenant)).status).toBe(200);
      return { token: tok(sub, email), id };
    };

    expect(await me(a.token, a.tenant)).toEqual({ member_id: a.owner, tenant_id: a.tenant, name: "Synthetic Owner", role: "owner", outlet_ids: "*" });
    const mgr = await invite("manager", "Outlet B Manager", [outletB]);
    expect(await me(mgr.token, a.tenant)).toEqual({ member_id: mgr.id, tenant_id: a.tenant, name: "Outlet B Manager", role: "manager", outlet_ids: [outletB] });
    const adv = await invite("advisor", "Advisor", []);
    expect(await me(adv.token, a.tenant)).toEqual({ member_id: adv.id, tenant_id: a.tenant, name: "Advisor", role: "advisor", outlet_ids: "*" });
    // A staff membership with no outlets cannot be made by command (invite refuses it); planted, it reads as no outlets, never '*'.
    const staff = await invite("staff", "Staff", [a.outlet]);
    await db.admin(`SET session_replication_role = replica; UPDATE core.membership SET outlet_ids = '{}' WHERE tenant_id = '${a.tenant}' AND member_id = '${staff.id}'; SET session_replication_role = origin`);
    expect(await me(staff.token, a.tenant)).toEqual({ member_id: staff.id, tenant_id: a.tenant, name: "Staff", role: "staff", outlet_ids: [] });

    // A judge of a demo session (operator-made, with a sign-in) sees their label and the whole demo tenant.
    const op = uuidv7(), opSub = `op-${uuidv7()}`, judgeSub = `judge-${uuidv7()}`;
    await db.admin(`INSERT INTO platform.operator (id, idp_sub, email) VALUES ($1, $2, 'op-me@example.test')`, [op, opSub]);
    const T = uuidv7(), judge = uuidv7();
    expect((await call("POST", "/platform/v1/demo-sessions", tok(opSub, "op-me@example.test"), env("demo.session.start.v1",
      { tenant_id: T, member_id: judge, outlet_id: uuidv7(), kind: "restaurant", country_code: "IN", idp_sub: judgeSub, judge_label: "Judge 9c1d (demo)" }))).status).toBe(201);
    expect(await me(tok(judgeSub), T)).toEqual({ member_id: judge, tenant_id: T, name: "Judge 9c1d (demo)", role: "judge", outlet_ids: "*" });

    // Tenant only from the verified membership: A's owner naming B is 404 (B exists), as is a stranger; no token is 401.
    expect((await call("GET", "/v1/me", a.token, undefined, b.tenant)).status).toBe(404);
    expect((await call("GET", "/v1/me", mgr.token, undefined, b.tenant)).status).toBe(404);
    expect((await call("GET", "/v1/me", tok(`nobody-${uuidv7()}`), undefined, a.tenant)).status).toBe(404);
    expect((await call("GET", "/v1/me", null, undefined, a.tenant)).status).toBe(401);
    // A deactivated member stops resolving.
    expect((await call("POST", `/v1/members/${mgr.id}:deactivate`, a.token, env("tenancy.member.deactivate.v1", { member_id: mgr.id }), a.tenant)).status).toBe(200);
    expect((await call("GET", "/v1/me", mgr.token, undefined, a.tenant)).status).toBe(404);
  });
});

// B12: the published read schemas (strict) accept what the routes really return.
describe("read shapes parse with the published contracts", () => {
  it("tenant, outlets, brands, channels, devices, members, my tenants", async () => {
    const a = await onboard();
    const get = async (path: string) => {
      const r = await call("GET", path, a.token, undefined, path === "/v1/me/tenants" ? undefined : a.tenant);
      expect(r.status).toBe(200);
      return r.json();
    };
    expect(SCHEMAS["v1.tenant"].parse(await get("/v1/tenant")).tenant_id).toBe(a.tenant);
    expect(SCHEMAS["v1.outlets"].parse(await get("/v1/outlets")).outlets.map((o) => o.id)).toEqual([a.outlet]);
    expect(SCHEMAS["v1.brands"].parse(await get("/v1/brands")).brands.length).toBeGreaterThan(0);
    expect(SCHEMAS["v1.channels"].parse(await get("/v1/channels")).channels.length).toBeGreaterThan(0);
    SCHEMAS["v1.devices"].parse(await get("/v1/devices"));
    expect(SCHEMAS["v1.members"].parse(await get("/v1/members")).members.map((m) => [m.id, m.role, m.signed_in])).toEqual([[a.owner, "owner", true]]);
    expect(SCHEMAS["tenancy.me.tenants"].parse(await get("/v1/me/tenants")).tenants.map((t) => t.tenant_id)).toEqual([a.tenant]);
  });
});
