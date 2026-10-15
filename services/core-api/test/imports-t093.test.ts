// T-093 gates — shift_log_v1 and stock_count_v1 history through the approved-import path (0021, 0022; R28; R44). Through
// the real app (member auth → RLS → book guard) and the core-worker parse job. Every expected value is hand-written below
// from the fixture files in test/fixtures/t093/ (never read back from the code under test):
//   1. a 7-day shift log over 9 committed bills commits 7 shifts, each with a hand-valued expected cash and variance;
//      no tender is touched (no shift link is written);
//   2. a tender control-total mismatch is quarantined, with every other shift reason paired with an accepted row;
//   3. a stock count commits its count, lines and one count_adjust movement per non-zero line (hand-summed);
//   4. an owner's own imports.run.commit.v1 cannot write a shift, a count or a count line (MB001);
//   5. a future date → date_not_past, a closed period → period_closed (at preview and between preview and approval);
//   6. the commit is idempotent: the same key replays, a new key is refused, 0 rows added.
// W3.2 review fix cycle 1 (last describe):
//   R-A 2  two approvals racing (a lock barrier holds both inside their transactions): the first commits, the second goes
//          stale (409 `stale_draft`, draft `stale`, 0 rows) — a clash never clears on a retry, so it is no 409 loop;
//   R-A 3  a count dated before a submitted count of the same outlet + ingredient (+ batch) → `later_count_exists` at the
//          preview (its siblings `count_rejected`), and stale at the approval when the later count landed after the
//          preview — including a live count submitted while the approval runs (the same outlet lock);
//   R-A 6  core's figure moved between the preview and the approval (an imported bill, an earlier count, a bill's tax) → 409 `stale_draft`,
//          the draft `stale` (not `proposed`), 0 rows; a retry → 409 `stale_draft` again;
//   R-A 10 a live device-less cash order (a QR / storefront order) on a past day is not a history drawer's cash.
// Red-proofs: services/core-api/test/redproof-t093.sh (MUNIM_T093_PLANT, test-side only). Synthetic data only.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import { localBlobStore } from "../src/modules/imports/index.ts";
import { openDb } from "./db.ts";

const FIXTURES = join(import.meta.dirname, "fixtures/t093");
const PLANT = process.env.MUNIM_T093_PLANT ?? "";
const PLANTS = ["", "tender-shifted", "control-matches", "late-movement-early", "draft-only-off", "no-close", "replay-reset"];
if (!PLANTS.includes(PLANT)) throw new Error(`MUNIM_T093_PLANT: unknown plant ${PLANT}`);

const idp = createLocalIdp();
let db: TestDb;
let pools: { core: pg.Pool; svc: pg.Pool };
let app: Hono<AppEnv>;
let blobDir: string;
let w: World;
const subs = { owner: `owner-${uuidv7()}` };
const ctx = (command_type?: string) => ({ tenant_id: w.tenant, outlet_ids: "*" as const, role: "owner" as const, member_id: w.owner, ...(command_type ? { command_type } : {}) });

type Res = Omit<Response, "json"> & { json(): Promise<any> };
const call = async (method: string, path: string, body?: unknown): Promise<Res> =>
  (await app.request(path, {
    method,
    headers: { Authorization: `Bearer ${idp.sign({ sub: subs.owner })}`, [TENANT_HEADER]: w.tenant, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })) as Res;
const rows = async <R extends pg.QueryResultRow>(sql: string, params: unknown[] = []) => (await db.admin(sql, params)).rows as R[];
const count = async (sql: string, params: unknown[] = []) => Number((await rows<{ n: string }>(sql, params))[0]!.n);
const parse = () => parsePendingImports({ pool: pools.svc, blobs: localBlobStore(blobDir), log: () => {} }, [w.tenant]);
const COMMAND_IDS = new Map<string, string>();
const approve = (draft: string, key = `t93-${uuidv7()}`) => call("POST", `/v1/drafts/${draft}:approve`, {
  command_id: COMMAND_IDS.get(key) ?? COMMAND_IDS.set(key, uuidv7()).get(key)!, idempotency_key: key, type: "drafts.approve.v1", payload: { draft_id: draft, command_type: "imports.run.commit.v1", edited_payload: null, reason: null },
});

/** Upload + parse one fixture: the run's figures and rows. */
async function preview(kind: string, file: string, parser: string) {
  const up = await call("POST", "/v1/imports/documents", { kind, filename: file, media_type: "text/csv", content_base64: (await readFile(join(FIXTURES, file))).toString("base64") });
  expect(up.status).toBe(200);
  const u = ImportsUploadResponse.parse(await up.json());
  expect(u).toMatchObject({ duplicate: false, header: null, run: { status: "parsing", parser } });
  expect(await parse()).toEqual({ previewed: 1, failed: 0, skipped: 0, errors: 0 });
  const run = ImportRunView.parse(await (await call("GET", `/v1/imports/runs/${u.run!.import_run_id}`)).json());
  const r = ImportRunRowsResponse.parse(await (await call("GET", `/v1/imports/runs/${run.import_run_id}/rows`)).json());
  return { run, staged: r.staged, quarantined: Object.fromEntries(r.quarantined.map((q) => [String(q.row_no), q.reason_code])) };
}

const RUN: Record<string, { run: string; draft: string }> = {};
const shiftsOf = () => count(`SELECT count(*) AS n FROM core.shift WHERE tenant_id = $1 AND device_id IS NULL`, [w.tenant]);
const countsOf = () => count(`SELECT count(*) AS n FROM core.stock_count WHERE tenant_id = $1 AND origin ->> 'kind' = 'decision'`, [w.tenant]);
const tenders = () => count(`SELECT count(*) AS n FROM core.tender WHERE tenant_id = $1`, [w.tenant]);
const draftStatus = async (draft: string) => (await rows<{ status: string }>(`SELECT status FROM core.draft WHERE id = $1`, [draft]))[0]!.status;

beforeAll(async () => {
  db = await openDb();
  w = await buildWorld(db, { country: "IN" });
  await db.withContext("munim_core", ctx("tenancy.member.invite.v1"), async (c) => {
    await c.query(`UPDATE core.member SET idp_sub = $2 WHERE id = $1`, [w.owner, subs.owner]);
  });
  pools = { core: db.pool("munim_core", 8), svc: db.pool("munim_svc", 2) };
  blobDir = await mkdtemp(join(tmpdir(), "munim-t093-"));
  const config = { nodeEnv: "test", redact: (s: string) => s };
  app = await createApp({ pools, idp, storefronts: async () => null, blobs: localBlobStore(blobDir), config, log: createLogger(config, () => {}) });

  // Two untracked ingredients with stock at explicit past instants (IST). Flour at outlet 1: +10,000 g (28 Sep), −1,500 g waste
  // (30 Sep), +2,000 g (4 Oct, AFTER the first count). Oil: outlet 1 +5,000 ml (28 Sep); outlets 2 and 3 none.
  const flour = uuidv7(), oil = uuidv7();
  await db.withContext("munim_core", ctx("inventory.ingredient.upsert.v1"), async (c) => {
    await c.query(`INSERT INTO core.ingredient (tenant_id, id, name, base_unit, tracked_by_batch) VALUES ($1, $2, 'Flour', 'g', false), ($1, $3, 'Oil', 'ml', false)`, [w.tenant, flour, oil]);
  });
  const mv = (ing: string, qty: number, unit: string, kind: string, at: string) => ({ ing, qty, unit, kind, at });
  // A batch-tracked ingredient (the world's Paneer) with a dated batch at outlet 1: +2,000 g on 29 Sep.
  const batch = uuidv7();
  await db.withContext("munim_core", ctx("inventory.stock.receive.v1"), async (c) => {
    await c.query(`INSERT INTO core.batch (tenant_id, id, outlet_id, ingredient_id, batch_code, expires_on, supplier_id) VALUES ($1, $2, $3, $4, 'T93-PB', '2026-12-31', $5)`,
      [w.tenant, batch, w.outlets[0], w.ingredient, w.supplier]);
    await c.query(`INSERT INTO core.stock_movement (tenant_id, id, outlet_id, ingredient_id, batch_id, qty_milli, unit, kind, at) VALUES ($1, $2, $3, $4, $5, 2000000, 'g', 'receipt', '2026-09-29T09:00:00+05:30')`,
      [w.tenant, uuidv7(), w.outlets[0], w.ingredient, batch]);
  });
  const lateReceipt = PLANT === "late-movement-early" ? "2026-10-03T08:00:00+05:30" : "2026-10-04T08:00:00+05:30";
  await db.withContext("munim_core", ctx("inventory.stock.receive.v1"), async (c) => {
    for (const m of [mv(flour, 10_000_000, "g", "receipt", "2026-09-28T09:00:00+05:30"), mv(flour, -1_500_000, "g", "waste", "2026-09-30T10:00:00+05:30"),
      mv(flour, 2_000_000, "g", "receipt", lateReceipt), mv(oil, 5_000_000, "ml", "receipt", "2026-09-28T09:00:00+05:30")]) {
      await c.query(`INSERT INTO core.stock_movement (tenant_id, id, outlet_id, ingredient_id, qty_milli, unit, kind, at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [w.tenant, uuidv7(), w.outlets[0], m.ing, m.qty, m.unit, m.kind, m.at]);
    }
  });
  if (PLANT === "no-close") await db.admin(`SET session_replication_role = replica; DELETE FROM core.period_close WHERE tenant_id = '${w.tenant}'; SET session_replication_role = origin`);
});

afterAll(async () => {
  await pools?.core.end();
  await pools?.svc.end();
  await db?.stop();
  if (blobDir) await rm(blobDir, { recursive: true, force: true });
});

describe("shift_log_v1", () => {
  it("the bills of the days commit first (9 at outlet 1, 1 at outlet 2): the cash a shift log is checked against", async () => {
    const p = await preview("pos_bills", "t93_bills.csv", "pos_bills_v2");
    expect(p.run).toMatchObject({ rows_ok: 10, rows_quarantined: 0 });
    expect((await approve(p.run.draft_id!)).status).toBe(200);
    expect(await count(`SELECT count(*) AS n FROM core."order" WHERE tenant_id = $1 AND external_ref LIKE 'T93-B%'`, [w.tenant])).toBe(10);
    if (PLANT === "tender-shifted") {
      await db.admin(`SET session_replication_role = replica;
        UPDATE core.tender SET amount_minor = amount_minor + 100 WHERE tenant_id = '${w.tenant}' AND ref = 'T93-B01'; SET session_replication_role = origin`);
    }
  });

  it("a tender control-total mismatch is quarantined; each other reason is paired with an accepted row (nothing is written)", async () => {
    if (PLANT === "control-matches") {
      // Plant: core's cash for 1 Oct becomes the file's 1000.00 (B01 336.00 → 328.00), so row 3 is no longer a mismatch.
      await db.admin(`SET session_replication_role = replica;
        UPDATE core.tender SET amount_minor = 32800 WHERE tenant_id = '${w.tenant}' AND ref = 'T93-B01'; SET session_replication_role = origin`);
    }
    const before = [await shiftsOf(), await tenders()];
    const p = await preview("shift_log", "t93_shifts_bad.csv", "shift_log_v1");
    expect(p.run).toMatchObject({ status: "previewed", rows_ok: 1, rows_quarantined: 10 });
    expect(p.quarantined).toEqual({
      "3": "tender_mismatch", "4": "date_not_past", "5": "period_closed", "6": "member_unknown", "7": "outlet_unknown", "8": "shift_window_invalid",
      "9": "duplicate_row", "10": "amount_negative", "11": "shift_overlap", "12": "time_unreadable",
    });
    expect(p.staged.map((s) => s.data.shift_no)).toEqual(["T93-X1"]);
    expect([await shiftsOf(), await tenders()]).toEqual(before);
  });

  it("a 7-day log commits 7 closed shifts; expected = float + core's cash in the window; variance = counted − expected; no tender touched", async () => {
    const p = await preview("shift_log", "t93_shifts.csv", "shift_log_v1");
    RUN.shifts = { run: p.run.import_run_id, draft: p.run.draft_id! };
    expect(p.run).toMatchObject({ rows_ok: 7, rows_quarantined: 0 });
    const pre = [await shiftsOf(), await tenders()];
    expect(pre[0]).toBe(0);
    const res = await approve(p.run.draft_id!, "t93-shifts");
    expect(res.status).toBe(200);
    expect(await tenders()).toBe(pre[1]);
    const dec = (await rows<{ d: string }>(`SELECT decision_id::text AS d FROM core.import_run WHERE id = $1`, [p.run.import_run_id]))[0]!.d;
    // Hand values (paise). Cash in by day at outlet 1: 1 Oct 336+672; 2 Oct 336−100 refund; 3 Oct 1008 (the 336 card bill is not cash);
    // 4 Oct 336; 5 Oct 672; 6 Oct 21:30 bill falls in the 18:00–02:00 shift (the 02:00 end is the next calendar day); 7 Oct 336.
    expect(await rows(
      `SELECT to_char(s.opened_at AT TIME ZONE 'Asia/Kolkata', 'MM-DD HH24:MI') AS opened, to_char(s.closed_at AT TIME ZONE 'Asia/Kolkata', 'MM-DD HH24:MI') AS closed,
              s.status, s.device_id IS NULL AS deviceless, s.float_minor::int AS float, s.counted_cash_minor::int AS counted, s.expected_cash_minor::int AS expected,
              s.variance_minor::int AS variance, om.name AS opener, cm.name AS closer, s.origin ->> 'kind' AS origin, s.origin ->> 'decision_id' = $2 AS by_decision
         FROM core.shift s JOIN core.member om ON om.tenant_id = s.tenant_id AND om.id = s.opened_by JOIN core.member cm ON cm.tenant_id = s.tenant_id AND cm.id = s.closed_by
        WHERE s.tenant_id = $1 AND s.device_id IS NULL ORDER BY s.opened_at`, [w.tenant, dec])).toEqual([
      { opened: "10-01 10:00", closed: "10-01 23:00", status: "closed", deviceless: true, float: 200000, counted: 300000, expected: 300800, variance: -800, opener: "Owner", closer: "Owner", origin: "decision", by_decision: true },
      { opened: "10-02 10:00", closed: "10-02 23:00", status: "closed", deviceless: true, float: 200000, counted: 223600, expected: 223600, variance: 0, opener: "Owner", closer: "Staff", origin: "decision", by_decision: true },
      { opened: "10-03 10:00", closed: "10-03 23:00", status: "closed", deviceless: true, float: 200000, counted: 310800, expected: 300800, variance: 10000, opener: "Staff", closer: "Staff", origin: "decision", by_decision: true },
      { opened: "10-04 10:00", closed: "10-04 23:00", status: "closed", deviceless: true, float: 150000, counted: 180000, expected: 183600, variance: -3600, opener: "Owner", closer: "Owner", origin: "decision", by_decision: true },
      { opened: "10-05 10:00", closed: "10-05 23:00", status: "closed", deviceless: true, float: 150000, counted: 217200, expected: 217200, variance: 0, opener: "Owner", closer: "Owner", origin: "decision", by_decision: true },
      { opened: "10-06 18:00", closed: "10-07 02:00", status: "closed", deviceless: true, float: 100000, counted: 138600, expected: 133600, variance: 5000, opener: "Owner", closer: "Staff", origin: "decision", by_decision: true },
      { opened: "10-07 10:00", closed: "10-07 23:00", status: "closed", deviceless: true, float: 100000, counted: 133500, expected: 133600, variance: -100, opener: "Owner", closer: "Owner", origin: "decision", by_decision: true },
    ]);
    expect(await shiftsOf()).toBe(7);
  });

  it("the commit is idempotent: the same key replays, a new key is refused, 0 rows added", async () => {
    const r = RUN.shifts!;
    const same = await approve(r.draft, "t93-shifts");
    expect(same.status).toBe(200);
    if (PLANT === "replay-reset") {
      await db.admin(`SET session_replication_role = replica; UPDATE core.import_run SET status = 'previewed' WHERE id = '${r.run}'; UPDATE core.draft SET status = 'proposed' WHERE id = '${r.draft}'; SET session_replication_role = origin`);
    }
    const again = await approve(r.draft);
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(await shiftsOf()).toBe(7);
  });
});

describe("stock_count_v1", () => {
  it("bad rows are quarantined with their reasons, the good one is staged; nothing is written", async () => {
    const before = [await countsOf(), await count(`SELECT count(*) AS n FROM core.stock_movement WHERE tenant_id = $1 AND kind = 'count_adjust'`, [w.tenant])];
    const p = await preview("stock_count", "t93_counts_bad.csv", "stock_count_v1");
    expect(p.run).toMatchObject({ status: "previewed", rows_ok: 1, rows_quarantined: 15 });
    expect(p.quarantined).toEqual({
      "3": "date_not_past", "4": "period_closed", "5": "count_rejected", "6": "ingredient_unknown", "7": "batch_required", "8": "unit_mismatch",
      "9": "member_unknown", "10": "count_header_differs", "11": "count_header_differs", "12": "count_rejected", "13": "duplicate_ingredient",
      "14": "qty_invalid", "15": "outlet_unknown", "16": "batch_not_tracked", "17": "batch_unknown",
    });
    expect(p.staged.map((s) => [s.data.count_no, s.data.expected_qty_milli, s.data.counted_qty_milli])).toEqual([["T93-Y0", 0, 100_000]]);
    expect(before).toEqual([0, 0]);
  });

  it("3 counts: 6 lines, 5 adjustments (the zero line is skipped), summing −750,000 milli; expected is core's on-hand AT counted_at", async () => {
    const p = await preview("stock_count", "t93_counts.csv", "stock_count_v1");
    RUN.counts = { run: p.run.import_run_id, draft: p.run.draft_id! };
    expect(p.run).toMatchObject({ rows_ok: 6, rows_quarantined: 0 });
    const res = await approve(p.run.draft_id!, "t93-counts");
    expect(res.status).toBe(200);
    const dec = (await rows<{ d: string }>(`SELECT decision_id::text AS d FROM core.import_run WHERE id = $1`, [p.run.import_run_id]))[0]!.d;
    // Hand values (milli). Flour at outlet 1: 10,000,000 − 1,500,000 = 8,500,000 at the 3 Oct count (the 4 Oct +2,000,000 is later) → counted
    // 8,000,000 → −500,000. At the 6 Oct count: 8,500,000 − 500,000 + 2,000,000 = 10,000,000 → counted 9,700,000 → −300,000.
    // Oil outlet 1: 5,000,000 both times → 3 Oct counted 5,000,000 (no movement); 6 Oct counted 4,900,000 → −100,000. Oil outlet 2: 0 → +250,000.
    // Paneer batch T93-PB (tracked, counted per batch): its own 2,000,000 less the sale consumption of the 8 portions of paneer tikka billed
    // 2–6 Oct (150,000 each: FEFO skips the world's batches, expired since 1 Oct) = 800,000 → counted 700,000 → −100,000.
    expect(await rows(
      `SELECT sc.status, to_char(sc.counted_at AT TIME ZONE 'Asia/Kolkata', 'MM-DD HH24:MI') AS at, o.name AS outlet, m.name AS by, i.name AS ing,
              l.expected_qty_milli::int AS expected, l.counted_qty_milli::int AS counted, l.unit, l.batch_id IS NULL AS unbatched,
              sc.origin ->> 'kind' AS origin, sc.origin ->> 'decision_id' = $2 AS by_decision, l.origin ->> 'kind' AS line_origin
         FROM core.stock_count sc JOIN core.stock_count_line l ON l.tenant_id = sc.tenant_id AND l.stock_count_id = sc.id
         JOIN core.outlet o ON o.tenant_id = sc.tenant_id AND o.id = sc.outlet_id JOIN core.member m ON m.tenant_id = sc.tenant_id AND m.id = sc.counted_by
         JOIN core.ingredient i ON i.tenant_id = l.tenant_id AND i.id = l.ingredient_id
        WHERE sc.tenant_id = $1 AND sc.origin ->> 'kind' = 'decision' ORDER BY sc.counted_at, i.name`, [w.tenant, dec])).toEqual([
      { status: "submitted", at: "10-03 20:00", outlet: "Outlet 1", by: "Staff", ing: "Flour", expected: 8_500_000, counted: 8_000_000, unit: "g", unbatched: true, origin: "decision", by_decision: true, line_origin: "decision" },
      { status: "submitted", at: "10-03 20:00", outlet: "Outlet 1", by: "Staff", ing: "Oil", expected: 5_000_000, counted: 5_000_000, unit: "ml", unbatched: true, origin: "decision", by_decision: true, line_origin: "decision" },
      { status: "submitted", at: "10-05 18:00", outlet: "Outlet 2", by: "Owner", ing: "Oil", expected: 0, counted: 250_000, unit: "ml", unbatched: true, origin: "decision", by_decision: true, line_origin: "decision" },
      { status: "submitted", at: "10-06 18:30", outlet: "Outlet 1", by: "Owner", ing: "Flour", expected: 10_000_000, counted: 9_700_000, unit: "g", unbatched: true, origin: "decision", by_decision: true, line_origin: "decision" },
      { status: "submitted", at: "10-06 18:30", outlet: "Outlet 1", by: "Owner", ing: "Oil", expected: 5_000_000, counted: 4_900_000, unit: "ml", unbatched: true, origin: "decision", by_decision: true, line_origin: "decision" },
      { status: "submitted", at: "10-06 18:30", outlet: "Outlet 1", by: "Owner", ing: "Paneer", expected: 800_000, counted: 700_000, unit: "g", unbatched: false, origin: "decision", by_decision: true, line_origin: "decision" },
    ]);
    const moves = await rows<{ ing: string; outlet: string; qty: number; unit: string; at: string; ref_type: string; same_count: boolean; rule: string; by_rule: boolean }>(
      `SELECT i.name AS ing, o.name AS outlet, m.qty_milli::int AS qty, m.unit, to_char(m.at AT TIME ZONE 'Asia/Kolkata', 'MM-DD HH24:MI') AS at, m.ref_type,
              m.ref_id = sc.id AS same_count, m.origin ->> 'rule_id' AS rule, m.origin ->> 'source_ref' = 'core.stock_count:' || sc.id AS by_rule
         FROM core.stock_movement m JOIN core.stock_count sc ON sc.tenant_id = m.tenant_id AND sc.id = m.ref_id
         JOIN core.ingredient i ON i.tenant_id = m.tenant_id AND i.id = m.ingredient_id JOIN core.outlet o ON o.tenant_id = m.tenant_id AND o.id = m.outlet_id
        WHERE m.tenant_id = $1 AND m.kind = 'count_adjust' ORDER BY m.at, i.name`, [w.tenant]);
    expect(moves).toEqual([
      { ing: "Flour", outlet: "Outlet 1", qty: -500_000, unit: "g", at: "10-03 20:00", ref_type: "core.stock_count", same_count: true, rule: "inventory.count_adjust", by_rule: true },
      { ing: "Oil", outlet: "Outlet 2", qty: 250_000, unit: "ml", at: "10-05 18:00", ref_type: "core.stock_count", same_count: true, rule: "inventory.count_adjust", by_rule: true },
      { ing: "Flour", outlet: "Outlet 1", qty: -300_000, unit: "g", at: "10-06 18:30", ref_type: "core.stock_count", same_count: true, rule: "inventory.count_adjust", by_rule: true },
      { ing: "Oil", outlet: "Outlet 1", qty: -100_000, unit: "ml", at: "10-06 18:30", ref_type: "core.stock_count", same_count: true, rule: "inventory.count_adjust", by_rule: true },
      { ing: "Paneer", outlet: "Outlet 1", qty: -100_000, unit: "g", at: "10-06 18:30", ref_type: "core.stock_count", same_count: true, rule: "inventory.count_adjust", by_rule: true },
    ]);
    expect(moves.reduce((a, m) => a + m.qty, 0)).toBe(-750_000);
    // The Paneer movement carries the counted batch.
    expect(await count(`SELECT count(*) AS n FROM core.stock_movement m JOIN core.batch b ON b.tenant_id = m.tenant_id AND b.id = m.batch_id
                         WHERE m.tenant_id = $1 AND m.kind = 'count_adjust' AND b.batch_code = 'T93-PB'`, [w.tenant])).toBe(1);
  });

  it("the count's commit is idempotent too: the same key replays, a new key is refused, 0 rows added", async () => {
    const r = RUN.counts!;
    expect((await approve(r.draft, "t93-counts")).status).toBe(200);
    expect((await approve(r.draft)).status).toBeGreaterThanOrEqual(400);
    expect(await countsOf()).toBe(3);
    expect(await count(`SELECT count(*) AS n FROM core.stock_movement WHERE tenant_id = $1 AND kind = 'count_adjust'`, [w.tenant])).toBe(5);
  });
});

describe("two files previewed before either is approved", () => {
  const SH = "Shift No,Date,Outlet,Opened At,Closed At,Opened By,Closed By,Float,Counted Cash,Cash Tenders";
  const CH = "Count No,Date,Time,Outlet,Counted By,Ingredient,Counted Qty,Unit,Batch";
  const put = async (name: string, text: string) => { await writeFile(join(FIXTURES, name), text); };
  it("overlapping shift windows: the first commits, the second goes stale (409 stale_draft, draft stale) and writes 0 shifts", async () => {
    await put("t93_ov_a.csv", `${SH}\nT93-OA,2026-10-09,Outlet 2,10:00,18:00,Owner,Owner,100.00,100.00,0.00\n`);
    await put("t93_ov_b.csv", `${SH}\nT93-OB,2026-10-09,Outlet 2,15:00,20:00,Owner,Owner,100.00,100.00,0.00\n`);
    const a = await preview("shift_log", "t93_ov_a.csv", "shift_log_v1");
    const b = await preview("shift_log", "t93_ov_b.csv", "shift_log_v1");
    expect([a.run.rows_ok, b.run.rows_ok]).toEqual([1, 1]);
    const before = await shiftsOf();
    expect((await approve(a.run.draft_id!)).status).toBe(200);
    expect(await shiftsOf()).toBe(before + 1);
    const res = await approve(b.run.draft_id!);
    expect([res.status, (await res.json()).error?.code, await draftStatus(b.run.draft_id!)]).toEqual([409, "stale_draft", "stale"]);
    expect(await shiftsOf()).toBe(before + 1);
  });
  it("non-overlapping windows previewed together both commit", async () => {
    await put("t93_ok_c.csv", `${SH}\nT93-OC,2026-10-10,Outlet 2,10:00,15:00,Owner,Owner,100.00,100.00,0.00\n`);
    await put("t93_ok_d.csv", `${SH}\nT93-OD,2026-10-10,Outlet 2,15:01,20:00,Owner,Owner,100.00,100.00,0.00\n`);
    const c = await preview("shift_log", "t93_ok_c.csv", "shift_log_v1");
    const d = await preview("shift_log", "t93_ok_d.csv", "shift_log_v1");
    const before = await shiftsOf();
    expect([(await approve(c.run.draft_id!)).status, (await approve(d.run.draft_id!)).status]).toEqual([200, 200]);
    expect(await shiftsOf()).toBe(before + 2);
  });
  it("the same count (outlet and instant) in two files: the first commits, the second goes stale and writes 0 counts or movements", async () => {
    await put("t93_cnt_e.csv", `${CH}\nT93-CE,2026-10-09,11:00,Outlet 3,Owner,Oil,10,ml,\n`);
    await put("t93_cnt_f.csv", `${CH}\nT93-CF,2026-10-09,11:00,Outlet 3,Owner,Oil,20,ml,\n`);
    const e = await preview("stock_count", "t93_cnt_e.csv", "stock_count_v1");
    const f = await preview("stock_count", "t93_cnt_f.csv", "stock_count_v1");
    expect([e.run.rows_ok, f.run.rows_ok]).toEqual([1, 1]);
    const before = [await countsOf(), await count(`SELECT count(*) AS n FROM core.stock_movement WHERE tenant_id = $1 AND kind = 'count_adjust'`, [w.tenant])];
    expect((await approve(e.run.draft_id!)).status).toBe(200);
    const res = await approve(f.run.draft_id!);
    expect([res.status, (await res.json()).error?.code, await draftStatus(f.run.draft_id!)]).toEqual([409, "stale_draft", "stale"]);
    expect([await countsOf(), await count(`SELECT count(*) AS n FROM core.stock_movement WHERE tenant_id = $1 AND kind = 'count_adjust'`, [w.tenant])]).toEqual([before[0]! + 1, before[1]! + 1]);
  });
});

describe("refusals", () => {
  it("an owner's own imports.run.commit.v1 cannot write a shift, a count or a count line (draft-only → MB001)", async () => {
    if (PLANT === "draft-only-off") await db.admin(`UPDATE core.command_authority SET draft_only = false WHERE command_type = 'imports.run.commit.v1'`);
    const own = (sql: string, params: unknown[]) => db.withContext("munim_core", ctx("imports.run.commit.v1"), (c) => c.query(sql, params))
      .then(() => "accepted", (e: { code?: string }) => e.code);
    const shift = await own(`INSERT INTO core.shift (tenant_id, id, outlet_id, status, opened_by, opened_at, float_minor, currency, closed_by, closed_at, counted_cash_minor, expected_cash_minor, variance_minor)
                             VALUES ($1, $2, $3, 'closed', $4, '2026-09-01T05:00:00Z', 0, 'INR', $4, '2026-09-01T10:00:00Z', 0, 0, 0)`, [w.tenant, uuidv7(), w.outlets[0], w.owner]);
    const countId = uuidv7();
    const committed = (await rows<{ id: string }>(`SELECT id FROM core.stock_count WHERE tenant_id = $1 LIMIT 1`, [w.tenant]))[0]!.id;
    const cnt = await own(`INSERT INTO core.stock_count (tenant_id, id, outlet_id, counted_by, counted_at, status) VALUES ($1, $2, $3, $4, '2026-09-01T05:00:00Z', 'submitted')`,
      [w.tenant, countId, w.outlets[0], w.owner]);
    const line = await own(`INSERT INTO core.stock_count_line (tenant_id, id, stock_count_id, ingredient_id, expected_qty_milli, counted_qty_milli, unit) VALUES ($1, $2, $3, $4, 0, 0, 'g')`,
      [w.tenant, uuidv7(), committed, w.ingredient]);
    expect([shift, cnt, line]).toEqual(["MB001", "MB001", "MB001"]);
  });

  it("a month closed between the preview and the approval: 409 period_closed for a shift log and for a count; nothing written", async () => {
    const s = await preview("shift_log", "t93_shift_close.csv", "shift_log_v1");
    const k = await preview("stock_count", "t93_count_close.csv", "stock_count_v1");
    expect([s.run.rows_ok, k.run.rows_ok]).toEqual([1, 1]);
    const before = [await shiftsOf(), await countsOf()];
    if (PLANT !== "no-close") {
      await db.withContext("munim_core", ctx("finance.period.close.v1"), (c) => c.query(
        `INSERT INTO core.period_close (tenant_id, id, outlet_id, period_month, checklist, net_minor, currency, closed_by) VALUES ($1, $2, $3, '2026-10-01', '[]', 0, 'INR', $4)`,
        [w.tenant, uuidv7(), w.outlets[2], w.owner]));
    }
    for (const p of [s, k]) {
      const res = await approve(p.run.draft_id!);
      expect([res.status, (await res.json()).error?.code]).toEqual([409, "period_closed"]);
    }
    expect([await shiftsOf(), await countsOf()]).toEqual(before);
  });
});

describe("W3.2 review fixes: races, back-dated counts, drift, live device-less cash", () => {
  const SH = "Shift No,Date,Outlet,Opened At,Closed At,Opened By,Closed By,Float,Counted Cash,Cash Tenders";
  const CH = "Count No,Date,Time,Outlet,Counted By,Ingredient,Counted Qty,Unit,Batch";
  const BH = "Bill No,Bill Date,Bill Time,Outlet,Channel,Brand,Order Type,Customer Phone,Bill Status,Item Code,Variant Code,Qty,Unit Price,Tax Class,Line Discount,Line Total,Void Reason,Cash,Card,UPI,Refund,Refund Mode,Refund Reason,Refund Date";
  const put = async (name: string, text: string) => { await writeFile(join(FIXTURES, name), text); };
  const adjusts = () => count(`SELECT count(*) AS n FROM core.stock_movement WHERE tenant_id = $1 AND kind = 'count_adjust'`, [w.tenant]);
  const status = async (draft: string) => (await rows<{ status: string }>(`SELECT status FROM core.draft WHERE id = $1`, [draft]))[0]!.status;
  // Only this database's waits: the cluster is shared with other test files' clones.
  const ungranted = () => count(`SELECT count(*) AS n FROM pg_locks WHERE NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`);
  /** Holds `table` in SHARE mode (reads pass, INSERTs wait), starts each approval in turn once the previous one waits, then
   *  lets go: without a per-outlet lock taken BEFORE the re-checks, both approvals pass their checks and both commit. */
  async function race(table: string, steps: Array<() => Promise<Res>>): Promise<Res[]> {
    const barrier = await db.connect("admin");
    await barrier.query("BEGIN");
    await barrier.query(`LOCK TABLE ${table} IN SHARE MODE`);
    const pending: Array<Promise<Res>> = [];
    try {
      for (const [i, step] of steps.entries()) {
        pending.push(step());
        for (let k = 0; (await ungranted()) < i + 1; k++) {
          if (k > 400) throw new Error(`race: approval ${i + 1} never blocked`);
          await new Promise((r) => setTimeout(r, 25));
        }
      }
    } finally {
      await barrier.query("COMMIT");
      await barrier.end();
    }
    return Promise.all(pending);
  }

  it("R-A 10: a live device-less cash tender and refund on a past day are not drawer cash (Cash Tenders 0.00 → staged); 500.00 → tender_mismatch", async () => {
    // A storefront-style order at outlet 2 (device NULL, live pricing — no import run) paid 500.00 cash at 12:00 on 6 Oct and
    // refunded 100.00 cash at 13:00: either leg counted would make core's cash +500.00 or −100.00, not 0.00.
    const order = uuidv7(), tender = uuidv7();
    await db.admin(`SET session_replication_role = replica;
      INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, kind, status, subtotal_minor, tax_minor, total_minor, currency, pricing_snapshot, business_date, ticket_no, origin)
        VALUES ('${w.tenant}', '${order}', '${w.outlets[1]}', '${w.channel}', 'takeaway', 'completed', 47619, 2381, 50000, 'INR', '{}', '2026-10-06', 9301, '{}');
      INSERT INTO core.tender (tenant_id, id, outlet_id, order_id, method, amount_minor, currency, recorded_by, at, origin)
        VALUES ('${w.tenant}', '${tender}', '${w.outlets[1]}', '${order}', 'cash', 50000, 'INR', '${w.owner}', '2026-10-06T12:00:00+05:30', '{}');
      INSERT INTO core.refund (tenant_id, id, outlet_id, order_id, tender_id, method, amount_minor, currency, reason_code, note, actor, at, origin)
        VALUES ('${w.tenant}', '${uuidv7()}', '${w.outlets[1]}', '${order}', '${tender}', 'cash', 10000, 'INR', 'wrong_item', 'Synthetic refund', '${w.owner}',
                '2026-10-06T13:00:00+05:30', '{}');
      SET session_replication_role = origin`);
    await put("t93_w32_live0.csv", `${SH}\nT93-L0,2026-10-06,Outlet 2,10:00,18:00,Owner,Owner,100.00,100.00,0.00\n`);
    await put("t93_w32_live5.csv", `${SH}\nT93-L5,2026-10-06,Outlet 2,10:00,18:00,Owner,Owner,100.00,600.00,500.00\n`);
    const zero = await preview("shift_log", "t93_w32_live0.csv", "shift_log_v1");
    const five = await preview("shift_log", "t93_w32_live5.csv", "shift_log_v1");
    expect([zero.run.rows_ok, zero.quarantined]).toEqual([1, {}]);
    expect([five.run.rows_ok, five.quarantined]).toEqual([0, { "2": "tender_mismatch" }]);
  });

  it("R-A 3: a count before a later submitted count of the same ingredient → later_count_exists (sibling count_rejected); after it → staged", async () => {
    // Books: outlet 1 Flour and Oil were counted at 3 Oct 20:00 and 6 Oct 18:30, Paneer batch T93-PB at 6 Oct 18:30.
    await put("t93_w32_back.csv", `${CH}\nT93-K1,2026-10-05,12:00,Outlet 1,Owner,Flour,9000,g,\nT93-K1,2026-10-05,12:00,Outlet 1,Owner,Salt,100,g,\n`
      + `T93-K2,2026-10-04,12:00,Outlet 1,Owner,Paneer,500,g,T93-PB\nT93-K3,2026-10-07,12:00,Outlet 1,Owner,Flour,9700,g,\n`);
    await db.withContext("munim_core", ctx("inventory.ingredient.upsert.v1"), (c) =>
      c.query(`INSERT INTO core.ingredient (tenant_id, id, name, base_unit, tracked_by_batch) VALUES ($1, $2, 'Salt', 'g', false)`, [w.tenant, uuidv7()]));
    const p = await preview("stock_count", "t93_w32_back.csv", "stock_count_v1");
    expect(p.quarantined).toEqual({ "2": "later_count_exists", "3": "count_rejected", "4": "later_count_exists" });
    expect(p.staged.map((s) => [s.data.count_no, s.data.counted_qty_milli])).toEqual([["T93-K3", 9_700_000]]);
  });

  it("R-A 3: a later count approved after this one's preview → this approval goes stale (409 stale_draft), 0 counts; the later one committed", async () => {
    await put("t93_w32_late_a.csv", `${CH}\nT93-KA,2026-10-08,09:00,Outlet 1,Owner,Oil,4800,ml,\n`);
    await put("t93_w32_late_b.csv", `${CH}\nT93-KB,2026-10-08,15:00,Outlet 1,Owner,Oil,4700,ml,\n`);
    const a = await preview("stock_count", "t93_w32_late_a.csv", "stock_count_v1");
    const b = await preview("stock_count", "t93_w32_late_b.csv", "stock_count_v1");
    expect([a.run.rows_ok, b.run.rows_ok]).toEqual([1, 1]);
    const before = await countsOf();
    expect((await approve(b.run.draft_id!)).status).toBe(200);
    const res = await approve(a.run.draft_id!);
    expect([res.status, (await res.json()).error?.code, await status(a.run.draft_id!)]).toEqual([409, "stale_draft", "stale"]);
    expect(await countsOf()).toBe(before + 1);
  });

  it("R-A 2: two overlapping shift files approved at once → the first 200, the second stale (409 stale_draft); 1 shift written", async () => {
    await put("t93_w32_race_p.csv", `${SH}\nT93-RP,2026-10-08,Outlet 1,10:00,14:00,Owner,Owner,100.00,100.00,0.00\n`);
    await put("t93_w32_race_q.csv", `${SH}\nT93-RQ,2026-10-08,Outlet 1,13:00,18:00,Owner,Owner,100.00,100.00,0.00\n`);
    const p = await preview("shift_log", "t93_w32_race_p.csv", "shift_log_v1");
    const q = await preview("shift_log", "t93_w32_race_q.csv", "shift_log_v1");
    expect([p.run.rows_ok, q.run.rows_ok]).toEqual([1, 1]);
    const before = await shiftsOf();
    const [rp, rq] = await race("core.shift", [() => approve(p.run.draft_id!), () => approve(q.run.draft_id!)]);
    expect([rp!.status, rq!.status, (await rq!.json()).error?.code, await status(q.run.draft_id!)]).toEqual([200, 409, "stale_draft", "stale"]);
    expect(await shiftsOf()).toBe(before + 1);
  });

  it("R-A 2: two count files of one ingredient approved at once, the earlier-dated second → 200 then stale (409 stale_draft); 1 count written", async () => {
    await put("t93_w32_race_r.csv", `${CH}\nT93-RR,2026-10-09,15:00,Outlet 1,Owner,Flour,9600,g,\n`);
    await put("t93_w32_race_s.csv", `${CH}\nT93-RS,2026-10-09,10:00,Outlet 1,Owner,Flour,9650,g,\n`);
    const r = await preview("stock_count", "t93_w32_race_r.csv", "stock_count_v1");
    const s = await preview("stock_count", "t93_w32_race_s.csv", "stock_count_v1");
    expect([r.run.rows_ok, s.run.rows_ok]).toEqual([1, 1]);
    const before = await countsOf();
    const [rr, rs] = await race("core.stock_count", [() => approve(r.run.draft_id!), () => approve(s.run.draft_id!)]);
    expect([rr!.status, rs!.status, (await rs!.json()).error?.code, await status(s.run.draft_id!)]).toEqual([200, 409, "stale_draft", "stale"]);
    expect(await countsOf()).toBe(before + 1);
  });

  it("R-A 3: a live count submitted while a back-dated count's approval runs → the live count commits, the approval goes stale; 0 history counts", async () => {
    await put("t93_w32_race_live.csv", `${CH}\nT93-RL,2026-10-09,12:00,Outlet 2,Owner,Flour,0,g,\n`);
    const h = await preview("stock_count", "t93_w32_race_live.csv", "stock_count_v1");
    expect(h.run.rows_ok).toBe(1);
    const flour = (await rows<{ id: string }>(`SELECT id FROM core.ingredient WHERE tenant_id = $1 AND name = 'Flour'`, [w.tenant]))[0]!.id;
    const live = () => call("POST", "/v1/inventory/counts", { command_id: uuidv7(), idempotency_key: `t93-live-${uuidv7()}`, type: "inventory.count.submit.v1",
      payload: { count_id: uuidv7(), outlet_id: w.outlets[1], lines: [{ line_id: uuidv7(), ingredient_id: flour, batch_id: null, counted_qty_milli: 0, unit: "g" }] } });
    const before = await countsOf();
    const [rl, rh] = await race("core.stock_count", [live, () => approve(h.run.draft_id!)]);
    expect([rl!.status, rh!.status, (await rh!.json()).error?.code, await status(h.run.draft_id!)]).toEqual([200, 409, "stale_draft", "stale"]);
    expect(await countsOf()).toBe(before);
  });

  it("a negative Cash Tenders (a cash refund above the window's cash takings) is staged and commits; a negative float or counted cash → amount_negative", async () => {
    // A history-imported order at outlet 2 paid 336.00 cash on 3 Oct and refunded 100.00 cash at 13:00 on 5 Oct: core's
    // cash in the 5 Oct 10:00–18:00 window is −100.00, so expected = 200.00 − 100.00 = 100.00.
    const order = uuidv7(), tender = uuidv7();
    await db.admin(`SET session_replication_role = replica;
      INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, kind, status, subtotal_minor, tax_minor, total_minor, currency, pricing_snapshot, business_date, ticket_no, origin)
        VALUES ('${w.tenant}', '${order}', '${w.outlets[1]}', '${w.channel}', 'takeaway', 'completed', 32000, 1600, 33600, 'INR',
                '{"import_run_id": "${uuidv7()}"}', '2026-10-03', 9302, '{}');
      INSERT INTO core.tender (tenant_id, id, outlet_id, order_id, method, amount_minor, currency, recorded_by, at, origin)
        VALUES ('${w.tenant}', '${tender}', '${w.outlets[1]}', '${order}', 'cash', 33600, 'INR', '${w.owner}', '2026-10-03T12:00:00+05:30', '{}');
      INSERT INTO core.refund (tenant_id, id, outlet_id, order_id, tender_id, method, amount_minor, currency, reason_code, note, actor, at, origin)
        VALUES ('${w.tenant}', '${uuidv7()}', '${w.outlets[1]}', '${order}', '${tender}', 'cash', 10000, 'INR', 'wrong_item', 'Synthetic refund', '${w.owner}',
                '2026-10-05T13:00:00+05:30', '{}');
      SET session_replication_role = origin`);
    await put("t93_w32_neg_bad.csv", `${SH}\nT93-NF,2026-10-05,Outlet 2,10:00,18:00,Owner,Owner,-200.00,100.00,-100.00\n` +
      `T93-NC,2026-10-05,Outlet 2,10:00,18:00,Owner,Owner,200.00,-1.00,-100.00\nT93-NE,2026-10-05,Outlet 2,10:00,18:00,Owner,Owner,50.00,0.00,-100.00\n`);
    const bad = await preview("shift_log", "t93_w32_neg_bad.csv", "shift_log_v1");
    expect([bad.run.rows_ok, bad.quarantined]).toEqual([0, { "2": "amount_negative", "3": "amount_negative", "4": "expected_negative" }]);
    await put("t93_w32_neg.csv", `${SH}\nT93-N1,2026-10-05,Outlet 2,10:00,18:00,Owner,Owner,200.00,100.00,-100.00\n`);
    const p = await preview("shift_log", "t93_w32_neg.csv", "shift_log_v1");
    expect([p.run.rows_ok, p.quarantined]).toEqual([1, {}]);
    expect((await approve(p.run.draft_id!)).status).toBe(200);
    expect(await rows(`SELECT float_minor::int AS f, counted_cash_minor::int AS c, expected_cash_minor::int AS e, variance_minor::int AS v
                         FROM core.shift WHERE tenant_id = $1 AND outlet_id = $2 AND device_id IS NULL AND opened_at = '2026-10-05T10:00:00+05:30'`,
      [w.tenant, w.outlets[1]])).toEqual([{ f: 20000, c: 10000, e: 10000, v: 0 }]);
  });

  it("R-A 6: an imported cash bill lands in a previewed shift's window → 409 stale_draft, draft stale, 0 shifts; retry → 409 stale_draft", async () => {
    await put("t93_w32_drift_s.csv", `${SH}\nT93-DS,2026-10-07,Outlet 2,10:00,18:00,Owner,Owner,100.00,100.00,0.00\n`);
    await put("t93_w32_drift_b.csv", `${BH}\nT93-D1,2026-10-07,12:00,Outlet 2,counter,,dine_in,,,menu.paneer_tikka,,1,320.00,restaurant_5,0,336.00,,336.00,0,0,,,,\n`);
    const sh = await preview("shift_log", "t93_w32_drift_s.csv", "shift_log_v1");
    expect(sh.run.rows_ok).toBe(1);
    const bills = await preview("pos_bills", "t93_w32_drift_b.csv", "pos_bills_v2");
    expect((await approve(bills.run.draft_id!)).status).toBe(200);
    const before = await shiftsOf();
    const res = await approve(sh.run.draft_id!);
    expect([res.status, (await res.json()).error?.code, await status(sh.run.draft_id!)]).toEqual([409, "stale_draft", "stale"]);
    const again = await approve(sh.run.draft_id!);
    expect([again.status, (await again.json()).error?.code]).toEqual([409, "stale_draft"]);
    expect(await shiftsOf()).toBe(before);
  });

  it("R-A 6: a staged bill whose tax is no longer core's re-derivation → 409 stale_draft, draft stale, 0 orders", async () => {
    await put("t93_w32_drift_t.csv", `${BH}\nT93-D2,2026-10-08,14:00,Outlet 2,counter,,dine_in,,,menu.paneer_tikka,,1,320.00,restaurant_5,0,336.00,,336.00,0,0,,,,\n`);
    const p = await preview("pos_bills", "t93_w32_drift_t.csv", "pos_bills_v2");
    expect(p.run.rows_ok).toBe(1);
    // The preview's figure and core's now differ by one paisa (as a pack or MRP change since the preview would make them).
    await db.admin(`UPDATE core.import_staging SET data = jsonb_set(data, '{line_tax_minor}', to_jsonb((data ->> 'line_tax_minor')::int + 1)) WHERE import_run_id = $1`,
      [p.run.import_run_id]);
    const res = await approve(p.run.draft_id!);
    expect([res.status, (await res.json()).error?.code, await status(p.run.draft_id!)]).toEqual([409, "stale_draft", "stale"]);
    expect(await count(`SELECT count(*) AS n FROM core."order" WHERE tenant_id = $1 AND external_ref = 'T93-D2'`, [w.tenant])).toBe(0);
  });

  it("R-A 6: an earlier count approved after a later one's preview moves its expected → 409 stale_draft, draft stale, 0 counts", async () => {
    // Outlet 2 Oil: 250,000 on hand since the 5 Oct count. F at 9 Oct 12:00 is previewed against 250,000; E at 8 Oct (counted 300)
    // adjusts +50,000 before F's instant, so F's figure is no longer core's.
    await put("t93_w32_drift_f.csv", `${CH}\nT93-DF,2026-10-09,12:00,Outlet 2,Owner,Oil,200,ml,\n`);
    await put("t93_w32_drift_e.csv", `${CH}\nT93-DE,2026-10-08,12:00,Outlet 2,Owner,Oil,300,ml,\n`);
    const f = await preview("stock_count", "t93_w32_drift_f.csv", "stock_count_v1");
    const e = await preview("stock_count", "t93_w32_drift_e.csv", "stock_count_v1");
    expect([f.staged[0]!.data.expected_qty_milli, e.staged[0]!.data.expected_qty_milli]).toEqual([250_000, 250_000]);
    expect((await approve(e.run.draft_id!)).status).toBe(200);
    const before = [await countsOf(), await adjusts()];
    const res = await approve(f.run.draft_id!);
    expect([res.status, (await res.json()).error?.code, await status(f.run.draft_id!)]).toEqual([409, "stale_draft", "stale"]);
    expect([await countsOf(), await adjusts()]).toEqual(before);
  });
});

