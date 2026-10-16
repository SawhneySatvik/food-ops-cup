// C2 gates (the C1 security review's S2-1, S2-4, S2-5, S2-7 and R64 X-2 / X-4), through the real app on embedded Postgres; no
// model. Every expected status, code and count is typed by hand from the C2 brief and R64. Synthetic data only.
//   S2-1  an onboarded demo business refuses member invite, role change and deactivation, the AI cap and a storefront key revoke:
//         403 forbidden, nothing written. The same commands succeed on a business that is not a demo, and an invite succeeds on a
//         demo business still being set up (the seed's path), whose stored result still replays once it is onboarded. A command
//         off the list (a brand) still works on the demo.
//   S2-4  a run a member started mints no template above that member's CURRENT role (staff: no advisor-level finance.pnl);
//         the owner's run, a watcher's run and the staff-level template still mint.
//   S2-5  bodies over the route's cap are 413 before any route reads them; a cart over 100 lines, 20 options a line or a million
//         units a line is 422 invalid_payload on the storefront and member routes, and 100 lines still prices.
//   S2-7  POST /v1/devices: staff 403, a manager outside their outlet 403; the manager's own outlet and the owner 200.
//   X-4   one sign-in creates at most 5 businesses self-serve; a retry of an accepted envelope still replays.
import { createHash } from "node:crypto";
import { createLogger } from "@munim/config";
import { ownerCtx, type TestDb, uuidv7 } from "@munim/db";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalIdp } from "../src/auth/local-idp.ts";
import { createApp, type Deps, STOREFRONT_KEY_HEADER, storefrontResolver, TENANT_HEADER } from "../src/app.ts";
import { svcTx, testKeys } from "../src/commit/testkit.ts";
import { configureInternal } from "../src/internal/index.ts";
import { mintRunToken } from "../src/runtoken/index.ts";
import { openDb } from "./db.ts";
import { buildTenant, type Tenant } from "./world.ts";

const idp = createLocalIdp();
const keys = testKeys();
const SECRET = "c2-security-service-secret-not-real-0123456789";
const MONTH = `${new Date().toISOString().slice(0, 7)}-01`; // the operator budget's basis: the current UTC month
let db: TestDb;
let pools: { core: pg.Pool; svc: pg.Pool };
let app: Awaited<ReturnType<typeof createApp>>;
/** demo: is_demo + onboarded. setup: is_demo, not yet onboarded (the seed is still building it). plain: onboarded, not a demo. */
let demo: Tenant, setup: Tenant, plain: Tenant, dev: Tenant;
const staffSub = new Map<string, string>();
let SF_KEY: string; // plain's pickup storefront key
let VARIANT: string;

type Res = Omit<Response, "json"> & { json(): Promise<any> };
const as = (sub: string, t: Tenant) => ({ Authorization: `Bearer ${idp.sign({ sub })}`, [TENANT_HEADER]: t.tenant });
const post = async (path: string, headers: Record<string, string>, body: unknown): Promise<Res> =>
  (await app.request(path, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) })) as Res;
const env = (type: string, payload: Record<string, unknown>, key = `c2-${uuidv7()}`) => ({ command_id: uuidv7(), idempotency_key: key, type, payload });
const count = async (sql: string, params: unknown[]) => Number((await db.admin(sql, params)).rows[0]!.n);
const audits = (t: Tenant) => count(`SELECT count(*) n FROM core.audit_log WHERE tenant_id = $1`, [t.tenant]);
/** is_demo and onboarded_at are set only by operator provisioning and onboarding: the fixture sets them as plumbing. */
const flag = (t: Tenant, isDemo: boolean, onboarded: boolean) =>
  db.admin(`SET session_replication_role = replica;
            UPDATE core.tenant SET is_demo = ${isDemo}, onboarded_at = ${onboarded ? "now()" : "NULL"} WHERE tenant_id = '${t.tenant}';
            RESET session_replication_role`);

const invite = (t: Tenant, key?: string) => post("/v1/members:invite", as(t.ownerSub, t), env("tenancy.member.invite.v1",
  { member_id: uuidv7(), name: "Invited (synthetic)", email: `inv-${uuidv7()}@example.test`, role: "staff", outlet_ids: [t.outlets[0]] }, key));
const setRole = (t: Tenant) => post(`/v1/members/${t.staff}:set-role`, as(t.ownerSub, t),
  env("tenancy.member.role.set.v1", { member_id: t.staff, role: "manager", outlet_ids: [t.outlets[0]] }));
const deactivate = (t: Tenant) => post(`/v1/members/${t.manager}:deactivate`, as(t.ownerSub, t), env("tenancy.member.deactivate.v1", { member_id: t.manager }));
const setCap = (t: Tenant) => post("/v1/ai/policy/cap", as(t.ownerSub, t), env("ai_policy.cap.set.v1", { monthly_cap_minor: 1000 }));
const keyOf = async (t: Tenant) => (await db.admin<{ id: string }>(`SELECT id FROM core.storefront_key WHERE tenant_id = $1 AND channel_id = $2`, [t.tenant, t.channel])).rows[0]!.id;
const revoke = async (t: Tenant) => post(`/v1/storefront-keys/${await keyOf(t)}:revoke`, as(t.ownerSub, t), "");

beforeAll(async () => {
  db = await openDb();
  [demo, setup, plain, dev] = [await buildTenant(db, "D"), await buildTenant(db, "U"), await buildTenant(db, "P"), await buildTenant(db, "V")];
  await flag(demo, true, true);
  await flag(setup, true, false);
  await flag(plain, false, true);
  for (const t of [demo, plain, dev]) {
    const sub = `staff-${uuidv7()}`;
    staffSub.set(t.tenant, sub);
    await db.withContext("munim_core", ownerCtx(t, { command_type: "tenancy.member.invite.v1" }), (c) =>
      c.query(`UPDATE core.member SET idp_sub = $3 WHERE tenant_id = $1 AND id = $2`, [t.tenant, t.staff, sub]));
  }
  for (const t of [demo, plain]) {
    await db.admin(`INSERT INTO platform.llm_budget (tenant_id, month, limit_minor, currency) VALUES ($1, $2, 500000, $3)
                    ON CONFLICT (tenant_id, month) DO UPDATE SET limit_minor = EXCLUDED.limit_minor, currency = EXCLUDED.currency`, [t.tenant, MONTH, t.currency]);
  }
  // S2-4: one template a staff member may mint and one only an advisor or owner may (test-only rows in this clone).
  for (const [id, minRole] of [["test.c2_staff", "staff"], ["test.c2_advisor", "advisor"]]) {
    await db.admin(`INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES ($1, 1, $2, $3, $4, $5)`, [
      id, `SELECT o.id AS outlet FROM core.outlet o WHERE o.id = :outlet_id::uuid`,
      JSON.stringify({ type: "object", required: ["outlet_id"], additionalProperties: false, properties: { outlet_id: { type: "string" } } }),
      JSON.stringify([{ name: "outlet", type: "uuid" }]), minRole]);
  }
  // S2-5: a pickup channel with its own storefront key and a pickup price on plain's outlet 1.
  const ch = uuidv7();
  SF_KEY = `sfk_C2_${uuidv7().replaceAll("-", "")}`;
  await db.withContext("munim_core", ownerCtx(plain, { command_type: "tenancy.channel.create.v1" }), (c) =>
    c.query(`INSERT INTO core.channel (tenant_id, id, name, kind) VALUES ($1, $2, 'Pickup', 'pickup')`, [plain.tenant, ch]));
  await db.withContext("munim_core", ownerCtx(plain), (c) =>
    c.query(`INSERT INTO core.storefront_key (tenant_id, id, channel_id, key_hash) VALUES ($1, $2, $3, $4)`, [plain.tenant, uuidv7(), ch, createHash("sha256").update(SF_KEY).digest("hex")]));
  await db.withContext("munim_core", ownerCtx(plain, { command_type: "catalogue.price.set.v1" }), (c) =>
    c.query(`INSERT INTO core.price (tenant_id, id, item_id, outlet_id, channel_kind, amount_minor, currency, tax_class, valid_from)
             VALUES ($1, $2, $3, $4, 'pickup', 32000, $5, 'restaurant_5', '2026-10-01')`, [plain.tenant, uuidv7(), plain.item, plain.outlets[0], plain.currency]));
  VARIANT = (await db.admin<{ id: string }>(`SELECT id FROM core.variant WHERE tenant_id = $1 AND item_id = $2`, [plain.tenant, plain.item])).rows[0]!.id;

  pools = { core: db.pool("munim_core", 6), svc: db.pool("munim_svc", 4) };
  const config = { nodeEnv: "test", redact: (s: string) => s };
  const deps: Deps = { pools, idp, storefronts: storefrontResolver(pools.core), config, log: createLogger(config, () => {}) };
  app = await createApp(deps);
  configureInternal(deps, { serviceSecret: SECRET, keys, watchWindowMs: 0 });
});

afterAll(async () => {
  await pools?.core.end();
  await pools?.svc.end();
  await db?.stop();
});

describe("S2-1 demo deny-list (R64 X-2)", () => {
  it("member invite: refused on the onboarded demo (403, no member, no audit row); admitted on plain", async () => {
    const [members, audit] = [await count(`SELECT count(*) n FROM core.member WHERE tenant_id = $1`, [demo.tenant]), await audits(demo)];
    const refused = await invite(demo);
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.code).toBe("forbidden");
    expect(await count(`SELECT count(*) n FROM core.member WHERE tenant_id = $1`, [demo.tenant])).toBe(members);
    expect(await audits(demo)).toBe(audit);
    expect((await invite(plain)).status).toBe(200);
  });

  it("member invite during setup: admitted while the demo is not onboarded; its stored result replays after; a new invite then 403", async () => {
    const key = `c2-setup-${uuidv7()}`;
    const body = env("tenancy.member.invite.v1",
      { member_id: uuidv7(), name: "Demo person (synthetic)", email: `demo-${uuidv7()}@example.test`, role: "staff", outlet_ids: [setup.outlets[0]] }, key);
    const first = await post("/v1/members:invite", as(setup.ownerSub, setup), body);
    expect(first.status).toBe(200);
    const stored = await first.text();
    await flag(setup, true, true);
    const again = await post("/v1/members:invite", as(setup.ownerSub, setup), body);
    expect(again.status).toBe(200);
    expect(again.headers.get("X-Munim-Replayed")).toBe("true");
    expect(await again.text()).toBe(stored);
    expect((await invite(setup)).status).toBe(403);
  });

  it("role change: refused on the demo (role unchanged); admitted on plain", async () => {
    const role = (t: Tenant) => db.admin<{ role: string }>(`SELECT role FROM core.membership WHERE tenant_id = $1 AND member_id = $2`, [t.tenant, t.staff]).then((r) => r.rows[0]!.role);
    const refused = await setRole(demo);
    expect([refused.status, (await refused.json()).error.code]).toEqual([403, "forbidden"]);
    expect(await role(demo)).toBe("staff");
    expect((await setRole(plain)).status).toBe(200);
    expect(await role(plain)).toBe("manager");
  });

  it("deactivation: refused on the demo (still active); admitted on plain", async () => {
    const active = (t: Tenant) => db.admin<{ active: boolean }>(`SELECT active FROM core.member WHERE tenant_id = $1 AND id = $2`, [t.tenant, t.manager]).then((r) => r.rows[0]!.active);
    const refused = await deactivate(demo);
    expect([refused.status, (await refused.json()).error.code]).toEqual([403, "forbidden"]);
    expect(await active(demo)).toBe(true);
    expect((await deactivate(plain)).status).toBe(200);
    expect(await active(plain)).toBe(false);
  });

  it("AI cap: refused on the demo (the world's 500000 cap stays); admitted on plain (now 1000)", async () => {
    const cap = (t: Tenant) => db.admin<{ c: string }>(`SELECT monthly_cap_minor::text c FROM core.ai_budget_cap WHERE tenant_id = $1`, [t.tenant]).then((r) => r.rows.map((x) => x.c));
    const refused = await setCap(demo);
    expect([refused.status, (await refused.json()).error.code]).toEqual([403, "forbidden"]);
    expect(await cap(demo)).toEqual(["500000"]);
    expect((await setCap(plain)).status).toBe(200);
    expect(await cap(plain)).toEqual(["1000"]);
  });

  it("storefront key revoke: refused on the demo (revoked_at stays null); admitted on plain", async () => {
    const revoked = async (t: Tenant) => (await db.admin<{ r: boolean }>(`SELECT revoked_at IS NOT NULL r FROM core.storefront_key WHERE id = $1`, [await keyOf(t)])).rows[0]!.r;
    const refused = await revoke(demo);
    expect([refused.status, (await refused.json()).error.code]).toEqual([403, "forbidden"]);
    expect(await revoked(demo)).toBe(false);
    expect((await revoke(plain)).status).toBe(200);
    expect(await revoked(plain)).toBe(true);
  });

  it("a command off the list still works on the demo: a brand is created (200)", async () => {
    const r = await post("/v1/brands", as(demo.ownerSub, demo), env("tenancy.brand.create.v1", { brand_id: uuidv7(), name: "Demo brand (synthetic)", outlet_ids: [demo.outlets[0]] }));
    expect(r.status).toBe(200);
  });
});

describe("S2-4 a member's run mints within the member's current role", () => {
  type Run = Parameters<typeof mintRunToken>[1];
  const token = async (o: Partial<Run>) =>
    (await mintRunToken({ ...keys, svc: svcTx(db) }, { tenantId: dev.tenant, outletScope: [dev.outlets[0]], trigger: "ask", actor: dev.staff, ...o })).token;
  const mint = async (tok: string, template_id: string, params: Record<string, unknown> = { outlet_id: dev.outlets[0] }) =>
    (await post("/internal/intel/v1/snapshots", { authorization: `Bearer ${tok}`, "x-munim-service-secret": SECRET }, { template_id, params })).status;

  it("a staff member's Ask: the advisor-level template and finance.pnl → 404; the staff template → 201", async () => {
    const tok = await token({});
    expect(await mint(tok, "test.c2_advisor")).toBe(404);
    expect(await mint(tok, "finance.pnl", { period_month: "2026-10-01", group_by: "outlet" })).toBe(404);
    expect(await mint(tok, "test.c2_staff")).toBe(201);
  });

  it("the owner's Ask and a watcher's run: the advisor-level template and finance.pnl → 201", async () => {
    const owner = await token({ actor: dev.owner, outletScope: ["*"] });
    expect(await mint(owner, "test.c2_advisor")).toBe(201);
    expect(await mint(owner, "finance.pnl", { period_month: "2026-10-01", group_by: "outlet" })).toBe(201);
    expect(await mint(await token({ actor: "watcher:finance", trigger: "watch_sweep", outletScope: ["*"] }), "test.c2_advisor")).toBe(201);
  });

  it("the role is read at mint time: an advisor's run mints the advisor template, then 404 once the member is staff", async () => {
    const advisor = uuidv7();
    await db.withContext("munim_core", ownerCtx(dev, { command_type: "tenancy.member.invite.v1" }), async (c) => {
      await c.query(`INSERT INTO core.member (tenant_id, id, name, email) VALUES ($1, $2, 'Advisor (synthetic)', 'advisor-c2@example.test')`, [dev.tenant, advisor]);
      await c.query(`INSERT INTO core.membership (tenant_id, member_id, role, outlet_ids) VALUES ($1, $2, 'advisor', '{}')`, [dev.tenant, advisor]);
    });
    const tok = await token({ actor: advisor, outletScope: ["*"] });
    expect(await mint(tok, "test.c2_advisor")).toBe(201);
    await db.admin(`SET session_replication_role = replica; UPDATE core.membership SET role = 'staff' WHERE member_id = '${advisor}'; RESET session_replication_role`);
    expect(await mint(tok, "test.c2_advisor")).toBe(404);
  });
});

describe("S2-5 request body and cart caps", () => {
  const sf = (path: string, body: unknown) => post(path, { [STOREFRONT_KEY_HEADER]: SF_KEY }, body);
  const line = (o: Partial<{ option_ids: string[]; qty_milli: number }> = {}) =>
    ({ item_id: plain.item, variant_id: VARIANT, option_ids: [], qty_milli: 1000, barcode: null, ...o });
  const cart = (lines: unknown[]) => ({ outlet_id: plain.outlets[0], channel_id: plain.channel, brand_id: null, kind: "pickup", pickup_window_id: null,
    promised_at: null, coupon_codes: [], loyalty_redeem_points: 0, lines });
  const pad = (bytes: number) => JSON.stringify({ pad: "x".repeat(bytes) });

  it("over 256 KiB on a storefront route → 413 bad_request (the fixed error body); 200 KiB reaches the route (its own 400)", async () => {
    const big = await sf("/v1/storefront/orders:preview", pad(300 * 1024));
    expect(big.status).toBe(413);
    expect((await big.json()).error.code).toBe("bad_request");
    expect((await sf("/v1/storefront/orders:preview", pad(200 * 1024))).status).toBe(400);
  });

  it("the upload route and intel's internal routes keep their own larger caps", async () => {
    expect((await post("/v1/imports/documents", {}, pad(2 * 1024 * 1024))).status).toBe(401);
    expect((await post("/v1/imports/documents", {}, pad(9 * 1024 * 1024))).status).toBe(413);
    expect((await post("/internal/intel/v1/snapshots", {}, pad(2 * 1024 * 1024))).status).not.toBe(413);
    expect((await post("/internal/intel/v1/snapshots", {}, pad(17 * 1024 * 1024))).status).toBe(413);
  });

  it("storefront preview: 100 lines → 200; 101 lines, 21 options or 10⁹+1 qty_milli → 422 invalid_payload", async () => {
    expect((await sf("/v1/storefront/orders:preview", cart(Array.from({ length: 100 }, () => line())))).status).toBe(200);
    for (const lines of [Array.from({ length: 101 }, () => line()), [line({ option_ids: Array.from({ length: 21 }, () => uuidv7()) })], [line({ qty_milli: 1_000_000_001 })]]) {
      const r = await sf("/v1/storefront/orders:preview", cart(lines));
      expect([r.status, (await r.json()).error.code]).toEqual([422, "invalid_payload"]);
    }
  });

  it("storefront place and the member POS preview: 101 lines → 422, no order written", async () => {
    const orders = () => count(`SELECT count(*) n FROM core."order" WHERE tenant_id = $1`, [plain.tenant]);
    const before = await orders();
    const orderId = uuidv7();
    const lines = Array.from({ length: 101 }, () => ({ ...line(), line_id: uuidv7(), note: null }));
    const placed = await sf("/v1/storefront/orders", {
      order: { command_id: uuidv7(), idempotency_key: `c2-${orderId}`, type: "orders.place.v1", payload: {
        order_id: orderId, outlet_id: plain.outlets[0], channel_id: plain.channel, brand_id: null, device_id: null, kind: "pickup", table_ref: null,
        pickup_window_id: null, promised_at: null, external_ref: null, lines, coupon_codes: [], loyalty_redeem_points: 0, preview_total_minor: null, client_totals: null } },
      guest: { command_id: uuidv7(), idempotency_key: `c2-guest-${orderId}`, type: "storefront.guest.create.v1",
        payload: { name: "Guest (synthetic)", phone: "+919800000002", email: null, consent: { marketing: false, at: "2026-10-10T07:00:00.000Z" } } },
      contact: null,
    });
    expect([placed.status, (await placed.json()).error.code]).toEqual([422, "invalid_payload"]);
    expect(await orders()).toBe(before);
    const pos = await post("/v1/orders:preview", as(plain.ownerSub, plain), { ...cart(Array.from({ length: 101 }, () => line())), kind: "takeaway" });
    expect([pos.status, (await pos.json()).error.code]).toEqual([422, "invalid_payload"]);
  });
});

describe("S2-7 POST /v1/devices: owner and manager only, within their outlets", () => {
  const register = (sub: string, outlet: string) =>
    post("/v1/devices", as(sub, dev), env("tenancy.device.register.v1", { device_id: uuidv7(), outlet_id: outlet, kind: "pos", invoice_series: `C2${Math.floor(Math.random() * 1e6)}` }));
  const devices = () => count(`SELECT count(*) n FROM core.device WHERE tenant_id = $1`, [dev.tenant]);

  it("staff on their own outlet → 403 authority_denied; a manager on another outlet → 403; nothing written", async () => {
    const before = await devices();
    const staff = await register(staffSub.get(dev.tenant)!, dev.outlets[0]);
    expect([staff.status, (await staff.json()).error.reason_code]).toEqual([403, "authority_denied"]);
    const other = await register(dev.managerSub, dev.outlets[1]);
    expect([other.status, (await other.json()).error.reason_code]).toEqual([403, "authority_denied"]);
    expect(await devices()).toBe(before);
  });

  it("the manager on their own outlet and the owner on any outlet → 200, one device each", async () => {
    const before = await devices();
    expect((await register(dev.managerSub, dev.outlets[0])).status).toBe(200);
    expect((await register(dev.ownerSub, dev.outlets[1])).status).toBe(200);
    expect(await devices()).toBe(before + 2);
  });
});

describe("X-4 self-serve onboarding: at most 5 businesses per sign-in", () => {
  it("five onboardings → 201; the sixth → 403 and no tenant; the fifth's envelope again → its stored result (replayed)", async () => {
    const sub = `founder-c2-${uuidv7()}`;
    const token = idp.sign({ sub, email: `${sub}@example.test`, email_verified: true });
    const body = () => env("tenancy.onboard.v1", {
      tenant_id: uuidv7(), owner_member_id: uuidv7(), outlet_id: uuidv7(), owner_name: "Synthetic Owner", business_name: "Synthetic Biz",
      kind: "restaurant", country_code: "IN", outlet: { name: "Main outlet", address: "1 Synthetic Street", tax_ids: {} } });
    const owned = () => count(`SELECT count(*) n FROM core.member WHERE idp_sub = $1`, [sub]);
    let last: ReturnType<typeof body> | undefined;
    for (let i = 0; i < 5; i++) {
      last = body();
      expect((await post("/v1/onboarding", { Authorization: `Bearer ${token}` }, last)).status).toBe(201);
    }
    expect(await owned()).toBe(5);
    const sixth = await post("/v1/onboarding", { Authorization: `Bearer ${token}` }, body());
    expect([sixth.status, (await sixth.json()).error.code]).toEqual([403, "forbidden"]);
    expect(await owned()).toBe(5);
    const again = await post("/v1/onboarding", { Authorization: `Bearer ${token}` }, last);
    expect(again.status).toBe(201);
    expect(again.headers.get("X-Munim-Replayed")).toBe("true");
  });
});
