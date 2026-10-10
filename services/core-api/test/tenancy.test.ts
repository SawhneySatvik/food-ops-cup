// T-020 gates — tenancy + onboarding through the real app (IdP → withContext → RLS → book guard).
//   onboarding 3 kinds × 2 countries → hand-typed default row counts; retry of one envelope → 1 tenant;
//   country/currency change after onboarding → 409 country_locked (before onboarding it must fit the old pack's rows: 422);
//   invite → first sign-in binds idp_sub exactly once; storefront key stored only as sha256, revoked → 404;
//   manager of outlet A cannot update outlet B (MB001 → 403, twin: outlet A 200).
// PENDING SEED (reported to the migrator): tenancy.onboard.v1 and tenancy.member.bind.v1 are not in
// core.command_authority yet. This file inserts them into ITS OWN database clone with the shape the report
// requests; everything else uses seeded commands. Expected values are typed by hand. Synthetic data only.
import { createHash } from "node:crypto";
import { createLogger } from "@munim/config";
import type { TestDb } from "@munim/db";
import { uuidv7 } from "@munim/db";
import { Hono } from "hono";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalIdp } from "../../../adapters/dev/idp-local/index.ts";
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
const tok = (sub: string, email?: string) => idp.sign({ sub, ...(email ? { email } : {}) });
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
  return b;
}

beforeAll(async () => {
  db = await openDb();
  // The pending seed rows (see the header). ON CONFLICT: a later migration that seeds them wins.
  await db.admin(`INSERT INTO core.command_authority (command_type, allowed_roles, scope, target_tables) VALUES
    ('tenancy.onboard.v1', ARRAY['owner'], 'tenant', ARRAY['core.tenant', 'core.member', 'core.membership', 'core.outlet', 'core.outlet_calendar',
                                                           'core.brand', 'core.channel', 'core.business_policy', 'core.account']),
    ('tenancy.member.bind.v1', ARRAY['owner', 'manager', 'staff', 'advisor', 'judge'], 'outlet', ARRAY['core.member'])
    ON CONFLICT (command_type) DO NOTHING`);
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
    { kind: "restaurant", country: "IN", channels: 6, devices: 2, outletKind: "restaurant", prep: 15, lead: 20, agg: IN_AGG, cur: "INR", fy: 4, tz: "Asia/Kolkata", accounts: 21 },
    { kind: "cloud_kitchen", country: "IN", channels: 4, devices: 2, outletKind: "cloud_kitchen", prep: 20, lead: 30, agg: IN_AGG, cur: "INR", fy: 4, tz: "Asia/Kolkata", accounts: 21 },
    { kind: "shop", country: "IN", channels: 3, devices: 1, outletKind: "store", prep: 5, lead: 15, agg: [], cur: "INR", fy: 4, tz: "Asia/Kolkata", accounts: 21 },
    { kind: "restaurant", country: "AU", channels: 6, devices: 2, outletKind: "restaurant", prep: 15, lead: 20, agg: AU_AGG, cur: "AUD", fy: 7, tz: "Australia/Melbourne", accounts: 22 },
    { kind: "cloud_kitchen", country: "AU", channels: 4, devices: 2, outletKind: "cloud_kitchen", prep: 20, lead: 30, agg: AU_AGG, cur: "AUD", fy: 7, tz: "Australia/Melbourne", accounts: 22 },
    { kind: "shop", country: "AU", channels: 3, devices: 1, outletKind: "store", prep: 5, lead: 15, agg: [], cur: "AUD", fy: 7, tz: "Australia/Melbourne", accounts: 22 },
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
    // chart: the pack's accounts (IN 16, AU 17) + the 5 structural ones the packs do not define
    expect(await count(`SELECT count(*) n FROM core.account WHERE tenant_id = $1`, [T])).toBe(x.accounts);
    expect(await count(`SELECT count(*) n FROM core.member WHERE tenant_id = $1`, [T])).toBe(1);
    expect(await count(`SELECT count(*) n FROM core.membership WHERE tenant_id = $1 AND role = 'owner'`, [T])).toBe(1);
    // Every book row was stamped by the operator's own command (the guard's origin), not by anything else.
    expect(await count(`SELECT count(*) n FROM core.channel WHERE tenant_id = $1 AND origin->>'command_type' = 'tenancy.provision.v1'`, [T])).toBe(x.channels);
  });
});

describe("POST /v1/onboarding", () => {
  it("restaurant/IN and shop/AU through the route: owner signed in at once, same rows as the table above", async () => {
    const a = await onboard({ kind: "restaurant", country: "IN", outlet: { tax_ids: { FSSAI: IN_FSSAI } } });
    expect(await count(`SELECT count(*) n FROM core.channel WHERE tenant_id = $1`, [a.tenant])).toBe(6);
    expect(await count(`SELECT count(*) n FROM core.device WHERE tenant_id = $1`, [a.tenant])).toBe(2);
    expect(await count(`SELECT count(*) n FROM core.account WHERE tenant_id = $1`, [a.tenant])).toBe(21);
    expect(await count(`SELECT count(*) n FROM core.outlet WHERE tenant_id = $1 AND tax_ids->>'FSSAI' = $2`, [a.tenant, IN_FSSAI])).toBe(1);
    expect(await count(`SELECT count(*) n FROM core.member WHERE tenant_id = $1 AND id = $2 AND idp_sub = $3 AND email = $4`, [a.tenant, a.owner, a.sub, a.email])).toBe(1);
    expect(await count(`SELECT count(*) n FROM core.tenant WHERE tenant_id = $1 AND onboarded_at IS NOT NULL AND created_by = $2`, [a.tenant, a.owner])).toBe(1);
    // The audit entry names the person who asked, not an operator.
    expect(await count(`SELECT count(*) n FROM core.audit_log WHERE tenant_id = $1 AND actor->>'id' = $2 AND actor->>'kind' = 'member'`, [a.tenant, a.owner])).toBe(3);
    expect(await count(`SELECT count(*) n FROM core.account WHERE tenant_id = $1 AND origin->>'command_type' = 'tenancy.onboard.v1'`, [a.tenant])).toBe(21);
    const s = await onboard({ kind: "shop", country: "AU", outlet: { tax_ids: { ABN: "12345678901" } } });
    expect(await count(`SELECT count(*) n FROM core.channel WHERE tenant_id = $1`, [s.tenant])).toBe(3);
    expect(await count(`SELECT count(*) n FROM core.device WHERE tenant_id = $1`, [s.tenant])).toBe(1);
    expect(await count(`SELECT count(*) n FROM core.account WHERE tenant_id = $1`, [s.tenant])).toBe(22);
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
    expect(await second.text()).toBe(await first.text());
    expect(await count(`SELECT count(*) n FROM core.tenant WHERE tenant_id = $1`, [b.tenant])).toBe(1);
    expect(await count(`SELECT count(*) n FROM core.channel WHERE tenant_id = $1`, [b.tenant])).toBe(6);
  });

  it("an existing tenant id with a fresh key is refused 409 and changes nothing (no takeover)", async () => {
    const a = await onboard();
    const before = await count(`SELECT count(*) n FROM core.member WHERE tenant_id = $1`, [a.tenant]);
    const intruder = { tenant: a.tenant, owner: uuidv7(), outlet: uuidv7() };
    const r = await call("POST", "/v1/onboarding", tok(`x-${uuidv7()}`, "x@example.test"), onboardBody(intruder));
    expect(r.status).toBe(409);
    expect(await count(`SELECT count(*) n FROM core.member WHERE tenant_id = $1`, [a.tenant])).toBe(before);
  });

  it("refusals paired with accepts: bad FSSAI 422 (0 rows), missing FSSAI accepted; zone outside the pack 422; unknown country 422; no token 401", async () => {
    const bad = { tenant: uuidv7(), owner: uuidv7(), outlet: uuidv7() };
    const t = tok(`o-${uuidv7()}`, "bad@example.test");
    const r1 = await call("POST", "/v1/onboarding", t, onboardBody(bad, { outlet: { tax_ids: { FSSAI: "123" } } }));
    expect(r1.status).toBe(422);
    expect((await r1.json()).refs).toEqual(["tax_id:FSSAI"]);
    expect(await count(`SELECT count(*) n FROM core.tenant WHERE tenant_id = $1`, [bad.tenant])).toBe(0);
    const r2 = await call("POST", "/v1/onboarding", t, onboardBody(bad, { outlet: { tz: "Australia/Sydney" } }));
    expect(r2.status).toBe(422);
    const r3 = await call("POST", "/v1/onboarding", t, onboardBody(bad, { country: "ZZ" }));
    expect(r3.status).toBe(422);
    expect((await r3.json()).error.code).toBe("out_of_pack_scope");
    expect(await count(`SELECT count(*) n FROM core.tenant WHERE tenant_id = $1`, [bad.tenant])).toBe(0);
    expect((await call("POST", "/v1/onboarding", null, onboardBody(bad))).status).toBe(401);
    // accepts: no tax ids at all (ON3 "optional") and a valid pack zone
    const ok = await call("POST", "/v1/onboarding", t, onboardBody(bad, { outlet: { tz: "Asia/Kolkata" } }));
    expect(ok.status).toBe(201);
    expect(await count(`SELECT count(*) n FROM core.outlet WHERE tenant_id = $1 AND tax_ids = '{}'::jsonb`, [bad.tenant])).toBe(1);
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
    expect(await count(`SELECT count(*) n FROM core.account WHERE tenant_id = $1`, [T])).toBe(22);
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
    // the invited person signs in → bound
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

describe("storefront keys", () => {
  it("the raw key is returned once and never stored; revoked → 404 at once; non-owner and foreign channel refused", async () => {
    const a = await onboard();
    const other = await onboard();
    const channel = (await one<{ id: string }>(`SELECT id FROM core.channel WHERE tenant_id = $1 AND kind = 'own_site'`, [a.tenant])).id;
    const keyId = uuidv7();
    const r = await call("POST", "/v1/storefront-keys", a.token, { key_id: keyId, channel_id: channel, allowed_origins: ["https://shop.example.test"] }, a.tenant);
    expect(r.status).toBe(201);
    const { key } = await r.json();
    expect(key).toMatch(/^sfk_[A-Za-z0-9_-]{43}$/);
    // stored: exactly sha256(key) hex; the raw value is nowhere in the tenant's rows
    const hash = createHash("sha256").update(key).digest("hex");
    expect(await count(`SELECT count(*) n FROM core.storefront_key WHERE id = $1 AND key_hash = $2 AND revoked_at IS NULL`, [keyId, hash])).toBe(1);
    expect(await count(`SELECT count(*) n FROM core.audit_log WHERE tenant_id = $1 AND (audit_log::text LIKE '%' || $2 || '%')`, [a.tenant, key])).toBe(0);
    expect(await count(`SELECT count(*) n FROM core.command_log WHERE tenant_id = $1 AND (command_log::text LIKE '%' || $2 || '%')`, [a.tenant, key])).toBe(0);
    expect(await count(`SELECT count(*) n FROM core.outbox WHERE tenant_id = $1 AND (outbox::text LIKE '%' || $2 || '%')`, [a.tenant, key])).toBe(0);
    expect(await count(`SELECT count(*) n FROM core.storefront_key WHERE storefront_key::text LIKE '%' || $1 || '%'`, [key])).toBe(0);
    // the list never carries key material
    expect(JSON.stringify(await (await call("GET", "/v1/storefront-keys", a.token, undefined, a.tenant)).json())).not.toContain(key);
    // it resolves: requireCustomer on the key → 200
    const via = (k: string) => probe.request("/probe", { headers: { "X-Munim-Storefront-Key": k } });
    expect((await via(key)).status).toBe(200);
    // revoke → 404 at once; revoking twice is a stable success
    const rv = await call("POST", `/v1/storefront-keys/${keyId}:revoke`, a.token, undefined, a.tenant);
    expect(rv.status).toBe(200);
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
