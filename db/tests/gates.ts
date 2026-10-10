// Gate functions shared by the green tests and their red-proofs. Each returns the list of failures it saw
// (empty = green) plus what it checked, so a red-proof can assert the gate actually turned red.
import type pg from "pg";
import type { AppContext, TestDb } from "../src/harness.ts";
import { OUR_SCHEMAS } from "./manifest.ts";

export const ident = (t: string) => t.split(".").map((p) => `"${p}"`).join(".");

export async function catalogTenantTables(db: TestDb): Promise<string[]> {
  const r = await db.admin<{ t: string }>(`
    SELECT s.nspname || '.' || c.relname AS t
      FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
     WHERE s.nspname = ANY ($1) AND c.relkind = 'r'
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
     ORDER BY 1`, [OUR_SCHEMAS]);
  return r.rows.map((x) => x.t);
}

/** Isolation, catalog half: RLS enabled AND forced AND ≥ 1 PERMISSIVE policy on every tenant table (a table
 *  with only restrictive policies is deny-all). */
export async function isolationCatalog(db: TestDb): Promise<{ checked: string[]; failures: string[] }> {
  const r = await db.admin<{ t: string; rls: boolean; force: boolean; policies: number }>(`
    SELECT s.nspname || '.' || c.relname AS t, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
           (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid AND p.polpermissive) AS policies
      FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
     WHERE s.nspname = ANY ($1) AND c.relkind = 'r'
       AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
     ORDER BY 1`, [OUR_SCHEMAS]);
  const failures = r.rows
    .filter((x) => !x.rls || !x.force || x.policies < 1)
    .map((x) => `${x.t}: rls=${x.rls} force=${x.force} policies=${x.policies}`);
  return { checked: r.rows.map((x) => x.t), failures };
}

/** Isolation, row half: as tenant A every tenant table shows ≥ 1 own row and 0 of B's. */
export async function isolationRows(
  db: TestDb,
  tables: string[],
  a: string,
  b: string,
): Promise<{ checked: number; failures: string[] }> {
  const failures: string[] = [];
  await db.withContext("munim_core", { tenant_id: a, outlet_ids: "*" }, async (c) => {
    for (const t of tables) {
      const r = await c.query(
        `SELECT count(*) FILTER (WHERE tenant_id = $1)::int AS own, count(*) FILTER (WHERE tenant_id = $2)::int AS other FROM ${ident(t)}`,
        [a, b],
      );
      const { own, other } = r.rows[0];
      if (own < 1) failures.push(`${t}: own rows = ${own}`);
      if (other !== 0) failures.push(`${t}: saw ${other} of tenant B's rows`);
    }
  });
  return { checked: tables.length, failures };
}

/** Outlet scope: as tenant A scoped to outlet `inside`, rows of `outside` are invisible, own visible. */
export async function outletScopeRows(
  db: TestDb,
  tables: string[],
  tenant: string,
  inside: string,
  outside: string,
): Promise<{ checked: number; failures: string[] }> {
  const failures: string[] = [];
  await db.withContext("munim_core", { tenant_id: tenant, outlet_ids: [inside] }, async (c) => {
    for (const t of tables) {
      const r = await c.query(
        `SELECT count(*) FILTER (WHERE outlet_id = $1)::int AS mine, count(*) FILTER (WHERE outlet_id = $2)::int AS theirs FROM ${ident(t)}`,
        [inside, outside],
      );
      if (r.rows[0].mine < 1) failures.push(`${t}: in-scope rows = ${r.rows[0].mine}`);
      if (r.rows[0].theirs !== 0) failures.push(`${t}: saw ${r.rows[0].theirs} out-of-scope rows`);
    }
  });
  return { checked: tables.length, failures };
}

/** Runs one statement in its own transaction under ctx and returns the SQLSTATE + message (null = ok). */
export async function attempt(
  db: TestDb,
  role: Parameters<TestDb["withContext"]>[0],
  ctx: AppContext,
  sql: string,
  params: unknown[] = [],
): Promise<{ code: string; message: string } | null> {
  try {
    await db.withContext(role, ctx, (c: pg.Client) => c.query(sql, params));
    return null;
  } catch (e) {
    const err = e as { code?: string; message: string };
    return { code: err.code ?? "?", message: err.message };
  }
}

/** intel cannot write: INSERT/UPDATE/DELETE/TRUNCATE as munim_intel_ro on each table → 42501 permission denied. */
export async function intelWriteRefusals(db: TestDb, tables: string[]): Promise<{ attempts: number; failures: string[] }> {
  const cols = await db.admin<{ t: string; col: string }>(`
    SELECT DISTINCT ON (s.nspname, c.relname) s.nspname || '.' || c.relname AS t, a.attname AS col
      FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE s.nspname = ANY ($1) AND c.relkind = 'r' ORDER BY s.nspname, c.relname, a.attnum`, [OUR_SCHEMAS]);
  const firstCol = new Map(cols.rows.map((r) => [r.t, r.col]));
  const failures: string[] = [];
  let attempts = 0;
  for (const t of tables) {
    const col = firstCol.get(t);
    if (!col) {
      failures.push(`${t}: not in catalog`);
      continue;
    }
    const stmts = {
      INSERT: `INSERT INTO ${ident(t)} DEFAULT VALUES`,
      UPDATE: `UPDATE ${ident(t)} SET "${col}" = "${col}"`,
      DELETE: `DELETE FROM ${ident(t)}`,
      TRUNCATE: `TRUNCATE ${ident(t)}`,
    };
    // The refusal must name this table (or its schema): a write that got past the table privilege and then hit a
    // permission error inside a trigger (0020: core.ai_thread's summary trigger reads core.ai_thread_turn) is not one.
    const own = new RegExp(`^permission denied for (table ${t.split(".")[1]}|schema ${t.split(".")[0]})$`);
    for (const [op, sql] of Object.entries(stmts)) {
      attempts++;
      const e = await attempt(db, "munim_intel_ro", {}, sql);
      if (!e || e.code !== "42501" || !own.test(e.message)) {
        failures.push(`${t} ${op}: ${e ? `${e.code} ${e.message}` : "succeeded"}`);
      }
    }
  }
  return { attempts, failures };
}

export async function functionsExecutableBy(db: TestDb, role: string): Promise<string[]> {
  const r = await db.admin<{ f: string }>(`
    SELECT p.oid::regprocedure::text AS f FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
     WHERE s.nspname = ANY ($1) AND has_function_privilege($2, p.oid, 'EXECUTE') ORDER BY 1`, [OUR_SCHEMAS, role]);
  return r.rows.map((x) => x.f);
}

export async function catalogTags(db: TestDb): Promise<Map<string, string | null>> {
  const r = await db.admin<{ t: string; tag: string | null }>(`
    SELECT 'core.' || c.relname AS t, obj_description(c.oid, 'pg_class') AS tag
      FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
     WHERE s.nspname = 'core' AND c.relkind IN ('r', 'p') ORDER BY 1`);
  return new Map(r.rows.map((x) => [x.t, x.tag]));
}

/** Service has no book grants: neither table- nor column-level INSERT/UPDATE on any book table. */
export async function serviceBookGrants(db: TestDb, bookTables: string[]): Promise<string[]> {
  const r = await db.admin<{ t: string; tbl: boolean; col: boolean }>(`
    SELECT t, has_table_privilege('munim_svc', t, 'INSERT,UPDATE') AS tbl,
           has_any_column_privilege('munim_svc', t, 'INSERT,UPDATE') AS col
      FROM unnest($1::text[]) t`, [bookTables.map(ident)]);
  return r.rows.filter((x) => x.tbl || x.col).map((x) => `${x.t}: svc has INSERT/UPDATE`);
}

/** Objects that cross tenants: SECURITY DEFINER functions + anything munim_crosstenant owns. */
export async function crosstenantObjects(db: TestDb): Promise<string[]> {
  const r = await db.admin<{ o: string }>(`
    SELECT s.nspname || '.' || p.proname AS o FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
     WHERE s.nspname = ANY ($1) AND (p.prosecdef OR p.proowner = 'munim_crosstenant'::regrole)
    UNION
    SELECT s.nspname || '.' || c.relname FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
     WHERE c.relowner = 'munim_crosstenant'::regrole
     ORDER BY 1`, [OUR_SCHEMAS]);
  return r.rows.map((x) => x.o);
}
