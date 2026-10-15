// Gate: /health is 200 with the latest migration version, 503 with the database stopped. Uses its own
// cluster (not the shared one) so "stopped" means the server is really down, not a dropped clone.
import { copyFileSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "@munim/config";
import { startTestDb, type TestDb } from "@munim/db";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SKIPPED_HERE } from "../../../db/tests/manifest.ts";
import { createApp } from "../src/app.ts";
import { createLocalIdp } from "../src/auth/local-idp.ts";

// Expected version (W1 fixes #11, #76): the highest file number in db/migrations that is not in m-1's
// hand-written SKIPPED_HERE (files whose `-- requires:` extension embedded Postgres lacks) — never read from
// the runner. The cluster migrates a copy of db/migrations plus one planted top file requiring an extension no
// engine has, so "skipped files are excluded" is exercised whatever the real top file is.
const MIGRATIONS = join(import.meta.dirname, "../../../db/migrations");
const real = readdirSync(MIGRATIONS).flatMap((f) => (/^\d{4}_.*\.sql$/.test(f) ? [f] : []));
const skippedHere = new Set(SKIPPED_HERE.map((s) => s.name));
const expectedVersion = Math.max(...real.filter((f) => !skippedHere.has(f.replace(/\.sql$/, ""))).map((f) => Number(f.slice(0, 4))));
const highestReal = Math.max(...real.map((f) => Number(f.slice(0, 4))));
const PLANTED = `${String(highestReal + 1).padStart(4, "0")}_planted_needs_missing_ext`;
const COPY = mkdtempSync(join(tmpdir(), "munim-health-migrations-"));
for (const f of real) copyFileSync(join(MIGRATIONS, f), join(COPY, f));
writeFileSync(join(COPY, `${PLANTED}.sql`), "-- requires: munim_no_such_extension\nSELECT 1;\n");

let db: TestDb;
let stopped = false;
let pools: { core: pg.Pool; svc: pg.Pool };
const lines: string[] = [];

beforeAll(async () => {
  db = await startTestDb({ migrationsDir: COPY });
  pools = { core: db.pool("munim_core", 2), svc: db.pool("munim_svc", 2) };
  for (const p of Object.values(pools)) p.on("error", () => {});
});
afterAll(async () => {
  await Promise.allSettled([pools.core.end(), pools.svc.end()]);
  if (!stopped) await db?.stop(); // the test failed before stopping it
});

describe("/health", () => {
  it("200 with migration_version = highest applicable migration (skipped -- requires: files excluded), then 503 once the database is stopped", async () => {
    const config = { nodeEnv: "test", redact: (s: string) => s };
    const app = await createApp({
      pools, idp: createLocalIdp(), storefronts: async () => null, config, log: createLogger(config, (l) => lines.push(l)),
    });
    expect(expectedVersion).toBeGreaterThanOrEqual(12);
    expect(db.migration.skipped.map((s) => s.name).sort()).toEqual([...skippedHere, PLANTED].sort());
    console.log(`health: highest file ${highestReal + 1} (planted), expected ${expectedVersion}, skipped [${db.migration.skipped.map((s) => s.name).join(", ")}]`);

    const up = await app.request("/health");
    expect(up.status).toBe(200);
    expect(await up.json()).toEqual({ status: "ok", migration_version: expectedVersion, idp: null }); // no mode set on these Deps

    await db.stop();
    stopped = true;
    const down = await app.request("/health");
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ error: { code: "unavailable", message: "The service is unavailable.", reason_code: null } });
    expect(lines.some((l) => l.startsWith("health: database check failed"))).toBe(true);
  });
});
