// T-031 platform admin API gates, through the real auth -> munim_platform path (embedded Postgres, synthetic data).
//   model-role changes apply only after an approved config draft (proposed -> applied); gemini-2.5 and unknown
//   providers are refused (each paired with an accepted model); every platform route is 404 for a non-operator;
//   operators cannot reach tenant books through platform routes or the platform role.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createLogger } from "@munim/config";
import { uuidv7, type TestDb } from "@munim/db";
import { Snapshot } from "@munim/contracts";
import { ROUTES, SCHEMAS } from "@munim/contracts/platform";
import { TenancyProvisionV1, ROUTES as TENANCY_ROUTES } from "@munim/contracts/tenancy";
import type { Hono } from "hono";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppEnv, createApp, storefrontResolver, TENANT_HEADER } from "../src/app.ts";
import { createLocalIdp } from "../src/auth/local-idp.ts";
import { setProvisionTenant } from "../src/platform/index.ts";
import { isTenancyModuleAbsent } from "../src/platform/provision.ts";
import { openDb } from "./db.ts";
import { buildTenant, type Tenant } from "./world.ts";

const idp = createLocalIdp();
let db: TestDb;
let pools: { core: pg.Pool; svc: pg.Pool; platform: pg.Pool };
let app: Hono<AppEnv>;
let A: Tenant;
let opId1: string;
let opId2: string;
const OP1 = "operator-sub-1";
const OP2 = "operator-sub-2";

type Res = Omit<Response, "json"> & { json(): Promise<any> };
const call = (method: string, path: string, sub: string | null, body?: unknown, extra: Record<string, string> = {}): Promise<Res> =>
  app.request(path, {
    method,
    headers: { ...(sub ? { Authorization: `Bearer ${idp.sign({ sub })}` } : {}), ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...extra },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }) as Promise<Res>;
const draftCount = async () => Number((await db.admin("SELECT count(*) AS n FROM platform.config_draft")).rows[0]!.n);
const roleRow = async (role: string) => (await db.admin("SELECT provider, model_id FROM platform.model_role WHERE role = $1", [role])).rows[0];
const propose = (target: string, patch: unknown, sub = OP1) => call("POST", "/platform/v1/config-drafts", sub, { target, patch });
// The defaults 0015 A11 seeds (hand-typed from the migration): every role starts on a Gemini 3.x id.
const SEEDED: Record<string, { provider: string; model_id: string }> = {
  router: { provider: "gemini", model_id: "gemini-3.5-flash-lite" },
  extract: { provider: "gemini", model_id: "gemini-3.5-flash-lite" },
  narrate: { provider: "gemini", model_id: "gemini-3.5-flash-lite" },
  reason: { provider: "gemini", model_id: "gemini-3.8-flash" },
  vision: { provider: "gemini", model_id: "gemini-3.8-flash" },
  embed: { provider: "gemini", model_id: "gemini-embedding-001" },
};

beforeAll(async () => {
  db = await openDb();
  A = await buildTenant(db, "A");
  opId1 = uuidv7();
  opId2 = uuidv7();
  await db.admin(`INSERT INTO platform.operator (id, idp_sub, email) VALUES ($1, $2, 'ops1@example.test'), ($3, $4, 'ops2@example.test')`, [opId1, OP1, opId2, OP2]);
  pools = { core: db.pool("munim_core", 4), svc: db.pool("munim_svc", 2), platform: db.pool("munim_platform", 4) };
  const config = { nodeEnv: "test", redact: (s: string) => s };
  app = await createApp({ pools, idp, storefronts: storefrontResolver(pools.core), config, log: createLogger(config, () => {}) } as never);
  // A local fake of the tenancy seam (T-020): inserts the tenant row under tenancy.provision.v1.
  setProvisionTenant(async (tx, spec) => {
    await tx.query(`INSERT INTO core.tenant (tenant_id, name, country_code, base_currency, fy_start_month, is_demo, origin) VALUES ($1, $2, $3, 'AUD', 7, $4, '{}')`,
      [spec.tenant_id, spec.name, spec.country_code, spec.is_demo]);
    return { tenant_id: spec.tenant_id, outlet_ids: [], owner_member_id: spec.owner.member_id };
  });
});
afterAll(async () => {
  setProvisionTenant(null);
  await Promise.allSettled([pools.core.end(), pools.svc.end(), pools.platform.end()]);
  await db.stop();
});

describe("model roles change only through an approved config draft", () => {
  it("propose leaves the role untouched (proposed); approve applies it (applied) and audits it", async () => {
    expect(await roleRow("reason")).toEqual(SEEDED.reason);
    const p = await propose("model_role:reason", { provider: "openrouter", model_id: "meta/llama-3.3-70b-instruct" });
    expect(p.status).toBe(201);
    const d = await p.json();
    expect(d.status).toBe("proposed");
    expect(await roleRow("reason")).toEqual(SEEDED.reason); // pending: nothing applied
    // the operator's own command is its approval (R27): the proposer approves
    const a = await call("POST", `/platform/v1/config-drafts/${d.id}:approve`, OP1, {});
    expect(a.status).toBe(200);
    const ad = await a.json();
    expect(ad.status).toBe("applied");
    expect(ad.decided_by).toBe(opId1);
    expect(await roleRow("reason")).toEqual({ provider: "openrouter", model_id: "meta/llama-3.3-70b-instruct" });
    const audit = await db.admin(`SELECT action, actor, after FROM platform.platform_audit WHERE config_draft_id = $1 ORDER BY seq`, [d.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(["config_draft.propose", "config_draft.apply"]);
    expect(audit.rows[1]!.actor).toEqual({ kind: "operator", id: opId1 });
    expect(audit.rows[1]!.after).toMatchObject({ provider: "openrouter" });
    const list = await (await call("GET", "/platform/v1/model-roles", OP1)).json();
    expect(list.items.map((r: { role: string; model_id: string }) => [r.role, r.model_id])).toEqual([
      ["embed", "gemini-embedding-001"], ["extract", "gemini-3.5-flash-lite"], ["narrate", "gemini-3.5-flash-lite"],
      ["reason", "meta/llama-3.3-70b-instruct"], ["router", "gemini-3.5-flash-lite"], ["vision", "gemini-3.8-flash"],
    ]);
  });

  it("a second approve is refused (already_decided); reject by a second operator needs a reason and changes nothing", async () => {
    const d = await (await propose("model_role:router", { provider: "gemini", model_id: "gemini-3-flash" })).json();
    expect((await call("POST", `/platform/v1/config-drafts/${d.id}:reject`, OP2, {})).status).toBe(400);
    const r = await call("POST", `/platform/v1/config-drafts/${d.id}:reject`, OP2, { reason: "not now" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: "rejected", decided_by: opId2, reason: "not now" });
    expect(await roleRow("router")).toEqual(SEEDED.router);
    const again = await call("POST", `/platform/v1/config-drafts/${d.id}:approve`, OP1, {});
    expect(again.status).toBe(409);
    expect((await again.json()).error.code).toBe("already_decided");
    expect(await roleRow("router")).toEqual(SEEDED.router);
  });

  it("gemini-2.5 (any case, anywhere in the id) is refused with model_blocked and leaves no draft; gemini-3 is accepted", async () => {
    const before = await draftCount();
    for (const id of ["gemini-2.5-flash", "models/Gemini-2.5-pro", "google/GEMINI-2.5-flash-lite"]) {
      const r = await propose("model_role:narrate", { provider: "gemini", model_id: id });
      expect(r.status).toBe(422);
      expect((await r.json()).error).toMatchObject({ code: "invalid_payload", reason_code: "model_blocked" });
    }
    expect(await draftCount()).toBe(before);
    const ok = await propose("model_role:narrate", { provider: "gemini", model_id: "gemini-3-flash" });
    expect(ok.status).toBe(201);
    expect(await draftCount()).toBe(before + 1);
  });

  it("an unknown provider is refused and leaves no draft; nvidia is accepted", async () => {
    const before = await draftCount();
    for (const provider of ["mistral", "litellm", "Gemini", ""]) {
      const r = await propose("model_role:extract", { provider, model_id: "some-model" });
      expect(r.status).toBe(422);
      expect((await r.json()).error.code).toBe("invalid_payload");
    }
    expect((await propose("model_role:bogus", { provider: "gemini", model_id: "gemini-3-flash" })).status).toBe(422);
    expect(await draftCount()).toBe(before);
    const ok = await propose("model_role:extract", { provider: "nvidia", model_id: "meta/llama-3.3-70b-instruct" });
    expect(ok.status).toBe(201);
    expect(await draftCount()).toBe(before + 1);
  });

  it("a stored patch is re-validated at apply: a gemini-2.5 draft inserted behind the API cannot apply", async () => {
    const id = uuidv7();
    await db.admin(`INSERT INTO platform.config_draft (id, target, patch, proposed_by) VALUES ($1, 'model_role:vision', $2, 'probe')`,
      [id, JSON.stringify({ provider: "gemini", model_id: "gemini-2.5-flash" })]);
    const r = await call("POST", `/platform/v1/config-drafts/${id}:approve`, OP1, {});
    expect(r.status).toBe(422);
    expect(await roleRow("vision")).toEqual(SEEDED.vision);
    expect((await db.admin("SELECT status FROM platform.config_draft WHERE id = $1", [id])).rows[0]!.status).toBe("proposed");
  });

  it("proposing with a client draft_id is idempotent; the same id with another body is a 409", async () => {
    const id = uuidv7();
    const body = { draft_id: id, target: "model_role:embed", patch: { provider: "gemini", model_id: "gemini-embedding-001" } };
    const first = await call("POST", "/platform/v1/config-drafts", OP1, body);
    expect(first.status).toBe(201);
    const replay = await call("POST", "/platform/v1/config-drafts", OP1, body);
    expect(replay.status).toBe(200);
    expect((await replay.json()).id).toBe(id);
    const clash = await call("POST", "/platform/v1/config-drafts", OP1, { ...body, patch: { provider: "openai", model_id: "text-embedding-3-small" } });
    expect(clash.status).toBe(409);
    expect((await db.admin("SELECT count(*) AS n FROM platform.config_draft WHERE id = $1", [id])).rows[0]!.n).toBe("1");
  });
});

describe("other config targets", () => {
  it("kill switch: intel.enabled flips only on approve; a wrong-typed value is refused", async () => {
    expect((await propose("feature_flag:intel.enabled", { value: "no" })).status).toBe(201); // text is a valid proposal shape...
    const bad = await (await propose("feature_flag:intel.enabled", { value: "off" })).json();
    expect((await call("POST", `/platform/v1/config-drafts/${bad.id}:approve`, OP1, {})).status).toBe(422); // ...but not for a boolean flag
    expect((await db.admin("SELECT value FROM platform.feature_flag WHERE key = 'intel.enabled'")).rows[0]!.value).toBe(true);
    const d = await (await propose("feature_flag:intel.enabled", { value: false })).json();
    expect(d.before).toMatchObject({ key: "intel.enabled", value: true });
    expect((await db.admin("SELECT value FROM platform.feature_flag WHERE key = 'intel.enabled'")).rows[0]!.value).toBe(true);
    expect((await call("POST", `/platform/v1/config-drafts/${d.id}:approve`, OP2, {})).status).toBe(200);
    expect((await db.admin("SELECT value FROM platform.feature_flag WHERE key = 'intel.enabled'")).rows[0]!.value).toBe(false);
    const flags = await (await call("GET", "/platform/v1/feature-flags", OP1)).json();
    expect(flags.items).toEqual([expect.objectContaining({ key: "intel.enabled", value: false })]);
  });

  it("budget: limit applies on approve; spent comes from llm_budget_spent (15 minor of synthetic spend)", async () => {
    const patch = { month: "2026-10-01", limit_minor: 5000, currency: A.currency };
    const wrongCcy = await propose(`llm_budget:${A.tenant}`, { ...patch, currency: "USD" });
    const wd = await wrongCcy.json();
    expect((await call("POST", `/platform/v1/config-drafts/${wd.id}:approve`, OP1, {})).status).toBe(422); // currency_mismatch (R30)
    const d = await (await propose(`llm_budget:${A.tenant}`, patch)).json();
    expect((await call("POST", `/platform/v1/config-drafts/${d.id}:approve`, OP1, {})).status).toBe(200);
    const b = await (await call("GET", "/platform/v1/budgets", OP1)).json();
    expect(b.items).toEqual([{ tenant_id: A.tenant, month: "2026-10-01", limit_minor: 5000, currency: A.currency, spent_minor: 15 }]);
  });

  it("country pack: a new version needs a future start and the next version number; the schema is enforced", async () => {
    const packs = await (await call("GET", "/platform/v1/country-packs", OP1)).json();
    expect(packs.items.map((p: { code: string; version: number }) => `${p.code}${p.version}`).sort()).toEqual(["AU4", "IN4"]); // v4: the optional Cares block (ADR-015 §6)
    const cur = await (await call("GET", "/platform/v1/country-packs/IN/4", OP1)).json();
    expect(cur.doc.code).toBe("IN");
    const doc = { ...cur.doc, version: 5, effective_from: "2027-04-01" };
    expect((await propose("country_pack:IN", { effective_from: "2020-01-01", doc: { ...doc, effective_from: "2020-01-01" } })).status).toBe(422); // past
    expect((await propose("country_pack:IN", { effective_from: "2027-04-01", doc: { ...doc, currency: "x" } })).status).toBe(422); // schema
    const d = await (await propose("country_pack:IN", { effective_from: "2027-04-01", doc })).json();
    expect((await call("POST", `/platform/v1/config-drafts/${d.id}:approve`, OP1, {})).status).toBe(200);
    expect((await db.admin("SELECT version FROM platform.country_pack WHERE code = 'IN' ORDER BY version")).rows.map((r) => r.version)).toEqual([4, 5]);
    const skip = await (await propose("country_pack:IN", { effective_from: "2027-05-01", doc: { ...doc, version: 7, effective_from: "2027-05-01" } })).json();
    expect((await call("POST", `/platform/v1/config-drafts/${skip.id}:approve`, OP1, {})).status).toBe(409);
  });

  it("plans and operators list; a plan upserts through a draft", async () => {
    const d = await (await propose("plan:core", { name: "Core", limits: { outlets: 3 }, status: "active" })).json();
    await call("POST", `/platform/v1/config-drafts/${d.id}:approve`, OP1, {});
    expect((await (await call("GET", "/platform/v1/plans", OP1)).json()).items).toEqual([expect.objectContaining({ code: "core", limits: { outlets: 3 } })]);
    const ops = await (await call("GET", "/platform/v1/operators", OP1)).json();
    // + the world's operator: since 0028 it approves the world's Cares enablement draft (db/src/world.ts addCares).
    expect(ops.items.map((o: { email: string }) => o.email)).toEqual(["ops1@example.test", "ops2@example.test", "world-operator@example.test"]);
    expect(JSON.stringify(ops)).not.toContain("idp_sub");
  });

  it("the drafts list filters by status", async () => {
    const proposed = await (await call("GET", "/platform/v1/config-drafts", OP1)).json();
    const applied = await (await call("GET", "/platform/v1/config-drafts?status=applied", OP1)).json();
    expect(proposed.items.length).toBeGreaterThan(0);
    expect(applied.items.length).toBeGreaterThan(0);
    expect(proposed.items.every((x: { status: string }) => x.status === "proposed")).toBe(true);
    expect(applied.items.every((x: { status: string }) => x.status === "applied")).toBe(true);
    expect((await call("GET", "/platform/v1/config-drafts?status=bogus", OP1)).status).toBe(400);
  });
});

describe("tenants:provision", () => {
  const cmd = (tenant_id: string, key = `prov-${tenant_id}`) => ({
    command_id: uuidv7(), idempotency_key: key, type: "tenancy.provision.v1",
    payload: { tenant_id, name: "Synthetic Provisioned", country_code: "AU", is_demo: true, owner: { member_id: uuidv7(), name: "Owner", email: "owner@example.test" } },
  });
  it("the literal tenants:provision path runs the command as the operator and lists the tenant", async () => {
    expect(TenancyProvisionV1).toBeDefined();
    expect(TENANCY_ROUTES.some((r) => r.path === "/platform/v1/tenants:provision")).toBe(true);
    const tid = uuidv7();
    const c = cmd(tid);
    const r = await call("POST", "/platform/v1/tenants:provision", OP1, c);
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ type: "tenancy.provision.v1", entity_id: tid });
    const replay = await call("POST", "/platform/v1/tenants:provision", OP1, c);
    expect(replay.headers.get("X-Munim-Replayed")).toBe("true");
    const list = await (await call("GET", "/platform/v1/tenants", OP1)).json();
    expect(list.items.map((t: { tenant_id: string }) => t.tenant_id)).toContain(tid);
    const row = list.items.find((t: { tenant_id: string }) => t.tenant_id === tid);
    expect(row).toMatchObject({ name: "Synthetic Provisioned", country_code: "AU", is_demo: true });
    expect(Object.keys(row).sort()).toEqual(["base_currency", "country_code", "created_at", "is_demo", "name", "onboarded_at", "status", "tenant_id"]);
    const au = await db.admin("SELECT actor FROM core.audit_log WHERE tenant_id = $1", [tid]);
    expect(au.rows[0]!.actor).toMatchObject({ kind: "operator", id: opId1 });
  });
  it("same key + different body is a 409; an unpublished country pack is refused; a malformed envelope is 422 invalid_payload, a non-JSON body 400", async () => {
    const tid = uuidv7();
    expect((await call("POST", "/platform/v1/tenants:provision", OP1, cmd(tid, "same-key-1"))).status).toBe(201);
    const other = cmd(tid, "same-key-1");
    expect((await call("POST", "/platform/v1/tenants:provision", OP1, { ...other, payload: { ...other.payload, name: "Different" } })).status).toBe(409);
    const zz = cmd(uuidv7());
    expect((await call("POST", "/platform/v1/tenants:provision", OP1, { ...zz, payload: { ...zz.payload, country_code: "ZZ" } })).status).toBe(422);
    const bad = await call("POST", "/platform/v1/tenants:provision", OP1, { nope: 1 });
    expect(bad.status).toBe(422);
    expect((await bad.json()).error.code).toBe("invalid_payload");
    const notJson = await app.request("/platform/v1/tenants:provision", { method: "POST", headers: { Authorization: `Bearer ${idp.sign({ sub: OP1 })}`, "Content-Type": "application/json" }, body: "{" });
    expect(notJson.status).toBe(400);
  });
  // R3-m8: only "the tenancy module file is absent" maps to unavailable; anything else (a broken import inside it) is loud.
  it("isTenancyModuleAbsent: the module's own absence yes; a nested missing import, a package, a syntax error no", () => {
    const spec = "../modules/tenancy/index.ts";
    const missing = (target: string) => Object.assign(new Error(`Cannot find module '${target}' imported from /x/provision.ts`), { code: "ERR_MODULE_NOT_FOUND" });
    expect(isTenancyModuleAbsent(missing("/repo/services/core-api/src/modules/tenancy/index.ts"), spec)).toBe(true);
    expect(isTenancyModuleAbsent(missing("/repo/services/core-api/src/modules/tenancy/commands.ts"), spec)).toBe(false);
    expect(isTenancyModuleAbsent(Object.assign(new Error("Cannot find package 'zod' imported from /x"), { code: "ERR_MODULE_NOT_FOUND" }), spec)).toBe(false);
    expect(isTenancyModuleAbsent(new SyntaxError("Unexpected token"), spec)).toBe(false);
    expect(isTenancyModuleAbsent(null, spec)).toBe(false);
  });
});

describe("operator snapshots (R40 C4)", () => {
  beforeAll(async () => {
    await db.admin(
      `INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES
       ('platform.tenant_outlets', 1, 'SELECT count(*)::bigint AS outlets FROM core.outlet WHERE tenant_id = :tenant_id::uuid',
        '{"type":"object"}', '[{"name":"outlets","type":"integer","numeric_source":"count:core.outlet"}]', 'operator')`);
  });
  it("mints an operator-level template with minted_by_operator_id; refuses a tenant-level one", async () => {
    const r = await call("POST", "/platform/v1/snapshots", OP1, { tenant_id: A.tenant, template_id: "platform.tenant_outlets", params: {} });
    expect(r.status).toBe(201);
    const s = await r.json();
    Snapshot.parse(s); // R3-M5: the published `snapshot` schema accepts the real response
    expect(s).toMatchObject({ minted_by_operator_id: opId1, run_id: null, minted_by_member_id: null, row_count: 1, rows: [{ outlets: 3 }] });
    const stored = await db.admin("SELECT minted_by_operator_id, rows FROM evidence.snapshot WHERE tenant_id = $1 AND id = $2", [A.tenant, s.snapshot_id]);
    expect(stored.rows[0]).toMatchObject({ minted_by_operator_id: opId1, rows: [{ outlets: 3 }] });
    const refused = await call("POST", "/platform/v1/snapshots", OP1, { tenant_id: A.tenant, template_id: "inventory.below_reorder", params: {} });
    expect(refused.status).toBe(404);
    expect((await call("POST", "/platform/v1/snapshots", OP1, { tenant_id: uuidv7(), template_id: "platform.tenant_outlets", params: {} })).status).toBe(404);
  });
  it("refuses the network impact template (ADR-015 §2.3: minted only into platform.network_snapshot) — 404, no tenant snapshot row", async () => {
    const count = async () => Number((await db.admin("SELECT count(*) AS n FROM evidence.snapshot WHERE tenant_id = $1 AND template_id = 'platform.cares_network_impact'", [A.tenant])).rows[0]!.n);
    const before = await count();
    const r = await call("POST", "/platform/v1/snapshots", OP1,
      { tenant_id: A.tenant, template_id: "platform.cares_network_impact", params: { from: "2026-10-01", to: "2026-10-31", city_code: null } });
    expect(r.status).toBe(404);
    expect(await count()).toBe(before);
    expect(before).toBe(0);
  });
});

describe("access", () => {
  const concrete = (p: string) => p.replace("{id}", uuidv7()).replace("{code}", "IN").replace("{version}", "1");
  it("every platform route is 404 for a member token (and for an unknown subject), 401 without a token", async () => {
    const routes = [...ROUTES, ...TENANCY_ROUTES.filter((r) => r.path.startsWith("/platform/"))];
    expect(routes.length).toBeGreaterThanOrEqual(13); // positive: the loop below really covers the surface
    for (const r of routes) {
      const path = concrete(r.path);
      const body = r.method === "post" ? {} : undefined;
      for (const sub of [A.ownerSub, "nobody-at-all"]) {
        const res = await call(r.method.toUpperCase(), path, sub, body, { [TENANT_HEADER]: A.tenant });
        expect(res.status, `${r.method} ${path} as ${sub}`).toBe(404);
      }
      expect((await call(r.method.toUpperCase(), path, null, body)).status, `${r.method} ${path} anon`).toBe(401);
    }
    // a deactivated operator is also a 404
    await db.admin("UPDATE platform.operator SET active = false WHERE id = $1", [opId2]);
    expect((await call("GET", "/platform/v1/operators", OP2)).status).toBe(404);
    await db.admin("UPDATE platform.operator SET active = true WHERE id = $1", [opId2]);
    expect((await call("GET", "/platform/v1/operators", OP2)).status).toBe(200);
  });

  it("probe: the operator database role cannot read a tenant's books, and no platform response carries them", async () => {
    for (const t of ["core.\"order\"", "core.journal_entry", "core.member", "core.outlet", "core.customer", "evidence.snapshot"]) {
      const c = await db.connect("munim_platform");
      try {
        await expect(c.query(`SELECT 1 FROM ${t} LIMIT 1`), t).rejects.toMatchObject({ code: "42501" });
      } finally {
        await c.end();
      }
    }
    // positive control: the data exists and the books are readable under the tenant's own role
    const own = await db.admin(`SELECT count(*)::int AS n FROM core."order" WHERE tenant_id = $1`, [A.tenant]);
    expect(own.rows[0]!.n).toBeGreaterThan(0);
    const secrets = [...A.orders, A.owner, ...A.outlets, A.ownerSub, "owner@example.test"];
    const bodies: string[] = [];
    for (const p of ["tenants", "country-packs", "plans", "feature-flags", "budgets", "model-roles", "operators", "config-drafts?status=all"]) {
      bodies.push(await (await call("GET", `/platform/v1/${p}`, OP1)).text());
    }
    for (const b of bodies) for (const s of secrets) expect(b).not.toContain(s);
    // the only tenant fact is the registry row: name/country/status
    expect(bodies[0]).toContain("Synthetic Tenant");
  });
});

// R47 D1: the operator sets per-role prices through the same approved draft (R24); core serves them to intel.
describe("model-role prices (R47 D1)", () => {
  const priced = (extra: Record<string, unknown> = {}) => ({ provider: "gemini", model_id: "gemini-3.8-flash", input_price_per_mtok_minor: 1500, output_price_per_mtok_minor: 6000, price_currency: "INR", ...extra });
  const priceRow = async (role: string) =>
    (await db.admin(`SELECT input_price_per_mtok_minor::int AS i, output_price_per_mtok_minor::int AS o, price_currency AS c, probed_at IS NOT NULL AS probed FROM platform.model_role WHERE role = $1`, [role])).rows[0];
  const approveNew = async (target: string, patch: unknown) => {
    const p = await propose(target, patch);
    expect(p.status).toBe(201);
    const a = await call("POST", `/platform/v1/config-drafts/${(await p.json()).id}:approve`, OP1, {});
    expect(a.status).toBe(200);
  };

  it("refusals leave no draft: one or two of the three, a negative, a fraction, a lower-case currency, an unknown key", async () => {
    const before = await draftCount();
    for (const patch of [
      { provider: "gemini", model_id: "gemini-3.8-flash", input_price_per_mtok_minor: 1500 },
      { provider: "gemini", model_id: "gemini-3.8-flash", input_price_per_mtok_minor: 1500, output_price_per_mtok_minor: 6000 },
      priced({ input_price_per_mtok_minor: -1 }),
      priced({ output_price_per_mtok_minor: -1 }),
      priced({ output_price_per_mtok_minor: 1.5 }),
      priced({ price_currency: "inr" }),
      priced({ price_per_token: 1 }),
    ]) {
      const r = await propose("model_role:vision", patch);
      expect([r.status, (await r.json()).error.code]).toEqual([422, "invalid_payload"]);
    }
    expect(await draftCount()).toBe(before);
  });

  it("accept: the prices apply on approve, are audited before and after, and ride with the platform and the internal read", async () => {
    expect(await priceRow("vision")).toEqual({ i: null, o: null, c: null, probed: false });
    const p = await propose("model_role:vision", priced());
    expect(p.status).toBe(201);
    const d = await p.json();
    expect(await priceRow("vision")).toEqual({ i: null, o: null, c: null, probed: false }); // pending: nothing applied
    expect((await call("POST", `/platform/v1/config-drafts/${d.id}:approve`, OP1, {})).status).toBe(200);
    expect(await priceRow("vision")).toEqual({ i: 1500, o: 6000, c: "INR", probed: false });
    const audit = (await db.admin(`SELECT before, after FROM platform.platform_audit WHERE config_draft_id = $1 AND action = 'config_draft.apply'`, [d.id])).rows[0]!;
    expect(audit.before).toMatchObject({ input_price_per_mtok_minor: null, price_currency: null });
    expect(audit.after).toMatchObject({ input_price_per_mtok_minor: 1500, output_price_per_mtok_minor: 6000, price_currency: "INR" });
    const list = SCHEMAS["platform.model-roles"].parse(await (await call("GET", "/platform/v1/model-roles", OP1)).json());
    expect(list.items.find((r) => r.role === "vision")).toMatchObject({ input_price_per_mtok_minor: 1500, output_price_per_mtok_minor: 6000, price_currency: "INR" });
    expect(list.items.find((r) => r.role === "embed")).toMatchObject({ input_price_per_mtok_minor: null, output_price_per_mtok_minor: null, price_currency: null });
  });

  it("a price-only change keeps the probe; a model change resets it and, with no prices given, clears them (an unpriced new model)", async () => {
    await db.admin(`UPDATE platform.model_role SET probed_at = now() WHERE role = 'vision'`);
    await approveNew("model_role:vision", priced({ input_price_per_mtok_minor: 2000 }));
    expect(await priceRow("vision")).toEqual({ i: 2000, o: 6000, c: "INR", probed: true });
    await approveNew("model_role:vision", { provider: "gemini", model_id: "gemini-3.5-flash-lite" });
    expect(await priceRow("vision")).toEqual({ i: null, o: null, c: null, probed: false });
  });
});

// R3-M5: every platform read and the draft views parse with their published (strict) schemas, each with rows to prove it.
describe("platform responses parse with the published contracts", () => {
  it.each([
    ["/platform/v1/tenants", "platform.tenants"],
    ["/platform/v1/country-packs", "platform.country-packs"],
    ["/platform/v1/plans", "platform.plans"],
    ["/platform/v1/feature-flags", "platform.feature-flags"],
    ["/platform/v1/budgets", "platform.budgets"],
    ["/platform/v1/model-roles", "platform.model-roles"],
    ["/platform/v1/operators", "platform.operators"],
    ["/platform/v1/config-drafts?status=all", "platform.config-drafts"],
  ] as const)("%s", async (path, schema) => {
    const r = await call("GET", path, OP1);
    expect(r.status).toBe(200);
    const body = SCHEMAS[schema].parse(await r.json());
    expect(body.items.length).toBeGreaterThan(0);
  });
  it("a config draft and a country-pack detail", async () => {
    const created = await propose("model_role:vision", { provider: "gemini", model_id: "gemini-3-flash" });
    expect(created.status).toBe(201);
    const d = SCHEMAS["platform.config-draft"].parse(await created.json());
    expect(SCHEMAS["platform.config-draft"].parse(await (await call("GET", `/platform/v1/config-drafts/${d.id}`, OP1)).json()).id).toBe(d.id);
    const packs = SCHEMAS["platform.country-packs"].parse(await (await call("GET", "/platform/v1/country-packs", OP1)).json()).items;
    const p = packs[0]!;
    const detail = await call("GET", `/platform/v1/country-packs/${p.code}/${p.version}`, OP1);
    expect(detail.status).toBe(200);
    expect(SCHEMAS["platform.country-pack-detail"].parse(await detail.json()).code).toBe(p.code);
  });
});
