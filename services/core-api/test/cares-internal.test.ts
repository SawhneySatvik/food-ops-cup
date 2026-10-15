// T-095a gates on the non-member edges of Munim Cares, through the real app. Embedded Postgres, no model. Synthetic data.
//   run-frame: per-outlet `cares_active` = enablement on ∧ profile active ∧ outlet opted in (the world opts in outlets 1
//              and 2 of 3, hand-typed from db/src/world.ts); an operator draft turning enablement off → all false.
//   intel drafts: goals.task.create.v1 naming a Cares listing is the people mapping's only (ADR-015 §4): from market → 422,
//              0 rows; from people → proposed; market's ordinary task (no listing) → proposed.
//   operator: `cares_public_impact:<snapshot>` publishes a network snapshot once (published_at + publish_draft_id in the
//              approving transaction, 0028's deferred check); a second publish → 409; an unknown snapshot → 404.
import { createLogger } from "@munim/config";
import { snapRef } from "@munim/contracts";
import { DraftsResponse, RunFrameResponse } from "@munim/contracts/internal";
import { type TestDb, uuidv7 } from "@munim/db";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalIdp } from "../src/auth/local-idp.ts";
import { createApp, type Deps } from "../src/app.ts";
import { svcTx, testKeys } from "../src/commit/testkit.ts";
import { configureInternal } from "../src/internal/index.ts";
import { runTemplate } from "../src/modules/approvals/snapshots.ts";
import { mintRunToken } from "../src/runtoken/index.ts";
import { openDb } from "./db.ts";
import { buildTenant, type Tenant } from "./world.ts";

const keys = testKeys();
const SECRET = "t095a-cares-internal-secret-not-real-0123456789abcdef";
const idp = createLocalIdp();
let db: TestDb;
let pools: { core: pg.Pool; svc: pg.Pool; platform: pg.Pool };
let app: Awaited<ReturnType<typeof createApp>>;
let A: Tenant;
let token = "";

type Res = Omit<Response, "json"> & { json(): Promise<any> };
const intel = async (method: string, path: string, body?: unknown): Promise<Res> =>
  (await app.request(`/internal/intel/v1/${path}`, {
    method, headers: { authorization: `Bearer ${token}`, "x-munim-service-secret": SECRET, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })) as Res;
const operator = async (method: string, path: string, body?: unknown): Promise<Res> =>
  (await app.request(path, {
    method, headers: { Authorization: `Bearer ${idp.sign({ sub: `world-operator-${A.operator}` })}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })) as Res;
const count = async (sql: string, params: unknown[] = []) => Number((await db.admin(sql, params)).rows[0]!.n);

beforeAll(async () => {
  db = await openDb();
  A = await buildTenant(db, "a");
  pools = { core: db.pool("munim_core", 4), svc: db.pool("munim_svc", 4), platform: db.pool("munim_platform", 2) };
  const config = { nodeEnv: "test", redact: (s: string) => s };
  const deps: Deps = { pools, idp, storefronts: async () => null, config, log: createLogger(config, () => {}) };
  app = await createApp(deps);
  configureInternal(deps, { serviceSecret: SECRET, keys, watchWindowMs: 0 });
  token = (await mintRunToken({ ...keys, svc: svcTx(db) }, { tenantId: A.tenant, outletScope: ["*"], trigger: "event", actor: "watcher:people" })).token;
});
afterAll(async () => {
  await Promise.allSettled([pools.core.end(), pools.svc.end(), pools.platform.end()]);
  await db.stop();
});

async function approved(target: string, patch: Record<string, unknown>) {
  const p = await operator("POST", "/platform/v1/config-drafts", { target, patch });
  expect(p.status).toBe(201);
  const id = (await p.json()).id as string;
  return { id, res: await operator("POST", `/platform/v1/config-drafts/${id}:approve`, { reason: "synthetic test" }) };
}

describe("run-frame cares_active", () => {
  it("outlets 1 and 2 are active, outlet 3 is not; with enablement turned off by an approved draft, none is", async () => {
    const active = async () => {
      const r = await intel("GET", "run-frame");
      expect(r.status).toBe(200);
      const f = RunFrameResponse.parse(await r.json());
      return A.outlets.map((o) => f.outlets.find((x) => x.id === o)!.cares_active);
    };
    expect(await active()).toEqual([true, true, false]);
    expect((await approved(`cares_enablement:${A.tenant}`, { enabled: false })).res.status).toBe(200);
    expect(await active()).toEqual([false, false, false]);
    expect((await approved(`cares_enablement:${A.tenant}`, { enabled: true })).res.status).toBe(200);
    expect(await active()).toEqual([true, true, false]);
  });
});

describe("a task draft naming a Cares listing is the people pack's only", () => {
  it("market + cares_listing_id → 422, 0 rows; people + cares_listing_id → proposed; market without a listing → proposed", async () => {
    const snap = uuidv7();
    await db.withContext("munim_svc", { tenant_id: A.tenant, outlet_ids: "*", role: "service" }, async (c) => {
      const run = uuidv7();
      await c.query(`INSERT INTO intel.run (tenant_id, id, trigger, actor, outlet_scope, expires_at) VALUES ($1, $2, 'event', 'watcher:people', '{*}', now() + interval '1 hour')`, [A.tenant, run]);
      const params = { outlet_id: A.outlets[0], status: "published" };
      const { rows } = await runTemplate(c, "cares.listings", 1, params);
      expect(rows.length).toBe(1); // the world's one published outlet-1 donation
      await c.query(`INSERT INTO evidence.snapshot (tenant_id, id, template_id, template_version, params, run_id, outlet_scope, rows, row_count, sha256)
                     VALUES ($1, $2, 'cares.listings', 1, $3, $4, '{*}', $5, 1, repeat('0', 64))`, [A.tenant, snap, params, run, JSON.stringify(rows)]);
    });
    const listing = (await db.admin<{ l: string }>(`SELECT rows->0->>'listing_id' AS l FROM evidence.snapshot WHERE id = $1`, [snap])).rows[0]!.l;
    const req = (pack: string, cares_listing_id: string | null) => ({
      draft_id: uuidv7(), pack, command_type: "goals.task.create.v1",
      payload: { task_id: uuidv7(), outlet_id: A.outlets[0], title_key: "cares.task.pack_and_hand_over", assignee_member_id: A.staff, due_on: "2026-10-20",
        finding_id: null, cares_listing_id },
      outlet_ids: [A.outlets[0]], finding_id: null, evidence: [`snap:${snap}`], based_on: [snapRef(snap, 0, "pickup_on")],
    });
    const drafts = () => count(`SELECT count(*) n FROM core.draft WHERE tenant_id = $1 AND command_type = 'goals.task.create.v1'`, [A.tenant]);
    const before = await drafts();
    const bad = await intel("POST", "drafts", req("market", listing));
    expect([bad.status, (await bad.json()).error.code]).toEqual([422, "invalid_payload"]);
    expect(await drafts()).toBe(before);
    for (const ok of [req("people", listing), req("market", null)]) {
      const r = await intel("POST", "drafts", ok);
      expect([r.status, DraftsResponse.parse(await r.json()).status]).toEqual([201, "proposed"]);
    }
    expect(await drafts()).toBe(before + 2);
    expect((await db.admin(`SELECT source, command_payload->>'cares_listing_id' AS l FROM core.draft WHERE command_payload->>'cares_listing_id' IS NOT NULL`)).rows)
      .toEqual([{ source: "intel:people", l: listing }]);
  });
});

describe("cares_public_impact: an approved config draft publishes a network snapshot once", () => {
  it("unpublished → approved draft sets published_at + publish_draft_id; again → 409 (unchanged); an unknown snapshot → 404, draft stays proposed", async () => {
    const snap = uuidv7();
    await db.withContext("munim_core", { role: "operator", operator_id: A.operator }, (c) =>
      c.query(`INSERT INTO platform.network_snapshot (id, template_id, template_version, params, rows, row_count, sha256, minted_by_operator_id)
               VALUES ($1, 'platform.cares_network_impact', 1, '{"from": "2026-10-01", "to": "2026-10-12", "city_code": null}', '[]', 0, repeat('a', 64), $2)`, [snap, A.operator]));
    const first = await approved(`cares_public_impact:${snap}`, {});
    expect(first.res.status).toBe(200);
    const row = (await db.admin(`SELECT published_at IS NOT NULL AS published, publish_draft_id FROM platform.network_snapshot WHERE id = $1`, [snap])).rows[0];
    expect(row).toEqual({ published: true, publish_draft_id: first.id });
    const again = await approved(`cares_public_impact:${snap}`, {});
    expect([again.res.status, (await again.res.json()).error.code]).toEqual([409, "conflict"]);
    expect((await db.admin(`SELECT publish_draft_id FROM platform.network_snapshot WHERE id = $1`, [snap])).rows[0]!.publish_draft_id).toBe(first.id);
    const missing = await approved(`cares_public_impact:${uuidv7()}`, {});
    expect([missing.res.status, (await missing.res.json()).error.code]).toEqual([404, "not_found"]);
    expect((await db.admin(`SELECT status FROM platform.config_draft WHERE id = $1`, [missing.id])).rows[0]!.status).toBe("proposed");
  });

  it("a patch with keys is refused at propose (422, nothing stored)", async () => {
    const before = await count(`SELECT count(*) n FROM platform.config_draft`);
    const r = await operator("POST", "/platform/v1/config-drafts", { target: `cares_public_impact:${uuidv7()}`, patch: { published: true } });
    expect([r.status, (await r.json()).error.code]).toEqual([422, "invalid_payload"]);
    expect(await count(`SELECT count(*) n FROM platform.config_draft`)).toBe(before);
  });
});
