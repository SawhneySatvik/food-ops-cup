// Imports module (T-030; R5, R28; flows/import.md; screens/onboarding-import.md B). Mounted by modules/index.ts.
//   POST /v1/imports/documents          upload (sha256 unique per tenant: the same file returns the existing document)
//   POST /v1/imports/runs               start a run for a stored document whose format is now known
//   GET  /v1/imports/runs?kind=&status=&limit=&cursor=   runs, newest first
//   GET  /v1/imports/runs/{id}          one run: status and the run row's own figures
//   GET  /v1/imports/runs/{id}/rows     staged rows + quarantined rows with reasons
//   POST /v1/imports/formats:propose    a member's own column mapping (renames + units) → mapping draft
// Parsing is a core-worker job (`parsePendingImports`, services/core-worker/src/imports) calling `parseRun`.
// Approving imports.run.commit.v1 / imports.format.approve.v1 goes through the approvals routes; their handlers
// are registered here. Uploads and runs are operational rows (R29): nothing here writes the books.
import { createHash } from "node:crypto";
import { ImportsFormatApproveV1, ImportsFormatProposeRequest, ImportsRunCreateRequest, ImportsUploadRequest, ImportKind, ImportRunStatus } from "@munim/contracts/imports";
import { Hono, type Context } from "hono";
import { contextOf, requireMember, type Principal } from "../../auth/resolve.ts";
import { uuidv7 } from "../../commit/index.ts";
import { withContext } from "../../lib/db.ts";
import { ApiError } from "../../lib/errors.ts";
import type { AppEnv } from "../../lib/types.ts";
import type { Queryable } from "../../runtoken/index.ts";
import { registerDraftHandler } from "../approvals/index.ts";
import { blobKey, type BlobStore, DEFAULT_BLOB_DIR, localBlobStore } from "./blob.ts";
import { formatApproveHandler, runCommitHandler } from "./commit.ts";
import { readCsv } from "./csv.ts";
import { BUILT_INS, checkMapping, headerSignature } from "./formats.ts";
import { readRoutes } from "./routes.ts";

export { blobKey, localBlobStore, type BlobStore } from "./blob.ts";
export { parseRun, type ParseOutcome } from "./parse.ts";
export { BUILT_INS, checkMapping, headerSignature } from "./formats.ts";
export { commitRun, formatApproveHandler, runCommitHandler } from "./commit.ts";

// One registration per process even if this file is evaluated twice (vitest by path, loadRouters by URL).
const REGISTERED = Symbol.for("munim.imports.draftHandlers");
const g = globalThis as unknown as Record<symbol, boolean | undefined>;
if (!g[REGISTERED]) {
  registerDraftHandler(runCommitHandler);
  registerDraftHandler(formatApproveHandler);
  g[REGISTERED] = true;
}

/** A local store under the repository's `.run/blobs` — the default a composition root hands Deps and the worker
 *  when it is given no other store. The routes read the store only from Deps. */
export const blobs = (): BlobStore => localBlobStore(DEFAULT_BLOB_DIR);

function blobStore(c: Context<AppEnv>): BlobStore {
  const b = c.var.deps.blobs;
  if (!b) throw new ApiError("unavailable");
  return b;
}

type Member = Extract<Principal, { kind: "member" }>;
const MAX_BYTES = 5 * 1024 * 1024;
/** Who may bring files in: the roles that may approve an import run (command_authority imports.run.commit.v1). */
const IMPORTERS = new Set(["owner", "manager", "judge"]);
const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

function member(c: Context<AppEnv>, write = false): Member {
  const p = c.var.principal;
  if (p.kind !== "member" || p.role === "staff" || (write && !IMPORTERS.has(p.role))) throw new ApiError("forbidden", "authority_denied");
  return p;
}

async function body<T>(c: Context<AppEnv>, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError("bad_request");
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new ApiError("invalid_payload");
  return r.data;
}

const iso = (d: Date) => d.toISOString();
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

interface DocRow {
  id: string;
  kind: string;
  media_type: string;
  filename: string | null;
  byte_size: string;
  sha256: string;
  storage_ref: string;
  uploaded_by: string | null;
  created_at: Date;
}
const DOC = `SELECT id, kind, media_type, filename, byte_size, sha256, storage_ref, uploaded_by, created_at FROM core.document`;
const docView = (d: DocRow) => ({
  document_id: d.id, kind: d.kind, media_type: d.media_type, filename: d.filename, byte_size: Number(d.byte_size), sha256: d.sha256,
  uploaded_by: d.uploaded_by, created_at: iso(d.created_at),
});

interface RunRow {
  id: string;
  document_id: string;
  kind: ImportKind;
  parser: string | null;
  format_id: string | null;
  status: "parsing" | "previewed" | "committed" | "rejected" | "failed";
  rows_ok: number;
  rows_quarantined: number;
  control_total_minor: string | null;
  currency: string | null;
  total_matches: boolean | null;
  draft_id: string | null;
  decision_id: string | null;
  created_at: Date;
  updated_at: Date;
}
// total_matches compares the file's printed total with its staged rows inside this read (shown as a tick or a
// cross, never as a figure; the staged total itself is the imports.run_preview snapshot — pending M-C).
const RUN = `
  SELECT r.id, r.document_id, r.kind, r.parser, r.format_id, r.status, r.rows_ok, r.rows_quarantined, r.control_total_minor, r.currency,
         CASE WHEN r.status = 'parsing' OR r.control_total_minor IS NULL THEN NULL
              ELSE r.control_total_minor = (SELECT coalesce(sum(s.amount_minor), 0) FROM core.import_staging s
                                             WHERE s.tenant_id = r.tenant_id AND s.import_run_id = r.id) END AS total_matches,
         r.draft_id, r.decision_id, r.created_at, r.updated_at
    FROM core.import_run r`;
const runView = (r: RunRow) => ({
  import_run_id: r.id, document_id: r.document_id, kind: r.kind, parser: r.parser, format_id: r.format_id, status: r.status,
  rows_ok: r.rows_ok, rows_quarantined: r.rows_quarantined,
  control_total_minor: r.control_total_minor === null ? null : Number(r.control_total_minor), currency: r.currency,
  total_matches: r.total_matches, draft_id: r.draft_id, decision_id: r.decision_id, created_at: iso(r.created_at), updated_at: iso(r.updated_at),
});

/** The file's header cells, or null when it is not readable as UTF-8 CSV. */
function headerOf(bytes: Uint8Array): string[] | null {
  try {
    return readCsv(new TextDecoder("utf-8", { fatal: true }).decode(bytes))[0]?.cells ?? null;
  } catch {
    return null;
  }
}

/** Format detection by header signature (flows/import.md step 2): a built-in parser of this kind that the
 *  tenant's country pack offers, else the tenant's own active approved format. */
async function detect(db: Queryable, kind: ImportKind, header: string[] | null): Promise<{ parser: string } | { format_id: string } | null> {
  if (!header) return null;
  const sig = headerSignature(header);
  const country = (await db.query<{ c: string }>(`SELECT country_code AS c FROM core.tenant`)).rows[0]?.c;
  const b = BUILT_INS.find((x) => x.kind === kind && headerSignature(x.header) === sig && (x.countries === null || x.countries.includes(country ?? "")));
  if (b) return { parser: b.parser };
  const f = (await db.query<{ id: string }>(
    `SELECT id FROM core.import_format WHERE kind = $1 AND header_signature = $2 AND status = 'active'`, [kind, sig])).rows[0];
  return f ? { format_id: f.id } : null;
}

async function startRun(db: Queryable, m: Member, doc: { id: string; kind: ImportKind }, how: { parser: string } | { format_id: string }) {
  const r = await db.query<RunRow>(
    `WITH r AS (INSERT INTO core.import_run (tenant_id, id, document_id, kind, parser, format_id, created_by)
                VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *)
     ${RUN.replace("FROM core.import_run r", "FROM r")}`,
    [m.tenant_id, uuidv7(), doc.id, doc.kind, "parser" in how ? how.parser : null, "format_id" in how ? how.format_id : null, m.member_id]);
  return r.rows[0]!;
}

async function upload(c: Context<AppEnv>) {
  const m = member(c, true);
  const req = await body(c, ImportsUploadRequest);
  const bytes = Buffer.from(req.content_base64, "base64");
  if (bytes.length === 0 || bytes.length > MAX_BYTES || bytes.toString("base64") !== req.content_base64.replace(/\s/g, "")) {
    throw new ApiError("invalid_payload");
  }
  const sha = sha256(bytes);
  const key = blobKey(m.tenant_id, sha);
  // Content-addressed, so storing before the row exists is harmless if the transaction then fails.
  await blobStore(c).put(key, bytes);
  const header = headerOf(bytes);
  return withContext(c.var.deps.pools.core, contextOf(m), async (db) => {
    const inserted = (await db.query<DocRow>(
      `INSERT INTO core.document (tenant_id, id, kind, media_type, filename, byte_size, sha256, storage_ref, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT ON CONSTRAINT document_sha256_unique DO NOTHING
       RETURNING id, kind, media_type, filename, byte_size, sha256, storage_ref, uploaded_by, created_at`,
      [m.tenant_id, uuidv7(), req.kind, req.media_type, req.filename, bytes.length, sha, key, m.member_id])).rows[0];
    if (!inserted) {
      // The same bytes again: the existing document and its latest run (screen I1: "already uploaded on {date}").
      const doc = (await db.query<DocRow>(`${DOC} WHERE sha256 = $1`, [sha])).rows[0]!;
      const run = (await db.query<RunRow>(`${RUN} WHERE r.document_id = $1 ORDER BY r.created_at DESC, r.id DESC LIMIT 1`, [doc.id])).rows[0];
      return c.json({ duplicate: true, document: docView(doc), run: run ? runView(run) : null, header: null }, 200);
    }
    const how = await detect(db, req.kind, header);
    const run = how ? await startRun(db, m, { id: inserted.id, kind: req.kind }, how) : null;
    return c.json({ duplicate: false, document: docView(inserted), run: run ? runView(run) : null, header: run ? null : header ?? [] }, 200);
  });
}

async function createRun(c: Context<AppEnv>) {
  const m = member(c, true);
  const { document_id } = await body(c, ImportsRunCreateRequest);
  return withContext(c.var.deps.pools.core, contextOf(m), async (db) => {
    const doc = (await db.query<DocRow>(`${DOC} WHERE id = $1`, [document_id])).rows[0];
    if (!doc) throw new ApiError("not_found");
    const kind = doc.kind as ImportKind;
    const how = await detect(db, kind, headerOf(await blobStore(c).get(doc.storage_ref)));
    if (!how) throw new ApiError("invalid_payload");
    return c.json(runView(await startRun(db, m, { id: doc.id, kind }, how)), 201);
  });
}

async function proposeFormat(c: Context<AppEnv>) {
  const m = member(c, true);
  const req = await body(c, ImportsFormatProposeRequest);
  return withContext(c.var.deps.pools.core, contextOf(m), async (db) => {
    const doc = (await db.query<DocRow>(`${DOC} WHERE id = $1`, [req.document_id])).rows[0];
    if (!doc) throw new ApiError("not_found");
    // The header comes from the stored file, never from the request: a mapping names real columns only.
    const header = headerOf(await blobStore(c).get(doc.storage_ref));
    if (!header?.length) throw new ApiError("invalid_payload");
    const payload = ImportsFormatApproveV1.safeParse({
      format_id: uuidv7(), kind: req.kind, name: req.name, header, header_signature: headerSignature(header), mapping: req.mapping,
    });
    if (!payload.success || checkMapping(req.kind, header, req.mapping) || (await detect(db, req.kind, header))) throw new ApiError("invalid_payload");
    const draftId = uuidv7();
    // Tenant-wide (no outlet) like the format it saves; RLS admits it only under the all-outlet scope.
    await db.query(
      `INSERT INTO core.draft (tenant_id, id, outlet_ids, source, command_type, command_payload, created_by)
       VALUES ($1, $2, '{}', 'member', 'imports.format.approve.v1', $3, $4)`, [m.tenant_id, draftId, payload.data, m.member_id]);
    return c.json({ draft_id: draftId }, 201);
  });
}

export const router = new Hono<AppEnv>()
  .post("/v1/imports/documents", requireMember, upload)
  .post("/v1/imports/runs", requireMember, createRun)
  .get("/v1/imports/runs", requireMember, async (c) => {
    const m = member(c);
    // T-092a: limit (default 100, as before), keyset cursor (the last run's id), kind and status filters.
    const q = c.req.query();
    const limit = q.limit === undefined ? 100 : Number(q.limit);
    const kind = q.kind === undefined ? null : ImportKind.safeParse(q.kind);
    const status = q.status === undefined ? null : ImportRunStatus.safeParse(q.status);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (kind && !kind.success) || (status && !status.success)
      || (q.cursor !== undefined && !new RegExp(`^${ID}$`).test(q.cursor))) throw new ApiError("bad_request");
    const rows = await withContext(c.var.deps.pools.core, contextOf(m), async (db) =>
      (await db.query<RunRow>(
        `${RUN} WHERE ($1::text IS NULL OR r.kind = $1) AND ($2::text IS NULL OR r.status = $2)
            AND ($3::uuid IS NULL OR (r.created_at, r.id) < (SELECT x.created_at, x.id FROM core.import_run x WHERE x.id = $3))
          ORDER BY r.created_at DESC, r.id DESC LIMIT $4`,
        [kind?.data ?? null, status?.data ?? null, q.cursor ?? null, limit + 1])).rows);
    return c.json({ runs: rows.slice(0, limit).map(runView), next_cursor: rows.length > limit ? rows[limit - 1]!.id : null }, 200);
  })
  .get(`/v1/imports/runs/:id{${ID}}`, requireMember, async (c) => {
    const m = member(c);
    const r = await withContext(c.var.deps.pools.core, contextOf(m), async (db) =>
      (await db.query<RunRow>(`${RUN} WHERE r.id = $1`, [c.req.param("id")])).rows[0]);
    if (!r) throw new ApiError("not_found");
    return c.json(runView(r), 200);
  })
  .get(`/v1/imports/runs/:id{${ID}}/rows`, requireMember, async (c) => {
    const m = member(c);
    const out = await withContext(c.var.deps.pools.core, contextOf(m), async (db) => {
      const id = c.req.param("id");
      if (!(await db.query(`SELECT 1 FROM core.import_run WHERE id = $1`, [id])).rows[0]) throw new ApiError("not_found");
      const staged = (await db.query<{ row_no: number; target_table: string; data: Record<string, unknown>; amount_minor: string | null; external_ref: string | null }>(
        `SELECT row_no, target_table, data, amount_minor, external_ref FROM core.import_staging WHERE import_run_id = $1 ORDER BY row_no`, [id])).rows;
      const quarantined = (await db.query<{ row_no: number; raw: string; reason_code: string }>(
        `SELECT row_no, raw, reason_code FROM core.import_quarantine WHERE import_run_id = $1 ORDER BY row_no`, [id])).rows;
      return { staged: staged.map((s) => ({ ...s, amount_minor: s.amount_minor === null ? null : Number(s.amount_minor) })), quarantined };
    });
    return c.json(out, 200);
  })
  .post("/v1/imports/:action{formats:propose}", requireMember, proposeFormat)
  .route("/", readRoutes);
