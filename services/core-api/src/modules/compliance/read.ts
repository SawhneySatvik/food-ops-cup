// Compliance read model (T-029). Rows are the rows' own fields; the two derived columns are per-row facts, not
// aggregates: `days_left` (licence valid_to − the outlet-local date of as_of) and `out_of_range` (reading vs the
// asset's own safe range). Dashboard numbers (coverage, excursion counts, asset ₹) are W3 snapshot templates.
// Dates and times leave as text so no driver time-zone conversion can move a day.
import { ApiError } from "../../lib/errors.ts";
import type { Queryable } from "../../runtoken/index.ts";

type Rule = "uuid" | "date" | "datetime" | "int" | readonly string[];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** Query-string validation: unknown or malformed parameters are a bad_request, never passed to SQL. */
function query<K extends string>(rules: Record<K, Rule>, raw: Record<string, string | undefined>): { [P in K]?: string | undefined } {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    const rule = (rules as Record<string, Rule | undefined>)[k];
    if (v === undefined) continue;
    const ok = rule === undefined ? false : Array.isArray(rule) ? rule.includes(v) : rule === "uuid" ? UUID.test(v)
      : rule === "date" ? DATE.test(v) && !Number.isNaN(Date.parse(v)) : rule === "datetime" ? DATETIME.test(v) && !Number.isNaN(Date.parse(v))
      : /^\d{1,4}$/.test(v);
    if (!ok) throw new ApiError("bad_request");
    out[k] = v;
  }
  return out as { [P in K]?: string | undefined };
}

/** Outlet confinement for tables whose RLS is tenant-only (02-schema §0 scopes only checklist_run and temp_log by
 *  outlet): a tenant-wide row (NULL outlet) is everyone's; an outlet row needs that outlet in the caller's scope. */
const inScope = (col: string) =>
  `(${col} IS NULL OR CASE WHEN current_setting('app.outlet_ids', true) = '{*}' THEN true
     ELSE ${col} = ANY (nullif(current_setting('app.outlet_ids', true), '')::uuid[]) END)`;

const PACK_TZ = `(SELECT p.doc ->> 'default_timezone' FROM core.tenant t JOIN platform.country_pack p ON p.code = t.country_code AND p.status = 'active'
                   WHERE t.tenant_id = current_setting('app.tenant_id')::uuid ORDER BY p.version DESC LIMIT 1)`;

export async function licences(c: Queryable, raw: Record<string, string | undefined>) {
  const q = query({ outlet: "uuid", status: ["active", "superseded", "lapsed"] }, raw);
  const r = await c.query(
    `SELECT id, outlet_id, kind, number, issuer, valid_from::text, valid_to::text, document_id, status
       FROM core.licence WHERE ($1::uuid IS NULL OR outlet_id = $1) AND ${inScope("outlet_id")} AND status = coalesce($2, 'active') ORDER BY kind, valid_to NULLS LAST, id`,
    [q.outlet ?? null, q.status ?? null]);
  return { items: r.rows };
}

/** Active licences whose valid_to is within `within_days` of today (or already past) in the OUTLET's time zone;
 *  a tenant-wide licence uses the country pack's default zone. `as_of` exists so a check is reproducible. */
export async function expiringLicences(c: Queryable, raw: Record<string, string | undefined>) {
  const q = query({ within_days: "int", as_of: "datetime", outlet: "uuid" }, raw);
  const r = await c.query(
    `SELECT * FROM (
       SELECT l.id, l.outlet_id, l.kind, l.number, l.valid_to::text AS valid_to, l.document_id,
              (l.valid_to - (coalesce($1::timestamptz, now()) AT TIME ZONE coalesce(o.tz, ${PACK_TZ}))::date)::int AS days_left
         FROM core.licence l LEFT JOIN core.outlet o ON o.tenant_id = l.tenant_id AND o.id = l.outlet_id
        WHERE l.status = 'active' AND l.valid_to IS NOT NULL AND ($3::uuid IS NULL OR l.outlet_id = $3) AND ${inScope("l.outlet_id")}) x
      WHERE days_left <= $2 ORDER BY days_left, kind, id`,
    [q.as_of ?? null, Number(q.within_days ?? 30), q.outlet ?? null]);
  return { items: r.rows.map((x: { days_left: number }) => ({ ...x, expired: x.days_left < 0 })) };
}

export async function assets(c: Queryable, raw: Record<string, string | undefined>) {
  const q = query({ outlet: "uuid" }, raw);
  const r = await c.query(
    `SELECT id, outlet_id, kind, name, make_model, serial_no, safe_min_milli_c, safe_max_milli_c, installed_on::text, active
       FROM core.asset WHERE ($1::uuid IS NULL OR outlet_id = $1) AND ${inScope("outlet_id")} ORDER BY outlet_id, name, id`, [q.outlet ?? null]);
  return { items: r.rows };
}

/** Readings with the asset's own range applied: out_of_range true/false, or null when the asset has no range
 *  (never "in range" by default). A reading exactly on a limit is in range. */
export async function tempLogs(c: Queryable, raw: Record<string, string | undefined>) {
  const q = query({ outlet: "uuid", asset: "uuid", from: "date", to: "date", limit: "int" }, raw);
  const r = await c.query(
    `SELECT t.id, t.outlet_id, t.asset_id, t.reading_milli_c, t.read_at, t.recorded_by, t.note,
            (t.read_at AT TIME ZONE o.tz)::date::text AS local_date,
            CASE WHEN a.safe_min_milli_c IS NULL THEN NULL
                 ELSE (t.reading_milli_c < a.safe_min_milli_c OR t.reading_milli_c > a.safe_max_milli_c) END AS out_of_range
       FROM core.temp_log t
       JOIN core.asset a ON a.tenant_id = t.tenant_id AND a.id = t.asset_id
       JOIN core.outlet o ON o.tenant_id = t.tenant_id AND o.id = t.outlet_id
      WHERE ($1::uuid IS NULL OR t.outlet_id = $1) AND ($2::uuid IS NULL OR t.asset_id = $2)
        AND ($3::date IS NULL OR (t.read_at AT TIME ZONE o.tz)::date >= $3) AND ($4::date IS NULL OR (t.read_at AT TIME ZONE o.tz)::date <= $4)
      ORDER BY t.read_at DESC, t.id LIMIT $5`,
    [q.outlet ?? null, q.asset ?? null, q.from ?? null, q.to ?? null, Math.min(Number(q.limit ?? 200), 500)]);
  return { items: r.rows };
}

export async function checklists(c: Queryable, raw: Record<string, string | undefined>) {
  const q = query({ outlet: "uuid" }, raw);
  const r = await c.query(
    `SELECT id, outlet_id, name_key, kind, frequency, due_time::text, items, active FROM core.checklist
      WHERE ($1::uuid IS NULL OR outlet_id IS NULL OR outlet_id = $1) AND ${inScope("outlet_id")} ORDER BY kind, name_key, id`, [q.outlet ?? null]);
  return { items: r.rows };
}

export async function checklistRuns(c: Queryable, raw: Record<string, string | undefined>) {
  const q = query({ outlet: "uuid", checklist: "uuid", from: "date", to: "date", limit: "int" }, raw);
  const r = await c.query(
    `SELECT id, checklist_id, outlet_id, business_date::text, results, completed_by, completed_at FROM core.checklist_run
      WHERE ($1::uuid IS NULL OR outlet_id = $1) AND ($2::date IS NULL OR business_date >= $2) AND ($3::date IS NULL OR business_date <= $3)
        AND ($5::uuid IS NULL OR checklist_id = $5)
      ORDER BY business_date DESC, id LIMIT $4`,
    [q.outlet ?? null, q.from ?? null, q.to ?? null, Math.min(Number(q.limit ?? 200), 500), q.checklist ?? null]);
  return { items: r.rows };
}

export async function amcs(c: Queryable, raw: Record<string, string | undefined>) {
  const q = query({ asset: "uuid" }, raw);
  const r = await c.query(
    `SELECT id, asset_id, vendor, valid_from::text, valid_to::text, cost_minor::float8 AS cost_minor, currency, document_id
       FROM core.amc WHERE ($1::uuid IS NULL OR asset_id = $1) AND asset_id IN (SELECT id FROM core.asset WHERE ${inScope("outlet_id")}) ORDER BY valid_from DESC, id`, [q.asset ?? null]);
  return { items: r.rows };
}

export async function maintenance(c: Queryable, raw: Record<string, string | undefined>) {
  const q = query({ asset: "uuid", status: ["scheduled", "done", "cancelled"] }, raw);
  const r = await c.query(
    `SELECT id, asset_id, kind, status, due_on::text, done_on::text, estimated_cost_minor::float8 AS estimated_cost_minor,
            cost_minor::float8 AS cost_minor, currency, vendor, amc_id, note
       FROM core.maintenance WHERE ($1::uuid IS NULL OR asset_id = $1) AND ($2::text IS NULL OR status = $2)
        AND asset_id IN (SELECT id FROM core.asset WHERE ${inScope("outlet_id")})
      ORDER BY coalesce(done_on, due_on) DESC, id`, [q.asset ?? null, q.status ?? null]);
  return { items: r.rows };
}
