// T-114 gates — POST /v1/rfq-requests (purchasing.rfq.request.v1) through the real app: a person asks the simulated
// suppliers for quotes; core records the request (audit) and starts the negotiation run under the person's identity.
//   (1) the owner's request for two outlets: 201 command result; ONE audit entry under the owner; intel called once with
//       core's own reads (simulated suppliers with a card only, the active items, the pack's minor unit) under an `ask`
//       run whose actor is the owner and whose scope is exactly the two outlets; the run is ended; the outcome headers;
//   (2) idempotency: the same key replays the stored bytes, starts no second run and calls intel no second time;
//   (3) role and outlet: staff 403; a manager asking for her outlet and another 403 (every chosen outlet is judged),
//       for her own outlet alone 201 — a refusal writes nothing and calls nothing;
//   (4) intel failing after the commit: 503, the request stays on record, the run is ended;
//   (5) no negotiation port wired: 503 before anything is written.
// The intel side is a fake at the service boundary (the port); the run token is checked with core's own verifier.
// The command's core.command_authority row is the migration's (0032); RFQ_NO_AUTHORITY_ROW=1 deletes it for this file's database,
// and redproof-t114.sh proves every request is then refused.
import { createLogger } from "@munim/config";
import { CommandResult, REPLAYED_HEADER } from "@munim/contracts";
import { buildWorld, type TestDb } from "@munim/db";
import type { Hono } from "hono";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalIdp } from "../src/auth/local-idp.ts";
import { type AppEnv, createApp, TENANT_HEADER } from "../src/app.ts";
import { uuidv7 } from "../src/commit/index.ts";
import { svcTx, testKeys } from "../src/commit/testkit.ts";
import type { Deps } from "../src/lib/types.ts";
import { configureRfq, DRAFT_ID_HEADER, type NegotiateBody, NEGOTIATION_HEADER } from "../src/modules/purchasing/index.ts";
import { verifyRunToken } from "../src/runtoken/index.ts";
import { openDb } from "./db.ts";

const idp = createLocalIdp();
const keys = testKeys();
let db: TestDb;
let pools: { core: pg.Pool; svc: pg.Pool };
let app: Hono<AppEnv>;
let deps: Deps;

const T = {
  tenant: "", owner: "", staff: "", outlets: ["", "", ""] as [string, string, string], ingredient: "", item: "", supplier: "",
  manager: uuidv7(), real: uuidv7(), noCard: uuidv7(),
  subs: { owner: `owner-${uuidv7()}`, staff: `staff-${uuidv7()}`, manager: `manager-${uuidv7()}` },
};
type Who = keyof typeof T.subs;

interface Call { token: string; body: NegotiateBody }
const calls: Call[] = [];
let failIntel = false;
async function fakeIntel(token: string, body: NegotiateBody): Promise<unknown> {
  calls.push({ token, body });
  if (failIntel) throw new Error("intel /negotiate: HTTP 502");
  const v = await verifyRunToken({ ...keys, svc: svcTx(db) }, token);
  if (!v.ok) throw new Error(`fake intel: token refused ${v.reason}`);
  return { run_id: v.claims.run_id, status: "drafted", draft_id: uuidv7() };
}

type Res = Omit<Response, "json"> & { json(): Promise<any> };
const post = async (who: Who, payload: unknown, key = `rfq-${uuidv7()}`, command_id = uuidv7()): Promise<Res> =>
  (await app.request("/v1/rfq-requests", {
    method: "POST",
    headers: { Authorization: `Bearer ${idp.sign({ sub: T.subs[who] })}`, [TENANT_HEADER]: T.tenant, "Content-Type": "application/json" },
    body: JSON.stringify({ command_id, idempotency_key: key, type: "purchasing.rfq.request.v1", payload }),
  })) as Res;
const rfq = (outlets: string[]) => ({ rfq_id: uuidv7(), ingredient_id: T.ingredient, outlet_ids: outlets });
const count = async (sql: string, params: unknown[] = []) => Number((await db.admin(sql, params)).rows[0]!.n);
const runs = () => count(`SELECT count(*) n FROM intel.run WHERE tenant_id = $1`, [T.tenant]);
const audits = () => count(`SELECT count(*) n FROM core.audit_log WHERE tenant_id = $1 AND action = 'purchasing.rfq.request.v1'`, [T.tenant]);
const logged = () => count(`SELECT count(*) n FROM core.command_log WHERE tenant_id = $1 AND command_type = 'purchasing.rfq.request.v1'`, [T.tenant]);

beforeAll(async () => {
  db = await openDb();
  if (process.env.RFQ_NO_AUTHORITY_ROW) await db.admin(`DELETE FROM core.command_authority WHERE command_type = 'purchasing.rfq.request.v1'`);
  const w = await buildWorld(db);
  Object.assign(T, { tenant: w.tenant, owner: w.owner, staff: w.staff, outlets: [...w.outlets], ingredient: w.ingredient, item: w.item, supplier: w.supplier });
  const own = (command_type: string) => ({ tenant_id: T.tenant, outlet_ids: "*" as const, role: "owner" as const, member_id: T.owner, command_type });
  await db.withContext("munim_core", own("tenancy.member.invite.v1"), async (c) => {
    await c.query(`UPDATE core.member SET idp_sub = $2 WHERE id = $1`, [T.owner, T.subs.owner]);
    await c.query(`UPDATE core.member SET idp_sub = $2 WHERE id = $1`, [T.staff, T.subs.staff]);
    await c.query(`INSERT INTO core.member (tenant_id, id, idp_sub, name, email) VALUES ($1, $2, $3, 'Synthetic manager', 'manager@example.test')`, [T.tenant, T.manager, T.subs.manager]);
    await c.query(`INSERT INTO core.membership (tenant_id, member_id, role, outlet_ids) VALUES ($1, $2, 'manager', $3)`, [T.tenant, T.manager, [T.outlets[0]]]);
  });
  // Two suppliers intel must never be sent: a real one, and a simulated one with no agent card.
  await db.withContext("munim_core", own("purchasing.supplier.upsert.v1"), (c) =>
    c.query(`INSERT INTO core.supplier (tenant_id, id, name, kind, a2a_card_url) VALUES ($1, $2, 'Mandi Traders', 'real', NULL), ($1, $3, 'Card-less (simulated)', 'simulated', NULL)`,
      [T.tenant, T.real, T.noCard]));
  pools = { core: db.pool("munim_core", 8), svc: db.pool("munim_svc", 4) };
  const config = { nodeEnv: "test", redact: (s: string) => s };
  deps = { pools, idp, storefronts: async () => null, config, log: createLogger(config, () => {}) };
  app = await createApp(deps);
});

afterAll(async () => {
  await pools?.core.end();
  await pools?.svc.end();
  await db?.stop();
});

describe("POST /v1/rfq-requests", () => {
  it("(5) no negotiation port wired → 503 and nothing written", async () => {
    const before = [await logged(), await audits(), await runs()];
    expect((await post("owner", rfq([T.outlets[0]]))).status).toBe(503);
    expect([await logged(), await audits(), await runs()]).toEqual(before);
    configureRfq(deps, { keys, intel: fakeIntel });
  });

  it("(1) the owner asks for two outlets: one audit entry under her, one ask run scoped to exactly those outlets, core's own reads", async () => {
    const p = rfq([T.outlets[0], T.outlets[1]]);
    const [runs0, n0] = [await runs(), calls.length];
    const r = await post("owner", p);
    expect(r.status).toBe(201);
    const body = CommandResult.parse(await r.json());
    expect(body).toMatchObject({ type: "purchasing.rfq.request.v1", entity_id: p.rfq_id });
    expect(r.headers.get(NEGOTIATION_HEADER)).toBe("drafted");
    expect(r.headers.get(DRAFT_ID_HEADER)).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls.length).toBe(n0 + 1);
    const call = calls.at(-1)!;
    expect(call.body).toEqual({
      rfq_id: p.rfq_id, ingredient_id: T.ingredient, item_name: "Paneer", unit: "g", currency: "INR", minor_unit: 2,
      outlet_ids: [T.outlets[0], T.outlets[1]],
      suppliers: [{ supplier_id: T.supplier, kind: "simulated", card_url: "http://localhost:9000/card" }],
      item_ids: expect.arrayContaining([T.item]),
    });
    expect(call.body.item_ids.length).toBe(2);
    // The run is the one the token names: `issued_at` is the token's iat in whole seconds, so "the newest run" can be the world's
    // own watch_sweep run when the two fall in the same second. (The signature was already checked by fakeIntel.)
    const runId = (JSON.parse(Buffer.from(call.token.split(".")[1]!, "base64url").toString("utf8")) as { run_id: string }).run_id;
    const run = (await db.admin(`SELECT trigger, actor, outlet_scope::text[] AS scope, ended_at IS NOT NULL AS ended FROM intel.run WHERE tenant_id = $1 AND id = $2`, [T.tenant, runId])).rows[0];
    expect(run).toEqual({ trigger: "ask", actor: T.owner, scope: [T.outlets[0], T.outlets[1]], ended: true });
    expect(await runs()).toBe(runs0 + 1);
    // The ended run's token no longer verifies.
    expect((await verifyRunToken({ ...keys, svc: svcTx(db) }, call.token)).ok).toBe(false);
    const a = (await db.admin(`SELECT actor, entity, entity_id, after, decision_id FROM core.audit_log WHERE tenant_id = $1 AND action = 'purchasing.rfq.request.v1'`, [T.tenant])).rows;
    expect(a).toEqual([{ actor: { kind: "member", id: T.owner, role: "owner" }, entity: "core.ingredient", entity_id: T.ingredient,
      after: { rfq_id: p.rfq_id, outlet_ids: [T.outlets[0], T.outlets[1]] }, decision_id: null }]);
  });

  it("(2) a replay of the same key returns the stored bytes, starts no run and calls intel no second time", async () => {
    const p = rfq([T.outlets[0]]);
    const key = `rfq-${uuidv7()}`;
    const cmd = uuidv7();
    const first = await post("owner", p, key, cmd);
    expect(first.status).toBe(201);
    const text = await first.text();
    const [runs0, n0, a0] = [await runs(), calls.length, await audits()];
    const again = await post("owner", p, key, cmd);
    expect(again.status).toBe(201);
    expect(await again.text()).toBe(text);
    expect(again.headers.get(REPLAYED_HEADER)).toBe("true");
    expect(again.headers.get(NEGOTIATION_HEADER)).toBeNull();
    expect([await runs(), calls.length, await audits()]).toEqual([runs0, n0, a0]);
  });

  it("(3) staff are refused; a manager is refused for an outlet outside her scope and allowed for her own", async () => {
    const before = [await logged(), await runs(), calls.length];
    const staff = await post("staff", rfq([T.outlets[0]]));
    expect(staff.status).toBe(403);
    const both = await post("manager", rfq([T.outlets[0], T.outlets[1]]));
    expect(both.status).toBe(403);
    expect((await both.json()).error.reason_code).toBe("authority_denied");
    expect([await logged(), await runs(), calls.length]).toEqual(before);
    const mine = await post("manager", rfq([T.outlets[0]]));
    expect(mine.status).toBe(201);
    expect(calls.at(-1)!.body.outlet_ids).toEqual([T.outlets[0]]);
  });

  it("an unknown ingredient or outlet is a bad request and calls nothing", async () => {
    const n0 = calls.length;
    expect((await post("owner", { ...rfq([T.outlets[0]]), ingredient_id: uuidv7() })).status).toBe(400);
    expect((await post("owner", rfq([T.outlets[0], uuidv7()]))).status).toBe(400);
    expect(calls.length).toBe(n0);
  });

  it("(4) intel failing after the commit → 503; the request stays on record and the run is ended", async () => {
    failIntel = true;
    try {
      const [a0, r0] = [await audits(), await runs()];
      expect((await post("owner", rfq([T.outlets[2]]))).status).toBe(503);
      expect([await audits(), await runs()]).toEqual([a0 + 1, r0 + 1]);
      expect(await count(`SELECT count(*) n FROM intel.run WHERE tenant_id = $1 AND trigger = 'ask' AND ended_at IS NULL`, [T.tenant])).toBe(0);
    } finally {
      failIntel = false;
    }
  });
});
