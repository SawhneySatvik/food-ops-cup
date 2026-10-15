// T-058 wiring gates — POST /internal/intel/v1/graph:query through the real app (run token + service secret → munim_svc
// under the token's tenant). Embedded Postgres, no model, synthetic data. Expected rows are typed by hand from the tiny
// graph written here (rice → dosa → …), never read from the code under test.
//   (1) price_shock_path from A's rice = A's dosa (depth 1) and A's thali (depth 2), by hand
//   (2) isolation: B's token, the same ids → 0 rows (another tenant's graph is simply not there)
//   (3) check_args parity: tenant_id, an unknown key, a non-uuid id, depth 0 / 4 / "2" / true, an unknown template → 422;
//       the depth default is 3 (accept), and the walk honours depth 1 (accept)
//   (4) outlet isolation (R-A 1): a run scoped to outlet 1 walks only what that scope may see — outlet 2's outlet node, its
//       staff, a customer who ordered only there, its finding and that finding's claim are 0 rows, and so is an item reached
//       only through outlet 2 (the bridge), and an outlet-anchored edge (waste) with no outlet end; outlet 1's counterparts
//       come back. The '*' run sees both (hand lists below)
//   (5) template comments are kept: bindNamedParams skips a `:name` inside a `--` comment (R-A 9)
import { createLogger } from "@munim/config";
import { GraphQueryResponse } from "@munim/contracts/internal";
import { type TestDb, uuidv7 } from "@munim/db";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalIdp } from "../src/auth/local-idp.ts";
import { createApp, type Deps } from "../src/app.ts";
import { svcTx, testKeys } from "../src/commit/testkit.ts";
import { graphStatement } from "../src/internal/graph/index.ts";
import { configureInternal } from "../src/internal/index.ts";
import { bindNamedParams } from "../src/modules/approvals/snapshots.ts";
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
// (4): graph nodes around ghee, and the core rows that decide what an outlet-1 run may see.
const g = Object.fromEntries(["ghee", "dosa2", "chut2", "onlyb", "o1", "o2", "p1", "p2", "c1", "c2", "f1", "f2", "cl1", "cl2", "day"].map((k) => [k, uuidv7()])) as Record<string, string>;
const core = { staff2: uuidv7(), customer2: uuidv7(), finding2: uuidv7(), claim2: uuidv7() };

type Res = Omit<Response, "json"> & { json(): Promise<any> };
const run = async (t: Tenant, outletScope: ["*"] | string[] = ["*"]) =>
  (await mintRunToken({ ...keys, svc: svcTx(db) }, { tenantId: t.tenant, outletScope, trigger: "ask", actor: t.owner })).token;
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

  // (4) Core rows of outlet 2 (fixture plumbing, as the superuser with triggers off): a cook, a customer whose only order is
  // there, a conversation message with a chunk and a claim, and a finding. Outlet 1 has the world's own: the cook
  // (A.person), the customer (A.customer, who ordered at outlets 1 and 2), the handover message's claim and the finding.
  const [o1, o2] = A.outlets;
  const claim1 = (await db.admin(`SELECT id FROM intel.claim WHERE tenant_id = $1 AND chunk_id = $2`, [A.tenant, A.chunk])).rows[0]!.id as string;
  const conv2 = uuidv7(), msg2 = uuidv7(), chunk2 = uuidv7();
  await db.admin(`SET session_replication_role = replica;
    INSERT INTO core.staff (tenant_id, id, outlet_id, name, role_key, pay_basis, wage_rate_minor, ot_multiplier_bp, currency, joined_on, origin)
      VALUES ('${A.tenant}', '${core.staff2}', '${o2}', 'Cook Two', 'cook', 'hourly', 15000, 15000, '${A.currency}', '2026-01-01', '{}');
    INSERT INTO core.customer (tenant_id, id, name, phone, origin) VALUES ('${A.tenant}', '${core.customer2}', 'Guest Two', '+919800000002', '{}');
    INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, kind, status, subtotal_minor, tax_minor, total_minor, currency, pricing_snapshot, customer_id, origin, business_date, ticket_no)
      VALUES ('${A.tenant}', '${uuidv7()}', '${o2}', '${A.channel}', 'dine_in', 'placed', 32000, 1600, 33600, '${A.currency}', '{}', '${core.customer2}', '{}', '2026-10-09', 901);
    INSERT INTO core.conversation (tenant_id, id, outlet_id, kind, title) VALUES ('${A.tenant}', '${conv2}', '${o2}', 'handover', 'Evening handover');
    INSERT INTO core.message (tenant_id, id, conversation_id, author_member_id, body) VALUES ('${A.tenant}', '${msg2}', '${conv2}', '${A.owner}', 'Ghee short again');
    INSERT INTO intel.chunk (tenant_id, id, message_id, seq, text, run_id) VALUES ('${A.tenant}', '${chunk2}', '${msg2}', 0, 'Ghee short again', '${A.run}');
    INSERT INTO intel.claim (tenant_id, id, run_id, chunk_id, span_start, span_end, quote, predicate, object)
      VALUES ('${A.tenant}', '${core.claim2}', '${A.run}', '${chunk2}', 0, 4, 'Ghee', 'delivered_short', 'ghee');
    INSERT INTO intel.finding (tenant_id, id, run_id, outlet_ids, pack, type, severity, confidence_bp, envelope, dedupe_key)
      VALUES ('${A.tenant}', '${core.finding2}', '${A.run}', '{${o2}}', 'inventory_purchasing', 'inventory.shortfall', 'high', 8000,
              '{"segments": [], "abstained": true}', 'graph-test:${core.finding2}');
    SET session_replication_role = origin`);
  g.f1 = A.finding; g.f2 = core.finding2; g.cl1 = claim1; g.cl2 = core.claim2;
  const node = (id: string, kind: string, name: string, core_ref: string | null = null) => ({ id, kind, core_ref, name });
  const gents = [
    node(g.ghee!, "ingredient", "Ghee (synthetic)"), node(g.dosa2!, "item", "Ghee Dosa"), node(g.chut2!, "item", "Ghee Chutney"),
    node(g.onlyb!, "item", "Outlet Two Special"), node(g.day!, "day", "Day 2026-10-08"),
    node(g.o1!, "outlet", "Outlet One", `core.outlet:${o1}`), node(g.o2!, "outlet", "Outlet Two", `core.outlet:${o2}`),
    node(g.p1!, "person", "Cook One", `core.staff:${A.person}`), node(g.p2!, "person", "Cook Two", `core.staff:${core.staff2}`),
    node(g.c1!, "customer", "Guest", `core.customer:${A.customer}`), node(g.c2!, "customer", "Guest Two", `core.customer:${core.customer2}`),
    node(g.f1!, "other", `finding:${g.f1}`), node(g.f2!, "other", `finding:${g.f2}`), node(g.cl1!, "other", `claim:${g.cl1}`), node(g.cl2!, "other", `claim:${g.cl2}`),
  ];
  expect((await intel(tok.A!, "entities:batch", { entities: gents })).status).toBe(201);
  const gedges = ([
    ["uses", g.dosa2, g.ghee], ["uses", g.chut2, g.ghee], ["sold", g.o1, g.dosa2], ["sold", g.o2, g.chut2], ["sold", g.o2, g.onlyb],
    ["works_at", g.p1, g.o1], ["works_at", g.p2, g.o2], ["about", g.f1, g.ghee], ["about", g.f2, g.ghee],
    ["supported_by", g.f1, g.cl1], ["supported_by", g.f2, g.cl2], ["mentions", g.cl1, g.c1], ["mentions", g.cl1, g.c2], ["mentions", g.cl2, g.c2],
    // An outlet-anchored kind between two tenant-wide nodes (an outlet-2 waste recorded against a day): no outlet end → hidden.
    ["wasted", g.ghee, g.day],
  ] as Array<[string, string, string]>).map(([k, s, d]) => edge(k, s, d));
  expect((await intel(tok.A!, "edges:batch", { edges: gedges })).status).toBe(201);
  tok.A1 = await run(A, [o1]);
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

describe("graph:query outlet isolation (R-A 1)", () => {
  const names = (rows: Array<Record<string, unknown>>) => rows.map((r) => `${r.name}@${r.depth}`).sort();
  const N = { dosa: "Ghee Dosa", chut: "Ghee Chutney", onlyb: "Outlet Two Special", o1: "Outlet One", o2: "Outlet Two", p1: "Cook One", p2: "Cook Two",
    c1: "Guest", c2: "Guest Two", day: "Day 2026-10-08" };

  it("(4) neighbourhood of ghee: '*' sees 14 nodes; outlet 1 sees its 7 — no outlet 2, its cook, its customer, finding, claim, bridge item or waste day", async () => {
    const all = await query(tok.A!, "neighbourhood", { entity_id: g.ghee });
    expect(names(all.body.rows)).toEqual([`${N.dosa}@1`, `${N.chut}@1`, `finding:${g.f1}@1`, `finding:${g.f2}@1`, `${N.day}@1`, `${N.o1}@2`, `${N.o2}@2`,
      `claim:${g.cl1}@2`, `claim:${g.cl2}@2`, `${N.p1}@3`, `${N.p2}@3`, `${N.onlyb}@3`, `${N.c1}@3`, `${N.c2}@3`].sort());
    const one = await query(tok.A1!, "neighbourhood", { entity_id: g.ghee });
    expect([one.status, names(one.body.rows)]).toEqual([200, [`${N.dosa}@1`, `${N.chut}@1`, `finding:${g.f1}@1`, `${N.o1}@2`, `claim:${g.cl1}@2`,
      `${N.p1}@3`, `${N.c1}@3`].sort()]);
  });

  it("(4) price_shock_path: '*' reaches both outlets; outlet 1 reaches only its own", async () => {
    expect(names((await query(tok.A!, "price_shock_path", { ingredient_id: g.ghee })).body.rows))
      .toEqual([`${N.dosa}@1`, `${N.chut}@1`, `${N.o1}@2`, `${N.o2}@2`].sort());
    expect(names((await query(tok.A1!, "price_shock_path", { ingredient_id: g.ghee })).body.rows))
      .toEqual([`${N.dosa}@1`, `${N.chut}@1`, `${N.o1}@2`].sort());
  });

  it("(4) claim_support: outlet 1's finding → its claim and the outlet-1 customer only; outlet 2's finding → 0 rows ('*': 1 row)", async () => {
    const mine = await query(tok.A1!, "claim_support", { finding_id: g.f1 });
    expect(mine.body.rows.map((r: Record<string, unknown>) => [r.claim_id, r.relation, r.entity_name])).toEqual([[g.cl1, "supports", N.c1]]);
    const allMine = await query(tok.A!, "claim_support", { finding_id: g.f1 });
    expect(allMine.body.rows.map((r: Record<string, unknown>) => r.entity_name).sort()).toEqual([N.c1, N.c2].sort());
    expect((await query(tok.A!, "claim_support", { finding_id: g.f2 })).body.rows.length).toBe(1);
    expect((await query(tok.A1!, "claim_support", { finding_id: g.f2 })).body.rows).toEqual([]);
  });

  it("(4) a start node outlet 1 may not see → 0 rows (outlet 2, its cook, the bridge item's only path); its own → rows", async () => {
    for (const [t, a] of [["neighbourhood", { entity_id: g.o2 }], ["neighbourhood", { entity_id: g.p2 }], ["neighbourhood", { entity_id: g.c2 }],
      ["neighbourhood", { entity_id: g.f2 }], ["neighbourhood", { entity_id: g.onlyb }]] as const) {
      const r = await query(tok.A1!, t, a);
      expect([a, r.status, r.body.rows]).toEqual([a, 200, []]);
    }
    expect(names((await query(tok.A1!, "neighbourhood", { entity_id: g.o1, depth: 1 })).body.rows)).toEqual([`${N.dosa}@1`, `${N.p1}@1`].sort());
    expect((await query(tok.A1!, "supplier_dependency", { supplier_id: ids.mill })).body.rows.length).toBe(1);
  });

  it("(5) comments are kept and never bind: a `:name` in a `--` comment is not a parameter", () => {
    expect(bindNamedParams("-- :ghost is a comment\nSELECT :tenant_id::uuid -- and :ghost2\n").names).toEqual(["tenant_id"]);
    for (const [t, a] of [["price_shock_path", { ingredient_id: ids.rice }], ["dish_margin_drivers", { item_id: ids.dosa }],
      ["supplier_dependency", { supplier_id: ids.mill }], ["claim_support", { finding_id: ids.rice }], ["neighbourhood", { entity_id: ids.rice }]] as const) {
      const st = graphStatement(t, a, A.tenant, ["*"]);
      expect([t, st.text.includes("--"), st.values.includes(undefined)]).toEqual([t, true, false]);
    }
  });
});

