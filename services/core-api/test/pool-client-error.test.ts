// T-096: a checked-out client whose connection breaks emits 'error'; with no listener the EventEmitter throws and
// the process dies (hosted pooler, malformed packet mid-query). The request must fail, the process and pool survive.
import type { TestDb } from "@munim/db";
import type pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPool, withContext } from "../src/lib/db.ts";
import { openDb } from "./db.ts";

let db: TestDb;
let pool: pg.Pool;

beforeAll(async () => {
  db = await openDb();
  pool = createPool(`postgresql://munim_core:${db.password}@127.0.0.1:${db.port}/${db.database}`, 2);
});
afterAll(async () => {
  await pool.end();
  await db.stop();
});

it("a connection killed mid-query fails that request only; the pool recovers", async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const mid = withContext(pool, {}, async (c) => {
      const pid = (await c.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
      // Kill our own backend from another connection while the query is in flight, and force the client-level
      // 'error' a protocol failure raises (the pooler case) on the same client.
      setTimeout(() => {
        void db.admin("SELECT pg_terminate_backend($1)", [pid]);
        c.emit("error", new Error("received invalid response: 0"));
      }, 200);
      await c.query("SELECT pg_sleep(5)");
    });
    await expect(mid).rejects.toThrow();
  } finally {
    console.warn = warn;
  }
  expect(await withContext(pool, {}, async (c) => (await c.query("SELECT 1 AS one")).rows[0])).toEqual({ one: 1 });
  expect(pool.totalCount).toBeLessThanOrEqual(2);
  expect(pool.waitingCount).toBe(0);
});
