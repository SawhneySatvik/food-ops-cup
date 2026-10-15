// Wiring gate — GET /internal/intel/v1/brief-items through the real app (run token + service secret → munim_svc under the
// token's RLS). Embedded Postgres, no model. Synthetic data only. Expected values are hand values from the fixture built
// here (the canonical world's ingredient: 5 000 000 on hand, 9 000 000 minimum, so min_qty_milli outranks on_hand_milli
// at the same severity and confidence), never read back from the code under test.
//   (1) a brief run gets the items in rank order, the finding's stored texts, its impact ref, its draft; no dedupe key
//       anywhere in the body; an abstained finding is not an item
//   (2) paired refusals: an event run → 404 (accept: the brief run above); another tenant's brief run sees none of A's
//   (3) outlet scope comes from the token: an outlet-2 brief run sees no outlet-1 finding
//   (4) trace labels: a prose label → 422 (invalid_payload); a slug label → 201
import { createLogger } from "@munim/config";
import { Snapshot, snapRef } from "@munim/contracts";
import { BriefItemsResponse } from "@munim/contracts/internal";
import { type TestDb, uuidv7 } from "@munim/db";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalIdp } from "../src/auth/local-idp.ts";
import { createApp, type Deps } from "../src/app.ts";
import { svcTx, testKeys } from "../src/commit/testkit.ts";
import { configureInternal } from "../src/internal/index.ts";
import { mintRunToken, type OutletScope } from "../src/runtoken/index.ts";
import { openDb } from "./db.ts";
import { buildTenant, type Tenant } from "./world.ts";

const idp = createLocalIdp();
const keys = testKeys();
const SECRET = "brief-test-service-secret-not-real-0123456789abcdef";
let db: TestDb;
let pools: { core: pg.Pool; svc: pg.Pool };
let app: Awaited<ReturnType<typeof createApp>>;
let A: Tenant;
let B: Tenant;

type Res = Omit<Response, "json"> & { json(): Promise<any> };
const token = async (t: Tenant, scope: OutletScope, trigger: "brief" | "event") =>
  (await mintRunToken({ ...keys, svc: svcTx(db) }, { tenantId: t.tenant, outletScope: scope, trigger, actor: trigger === "brief" ? "brief" : "watcher:inventory_purchasing" })).token;
const call = async (tok: string, path: string, body?: unknown): Promise<Res> =>
  (await app.request(`/internal/intel/v1/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${tok}`, "x-munim-service-secret": SECRET, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })) as Res;

const F = { hi: "", lo: "", draft: "", snap: "", keyHi: "", keyLo: "", brief: "", briefOutlet2: "", briefB: "", event: "" };

const finding = (s: string, id: string, key: string, impactCol: string) => ({
  pack: "inventory_purchasing", type: "inventory.below_reorder", severity: "high", confidence_bp: 9000, dedupe_key: key,
  envelope: {
    finding_id: id, abstained: false, impact_ref: snapRef(s, 0, impactCol),
    segments: [{ text: `Stock of ⟨snap:${s}·0·ingredient_name⟩ is under its reorder level ⟨snap:${s}·0·min_qty_milli⟩.`, refs: [`snap:${s}`] }],
  },
});

beforeAll(async () => {
  db = await openDb();
  A = await buildTenant(db, "a");
  B = await buildTenant(db, "b");
  // The canonical world's placeholder finding has an empty envelope; store it as the abstention core would have written.
  for (const t of [A, B]) {
    await db.withContext("munim_svc", { tenant_id: t.tenant, outlet_ids: "*" }, (c) =>
      c.query(`UPDATE intel.finding SET envelope = $2, impact_snapshot_id = NULL, impact_row = NULL, impact_column = NULL WHERE id = $1`,
        [t.finding, { finding_id: t.finding, segments: [], impact_ref: null, abstained: true, reason_code: "count_missing" }]));
    // …and its proposed placeholder drafts are not part of this gate.
    await db.admin(`UPDATE core.draft SET status = 'rejected' WHERE tenant_id = $1 AND status = 'proposed'`, [t.tenant]).catch(() => undefined);
  }
  pools = { core: db.pool("munim_core", 4), svc: db.pool("munim_svc", 4) };
  const config = { nodeEnv: "test", redact: (s: string) => s };
  const deps: Deps = { pools, idp, storefronts: async () => null, config, log: createLogger(config, () => {}) };
  app = await createApp(deps);
  configureInternal(deps, { serviceSecret: SECRET, keys, watchWindowMs: 0, clock: () => new Date("2026-10-11T00:30:00Z") });
  F.brief = await token(A, [A.outlets[0]], "brief");
  F.briefOutlet2 = await token(A, [A.outlets[1]], "brief");
  F.briefB = await token(B, ["*"], "brief");
  F.event = await token(A, ["*"], "event");
  const snap = Snapshot.parse(await (await call(F.brief, "snapshots", { template_id: "inventory.below_reorder", params: {} })).json());
  F.snap = snap.snapshot_id;
  F.hi = uuidv7(); F.lo = uuidv7();
  F.keyHi = `below_reorder:min:${F.snap}`; F.keyLo = `below_reorder:on_hand:${F.snap}`;
  expect((await call(F.brief, "findings", finding(F.snap, F.lo, F.keyLo, "on_hand_milli"))).status).toBe(201);
  expect((await call(F.brief, "findings", finding(F.snap, F.hi, F.keyHi, "min_qty_milli"))).status).toBe(201);
  F.draft = uuidv7();
  const row = snap.rows[0]!;
  const d = await call(F.brief, "drafts", {
    draft_id: F.draft, pack: "inventory_purchasing", command_type: "inventory.reorder_level.set.v1",
    payload: { outlet_id: row.outlet_id, ingredient_id: row.ingredient_id, min_qty_milli: snapRef(F.snap, 0, "min_qty_milli"), par_qty_milli: snapRef(F.snap, 0, "par_qty_milli") },
    outlet_ids: [row.outlet_id], finding_id: F.hi, evidence: [`snap:${F.snap}`], based_on: [snapRef(F.snap, 0, "on_hand_milli")],
  });
  expect(d.status).toBe(201);
});

afterAll(async () => {
  await pools?.core.end();
  await pools?.svc.end();
  await db?.stop();
});

describe("GET brief-items", () => {
  it("(1) a brief run: items in rank order with stored texts, impact ref and draft; no dedupe key; the abstained finding is not an item", async () => {
    const r = await call(F.brief, "brief-items");
    expect(r.status).toBe(200);
    const text = await r.text();
    const body = BriefItemsResponse.parse(JSON.parse(text));
    // 9 000 000 × 9000 × urgency beats 5 000 000 × 9000 × urgency (same severity, same age).
    expect(body.items.map((i) => i.finding_id)).toEqual([F.hi, F.lo]);
    expect(body.items[0]).toEqual({
      finding_id: F.hi, pack: "inventory_purchasing", severity: "high", type: "inventory.below_reorder",
      texts: [`Stock of ⟨snap:${F.snap}·0·ingredient_name⟩ is under its reorder level ⟨snap:${F.snap}·0·min_qty_milli⟩.`],
      impact_ref: snapRef(F.snap, 0, "min_qty_milli"), draft_ids: [F.draft],
    });
    expect(body.items[1]!.draft_ids).toEqual([]);
    expect(text).not.toContain(F.keyHi);
    expect(text).not.toContain(F.keyLo);
    expect(text).not.toContain("dedupe");
  });

  it("(2) paired: an event run is refused 404 where the brief run got 200; another tenant's brief run sees none of A's findings", async () => {
    const r = await call(F.event, "brief-items");
    expect([r.status, (await r.json()).error.code]).toEqual([404, "not_found"]);
    const b = BriefItemsResponse.parse(await (await call(F.briefB, "brief-items")).json());
    expect(b.items).toEqual([]);
  });

  it("(3) outlet scope comes from the token: an outlet-2 brief run sees no outlet-1 finding", async () => {
    const r = await call(F.briefOutlet2, "brief-items");
    expect(r.status).toBe(200);
    expect(BriefItemsResponse.parse(await r.json()).items).toEqual([]);
  });
});

describe("(4) trace labels are labels", () => {
  const ev = (seq: number, label: string) => ({ id: uuidv7(), seq, parent_id: null, actor: "brief", at: new Date().toISOString(), kind: "tool_call", payload: { tool: label } });
  it("a prose label → 422 invalid_payload, nothing stored; a slug label → 201", async () => {
    const n = async () => Number((await db.admin(`SELECT count(*) n FROM intel.trace_event WHERE tenant_id = $1`, [A.tenant])).rows[0]!.n);
    const before = await n();
    const prose = await call(F.brief, "traces:batch", { events: [ev(1, "What needs me today? Net sales were down")] });
    expect([prose.status, (await prose.json()).error.code]).toEqual([422, "invalid_payload"]);
    const empty = await call(F.brief, "traces:batch", { events: [ev(1, "")] });
    expect(empty.status).toBe(422);
    expect(await n()).toBe(before);
    const slug = await call(F.brief, "traces:batch", { events: [ev(1, "read_below_reorder")] });
    expect(slug.status).toBe(201);
    expect(await n()).toBe(before + 1);
  });
});
