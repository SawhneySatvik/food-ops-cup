// One embedded Postgres cluster for the whole run (BOARD standing rule: DB gates on embedded PG via the
// @munim/db harness), migrated + pack-seeded once; each test file clones it (test/db.ts).
import type { TestProject } from "vitest/node";
import { startTestDb, type TestDb } from "@munim/db";

let db: TestDb | undefined;

export default async function setup(project: TestProject) {
  db = await startTestDb();
  project.provide("workerDb", {
    port: db.port,
    password: db.password,
    database: db.database,
    migration: db.migration,
    packs: db.packs,
  });
  return async () => {
    await db?.stop();
  };
}
