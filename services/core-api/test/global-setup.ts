// One embedded Postgres cluster for the whole run (BOARD standing rule: no Docker, no .env). Each test file
// attaches to a private clone of its migrated, pack-seeded database (test/db.ts). The exit-code fix for
// embedded-postgres' exit hook lives in the @munim/db harness (W1 fix #73).
import { startTestDb, type TestDb } from "@munim/db";
import type { TestProject } from "vitest/node";

let db: TestDb | undefined;

export default async function setup(project: TestProject) {
  db = await startTestDb();
  project.provide("munimDb", { port: db.port, password: db.password, database: db.database, migration: db.migration, packs: db.packs });
  return async () => {
    await db?.stop();
  };
}
