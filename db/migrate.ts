// Migration runner (BOARD M-A). Applies db/migrations/NNNN_name.sql in version order, one transaction per
// file, and records each in munim_meta.schema_migrations with the file's sha256.
//   - An applied file whose bytes changed is refused: migrations are frozen once applied; fix forward.
//   - A header line `-- requires: <extension>` skips the file LOUDLY when the server lacks the extension;
//     the file is not recorded, so it applies on a later run against a server that has it.
//   - From 0002 on, each file runs under `SET LOCAL ROLE munim_migrator`, so every object it creates is
//     owned by munim_migrator (0001 creates that role, so it runs as the connecting admin).
// CLI: `pnpm -F @munim/db migrate` against $MUNIM_DB_URL_SESSION (an admin URL), which the caller exports (the script
// never reads .env; the config module reads only the environment here). Never point it at a database you did not mean to.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

export interface MigrationFile {
  version: number;
  name: string; // e.g. "0003_core_foundation"
  path: string;
  sql: string;
  sha256: string;
  requires: string[];
}

export interface MigrateResult {
  applied: string[];
  skipped: { name: string; missing: string[] }[];
  alreadyApplied: string[];
}

const FILE_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const REQUIRES_RE = /^--\s*requires:\s*([a-z0-9_]+)\s*$/gm;
// Arbitrary constant: serialises concurrent runners against one database.
const RUNNER_LOCK = 7_364_201;

export function readMigrations(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const out: MigrationFile[] = [];
  for (const f of files) {
    const m = FILE_RE.exec(f);
    if (!m) throw new Error(`migrate: ${f} does not match NNNN_name.sql`);
    const sql = readFileSync(join(dir, f), "utf8");
    out.push({
      version: Number(m[1]),
      name: f.slice(0, -4),
      path: join(dir, f),
      sql,
      sha256: createHash("sha256").update(sql).digest("hex"),
      requires: [...sql.matchAll(REQUIRES_RE)].map((r) => r[1]!),
    });
  }
  out.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`migrate: expected version ${i + 1}, found ${m.name} (gap or duplicate)`);
  });
  return out;
}

export async function migrate(
  client: pg.Client,
  opts: { dir?: string; log?: (line: string) => void } = {},
): Promise<MigrateResult> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const files = readMigrations(opts.dir);
  const result: MigrateResult = { applied: [], skipped: [], alreadyApplied: [] };

  await client.query("SELECT pg_advisory_lock($1)", [RUNNER_LOCK]);
  try {
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS munim_meta;
      CREATE TABLE IF NOT EXISTS munim_meta.schema_migrations (
        version    integer PRIMARY KEY,
        name       text NOT NULL,
        sha256     text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      );`);
    const applied = new Map<number, { name: string; sha256: string }>();
    for (const r of (await client.query("SELECT version, name, sha256 FROM munim_meta.schema_migrations")).rows) {
      applied.set(r.version, { name: r.name, sha256: r.sha256 });
    }
    for (const [version, row] of applied) {
      const f = files.find((x) => x.version === version);
      if (!f) throw new Error(`migrate: applied migration ${row.name} has no file — refusing (never delete an applied migration)`);
      if (f.name !== row.name || f.sha256 !== row.sha256) {
        throw new Error(
          `migrate: applied migration ${row.name} was edited (recorded sha256 ${row.sha256}, file ${f.sha256}) — refusing; fix forward in a new migration`,
        );
      }
    }

    const available = new Set<string>(
      (await client.query("SELECT name FROM pg_available_extensions")).rows.map((r) => r.name as string),
    );
    for (const f of files) {
      if (applied.has(f.version)) {
        result.alreadyApplied.push(f.name);
        continue;
      }
      const missing = f.requires.filter((e) => !available.has(e));
      if (missing.length > 0) {
        log(`migrate: SKIPPED ${f.name} — requires extension(s) ${missing.join(", ")}, not available on this server (not recorded; applies where available)`);
        result.skipped.push({ name: f.name, missing });
        continue;
      }
      await client.query("BEGIN");
      try {
        if (f.version > 1) await client.query("SET LOCAL ROLE munim_migrator");
        await client.query(f.sql);
        await client.query("INSERT INTO munim_meta.schema_migrations (version, name, sha256) VALUES ($1, $2, $3)", [
          f.version,
          f.name,
          f.sha256,
        ]);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw new Error(`migrate: ${f.name} failed and was rolled back: ${(e as Error).message}`, { cause: e });
      }
      log(`migrate: applied ${f.name}`);
      result.applied.push(f.name);
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [RUNNER_LOCK]);
  }
  return result;
}

/** The admin URL a db CLI connects with: MUNIM_DB_URL_SESSION from the process environment only (through the config
 *  module, so a development checkout's dev name for it works too), or exit 1 naming the variable, never a value. */
export async function adminUrlFromEnv(cli: string): Promise<string> {
  const { loadConfig } = await import("../packages/config/src/index.ts");
  try {
    return loadConfig({ env: process.env }).require("MUNIM_DB_URL_SESSION");
  } catch (e) {
    console.error(`${cli}: FAIL — ${(e as Error).message.replace(" — see .env.example", "")} in the environment (this script never reads .env)`);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = await adminUrlFromEnv("migrate");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const r = await migrate(client);
    console.log(`migrate: ${r.applied.length} applied, ${r.alreadyApplied.length} already applied, ${r.skipped.length} skipped`);
  } finally {
    await client.end();
  }
}
