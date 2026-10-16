// R67 gate (founder, 16 Oct; T-128) — POST /internal/intel/v1/drafts admits the customers specialist's win-back campaign only
// on a demo business and only when its audience is the at-risk count of the finding's own churn segment (lib/demo.ts), through
// the real app (run token + service secret → munim_svc under the token's RLS). Paired, every case on the same proposal shape:
//   demo + the Σ row's at_risk_count of a customers.churn_segments snapshot for the draft's one outlet → 201 proposed;
//   the same proposal on a business that is not a demo → 422 campaign_audience_unscoped, 0 rows (the 11 Oct S1-D ruling stands);
//   demo, but the audience from another column, another snapshot than the segment, another outlet's segment, another template,
//   or a tenant-wide draft → 422 campaign_audience_unscoped, 0 rows.
// Expected outcomes are the R67 decision as the orchestrator relayed it (16 Oct), typed by hand. Embedded Postgres, no model.
import { createLogger } from "@munim/config";
import { Snapshot, snapRef } from "@munim/contracts";
import { DraftsResponse } from "@munim/contracts/internal";
import { buildWorld, type TestDb, uuidv7, type World } from "@munim/db";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalIdp } from "../src/auth/local-idp.ts";
import { createApp, type Deps } from "../src/app.ts";
import { svcTx, testKeys } from "../src/commit/testkit.ts";
import { configureInternal } from "../src/internal/index.ts";
import { mintRunToken } from "../src/runtoken/index.ts";
import { openDb } from "./db.ts";

const keys = testKeys();
const SECRET = "r67-campaign-demo-service-secret-not-real-0123456789";
const AS_OF = "2026-10-10";
let db: TestDb;
let pools: { core: pg.Pool; svc: pg.Pool };
let app: Awaited<ReturnType<typeof createApp>>;
let demo: World;
let plain: World;

type Res = Omit<Response, "json"> & { json(): Promise<any> };
const token = async (w: World) =>
  (await mintRunToken({ ...keys, svc: svcTx(db) }, { tenantId: w.tenant, outletScope: ["*"], trigger: "watch_sweep", actor: "watcher:customers" })).token;
const intel = async (tok: string, path: string, body: unknown): Promise<Res> =>
  (await app.request(`/internal/intel/v1/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${tok}`, "x-munim-service-secret": SECRET, "content-type": "application/json" },
    body: JSON.stringify(body),
  })) as Res;
const drafts = async (w: World) => Number((await db.admin(`SELECT count(*) n FROM core.draft WHERE tenant_id = $1`, [w.tenant])).rows[0]!.n);
const mint = async (tok: string, template_id: string, params: Record<string, unknown>) => {
  const r = await intel(tok, "snapshots", { template_id, params });
  expect(r.status).toBe(201);
  return Snapshot.parse(await r.json());
};
/** The Σ row of a churn segment: its customer_id cell is null (0021's template puts it last). */
const sigma = (s: ReturnType<typeof Snapshot.parse>) => s.rows.findIndex((r) => r.customer_id === null);

function campaign(segment: string, audienceRef: string, outlets: string[]) {
  return {
    draft_id: uuidv7(), pack: "customers", command_type: "customers.campaign.create.v1",
    payload: { campaign_id: uuidv7(), name: "Win back regulars who have stopped coming", channel: "sms", outlet_ids: outlets,
      segment_snapshot_id: segment, audience_count: audienceRef, message_key: "campaign.win_back", placeholders: [], coupon_id: null,
      send_at: "2026-10-11T10:00:00+05:30", window_from: null, window_to: null },
    outlet_ids: outlets, finding_id: null, evidence: [`snap:${segment}`], based_on: [audienceRef],
  };
}

beforeAll(async () => {
  db = await openDb();
  demo = await buildWorld(db);
  plain = await buildWorld(db);
  // is_demo is set only by the operator's provisioning (no member command changes it); the fixture flips it as plumbing.
  await db.admin(`SET session_replication_role = replica; UPDATE core.tenant SET is_demo = true WHERE tenant_id = '${demo.tenant}'; RESET session_replication_role`);
  pools = { core: db.pool("munim_core", 4), svc: db.pool("munim_svc", 4) };
  const config = { nodeEnv: "test", redact: (s: string) => s };
  const deps: Deps = { pools, idp: createLocalIdp(), storefronts: async () => null, config, log: createLogger(config, () => {}) };
  app = await createApp(deps);
  configureInternal(deps, { serviceSecret: SECRET, keys, watchWindowMs: 0 });
});

afterAll(async () => {
  await pools?.core.end();
  await pools?.svc.end();
  await db?.stop();
});

describe("R67: the win-back campaign draft", () => {
  it("demo business, the Σ row's at_risk_count of the outlet's own churn segment → 201 proposed", async () => {
    const tok = await token(demo);
    const s = await mint(tok, "customers.churn_segments", { outlet_id: demo.outlets[0], as_of: AS_OF });
    const before = await drafts(demo);
    const r = await intel(tok, "drafts", campaign(s.snapshot_id, snapRef(s.snapshot_id, sigma(s), "at_risk_count"), [demo.outlets[0]]));
    expect([r.status, DraftsResponse.parse(await r.json()).status]).toEqual([201, "proposed"]);
    expect(await drafts(demo)).toBe(before + 1);
  });

  it("the same proposal on a business that is not a demo → 422 campaign_audience_unscoped, nothing stored", async () => {
    const tok = await token(plain);
    const s = await mint(tok, "customers.churn_segments", { outlet_id: plain.outlets[0], as_of: AS_OF });
    const before = await drafts(plain);
    const r = await intel(tok, "drafts", campaign(s.snapshot_id, snapRef(s.snapshot_id, sigma(s), "at_risk_count"), [plain.outlets[0]]));
    expect([r.status, (await r.json()).error]).toEqual([422, expect.objectContaining({ code: "invalid_payload", reason_code: "campaign_audience_unscoped" })]);
    expect(await drafts(plain)).toBe(before);
  });

  it("demo, any other audience → 422 campaign_audience_unscoped, nothing stored", async () => {
    const tok = await token(demo);
    const s = await mint(tok, "customers.churn_segments", { outlet_id: demo.outlets[0], as_of: AS_OF });
    const s2 = await mint(tok, "customers.churn_segments", { outlet_id: demo.outlets[0], as_of: "2026-10-09" });
    const other = await mint(tok, "customers.churn_segments", { outlet_id: demo.outlets[1], as_of: AS_OF });
    const waste = await mint(tok, "inventory.waste_week", { outlet_id: demo.outlets[0], week_start: "2026-10-05" });
    const at = (x: typeof s, col = "at_risk_count") => snapRef(x.snapshot_id, sigma(x), col);
    const cases: Array<[string, ReturnType<typeof campaign>]> = [
      ["regular_count instead of at_risk_count", campaign(s.snapshot_id, at(s, "regular_count"), [demo.outlets[0]])],
      ["the audience from another snapshot than the segment", campaign(s.snapshot_id, at(s2), [demo.outlets[0]])],
      ["another outlet's segment", campaign(other.snapshot_id, at(other), [demo.outlets[0]])],
      ["a tenant-wide draft", campaign(s.snapshot_id, at(s), [])],
      ["two outlets", campaign(s.snapshot_id, at(s), [demo.outlets[0], demo.outlets[1]])],
    ];
    if (waste.rows.length > 0) cases.push(["another template", campaign(waste.snapshot_id, snapRef(waste.snapshot_id, 0, "waste_minor"), [demo.outlets[0]])]);
    const before = await drafts(demo);
    const got: string[] = [];
    for (const [name, body] of cases) {
      const r = await intel(tok, "drafts", body);
      got.push(`${name}: ${r.status} ${(await r.json()).error?.reason_code}`);
    }
    console.log(`R67 refusals:\n  ${got.join("\n  ")}`);
    expect(got).toEqual(cases.map(([name]) => `${name}: 422 campaign_audience_unscoped`));
    expect(await drafts(demo)).toBe(before);
  });
});
