// T-040b gates — the batch writes of /internal/intel/v1 and the draft prose/pack rules, through the real app (run token
// + service secret → munim_svc under the token's RLS). Embedded Postgres, no model. Synthetic data only.
//   (1) 500 claims → 500 rows; the same 500 again → 0 inserted; a quote that is not its source → MB012, 0 rows
//   (6) a draft's free-text note with a digit → abstained number_grammar, 0 rows / plain text → proposed, 1 row
//   (7) draft pack `inventory` (not an F8 id) → 422, 0 rows / `inventory_purchasing` → 201
//   (8) W3.2 workflow draft (DECISIONS 11 Oct): ingestion's invoice — based_on [], every number a doc span, invoice_no
//       with digits (an identifier) → proposed; the same type from another pack → 422; two documents → two drafts and
//       the same document again → the first draft (the fingerprint holds the cited spans); a digit in a description → abstained
//   plus every other batch: idempotent by id, same id + other body → 409, refusals typed (never a 500).
// Expected counts are hand values (the batch sizes sent here, the canonical world's rows), never read from the code.
import { createHash } from "node:crypto";
import { createLogger } from "@munim/config";
import { Snapshot, snapRef } from "@munim/contracts";
import { BatchResponse, DraftsResponse, ForecastsBatchResponse, WikiBatchResponse } from "@munim/contracts/internal";
import { SPECIALIST_REGISTRY } from "@munim/contracts/intel";
import { loadRegistry } from "@munim/contracts/registry";
import { ownerCtx, type TestDb, uuidv7 } from "@munim/db";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalIdp } from "../src/auth/local-idp.ts";
import { createApp, type Deps, TENANT_HEADER } from "../src/app.ts";
import { svcTx, testKeys } from "../src/commit/testkit.ts";
import { configureInternal } from "../src/internal/index.ts";
import { proseLeafPaths } from "../src/internal/drafts.ts";
import { mintRunToken, type OutletScope } from "../src/runtoken/index.ts";
import { openDb } from "./db.ts";
import { buildTenant, type Tenant } from "./world.ts";

const keys = testKeys();
const idp = createLocalIdp();
const SECRET = "t040b-test-service-secret-not-real-0123456789abcdef";
const CLOCK = new Date("2026-10-11T08:00:00Z");
let db: TestDb;
let pools: { core: pg.Pool; svc: pg.Pool };
let app: Awaited<ReturnType<typeof createApp>>;
let A: Tenant;
let all = ""; // a '*' run of A
let one = ""; // a run of A scoped to outlet 1
let snap: Snapshot; // inventory.below_reorder minted by `one` (outlet 1)

type Res = Omit<Response, "json"> & { json(): Promise<any> };
const count = async (sql: string, params: unknown[] = []) => Number((await db.admin(sql, params)).rows[0]!.n);
const run = async (t: Tenant, scope: OutletScope) =>
  (await mintRunToken({ ...keys, svc: svcTx(db) }, { tenantId: t.tenant, outletScope: scope, trigger: "event", actor: "watcher:inventory_purchasing" })).token;
const intel = async (token: string, path: string, body: unknown): Promise<Res> =>
  (await app.request(`/internal/intel/v1/${path}`, {
    method: "POST", body: JSON.stringify(body),
    headers: { authorization: `Bearer ${token}`, "x-munim-service-secret": SECRET, "content-type": "application/json" },
  })) as Res;
const refusal = async (r: Res) => [r.status, (await r.json()).error.code];

beforeAll(async () => {
  db = await openDb();
  A = await buildTenant(db, "a");
  pools = { core: db.pool("munim_core", 4), svc: db.pool("munim_svc", 4) };
  const config = { nodeEnv: "test", redact: (s: string) => s };
  const deps: Deps = { pools, idp, storefronts: async () => null, config, log: createLogger(config, () => {}) };
  app = await createApp(deps);
  configureInternal(deps, { serviceSecret: SECRET, keys, watchWindowMs: 0, clock: () => CLOCK });
  all = await run(A, ["*"]);
  one = await run(A, [A.outlets[0]]);
  const r = await intel(one, "snapshots", { template_id: "inventory.below_reorder", params: {} });
  expect(r.status).toBe(201);
  snap = Snapshot.parse(await r.json());
  expect(snap.row_count).toBeGreaterThanOrEqual(1); // the world's ingredient: 5 000 000 on hand < 9 000 000 at outlet 1
});

afterAll(async () => {
  await pools?.core.end();
  await pools?.svc.end();
  await db?.stop();
});

// The canonical world's message body (db/src/world.ts): "Paneer from Simulated Dairy arrived at 7 am, two crates short."
const claim = (o: { id?: string; quote?: string; span?: [number, number] } = {}) => ({
  id: o.id ?? uuidv7(), chunk_id: A.chunk, message_id: null, span_start: o.span?.[0] ?? 0, span_end: o.span?.[1] ?? 6,
  quote: o.quote ?? "Paneer", subject_entity_id: null, predicate: "delivered_short", object: null, object_entity_id: null,
});
const claims = () => count(`SELECT count(*) n FROM intel.claim WHERE tenant_id = $1`, [A.tenant]);

describe("claims:batch (gate 1)", () => {
  it("500 claims → 201 inserted 500 = 500 new rows; the same batch again → inserted 0, existing 500, 0 new rows", async () => {
    const before = await claims();
    const batch = Array.from({ length: 500 }, () => claim());
    const first = await intel(all, "claims:batch", { claims: batch });
    expect(first.status).toBe(201);
    expect(BatchResponse.parse(await first.json())).toEqual({ inserted: 500, existing: 0 });
    expect(await claims()).toBe(before + 500);
    const again = await intel(all, "claims:batch", { claims: batch });
    expect([again.status, BatchResponse.parse(await again.json())]).toEqual([201, { inserted: 0, existing: 500 }]);
    expect(await claims()).toBe(before + 500);
    // run_id is the token's: every one of the 500 carries the run that sent the first batch.
    expect(await count(`SELECT count(DISTINCT run_id) n FROM intel.claim WHERE id = ANY ($1::uuid[])`, [batch.map((c) => c.id)])).toBe(1);
  });

  it("a quote that is not its source span → 422 claim_quote_mismatch (MB012) and the whole batch is refused (0 rows); the true span → 201", async () => {
    const before = await claims();
    const bad = await intel(all, "claims:batch", { claims: [claim(), claim({ quote: "Cheese" }), claim()] });
    expect(await refusal(bad)).toEqual([422, "claim_quote_mismatch"]);
    expect(await claims()).toBe(before);
    const good = await intel(all, "claims:batch", { claims: [claim({ quote: "Simulated Dairy", span: [12, 27] })] });
    expect([good.status, (await good.json()).inserted]).toEqual([201, 1]);
    expect(await claims()).toBe(before + 1);
  });

  it("the same id with another body → 409, nothing changes", async () => {
    const c = claim();
    expect((await intel(all, "claims:batch", { claims: [c] })).status).toBe(201);
    const other = await intel(all, "claims:batch", { claims: [{ ...c, predicate: "arrived_late" }] });
    expect(await refusal(other)).toEqual([409, "idempotency_conflict"]);
    expect(await count(`SELECT count(*) n FROM intel.claim WHERE id = $1 AND predicate = 'delivered_short'`, [c.id])).toBe(1);
  });
});

describe("knowledge batches: entities, aliases, chunks, edges, wiki, embeddings", () => {
  const e1 = uuidv7();
  const e2 = uuidv7();
  it("entities → 2 rows, retry 0; a core_ref already held by another entity → 409; aliases normalised by core", async () => {
    const ents = [{ id: e1, kind: "supplier", core_ref: null, name: "Simulated Mills" }, { id: e2, kind: "ingredient", core_ref: null, name: "Atta" }];
    expect(BatchResponse.parse(await (await intel(all, "entities:batch", { entities: ents })).json())).toEqual({ inserted: 2, existing: 0 });
    expect(BatchResponse.parse(await (await intel(all, "entities:batch", { entities: ents })).json())).toEqual({ inserted: 0, existing: 2 });
    // The world's 'Paneer' entity holds core.ingredient:<ingredient>.
    const dup = await intel(all, "entities:batch", { entities: [{ id: uuidv7(), kind: "ingredient", core_ref: `core.ingredient:${A.ingredient}`, name: "Paneer" }] });
    expect(await refusal(dup)).toEqual([409, "conflict"]);
    const a = { id: uuidv7(), entity_id: e1, alias: "  Sim   MILLS ", source: "claim" };
    expect((await intel(all, "aliases:batch", { aliases: [a] })).status).toBe(201);
    expect((await db.admin(`SELECT normalized FROM intel.alias WHERE id = $1`, [a.id])).rows[0]!.normalized).toBe("sim mills");
    const dangling = await intel(all, "aliases:batch", { aliases: [{ ...a, id: uuidv7(), entity_id: uuidv7() }] });
    expect(await refusal(dangling)).toEqual([422, "invalid_payload"]);
  });

  it("chunks carry the token's run; edges need provenance; a missing entity → 422 (never 500)", async () => {
    const ch = { id: uuidv7(), document_id: null, message_id: A.message, seq: 1, char_start: 0, text: "Synthetic second chunk." };
    expect((await intel(all, "chunks:batch", { chunks: [ch] })).status).toBe(201);
    expect(await count(`SELECT count(*) n FROM intel.chunk c JOIN intel.run r ON r.id = c.run_id AND r.trigger = 'event' WHERE c.id = $1`, [ch.id])).toBe(1);
    // At most one source: a document and a message both → 422.
    expect(await refusal(await intel(all, "chunks:batch", { chunks: [{ ...ch, id: uuidv7(), document_id: uuidv7() }] }))).toEqual([422, "invalid_payload"]);
    const edge = { id: uuidv7(), kind: "supplies", src_entity_id: e1, dst_entity_id: e2, claim_id: null, source_ref: `core.supplier:${A.supplier}`, valid_from: null, valid_to: null };
    expect(BatchResponse.parse(await (await intel(all, "edges:batch", { edges: [edge] })).json())).toEqual({ inserted: 1, existing: 0 });
    expect((await intel(all, "edges:batch", { edges: [{ ...edge, id: uuidv7(), claim_id: null, source_ref: null }] })).status).toBe(422);
    expect(await refusal(await intel(all, "edges:batch", { edges: [{ ...edge, id: uuidv7(), dst_entity_id: uuidv7() }] }))).toEqual([422, "invalid_payload"]);
  });

  it("wiki: a cited body → stored (current_version 1, not dirty); retry → existing; a free digit → abstained, nothing written; a skipped version → 409", async () => {
    const page = uuidv7();
    const cell = snapRef(snap.snapshot_id, 0, "ingredient_name");
    const p = (o: Record<string, unknown> = {}) => ({ page_id: page, entity_id: e2, kind: "ingredient", slug: `atta-${page.slice(-6)}`, title: "Atta",
      version_id: uuidv7(), version: 1, body: [{ text: `Stocked as ${cell}.`, refs: [`snap:${snap.snapshot_id}`] }], ...o });
    const v1 = p();
    const w = WikiBatchResponse.parse(await (await intel(all, "wiki:batch", { pages: [v1] })).json());
    expect(w.pages).toEqual([{ page_id: page, version: 1, status: "stored", reason_code: null }]);
    expect((await db.admin(`SELECT current_version, dirty FROM intel.wiki_page WHERE id = $1`, [page])).rows[0]).toEqual({ current_version: 1, dirty: false });
    expect(WikiBatchResponse.parse(await (await intel(all, "wiki:batch", { pages: [v1] })).json()).pages[0]!.status).toBe("existing");
    const digit = p({ version_id: uuidv7(), version: 2, body: [{ text: `Stocked 2 times as ${cell}.`, refs: [`snap:${snap.snapshot_id}`] }] });
    expect(WikiBatchResponse.parse(await (await intel(all, "wiki:batch", { pages: [digit] })).json()).pages[0]).toMatchObject({ status: "abstained", reason_code: "number_grammar" });
    expect(await count(`SELECT count(*) n FROM intel.wiki_version WHERE page_id = $1`, [page])).toBe(1);
    expect(await refusal(await intel(all, "wiki:batch", { pages: [p({ version_id: uuidv7(), version: 3 })] }))).toEqual([409, "conflict"]);
  });

  it("embeddings: 0013 (pgvector) is not applied on embedded Postgres → 503 unavailable (the success path is hosted-only, UNVERIFIED here)", async () => {
    const r = await intel(all, "embeddings:batch", { embeddings: [{ chunk_id: A.chunk, embedding_micro: Array.from({ length: 768 }, () => 500_000) }] });
    expect(await refusal(r)).toEqual([503, "unavailable"]);
    expect((await intel(all, "embeddings:batch", { embeddings: [{ chunk_id: A.chunk, embedding_micro: [500_000] }] })).status).toBe(422);
  });
});

describe("forecasts:batch, quotes:batch", () => {
  const fr = { id: uuidv7(), method: "weighted_seasonal_v1", trained_through: "2026-10-10", horizon_days: 7, holdout_days: 28, wape_bp: 1800, baseline_wape_bp: 2400, bias_bp: -150 };
  const pt = (o: Record<string, unknown> = {}) => ({ id: uuidv7(), outlet_id: A.outlets[0], item_id: A.item, business_on: "2026-10-11", slot_start: null,
    method: "weighted_seasonal_v1", qty_milli: 12000, lo_qty_milli: 9000, hi_qty_milli: 15000, inputs_snapshot_id: snap.snapshot_id, ...o });

  it("a run and 2 points at outlet 1 → 2 rows; retry → 0; a point at outlet 2 → 403; a snapshot outside the run's scope → 422; lo > qty → 422", async () => {
    const points = [pt(), pt({ business_on: "2026-10-12" })];
    const first = ForecastsBatchResponse.parse(await (await intel(one, "forecasts:batch", { forecast_run: fr, points })).json());
    expect(first).toEqual({ run_inserted: true, inserted: 2, existing: 0 });
    expect(ForecastsBatchResponse.parse(await (await intel(one, "forecasts:batch", { forecast_run: fr, points })).json())).toEqual({ run_inserted: false, inserted: 0, existing: 2 });
    expect(await count(`SELECT count(*) n FROM intel.forecast_point WHERE forecast_run_id = $1`, [fr.id])).toBe(2);
    expect(await refusal(await intel(one, "forecasts:batch", { forecast_run: fr, points: [pt({ outlet_id: A.outlets[1] })] }))).toEqual([403, "forbidden"]);
    // A '*' snapshot (the world's) is not citable by an outlet-1 run (R40 C4), though it is a row of the tenant (FK).
    expect(await refusal(await intel(one, "forecasts:batch", { forecast_run: fr, points: [pt({ inputs_snapshot_id: A.snapshot })] }))).toEqual([422, "cannot_verify"]);
    expect(await refusal(await intel(one, "forecasts:batch", { forecast_run: fr, points: [pt({ lo_qty_milli: 13000 })] }))).toEqual([422, "invalid_payload"]);
    expect(await count(`SELECT count(*) n FROM intel.forecast_point WHERE forecast_run_id = $1`, [fr.id])).toBe(2);
  });

  // The supplier's reply as an untrusted chunk of the `all` run (a negotiation stores it with chunks:batch first). Hand
  // spans in REPLY (74 characters), checked against the text by the first test.
  const REPLY = "Simulated supplier: 10 kg at INR 385.00 per kg, minimum 5 kg, net 15 days.";
  const SPANS = { unit_price_minor: [33, 39], qty_milli: [20, 22], min_order_qty_milli: [56, 57], payment_days: [66, 68] };
  const replyChunk = uuidv7();
  const otherRunsChunk = uuidv7(); // the same text, stored by another run (`one`)
  beforeAll(async () => {
    // A run-held chunk (0024): no document, no message — the reply the run received.
    const r = await intel(all, "chunks:batch", { chunks: [{ id: replyChunk, document_id: null, message_id: null, seq: 9, char_start: 0, text: REPLY }] });
    expect(r.status).toBe(201);
    const o = await intel(one, "chunks:batch", { chunks: [{ id: otherRunsChunk, document_id: null, message_id: null, seq: 10, char_start: 0, text: REPLY }] });
    expect(o.status).toBe(201);
  });

  it("quotes from the simulated supplier → stored; a real supplier → 422 (R22: simulated only), 0 rows", async () => {
    const real = uuidv7();
    await db.withContext("munim_core", ownerCtx(A, { command_type: "purchasing.supplier.upsert.v1" }), (c) =>
      c.query(`INSERT INTO core.supplier (tenant_id, id, name, kind) VALUES ($1, $2, 'Synthetic Real Supplier', 'real')`, [A.tenant, real]));
    const q = (supplier: string) => ({ id: uuidv7(), supplier_id: supplier, ingredient_id: A.ingredient, round: 1, qty_milli: 10000, unit: "kg",
      unit_price_minor: 38500, currency: "INR", min_order_qty_milli: 5000, payment_days: 15, terms: { delivery_days: 2, cold_chain: true }, trace_event_id: null,
      source_chunk_id: replyChunk, spans: SPANS });
    expect(Object.fromEntries(Object.entries(SPANS).map(([k, [s, e]]) => [k, REPLY.slice(s, e)])))
      .toEqual({ unit_price_minor: "385.00", qty_milli: "10", min_order_qty_milli: "5", payment_days: "15" });
    const ok = await intel(all, "quotes:batch", { quotes: [q(A.supplier)] });
    expect([ok.status, (await ok.json()).inserted]).toEqual([201, 1]);
    const before = await count(`SELECT count(*) n FROM intel.supplier_quote WHERE tenant_id = $1`, [A.tenant]);
    expect(await refusal(await intel(all, "quotes:batch", { quotes: [q(real)] }))).toEqual([422, "invalid_payload"]);
    expect(await count(`SELECT count(*) n FROM intel.supplier_quote WHERE tenant_id = $1`, [A.tenant])).toBe(before);
    // Supplier prose never rides in terms (flags, counts and codes only).
    expect((await intel(all, "quotes:batch", { quotes: [{ ...q(A.supplier), terms: { note: "Call me at 98…" } }] })).status).toBe(422);
  });

  it("quote provenance (R-C F3): a stored quote keeps its reply chunk and spans; another run's chunk, a span past the chunk's end, no span for a non-zero field or no source → 422, 0 rows", async () => {
    const q = (o: Record<string, unknown> = {}) => ({ id: uuidv7(), supplier_id: A.supplier, ingredient_id: A.ingredient, round: 1, qty_milli: 10000,
      unit: "kg", unit_price_minor: 38500, currency: "INR", min_order_qty_milli: 5000, payment_days: 15, terms: {}, trace_event_id: null,
      source_chunk_id: replyChunk, spans: SPANS, ...o });
    const good = q();
    const ok = await intel(all, "quotes:batch", { quotes: [good] });
    expect(ok.status).toBe(201);
    expect((await db.admin(`SELECT source_chunk_id::text AS c, spans FROM intel.supplier_quote WHERE id = $1`, [good.id])).rows)
      .toEqual([{ c: replyChunk, spans: SPANS }]);
    const before = await count(`SELECT count(*) n FROM intel.supplier_quote WHERE tenant_id = $1`, [A.tenant]);
    // The same reply text, but stored by another run: not this run's source.
    expect(await refusal(await intel(all, "quotes:batch", { quotes: [q({ source_chunk_id: otherRunsChunk })] }))).toEqual([422, "invalid_payload"]);
    expect(await refusal(await intel(all, "quotes:batch", { quotes: [q({ spans: { ...SPANS, payment_days: [66, REPLY.length + 1] } })] })))
      .toEqual([422, "invalid_payload"]);
    expect(await refusal(await intel(all, "quotes:batch", { quotes: [q({ spans: { ...SPANS, min_order_qty_milli: null } })] })))
      .toEqual([422, "invalid_payload"]);
    expect(await refusal(await intel(all, "quotes:batch", { quotes: [q({ source_chunk_id: undefined, spans: undefined })] }))).toEqual([422, "invalid_payload"]);
    expect(await count(`SELECT count(*) n FROM intel.supplier_quote WHERE tenant_id = $1`, [A.tenant])).toBe(before);
    // Paired accept: zero minimum order and payment days carry no span.
    const none = q({ min_order_qty_milli: 0, payment_days: 0, spans: { ...SPANS, min_order_qty_milli: null, payment_days: null } });
    expect((await intel(all, "quotes:batch", { quotes: [none] })).status).toBe(201);
    // Stored with no key for a zero field (0024's spans_match admits no null span).
    expect((await db.admin(`SELECT spans FROM intel.supplier_quote WHERE id = $1`, [none.id])).rows)
      .toEqual([{ spans: { unit_price_minor: SPANS.unit_price_minor, qty_milli: SPANS.qty_milli } }]);
    // A retry of the same null-span body is the stored row, not a conflict.
    expect(BatchResponse.parse(await (await intel(all, "quotes:batch", { quotes: [none] })).json())).toEqual({ inserted: 0, existing: 1 });
  });
});

describe("spend", () => {
  it("stamped by core's clock, run from the token; a currency other than the month's budget (INR) → 422, 0 rows", async () => {
    const e = { id: uuidv7(), role: "narrate", provider: "gemini", model_id: "gemini-3-flash", input_tokens: 900, output_tokens: 120, amount_minor: 40, currency: "INR" };
    expect(BatchResponse.parse(await (await intel(all, "spend", { entries: [e] })).json())).toEqual({ inserted: 1, existing: 0 });
    const row = (await db.admin(`SELECT at FROM intel.intel_spend WHERE id = $1`, [e.id])).rows[0]!;
    expect((row.at as Date).toISOString()).toBe(CLOCK.toISOString());
    expect(BatchResponse.parse(await (await intel(all, "spend", { entries: [e] })).json())).toEqual({ inserted: 0, existing: 1 });
    const aud = await intel(all, "spend", { entries: [{ ...e, id: uuidv7(), currency: "AUD" }] });
    expect(await refusal(aud)).toEqual([422, "currency_mismatch"]);
    expect(await count(`SELECT count(*) n FROM intel.intel_spend WHERE tenant_id = $1 AND currency = 'AUD'`, [A.tenant])).toBe(0);
  });
});

// A supplier return (inventory_purchasing): `note` is a prose leaf; qty is a ref; ids are the snapshot row's own cells.
// `basis` picks the based_on cell: another cell is another fingerprint, so two accepted proposals are two drafts.
const returnDraft = (note: string, pack = "inventory_purchasing", basis = "on_hand_milli") => ({
  draft_id: uuidv7(), pack, command_type: "purchasing.supplier_return.create.v1",
  payload: { supplier_return_id: uuidv7(), outlet_id: snap.rows[0]!.outlet_id, supplier_id: A.supplier, goods_received_id: null, reason_code: "damaged", note,
    lines: [{ batch_id: null, ingredient_id: snap.rows[0]!.ingredient_id, qty_milli: snapRef(snap.snapshot_id, 0, "on_hand_milli"), unit: "g" }] },
  outlet_ids: [snap.rows[0]!.outlet_id], finding_id: null, evidence: [`snap:${snap.snapshot_id}`], based_on: [snapRef(snap.snapshot_id, 0, basis)],
});
const drafts = () => count(`SELECT count(*) n FROM core.draft WHERE tenant_id = $1`, [A.tenant]);

describe("drafts: number grammar over prose leaves (gate 6), pack = an F8 id (gate 7)", () => {
  it("the prose leaves of every intel-proposable draftable = the hand list (4); imports.* are excepted (no specialist proposes them)", async () => {
    await loadRegistry();
    // Hand list (T-080's finding, read from the proposal schemas by eye): free strings a person reads on the draft. The
    // workflow invoice's `invoice_no` is an identifier (excepted by name, beside the coupon code); its description is prose.
    // customers.campaign.create.v1's `name` left with the campaign draftable (R-B S1-D ruling, 11 Oct) and is back with it
    // (R67, 16 Oct: the Customers desk proposes the demo win-back campaign), so a digit in it is refused like any other prose.
    const HAND = ["compliance.maintenance.schedule.v1:vendor_note", "customers.campaign.create.v1:name",
      "purchasing.invoice.record.v1:lines[].description", "purchasing.supplier_return.create.v1:note"];
    const proposable = [...new Set(SPECIALIST_REGISTRY.specialists.flatMap((s) => [...s.draftables, ...s.workflow_draftables]))];
    expect(proposable.length).toBeGreaterThan(10);
    expect(proposable.flatMap((t) => [...proseLeafPaths(t)].map((p) => `${t}:${p}`)).sort()).toEqual(HAND);
    expect(proposable.some((t) => t.startsWith("imports."))).toBe(false);
  });

  it("a note with a digit (planted) → abstained number_grammar, 0 new rows; a number word → abstained; plain text → proposed, 1 new row", async () => {
    const before = await drafts();
    for (const note of ["Return 3 crates, they arrived warm.", "Return three crates, they arrived warm."]) {
      const r = await intel(one, "drafts", returnDraft(note));
      expect([r.status, DraftsResponse.parse(await r.json()).reason_code]).toEqual([201, "number_grammar"]);
    }
    expect(await drafts()).toBe(before);
    const ok = await intel(one, "drafts", returnDraft("The crates arrived warm; return them."));
    expect([ok.status, DraftsResponse.parse(await ok.json()).status]).toEqual([201, "proposed"]);
    expect(await drafts()).toBe(before + 1);
  });

  it("pack `inventory` (the world builder's placeholder, not an F8 id) → 422, 0 rows; `inventory_purchasing` → accepted", async () => {
    const before = await drafts();
    expect(await refusal(await intel(one, "drafts", returnDraft("The seal was broken; return it.", "inventory", "min_qty_milli")))).toEqual([422, "invalid_payload"]);
    expect(await drafts()).toBe(before);
    const ok = await intel(one, "drafts", returnDraft("The seal was broken; return it.", "inventory_purchasing", "min_qty_milli"));
    expect([ok.status, DraftsResponse.parse(await ok.json()).status]).toEqual([201, "proposed"]);
    expect(await drafts()).toBe(before + 1);
  });
});

// Ingestion's supplier-invoice draft (T-056): a document whose text is stored as chunks; each number is a span of it.
const PAGE = "Steady Dairy (simulated supplier)\nTax invoice INV-1042\nPaneer 12 kg 340.00 204.00\n";
const span = (doc: string, text: string) => { const i = PAGE.indexOf(text); return `⟨cite:doc:${doc}·${i}-${i + text.length}⟩`; };
async function invoiceDocument(): Promise<string> {
  const doc = uuidv7();
  await db.admin(`INSERT INTO core.document (tenant_id, id, kind, media_type, byte_size, sha256, storage_ref) VALUES ($1, $2, 'supplier_invoice', 'image/png', 10, $3, $4)`,
    [A.tenant, doc, createHash("sha256").update(doc).digest("hex"), `fixture:${doc}`]);
  const r = await intel(all, "chunks:batch", { chunks: [{ id: uuidv7(), document_id: doc, message_id: null, seq: 0, char_start: 0, text: PAGE }] });
  expect(r.status).toBe(201);
  return doc;
}
const invoiceDraft = (doc: string, over: { pack?: string; description?: string | null; invoice_no?: string; unit?: string } = {}) => ({
  draft_id: uuidv7(), pack: over.pack ?? "inventory_purchasing", command_type: "purchasing.invoice.record.v1",
  payload: { supplier_invoice_id: uuidv7(), supplier_id: A.supplier, invoice_no: over.invoice_no ?? "INV-1042", invoice_date: "2026-10-09", po_id: null, currency: A.currency,
    lines: [{ line_id: uuidv7(), po_line_id: null, ingredient_id: over.description === undefined ? A.ingredient : null, description: over.description ?? null,
      qty_milli: span(doc, "12"), unit: over.unit ?? "kg", unit_price_minor: span(doc, "340.00"), tax_minor: span(doc, "204.00") }] },
  outlet_ids: [], finding_id: null, evidence: [`doc:${doc}`], based_on: [],
});

describe("workflow draft: ingestion's supplier invoice (gate 8)", () => {
  it("based_on [] with doc-span numbers and invoice_no 'INV-1042' (digits: an identifier) → proposed, 1 row stored as sent", async () => {
    const doc = await invoiceDocument();
    const before = await drafts();
    const d = invoiceDraft(doc);
    const r = await intel(all, "drafts", d);
    expect([r.status, DraftsResponse.parse(await r.json())]).toEqual([201, { draft_id: d.draft_id, status: "proposed", reason_code: null }]);
    expect(await drafts()).toBe(before + 1);
    const row = (await db.admin(`SELECT source, status, command_payload, based_on FROM core.draft WHERE id = $1`, [d.draft_id])).rows[0]!;
    expect([row.source, row.status, row.command_payload, row.based_on]).toEqual(["intel:inventory_purchasing", "proposed", d.payload, []]);
  });

  it("the same workflow type from another pack → 422, 0 rows; a normal draft with based_on [] → 422 (contracts), 0 rows", async () => {
    const doc = await invoiceDocument();
    const before = await drafts();
    expect(await refusal(await intel(all, "drafts", invoiceDraft(doc, { pack: "finance" })))).toEqual([422, "invalid_payload"]);
    expect(await refusal(await intel(one, "drafts", { ...returnDraft("The crates arrived warm; return them all."), based_on: [] }))).toEqual([422, "invalid_payload"]);
    expect(await drafts()).toBe(before);
  });

  it("two documents → two drafts; the same document's draft again (new draft id) → the first draft's id, 0 new rows", async () => {
    const [d1, d2] = [await invoiceDocument(), await invoiceDocument()];
    const before = await drafts();
    const first = invoiceDraft(d1);
    const ids = [];
    for (const d of [first, invoiceDraft(d2), { ...first, draft_id: uuidv7() }]) ids.push(DraftsResponse.parse(await (await intel(all, "drafts", d)).json()).draft_id);
    expect(ids[0]).toBe(first.draft_id);
    expect(ids[1]).not.toBe(first.draft_id);
    expect(ids[2]).toBe(first.draft_id);
    expect(await drafts()).toBe(before + 2);
  });

  it("an unlinked line's description with a quantity in it → abstained number_grammar, 0 rows; the bare name → proposed", async () => {
    const doc = await invoiceDocument();
    const before = await drafts();
    const bad = await intel(all, "drafts", invoiceDraft(doc, { description: "Paneer 12 kg" }));
    expect(DraftsResponse.parse(await bad.json())).toMatchObject({ status: "abstained", reason_code: "number_grammar" });
    expect(await drafts()).toBe(before);
    const ok = await intel(all, "drafts", invoiceDraft(doc, { description: "Paneer" }));
    expect(DraftsResponse.parse(await ok.json()).status).toBe("proposed");
    expect(await drafts()).toBe(before + 1);
  });
});

describe("workflow draft: approval fails closed until the approver types each document number (R26)", () => {
  const approve = async (draftId: string, edited: Record<string, unknown> | null) =>
    (await app.request(`/v1/drafts/${draftId}:approve`, {
      method: "POST",
      headers: { Authorization: `Bearer ${idp.sign({ sub: A.ownerSub })}`, [TENANT_HEADER]: A.tenant, "Content-Type": "application/json" },
      body: JSON.stringify({ command_id: uuidv7(), idempotency_key: `approve-${uuidv7()}`, type: "drafts.approve.v1",
        payload: { draft_id: draftId, command_type: "purchasing.invoice.record.v1", edited_payload: edited, reason: edited ? "Typed from the page" : null } }),
    })) as Res;
  const invoices = () => count(`SELECT count(*) n FROM core.supplier_invoice WHERE tenant_id = $1 AND invoice_no = 'INV-2001'`, [A.tenant]);

  it("approve as proposed → 422 cannot_verify (a span is not a cell), 0 invoices; the owner's typed numbers → executed under the owner", async () => {
    const doc = await invoiceDocument();
    const d = invoiceDraft(doc, { invoice_no: "INV-2001", unit: "g" });
    expect(DraftsResponse.parse(await (await intel(all, "drafts", d)).json()).status).toBe("proposed");
    const asProposed = await approve(d.draft_id, null);
    expect([asProposed.status, (await asProposed.json()).error.code]).toEqual([422, "cannot_verify"]);
    expect(await invoices()).toBe(0);
    expect((await db.admin(`SELECT status FROM core.draft WHERE id = $1`, [d.draft_id])).rows[0]!.status).toBe("proposed");
    const line = d.payload.lines[0]!;
    const typed = { ...d.payload, lines: [{ ...line, qty_milli: { value: 12000, typed_by: A.owner }, unit_price_minor: { value: 34000, typed_by: A.owner },
      tax_minor: { value: 20400, typed_by: A.owner } }] };
    const ok = await approve(d.draft_id, typed);
    expect(ok.status, JSON.stringify(await ok.clone().json())).toBe(200);
    expect(await invoices()).toBe(1);
    const dec = (await db.admin(`SELECT verdict, decided_by FROM core.decision WHERE draft_id = $1`, [d.draft_id])).rows[0]!;
    expect([dec.verdict, dec.decided_by]).toEqual(["edited", A.owner]);
  });
});
