// Platform config drafts (R24, R27): propose -> (approve | reject). Applying a patch happens only inside
// approve, in the same munim_platform transaction as the status flip and the hash-chained platform_audit entry.
// An operator's own command is its approval (R27): the proposer may approve. Writes use the operator's own id,
// taken from the verified token, never from the body.
import { uuidv7 } from "../commit/index.ts";
import { ApiError } from "../lib/errors.ts";
import type { Queryable } from "../runtoken/index.ts";
import { type Parsed, parsePatch, type Patch } from "./validate.ts";

export interface DraftRow {
  id: string; target: string; patch: Patch; before: Record<string, unknown> | null; status: string;
  proposed_by: string; decided_by: string | null; decided_at: string | null; reason: string | null; created_at: string;
}

const COLS = `d.id, d.target, d.patch, d.status, d.proposed_by, d.decided_by,
  to_char(d.decided_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS decided_at, d.reason,
  to_char(d.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at`;

const asNumber = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

/** The target's current row as a plain object (null when it has none). Dates and bigints as text/number. */
export async function currentOf(c: Queryable, p: Parsed): Promise<Record<string, unknown> | null> {
  switch (p.kind) {
    case "model_role": {
      const r = await c.query(
        `SELECT role, provider, model_id, input_price_per_mtok_minor::text AS input_price_per_mtok_minor,
                output_price_per_mtok_minor::text AS output_price_per_mtok_minor, price_currency FROM platform.model_role WHERE role = $1`, [p.role]);
      const row = r.rows[0];
      return row ? { ...row, input_price_per_mtok_minor: asNumber(row.input_price_per_mtok_minor), output_price_per_mtok_minor: asNumber(row.output_price_per_mtok_minor) } : null;
    }
    case "feature_flag": {
      const r = await c.query(`SELECT key, value_type, value FROM platform.feature_flag WHERE key = $1`, [p.key]);
      return r.rows[0] ?? null;
    }
    case "llm_budget": {
      const r = await c.query(`SELECT tenant_id, month::text AS month, limit_minor::bigint::text AS limit_minor, currency FROM platform.llm_budget WHERE tenant_id = $1 AND month = $2`, [p.tenant_id, p.month]);
      const row = r.rows[0];
      return row ? { ...row, limit_minor: Number(row.limit_minor) } : null;
    }
    case "country_pack": {
      const r = await c.query(`SELECT code, max(version) AS latest_version FROM platform.country_pack WHERE code = $1 GROUP BY code`, [p.code]);
      return r.rows[0] ?? null;
    }
    case "plan": {
      const r = await c.query(`SELECT code, name, limits, status FROM platform.plan WHERE code = $1`, [p.code]);
      return r.rows[0] ?? null;
    }
  }
}

async function hydrate(c: Queryable, rows: Array<Omit<DraftRow, "before">>): Promise<DraftRow[]> {
  const out: DraftRow[] = [];
  for (const r of rows) {
    let before: Record<string, unknown> | null = null;
    if (r.status === "proposed") {
      try { before = await currentOf(c, parsePatch(r.target, r.patch, "0000-00-00")); } catch { before = null; }
    } else {
      const a = await c.query(`SELECT before FROM platform.platform_audit WHERE config_draft_id = $1 AND action = 'config_draft.apply' ORDER BY seq DESC LIMIT 1`, [r.id]);
      before = (a.rows[0]?.before as Record<string, unknown> | null | undefined) ?? null;
    }
    out.push({ ...r, before });
  }
  return out;
}

export async function listDrafts(c: Queryable, status: string): Promise<DraftRow[]> {
  const r = await c.query(`SELECT ${COLS} FROM platform.config_draft d WHERE ($1 = 'all' OR d.status = $1) ORDER BY d.created_at DESC, d.id LIMIT 200`, [status]);
  return hydrate(c, r.rows);
}

export async function getDraftRow(c: Queryable, id: string, lock = false): Promise<DraftRow | null> {
  const r = await c.query(`SELECT ${COLS} FROM platform.config_draft d WHERE d.id = $1 ${lock ? "FOR UPDATE OF d" : ""}`, [id]);
  return r.rows[0] ? (await hydrate(c, r.rows))[0]! : null;
}

async function audit(c: Queryable, operatorId: string, action: string, entity: string, entityId: string, before: unknown, after: unknown, draftId: string) {
  await c.query(
    `INSERT INTO platform.platform_audit (actor, action, entity, entity_id, before, after, config_draft_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [{ kind: "operator", id: operatorId }, action, entity, entityId,
     before === null || before === undefined ? null : JSON.stringify(before), after === null || after === undefined ? null : JSON.stringify(after), draftId]);
}

/** Inserts a proposed draft after validating its patch. The same client id and body replays the original. */
export async function propose(c: Queryable, operatorId: string, body: { draft_id?: string | undefined; target: string; patch: Patch }): Promise<{ draft: DraftRow; replayed: boolean }> {
  parsePatch(body.target, body.patch); // refusals leave no row
  const id = body.draft_id ?? uuidv7();
  const proposedBy = `operator:${operatorId}`;
  if (body.draft_id) {
    await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('platform.config_draft:' || $1, 0))`, [id]);
    const prior = await getDraftRow(c, id);
    if (prior) {
      if (prior.target !== body.target || prior.proposed_by !== proposedBy || JSON.stringify(sortKeys(prior.patch)) !== JSON.stringify(sortKeys(body.patch))) {
        throw new ApiError("idempotency_conflict");
      }
      return { draft: prior, replayed: true };
    }
  }
  await c.query(`INSERT INTO platform.config_draft (id, target, patch, proposed_by) VALUES ($1, $2, $3, $4)`, [id, body.target, JSON.stringify(body.patch), proposedBy]);
  await audit(c, operatorId, "config_draft.propose", "platform.config_draft", id, null, { target: body.target, patch: body.patch }, id);
  return { draft: (await getDraftRow(c, id))!, replayed: false };
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, sortKeys(x)]));
  return v;
}

/** Writes the validated patch to its target table. Runs only inside approve. */
async function apply(c: Queryable, p: Parsed): Promise<void> {
  switch (p.kind) {
    case "model_role":
      // A new model has not been probed: probed_at resets when provider or model change (a price-only change keeps the probe).
      await c.query(
        `INSERT INTO platform.model_role (role, provider, model_id, input_price_per_mtok_minor, output_price_per_mtok_minor, price_currency)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (role) DO UPDATE SET provider = excluded.provider, model_id = excluded.model_id,
           input_price_per_mtok_minor = excluded.input_price_per_mtok_minor, output_price_per_mtok_minor = excluded.output_price_per_mtok_minor,
           price_currency = excluded.price_currency,
           probed_at = CASE WHEN platform.model_role.provider = excluded.provider AND platform.model_role.model_id = excluded.model_id
                            THEN platform.model_role.probed_at ELSE NULL END`,
        [p.role, p.provider, p.model_id, p.prices?.input ?? null, p.prices?.output ?? null, p.prices?.currency ?? null]);
      return;
    case "feature_flag": {
      const f = await c.query<{ value_type: string }>(`SELECT value_type FROM platform.feature_flag WHERE key = $1 FOR UPDATE`, [p.key]);
      const t = f.rows[0]?.value_type;
      if (!t) throw new ApiError("not_found");
      const ok = t === "boolean" ? typeof p.value === "boolean" : t === "integer" ? typeof p.value === "number" : typeof p.value === "string";
      if (!ok) throw new ApiError("invalid_payload");
      await c.query(`UPDATE platform.feature_flag SET value = $2 WHERE key = $1`, [p.key, JSON.stringify(p.value)]);
      return;
    }
    case "llm_budget": {
      const t = await c.query<{ base_currency: string }>(`SELECT base_currency FROM platform.tenant_registry WHERE tenant_id = $1`, [p.tenant_id]);
      if (!t.rows[0]) throw new ApiError("not_found");
      if (t.rows[0].base_currency !== p.currency) throw new ApiError("currency_mismatch"); // R30: one currency per tenant
      await c.query(
        `INSERT INTO platform.llm_budget (tenant_id, month, limit_minor, currency) VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, month) DO UPDATE SET limit_minor = excluded.limit_minor`,
        [p.tenant_id, p.month, p.limit_minor, p.currency]);
      return;
    }
    case "country_pack": {
      await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('platform.country_pack:' || $1, 0))`, [p.code]);
      const v = await c.query<{ v: number }>(`SELECT coalesce(max(version), 0)::int AS v FROM platform.country_pack WHERE code = $1`, [p.code]);
      if (p.doc.version !== v.rows[0]!.v + 1) throw new ApiError("conflict"); // packs are immutable per version; the next one only
      await c.query(`INSERT INTO platform.country_pack (code, version, effective_from, doc, status) VALUES ($1, $2, $3, $4, 'active')`,
        [p.code, p.doc.version, p.effective_from, JSON.stringify(p.doc)]);
      return;
    }
    case "plan":
      await c.query(
        `INSERT INTO platform.plan (code, name, limits, status) VALUES ($1, $2, $3, $4)
         ON CONFLICT (code) DO UPDATE SET name = excluded.name, limits = excluded.limits, status = excluded.status`,
        [p.code, p.name, JSON.stringify(p.limits), p.status]);
      return;
  }
}

export async function approve(c: Queryable, operatorId: string, id: string, reason: string | null): Promise<DraftRow> {
  const d = await getDraftRow(c, id, true);
  if (!d) throw new ApiError("not_found");
  if (d.status !== "proposed") throw new ApiError("already_decided");
  const parsed = parsePatch(d.target, d.patch); // re-validated: apply never trusts what was stored
  const before = await currentOf(c, parsed);
  await apply(c, parsed);
  const after = await currentOf(c, parsed);
  await c.query(`UPDATE platform.config_draft SET status = 'applied', decided_by = $2, decided_at = now(), reason = $3 WHERE id = $1`, [id, operatorId, reason]);
  await audit(c, operatorId, "config_draft.apply", `platform.${parsed.kind}`, d.target, before, after, id);
  return (await getDraftRow(c, id))!;
}

export async function reject(c: Queryable, operatorId: string, id: string, reason: string): Promise<DraftRow> {
  const d = await getDraftRow(c, id, true);
  if (!d) throw new ApiError("not_found");
  if (d.status !== "proposed") throw new ApiError("already_decided");
  await c.query(`UPDATE platform.config_draft SET status = 'rejected', decided_by = $2, decided_at = now(), reason = $3 WHERE id = $1`, [id, operatorId, reason]);
  await audit(c, operatorId, "config_draft.reject", "platform.config_draft", id, { status: "proposed" }, { status: "rejected" }, id);
  return (await getDraftRow(c, id))!;
}
