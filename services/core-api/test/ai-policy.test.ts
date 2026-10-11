// T-090 gates — AI policy (ledger F10 "who", F11 O-2) through the real app on embedded Postgres. Expected values are
// hand-written here (the ledger's F10 list + R47 D10's rows; hand-picked money), never imported from the module.
// Synthetic data only; the operator budget and spend rows are planted as the operator / intel spend log would hold them.
// The canonical world (db/src/world.ts, 0020) seeds: owner ceiling auto (a row), cap 500000 INR, operator limit 500000 INR
// for 2026-10, and 15 of model spend on 2026-10-09. A bare provisioned tenant (no seeds) stands for a new business.
import { CommandResult, ErrorResponse, REPLAYED_HEADER } from "@munim/contracts";
import { AiPolicyResponse } from "@munim/contracts/ai_policy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeCommand, uuidv7, verifyAuditChain } from "../src/commit/index.ts";
import { provisionTenant, svcTx, type Tenant } from "../src/commit/testkit.ts";
import { withContext } from "../src/lib/db.ts";
import { ApiError } from "../src/lib/errors.ts";
import { assertModeAllowed, ceilingFor, effectiveCap, handlers } from "../src/modules/ai_policy/index.ts";
import { policy } from "../src/modules/ai_policy/policy.ts";
import { type Env, startEnv, type Who } from "./compliance.kit.ts";

// Hand list: F10 (owner auto, manager plan, staff step) + R47 D10 (advisor step, judge plan).
const DEFAULTS = [
  { role: "owner", mode_ceiling: "auto" },
  { role: "manager", mode_ceiling: "plan" },
  { role: "staff", mode_ceiling: "step" },
  { role: "advisor", mode_ceiling: "step" },
  { role: "judge", mode_ceiling: "plan" },
] as const;
const MONTH = `${new Date().toISOString().slice(0, 7)}-01`; // the current UTC month: the operator budget's basis
const WORLD_SPEND = MONTH === "2026-10-01" ? 15 : 0; // the world's one spend row is dated 2026-10-09

let e: Env;
let bare: Tenant;
let judge: string;
let seededOwnerRow: string;
beforeAll(async () => {
  e = await startEnv("IN");
  bare = await provisionTenant(e.db);
  seededOwnerRow = (await e.one<{ id: string }>(`SELECT id::text FROM core.ai_policy WHERE tenant_id = $1 AND role = 'owner'`, [e.w.tenant])).id;
  judge = uuidv7();
  await e.db.withContext("munim_core", { tenant_id: e.w.tenant, outlet_ids: "*", role: "owner", member_id: e.w.owner, command_type: "tenancy.member.invite.v1" }, async (c) => {
    await c.query(`INSERT INTO core.member (tenant_id, id, name, email) VALUES ($1, $2, 'Synthetic judge', 'judge@example.test')`, [e.w.tenant, judge]);
    await c.query(`INSERT INTO core.membership (tenant_id, member_id, role) VALUES ($1, $2, 'judge')`, [e.w.tenant, judge]);
  });
});
afterAll(() => e?.stop());

const roleOf: Record<Who, "owner" | "staff" | "manager"> = { owner: "owner", staff: "staff", mgr1: "manager", mgr2: "manager" };
const ctx = (who: Who) => ({ tenant_id: e.w.tenant, outlet_ids: who === "owner" ? "*" as const : [e.w.outlets[who === "mgr2" ? 1 : 0]!], role: roleOf[who], member_id: e.ids[who] });
/** The member's ceiling verdict for `mode`: "ok" or the refusal's [status, code, reason_code]. */
const verdict = (who: Who, mode: "step" | "plan" | "auto") =>
  withContext(e.pools.core, ctx(who), (q) => assertModeAllowed(q, { role: roleOf[who] }, mode)).then(() => "ok", (err: unknown) =>
    err instanceof ApiError ? [err.status, err.code, err.reason_code] : err);
const getPolicy = async (who: Who) => {
  const r = await e.call("GET", "/v1/ai/policy", who);
  expect(r.status).toBe(200);
  return AiPolicyResponse.parse(await r.json());
};
const setBudget = (limit: number, currency = "INR", tenant = e.w.tenant) =>
  e.db.admin(`INSERT INTO platform.llm_budget (tenant_id, month, limit_minor, currency) VALUES ($1, $2, $3, $4)
              ON CONFLICT (tenant_id, month) DO UPDATE SET limit_minor = EXCLUDED.limit_minor, currency = EXCLUDED.currency`, [tenant, MONTH, limit, currency]);
const cap = (who: Who, monthly_cap_minor: number) => e.cmd("/v1/ai/policy/cap", who, "ai_policy.cap.set.v1", { monthly_cap_minor });
const capRow = () => e.db.admin<{ monthly_cap_minor: string }>(`SELECT monthly_cap_minor::text FROM core.ai_budget_cap WHERE tenant_id = $1`, [e.w.tenant]).then((r) => r.rows.map((x) => x.monthly_cap_minor));
const audits = (entity: string, tenant = e.w.tenant) => e.count(`SELECT count(*) n FROM core.audit_log WHERE tenant_id = $1 AND entity = $2`, [tenant, entity]);
const policyRows = (tenant = e.w.tenant) => e.count(`SELECT count(*) n FROM core.ai_policy WHERE tenant_id = $1`, [tenant]);
const bareCtx = () => ({ tenant_id: bare.tenant, outlet_ids: "*" as const, role: "owner" as const, member_id: bare.owner });
/** The bare tenant owner's own cap command, straight through executeCommand (no IdP login on that tenant). */
const bareCap = (monthly_cap_minor: number) =>
  executeCommand({ tx: (fn) => withContext(e.pools.core, bareCtx(), fn), tenantId: bare.tenant, actor: { kind: "member", id: bare.owner, role: "owner" } },
    { command_id: uuidv7(), idempotency_key: `k-${uuidv7()}`, type: "ai_policy.cap.set.v1", payload: { monthly_cap_minor } }, handlers.capSet)
    .then(() => "ok", (err: unknown) => (err instanceof ApiError ? [err.status, err.reason_code] : err));

describe("gate 1: a new tenant's policy is the code defaults (no rows, no backfill)", () => {
  it("a just-provisioned tenant: 0 policy rows; the five hand-listed ceilings, all `default`; no cap", async () => {
    expect(await policyRows(bare.tenant)).toBe(0);
    const p = AiPolicyResponse.parse(await withContext(e.pools.core, bareCtx(), policy));
    expect(p).toEqual({ ceilings: DEFAULTS.map((d) => ({ ...d, source: "default" })), cap: null });
    const each = await withContext(e.pools.core, bareCtx(), async (q) => Promise.all(DEFAULTS.map((d) => ceilingFor(q, d.role))));
    expect(each).toEqual(DEFAULTS.map((d) => d.mode_ceiling));
  });
  it("GET /v1/ai/policy on the world (owner row seeded) for owner, manager and staff: the same values, owner `set`, the cap row", async () => {
    for (const who of ["owner", "mgr1", "staff"] as const) {
      const p = await getPolicy(who);
      expect(p.ceilings).toEqual(DEFAULTS.map((d) => ({ ...d, source: d.role === "owner" ? "set" : "default" })));
      expect(p.cap).toEqual({ monthly_cap_minor: 500000, currency: "INR" });
    }
  });
});

describe("gate 2: assertModeAllowed — a mode above the role's ceiling is 403 mode_above_ceiling", () => {
  it("staff Plan → 403; manager Plan → ok; manager Auto → 403; owner Auto → ok (4/4)", async () => {
    const refused = [403, "forbidden", "mode_above_ceiling"];
    expect(await verdict("staff", "plan")).toEqual(refused);
    expect(await verdict("mgr1", "plan")).toBe("ok");
    expect(await verdict("mgr1", "auto")).toEqual(refused);
    expect(await verdict("owner", "auto")).toBe("ok");
    expect(await verdict("staff", "step")).toBe("ok");
  });
  it("the refusal body carries the reason's own copy, not the generic forbidden text", () => {
    const b = ErrorResponse.parse(new ApiError("forbidden", "mode_above_ceiling").body());
    expect(b.error.message).toBe("Your role cannot use this investigation mode. The owner sets the highest mode for each role.");
  });
});

describe("gate 3: only the owner's own command changes a ceiling", () => {
  it("a manager → 403 book_write_refused (MB001), 0 rows; a judge (owner-rank elsewhere) → MB001", async () => {
    const m = await e.cmd("/v1/ai/policy/ceiling", "mgr1", "ai_policy.ceiling.set.v1", { role: "manager", mode_ceiling: "auto" });
    expect([m.status, ErrorResponse.parse(await m.json()).error]).toEqual([403, expect.objectContaining({ code: "book_write_refused", reason_code: "authority_denied" })]);
    const s = await e.cmd("/v1/ai/policy/ceiling", "staff", "ai_policy.ceiling.set.v1", { role: "staff", mode_ceiling: "plan" });
    expect(s.status).toBe(403);
    const jctx = { tenant_id: e.w.tenant, outlet_ids: "*" as const, role: "judge" as const, member_id: judge };
    const j = await executeCommand({ tx: (fn) => withContext(e.pools.core, jctx, fn), tenantId: e.w.tenant, actor: { kind: "member", id: judge, role: "judge" } },
      { command_id: uuidv7(), idempotency_key: `k-${uuidv7()}`, type: "ai_policy.ceiling.set.v1", payload: { role: "judge", mode_ceiling: "auto" } }, handlers.ceilingSet)
      .then(() => "ok", (err: { code?: string }) => err.code);
    expect(j).toBe("MB001");
    expect(await policyRows()).toBe(1); // the seeded owner row only
  });
  it("the owner sets manager → step: 1 row + 1 audit; the row beats the default (manager Plan now 403); a second set updates it", async () => {
    const before = await audits("core.ai_policy");
    const r = await e.cmd("/v1/ai/policy/ceiling", "owner", "ai_policy.ceiling.set.v1", { role: "manager", mode_ceiling: "step" });
    expect(r.status).toBe(200);
    expect(CommandResult.parse(await r.json())).toMatchObject({ type: "ai_policy.ceiling.set.v1" });
    expect(await policyRows()).toBe(2);
    expect(await audits("core.ai_policy")).toBe(before + 1);
    expect(await verdict("mgr1", "plan")).toEqual([403, "forbidden", "mode_above_ceiling"]);
    const p = await getPolicy("mgr1");
    expect(p.ceilings[1]).toEqual({ role: "manager", mode_ceiling: "step", source: "set" });
    expect(p.ceilings.filter((c) => c.source === "set").map((c) => c.role)).toEqual(["owner", "manager"]);
    // Raise it again: the same row (1), a second audit entry, manager Plan allowed again.
    expect((await e.cmd("/v1/ai/policy/ceiling", "owner", "ai_policy.ceiling.set.v1", { role: "manager", mode_ceiling: "plan" })).status).toBe(200);
    expect(await policyRows()).toBe(2);
    expect(await audits("core.ai_policy")).toBe(before + 2);
    expect(await verdict("mgr1", "plan")).toBe("ok");
  });
});

describe("idempotency: the same command twice is one change", () => {
  it("a byte-identical replay (X-Munim-Replayed), +1 audit not +2; the same key with another payload → 409, value unchanged", async () => {
    const before = await audits("core.ai_policy");
    const env = { command_id: uuidv7(), idempotency_key: `k-${uuidv7()}`, type: "ai_policy.ceiling.set.v1", payload: { role: "manager", mode_ceiling: "plan" } };
    const a = await e.call("POST", "/v1/ai/policy/ceiling", "owner", env);
    const b = await e.call("POST", "/v1/ai/policy/ceiling", "owner", env);
    const [ta, tb] = [await a.text(), await b.text()];
    expect([a.status, b.status, a.headers.get(REPLAYED_HEADER), b.headers.get(REPLAYED_HEADER)]).toEqual([200, 200, null, "true"]);
    expect(tb).toBe(ta);
    expect(await audits("core.ai_policy")).toBe(before + 1);
    const c = await e.call("POST", "/v1/ai/policy/ceiling", "owner", { ...env, payload: { role: "manager", mode_ceiling: "auto" } });
    expect([c.status, ErrorResponse.parse(await c.json()).error.code]).toEqual([409, "idempotency_conflict"]);
    expect(await e.one(`SELECT mode_ceiling FROM core.ai_policy WHERE tenant_id = $1 AND role = 'manager'`, [e.w.tenant])).toEqual({ mode_ceiling: "plan" });
    expect(await audits("core.ai_policy")).toBe(before + 1);
  });
});

describe("gate 4: the owner's cap — never above the operator's limit for the month (F11 O-2)", () => {
  it("a new tenant with no operator budget this month → 422 platform_budget_missing, 0 rows", async () => {
    expect(await bareCap(100000)).toEqual([422, "platform_budget_missing"]);
    expect(await e.count(`SELECT count(*) n FROM core.ai_budget_cap WHERE tenant_id = $1`, [bare.tenant])).toBe(0);
  });
  it("a new tenant, limit 250000: 250001 → 422 cap_above_platform_budget, 0 rows; exactly 250000 → ok, 1 row in INR, 1 audit", async () => {
    await setBudget(250000, "INR", bare.tenant);
    expect(await bareCap(250001)).toEqual([422, "cap_above_platform_budget"]);
    expect(await e.count(`SELECT count(*) n FROM core.ai_budget_cap WHERE tenant_id = $1`, [bare.tenant])).toBe(0);
    expect(await audits("core.ai_budget_cap", bare.tenant)).toBe(0);
    expect(await bareCap(250000)).toBe("ok");
    expect(await e.one(`SELECT monthly_cap_minor::text, currency FROM core.ai_budget_cap WHERE tenant_id = $1`, [bare.tenant])).toEqual({ monthly_cap_minor: "250000", currency: "INR" });
    expect(await audits("core.ai_budget_cap", bare.tenant)).toBe(1);
  });
  it("the world, limit raised to 800000: 800001 → 422 over HTTP (no amount in the body), unchanged; exactly 800000 → 200, 1 audit", async () => {
    await setBudget(800000);
    const over = await cap("owner", 800001);
    const body = await over.text();
    expect([over.status, ErrorResponse.parse(JSON.parse(body)).error.code, JSON.parse(body).error.reason_code]).toEqual([422, "invalid_payload", "cap_above_platform_budget"]);
    expect(JSON.parse(body).error.message).toBe("The monthly AI cap cannot be above the platform's AI budget for this month.");
    expect(body).not.toMatch(/[0-9]/);
    expect(await capRow()).toEqual(["500000"]);
    expect(await audits("core.ai_budget_cap")).toBe(0);
    expect((await cap("owner", 800000)).status).toBe(200);
    expect(await capRow()).toEqual(["800000"]);
    expect(await audits("core.ai_budget_cap")).toBe(1);
  });
  it("a manager → 403 and the cap is unchanged; the owner lowers it to 500000 → 200, the same row, a second audit", async () => {
    const m = await cap("mgr1", 100);
    expect([m.status, (await m.json()).error.code]).toEqual([403, "book_write_refused"]);
    expect(await capRow()).toEqual(["800000"]);
    expect((await cap("owner", 500000)).status).toBe(200);
    expect(await capRow()).toEqual(["500000"]);
    expect(await audits("core.ai_budget_cap")).toBe(2);
    expect((await getPolicy("mgr1")).cap).toEqual({ monthly_cap_minor: 500000, currency: "INR" });
  });
  it("an operator budget in another currency → 422 platform_budget_missing (the owner cap could not apply)", async () => {
    await setBudget(800000, "USD");
    const r = await cap("owner", 100);
    expect([r.status, (await r.json()).error.reason_code]).toEqual([422, "platform_budget_missing"]);
    expect(await capRow()).toEqual(["500000"]);
    await setBudget(800000, "INR");
  });
});

describe("gate 5: effectiveCap = the lower of the owner's cap and the operator's limit (hand values, both orders)", () => {
  const read = (pool: "core" | "svc", tenant = e.w.tenant, month?: string) =>
    withContext(e.pools[pool], pool === "core" ? { tenant_id: tenant, outlet_ids: "*", role: "owner", member_id: e.w.owner } : { tenant_id: tenant, outlet_ids: "*", role: "service" },
      (q) => effectiveCap(q, month));

  it("cap 500000 < limit 800000 → 500000; the operator lowers the limit to 300000 → 300000 (cap now above it)", async () => {
    expect(await read("core")).toEqual({ month: MONTH, currency: "INR", owner_cap_minor: 500000, operator_limit_minor: 800000, effective_cap_minor: 500000,
      spent_minor: WORLD_SPEND, left_minor: 500000 - WORLD_SPEND });
    await setBudget(300000);
    expect(await read("svc")).toMatchObject({ owner_cap_minor: 500000, operator_limit_minor: 300000, effective_cap_minor: 300000, left_minor: 300000 - WORLD_SPEND });
  });
  it("spend at the cap → left 0 (never a refusal); the month may be given as YYYY-MM", async () => {
    await e.db.withContext("munim_svc", { tenant_id: e.w.tenant, outlet_ids: "*", role: "service" }, async (c) => {
      const run = uuidv7();
      await c.query(`INSERT INTO intel.run (tenant_id, id, trigger, actor, outlet_scope, expires_at) VALUES ($1, $2, 'event', 'watcher:events', '{*}', now() + interval '1 hour')`, [e.w.tenant, run]);
      await c.query(`INSERT INTO intel.intel_spend (tenant_id, id, run_id, role, provider, model_id, input_tokens, output_tokens, amount_minor, currency)
                     VALUES ($1, $2, $3, 'narrate', 'gemini', 'synthetic-model', 10, 10, $4, 'INR')`, [e.w.tenant, uuidv7(), run, 300000 - WORLD_SPEND]);
    });
    expect(await read("svc", e.w.tenant, MONTH.slice(0, 7))).toMatchObject({ effective_cap_minor: 300000, spent_minor: 300000, left_minor: 0 });
  });
  it("a tenant with no budget → null; budget 250000 and no cap → 250000; budget in USD with an INR cap → the cap does not apply", async () => {
    const t = await provisionTenant(e.db);
    const other = (pool: "core" | "svc") =>
      withContext(e.pools[pool], pool === "core" ? { tenant_id: t.tenant, outlet_ids: "*", role: "owner", member_id: t.owner } : { tenant_id: t.tenant, outlet_ids: "*", role: "service" }, (q) => effectiveCap(q));
    expect(await other("svc")).toBeNull();
    await setBudget(250000, "INR", t.tenant);
    expect(await other("core")).toMatchObject({ owner_cap_minor: null, operator_limit_minor: 250000, effective_cap_minor: 250000, left_minor: 250000 });
    // This tenant (cap 500000 INR) with the operator budget switched to USD: effective = the USD limit alone.
    await setBudget(900000, "USD");
    expect(await read("svc")).toMatchObject({ currency: "USD", owner_cap_minor: null, effective_cap_minor: 900000 });
    await setBudget(300000, "INR");
  });
  it("a malformed month is a programming error, not a silent empty budget", async () => {
    await expect(read("svc", e.w.tenant, "October")).rejects.toThrow(/not YYYY-MM/);
  });
});

describe("One Guarantee clause 1 over the AI policy books (runs last)", () => {
  it("every row is its tenant owner's own command; every value this suite set has its owner-attributed audit entry; the audit chains verify", async () => {
    const rows = (await e.db.admin<{ tenant: string; tbl: string; id: string; origin: { kind: string; command_type?: string; principal_id?: string; role?: string }; val: string }>(
      `SELECT tenant_id::text AS tenant, 'core.ai_policy' AS tbl, id::text, origin, mode_ceiling AS val FROM core.ai_policy WHERE tenant_id = ANY ($1::uuid[])
       UNION ALL SELECT tenant_id::text, 'core.ai_budget_cap', id::text, origin, monthly_cap_minor::text FROM core.ai_budget_cap WHERE tenant_id = ANY ($1::uuid[])`,
      [[e.w.tenant, bare.tenant]])).rows;
    // by hand: world — seeded owner ceiling, manager ceiling (gate 3), cap (seeded, then set twice); bare — its cap (gate 4)
    expect(rows).toHaveLength(4);
    const ownerOf: Record<string, string> = { [e.w.tenant]: e.w.owner, [bare.tenant]: bare.owner };
    const bad: string[] = [];
    for (const r of rows) {
      if (r.origin.kind !== "command" || !r.origin.command_type?.startsWith("ai_policy.") || r.origin.principal_id !== ownerOf[r.tenant] || r.origin.role !== "owner") bad.push(`${r.tbl}:${r.id} origin`);
      if (r.id === seededOwnerRow) continue; // the world builder's raw fixture insert (no command_log / audit)
      // Gotcha 34: UPDATEs keep the creation origin, so the current value must trace through the audit log.
      const key = r.tbl === "core.ai_policy" ? "mode_ceiling" : "monthly_cap_minor";
      const hit = await e.count(
        `SELECT count(*) n FROM core.audit_log WHERE tenant_id = $1 AND entity = $2 AND entity_id = $3 AND after ->> $4 = $5 AND actor ->> 'id' = $6 AND actor ->> 'role' = 'owner'`,
        [r.tenant, r.tbl, r.id, key, r.val, ownerOf[r.tenant]]);
      if (hit < 1) bad.push(`${r.tbl}:${r.id} unaudited value`);
    }
    expect(bad).toEqual([]);
    for (const t of [e.w.tenant, bare.tenant]) {
      const v = await verifyAuditChain(svcTx(e.db), t);
      expect([v.ok, v.firstBadSeq]).toEqual([true, null]);
    }
  });
});
