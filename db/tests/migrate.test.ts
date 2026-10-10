// Gate: the migration runner. On fresh databases in the shared cluster (roles already exist there, which
// also proves 0001 re-applies cleanly against pre-existing cluster-global roles): applies the manifest in order
// (0013 skipped: no pgvector here) and is
// idempotent; refuses an edited applied migration; skips `-- requires: <missing ext>` loudly without
// recording it; rolls a failing migration back entirely; refuses a numbering gap.
import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, rmSync, writeFileSync, appendFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, expect, test } from "vitest";
import { MIGRATIONS_DIR, migrate, readMigrations } from "../migrate.ts";
import type { TestDb } from "../src/harness.ts";
import { openDb } from "./db.ts";
import { MIGRATION_FILES, MIGRATIONS, SKIPPED_HERE } from "./manifest.ts";

// Planted files take the next free version numbers after the real ones.
const NEXT = MIGRATION_FILES.length + 1;
const v = (n: number) => String(n).padStart(4, "0");

let db: TestDb;
const cleanup: (() => Promise<void>)[] = [];

beforeAll(async () => {
  db = await openDb();
});
afterAll(async () => {
  for (const f of cleanup.reverse()) await f();
  await db?.stop();
});

function copy(): string {
  const d = mkdtempSync(join(tmpdir(), "munim-mig-"));
  cpSync(MIGRATIONS_DIR, d, { recursive: true });
  cleanup.push(async () => rmSync(d, { recursive: true, force: true }));
  return d;
}

async function freshDb(): Promise<pg.Client> {
  const name = `munim_fresh_${randomBytes(5).toString("hex")}`;
  await db.admin(`CREATE DATABASE ${name}`);
  const c = new pg.Client({ host: "127.0.0.1", port: db.port, user: "postgres", password: db.password, database: name });
  await c.connect();
  cleanup.push(async () => {
    await c.end().catch(() => {});
    await db.admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  });
  return c;
}

const quiet = { log: () => {} };

test(`fresh database: ${MIGRATIONS.length} applied in manifest order, 0013 skipped; a second run applies nothing`, async () => {
  const c = await freshDb();
  const first = await migrate(c, quiet);
  console.log(`runner: applied ${first.applied.length} (${first.applied.join(", ")}); skipped ${JSON.stringify(first.skipped)}`);
  expect(first.applied).toEqual([...MIGRATIONS]);
  expect(first.skipped).toEqual(SKIPPED_HERE);
  const second = await migrate(c, quiet);
  expect(second.applied).toEqual([]);
  expect(second.alreadyApplied).toEqual([...MIGRATIONS]);
  expect(second.skipped).toEqual(SKIPPED_HERE);
  const shas = await c.query("SELECT name, sha256 FROM munim_meta.schema_migrations ORDER BY version");
  expect(shas.rows.map((r) => r.sha256)).toEqual(readMigrations().filter((m) => m.requires.length === 0).map((m) => m.sha256));
});

test("an edited applied migration is refused (sha mismatch) — fix forward", async () => {
  const d = copy();
  const c = await freshDb();
  await migrate(c, { ...quiet, dir: d });
  appendFileSync(join(d, "0004_catalogue_orders_customer.sql"), "\n-- harmless-looking edit\n");
  const e = await migrate(c, { ...quiet, dir: d }).catch((x: Error) => x);
  console.log("runner refusal:", (e as Error).message);
  expect((e as Error).message).toMatch(/applied migration 0004_catalogue_orders_customer was edited/);
});

test("`-- requires: vector` is skipped LOUDLY and not recorded; later files still apply; `requires: pgcrypto` applies", async () => {
  const d = copy();
  writeFileSync(join(d, `${v(NEXT)}_embeddings2.sql`), "-- requires: vector\nCREATE TABLE intel.chunk_vec (id int, v vector(3));\n");
  writeFileSync(join(d, `${v(NEXT + 1)}_after.sql`), "-- requires: pgcrypto\nCREATE TABLE intel.after_skip (id int);\n");
  const c = await freshDb();
  const lines: string[] = [];
  const r = await migrate(c, { dir: d, log: (l) => lines.push(l) });
  const loud = lines.filter((l) => l.includes("SKIPPED"));
  console.log(`runner skip: ${loud.join(" | ")}`);
  expect(r.skipped).toEqual([...SKIPPED_HERE, { name: `${v(NEXT)}_embeddings2`, missing: ["vector"] }]);
  expect(loud[0]).toMatch(/SKIPPED 0013_embeddings — requires extension\(s\) vector/);
  expect(r.applied.at(-1)).toBe(`${v(NEXT + 1)}_after`);
  const rec = await c.query("SELECT name FROM munim_meta.schema_migrations WHERE version >= $1 ORDER BY version", [MIGRATION_FILES.length]);
  expect(rec.rows.map((x) => x.name)).toEqual([MIGRATIONS.at(-1), `${v(NEXT + 1)}_after`]);
});

test("a failing migration is rolled back entirely and not recorded", async () => {
  const d = copy();
  writeFileSync(join(d, `${v(NEXT)}_broken.sql`), "CREATE TABLE intel.half_done (id int);\nSELECT * FROM no_such_table;\n");
  const c = await freshDb();
  const e = await migrate(c, { ...quiet, dir: d }).catch((x: Error) => x);
  expect((e as Error).message).toMatch(new RegExp(`${v(NEXT)}_broken failed and was rolled back`));
  expect((await c.query("SELECT to_regclass('intel.half_done') AS t")).rows[0].t).toBeNull();
  expect((await c.query("SELECT count(*)::int n FROM munim_meta.schema_migrations")).rows[0].n).toBe(MIGRATIONS.length);
});

test("a numbering gap is refused before anything runs", () => {
  const d = copy();
  renameSync(join(d, "0006_approvals_extras.sql"), join(d, "0007_approvals_extras.sql"));
  expect(() => readMigrations(d)).toThrow(/expected version 6, found 0007_approvals_extras/);
});
