// T-127 gates — POST /v1/finance/budgets (finance.budget.set.v1) through the real app: the owner sets a month's budget for one
// spending category, for one outlet or the whole business. The deal review reads the purchases one (purchasing.deal_inputs
// budget_left_minor: category purchases, the month, the outlet or the whole business); with none it is budget_missing.
//   (1) the owner sets this month's purchases budget for the whole business: 201 command result; one core.budget row exactly as
//       sent, its origin the owner's own command; one audit entry under her; the tenant's audit chain verifies;
//   (2) idempotency: the same key replays the stored bytes (X-Munim-Replayed) and writes nothing more;
//   (3) set again under a new key: the same row's amount changes (one budget per outlet, category and month), one audit entry with
//       before and after; another outlet or another category is another row;
//   (4) roles: the row lists owner and judge only — a manager (for her own outlet) and staff are refused 403 authority_denied
//       (the book guard), and nothing is written;
//   (5) the payload: a day that is not the first of a month → 422; a currency other than the business's → currency_mismatch, on a
//       new row (the table's trigger) and on an existing one (the handler), and the existing amount is kept.
// Expected values are typed by hand here (the payloads below and the canonical world: INR, owner, staff, three outlets).
import { createLogger } from "@munim/config";
import { CommandResult, REPLAYED_HEADER } from "@munim/contracts";
import { buildWorld, type TestDb } from "@munim/db";
import type { Hono } from "hono";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalIdp } from "../src/auth/local-idp.ts";
import { type AppEnv, createApp, TENANT_HEADER } from "../src/app.ts";
import { uuidv7, verifyAuditChain } from "../src/commit/index.ts";
import { svcTx } from "../src/commit/testkit.ts";
import type { Deps } from "../src/lib/types.ts";
import { openDb } from "./db.ts";

const idp = createLocalIdp();
let db: TestDb;
let pools: { core: pg.Pool; svc: pg.Pool };
let app: Hono<AppEnv>;

const T = {
  tenant: "", owner: "", staff: "", outlets: ["", "", ""] as [string, string, string], manager: uuidv7(),
  subs: { owner: `owner-${uuidv7()}`, staff: `staff-${uuidv7()}`, manager: `manager-${uuidv7()}` },
};
type Who = keyof typeof T.subs;
const MONTH = "2026-11-01";

type Res = Omit<Response, "json"> & { json(): Promise<any> };
const post = async (who: Who, payload: unknown, key = `budget-${uuidv7()}`, command_id = uuidv7()): Promise<Res> =>
  (await app.request("/v1/finance/budgets", {
    method: "POST",
    headers: { Authorization: `Bearer ${idp.sign({ sub: T.subs[who] })}`, [TENANT_HEADER]: T.tenant, "Content-Type": "application/json" },
    body: JSON.stringify({ command_id, idempotency_key: key, type: "finance.budget.set.v1", payload }),
  })) as Res;
const budget = (o: Partial<{ outlet_id: string | null; category: string; period_month: string; amount_minor: number; currency: string }> = {}) =>
  ({ budget_id: uuidv7(), outlet_id: null, category: "purchases", period_month: MONTH, amount_minor: 5_000_000, currency: "INR", ...o });
/** This file's month only: the canonical world holds budgets of its own. */
const rows = async () => (await db.admin(
  `SELECT id, outlet_id, category, period_month::text AS month, amount_minor::int AS amount, currency, origin FROM core.budget
    WHERE tenant_id = $1 AND period_month = $2 ORDER BY created_at, id`, [T.tenant, MONTH])).rows;
const audits = async () => (await db.admin(
  `SELECT actor, entity, entity_id, before, after, decision_id FROM core.audit_log WHERE tenant_id = $1 AND action = 'finance.budget.set.v1' ORDER BY seq`,
  [T.tenant])).rows;

beforeAll(async () => {
  db = await openDb();
  const w = await buildWorld(db);
  Object.assign(T, { tenant: w.tenant, owner: w.owner, staff: w.staff, outlets: [...w.outlets] });
  const own = (command_type: string) => ({ tenant_id: T.tenant, outlet_ids: "*" as const, role: "owner" as const, member_id: T.owner, command_type });
  await db.withContext("munim_core", own("tenancy.member.invite.v1"), async (c) => {
    await c.query(`UPDATE core.member SET idp_sub = $2 WHERE id = $1`, [T.owner, T.subs.owner]);
    await c.query(`UPDATE core.member SET idp_sub = $2 WHERE id = $1`, [T.staff, T.subs.staff]);
    await c.query(`INSERT INTO core.member (tenant_id, id, idp_sub, name, email) VALUES ($1, $2, $3, 'Synthetic manager', 'manager@example.test')`, [T.tenant, T.manager, T.subs.manager]);
    await c.query(`INSERT INTO core.membership (tenant_id, member_id, role, outlet_ids) VALUES ($1, $2, 'manager', $3)`, [T.tenant, T.manager, [T.outlets[0]]]);
  });
  pools = { core: db.pool("munim_core", 4), svc: db.pool("munim_svc", 2) };
  const config = { nodeEnv: "test", redact: (s: string) => s };
  const deps: Deps = { pools, idp, storefronts: async () => null, config, log: createLogger(config, () => {}) };
  app = await createApp(deps);
});

afterAll(async () => {
  await pools?.core.end();
  await pools?.svc.end();
  await db?.stop();
});

describe("POST /v1/finance/budgets", () => {
  let first: ReturnType<typeof budget>;

  it("(1) the owner sets this month's purchases budget for the whole business: one row as sent, her own command, one audit entry", async () => {
    first = budget();
    const r = await post("owner", first);
    expect(r.status).toBe(201);
    expect(CommandResult.parse(await r.json())).toMatchObject({ type: "finance.budget.set.v1", entity_id: first.budget_id });
    expect(await rows()).toEqual([{ id: first.budget_id, outlet_id: null, category: "purchases", month: MONTH, amount: 5_000_000, currency: "INR",
      origin: { kind: "command", command_type: "finance.budget.set.v1", role: "owner", principal_id: T.owner } }]);
    expect(await audits()).toEqual([{ actor: { kind: "member", id: T.owner, role: "owner" }, entity: "core.budget", entity_id: first.budget_id,
      before: null, after: { outlet_id: null, category: "purchases", period_month: MONTH, amount_minor: 5_000_000, currency: "INR" }, decision_id: null }]);
    const v = await verifyAuditChain(svcTx(db), T.tenant);
    expect([v.ok, v.firstBadSeq]).toEqual([true, null]);
  });

  it("(2) the same key replays the stored bytes and writes nothing more", async () => {
    const p = budget({ category: "marketing", amount_minor: 100_000 });
    const key = `budget-${uuidv7()}`;
    const cmd = uuidv7();
    const once = await post("owner", p, key, cmd);
    expect(once.status).toBe(201);
    const text = await once.text();
    const [n, a] = [(await rows()).length, (await audits()).length];
    const again = await post("owner", p, key, cmd);
    expect([again.status, await again.text(), again.headers.get(REPLAYED_HEADER)]).toEqual([201, text, "true"]);
    expect([(await rows()).length, (await audits()).length]).toEqual([n, a]);
  });

  it("(3) set again: the same row's amount changes, audited with before and after; another outlet or category is another row", async () => {
    const r = await post("owner", budget({ amount_minor: 7_500_000 }));
    expect(r.status).toBe(201);
    expect(CommandResult.parse(await r.json()).entity_id).toBe(first.budget_id);
    const purchases = (await rows()).filter((x) => x.category === "purchases");
    expect(purchases.map((x) => [x.id, x.outlet_id, x.amount])).toEqual([[first.budget_id, null, 7_500_000]]);
    expect((await audits()).at(-1)).toMatchObject({ entity_id: first.budget_id, before: { amount_minor: 5_000_000 }, after: { amount_minor: 7_500_000 } });
    const outletA = budget({ outlet_id: T.outlets[0], amount_minor: 2_000_000 });
    expect((await post("owner", outletA)).status).toBe(201);
    const after = (await rows()).filter((x) => x.category === "purchases").map((x) => [x.id, x.outlet_id, x.amount]);
    expect(after).toEqual([[first.budget_id, null, 7_500_000], [outletA.budget_id, T.outlets[0], 2_000_000]]);
    const v = await verifyAuditChain(svcTx(db), T.tenant);
    expect(v.ok).toBe(true);
  });

  it("(4) a manager (for her own outlet) and staff are refused 403 authority_denied; nothing is written", async () => {
    const [n, a] = [(await rows()).length, (await audits()).length];
    for (const [who, p] of [["manager", budget({ outlet_id: T.outlets[0], category: "labour" })], ["staff", budget({ category: "other" })],
      ["manager", budget({ amount_minor: 1 })]] as const) {
      const r = await post(who, p);
      expect([who, r.status, (await r.json()).error.reason_code]).toEqual([who, 403, "authority_denied"]);
    }
    expect([(await rows()).length, (await audits()).length]).toEqual([n, a]);
    expect((await rows()).find((x) => x.id === first.budget_id)!.amount).toBe(7_500_000);
  });

  it("(5) not the first of a month → 422; another currency → currency_mismatch, on a new row and on an existing one", async () => {
    const [n, a] = [(await rows()).length, (await audits()).length];
    expect((await post("owner", budget({ period_month: "2026-11-15", category: "utilities" }))).status).toBe(422);
    const fresh = await post("owner", budget({ currency: "AUD", category: "maintenance" }));
    expect((await fresh.json()).error.code).toBe("currency_mismatch");
    const existing = await post("owner", budget({ currency: "AUD", amount_minor: 1 }));
    expect((await existing.json()).error.code).toBe("currency_mismatch");
    expect([(await rows()).length, (await audits()).length]).toEqual([n, a]);
    expect((await rows()).find((x) => x.id === first.budget_id)!.amount).toBe(7_500_000);
  });
});
