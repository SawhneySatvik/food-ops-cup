// T-040 gates — the internal intel API and the seven /v1 reads it feeds, through the real app (run token + service
// secret → munim_svc under the token's RLS; member token → munim_core under the member's RLS). Embedded Postgres,
// recorded nothing (no model is called). Synthetic data only.
//   (1) free digit → abstained + reason          (2) bare-number draft → 422; with refs → 201
//   (3) cross-tenant / out-of-scope ref → refused (4) a 500-event trace batch is gapless
//   (5) same id + body → byte-identical; other body → 409
//   (6) open duplicate → the existing id, 0 new rows (another row of the same template → a new draft)
//   (7) rejected fingerprint at 29 days → recently_rejected; at 31 days → accepted
//   (8) each public route: ≥ 1 fixture row, 0 rows of another outlet
// Expected counts are hand values from the fixture built here (2 below-reorder rows at outlet 1, …), never read back
// from the code under test.
import { createLogger } from "@munim/config";
import { Snapshot, snapRef } from "@munim/contracts";
import { DraftsResponse, EventsClaimResponse, FindingsResponse, AnswersResponse, TracesBatchResponse, WatchClaimResponse } from "@munim/contracts/internal";
import { FindingsListResponse, InboxResponse, RunsListResponse, RunView, TracesResponse } from "@munim/contracts/intel";
import { ModelRoleList } from "@munim/contracts/platform";
import { ownerCtx, type TestDb, uuidv7 } from "@munim/db";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalIdp } from "../src/auth/local-idp.ts";
import { createApp, TENANT_HEADER, type Deps } from "../src/app.ts";
import { svcTx, testKeys } from "../src/commit/testkit.ts";
import { ENDED_GRACE_S } from "../src/internal/auth.ts";
import { configureInternal } from "../src/internal/index.ts";
import { endRun, mintRunToken, type OutletScope } from "../src/runtoken/index.ts";
import { openDb } from "./db.ts";
import { buildTenant, type Tenant } from "./world.ts";

const idp = createLocalIdp();
const keys = testKeys();
const SECRET = "t040-test-service-secret-not-real-0123456789abcdef";
let db: TestDb;
let pools: { core: pg.Pool; svc: pg.Pool };
let deps: Deps;
let app: Awaited<ReturnType<typeof createApp>>;
let A: Tenant;
let B: Tenant;
const ing2 = uuidv7();

type Res = Omit<Response, "json"> & { json(): Promise<any> };
const one = async <R extends pg.QueryResultRow>(sql: string, params: unknown[] = []) => (await db.admin(sql, params)).rows[0] as R;
const count = async (sql: string, params: unknown[] = []) => Number((await one<{ n: string }>(sql, params)).n);

async function run(t: Tenant, scope: OutletScope, actor = "watcher:inventory_purchasing") {
  return (await mintRunToken({ ...keys, svc: svcTx(db) }, { tenantId: t.tenant, outletScope: scope, trigger: "event", actor }));
}
const intel = async (token: string, path: string, body?: unknown, o: { secret?: string; method?: string } = {}): Promise<Res> =>
  (await app.request(`/internal/intel/v1/${path}`, {
    method: o.method ?? "POST",
    headers: { authorization: `Bearer ${token}`, "x-munim-service-secret": o.secret ?? SECRET, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })) as Res;
const asMember = async (t: Tenant, sub: string, path: string, body?: unknown): Promise<Res> =>
  (await app.request(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${idp.sign({ sub })}`, [TENANT_HEADER]: t.tenant, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })) as Res;

async function mint(token: string): Promise<Snapshot> {
  const r = await intel(token, "snapshots", { template_id: "inventory.below_reorder", params: {} });
  expect(r.status).toBe(201);
  return Snapshot.parse(await r.json());
}

const segment = (s: string) => ({
  text: `Stock of ⟨snap:${s}·0·ingredient_name⟩ is under its reorder level ⟨snap:${s}·0·min_qty_milli⟩.`, refs: [`snap:${s}`],
});
const findingBody = (s: string, o: { id?: string; text?: string; key?: string; refs?: string[] } = {}) => {
  const id = o.id ?? uuidv7();
  return {
    pack: "inventory_purchasing", type: "inventory.below_reorder", severity: "high", confidence_bp: 9000,
    dedupe_key: o.key ?? `below_reorder:${s}`,
    envelope: { finding_id: id, segments: [o.text ? { text: o.text, refs: o.refs ?? [`snap:${s}`] } : segment(s)], impact_ref: snapRef(s, 0, "on_hand_milli"), abstained: false },
  };
};
/** A reorder-level proposal for row `row` of below_reorder snapshot `s` (ids are that row's own cells). */
const draftBody = (s: Snapshot, row: number, o: { id?: string; finding?: string | null; min?: unknown } = {}) => ({
  draft_id: o.id ?? uuidv7(), pack: "inventory_purchasing", command_type: "inventory.reorder_level.set.v1",
  payload: { outlet_id: s.rows[row]!.outlet_id, ingredient_id: s.rows[row]!.ingredient_id,
    min_qty_milli: o.min ?? snapRef(s.snapshot_id, row, "min_qty_milli"), par_qty_milli: snapRef(s.snapshot_id, row, "par_qty_milli") },
  outlet_ids: [s.rows[row]!.outlet_id], finding_id: o.finding ?? null, evidence: [`snap:${s.snapshot_id}`],
  based_on: [snapRef(s.snapshot_id, row, "on_hand_milli")],
});
const drafts = () => count(`SELECT count(*) n FROM core.draft WHERE tenant_id = $1`, [A.tenant]);

// Shared across the ordered describes below.
const F = { runA: "", tokA: "", runB: "", tokB: "", snapA: null as unknown as Snapshot, snapB: null as unknown as Snapshot, findingA: "", findingB: "", draftA: "", draftA2: "", draftB: "" };

beforeAll(async () => {
  db = await openDb();
  A = await buildTenant(db, "a");
  B = await buildTenant(db, "b");
  // A second ingredient at outlet 1 with a reorder level and no stock: below_reorder at outlet 1 = 2 rows (the world's
  // ingredient, 5 000 000 on hand < 9 000 000, and this one, 0 < 1 000).
  await db.withContext("munim_core", ownerCtx(A, { command_type: "inventory.ingredient.upsert.v1" }), (c) =>
    c.query(`INSERT INTO core.ingredient (tenant_id, id, name, base_unit) VALUES ($1, $2, 'Synthetic cumin', 'g')`, [A.tenant, ing2]));
  await db.withContext("munim_core", ownerCtx(A, { command_type: "inventory.reorder_level.set.v1" }), (c) =>
    c.query(`INSERT INTO core.reorder_level (tenant_id, id, outlet_id, ingredient_id, min_qty_milli, par_qty_milli) VALUES ($1, $2, $3, $4, 1000, 5000)`,
      [A.tenant, uuidv7(), A.outlets[0], ing2]));
  // The canonical world carries placeholder intel rows a reader cannot render: its finding's envelope is `{segments: []}`.
  // Replace it (munim_svc's own UPDATE grant) with a stored abstention, as core would have written it.
  for (const t of [A, B]) {
    await db.withContext("munim_svc", { tenant_id: t.tenant, outlet_ids: "*" }, (c) =>
      c.query(`UPDATE intel.finding SET envelope = $2, impact_snapshot_id = NULL, impact_row = NULL, impact_column = NULL WHERE id = $1`,
        [t.finding, { finding_id: t.finding, segments: [], impact_ref: null, abstained: true, reason_code: "count_missing" }]));
  }
  // Test-only template (this clone): one outlet's reorder levels, by an `outlet_id` param — exercises the scope rule.
  await db.admin(`INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES ('test.t040_outlet_levels', 1, $1, $2, $3, 'manager')`, [
    `SELECT r.outlet_id, r.ingredient_id, r.min_qty_milli FROM core.reorder_level r WHERE r.outlet_id = :outlet_id::uuid ORDER BY r.ingredient_id`,
    JSON.stringify({ type: "object", required: ["outlet_id"], additionalProperties: false, properties: { outlet_id: { type: "string" } } }),
    JSON.stringify([{ name: "outlet_id", type: "uuid" }, { name: "ingredient_id", type: "uuid" }, { name: "min_qty_milli", type: "integer", numeric_source: "core.reorder_level.min_qty_milli" }]),
  ]);
  pools = { core: db.pool("munim_core", 8), svc: db.pool("munim_svc", 4) };
  const config = { nodeEnv: "test", redact: (s: string) => s };
  deps = { pools, idp, storefronts: async () => null, config, log: createLogger(config, () => {}) };
  app = await createApp(deps);
  configureInternal(deps, { serviceSecret: SECRET, keys, watchWindowMs: 60_000 });
  // …and a proposed draft with a `{}` payload (its second one is already rejected): rejected by the owner through the real route.
  for (const t of [A, B]) {
    for (const d of t.drafts) {
      if ((await one<{ status: string }>(`SELECT status FROM core.draft WHERE id = $1`, [d])).status !== "proposed") continue;
      const r = await asMember(t, t.ownerSub, `/v1/drafts/${d}:reject`, {
        command_id: uuidv7(), idempotency_key: `t040-${d}`, type: "drafts.reject.v1", payload: { draft_id: d, reason: "Fixture placeholder" } });
      expect(r.status).toBe(200);
    }
  }
  ({ token: F.tokA, claims: { run_id: F.runA } } = await run(A, [A.outlets[0]]));
  ({ token: F.tokB, claims: { run_id: F.runB } } = await run(A, [A.outlets[1]]));
});

afterAll(async () => {
  await pools?.core.end();
  await pools?.svc.end();
  await db?.stop();
});

describe("auth: service secret + run token, scope only from the token", () => {
  it("a wrong secret, no token, a token of an ended run → the same 404; an unconfigured app → 503", async () => {
    const { token, claims } = await run(A, ["*"]);
    expect((await intel(token, "events:claim", { event_id: uuidv7() })).status).toBe(200);
    const wrong = await intel(token, "events:claim", { event_id: uuidv7() }, { secret: "x".repeat(48) });
    const none = (await app.request("/internal/intel/v1/events:claim", { method: "POST", headers: { "x-munim-service-secret": SECRET }, body: "{}" })) as Res;
    await endRun({ svc: svcTx(db) }, A.tenant, claims.run_id);
    const ended = await intel(token, "events:claim", { event_id: uuidv7() });
    for (const r of [wrong, none, ended]) expect([r.status, (await r.json()).error.code]).toEqual([404, "not_found"]);
    const bare = await createApp({ ...deps });
    const r = await bare.request("/internal/intel/v1/events:claim", { method: "POST", headers: { authorization: `Bearer ${F.tokA}`, "x-munim-service-secret": SECRET }, body: "{}" });
    expect(r.status).toBe(503);
  });

  it("an ended run: its spend and traces are taken for ENDED_GRACE_S more, never past it; every other route refuses it at once (404)", async () => {
    const { token, claims } = await run(A, ["*"]);
    await endRun({ svc: svcTx(db) }, A.tenant, claims.run_id);
    const spend = (id = uuidv7()) => ({ entries: [{ id, role: "reason", provider: "gemini", model_id: "gemini-3.8-flash", input_tokens: 900, output_tokens: 120, amount_minor: 0, currency: "INR" }] });
    const trace = (seq: number) => ({ events: [{ id: uuidv7(), seq, parent_id: null, actor: "specialist:inventory_purchasing", at: new Date().toISOString(), kind: "tool_call", payload: { tool: "read_below_reorder" } }] });
    // Core's wait ended (here: just now); intel's late flush still lands, under the same run.
    expect((await intel(token, "spend", spend())).status).toBe(201);
    expect((await intel(token, "traces:batch", trace(1))).status).toBe(201);
    // No other route widens: an answer, a draft, a snapshot, a claim and the run-frame are the same 404 as before.
    for (const [path, method] of [["answers", "POST"], ["drafts", "POST"], ["snapshots", "POST"], ["events:claim", "POST"], ["run-frame", "GET"]] as const) {
      const r = await intel(token, path, method === "POST" ? {} : undefined, { method });
      expect([path, r.status, (await r.json()).error.code]).toEqual([path, 404, "not_found"]);
    }
    // Past the window (ended_at moved back by hand): spend and traces are refused too, and nothing more is stored.
    await db.admin(`UPDATE intel.run SET ended_at = now() - make_interval(secs => $2) WHERE id = $1`, [claims.run_id, ENDED_GRACE_S + 5]);
    for (const r of [await intel(token, "spend", spend()), await intel(token, "traces:batch", trace(2))]) {
      expect([r.status, (await r.json()).error.code]).toEqual([404, "not_found"]);
    }
    expect(await count(`SELECT count(*) n FROM intel.intel_spend WHERE run_id = $1`, [claims.run_id])).toBe(1);
    expect(await count(`SELECT count(*) n FROM intel.trace_event WHERE run_id = $1`, [claims.run_id])).toBe(1);
  });

  it("events:claim: first 200, repeat 409 (1 row); watch:claim: go, then not within the window, another pack goes", async () => {
    const ev = uuidv7();
    const first = await intel(F.tokA, "events:claim", { event_id: ev });
    expect(first.status).toBe(200);
    expect(EventsClaimResponse.parse(await first.json()).event_id).toBe(ev);
    expect((await intel(F.tokA, "events:claim", { event_id: ev })).status).toBe(409);
    expect(await count(`SELECT count(*) n FROM intel.event_claim WHERE event_id = $1`, [ev])).toBe(1);
    const w1 = WatchClaimResponse.parse(await (await intel(F.tokA, "watch:claim", { pack: "inventory_purchasing" })).json());
    const w2 = WatchClaimResponse.parse(await (await intel(F.tokA, "watch:claim", { pack: "inventory_purchasing" })).json());
    const w3 = WatchClaimResponse.parse(await (await intel(F.tokA, "watch:claim", { pack: "finance" })).json());
    expect([w1.go, w1.last_run_at, w2.go, w3.go]).toEqual([true, null, false, true]);
    expect(w2.last_run_at).not.toBeNull();
  });

  it("model-roles: platform.model_role as rows (R36), read with a run token", async () => {
    const r = await intel(F.tokA, "model-roles", undefined, { method: "GET" });
    expect(r.status).toBe(200);
    const roles = ModelRoleList.parse(await r.json());
    // Hand value: the six roles 0015 seeds (router, extract, narrate, reason, vision, embed).
    expect(roles.items.map((x) => x.role).sort()).toEqual(["embed", "extract", "narrate", "reason", "router", "vision"]);
    // R47 D1: unpriced until the operator approves a price; the three fields are always present.
    expect(roles.items.every((x) => x.input_price_per_mtok_minor === null && x.output_price_per_mtok_minor === null && x.price_currency === null)).toBe(true);
    await db.admin(`UPDATE platform.model_role SET input_price_per_mtok_minor = 1500, output_price_per_mtok_minor = 6000, price_currency = 'INR' WHERE role = 'narrate'`);
    const priced = ModelRoleList.parse(await (await intel(F.tokA, "model-roles", undefined, { method: "GET" })).json());
    expect(priced.items.find((x) => x.role === "narrate")).toMatchObject({ input_price_per_mtok_minor: 1500, output_price_per_mtok_minor: 6000, price_currency: "INR" });
    await db.admin(`UPDATE platform.model_role SET input_price_per_mtok_minor = NULL, output_price_per_mtok_minor = NULL, price_currency = NULL WHERE role = 'narrate'`);
  });
});

describe("snapshots, findings, answers (validator: gates 1 and 3)", () => {
  it("a run mints under its own outlet scope: outlet 1 → 2 rows (hand value), every row outlet 1", async () => {
    F.snapA = await mint(F.tokA);
    F.snapB = await mint(F.tokB);
    expect(F.snapA.row_count).toBe(2);
    expect(F.snapA.rows.map((r) => r.outlet_id)).toEqual([A.outlets[0], A.outlets[0]]);
    expect(F.snapA.rows.map((r) => r.ingredient_id)).toEqual([A.ingredient, ing2].sort()); // the template orders by ingredient id
    expect(F.snapB.rows.map((r) => r.outlet_id)).toEqual([A.outlets[1]]);
    expect([F.snapA.run_id, F.snapA.outlet_scope]).toEqual([F.runA, [A.outlets[0]]]);
    // A tenant_id param, an unknown template, an operator template → refused.
    expect((await intel(F.tokA, "snapshots", { template_id: "inventory.below_reorder", params: { tenant_id: B.tenant } })).status).toBe(422);
    expect((await intel(F.tokA, "snapshots", { template_id: "no.such_template", params: {} })).status).toBe(404);
    expect((await intel(F.tokA, "snapshots", { template_id: "platform.spend_by_tenant", params: {} })).status).toBe(404);
  });

  it("an outlet param is intersected with the minter's scope (R40 C4): outside → 403, inside → 201 (run and member)", async () => {
    const levels = (o: string) => ({ template_id: "test.t040_outlet_levels", params: { outlet_id: o } });
    const inside = await intel(F.tokA, "snapshots", levels(A.outlets[0]));
    expect([inside.status, Snapshot.parse(await inside.json()).row_count]).toEqual([201, 2]);
    expect((await intel(F.tokA, "snapshots", levels(A.outlets[1]))).status).toBe(403);
    const mine = await asMember(A, A.managerSub, "/v1/snapshots", levels(A.outlets[0]));
    expect([mine.status, Snapshot.parse(await mine.json()).row_count]).toEqual([201, 2]);
    expect((await asMember(A, A.managerSub, "/v1/snapshots", levels(A.outlets[1]))).status).toBe(403);
    expect((await asMember(A, A.managerSub, "/v1/snapshots", { template_id: "test.t040_outlet_levels", params: {} })).status).toBe(422);
  });

  it("(1) a valid finding is stored; a free digit → abstained number_grammar, stored without the prose", async () => {
    const ok = await intel(F.tokA, "findings", findingBody(F.snapA.snapshot_id, { key: `t040:a:${A.outlets[0]}` }));
    expect(ok.status).toBe(201);
    const stored = FindingsResponse.parse(await ok.json());
    expect([stored.outcome, stored.reason_code]).toEqual(["stored", null]);
    F.findingA = stored.finding_id;
    // As intel's Pydantic models send it: an unset Optional arrives as `reason_code: null` (accepted, not a 422).
    const fromPydantic = findingBody(F.snapB.snapshot_id, { key: `t040:b:${A.outlets[1]}` });
    const fb = FindingsResponse.parse(await (await intel(F.tokB, "findings", { ...fromPydantic, envelope: { ...fromPydantic.envelope, reason_code: null } })).json());
    expect(fb.outcome).toBe("stored");
    F.findingB = fb.finding_id;

    const digit = findingBody(F.snapA.snapshot_id, { text: `Stock is 5 kg under ⟨snap:${F.snapA.snapshot_id}·0·min_qty_milli⟩.`, key: "t040:digit" });
    const r = FindingsResponse.parse(await (await intel(F.tokA, "findings", digit)).json());
    expect([r.outcome, r.reason_code]).toEqual(["abstained", "number_grammar"]);
    const row = await one<{ envelope: { segments: unknown[]; abstained: boolean; reason_code: string }; outlet_ids: string[] }>(
      `SELECT envelope, outlet_ids FROM intel.finding WHERE id = $1`, [digit.envelope.finding_id]);
    expect(row.envelope).toMatchObject({ segments: [], abstained: true, reason_code: "number_grammar" });
    expect(JSON.stringify(row.envelope)).not.toContain("5 kg");
    expect(row.outlet_ids).toEqual([A.outlets[0]]);

    const words = AnswersResponse.parse(await (await intel(F.tokA, "answers", { question: "Why is stock short?",
      envelope: { answer_id: uuidv7(), segments: [{ text: `Five crates are missing at ⟨snap:${F.snapA.snapshot_id}·0·outlet_id⟩.`, refs: [`snap:${F.snapA.snapshot_id}`] }], abstained: false } })).json());
    expect([words.abstained, words.reason_code]).toEqual([true, "number_grammar"]);
    const good = AnswersResponse.parse(await (await intel(F.tokA, "answers", { question: "Why is stock short?",
      envelope: { answer_id: uuidv7(), segments: [segment(F.snapA.snapshot_id)], abstained: false } })).json());
    expect([good.abstained, good.reason_code]).toEqual([false, null]);
  });

  it("a re-detection with the same dedupe key merges into the open finding (0 new rows)", async () => {
    const before = await count(`SELECT count(*) n FROM intel.finding WHERE tenant_id = $1`, [A.tenant]);
    const again = FindingsResponse.parse(await (await intel(F.tokA, "findings", findingBody(F.snapA.snapshot_id, { key: `t040:a:${A.outlets[0]}` }))).json());
    expect([again.finding_id, again.outcome]).toEqual([F.findingA, "merged"]);
    expect(await count(`SELECT count(*) n FROM intel.finding WHERE tenant_id = $1`, [A.tenant])).toBe(before);
  });

  it("(3) a ref into another tenant, another outlet's snapshot, a non-tenant table or a forged ref → refused, nothing usable stored", async () => {
    const pgId = uuidv7();
    const forged = uuidv7();
    const { token: tokOther } = await run(B, ["*"]);
    const other = await mint(tokOther);
    const cases: Array<[string, ReturnType<typeof findingBody>]> = [
      ["other tenant", findingBody(other.snapshot_id, { key: "t040:x1" })],
      ["other outlet", findingBody(F.snapB.snapshot_id, { key: "t040:x2" })],
      ["pg_catalog", findingBody(F.snapA.snapshot_id, { key: "t040:x3", text: `See ⟨cite:row:pg_catalog.pg_authid:${pgId}⟩ now.`, refs: [`row:pg_catalog.pg_authid:${pgId}`] })],
      // Forged refs inside the run's own tenant: a snapshot that exists nowhere, a row out of range, a column the template lacks.
      ["no such snapshot", findingBody(forged, { key: "t040:x4" })],
      ["row out of range", findingBody(F.snapA.snapshot_id, { key: "t040:x5", text: `Short by ⟨snap:${F.snapA.snapshot_id}·99·min_qty_milli⟩ here.` })],
      ["no such column", findingBody(F.snapA.snapshot_id, { key: "t040:x6", text: `Short by ⟨snap:${F.snapA.snapshot_id}·0·no_such_column⟩ here.` })],
    ];
    for (const [name, body] of cases) {
      const r = FindingsResponse.parse(await (await intel(F.tokA, "findings", body)).json());
      expect([name, r.outcome, r.reason_code]).toEqual([name, "abstained", "unresolved_ref"]);
    }
    const before = await drafts();
    const d = DraftsResponse.parse(await (await intel(F.tokA, "drafts", { ...draftBody(F.snapA, 0), based_on: [snapRef(other.snapshot_id, 0, "on_hand_milli")] })).json());
    expect([d.status, d.reason_code]).toEqual(["abstained", "unresolved_ref"]);
    expect(await drafts()).toBe(before);
  });
});

describe("drafts (gates 2, 5, 6, 7)", () => {
  it("(2) a bare number in the payload → 422, 0 rows; with refs → 201 proposed, source intel:<pack>, expected copied", async () => {
    const before = await drafts();
    const bare = await intel(F.tokA, "drafts", draftBody(F.snapA, 0, { min: 5000, finding: F.findingA }));
    expect([bare.status, (await bare.json()).error.code]).toEqual([422, "invalid_payload"]);
    expect(await drafts()).toBe(before);
    const body = draftBody(F.snapA, 0, { finding: F.findingA });
    const ok = await intel(F.tokA, "drafts", body);
    expect(ok.status).toBe(201);
    expect(DraftsResponse.parse(await ok.json())).toEqual({ draft_id: body.draft_id, status: "proposed", reason_code: null });
    F.draftA = body.draft_id;
    const row = await one<{ source: string; status: string; run_id: string; based_on: Array<{ ref: string; expected: unknown }> }>(
      `SELECT source, status, run_id, based_on FROM core.draft WHERE id = $1`, [F.draftA]);
    expect(row).toMatchObject({ source: "intel:inventory_purchasing", status: "proposed", run_id: F.runA });
    expect(row.based_on).toEqual([expect.objectContaining({ ref: body.based_on[0], expected: F.snapA.rows[0]!.on_hand_milli })]);
    expect(await drafts()).toBe(before + 1);
    // Refused: a draft outside the run's scope (403); a pack that is not a specialist or may not propose this command,
    // and a cited finding of another specialist (422, F8 registry).
    expect((await intel(F.tokA, "drafts", draftBody(F.snapB, 0))).status).toBe(403);
    const kitchen = FindingsResponse.parse(await (await intel(F.tokA, "findings", { ...findingBody(F.snapA.snapshot_id, { key: "t040:kitchen" }), pack: "kitchen", type: "kitchen.ticket_drift" })).json());
    expect(kitchen.outcome).toBe("stored");
    for (const bad of [{ pack: "finance" }, { pack: "manager" }, { pack: "inventory" }, { finding_id: kitchen.finding_id }]) {
      const r = await intel(F.tokA, "drafts", { ...draftBody(F.snapA, 0), ...bad });
      expect([JSON.stringify(bad), r.status]).toEqual([JSON.stringify(bad), 422]);
    }
    expect((await intel(F.tokA, "findings", { ...findingBody(F.snapA.snapshot_id, { key: "t040:nopack" }), pack: "inventory" })).status).toBe(422);
    expect(await drafts()).toBe(before + 1);
  });

  it("(5) same id + same body → byte-identical response; same id + another body → 409", async () => {
    const body = draftBody(F.snapB, 0);
    const first = await intel(F.tokB, "drafts", body);
    const again = await intel(F.tokB, "drafts", body);
    const t1 = await first.text();
    expect([first.status, again.status]).toEqual([201, 201]);
    expect(await again.text()).toBe(t1);
    F.draftB = body.draft_id;
    const changed = await intel(F.tokB, "drafts", { ...body, evidence: [...body.evidence, `snap:${F.snapB.snapshot_id}`] });
    expect([changed.status, (await changed.json()).error.code]).toEqual([409, "idempotency_conflict"]);
    expect(await count(`SELECT count(*) n FROM core.draft WHERE id = $1`, [body.draft_id])).toBe(1);
  });

  it("(6) the same proposal from a NEW run on a NEW snapshot → the open draft's id, 0 new rows; another row → a new draft", async () => {
    const { token } = await run(A, [A.outlets[0]]);
    const fresh = await mint(token);
    expect(fresh.snapshot_id).not.toBe(F.snapA.snapshot_id);
    const before = await drafts();
    const dup = DraftsResponse.parse(await (await intel(token, "drafts", draftBody(fresh, 0))).json());
    expect(dup).toEqual({ draft_id: F.draftA, status: "proposed", reason_code: null });
    expect(await drafts()).toBe(before);
    // Negative control: same template, params and outlet, the other ingredient's row → its own draft.
    const body = draftBody(fresh, 1);
    const other = DraftsResponse.parse(await (await intel(token, "drafts", body)).json());
    expect(other).toEqual({ draft_id: body.draft_id, status: "proposed", reason_code: null });
    expect(await drafts()).toBe(before + 1);
    F.draftA2 = body.draft_id;
  });

  it("(7) a person rejects it → the same fingerprint is recently_rejected at 29 days (0 rows), accepted at 31", async () => {
    const r = await asMember(A, A.ownerSub, `/v1/drafts/${F.draftA}:reject`, {
      command_id: uuidv7(), idempotency_key: `t040-reject-${F.draftA}`, type: "drafts.reject.v1", payload: { draft_id: F.draftA, reason: "Par is fine" } });
    expect(r.status).toBe(200);
    const propose = async () => {
      const { token } = await run(A, [A.outlets[0]]);
      const body = draftBody(await mint(token), 0);
      return { body, res: DraftsResponse.parse(await (await intel(token, "drafts", body)).json()) };
    };
    const before = await drafts();
    const now = await propose();
    expect([now.res.status, now.res.reason_code]).toEqual(["abstained", "recently_rejected"]);
    await db.admin(`UPDATE core.decision SET decided_at = now() - interval '29 days' WHERE draft_id = $1`, [F.draftA]);
    const d29 = await propose();
    expect([d29.res.status, d29.res.reason_code]).toEqual(["abstained", "recently_rejected"]);
    expect(await drafts()).toBe(before);
    await db.admin(`UPDATE core.decision SET decided_at = now() - interval '31 days' WHERE draft_id = $1`, [F.draftA]);
    const d31 = await propose();
    expect(d31.res).toEqual({ draft_id: d31.body.draft_id, status: "proposed", reason_code: null });
    expect(await drafts()).toBe(before + 1);
  });
});

describe("(4) traces:batch", () => {
  const ev = (seq: number, id = uuidv7()) => ({ id, seq, parent_id: null, actor: "specialist:inventory_purchasing", at: new Date().toISOString(), kind: "tool_call", payload: { tool: "read_below_reorder" } });

  it("500 events in one batch → 500 rows, seq 1..500 with no gap; a retried batch inserts 0; a gap → 409", async () => {
    const batch = Array.from({ length: 500 }, (_, i) => ev(i + 1)).reverse(); // order on the wire does not matter
    const r = await intel(F.tokA, "traces:batch", { events: batch });
    expect(r.status).toBe(201);
    expect(TracesBatchResponse.parse(await r.json())).toEqual({ inserted: 500, last_seq: 500 });
    const s = await one<{ n: string; lo: number; hi: number; d: string }>(
      `SELECT count(*) n, min(seq) lo, max(seq) hi, count(DISTINCT seq) d FROM intel.trace_event WHERE run_id = $1`, [F.runA]);
    expect([Number(s.n), s.lo, s.hi, Number(s.d)]).toEqual([500, 1, 500, 500]);
    expect(TracesBatchResponse.parse(await (await intel(F.tokA, "traces:batch", { events: batch })).json())).toEqual({ inserted: 0, last_seq: 500 });
    const gap = await intel(F.tokA, "traces:batch", { events: [ev(502)] });
    expect([gap.status, (await gap.json()).error.code]).toEqual([409, "sequence_gap"]);
    const clash = await intel(F.tokA, "traces:batch", { events: [ev(500)] });
    expect(clash.status).toBe(409);
    expect(TracesBatchResponse.parse(await (await intel(F.tokB, "traces:batch", { events: [ev(1)] })).json())).toEqual({ inserted: 1, last_seq: 1 });
  });
});

describe("(8) the public reads: ≥ 1 fixture row each, 0 rows of another outlet (outlet-1 manager)", () => {
  const mgr = (path: string, body?: unknown) => asMember(A, A.managerSub, path, body);

  it("GET /v1/findings and GET /v1/inbox", async () => {
    const f = FindingsListResponse.parse(await (await mgr("/v1/findings")).json());
    const ids = f.items.map((x) => x.finding_id);
    expect(ids).toContain(F.findingA);
    expect(ids).not.toContain(F.findingB);
    const fa = f.items.find((x) => x.finding_id === F.findingA)!;
    // Values beside refs come from the snapshot cells (R26).
    expect(fa.resolved_refs).toContainEqual({ ref: snapRef(F.snapA.snapshot_id, 0, "on_hand_milli"), value: F.snapA.rows[0]!.on_hand_milli });

    const inbox = InboxResponse.parse(await (await mgr("/v1/inbox")).json());
    const keys = inbox.items.map((i) => (i.kind === "finding" ? i.finding.finding_id : i.draft.draft_id));
    expect(keys).toEqual(expect.arrayContaining([F.findingA, F.draftA2]));
    for (const other of [F.findingB, F.draftB, F.draftA]) expect(keys).not.toContain(other); // B's outlet; draftA is rejected
    const owner = InboxResponse.parse(await (await asMember(A, A.ownerSub, "/v1/inbox")).json());
    expect(owner.items.map((i) => (i.kind === "finding" ? i.finding.finding_id : i.draft.draft_id))).toEqual(expect.arrayContaining([F.findingB, F.draftB]));
  });

  it("GET /v1/snapshots/{id} and POST /v1/snapshots (member mint, R40 C4)", async () => {
    const mine = await mgr(`/v1/snapshots/${F.snapA.snapshot_id}`);
    expect(mine.status).toBe(200);
    expect(Snapshot.parse(await mine.json()).row_count).toBe(2);
    expect((await mgr(`/v1/snapshots/${F.snapB.snapshot_id}`)).status).toBe(404);
    expect((await asMember(B, B.ownerSub, `/v1/snapshots/${F.snapA.snapshot_id}`)).status).toBe(404);
    const minted = await mgr("/v1/snapshots", { template_id: "inventory.below_reorder", params: {} });
    expect(minted.status).toBe(201);
    const s = Snapshot.parse(await minted.json());
    expect([s.row_count, s.minted_by_member_id, s.run_id, s.outlet_scope]).toEqual([2, A.manager, null, [A.outlets[0]]]);
    expect(s.rows.every((r) => r.outlet_id === A.outlets[0])).toBe(true);
    expect((await mgr("/v1/snapshots", { template_id: "inventory.below_reorder", params: { outlet_id: A.outlets[1] } })).status).toBe(422);
    // One min_role ladder (staff < manager < advisor < owner): a manager cannot mint an advisor-level finance template;
    // the owner can (M-C1bc finding: a second ladder in evidence/mint.ts ranked advisor = staff).
    const pnl = { template_id: "finance.pnl", params: { period_month: "2026-09-01", group_by: "outlet" } };
    expect((await mgr("/v1/snapshots", pnl)).status).toBe(404);
    expect((await asMember(A, A.ownerSub, "/v1/snapshots", pnl)).status).toBe(201);
  });

  it("GET /v1/runs, GET /v1/runs?finding=, GET /v1/runs/{id}", async () => {
    const list = RunsListResponse.parse(await (await mgr("/v1/runs")).json());
    expect(list.items.map((r) => r.run_id)).toContain(F.runA);
    expect(list.items.map((r) => r.run_id)).not.toContain(F.runB);
    expect(list.items.every((r) => r.outlet_scope.every((o) => o === A.outlets[0]))).toBe(true);
    const byFinding = RunsListResponse.parse(await (await mgr(`/v1/runs?finding=${F.findingA}`)).json());
    expect(byFinding.items.map((r) => r.run_id)).toEqual([F.runA]);
    expect(RunsListResponse.parse(await (await mgr(`/v1/runs?finding=${F.findingB}`)).json()).items).toEqual([]);
    const one = await mgr(`/v1/runs/${F.runA}`);
    expect(RunView.parse(await one.json()).run_id).toBe(F.runA);
    expect((await mgr(`/v1/runs/${F.runB}`)).status).toBe(404);
  });

  it("GET /v1/traces/{run}", async () => {
    const t = TracesResponse.parse(await (await mgr(`/v1/traces/${F.runA}?limit=100`)).json());
    expect(t.events.map((e) => e.seq)).toEqual(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(t.next_after_seq).toBe(100);
    const tail = TracesResponse.parse(await (await mgr(`/v1/traces/${F.runA}?after_seq=450`)).json());
    expect([tail.events.length, tail.next_after_seq]).toEqual([50, null]);
    expect((await mgr(`/v1/traces/${F.runB}`)).status).toBe(404);
  });
});
