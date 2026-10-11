// Snapshot cells behind draft refs (R25, R26, R40 C4). Every value approvals shows or executes is read
// from an evidence.snapshot row under the caller's RLS — never from payload text. A snapshot wider than
// the viewer's outlet scope, or of a template above the viewer's role, does not resolve ("cannot verify").
import { parseRef } from "@munim/contracts";
import type { Principal } from "../../auth/resolve.ts";
import { canonicalJson, sha256Hex, uuidv7 } from "../../commit/index.ts";
import type { Queryable } from "../../runtoken/index.ts";

export type Cell = string | number | boolean | null;
export type Row = Record<string, Cell>;
export type Column = { name: string; type: string };
export type Member = Extract<Principal, { kind: "member" }>;

export interface LoadedSnapshot {
  id: string;
  template_id: string;
  template_version: number;
  params: Record<string, unknown>;
  outlet_scope: string[];
  rows: Row[];
  columns: Column[];
  min_role: string;
  created_at: Date;
}

// Template min_role ladder (0019, settles W2-R8): staff < manager < advisor (read-only finance, R27) < owner; judge has
// owner rights in its demo tenant (03-arch §6); operator templates are operator-only.
export const TEMPLATE_RANK: Record<string, number> = { staff: 1, manager: 2, advisor: 3, owner: 4, judge: 4, operator: 5 };
const RANK = TEMPLATE_RANK;

export function visibleTo(s: LoadedSnapshot, m: Member): boolean {
  if ((RANK[m.role] ?? 0) < (RANK[s.min_role] ?? 99)) return false;
  if (m.outlet_ids === "*") return true;
  const scope = m.outlet_ids;
  return !s.outlet_scope.includes("*") && s.outlet_scope.every((o) => scope.includes(o));
}

/** Snapshots by id that the member may open (RLS confines the read to the member's tenant). */
export async function loadSnapshots(c: Queryable, ids: Iterable<string>, m: Member): Promise<Map<string, LoadedSnapshot>> {
  const list = [...new Set(ids)];
  const out = new Map<string, LoadedSnapshot>();
  if (list.length === 0) return out;
  const r = await c.query<LoadedSnapshot>(
    `SELECT s.id, s.template_id, s.template_version, s.params, s.outlet_scope, s.rows, t.columns, t.min_role, s.created_at
       FROM evidence.snapshot s
       JOIN evidence.snapshot_template t ON t.id = s.template_id AND t.version = s.template_version
      WHERE s.id = ANY ($1::uuid[])`,
    [list],
  );
  for (const s of r.rows) if (visibleTo(s, m)) out.set(s.id, s);
  return out;
}

/** The cell a snap ref names, with its column type; null when it does not resolve for this viewer. */
export function cellOf(ref: string, snaps: Map<string, LoadedSnapshot>): { value: Cell; type: string } | null {
  const p = parseRef(ref);
  if (!p || p.kind !== "snap") return null;
  const s = snaps.get(p.snapshot_id);
  const col = s?.columns.find((x) => x.name === p.column);
  const row = s?.rows[p.row];
  if (!s || !col || !row || !(p.column in row)) return null;
  return { value: row[p.column]!, type: col.type };
}

export const snapIdOf = (ref: string): string | null => {
  const p = parseRef(ref);
  return p && p.kind === "snap" ? p.snapshot_id : null;
};

/** Template SQL uses named params (`:outlet_id`, docs/plan/packs). Rewrites them to `$n` outside string
 *  literals ('…', E'…', $tag$…$tag$), quoted identifiers and comments; `::type` casts are not params. */
export function bindNamedParams(sql: string): { sql: string; names: string[] } {
  const names: string[] = [];
  let out = "";
  let i = 0;
  const skipTo = (end: string, from: number) => {
    const j = sql.indexOf(end, from);
    return j < 0 ? sql.length : j + end.length;
  };
  while (i < sql.length) {
    const ch = sql[i]!;
    let next = i + 1;
    if (ch === "'") {
      const escapes = /[eE]/.test(sql[i - 1] ?? "") && !/[A-Za-z0-9_]/.test(sql[i - 2] ?? "");
      next = i + 1;
      for (;;) {
        while (next < sql.length && sql[next] !== "'") next += escapes && sql[next] === "\\" ? 2 : 1;
        next++;
        if (sql[next] !== "'") break; // '' is an escaped quote inside the literal
        next++;
      }
    } else if (ch === '"') next = skipTo('"', i + 1);
    else if (ch === "-" && sql[i + 1] === "-") next = skipTo("\n", i + 2);
    else if (ch === "/" && sql[i + 1] === "*") next = skipTo("*/", i + 2);
    else if (ch === "$" && /^\$[A-Za-z_]*\$/.test(sql.slice(i))) {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))![0];
      next = skipTo(tag, i + tag.length);
    } else if (ch === ":" && sql[i + 1] === ":") next = i + 2;
    else if (ch === ":") {
      const m = /^:([a-z_][a-z0-9_]*)/.exec(sql.slice(i));
      if (m) {
        if (!names.includes(m[1]!)) names.push(m[1]!);
        out += `$${names.indexOf(m[1]!) + 1}`;
        i += m[0].length;
        continue;
      }
    }
    out += sql.slice(i, next);
    i = next;
  }
  return { sql: out, names };
}

function typed(text: string | null, type: string): Cell {
  if (text === null) return null;
  if (type === "integer") {
    const n = Number(text);
    return /^-?[0-9]+$/.test(text) && Number.isSafeInteger(n) ? n : text;
  }
  if (type === "boolean") return text === "true";
  return text;
}

/** Runs a migration-authored template under the transaction's RLS context (cap 500 rows). Cells are typed
 *  by the template's declared columns: integers as numbers when safe, numerics as decimal strings. */
export async function runTemplate(c: Queryable, templateId: string, version: number, params: Record<string, unknown>): Promise<{ columns: Column[]; rows: Row[] }> {
  const t = await c.query<{ sql: string; columns: Column[] }>(
    `SELECT sql, columns FROM evidence.snapshot_template WHERE id = $1 AND version = $2`, [templateId, version]);
  const tpl = t.rows[0];
  if (!tpl) throw new Error(`snapshot template ${templateId}@${version} not found`);
  const { sql, names } = bindNamedParams(tpl.sql);
  for (const n of names) if (!(n in params)) throw new Error(`snapshot template ${templateId}: param '${n}' not supplied`);
  const r = await c.query<{ r: Record<string, string | null> | null }>(
    `SELECT (SELECT jsonb_object_agg(e.key, e.value #>> '{}') FROM jsonb_each(to_jsonb(t)) e) AS r FROM (${sql}) t LIMIT 500`,
    names.map((n) => params[n]),
  );
  const rows = r.rows.map(({ r: raw }) => {
    const row: Row = {};
    for (const col of tpl.columns) row[col.name] = typed(raw?.[col.name] ?? null, col.type);
    return row;
  });
  return { columns: tpl.columns, rows };
}

/** Mints a snapshot as the signed-in member (R40 C4: minted_by_member_id) with the member's outlet scope. */
export async function mintMemberSnapshot(c: Queryable, m: Member, templateId: string, version: number,
  params: Record<string, unknown>, rows: Row[]): Promise<string> {
  const id = uuidv7();
  await c.query(
    `INSERT INTO evidence.snapshot (tenant_id, id, template_id, template_version, params, minted_by_member_id, outlet_scope, rows, row_count, sha256)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [m.tenant_id, id, templateId, version, params, m.member_id, m.outlet_ids === "*" ? ["*"] : m.outlet_ids,
     JSON.stringify(rows), rows.length, sha256Hex(canonicalJson(rows))],
  );
  return id;
}
