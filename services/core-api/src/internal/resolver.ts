// The validator's RefResolver over Postgres (04-agent-framework §4; R25: "core-api decides"). Every lookup runs on
// the caller's munim_svc transaction, which carries the run token's tenant and outlet scope (SET LOCAL), so another
// tenant's row is simply not there: it resolves as `missing` → `unresolved_ref`. No cross-tenant lookup exists (the
// munim_crosstenant role owns exactly three objects, 0006), so `other_tenant` is never answered here.
// Snapshot RLS is tenant-only, so the outlet rule is applied here: a snapshot resolves for a run only when the run's
// scope covers the snapshot's (R40 C4, same rule as a member's view).
// `row:<schema>.<table>:<id>` names a table from model input: only a tenant-keyed table under FORCE RLS with an `id`
// column that munim_svc may read is looked up, through a quoted identifier; anything else is missing.
import type { RefResolver, Resolution } from "@munim/core-domain/envelope";
import type { ParsedRef } from "@munim/contracts";
import type { OutletScope, Queryable } from "../runtoken/index.ts";

interface Snap { outlet_scope: string[]; rows: Array<Record<string, unknown>>; columns: Array<{ name: string }> }

const MISSING: Resolution = { status: "missing" };
const OK: Resolution = { status: "ok" };

export function dbResolver(c: Queryable, scope: OutletScope): RefResolver {
  const snaps = new Map<string, Snap | null>();
  const tables = new Map<string, boolean>();

  async function snapshot(id: string): Promise<Snap | null> {
    if (!snaps.has(id)) {
      const r = await c.query<Snap>(
        `SELECT s.outlet_scope, s.rows, t.columns FROM evidence.snapshot s
           JOIN evidence.snapshot_template t ON t.id = s.template_id AND t.version = s.template_version WHERE s.id = $1`, [id]);
      const s = r.rows[0] ?? null;
      const covered = s !== null && (scope[0] === "*" || (!s.outlet_scope.includes("*") && s.outlet_scope.every((o) => (scope as string[]).includes(o))));
      snaps.set(id, covered ? s : null);
    }
    return snaps.get(id)!;
  }

  async function readable(schemaTable: string): Promise<boolean> {
    if (!tables.has(schemaTable)) {
      const [schema, table] = schemaTable.split(".") as [string, string];
      const r = await c.query<{ ok: boolean }>(
        `SELECT (c.relkind = 'r' AND c.relrowsecurity AND c.relforcerowsecurity
                 AND has_table_privilege(c.oid, 'SELECT')
                 AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
                 AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'id' AND NOT a.attisdropped)) AS ok
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = $2 AND n.nspname IN ('core', 'intel', 'evidence')`, [schema, table]);
      tables.set(schemaTable, r.rows[0]?.ok === true);
    }
    return tables.get(schemaTable)!;
  }

  async function length(sql: string, id: string): Promise<Resolution> {
    const r = await c.query<{ n: number | null }>(sql, [id]);
    if (!r.rows[0]) return MISSING;
    return r.rows[0].n === null ? OK : { status: "ok", text_length: r.rows[0].n };
  }

  return {
    async resolve(ref: ParsedRef): Promise<Resolution> {
      switch (ref.kind) {
        case "snap": {
          const s = await snapshot(ref.snapshot_id);
          const row = s?.rows[ref.row];
          return s && row && ref.column in row && s.columns.some((col) => col.name === ref.column) ? OK : MISSING;
        }
        case "snapshot":
          return (await snapshot(ref.id)) ? OK : MISSING;
        case "row": {
          const i = ref.id.lastIndexOf(":");
          const [schema, table] = ref.id.slice(0, i).split(".") as [string, string];
          if (!(await readable(`${schema}.${table}`))) return MISSING;
          const r = await c.query(`SELECT 1 FROM "${schema}"."${table}" WHERE id = $1`, [ref.id.slice(i + 1)]);
          return r.rowCount === 1 ? OK : MISSING;
        }
        case "msg":
          return length(`SELECT length(body) AS n FROM core.message WHERE id = $1`, ref.id);
        case "claim":
          return length(`SELECT length(quote) AS n FROM intel.claim WHERE id = $1`, ref.id);
        case "doc":
          // A document's text is its extracted chunks (0012); with none, a span cannot be checked (quote_mismatch).
          return length(`SELECT (SELECT max(k.char_start + length(k.text)) FROM intel.chunk k WHERE k.document_id = d.id) AS n
                           FROM core.document d WHERE d.id = $1`, ref.id);
      }
    },
  };
}
