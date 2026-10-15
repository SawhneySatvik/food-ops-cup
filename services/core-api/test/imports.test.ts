// T-030 gates — imports through the real app (member auth → RLS → book guard) and the core-worker parse job.
//   4 synthetic sample files per format → rows_ok, quarantine reasons, the file's total and the staged total =
//     the hand-written key (services/core-worker/test/fixtures/imports/KEY.json);
//   0 book rows before approval, rows_ok after, under the approver's decision; a mismatched total needs a reason;
//   re-uploading the same file returns the existing document and run;
//   a mapping with arithmetic (an expression as a column, a formula key, a unit on a text field) is refused;
//     a rename + unit mapping is approved and then reads its layout.
// Synthetic data only.
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@munim/config";
import { ImportRunRowsResponse, ImportRunView, ImportsFormatProposeResponse, ImportsRunsResponse, ImportsUploadResponse } from "@munim/contracts/imports";
import { PACKS } from "@munim/contracts/packs";
import { buildWorld, type TestDb, uuidv7, type World } from "@munim/db";
import type { Hono } from "hono";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalIdp } from "../src/auth/local-idp.ts";
import { parsePendingImports } from "../../core-worker/src/imports/index.ts";
import { type AppEnv, createApp, TENANT_HEADER } from "../src/app.ts";
import { seedChart } from "../src/modules/finance/index.ts";
import { localBlobStore } from "../src/modules/imports/index.ts";
import { openDb } from "./db.ts";

const FIXTURES = join(import.meta.dirname, "../../core-worker/test/fixtures/imports");
type KeyEntry = { country: "IN" | "AU"; kind: string; parser: string; rows_ok: number; control_total_minor: number | null;
  staged_total_minor: number | null; quarantine: Record<string, string> };
const KEY = JSON.parse(await readFile(join(FIXTURES, "KEY.json"), "utf8")) as { files: Record<string, KeyEntry> };

const idp = createLocalIdp();
let db: TestDb;
let pools: { core: pg.Pool; svc: pg.Pool };
let app: Hono<AppEnv>;
let blobDir: string;

type Who = "owner" | "staff" | "manager";
interface Tenant { w: World; subs: Record<Who, string>; manager: string }
const T: Record<"IN" | "AU", Tenant> = {} as Record<"IN" | "AU", Tenant>;
/** file → its run, filled by the parse gates and used by the commit gates. */
const RUNS = new Map<string, { country: "IN" | "AU"; run: string; draft: string; key: KeyEntry }>();

const own = (w: World, command_type: string) => ({ tenant_id: w.tenant, outlet_ids: "*" as const, role: "owner" as const, member_id: w.owner, command_type });

async function tenant(country: "IN" | "AU"): Promise<Tenant> {
  const w = await buildWorld(db, { country });
  const t: Tenant = { w, manager: uuidv7(), subs: { owner: `owner-${uuidv7()}`, staff: `staff-${uuidv7()}`, manager: `manager-${uuidv7()}` } };
  await db.withContext("munim_core", own(w, "tenancy.member.invite.v1"), async (c) => {
    await c.query(`UPDATE core.member SET idp_sub = $2 WHERE id = $1`, [w.owner, t.subs.owner]);
    await c.query(`UPDATE core.member SET idp_sub = $2 WHERE id = $1`, [w.staff, t.subs.staff]);
    await c.query(`INSERT INTO core.member (tenant_id, id, idp_sub, name, email) VALUES ($1, $2, $3, 'Synthetic Manager', 'manager@example.test')`,
      [w.tenant, t.manager, t.subs.manager]);
    await c.query(`INSERT INTO core.membership (tenant_id, member_id, role, outlet_ids) VALUES ($1, $2, 'manager', $3)`, [w.tenant, t.manager, [w.outlets[0]]]);
  });
  // A provisioned tenant has its pack's chart of accounts (finance's seedChart, as tenancy.provision.v1 runs it);
  // the canonical world carries only two accounts, and imports post through finance.
  await db.withContext("munim_core", own(w, "finance.account.upsert.v1"), (c) => seedChart(c, PACKS[country]));
  // The pack's aggregators as channels (the owner's own command).
  await db.withContext("munim_core", own(w, "tenancy.channel.create.v1"), async (c) => {
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

const uploadBody = (kind: string, filename: string, bytes: Buffer) => ({ kind, filename, media_type: "text/csv", content_base64: bytes.toString("base64") });
const upload = async (country: "IN" | "AU", kind: string, file: string, who: Who = "owner") =>
  call(country, who, "POST", "/v1/imports/documents", uploadBody(kind, file, await readFile(join(FIXTURES, file))));
const parse = (country: "IN" | "AU") =>
  parsePendingImports({ pool: pools.svc, blobs: localBlobStore(blobDir), log: () => {} }, [T[country].w.tenant]);
const approve = (country: "IN" | "AU", who: Who, draft: string, command_type: string, reason: string | null = null) =>
  call(country, who, "POST", `/v1/drafts/${draft}:approve`, {
    command_id: uuidv7(), idempotency_key: `imp-${uuidv7()}`, type: "drafts.approve.v1",
    payload: { draft_id: draft, command_type, edited_payload: null, reason },
  });

const one = async <R extends pg.QueryResultRow>(sql: string, params: unknown[] = []) => (await db.admin(sql, params)).rows[0] as R;
const count = async (sql: string, params: unknown[] = []) => Number((await one<{ n: string }>(sql, params)).n);
/** Book rows that came from one import run, across every table a commit writes. */
const bookRows = (run: string) => count(
  `SELECT (SELECT count(*) FROM core.settlement_line l JOIN core.settlement s ON s.tenant_id = l.tenant_id AND s.id = l.settlement_id WHERE s.import_run_id = $1)
        + (SELECT count(*) FROM core.bank_line WHERE import_run_id = $1)
        + (SELECT count(*) FROM core.expense e JOIN core.import_run r ON r.tenant_id = e.tenant_id AND r.document_id = e.document_id WHERE r.id = $1)
        + (SELECT count(*) FROM core.market_signal WHERE import_run_id = $1) AS n`, [run]);

beforeAll(async () => {
  db = await openDb();
  T.IN = await tenant("IN");
  T.AU = await tenant("AU");
  pools = { core: db.pool("munim_core", 8), svc: db.pool("munim_svc", 2) };
  blobDir = await mkdtemp(join(tmpdir(), "munim-imports-"));
  const config = { nodeEnv: "test", redact: (s: string) => s };
  // The routes and the worker's parse job share one store, handed over as Deps (not a module global).
  app = await createApp({ pools, idp, storefronts: async () => null, blobs: localBlobStore(blobDir), config, log: createLogger(config, () => {}) });
});

afterAll(async () => {
  await pools?.core.end();
  await pools?.svc.end();
  await db?.stop();
  if (blobDir) await rm(blobDir, { recursive: true, force: true });
});

const FILES = Object.keys(KEY.files).sort();

describe("the answer key itself", () => {
  it("has 4 synthetic sample files for each of the 8 formats, each present on disk, and ≥ 3 planted bad rows", async () => {
    const perParser = new Map<string, number>();
    for (const f of FILES) perParser.set(KEY.files[f]!.parser, (perParser.get(KEY.files[f]!.parser) ?? 0) + 1);
    expect([...perParser.values()]).toEqual(Array(8).fill(4));
    expect((await readdir(FIXTURES)).filter((f) => f.endsWith(".csv")).sort()).toEqual(FILES);
    expect(FILES.every((f) => f.startsWith("synthetic_"))).toBe(true);
    expect(FILES.reduce((n, f) => n + Object.keys(KEY.files[f]!.quarantine).length, 0)).toBeGreaterThanOrEqual(3);
  });
});

describe("parse: each sample file → rows_ok, quarantine reasons and totals = the hand-written key; nothing in the books", () => {
  it.each(FILES)("%s", async (file) => {
    const k = KEY.files[file]!;
    const up = await upload(k.country, k.kind, file);
    expect(up.status).toBe(200);
    const u = ImportsUploadResponse.parse(await up.json());
    expect(u).toMatchObject({ duplicate: false, header: null, run: { status: "parsing", parser: k.parser, rows_ok: 0, draft_id: null } });

    expect(await parse(k.country)).toEqual({ previewed: 1, failed: 0, skipped: 0, errors: 0 });

    const run = ImportRunView.parse(await (await call(k.country, "owner", "GET", `/v1/imports/runs/${u.run!.import_run_id}`)).json());
    expect(run).toMatchObject({
      status: "previewed", rows_ok: k.rows_ok, rows_quarantined: Object.keys(k.quarantine).length,
      control_total_minor: k.control_total_minor, currency: k.control_total_minor === null ? null : k.country === "IN" ? "INR" : "AUD",
      total_matches: k.control_total_minor === null ? null : k.control_total_minor === k.staged_total_minor,
    });
    expect(run.draft_id).not.toBeNull();

    const rows = ImportRunRowsResponse.parse(await (await call(k.country, "owner", "GET", `/v1/imports/runs/${run.import_run_id}/rows`)).json());
    expect(Object.fromEntries(rows.quarantined.map((q) => [String(q.row_no), q.reason_code]))).toEqual(k.quarantine);
    expect(rows.staged).toHaveLength(k.rows_ok);
    if (k.staged_total_minor === null) expect(rows.staged.every((s) => s.amount_minor === null)).toBe(true);
    else expect(rows.staged.reduce((a, s) => a + s.amount_minor!, 0)).toBe(k.staged_total_minor);

    expect(await bookRows(run.import_run_id)).toBe(0);
    expect(await one(`SELECT status, source, command_type FROM core.draft WHERE id = $1`, [run.draft_id]))
      .toEqual({ status: "proposed", source: "import", command_type: "imports.run.commit.v1" });
    RUNS.set(file, { country: k.country, run: run.import_run_id, draft: run.draft_id!, key: k });
  });
});

describe("commit on approval: 0 book rows before, rows_ok after, under the approver", () => {
  it("a manager scoped to one outlet does not even see a tenant-wide import draft (404); nothing is written", async () => {
    const r = RUNS.get("synthetic_bank_1.csv")!;
    const res = await approve("IN", "manager", r.draft, "imports.run.commit.v1");
    expect(res.status).toBe(404);
    expect(await bookRows(r.run)).toBe(0);
  });

  it("a total that does not match the file's needs a reason: without → 422 and 0 rows; with → committed", async () => {
    const r = RUNS.get("synthetic_swiggy_3.csv")!;
    expect(r.key.control_total_minor).not.toBe(r.key.staged_total_minor);
    const refused = await approve("IN", "owner", r.draft, "imports.run.commit.v1");
    expect(refused.status).toBe(422);
    expect((await refused.json()).error.code).toBe("invalid_payload");
    expect(await bookRows(r.run)).toBe(0);
    expect((await one<{ status: string }>(`SELECT status FROM core.draft WHERE id = $1`, [r.draft])).status).toBe("proposed");
    const ok = await approve("IN", "owner", r.draft, "imports.run.commit.v1", "Two rows were quarantined; the rest are right");
    expect(ok.status).toBe(200);
    expect(await bookRows(r.run)).toBe(r.key.rows_ok);
  });

  const committable = FILES.filter((f) => KEY.files[f]!.kind !== "pos_export" && f !== "synthetic_swiggy_3.csv");
  it.each(committable)("%s", async (file) => {
    const r = RUNS.get(file)!;
    const t = T[r.country];
    expect(await bookRows(r.run)).toBe(0);
    const res = await approve(r.country, "owner", r.draft, "imports.run.commit.v1");
    expect(res.status).toBe(200);
    expect(await bookRows(r.run)).toBe(r.key.rows_ok);
    const run = await one<{ status: string; decision_id: string; decided_by: string }>(
      `SELECT r.status, r.decision_id, d.decided_by FROM core.import_run r JOIN core.decision d ON d.tenant_id = r.tenant_id AND d.id = r.decision_id WHERE r.id = $1`, [r.run]);
    expect(run).toMatchObject({ status: "committed", decided_by: t.w.owner });
    // Book rows carry the approval as their origin (the guard's decision branch), never a bare command.
    const origins = await db.admin(
      `SELECT DISTINCT origin->>'kind' AS kind, origin->>'decision_id' AS decision FROM (
         SELECT l.origin FROM core.settlement_line l JOIN core.settlement s ON s.tenant_id = l.tenant_id AND s.id = l.settlement_id WHERE s.import_run_id = $1
         UNION ALL SELECT origin FROM core.bank_line WHERE import_run_id = $1
         UNION ALL SELECT e.origin FROM core.expense e JOIN core.import_run r ON r.tenant_id = e.tenant_id AND r.document_id = e.document_id WHERE r.id = $1) o`, [r.run]);
    if (r.key.kind !== "market_signal") expect(origins.rows).toEqual([{ kind: "decision", decision: run.decision_id }]);
  });

  it("settlement amounts are the file's own figures (synthetic_swiggy_1: 4 lines, net Σ = 138039 paise)", async () => {
    const r = RUNS.get("synthetic_swiggy_1.csv")!;
    const s = await one<{ net_minor: string; lines: string; ads: string }>(
      `SELECT s.net_minor, count(l.*) AS lines, sum(l.ad_fee_minor) AS ads FROM core.settlement s JOIN core.settlement_line l ON l.tenant_id = s.tenant_id AND l.settlement_id = s.id
        WHERE s.import_run_id = $1 GROUP BY s.net_minor`, [r.run]);
    expect(s).toEqual({ net_minor: "138039", lines: "4", ads: "15000" });
  });

  it("imported money is posted through finance: 1 settlement entry (synthetic_swiggy_1), 3 expense entries (synthetic_tally_1)", async () => {
    const entries = (rule: string, table: string, run: string) => count(
      `SELECT count(*) n FROM core.journal_entry j WHERE j.posting_rule = $1 AND j.source_type = $2 AND j.source_id IN (
         SELECT s.id FROM core.settlement s WHERE s.import_run_id = $3
         UNION ALL SELECT e.id FROM core.expense e JOIN core.import_run r ON r.tenant_id = e.tenant_id AND r.document_id = e.document_id WHERE r.id = $3)`,
      [rule, table, run]);
    expect(await entries("finance.post_settlement", "core.settlement", RUNS.get("synthetic_swiggy_1.csv")!.run)).toBe(1);
    expect(await entries("finance.post_expense", "core.expense", RUNS.get("synthetic_tally_1.csv")!.run)).toBe(3);
  });

  it("POS export commit (0015 A7): 4 bills → 4 completed orders + 4 tenders under the approval, each posted as a sale; staff cannot approve", async () => {
    const r = RUNS.get("synthetic_pos_1.csv")!;
    const mine = (sql: string) => db.admin(sql, [T.IN.w.tenant, r.run]).then((x) => x.rows);
    const ORDERS = `SELECT o.external_ref AS bill, o.business_date::text AS bd, o.status, o.kind, o.subtotal_minor::int AS sub, o.discount_minor::int AS disc,
                           o.tax_minor::int AS tax, o.total_minor::int AS total, o.invoice_no, o.origin ->> 'kind' AS origin
                      FROM core."order" o WHERE o.tenant_id = $1 AND o.pricing_snapshot ->> 'import_run_id' = $2::text ORDER BY o.external_ref`;
    // Refusal: staff may not approve an import (not in imports.run.commit.v1's allowed roles) — nothing written.
    expect((await approve("IN", "staff", r.draft, "imports.run.commit.v1")).status).toBe(404);
    expect(await mine(ORDERS)).toEqual([]);
    const res = await approve("IN", "owner", r.draft, "imports.run.commit.v1");
    expect(res.status).toBe(200);
    // Hand-copied from synthetic_pos_1.csv (paise): the file's own figures, the bill's date, no device invoice number.
    expect(await mine(ORDERS)).toEqual([
      { bill: "SYN-B-0001", bd: "2026-10-01", status: "completed", kind: "dine_in", sub: 40000, disc: 0, tax: 2000, total: 42000, invoice_no: null, origin: "decision" },
      { bill: "SYN-B-0002", bd: "2026-10-01", status: "completed", kind: "takeaway", sub: 25000, disc: 2500, tax: 1125, total: 23625, invoice_no: null, origin: "decision" },
      { bill: "SYN-B-0003", bd: "2026-10-02", status: "completed", kind: "dine_in", sub: 100000, disc: 0, tax: 5000, total: 105000, invoice_no: null, origin: "decision" },
      { bill: "SYN-B-0004", bd: "2026-10-02", status: "completed", kind: "takeaway", sub: 12000, disc: 0, tax: 600, total: 12600, invoice_no: null, origin: "decision" },
    ]);
    expect(await mine(`SELECT t.ref AS bill, t.method, t.amount_minor::int AS amount, t.origin ->> 'kind' AS origin FROM core.tender t JOIN core."order" o ON o.tenant_id = t.tenant_id AND o.id = t.order_id
                        WHERE o.tenant_id = $1 AND o.pricing_snapshot ->> 'import_run_id' = $2::text ORDER BY t.ref`)).toEqual([
      { bill: "SYN-B-0001", method: "cash", amount: 42000, origin: "decision" },
      { bill: "SYN-B-0002", method: "upi", amount: 23625, origin: "decision" },
      { bill: "SYN-B-0003", method: "card", amount: 105000, origin: "decision" },
      { bill: "SYN-B-0004", method: "upi", amount: 12600, origin: "decision" },
    ]);
    // Each bill posts as a live sale does: one finance.post_order and one finance.post_tender entry, dated on the bill.
    expect(await mine(`SELECT j.posting_rule AS rule, count(*)::int AS n, min(j.entry_date)::text AS first, max(j.entry_date)::text AS last
                         FROM core.journal_entry j WHERE j.tenant_id = $1 AND j.origin ->> 'kind' = 'derivation'
                          AND (j.source_id IN (SELECT id FROM core."order" WHERE pricing_snapshot ->> 'import_run_id' = $2::text)
                            OR j.source_id IN (SELECT t.id FROM core.tender t JOIN core."order" o ON o.tenant_id = t.tenant_id AND o.id = t.order_id WHERE o.pricing_snapshot ->> 'import_run_id' = $2::text))
                        GROUP BY 1 ORDER BY 1`)).toEqual([
      { rule: "finance.post_order", n: 4, first: "2026-10-01", last: "2026-10-02" },
      { rule: "finance.post_tender", n: 4, first: "2026-10-01", last: "2026-10-02" },
    ]);
    // A person's own imports.run.commit.v1 cannot write an order (draft-only, MB001).
    const own = await db.withContext("munim_core", { tenant_id: T.IN.w.tenant, outlet_ids: "*", role: "owner", member_id: T.IN.w.owner, command_type: "imports.run.commit.v1" }, (c) =>
      c.query(`INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, kind, status, subtotal_minor, total_minor, currency, pricing_snapshot)
               VALUES ($1, $2, $3, $4, 'takeaway', 'completed', 100, 100, 'INR', '{}')`, [T.IN.w.tenant, uuidv7(), T.IN.w.outlets[0], T.IN.w.channel])).then(() => "ok", (e: { code?: string }) => e.code);
    expect(own).toBe("MB001");
  });

  it("a committed run cannot be committed again (its draft is already decided)", async () => {
    const r = RUNS.get("synthetic_bank_1.csv")!;
    const res = await approve("IN", "owner", r.draft, "imports.run.commit.v1");
    expect(res.status).toBe(409);
    expect(await bookRows(r.run)).toBe(r.key.rows_ok);
  });
});

describe("documents", () => {
  it("the blob store comes from Deps: an app composed without one refuses the upload (503 unavailable, no document); this app's store accepts it", async () => {
    const config = { nodeEnv: "test", redact: (s: string) => s };
    const bare = await createApp({ pools, idp, storefronts: async () => null, config, log: createLogger(config, () => {}) });
    const bytes = Buffer.from("Txn Date,Reference\n01-10-2026,SYN-BLOB\n");
    const req = (a: Hono<AppEnv>) => a.request("/v1/imports/documents", { method: "POST",
      headers: { Authorization: `Bearer ${idp.sign({ sub: T.IN.subs.owner })}`, [TENANT_HEADER]: T.IN.w.tenant, "Content-Type": "application/json" },
      body: JSON.stringify(uploadBody("bank_statement", "synthetic_blob.csv", bytes)) });
    const refused = await req(bare);
    expect([refused.status, ((await refused.json()) as { error: { code: string } }).error.code]).toEqual([503, "unavailable"]);
    expect(await count(`SELECT count(*) n FROM core.document WHERE tenant_id = $1 AND filename = 'synthetic_blob.csv'`, [T.IN.w.tenant])).toBe(0);
    expect((await req(app)).status).toBe(200);
    expect(await count(`SELECT count(*) n FROM core.document WHERE tenant_id = $1 AND filename = 'synthetic_blob.csv'`, [T.IN.w.tenant])).toBe(1);
  });

  it("re-uploading the same file returns the existing document and its run; still one document", async () => {
    const first = RUNS.get("synthetic_zomato_1.csv")!;
    const again = await upload("IN", "payout_statement", "synthetic_zomato_1.csv");
    expect(again.status).toBe(200);
    const u = ImportsUploadResponse.parse(await again.json());
    expect(u.duplicate).toBe(true);
    expect(u.run?.import_run_id).toBe(first.run);
    expect(u.document.document_id).toBe((await one<{ document_id: string }>(`SELECT document_id FROM core.import_run WHERE id = $1`, [first.run])).document_id);
    expect(await count(`SELECT count(*) n FROM core.document WHERE tenant_id = $1 AND sha256 = $2`, [T.IN.w.tenant, u.document.sha256])).toBe(1);
    expect(await count(`SELECT count(*) n FROM core.import_run WHERE document_id = $1`, [u.document.document_id])).toBe(1);
  });

  it("staff cannot upload (403); the owner can", async () => {
    const res = await call("IN", "staff", "POST", "/v1/imports/documents", uploadBody("bank_statement", "synthetic_staff.csv", Buffer.from("Txn Date,Reference\n")));
    expect(res.status).toBe(403);
  });

  it("an AU tenant is not offered an IN-only payout layout: no run, the header comes back for mapping", async () => {
    const res = await upload("AU", "payout_statement", "synthetic_swiggy_1.csv");
    const u = ImportsUploadResponse.parse(await res.json());
    expect(u.run).toBeNull();
    expect(u.header?.[0]).toBe("Payout Ref");
  });
});

describe("mapping drafts: column renames + units only (R28)", () => {
  // A layout no built-in reads (synthetic).
  const CUSTOM = Buffer.from([
    "Posted,Ref,Amt (Rs),Fee (Rs),Channel,A/c",
    "05-10-2026,SYN-CUS-01,150.00,0,UPI,SYN-ACC-09",
    "05-10-2026,SYN-CUS-02,-20.00,0,NEFT,SYN-ACC-09",
    "06-10-2026,SYN-CUS-03,abc,0,UPI,SYN-ACC-09",
  ].join("\n") + "\n");
  const good = [
    { source: "Posted", target: "txn_date", unit: "date_dmy" },
    { source: "Ref", target: "reference" },
    { source: "Amt (Rs)", target: "amount", unit: "rupees" },
    { source: "Channel", target: "mode" },
    { source: "A/c", target: "account" },
  ];
  let doc = "";
  const drafts = () => count(`SELECT count(*) n FROM core.draft WHERE tenant_id = $1 AND command_type = 'imports.format.approve.v1'`, [T.IN.w.tenant]);
  const formats = () => count(`SELECT count(*) n FROM core.import_format WHERE tenant_id = $1`, [T.IN.w.tenant]);
  const propose = (mapping: unknown) =>
    call("IN", "owner", "POST", "/v1/imports/formats:propose", { document_id: doc, kind: "bank_statement", name: "Synthetic custom bank", mapping });

  it("an unknown layout uploads with no run and its header", async () => {
    const res = await call("IN", "owner", "POST", "/v1/imports/documents", uploadBody("bank_statement", "synthetic_custom_bank.csv", CUSTOM));
    const u = ImportsUploadResponse.parse(await res.json());
    expect(u).toMatchObject({ duplicate: false, run: null, header: ["Posted", "Ref", "Amt (Rs)", "Fee (Rs)", "Channel", "A/c"] });
    doc = u.document.document_id;
  });

  it.each([
    ["an expression as the source column", [...good.slice(0, 2), { source: "Amt (Rs) - Fee (Rs)", target: "amount", unit: "rupees" }, ...good.slice(3)]],
    ["a formula key", [...good.slice(0, 2), { source: "Amt (Rs)", target: "amount", unit: "rupees", formula: "Amt (Rs) * 100" }, ...good.slice(3)]],
    ["an arithmetic unit", [...good.slice(0, 2), { source: "Amt (Rs)", target: "amount", unit: "rupees*100" }, ...good.slice(3)]],
    ["a unit on a text field", [good[0], { source: "Ref", target: "reference", unit: "rupees" }, ...good.slice(2)]],
    ["an unknown target", [...good, { source: "Fee (Rs)", target: "net_after_fee", unit: "rupees" }]],
    ["a required field left unmapped", good.slice(0, 4)],
  ])("refuses %s (422, no draft)", async (_label, mapping) => {
    const before = await drafts();
    const res = await propose(mapping);
    expect(res.status).toBe(422);
    expect(await drafts()).toBe(before);
  });

  it("refuses an arithmetic mapping proposed as a draft by intel (approve → 422, no format saved)", async () => {
    const header = ["Posted", "Ref", "Amt (Rs)", "Fee (Rs)", "Channel", "A/c"];
    const { headerSignature } = await import("../src/modules/imports/index.ts");
    const draft = uuidv7();
    await db.withContext("munim_svc", { tenant_id: T.IN.w.tenant, outlet_ids: "*" }, (c) =>
      c.query(`INSERT INTO core.draft (tenant_id, id, outlet_ids, source, command_type, command_payload) VALUES ($1, $2, '{}', 'intel:finance', 'imports.format.approve.v1', $3)`,
        [T.IN.w.tenant, draft, { format_id: uuidv7(), kind: "bank_statement", name: "Arithmetic", header, header_signature: headerSignature(header),
          mapping: [...good.slice(0, 2), { source: "Amt (Rs) - Fee (Rs)", target: "amount", unit: "rupees" }, ...good.slice(3)] }]));
    const before = await formats();
    const res = await approve("IN", "owner", draft, "imports.format.approve.v1");
    expect(res.status).toBe(422);
    expect(await formats()).toBe(before);
  });

  it("accepts renames + units: approved → saved under the decision; the layout then parses (2 ready, row 4 quarantined)", async () => {
    const res = await propose(good);
    expect(res.status).toBe(201);
    const { draft_id } = ImportsFormatProposeResponse.parse(await res.json());
    const before = await formats();
    expect((await approve("IN", "owner", draft_id, "imports.format.approve.v1")).status).toBe(200);
    expect(await formats()).toBe(before + 1);
    const f = await one<{ id: string; decided: string }>(
      `SELECT f.id, d.draft_id AS decided FROM core.import_format f JOIN core.decision d ON d.tenant_id = f.tenant_id AND d.id = f.decision_id
        WHERE f.tenant_id = $1 ORDER BY f.created_at DESC LIMIT 1`, [T.IN.w.tenant]);
    expect(f.decided).toBe(draft_id);

    const created = await call("IN", "owner", "POST", "/v1/imports/runs", { document_id: doc });
    expect(created.status).toBe(201);
    const run = ImportRunView.parse(await created.json());
    expect(run).toMatchObject({ format_id: f.id, parser: null, status: "parsing" });
    expect(ImportsRunsResponse.parse(await (await call("IN", "owner", "GET", "/v1/imports/runs")).json()).runs.map((r) => r.import_run_id)).toContain(run.import_run_id);
    expect(await parse("IN")).toMatchObject({ previewed: 1, failed: 0 });
    const rows = ImportRunRowsResponse.parse(await (await call("IN", "owner", "GET", `/v1/imports/runs/${run.import_run_id}/rows`)).json());
    expect(rows.staged.map((s) => [s.row_no, s.amount_minor])).toEqual([[2, 15000], [3, -2000]]);
    expect(rows.quarantined.map((q) => [q.row_no, q.reason_code])).toEqual([[4, "amount_unreadable"]]);
  });
});
