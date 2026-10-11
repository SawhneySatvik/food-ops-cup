// Parsing one import run (core-worker job, munim_svc under the run's tenant — no book grants). In ONE
// transaction: read the document's bytes, check the header against the run's format, stage each readable row or
// quarantine it with a reason, read the file's printed total, create the run's draft (imports.run.commit.v1) and
// move the run parsing → previewed with its figures — fixed from then on (0014), so the preview a person
// approves is the one they saw. A file that cannot be read as its format moves the run to `failed`.
import { PACKS } from "@munim/contracts/packs";
import type { ImportKind } from "@munim/contracts/imports";
import { uuidv7 } from "../../commit/index.ts";
import type { Queryable } from "../../runtoken/index.ts";
import type { BlobStore } from "./blob.ts";
import { CsvError, readCsv } from "./csv.ts";
import { builtInByParser, CONTROL_FIELD, headerSignature, type MappingEntry } from "./formats.ts";
import { checkCounts } from "./counts.ts";
import { checkBills, checkWaste, loadHistoryCtx } from "./history.ts";
import { checkShifts } from "./shifts.ts";
import { columnIndex, outletOf, readFields, readMoney, RowChecker, type RowContext, type RowOutcome, type Staged } from "./rows.ts";

export type ParseOutcome = "previewed" | "failed" | "skipped";

interface RunRow {
  tenant_id: string;
  id: string;
  kind: ImportKind;
  parser: string | null;
  storage_ref: string;
  base_currency: string;
  country_code: "IN" | "AU";
  header_signature: string | null;
  mapping: MappingEntry[] | null;
}

const TOTAL = "TOTAL";

/** Parses the run if it is still `parsing` and not locked by another worker; otherwise "skipped". */
export async function parseRun(c: Queryable, blobs: BlobStore, runId: string): Promise<ParseOutcome> {
  const run = (await c.query<RunRow>(
    `SELECT r.tenant_id, r.id, r.kind, r.parser, d.storage_ref, t.base_currency, t.country_code, f.header_signature, f.mapping
       FROM core.import_run r
       JOIN core.document d ON d.tenant_id = r.tenant_id AND d.id = r.document_id
       JOIN core.tenant t ON t.tenant_id = r.tenant_id
       LEFT JOIN core.import_format f ON f.tenant_id = r.tenant_id AND f.id = r.format_id
      WHERE r.id = $1 AND r.status = 'parsing'
      FOR UPDATE OF r SKIP LOCKED`, [runId])).rows[0];
  if (!run) return "skipped";
  const fail = async (): Promise<ParseOutcome> => {
    await c.query(`UPDATE core.import_run SET status = 'failed' WHERE id = $1`, [run.id]);
    return "failed";
  };

  const builtIn = run.parser ? builtInByParser(run.parser) : undefined;
  const spec = builtIn
    ? { mapping: builtIn.mapping, sig: headerSignature(builtIn.header), labels: builtIn.labels, fixed: builtIn.fixed }
    : run.mapping && run.header_signature ? { mapping: run.mapping, sig: run.header_signature, labels: {}, fixed: {} } : undefined;
  if (!spec) return fail();

  let records;
  try {
    records = readCsv(new TextDecoder("utf-8", { fatal: true }).decode(await blobs.get(run.storage_ref)));
  } catch (e) {
    if (e instanceof CsvError || e instanceof TypeError) return fail();
    throw e;
  }
  const [header, ...body] = records;
  if (!header || headerSignature(header.cells) !== spec.sig) return fail();
  const cols = columnIndex(header.cells, spec.mapping);
  if (!cols) return fail();

  // The file's printed total: one TOTAL row, last, in the kind's control column and that column's unit.
  const trailers = body.filter((r) => r.cells[0]?.trim().toUpperCase() === TOTAL);
  if (trailers.length > 1 || (trailers.length === 1 && body.at(-1) !== trailers[0])) return fail();
  const rows = trailers.length ? body.slice(0, -1) : body;
  if (rows.length === 0) return fail();
  const minorDigits = PACKS[run.country_code].currency.minor_unit;
  let control: number | null = null;
  if (trailers.length) {
    const field = CONTROL_FIELD[run.kind];
    const entry = spec.mapping.find((e) => e.target === field);
    if (!field || !entry) return fail();
    const v = readMoney(trailers[0]!.cells[cols.get(field)!] ?? "", entry.unit!, minorDigits);
    if (typeof v !== "number") return fail();
    control = v;
  }

  const ctx: RowContext = {
    kind: run.kind, currency: run.base_currency, minorDigits, labels: spec.labels, fixed: spec.fixed,
    outlets: new Map(), channels: new Map(), existing: new Set(),
  };
  for (const o of (await c.query<{ id: string; name: string }>(`SELECT id, name FROM core.outlet`)).rows) {
    const k = o.name.trim().toLowerCase();
    ctx.outlets.set(k, [...(ctx.outlets.get(k) ?? []), o.id]);
  }
  for (const ch of (await c.query<{ id: string; code: string }>(
    `SELECT id, substr(kind, 12) AS code FROM core.channel WHERE kind LIKE 'aggregator:%' AND active ORDER BY created_at, id`)).rows) {
    if (!ctx.channels.has(ch.code)) ctx.channels.set(ch.code, ch.id);
  }

  const read = rows.map((r) => ({ r, f: r.cells.length === header.cells.length
    ? readFields(r.cells, cols, spec.mapping, ctx) : { ok: false as const, reason: "column_count" } }));
  const refs = read.flatMap(({ f }) => (f.ok ? [String(f.v.payout_ref ?? f.v.reference ?? "")] : [])).filter((x) => x !== "");
  if (run.kind === "payout_statement" && refs.length) {
    for (const s of (await c.query<{ channel_id: string; external_ref: string }>(
      `SELECT channel_id, external_ref FROM core.settlement WHERE external_ref = ANY($1::text[])`, [refs])).rows) {
      ctx.existing.add(`payout:${s.channel_id}:${s.external_ref}`);
    }
  }
  if (run.kind === "bank_statement" && refs.length) {
    for (const b of (await c.query<{ account_ref: string; external_ref: string }>(
      `SELECT account_ref, external_ref FROM core.bank_line WHERE external_ref = ANY($1::text[])`, [refs])).rows) {
      ctx.existing.add(`bank:${b.account_ref}:${b.external_ref}`);
    }
  }

  // Dated rows (POS exports and history): outlet business dates, closed periods, channels and bills already imported.
  if (run.kind === "pos_export" || run.kind === "pos_bills" || run.kind === "waste_log" || run.kind === "shift_log" || run.kind === "stock_count") {
    ctx.history = await loadHistoryCtx(c, [...new Set(read.flatMap(({ f }) => (f.ok && f.v.bill_no != null ? [String(f.v.bill_no).trim()] : [])))]);
  }
  const outletId = (name: unknown) => outletOf(ctx, (name ?? null) as string | null)?.id ?? undefined;
  const checker = new RowChecker(ctx);
  let outcomes: RowOutcome[];
  if (run.kind === "pos_bills") {
    // A bill is judged whole (lines, tenders and refund together); a row that cannot even be read rejects its bill.
    const unreadableBills = new Set(read.flatMap(({ r, f }) => (f.ok ? [] : [(r.cells[cols.get("bill_no")!] ?? "").trim()])));
    const readable = read.flatMap(({ r, f }) => (f.ok && !unreadableBills.has(String(f.v.bill_no).trim()) ? [{ line: r.line, v: f.v }] : []));
    const judged = new Map(checkBills(readable, outletId, ctx.history!).map((o, i) => [readable[i]!.line, o] as const));
    outcomes = read.map(({ r, f }) => (!f.ok ? f : judged.get(r.line) ?? { ok: false, reason: "bill_rejected" }));
  } else if (run.kind === "shift_log") {
    const readable = read.flatMap(({ r, f }) => (f.ok ? [{ line: r.line, v: f.v }] : []));
    const judged = new Map((await checkShifts(c, readable, outletId, ctx.history!)).map((o, i) => [readable[i]!.line, o] as const));
    outcomes = read.map(({ r, f }) => (!f.ok ? f : judged.get(r.line)!));
  } else if (run.kind === "stock_count") {
    // A count is judged whole; a row that cannot even be read rejects its count.
    const unreadable = new Set(read.flatMap(({ r, f }) => (f.ok ? [] : [(r.cells[cols.get("count_no")!] ?? "").trim()])));
    const readable = read.flatMap(({ r, f }) => (f.ok && !unreadable.has(String(f.v.count_no).trim()) ? [{ line: r.line, v: f.v }] : []));
    const judged = new Map((await checkCounts(c, readable, outletId, ctx.history!)).map((o, i) => [readable[i]!.line, o] as const));
    outcomes = read.map(({ r, f }) => (!f.ok ? f : judged.get(r.line) ?? { ok: false, reason: "count_rejected" }));
  } else {
    outcomes = read.map(({ f }) => (!f.ok ? f : run.kind === "waste_log" ? checkWaste(f.v, outletId, ctx.history!) : checker.build(f.v)));
  }
  const staged: Array<Staged & { row_no: number }> = [];
  const quarantined: Array<{ row_no: number; raw: string; reason_code: string }> = [];
  for (const [i, { r }] of read.entries()) {
    const out = outcomes[i]!;
    if (out.ok) staged.push({ row_no: r.line, ...out.row });
    else quarantined.push({ row_no: r.line, raw: r.raw, reason_code: out.reason });
  }

  await c.query(
    `INSERT INTO core.import_staging (tenant_id, id, import_run_id, row_no, target_table, data, amount_minor, external_ref)
     SELECT $1, x.id, $2, x.row_no, x.target_table, x.data, x.amount_minor, x.external_ref
       FROM jsonb_to_recordset($3::jsonb) AS x (id uuid, row_no int, target_table text, data jsonb, amount_minor bigint, external_ref text)`,
    [run.tenant_id, run.id, JSON.stringify(staged.map((s) => ({ id: uuidv7(), ...s })))]);
  await c.query(
    `INSERT INTO core.import_quarantine (tenant_id, id, import_run_id, row_no, raw, reason_code)
     SELECT $1, x.id, $2, x.row_no, x.raw, x.reason_code
       FROM jsonb_to_recordset($3::jsonb) AS x (id uuid, row_no int, raw text, reason_code text)`,
    [run.tenant_id, run.id, JSON.stringify(quarantined.map((q) => ({ id: uuidv7(), ...q })))]);

  // Tenant-wide draft (no outlet): approving it needs the all-outlet scope. It carries no numbers — the
  // figures are the run row's own, frozen by this same statement's move to previewed.
  const draftId = uuidv7();
  await c.query(
    `INSERT INTO core.draft (tenant_id, id, outlet_ids, source, command_type, command_payload)
     VALUES ($1, $2, '{}', 'import', 'imports.run.commit.v1', $3)`, [run.tenant_id, draftId, { import_run_id: run.id }]);
  await c.query(
    `UPDATE core.import_run SET status = 'previewed', rows_ok = $2, rows_quarantined = $3, control_total_minor = $4, currency = $5, draft_id = $6
      WHERE id = $1`,
    [run.id, staged.length, quarantined.length, control, control === null ? null : run.base_currency, draftId]);
  return "previewed";
}
