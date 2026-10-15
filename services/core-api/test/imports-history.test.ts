// h-1 gates — dated synthetic history through the approved-import path (R44 b, c; R28; 0018). Through the real app
// (member auth → RLS → book guard) and the core-worker parse job:
//   parse: each history fixture → rows_ok, quarantine reasons, the file's total and the staged total = the hand-written
//     key (services/core-worker/test/fixtures/imports/history/KEY.json); 0 book rows before approval;
//   commit: hand-valued orders, lines, tenders, refunds, voids, entries, postings, movements and waste for each kind;
//   refusals: an owner's own imports.run.commit.v1 → MB001; core.write_derived judged by the guard (no bypass), never
//     executable by munim_svc; a period closed between preview and approval → 409 period_closed, nothing written;
//   equivalence: the batched commit and the per-row seams path write the same rows, postings, origins and audit entries;
//   round trips: a 1,000-bill batched commit sends ≤ 40 queries (the seams path: ~32 a bill).
// Red-proofs: services/core-api/test/redproof-history.sh (MUNIM_H1_PLANT, test-side only). Synthetic data only.
import { appendFileSync, mkdirSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@munim/config";
import { ImportRunRowsResponse, ImportRunView, ImportsUploadResponse } from "@munim/contracts/imports";
import { buildWorld, type TestDb, uuidv7, type World } from "@munim/db";
import type { Hono } from "hono";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalIdp } from "../src/auth/local-idp.ts";
import { parsePendingImports } from "../../core-worker/src/imports/index.ts";
import { type AppEnv, createApp, TENANT_HEADER } from "../src/app.ts";
import { executeCommand } from "../src/commit/index.ts";
import { type BlobStore, commitRun, localBlobStore, parseRun } from "../src/modules/imports/index.ts";
import { CHUNK, type WriteMode } from "../src/modules/imports/write.ts";
import { openDb } from "./db.ts";
import { posExportV1, timeCommit } from "./imports-timing.ts";

const FIXTURES = join(import.meta.dirname, "../../core-worker/test/fixtures/imports/history");
type KeyEntry = { country: "IN" | "AU"; kind: string; parser: string; rows_ok: number; control_total_minor: number | null;
  staged_total_minor: number | null; quarantine: Record<string, string> };
const KEY = JSON.parse(await readFile(join(FIXTURES, "KEY.json"), "utf8")) as { files: Record<string, KeyEntry>; after_bills_1: Record<string, KeyEntry> };
/** Test-side plants for redproof-history.sh; never read by production code. */
const PLANT = process.env.MUNIM_H1_PLANT ?? "";
const PLANTS = ["", "book-row-early", "draft-only-off", "item-exists", "no-close", "equivalence", "seams-timing", "svc-execute"];
if (!PLANTS.includes(PLANT)) throw new Error(`MUNIM_H1_PLANT: unknown plant ${PLANT}`);

const idp = createLocalIdp();
let db: TestDb;
let pools: { core: pg.Pool; svc: pg.Pool };
let app: Hono<AppEnv>;
let blobDir: string;

type Who = "owner" | "staff";
interface Tenant { w: World; subs: Record<Who, string> }
const T = {} as Record<"IN" | "AU", Tenant>;
const RUNS = new Map<string, { run: string; draft: string }>();

const ownerCtx = (w: World, command_type?: string) => ({ tenant_id: w.tenant, outlet_ids: "*" as const, role: "owner" as const, member_id: w.owner,
  ...(command_type ? { command_type } : {}) });

/** The canonical world (which carries its pack's chart) + IdP subjects and the pack's aggregators as channels. */
async function tenant(x: TestDb, country: "IN" | "AU"): Promise<Tenant> {
  const w = await buildWorld(x, { country });
  const t: Tenant = { w, subs: { owner: `owner-${uuidv7()}`, staff: `staff-${uuidv7()}` } };
  await x.withContext("munim_core", ownerCtx(w, "tenancy.member.invite.v1"), async (c) => {
    await c.query(`UPDATE core.member SET idp_sub = $2 WHERE id = $1`, [w.owner, t.subs.owner]);
    await c.query(`UPDATE core.member SET idp_sub = $2 WHERE id = $1`, [w.staff, t.subs.staff]);
  });
  await x.withContext("munim_core", ownerCtx(w, "tenancy.channel.create.v1"), async (c) => {
    for (const code of country === "IN" ? ["swiggy", "zomato"] : ["ubereats", "doordash"]) {
      await c.query(`INSERT INTO core.channel (tenant_id, id, name, kind) VALUES ($1, $2, $3, $4)`, [w.tenant, uuidv7(), `Synthetic ${code}`, `aggregator:${code}`]);
    }
  });
  return t;
}

type Res = Omit<Response, "json"> & { json(): Promise<any> };
const call = async (country: "IN" | "AU", who: Who, method: string, path: string, body?: unknown): Promise<Res> =>
  (await app.request(path, {
    method,
    headers: { Authorization: `Bearer ${idp.sign({ sub: T[country].subs[who] })}`, [TENANT_HEADER]: T[country].w.tenant, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })) as Res;
const upload = async (country: "IN" | "AU", kind: string, file: string) => call(country, "owner", "POST", "/v1/imports/documents",
  { kind, filename: file, media_type: "text/csv", content_base64: (await readFile(join(FIXTURES, file))).toString("base64") });
const parse = (country: "IN" | "AU") => parsePendingImports({ pool: pools.svc, blobs: localBlobStore(blobDir), log: () => {} }, [T[country].w.tenant]);
const approve = (country: "IN" | "AU", who: Who, draft: string, reason: string | null = null) =>
  call(country, who, "POST", `/v1/drafts/${draft}:approve`, {
    command_id: uuidv7(), idempotency_key: `h1-${uuidv7()}`, type: "drafts.approve.v1",
    payload: { draft_id: draft, command_type: "imports.run.commit.v1", edited_payload: null, reason },
  });
const rows = async <R extends pg.QueryResultRow>(sql: string, params: unknown[] = []) => (await db.admin(sql, params)).rows as R[];
const count = async (sql: string, params: unknown[] = []) => Number((await rows<{ n: string }>(sql, params))[0]!.n);

/** Book rows a run's approval would write, across every table a history commit touches (orders and their children by
 *  the order's snapshot; waste by the run's decision). Derived rows hang off these, so 0 here is 0 everywhere. */
const bookRows = (run: string) => count(
  `WITH o AS (SELECT id FROM core."order" WHERE pricing_snapshot ->> 'import_run_id' = $1::text)
   SELECT (SELECT count(*) FROM o) + (SELECT count(*) FROM core.order_line WHERE order_id IN (SELECT id FROM o))
        + (SELECT count(*) FROM core.tender WHERE order_id IN (SELECT id FROM o)) + (SELECT count(*) FROM core.refund WHERE order_id IN (SELECT id FROM o))
        + (SELECT count(*) FROM core.void WHERE order_id IN (SELECT id FROM o))
        + (SELECT count(*) FROM core.waste_log w JOIN core.import_run r ON r.tenant_id = w.tenant_id AND r.id = $1::text::uuid AND w.origin ->> 'decision_id' = r.decision_id::text) AS n`,
  [run]);

beforeAll(async () => {
  db = await openDb();
  T.IN = await tenant(db, "IN");
  T.AU = await tenant(db, "AU");
  pools = { core: db.pool("munim_core", 8), svc: db.pool("munim_svc", 2) };
  blobDir = await mkdtemp(join(tmpdir(), "munim-h1-"));
  const config = { nodeEnv: "test", redact: (s: string) => s };
  app = await createApp({ pools, idp, storefronts: async () => null, blobs: localBlobStore(blobDir), config, log: createLogger(config, () => {}) });
});

afterAll(async () => {
  await pools?.core.end();
  await pools?.svc.end();
  await db?.stop();
  if (blobDir) await rm(blobDir, { recursive: true, force: true });
});

async function parseAgainstKey(file: string, k: KeyEntry) {
  const up = await upload(k.country, k.kind, file);
  expect(up.status).toBe(200);
  const u = ImportsUploadResponse.parse(await up.json());
  expect(u).toMatchObject({ duplicate: false, header: null, run: { status: "parsing", parser: k.parser } });
  expect(await parse(k.country)).toEqual({ previewed: 1, failed: 0, skipped: 0, errors: 0 });
  const run = ImportRunView.parse(await (await call(k.country, "owner", "GET", `/v1/imports/runs/${u.run!.import_run_id}`)).json());
  expect(run).toMatchObject({
    status: "previewed", rows_ok: k.rows_ok, rows_quarantined: Object.keys(k.quarantine).length, control_total_minor: k.control_total_minor,
    total_matches: k.control_total_minor === null ? null : k.control_total_minor === k.staged_total_minor,
  });
  const r = ImportRunRowsResponse.parse(await (await call(k.country, "owner", "GET", `/v1/imports/runs/${run.import_run_id}/rows`)).json());
  expect(Object.fromEntries(r.quarantined.map((q) => [String(q.row_no), q.reason_code]))).toEqual(k.quarantine);
  expect(r.staged).toHaveLength(k.rows_ok);
  if (k.staged_total_minor === null) expect(r.staged.every((s) => s.amount_minor === null)).toBe(true);
  else expect(r.staged.reduce((a, s) => a + s.amount_minor!, 0)).toBe(k.staged_total_minor);
  if (PLANT === "book-row-early" && file === "synthetic_bills_1.csv") {
    // Plant: one book row tied to the run before anyone approved it.
    await db.withContext("munim_core", ownerCtx(T.IN.w, "orders.place.v1"), (c) => c.query(
      `INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, kind, status, business_date, subtotal_minor, total_minor, currency, pricing_snapshot)
       VALUES ($1, $2, $3, $4, 'takeaway', 'placed', current_date, 100, 100, 'INR', $5)`,
      [T.IN.w.tenant, uuidv7(), T.IN.w.outlets[0], T.IN.w.channel, { import_run_id: run.import_run_id }]));
  }
  expect(await bookRows(run.import_run_id)).toBe(0);
  RUNS.set(file, { run: run.import_run_id, draft: run.draft_id! });
}

describe("parse: each history file → rows_ok, quarantine reasons and totals = the hand-written key; nothing in the books", () => {
  it("the key covers every history fixture and plants ≥ 20 bad rows", async () => {
    expect(Object.keys(KEY.files).sort()).toEqual(["synthetic_bills_1.csv", "synthetic_bills_2.csv", "synthetic_bills_au.csv", "synthetic_bills_sept.csv",
      "synthetic_pos_d4.csv", "synthetic_waste_1.csv"]);
    expect(Object.values(KEY.files).reduce((n, k) => n + Object.keys(k.quarantine).length, 0)).toBeGreaterThanOrEqual(20);
  });

  it.each(Object.keys(KEY.files).sort())("%s", async (file) => {
    if (PLANT === "item-exists" && file === "synthetic_bills_2.csv") {
      // Plant: the item the file names exists after all → row 2 is no longer quarantined.
      await db.withContext("munim_core", ownerCtx(T.IN.w, "catalogue.item.upsert.v1"), (c) =>
        c.query(`INSERT INTO core.item (tenant_id, id, kind, name_key, category) VALUES ($1, $2, 'dish', 'menu.no_such_dish', 'mains')`, [T.IN.w.tenant, uuidv7()]));
    }
    if (PLANT === "no-close" && file === "synthetic_waste_1.csv") {
      // Plant: the closed month is gone (superuser, triggers off on this clone) → row 9 is no longer quarantined.
      await db.admin(`SET session_replication_role = replica; DELETE FROM core.period_close WHERE tenant_id = '${T.IN.w.tenant}'; SET session_replication_role = origin`);
    }
    await parseAgainstKey(file, KEY.files[file]!);
  });
});

describe("commit on approval: hand-valued, under the approver's decision", () => {
  it("staff cannot approve a history import (404: the tenant-wide draft is outside their outlets); nothing written", async () => {
    const r = RUNS.get("synthetic_bills_1.csv")!;
    expect((await approve("IN", "staff", r.draft)).status).toBe(404);
    expect(await bookRows(r.run)).toBe(0);
  });

  it("an owner's own imports.run.commit.v1 cannot write an order line or a waste entry (draft-only → MB001)", async () => {
    if (PLANT === "draft-only-off") await db.admin(`UPDATE core.command_authority SET draft_only = false WHERE command_type = 'imports.run.commit.v1'`);
    const w = T.IN.w;
    const own = (sql: string, params: unknown[]) => db.withContext("munim_core", ownerCtx(w, "imports.run.commit.v1"), (c) => c.query(sql, params))
      .then(() => "accepted", (e: { code?: string }) => e.code);
    const line = await own(`INSERT INTO core.order_line (tenant_id, id, outlet_id, order_id, line_no, item_id, qty_milli, unit_price_minor)
                            VALUES ($1, $2, $3, $4, 99, $5, 1000, 100)`, [w.tenant, uuidv7(), w.outlets[0], w.orders[0], w.item]);
    const waste = await own(`INSERT INTO core.waste_log (tenant_id, id, outlet_id, ingredient_id, qty_milli, unit, reason, recorded_by)
                             VALUES ($1, $2, $3, $4, 1000, 'g', 'damaged', $5)`, [w.tenant, uuidv7(), w.outlets[0], w.ingredient, w.owner]);
    expect([line, waste]).toEqual(["MB001", "MB001"]);
  });

  it("synthetic_bills_1: 5 bills → orders on their own dates (no invoice number), lines, split tenders, refunds, voids", async () => {
    const r = RUNS.get("synthetic_bills_1.csv")!;
    expect(await bookRows(r.run)).toBe(0);
    const res = await approve("IN", "owner", r.draft);
    expect(res.status).toBe(200);
    const w = T.IN.w;
    const dec = (await rows<{ d: string }>(`SELECT decision_id::text AS d FROM core.import_run WHERE id = $1`, [r.run]))[0]!.d;
    const O = `SELECT id FROM core."order" WHERE pricing_snapshot ->> 'import_run_id' = $1::text`;
    expect(await rows(
      `SELECT o.external_ref AS bill, o.business_date::text AS bd, o.status, o.kind, o.subtotal_minor::int AS sub, o.discount_minor::int AS disc,
              o.tax_minor::int AS tax, o.total_minor::int AS total, o.invoice_no, o.ticket_no, ch.kind AS channel, o.customer_id IS NOT NULL AS customer,
              o.brand_id IS NOT NULL AS brand, ou.name AS outlet, to_char(o.created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS at,
              o.origin ->> 'kind' AS origin, o.origin ->> 'decision_id' = $2 AS by_decision, o.pricing_snapshot ->> 'synthetic' AS synthetic
         FROM core."order" o JOIN core.channel ch ON ch.tenant_id = o.tenant_id AND ch.id = o.channel_id JOIN core.outlet ou ON ou.tenant_id = o.tenant_id AND ou.id = o.outlet_id
        WHERE o.id IN (${O}) ORDER BY o.external_ref`, [r.run, dec])).toEqual([
      { bill: "SYN-H-0001", bd: "2026-10-01", status: "completed", kind: "dine_in", sub: 72000, disc: 0, tax: 3600, total: 75600, invoice_no: null, ticket_no: 1,
        channel: "counter", customer: true, brand: true, outlet: "Outlet 1", at: "2026-10-01 13:05", origin: "decision", by_decision: true, synthetic: "true" },
      { bill: "SYN-H-0002", bd: "2026-10-01", status: "completed", kind: "delivery", sub: 32000, disc: 0, tax: 1600, total: 33600, invoice_no: null, ticket_no: 1,
        channel: "aggregator:swiggy", customer: false, brand: false, outlet: "Outlet 3", at: "2026-10-01 20:30", origin: "decision", by_decision: true, synthetic: "true" },
      { bill: "SYN-H-0003", bd: "2026-10-02", status: "completed", kind: "takeaway", sub: 64000, disc: 2000, tax: 3100, total: 65100, invoice_no: null, ticket_no: 1,
        channel: "counter", customer: false, brand: false, outlet: "Outlet 3", at: "2026-10-02 09:15", origin: "decision", by_decision: true, synthetic: "true" },
      // 02:30 is before the 04:00 cutoff: the instant is the next calendar day, the business date is the bill's.
      { bill: "SYN-H-0004", bd: "2026-10-02", status: "cancelled", kind: "takeaway", sub: 32000, disc: 0, tax: 1600, total: 33600, invoice_no: null, ticket_no: 2,
        channel: "counter", customer: false, brand: false, outlet: "Outlet 3", at: "2026-10-03 02:30", origin: "decision", by_decision: true, synthetic: "true" },
      { bill: "SYN-H-0005", bd: "2026-10-01", status: "completed", kind: "pickup", sub: 24000, disc: 0, tax: 1200, total: 25200, invoice_no: null, ticket_no: 1,
        channel: "counter", customer: false, brand: false, outlet: "Outlet 2", at: "2026-10-01 12:00", origin: "decision", by_decision: true, synthetic: "true" },
    ]);
    expect(await rows(
      `SELECT o.external_ref AS bill, l.line_no, l.qty_milli::int AS qty, l.unit_price_minor::int AS unit, l.line_discount_minor::int AS disc, l.tax_minor::int AS tax,
              l.variant_id IS NOT NULL AS variant, l.origin ->> 'kind' AS origin
         FROM core.order_line l JOIN core."order" o ON o.tenant_id = l.tenant_id AND o.id = l.order_id WHERE o.id IN (${O}) ORDER BY 1, 2`, [r.run])).toEqual([
      { bill: "SYN-H-0001", line_no: 1, qty: 2000, unit: 32000, disc: 0, tax: 3200, variant: true, origin: "decision" },
      { bill: "SYN-H-0001", line_no: 2, qty: 1000, unit: 8000, disc: 0, tax: 400, variant: false, origin: "decision" },
      { bill: "SYN-H-0002", line_no: 1, qty: 1000, unit: 32000, disc: 0, tax: 1600, variant: false, origin: "decision" },
      { bill: "SYN-H-0003", line_no: 1, qty: 1000, unit: 32000, disc: 2000, tax: 1500, variant: false, origin: "decision" },
      { bill: "SYN-H-0003", line_no: 2, qty: 1000, unit: 32000, disc: 0, tax: 1600, variant: false, origin: "decision" },
      { bill: "SYN-H-0004", line_no: 1, qty: 1000, unit: 32000, disc: 0, tax: 1600, variant: false, origin: "decision" },
      { bill: "SYN-H-0005", line_no: 1, qty: 3000, unit: 8000, disc: 0, tax: 1200, variant: false, origin: "decision" },
    ]);
    expect(await rows(
      `SELECT o.external_ref AS bill, t.method, t.amount_minor::int AS amount, t.recorded_by = $2 AS by_approver, t.origin ->> 'kind' AS origin
         FROM core.tender t JOIN core."order" o ON o.tenant_id = t.tenant_id AND o.id = t.order_id WHERE o.id IN (${O}) ORDER BY 1, 2`, [r.run, w.owner])).toEqual([
      { bill: "SYN-H-0001", method: "cash", amount: 50000, by_approver: true, origin: "decision" },
      { bill: "SYN-H-0001", method: "upi", amount: 25600, by_approver: true, origin: "decision" },
      { bill: "SYN-H-0003", method: "card", amount: 65100, by_approver: true, origin: "decision" },
      { bill: "SYN-H-0005", method: "cash", amount: 25200, by_approver: true, origin: "decision" },
    ]);
    expect(await rows(
      `SELECT o.external_ref AS bill, f.method, f.amount_minor::int AS amount, f.reason_code, f.tender_id IS NOT NULL AS tender, f.origin ->> 'kind' AS origin
         FROM core.refund f JOIN core."order" o ON o.tenant_id = f.tenant_id AND o.id = f.order_id WHERE o.id IN (${O}) ORDER BY 1`, [r.run])).toEqual([
      { bill: "SYN-H-0002", method: "upi", amount: 10000, reason_code: "late_delivery", tender: false, origin: "decision" },
      { bill: "SYN-H-0003", method: "card", amount: 31500, reason_code: "customer_complaint", tender: true, origin: "decision" },
    ]);
    expect(await rows(
      `SELECT o.external_ref AS bill, l.line_no, v.reason_code, v.amount_minor::int AS amount, v.origin ->> 'kind' AS origin
         FROM core.void v JOIN core."order" o ON o.tenant_id = v.tenant_id AND o.id = v.order_id LEFT JOIN core.order_line l ON l.tenant_id = v.tenant_id AND l.id = v.order_line_id
        WHERE o.id IN (${O}) ORDER BY 1`, [r.run])).toEqual([
      { bill: "SYN-H-0003", line_no: 2, reason_code: "remake", amount: 33600, origin: "decision" },
      { bill: "SYN-H-0004", line_no: null, reason_code: "customer_left", amount: 33600, origin: "decision" },
    ]);
  });

  it("synthetic_bills_1: postings by rule and account (hand), every entry a derivation dated in its own period", async () => {
    const r = RUNS.get("synthetic_bills_1.csv")!;
    const src = `SELECT id FROM core."order" WHERE pricing_snapshot ->> 'import_run_id' = $1::text
                 UNION ALL SELECT t.id FROM core.tender t JOIN core."order" o ON o.tenant_id = t.tenant_id AND o.id = t.order_id WHERE o.pricing_snapshot ->> 'import_run_id' = $1::text
                 UNION ALL SELECT f.id FROM core.refund f JOIN core."order" o ON o.tenant_id = f.tenant_id AND o.id = f.order_id WHERE o.pricing_snapshot ->> 'import_run_id' = $1::text`;
    const sums = await rows<{ rule: string; code: string; amount: string }>(
      `SELECT j.posting_rule AS rule, a.code, sum(p.amount_minor)::text AS amount FROM core.journal_entry j
         JOIN core.posting p ON p.tenant_id = j.tenant_id AND p.journal_entry_id = j.id JOIN core.account a ON a.tenant_id = p.tenant_id AND a.id = p.account_id
        WHERE j.source_id IN (${src}) GROUP BY 1, 2 ORDER BY 1, 2`, [r.run]);
    const by: Record<string, Record<string, number>> = {};
    for (const s of sums) (by[s.rule] ??= {})[s.code] = Number(s.amount);
    expect(by).toEqual({
      "finance.post_order": { 1100: 32000, 1110: 165900, 2100: -7900, 4000: -190000 },
      "finance.post_tender": { 1000: 75200, 1010: 90700, 1110: -165900 },
      "finance.post_refund": { 1010: -31500, 1100: -10000, 2100: 1500, 4000: 40000 },
    });
    expect(await rows(
      `SELECT j.posting_rule AS rule, count(*)::int AS n, min(j.entry_date)::text AS first, max(j.entry_date)::text AS last, bool_and(j.origin ->> 'kind' = 'derivation') AS derived
         FROM core.journal_entry j WHERE j.source_id IN (${src}) GROUP BY 1 ORDER BY 1`, [r.run])).toEqual([
      { rule: "finance.post_order", n: 4, first: "2026-10-01", last: "2026-10-02", derived: true },
      { rule: "finance.post_refund", n: 2, first: "2026-10-02", last: "2026-10-02", derived: true },
      { rule: "finance.post_tender", n: 4, first: "2026-10-01", last: "2026-10-02", derived: true },
    ]);
  });

  it("synthetic_bills_1: stock consumed at the bill's time, FEFO from the outlet's batch on its last sellable day, else unbatched", async () => {
    const r = RUNS.get("synthetic_bills_1.csv")!;
    expect(await rows(
      `SELECT o.external_ref AS bill, m.origin ->> 'rule_id' AS rule, ou.name AS outlet, b.batch_code AS batch, m.qty_milli::int AS qty, m.unit,
              to_char(m.at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS at
         FROM core.stock_movement m JOIN core."order" o ON o.tenant_id = m.tenant_id AND o.id = m.ref_id JOIN core.outlet ou ON ou.tenant_id = m.tenant_id AND ou.id = m.outlet_id
         LEFT JOIN core.batch b ON b.tenant_id = m.tenant_id AND b.id = m.batch_id
        WHERE m.ref_type = 'core.order' AND o.pricing_snapshot ->> 'import_run_id' = $1::text ORDER BY 1, 2`, [r.run])).toEqual([
      { bill: "SYN-H-0001", rule: "inventory.consume_order", outlet: "Outlet 1", batch: "B-1", qty: -300000, unit: "g", at: "2026-10-01 13:05" },
      { bill: "SYN-H-0001", rule: "inventory.consume_sku", outlet: "Outlet 1", batch: "B-1", qty: -1000, unit: "g", at: "2026-10-01 13:05" },
      { bill: "SYN-H-0002", rule: "inventory.consume_order", outlet: "Outlet 3", batch: null, qty: -150000, unit: "g", at: "2026-10-01 20:30" },
      { bill: "SYN-H-0003", rule: "inventory.consume_order", outlet: "Outlet 3", batch: null, qty: -300000, unit: "g", at: "2026-10-02 09:15" },
      { bill: "SYN-H-0005", rule: "inventory.consume_sku", outlet: "Outlet 2", batch: "B-2", qty: -3000, unit: "g", at: "2026-10-01 12:00" },
    ]);
  });

  it("re-importing a committed bill is quarantined already_imported; the rest of the file still previews (key after_bills_1)", async () => {
    await parseAgainstKey("synthetic_bills_again.csv", KEY.after_bills_1["synthetic_bills_again.csv"]!);
  });

  it("synthetic_waste_1: 3 waste entries under the decision, each with its inventory.record_waste movement at the entry's time", async () => {
    const r = RUNS.get("synthetic_waste_1.csv")!;
    expect((await approve("IN", "owner", r.draft)).status).toBe(200);
    const dec = (await rows<{ d: string }>(`SELECT decision_id::text AS d FROM core.import_run WHERE id = $1`, [r.run]))[0]!.d;
    expect(await rows(
      `SELECT ou.name AS outlet, w.qty_milli::int AS qty, w.unit, w.reason, w.note, w.recorded_by = $3 AS by_approver,
              to_char(w.at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD HH24:MI') AS at, m.qty_milli::int AS moved, m.kind, m.batch_id, m.origin ->> 'kind' AS m_origin,
              m.origin ->> 'rule_id' AS m_rule, m.at = w.at AS same_time
         FROM core.waste_log w JOIN core.outlet ou ON ou.tenant_id = w.tenant_id AND ou.id = w.outlet_id
         JOIN core.stock_movement m ON m.tenant_id = w.tenant_id AND m.ref_type = 'core.waste_log' AND m.ref_id = w.id
        WHERE w.tenant_id = $1 AND w.origin ->> 'decision_id' = $2 ORDER BY w.at`, [T.IN.w.tenant, dec, T.IN.w.owner])).toEqual([
      { outlet: "Outlet 1", qty: 250000, unit: "g", reason: "overprep", note: null, by_approver: true, at: "2026-10-01 22:10", moved: -250000, kind: "waste",
        batch_id: null, m_origin: "derivation", m_rule: "inventory.record_waste", same_time: true },
      { outlet: "Outlet 3", qty: 1500, unit: "g", reason: "other", note: "Dropped tray (synthetic)", by_approver: true, at: "2026-10-02 12:00", moved: -1500,
        kind: "waste", batch_id: null, m_origin: "derivation", m_rule: "inventory.record_waste", same_time: true },
      { outlet: "Outlet 2", qty: 100000, unit: "g", reason: "expired", note: null, by_approver: true, at: "2026-10-03 23:59", moved: -100000, kind: "waste",
        batch_id: null, m_origin: "derivation", m_rule: "inventory.record_waste", same_time: true },
    ]);
  });

  it("synthetic_pos_d4 (D4): the 3 good bills commit (a bill number repeated at another outlet no longer fails the approval)", async () => {
    const r = RUNS.get("synthetic_pos_d4.csv")!;
    expect((await approve("IN", "owner", r.draft)).status).toBe(200);
    expect(await rows(
      `SELECT o.external_ref AS bill, ou.name AS outlet, o.kind, o.total_minor::int AS total, t.method, t.amount_minor::int AS paid
         FROM core."order" o JOIN core.outlet ou ON ou.tenant_id = o.tenant_id AND ou.id = o.outlet_id JOIN core.tender t ON t.tenant_id = o.tenant_id AND t.order_id = o.id
        WHERE o.pricing_snapshot ->> 'import_run_id' = $1::text ORDER BY 1`, [r.run])).toEqual([
      { bill: "SYN-D4-01", outlet: "Outlet 1", kind: "dine_in", total: 10500, method: "cash", paid: 10500 },
      { bill: "SYN-D4-05", outlet: "Outlet 1", kind: "takeaway", total: 10500, method: "upi", paid: 10500 },
      { bill: "SYN-D4-08", outlet: "Outlet 2", kind: "takeaway", total: 10500, method: "card", paid: 10500 },
    ]);
  });

  it("synthetic_bills_au (AU, tax-inclusive): 2 × $11.00 less $1.00 → total 2100, GST 191 (core's, not the file's); posted and consumed", async () => {
    const r = RUNS.get("synthetic_bills_au.csv")!;
    expect((await approve("AU", "owner", r.draft)).status).toBe(200);
    const o = (await rows<{ id: string; sub: number; disc: number; tax: number; total: number; bd: string }>(
      `SELECT id, subtotal_minor::int AS sub, discount_minor::int AS disc, tax_minor::int AS tax, total_minor::int AS total, business_date::text AS bd
         FROM core."order" WHERE pricing_snapshot ->> 'import_run_id' = $1::text`, [r.run]))[0]!;
    expect([o.sub, o.disc, o.tax, o.total, o.bd]).toEqual([2009, 100, 191, 2100, "2026-10-02"]);
    const sums = await rows<{ rule: string; code: string; amount: number }>(
      `SELECT j.posting_rule AS rule, a.code, sum(p.amount_minor)::int AS amount FROM core.journal_entry j
         JOIN core.posting p ON p.tenant_id = j.tenant_id AND p.journal_entry_id = j.id JOIN core.account a ON a.tenant_id = p.tenant_id AND a.id = p.account_id
        WHERE j.source_id = $1 OR j.source_id IN (SELECT id FROM core.tender WHERE order_id = $1) GROUP BY 1, 2 ORDER BY 1, 2`, [o.id]);
    expect(sums).toEqual([
      { rule: "finance.post_order", code: "1110", amount: 2100 }, { rule: "finance.post_order", code: "2100", amount: -191 },
      { rule: "finance.post_order", code: "4000", amount: -1909 },
      { rule: "finance.post_tender", code: "1000", amount: 2100 }, { rule: "finance.post_tender", code: "1110", amount: -2100 },
    ]);
    // The outlet's only batch expired on 1 Oct: a recipe never draws expired stock, so the 300 g are unbatched.
    expect(await rows(`SELECT qty_milli::int AS qty, batch_id FROM core.stock_movement WHERE ref_type = 'core.order' AND ref_id = $1`, [o.id]))
      .toEqual([{ qty: -300000, batch_id: null }]);
  });
});

describe("refusals", () => {
  it("a month closed between the preview and the approval: 409 period_closed, nothing written, the draft stays proposed", async () => {
    const r = RUNS.get("synthetic_bills_sept.csv")!;
    const w = T.IN.w;
    if (PLANT !== "no-close") {
      await db.withContext("munim_core", ownerCtx(w, "finance.period.close.v1"), (c) => c.query(
        `INSERT INTO core.period_close (tenant_id, id, outlet_id, period_month, checklist, net_minor, currency, closed_by) VALUES ($1, $2, $3, '2026-09-01', '[]', 0, 'INR', $4)`,
        [w.tenant, uuidv7(), w.outlets[1], w.owner]));
    }
    const res = await approve("IN", "owner", r.draft);
    expect([res.status, (await res.json()).error?.code]).toEqual([409, "period_closed"]);
    expect(await bookRows(r.run)).toBe(0);
    expect((await rows<{ status: string }>(`SELECT status FROM core.draft WHERE id = $1`, [r.draft]))[0]!.status).toBe("proposed");
  });

  it("core.write_derived: munim_svc may not call it (42501); munim_core gets no bypass — the guard judges every row it writes", async () => {
    if (PLANT === "svc-execute") await db.admin(`GRANT EXECUTE ON FUNCTION core.write_derived(jsonb) TO munim_svc`);
    const w = T.IN.w;
    const wd = (role: "munim_core" | "munim_svc", ctx: Record<string, string>, groups: unknown) =>
      db.withContext(role, { tenant_id: w.tenant, outlet_ids: "*", ...ctx }, (c) => c.query(`SELECT core.write_derived($1::jsonb)`, [JSON.stringify(groups)]))
        .then(() => "accepted", (e: { code?: string }) => e.code);
    const acct = (await rows<{ id: string }>(`SELECT id FROM core.account WHERE tenant_id = $1 AND code = '4000'`, [w.tenant]))[0]!.id;
    const cash = (await rows<{ id: string }>(`SELECT id FROM core.account WHERE tenant_id = $1 AND code = '1000'`, [w.tenant]))[0]!.id;
    const entry = (src: string, posting: Array<{ journal_entry_id?: string }> = []) => {
      const id = uuidv7();
      return { rule: "finance.post_order", source_ref: src, journal_entry: [{ id, outlet_id: w.outlets[0], brand_id: null, channel_id: w.channel, entry_date: "2026-10-05" }],
        posting: posting.length ? posting : [{ id: uuidv7(), journal_entry_id: id, account_id: acct, amount_minor: -100, currency: "INR" },
          { id: uuidv7(), journal_entry_id: id, account_id: cash, amount_minor: 100, currency: "INR" }] };
    };
    // A service context: refused at the function itself (it has no book grants either, so a grant here would still write
    // nothing — the EXECUTE revoke is checked on its own).
    const svcErr = await db.withContext("munim_svc", { tenant_id: w.tenant, outlet_ids: "*", role: "service" }, (c) =>
      c.query(`SELECT core.write_derived($1::jsonb)`, [JSON.stringify([entry(`core.order:${uuidv7()}`)])])).then(() => null, (e: { code?: string; message: string }) => e);
    expect([svcErr?.code, svcErr?.message]).toEqual(["42501", "permission denied for function write_derived"]);
    // The owner's own context, a source that does not exist: the derivation branch refuses (no decision, no command).
    expect(await wd("munim_core", { role: "owner", member_id: w.owner }, [entry(`core.order:${uuidv7()}`)])).toBe("MB001");
    // A real order that is not completed (the world's first order is placed): not in finance.post_order's source state.
    const placed = (await rows<{ id: string }>(`SELECT id FROM core."order" WHERE tenant_id = $1 AND status <> 'completed' ORDER BY id LIMIT 1`, [w.tenant]))[0]!.id;
    expect(await wd("munim_core", { role: "owner", member_id: w.owner }, [entry(`core.order:${placed}`)])).toBe("MB001");
    // A posting that names another group's entry: refused before anything is written.
    expect(await wd("munim_core", { role: "owner", member_id: w.owner }, [entry(`core.order:${placed}`, [{ journal_entry_id: uuidv7() }])])).toBe("22023");
  });
});

// ---- equivalence: batched vs seams ------------------------------------------------------------------------------

/** A synthetic pos_bills_v2 file of `n` bills over the first days of October 2026 at the canonical world's three
 *  outlets: dishes and the paneer SKU (only where a batch is sellable or none exists), split tenders, refunds, line
 *  voids, void bills and aggregator bills — deterministic. */
function genBills(n: number): string {
  const head = "Bill No,Bill Date,Bill Time,Outlet,Channel,Brand,Order Type,Customer Phone,Bill Status,Item Code,Variant Code,Qty,Unit Price,Tax Class,Line Discount,Line Total,Void Reason,Cash,Card,UPI,Refund,Refund Mode,Refund Reason,Refund Date";
  const out = [head];
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const outlet = (i % 3) + 1;
    const date = outlet === 3 ? `2026-10-0${1 + (i % 5)}` : "2026-10-01";
    const agg = i % 29 === 0;
    const voidBill = !agg && i % 31 === 0;
    const lines: Array<[string, number, string, string, number]> = [["menu.paneer_tikka", 1 + (i % 2), "320.00", "restaurant_5", 33600]];
    if (i % 5 === 0) lines.push(["8901234567890", 1 + (i % 3), "80.00", "goods_5", 8400]);
    const totals = lines.map(([, q, , , unit]) => q * unit);
    const total = totals.reduce((a, b) => a + b, 0);
    const m = (x: number) => (x / 100).toFixed(2);
    const method = ["cash", "card", "upi"][i % 3]!;
    const paid = agg || voidBill ? { cash: "", card: "", upi: "" } : { cash: method === "cash" ? m(total) : "", card: method === "card" ? m(total) : "", upi: method === "upi" ? m(total) : "" };
    const refund = !voidBill && i % 17 === 0 ? ["10.00", method, "goodwill", ""] : ["", "", "", ""];
    for (const [j, [code, q, unit, cls]] of lines.entries()) {
      const voidReason = voidBill ? "walked_out" : !agg && j === 0 && i % 23 === 0 ? "remake" : "";
      out.push([`GEN-${String(i).padStart(5, "0")}`, date, `${String(10 + (i % 12)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`, `Outlet ${outlet}`,
        agg ? "aggregator:swiggy" : "counter", "", agg ? "delivery" : "takeaway", "", voidBill ? "void" : "", code, "", String(q), unit, cls, "0", m(totals[j]!), voidReason,
        paid.cash, paid.card, paid.upi, ...refund].join(","));
    }
    sum += total;
  }
  out.push(["TOTAL", ...Array(14).fill(""), (sum / 100).toFixed(2), ...Array(8).fill("")].join(","));
  return `${out.join("\n")}\n`;
}

const memBlobs = (files: Map<string, Uint8Array>): BlobStore => ({ put: async (k, b) => void files.set(k, b), get: async (k) => files.get(k)! });

/** Upload + parse without HTTP (no pool held open, so the database can be cloned afterwards). */
async function stage(x: TestDb, w: World, blobs: Map<string, Uint8Array>, kind: string, parser: string, text: string): Promise<{ run: string; draft: string; rows_ok: number }> {
  const bytes = new TextEncoder().encode(text);
  const sha = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
  const run = uuidv7();
  await x.withContext("munim_core", ownerCtx(w), async (c) => {
    const doc = uuidv7();
    await c.query(`INSERT INTO core.document (tenant_id, id, kind, media_type, filename, byte_size, sha256, storage_ref, uploaded_by)
                   VALUES ($1, $2, $3, 'text/csv', 'synthetic_eq.csv', $4, $5, $6, $7)`, [w.tenant, doc, kind, bytes.length, sha, `${w.tenant}/${sha}`, w.owner]);
    await c.query(`INSERT INTO core.import_run (tenant_id, id, document_id, kind, parser, created_by) VALUES ($1, $2, $3, $4, $5, $6)`, [w.tenant, run, doc, kind, parser, w.owner]);
  });
  blobs.set(`${w.tenant}/${sha}`, bytes);
  expect(await x.withContext("munim_svc", { tenant_id: w.tenant, outlet_ids: "*", role: "service" }, (c) => parseRun(c, memBlobs(blobs), run))).toBe("previewed");
  return (await x.admin<{ run: string; draft: string; rows_ok: number }>(`SELECT id AS run, draft_id AS draft, rows_ok FROM core.import_run WHERE id = $1`, [run])).rows[0]!;
}

/** The approval transaction of approvals/decide.ts (executing → decision → app.decision_id → executeCommand → executed),
 *  with the commit handler in the given mode. */
async function approveIn(x: TestDb, w: World, s: { run: string; draft: string }, mode: WriteMode) {
  await x.withContext("munim_core", ownerCtx(w), async (c) => {
    await c.query(`UPDATE core.draft SET status = 'executing', exec_txid = txid_current() WHERE id = $1 AND status = 'proposed'`, [s.draft]);
    const decisionId = uuidv7();
    await c.query(`INSERT INTO core.decision (tenant_id, id, draft_id, verdict, final_payload, reason, decided_by) VALUES ($1, $2, $3, 'approved', $4, NULL, $5)`,
      [w.tenant, decisionId, s.draft, { import_run_id: s.run }, w.owner]);
    await c.query(`SELECT set_config('app.decision_id', $1, true)`, [decisionId]);
    await executeCommand({ tx: (fn) => fn(c), tenantId: w.tenant, actor: { kind: "member", id: w.owner, role: "owner" }, decisionId },
      { command_id: uuidv7(), idempotency_key: `h1-eq-${s.run}`, type: "imports.run.commit.v1", payload: { import_run_id: s.run } },
      { type: "imports.run.commit.v1", run: (q, cmd) => commitRun(q, cmd, mode) });
    await c.query(`UPDATE core.draft SET status = 'executed' WHERE id = $1`, [s.draft]);
  });
}

const BOOK = ["order", "order_line", "tender", "refund", "void", "journal_entry", "posting", "stock_movement", "waste_log"] as const;
type Snap = Record<(typeof BOOK)[number] | "audit", Array<Record<string, unknown>>>;

/** Every row the approvals wrote, ids replaced by stable labels (bill number, line number, rule + source…), so two
 *  databases that wrote the same books compare equal. Columns stamped with now() at write time are left out. */
async function project(x: TestDb, tenant: string, auditAfter: number): Promise<Snap> {
  const get = async (t: string) => (await x.admin<{ j: Record<string, unknown> }>(
    `SELECT to_jsonb(r) - 'created_at' - 'updated_at' AS j FROM core."${t}" r WHERE tenant_id = $1 AND origin ->> 'kind' IN ('decision', 'derivation')
        AND (origin ->> 'kind' = 'derivation' OR EXISTS (SELECT 1 FROM core.decision d JOIN core.draft r2 ON r2.tenant_id = d.tenant_id AND r2.id = d.draft_id
                                                        WHERE d.id::text = origin ->> 'decision_id' AND r2.command_type = 'imports.run.commit.v1'))`, [tenant])).rows.map((r) => r.j);
  const raw = Object.fromEntries(await Promise.all(BOOK.map(async (t) => [t, await get(t)] as const))) as Record<(typeof BOOK)[number], Array<Record<string, any>>>;
  const audit = (await x.admin<{ j: Record<string, unknown> }>(
    `SELECT jsonb_build_object('actor', actor, 'action', action, 'entity', entity, 'entity_id', entity_id, 'before', before, 'after', after,
                               'decision', decision_id IS NOT NULL) AS j FROM core.audit_log WHERE tenant_id = $1 AND seq > $2 ORDER BY seq`, [tenant, auditAfter])).rows.map((r) => r.j);
  const label = new Map<string, string>();
  for (const d of await x.admin<{ id: string }>(`SELECT id FROM core.decision WHERE tenant_id = $1`, [tenant]).then((r) => r.rows)) label.set(d.id, "decision");
  const ext = new Map(raw.order.map((o) => [o.id as string, o.external_ref as string]));
  for (const o of raw.order) label.set(o.id, `order:${o.external_ref}`);
  for (const l of raw.order_line) label.set(l.id, `line:${ext.get(l.order_id)}:${l.line_no}`);
  for (const t of raw.tender) label.set(t.id, `tender:${ext.get(t.order_id)}:${t.method}`);
  for (const f of raw.refund) label.set(f.id, `refund:${ext.get(f.order_id)}`);
  for (const v of raw.void) label.set(v.id, `void:${ext.get(v.order_id)}:${v.order_line_id ? label.get(v.order_line_id) : "bill"}`);
  for (const w of raw.waste_log) label.set(w.id, `waste:${w.ingredient_id}:${w.at}:${w.qty_milli}`);
  for (const j of raw.journal_entry) label.set(j.id, `entry:${j.posting_rule}:${label.get(j.source_id) ?? j.source_id}`);
  for (const p of raw.posting) label.set(p.id, `posting:${label.get(p.journal_entry_id)}:${p.account_id}`);
  for (const m of raw.stock_movement) label.set(m.id, `movement:${label.get(m.ref_id) ?? m.ref_id}:${m.origin.rule_id ?? m.origin.kind}:${m.ingredient_id}:${m.batch_id}`);
  const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
  const relabel = (r: unknown) => JSON.parse(JSON.stringify(r).replace(UUID, (u) => label.get(u) ?? u)) as Record<string, unknown>;
  const sorted = (xs: unknown[]) => xs.map(relabel).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  return { ...Object.fromEntries(BOOK.map((t) => [t, sorted(raw[t])])), audit: audit.map(relabel) } as Snap;
}

describe("equivalence: the batched commit writes exactly what the per-row seams path writes", () => {
  it(`bills_1 + waste_1 + ${CHUNK + 220} generated bills (two chunks, a batch drawn to empty): rows, postings, origins and audit entries equal`, async () => {
    const base = await openDb();
    const clones: TestDb[] = [];
    try {
      const w = (await tenant(base, "IN")).w;
      const blobs = new Map<string, Uint8Array>();
      const runs = [
        await stage(base, w, blobs, "pos_bills", "pos_bills_v2", await readFile(join(FIXTURES, "synthetic_bills_1.csv"), "utf8")),
        await stage(base, w, blobs, "waste_log", "waste_log_v1", await readFile(join(FIXTURES, "synthetic_waste_1.csv"), "utf8")),
        await stage(base, w, blobs, "pos_bills", "pos_bills_v2", genBills(CHUNK + 220)),
        await stage(base, w, blobs, "pos_export", "pos_export_v1", posExportV1(30, "Outlet 2", new Date("2026-10-08T00:00:00Z"))),
      ];
      expect(runs.map((r) => r.rows_ok)).toEqual([7, 3, runs[2]!.rows_ok, 30]);
      expect(runs[2]!.rows_ok).toBeGreaterThan(CHUNK);
      const auditAfter = Number((await base.admin<{ s: string }>(`SELECT coalesce(max(seq), 0)::text AS s FROM core.audit_log WHERE tenant_id = $1`, [w.tenant])).rows[0]!.s);
      const snaps: Snap[] = [];
      for (const mode of ["seams", "batched"] as const) {
        const x = await base.clone();
        clones.push(x);
        for (const r of runs) await approveIn(x, w, r, mode);
        if (PLANT === "equivalence" && mode === "batched") {
          // Plant: the batched path "forgot" one consumption movement.
          await x.admin(`SET session_replication_role = replica; DELETE FROM core.stock_movement WHERE id = (SELECT id FROM core.stock_movement WHERE tenant_id = '${w.tenant}'
                           AND kind = 'sale_consumption' ORDER BY id DESC LIMIT 1); SET session_replication_role = origin`);
        }
        snaps.push(await project(x, w.tenant, auditAfter));
      }
      const [seams, batched] = snaps as [Snap, Snap];
      const counts = (s: Snap) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, v.length]));
      mkdirSync(join(import.meta.dirname, "../../../scratchpad/h1"), { recursive: true }); // git-ignored: absent in a fresh clone
      appendFileSync(join(import.meta.dirname, "../../../scratchpad/h1/equivalence.jsonl"), `${JSON.stringify({ seams: counts(seams), batched: counts(batched) })}\n`);
      // Positive anchors: the fixtures' hand counts are inside (bills_1: 5 orders, 7 lines, 4 tenders, 2 refunds, 2 voids; waste_1: 3 entries), and
      // the generated file put more than one chunk of orders through.
      expect(seams.order.length).toBeGreaterThan(CHUNK + 5);
      expect(seams.waste_log.length).toBe(3);
      expect(seams.stock_movement.length).toBeGreaterThan(seams.order.length / 2);
      expect(seams.posting.length).toBeGreaterThan(2 * seams.journal_entry.length - 1);
      expect(seams.audit.length).toBe(runs.length * 1);
      for (const t of [...BOOK, "audit"] as const) expect({ table: t, rows: batched[t] }).toEqual({ table: t, rows: seams[t] });
    } finally {
      for (const x of clones) await x.stop();
      await base.stop();
    }
  }, 300_000);
});

describe("round trips (R44c): the batched commit's queries do not grow with the bills", () => {
  it("1,000 POS bills: batched ≤ 40 queries in all; the seams path ≥ 30 a bill (measured, printed)", async () => {
    const admin = await db.connect("admin");
    try {
      const batched = await timeCommit(admin, "pos_export", "pos_export_v1", (t) => posExportV1(1000, t.outlet.name, new Date("2026-10-09T00:00:00Z")),
        { batched: PLANT === "seams-timing" ? false : true, tenant: T.IN.w.tenant, outlet: T.IN.w.outlets[0] });
      const seams = await timeCommit(admin, "pos_export", "pos_export_v1", (t) => posExportV1(200, t.outlet.name, new Date("2026-10-09T00:00:00Z")),
        { batched: false, tenant: T.IN.w.tenant, outlet: T.IN.w.outlets[0] });
      mkdirSync(join(import.meta.dirname, "../../../scratchpad/h1"), { recursive: true }); // git-ignored: absent in a fresh clone
      appendFileSync(join(import.meta.dirname, "../../../scratchpad/h1/timing.jsonl"), `${JSON.stringify({ where: "embedded", batched, seams })}\n`);
      expect(batched.rows_ok).toBe(1000);
      expect(batched.queries).toBeLessThanOrEqual(40);
      expect(seams.per_row_queries).toBeGreaterThanOrEqual(30);
    } finally {
      await admin.end();
    }
  }, 300_000);
});
