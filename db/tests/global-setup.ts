// Starts one embedded cluster for the whole vitest run, migrates + seeds its template database, and hands
// the connection info to test files (each clones the template via tests/db.ts). Stopped on teardown.
import type { TestProject } from "vitest/node";
import { startTestDb, type TestDb } from "../src/harness.ts";

let db: TestDb | undefined;

export default async function setup(project: TestProject) {
  const lines: string[] = [];
  db = await startTestDb({ log: (l) => lines.push(l) });
  for (const l of lines) console.log(l);
  project.provide("munimDb", {
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
