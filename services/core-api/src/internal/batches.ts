// The batch writes of /internal/intel/v1 (T-040b; ADR-014 §7.1 semantic memory, §14 C2; R25). Each runs on the run's
// munim_svc transaction (tenant + outlet scope from the token) and writes only operational intel.* rows — munim_svc
// holds no book grant (R26–R29). `run_id` is always the token's, never the body's.
// Idempotent by row id: `INSERT … ON CONFLICT (tenant_id, id) DO NOTHING`, then the request's rows are compared with the
// stored ones — a retry inserts 0 and answers `existing`; the same id with another body is 409. One transaction per
// batch: a refused row (a quote that is not its source, an id or outlet the run cannot see, a dangling id) refuses all.
import {
  AliasesBatchRequest, ChunksBatchRequest, ClaimsBatchRequest, EdgesBatchRequest, EmbeddingsBatchRequest, EntitiesBatchRequest,
  ForecastsBatchRequest, QuotesBatchRequest, SpendRequest, WikiBatchRequest,
} from "@munim/contracts/internal";
import type { ReasonCode } from "@munim/contracts";
import { validateSegments } from "@munim/core-domain/envelope";
import { canonicalJson } from "../commit/index.ts";
import { ApiError, type ErrorCode } from "../lib/errors.ts";
import type { Queryable } from "../runtoken/index.ts";
import type { InternalConfig, Run } from "./auth.ts";
import { dbResolver } from "./resolver.ts";

function parse<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, raw: unknown): T {
  const r = schema.safeParse(raw);
  if (!r.success) throw new ApiError("invalid_payload");
  return r.data;
}

// Postgres refusals a batch can meet, as typed errors (MB012 and the other MB codes map in app.ts). The driver text is
// never returned.
const PG_REFUSALS: Record<string, ErrorCode> = {
  "23503": "invalid_payload", // a dangling id (entity, chunk, outlet, supplier not simulated …)
  "23514": "invalid_payload", // a CHECK (lo ≤ qty ≤ hi, valid_to > valid_from …)
  "22P02": "invalid_payload",
  "23505": "conflict", // another unique key (an entity's core_ref, a wiki slug, a forecast series) under another id
  "42501": "forbidden", // RLS WITH CHECK: an outlet outside the run's scope
};
export const refusing = <A extends unknown[], T>(fn: (...a: A) => Promise<T>) => async (...a: A): Promise<T> => {
  try {
    return await fn(...a);
  } catch (e) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && PG_REFUSALS[code]) throw new ApiError(PG_REFUSALS[code]);
    throw e;
  }
};

type Col = readonly [name: string, type: string];
type Stamp = ReadonlyArray<readonly [name: string, value: unknown]>;

/** Insert `rows` (keys = `cols`) into `table` with the stamped columns (run_id, at) added; compare on `cols` only. */
async function insertRows(c: Queryable, run: Run, table: string, cols: readonly Col[], rows: readonly object[], stamp: Stamp = []) {
  if (rows.length === 0) return { inserted: 0, existing: 0 };
  const def = cols.map(([n, t]) => `${n} ${t}`).join(", ");
  const names = cols.map(([n]) => n);
  const json = JSON.stringify(rows);
  const ins = await c.query<{ n: number }>(
    `WITH ins AS (
       INSERT INTO ${table} (tenant_id, ${[...stamp.map(([n]) => n), ...names].join(", ")})
       SELECT $1, ${[...stamp.map((_, i) => `$${i + 3}`), ...names.map((n) => `r.${n}`)].join(", ")}
         FROM jsonb_to_recordset($2::jsonb) AS r(${def})
       ON CONFLICT (tenant_id, id) DO NOTHING RETURNING 1)
     SELECT count(*)::int AS n FROM ins`,
    [run.tenantId, json, ...stamp.map(([, v]) => v)]);
  const differ = await c.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM jsonb_to_recordset($1::jsonb) AS r(${def}) JOIN ${table} t ON t.id = r.id
      WHERE (${names.map((n) => `t.${n}`).join(", ")}, NULL) IS DISTINCT FROM (${names.map((n) => `r.${n}`).join(", ")}, NULL)`, [json]);
  if (differ.rows[0]!.n > 0) throw new ApiError("idempotency_conflict");
  const inserted = ins.rows[0]!.n;
  return { inserted, existing: rows.length - inserted };
}

const RUN = (run: Run): Stamp => [["run_id", run.runId]];

export async function writeEntities(c: Queryable, run: Run, raw: unknown) {
  const { entities } = parse(EntitiesBatchRequest, raw);
  return insertRows(c, run, "intel.entity", [["id", "uuid"], ["kind", "text"], ["core_ref", "text"], ["name", "text"]], entities);
}

/** One normalisation rule, core's: NFKC, trimmed, inner whitespace collapsed, lower case. */
export const normalizeAlias = (s: string) => s.normalize("NFKC").trim().replace(/\s+/gu, " ").toLowerCase();

export async function writeAliases(c: Queryable, run: Run, raw: unknown) {
  const { aliases } = parse(AliasesBatchRequest, raw);
  return insertRows(c, run, "intel.alias", [["id", "uuid"], ["entity_id", "uuid"], ["alias", "text"], ["normalized", "text"], ["source", "text"]],
    aliases.map((a) => ({ ...a, normalized: normalizeAlias(a.alias) })));
}

export async function writeChunks(c: Queryable, run: Run, raw: unknown) {
  const { chunks } = parse(ChunksBatchRequest, raw);
  return insertRows(c, run, "intel.chunk",
    [["id", "uuid"], ["document_id", "uuid"], ["message_id", "uuid"], ["seq", "int"], ["char_start", "int"], ["text", "text"]], chunks, RUN(run));
}

/** The quote of every claim is checked against its source by the database (intel.claim_quote_matches, MB012 → 422
 *  `claim_quote_mismatch`), which refuses the whole batch. */
export async function writeClaims(c: Queryable, run: Run, raw: unknown) {
  const { claims } = parse(ClaimsBatchRequest, raw);
  return insertRows(c, run, "intel.claim",
    [["id", "uuid"], ["chunk_id", "uuid"], ["message_id", "uuid"], ["span_start", "int"], ["span_end", "int"], ["quote", "text"],
     ["subject_entity_id", "uuid"], ["predicate", "text"], ["object", "text"], ["object_entity_id", "uuid"]], claims, RUN(run));
}

export async function writeEdges(c: Queryable, run: Run, raw: unknown) {
  const { edges } = parse(EdgesBatchRequest, raw);
  return insertRows(c, run, "intel.edge",
    [["id", "uuid"], ["kind", "text"], ["src_entity_id", "uuid"], ["dst_entity_id", "uuid"], ["claim_id", "uuid"], ["source_ref", "text"],
     ["valid_from", "date"], ["valid_to", "date"]], edges);
}

/** 0013's pgvector column. Absent where 0013 was skipped (embedded Postgres in every gate) → 503: the success path
 *  runs only on a server with pgvector (UNVERIFIED in the gates). */
export async function writeEmbeddings(c: Queryable, _run: Run, raw: unknown) {
  const { embeddings } = parse(EmbeddingsBatchRequest, raw);
  const has = await c.query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'intel.chunk'::regclass AND attname = 'embedding' AND NOT attisdropped) AS ok`);
  if (!has.rows[0]!.ok) throw new ApiError("unavailable");
  const json = JSON.stringify(embeddings.map((e) => ({ chunk_id: e.chunk_id, embedding: `[${e.embedding_micro.map((x) => x / 1e6).join(",")}]` })));
  const ids = [...new Set(embeddings.map((e) => e.chunk_id))];
  const found = await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM intel.chunk WHERE id = ANY ($1::uuid[])`, [ids]);
  if (found.rows[0]!.n !== ids.length) throw new ApiError("invalid_payload");
  const differ = await c.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM jsonb_to_recordset($1::jsonb) AS r(chunk_id uuid, embedding text) JOIN intel.chunk k ON k.id = r.chunk_id
      WHERE k.embedding IS NOT NULL AND k.embedding <> r.embedding::vector`, [json]);
  if (differ.rows[0]!.n > 0) throw new ApiError("idempotency_conflict");
  const up = await c.query(
    `UPDATE intel.chunk k SET embedding = r.embedding::vector FROM jsonb_to_recordset($1::jsonb) AS r(chunk_id uuid, embedding text)
      WHERE k.id = r.chunk_id AND k.embedding IS NULL`, [json]);
  return { inserted: up.rowCount ?? 0, existing: embeddings.length - (up.rowCount ?? 0) };
}

/** A page version is stored only when its body passes core's validator (grammar; every ref resolves for this run), as
 *  0012 requires ("validated by core-api"); else the page is `abstained` with the reason and nothing of it is written.
 *  The version must be the page's next; the page's title follows its newest version. */
export async function writeWiki(c: Queryable, run: Run, raw: unknown) {
  const { pages } = parse(WikiBatchRequest, raw);
  const resolver = dbResolver(c, run.scope);
  const out: Array<{ page_id: string; version: number; status: "stored" | "existing" | "abstained"; reason_code: ReasonCode | null }> = [];
  for (const p of pages) {
    const at = { page_id: p.page_id, version: p.version };
    const v = await validateSegments(p.body, resolver);
    if (!v.ok) {
      out.push({ ...at, status: "abstained", reason_code: v.reason_code });
      continue;
    }
    await insertRows(c, run, "intel.wiki_page", [["id", "uuid"], ["entity_id", "uuid"], ["kind", "text"], ["slug", "text"]],
      [{ id: p.page_id, entity_id: p.entity_id, kind: p.kind, slug: p.slug }], [["title", p.title]]);
    const cur = await c.query<{ current_version: number | null }>(`SELECT current_version FROM intel.wiki_page WHERE id = $1 FOR UPDATE`, [p.page_id]);
    const prior = await c.query<{ page_id: string; version: number; body: unknown }>(`SELECT page_id, version, body FROM intel.wiki_version WHERE id = $1`, [p.version_id]);
    if (prior.rows[0]) {
      const r = prior.rows[0];
      if (r.page_id !== p.page_id || r.version !== p.version || canonicalJson(r.body) !== canonicalJson(p.body)) throw new ApiError("idempotency_conflict");
      out.push({ ...at, status: "existing", reason_code: null });
      continue;
    }
    if (p.version !== (cur.rows[0]!.current_version ?? 0) + 1) throw new ApiError("conflict");
    await c.query(`INSERT INTO intel.wiki_version (tenant_id, id, page_id, version, body, run_id) VALUES ($1, $2, $3, $4, $5, $6)`,
      [run.tenantId, p.version_id, p.page_id, p.version, JSON.stringify(p.body), run.runId]);
    await c.query(`UPDATE intel.wiki_page SET current_version = $2, title = $3, dirty = false WHERE id = $1`, [p.page_id, p.version, p.title]);
    out.push({ ...at, status: "stored", reason_code: null });
  }
  return { pages: out };
}

/** T-052's output. Each point's inputs snapshot must be one this run may cite (the resolver's scope rule), not only a
 *  row of the tenant (the FK); its outlet must be in the run's scope (forecast_point RLS → 403). */
export async function writeForecasts(c: Queryable, run: Run, raw: unknown) {
  const { forecast_run: fr, points } = parse(ForecastsBatchRequest, raw);
  const head = await insertRows(c, run, "intel.forecast_run",
    [["id", "uuid"], ["method", "text"], ["trained_through", "date"], ["horizon_days", "int"], ["holdout_days", "int"], ["wape_bp", "int"],
     ["baseline_wape_bp", "int"], ["bias_bp", "int"]], [fr], RUN(run));
  const resolver = dbResolver(c, run.scope);
  for (const id of new Set(points.map((p) => p.inputs_snapshot_id))) {
    if ((await resolver.resolve({ kind: "snapshot", id, span: null })).status !== "ok") throw new ApiError("cannot_verify", "unresolved_ref");
  }
  const pts = await insertRows(c, run, "intel.forecast_point",
    [["id", "uuid"], ["forecast_run_id", "uuid"], ["outlet_id", "uuid"], ["item_id", "uuid"], ["business_on", "date"], ["slot_start", "time"],
     ["method", "text"], ["qty_milli", "bigint"], ["lo_qty_milli", "bigint"], ["hi_qty_milli", "bigint"], ["inputs_snapshot_id", "uuid"]],
    points.map((p) => ({ ...p, forecast_run_id: fr.id })));
  return { run_inserted: head.inserted === 1, ...pts };
}

/** Simulated suppliers only: the composite FK to core.supplier (id, kind = 'simulated') refuses any other (→ 422).
 *  Provenance (DECISIONS 11 Oct, "W3.2 review ruling — quote provenance"; columns from 0024): each quote names the
 *  supplier's reply as a chunk THIS run stored, and every field's span lies inside that chunk's text (characters, as
 *  Postgres counts them) — else 422 and nothing is stored. 0024's own check holds the same rule in the database. */
export async function writeQuotes(c: Queryable, run: Run, raw: unknown) {
  const { quotes } = parse(QuotesBatchRequest, raw);
  const outside = await c.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM jsonb_to_recordset($1::jsonb) AS r(source_chunk_id uuid, spans jsonb)
       LEFT JOIN intel.chunk k ON k.id = r.source_chunk_id AND k.run_id = $2
      WHERE k.id IS NULL OR EXISTS (SELECT 1 FROM jsonb_each(r.spans) s WHERE (s.value ->> 1)::int > char_length(k.text))`,
    [JSON.stringify(quotes), run.runId]);
  if (outside.rows[0]!.n > 0) throw new ApiError("invalid_payload");
  // A zero field's span is null on the wire; 0024's spans_match admits a span or no key, so null keys are not stored.
  const rows = quotes.map((q) => ({ ...q, spans: Object.fromEntries(Object.entries(q.spans).filter(([, s]) => s !== null)) }));
  return insertRows(c, run, "intel.supplier_quote",
    [["id", "uuid"], ["supplier_id", "uuid"], ["ingredient_id", "uuid"], ["round", "smallint"], ["qty_milli", "bigint"], ["unit", "text"],
     ["unit_price_minor", "bigint"], ["currency", "char(3)"], ["min_order_qty_milli", "bigint"], ["payment_days", "int"], ["terms", "jsonb"],
     ["trace_event_id", "uuid"], ["source_chunk_id", "uuid"], ["spans", "jsonb"]], rows, RUN(run));
}

/** Always recorded — past the cap too (the cap decides narration, never whether spend is written). Stamped `at` = core's
 *  clock. The currency must be the month's budget currency, or with no budget the tenant's base currency: platform
 *  budgets sum spend in their own currency only, so other spend would escape the cap. */
export async function writeSpend(c: Queryable, run: Run, raw: unknown, cfg: InternalConfig) {
  const { entries } = parse(SpendRequest, raw);
  const at = (cfg.clock ?? (() => new Date()))();
  const cur = await c.query<{ currency: string }>(
    `SELECT coalesce((SELECT b.currency FROM platform.llm_budget b WHERE b.month = date_trunc('month', $1::timestamptz AT TIME ZONE 'UTC')::date),
                     (SELECT t.base_currency FROM core.tenant t)) AS currency`, [at.toISOString()]);
  if (entries.some((e) => e.currency !== cur.rows[0]!.currency)) throw new ApiError("currency_mismatch");
  return insertRows(c, run, "intel.intel_spend",
    [["id", "uuid"], ["role", "text"], ["provider", "text"], ["model_id", "text"], ["input_tokens", "int"], ["output_tokens", "int"],
     ["amount_minor", "bigint"], ["currency", "char(3)"]], entries, [...RUN(run), ["at", at.toISOString()]]);
}
