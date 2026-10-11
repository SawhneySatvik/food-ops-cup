// T-058 wiring gates — POST /internal/intel/v1/graph:query through the real app (run token + service secret → munim_svc
// under the token's tenant). Embedded Postgres, no model, synthetic data. Expected rows are typed by hand from the tiny
// graph written here (rice → dosa → …), never read from the code under test.
//   (1) price_shock_path from A's rice = A's dosa (depth 1) and A's thali (depth 2), by hand
//   (2) isolation: B's token, the same ids → 0 rows (another tenant's graph is simply not there)
//   (3) check_args parity: tenant_id, an unknown key, a non-uuid id, depth 0 / 4 / "2" / true, an unknown template → 422;
//       the depth default is 3 (accept), and the walk honours depth 1 (accept)
import { createLogger } from "@munim/config";
import { GraphQueryResponse } from "@munim/contracts/internal";
import { type TestDb, uuidv7 } from "@munim/db";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalIdp } from "../../../adapters/dev/idp-local/index.ts";
import { createApp, type Deps } from "../src/app.ts";
import { svcTx, testKeys } from "../src/commit/testkit.ts";
import { configureInternal } from "../src/internal/index.ts";
import { mintRunToken } from "../src/runtoken/index.ts";
import { openDb } from "./db.ts";
import { buildTenant, type Tenant } from "./world.ts";

const keys = testKeys();
const SECRET = "t058w-test-service-secret-not-real-0123456789abcdef";
let db: TestDb;
let pools: { core: pg.Pool; svc: pg.Pool };
let app: Awaited<ReturnType<typeof createApp>>;
let A: Tenant;
let B: Tenant;
const tok: Record<string, string> = {};
const ids = { rice: uuidv7(), dosa: uuidv7(), thali: uuidv7(), mill: uuidv7() };

type Res = Omit<Response, "json"> & { json(): Promise<any> };
const run = async (t: Tenant) =>
  (await mintRunToken({ ...keys, svc: svcTx(db) }, { tenantId: t.tenant, outletScope: ["*"], trigger: "ask", actor: t.owner })).token;
const intel = async (token: string, path: string, body: unknown): Promise<Res> =>
  (await app.request(`/internal/intel/v1/${path}`, {
    method: "POST", body: JSON.stringify(body),
    headers: { authorization: `Bearer ${token}`, "x-munim-service-secret": SECRET, "content-type": "application/json" },
  })) as Res;
const query = async (token: string, template: string, args: Record<string, unknown>) => {
  const r = await intel(token, "graph:query", { template, args });
  return { status: r.status, body: await r.json() };
};
const shape = (rows: Array<Record<string, unknown>>) => rows.map((r) => [r.node_id, r.kind, r.name, r.depth]).sort((a, b) => String(a).localeCompare(String(b)));

beforeAll(async () => {
  db = await openDb();
  A = await buildTenant(db, "a");
  B = await buildTenant(db, "b");
  pools = { core: db.pool("munim_core", 4), svc: db.pool("munim_svc", 4) };
  const config = { nodeEnv: "test", redact: (s: string) => s };
  const deps: Deps = { pools, idp: createLocalIdp(), storefronts: async () => null, config, log: createLogger(config, () => {}) };
  app = await createApp(deps);
  configureInternal(deps, { serviceSecret: SECRET, keys, watchWindowMs: 0 });
  tok.A = await run(A);
  tok.B = await run(B);
  const ents = [
    { id: ids.rice, kind: "ingredient", core_ref: null, name: "Rice (synthetic)" },
    { id: ids.dosa, kind: "item", core_ref: null, name: "Dosa (synthetic)" },
    { id: ids.thali, kind: "item", core_ref: null, name: "Thali (synthetic)" },
    { id: ids.mill, kind: "supplier", core_ref: null, name: "Simulated Mill" },
  ];
  expect((await intel(tok.A!, "entities:batch", { entities: ents })).status).toBe(201);
  const edge = (kind: string, src: string, dst: string) => ({ id: uuidv7(), kind, src_entity_id: src, dst_entity_id: dst, claim_id: null,
    source_ref: `core.supplier:${A.supplier}`, valid_from: null, valid_to: null });
  // thali uses dosa uses rice; the mill supplies rice
  const edges = [edge("uses", ids.dosa, ids.rice), edge("uses", ids.thali, ids.dosa), edge("supplies", ids.mill, ids.rice)];
  expect((await intel(tok.A!, "edges:batch", { edges })).status).toBe(201);
});

afterAll(async () => {
  await pools?.core.end();
  await pools?.svc.end();
  await db?.stop();
});

describe("graph:query (T-058 wiring)", () => {
  it("(1) price_shock_path from rice = dosa at 1 hop and thali at 2, by hand; depth 1 stops at dosa", async () => {
    const all = await query(tok.A!, "price_shock_path", { ingredient_id: ids.rice });
    expect(all.status).toBe(200);
    expect(shape(GraphQueryResponse.parse(all.body).rows)).toEqual(shape([
      { node_id: ids.dosa, kind: "item", name: "Dosa (synthetic)", depth: 1 }, { node_id: ids.thali, kind: "item", name: "Thali (synthetic)", depth: 2 }]));
    const one = await query(tok.A!, "price_shock_path", { ingredient_id: ids.rice, depth: 1 });
    expect(shape(one.body.rows)).toEqual(shape([{ node_id: ids.dosa, kind: "item", name: "Dosa (synthetic)", depth: 1 }]));
    const sup = await query(tok.A!, "supplier_dependency", { supplier_id: ids.mill });
    expect([sup.status, sup.body.rows.length]).toEqual([200, 1]);
  });

  it("(2) isolation: tenant B's token with A's ids → 200 and 0 rows (A's own token → rows, above)", async () => {
    for (const [t, a] of [["price_shock_path", { ingredient_id: ids.rice }], ["neighbourhood", { entity_id: ids.rice }], ["supplier_dependency", { supplier_id: ids.mill }]] as const) {
      const r = await query(tok.B!, t, a);
      expect([t, r.status, r.body.rows]).toEqual([t, 200, []]);
    }
    expect((await query(tok.A!, "neighbourhood", { entity_id: ids.rice })).body.rows.length).toBe(3);
  });

  it("(3) check_args parity: anything but the template's own arguments → 422, nothing run", async () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      ["price_shock_path", { ingredient_id: ids.rice, tenant_id: B.tenant }],
      ["price_shock_path", { ingredient_id: ids.rice, x: 1 }],
      ["price_shock_path", { ingredient_id: "not-a-uuid" }],
      ["price_shock_path", {}],
      ["price_shock_path", { ingredient_id: ids.rice, depth: 0 }],
      ["price_shock_path", { ingredient_id: ids.rice, depth: 4 }],
      ["price_shock_path", { ingredient_id: ids.rice, depth: "2" }],
      ["price_shock_path", { ingredient_id: ids.rice, depth: true }],
      ["supplier_dependency", { supplier_id: ids.mill, depth: 1 }],
      ["no_such_template", { entity_id: ids.rice }],
    ];
    for (const [t, a] of bad) expect([t, a, (await query(tok.A!, t, a)).status]).toEqual([t, a, 422]);
    expect((await query(tok.A!, "price_shock_path", { ingredient_id: ids.rice, depth: 3 })).status).toBe(200);
  });
});
