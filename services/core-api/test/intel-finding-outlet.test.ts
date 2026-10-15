// T-114 gate — a finding about one outlet whose impact snapshot is tenant-wide carries that outlet (Lane B1 §7 item 4:
// Gomti Nagar's missing-licence finding was tenant-wide while its task draft sat at Gomti Nagar). The licence calendar
// takes no outlet param, so a sweep mints it over every outlet; intel names the detection's outlet (`outlet_ids`, one id)
// and core takes it only when it is the impact row's own `outlet_id` cell and inside the run's scope.
//   (1) the right outlet → stored with exactly that outlet;  (2) another outlet than the row's → 422, nothing stored;
//   (3) no outlet named (absent, or null as intel's generated client sends it) → tenant-wide, as before;
//   (4) a scoped run naming an outlet outside its scope → 422
//       (its snapshot holds only its own outlets' rows, so no row of another outlet can be named).
import { createLogger } from "@munim/config";
import { Snapshot, snapRef } from "@munim/contracts";
import { FindingsResponse } from "@munim/contracts/internal";
import type { TestDb } from "@munim/db";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalIdp } from "../src/auth/local-idp.ts";
import { createApp } from "../src/app.ts";
import { uuidv7 } from "../src/commit/index.ts";
import { svcTx, testKeys } from "../src/commit/testkit.ts";
import { configureInternal } from "../src/internal/index.ts";
import { mintRunToken, type OutletScope } from "../src/runtoken/index.ts";
import { openDb } from "./db.ts";
import { buildTenant, type Tenant } from "./world.ts";

const keys = testKeys();
const SECRET = "t114-test-service-secret-not-real-0123456789abcdef";
let db: TestDb;
let pools: { core: pg.Pool; svc: pg.Pool };
let app: Awaited<ReturnType<typeof createApp>>;
let A: Tenant;

type Res = Omit<Response, "json"> & { json(): Promise<any> };
const token = async (scope: OutletScope) =>
  (await mintRunToken({ ...keys, svc: svcTx(db) }, { tenantId: A.tenant, outletScope: scope, trigger: "watch_sweep", actor: "watcher:compliance" })).token;
const intel = async (tok: string, path: string, body: unknown): Promise<Res> =>
  (await app.request(`/internal/intel/v1/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${tok}`, "x-munim-service-secret": SECRET, "content-type": "application/json" },
    body: JSON.stringify(body),
  })) as Res;
const calendar = async (tok: string) => {
  const r = await intel(tok, "snapshots", { template_id: "compliance.licence_calendar", params: { as_of: "2026-10-15", required_kinds: ["fssai"] } });
  expect(r.status).toBe(201);
  return Snapshot.parse(await r.json());
};
/** The licence watcher's body for row `i` (licence_expiring.py: a missing licence cites its status; impact days_left). */
const finding = (s: Snapshot, i: number, outlet_ids?: string[] | null) => ({
  pack: "compliance", type: "compliance.licence_expiring", severity: "critical", confidence_bp: 10000,
  dedupe_key: `compliance.licence_expiring:${uuidv7()}:fssai:missing`,
  envelope: {
    finding_id: uuidv7(), abstained: false, impact_ref: snapRef(s.snapshot_id, i, "days_left"),
    segments: [{ text: `No licence of this kind is on record: ${snapRef(s.snapshot_id, i, "status")}.`, refs: [`snap:${s.snapshot_id}`] }],
  },
  ...(outlet_ids !== undefined ? { outlet_ids } : {}),
});
const outletsOf = async (id: string) => (await db.admin(`SELECT outlet_ids::text[] AS o FROM intel.finding WHERE id = $1`, [id])).rows[0]?.o;
const findings = async () => Number((await db.admin(`SELECT count(*) n FROM intel.finding WHERE tenant_id = $1`, [A.tenant])).rows[0]!.n);

beforeAll(async () => {
  db = await openDb();
  A = await buildTenant(db, "a");
  pools = { core: db.pool("munim_core", 4), svc: db.pool("munim_svc", 4) };
  const config = { nodeEnv: "test", redact: (s: string) => s };
  const deps = { pools, idp: createLocalIdp(), storefronts: async () => null, config, log: createLogger(config, () => {}) };
  app = await createApp(deps);
  configureInternal(deps, { serviceSecret: SECRET, keys, watchWindowMs: 0 });
});

afterAll(async () => {
  await pools?.core.end();
  await pools?.svc.end();
  await db?.stop();
});

describe("a per-outlet finding cut from a tenant-wide snapshot", () => {
  it("(1)–(3) the row's own outlet is stored; another outlet is refused; none named stays tenant-wide", async () => {
    const tok = await token(["*"]);
    const s = await calendar(tok);
    expect(s.outlet_scope).toEqual(["*"]);
    const i = s.rows.findIndex((r) => r.outlet_id === A.outlets[1]);
    expect(i).toBeGreaterThanOrEqual(0);
    const ok = await intel(tok, "findings", finding(s, i, [A.outlets[1]]));
    expect(ok.status).toBe(201);
    const stored = FindingsResponse.parse(await ok.json());
    expect(stored.outcome).toBe("stored");
    expect(await outletsOf(stored.finding_id)).toEqual([A.outlets[1]]);

    const before = await findings();
    const wrong = await intel(tok, "findings", finding(s, i, [A.outlets[0]]));
    expect([wrong.status, (await wrong.json()).error.code]).toEqual([422, "invalid_payload"]);
    expect(await findings()).toBe(before);

    const plain = FindingsResponse.parse(await (await intel(tok, "findings", finding(s, i))).json());
    expect(await outletsOf(plain.finding_id)).toEqual([]);
    const nul = await intel(tok, "findings", finding(s, i, null));
    expect(nul.status).toBe(201);
    expect(await outletsOf(FindingsResponse.parse(await nul.json()).finding_id)).toEqual([]);
  });

  it("(4) a scoped run cannot name an outlet outside its scope", async () => {
    const tok = await token([A.outlets[0]]);
    const s = await calendar(tok);
    const i = s.rows.findIndex((r) => r.outlet_id === A.outlets[0]);
    expect((await intel(tok, "findings", finding(s, i, [A.outlets[1]]))).status).toBe(422);
    const own = FindingsResponse.parse(await (await intel(tok, "findings", finding(s, i, [A.outlets[0]]))).json());
    expect(await outletsOf(own.finding_id)).toEqual([A.outlets[0]]);
  });
});
