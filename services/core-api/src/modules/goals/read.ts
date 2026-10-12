// Goals and tasks read model (T-029). Rows only: a goal's progress is a snapshot cell (W3 template), never
// computed here. Dates leave as text.
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

/** Goals and tasks are tenant-RLS only; outlet rows are confined here (NULL outlet = tenant-wide, everyone's). */
const inScope = (col: string) =>
  `(${col} IS NULL OR CASE WHEN current_setting('app.outlet_ids', true) = '{*}' THEN true
     ELSE ${col} = ANY (nullif(current_setting('app.outlet_ids', true), '')::uuid[]) END)`;

export async function goals(c: Queryable, raw: Record<string, string | undefined>) {
  const q = query({ outlet: "uuid", status: ["active", "achieved", "missed", "cancelled"] }, raw);
  const r = await c.query(
    `SELECT id, outlet_id, metric, target_value::float8 AS target_value, currency, period_from::text, due_on::text, status, basis_snapshot_id
       FROM core.goal WHERE ${inScope("outlet_id")} AND ($1::uuid IS NULL OR outlet_id = $1) AND ($2::text IS NULL OR status = $2) ORDER BY due_on, id`,
    [q.outlet ?? null, q.status ?? null]);
  return { items: r.rows };
}

export async function tasks(c: Queryable, raw: Record<string, string | undefined>) {
  const q = query({ outlet: "uuid", assignee: "uuid", status: ["open", "done", "cancelled"], due_before: "date" }, raw);
  const r = await c.query(
    `SELECT id, outlet_id, title_key, assignee_member_id, due_on::text, finding_id, cares_listing_id, status, done_at, done_by
       FROM core.task WHERE ${inScope("outlet_id")} AND ($1::uuid IS NULL OR outlet_id = $1) AND ($2::uuid IS NULL OR assignee_member_id = $2)
        AND ($3::text IS NULL OR status = $3) AND ($4::date IS NULL OR due_on <= $4) ORDER BY due_on, id`,
    [q.outlet ?? null, q.assignee ?? null, q.status ?? null, q.due_before ?? null]);
  return { items: r.rows };
}
