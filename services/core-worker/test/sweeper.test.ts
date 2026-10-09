// Outbox sweeper gates (T-007): exactly-once across two concurrent workers, at-least-once across a crash,
// and the cluster-wide advisory lock.
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestDb } from "@munim/db";
import { publishClaimed, sweepOutbox } from "../src/sweeper.ts";
import type { OutboxRow, Publisher } from "../src/ports.ts";
import { connString, countBy, insertOutbox, makeTenant, memLog, openDb, outboxIds, unpublishedCount } from "./db.ts";

let db: TestDb;
let tenants: string[];
const pools: pg.Pool[] = [];
const svcPool = () => {
  const p = new pg.Pool({ connectionString: connString(db, "munim_svc"), max: 3 });
  pools.push(p);
  return p;
};
const recorder = (sink: string[]): Publisher => ({ publish: async (row: OutboxRow) => void sink.push(row.id) });

beforeAll(async () => {
  db = await openDb();
  tenants = [await makeTenant(db), await makeTenant(db)];
});
afterAll(async () => {
  await Promise.all(pools.map((p) => p.end()));
  await db.stop();
});
beforeEach(async () => {
  await db.admin("TRUNCATE core.outbox");
  await insertOutbox(db, tenants[0]!, 500);
  await insertOutbox(db, tenants[1]!, 500);
});

describe("outbox sweeper", () => {
  it("2 worker instances, 1,000 rows → each id published exactly once", async () => {
    const expected = await outboxIds(db);
    expect(expected).toHaveLength(1000);
    const a: string[] = [];
    const b: string[] = [];
    const log = memLog();
    const [pa, pb] = [svcPool(), svcPool()];
    const [ra, rb] = await Promise.all([
      sweepOutbox(pa, recorder(a), log, { batchSize: 50 }),
      sweepOutbox(pb, recorder(b), log, { batchSize: 50 }),
    ]);
    const all = [...a, ...b];
    console.log(`with lock: A locked=${ra.locked} published=${ra.published}; B locked=${rb.locked} published=${rb.published}; ` +
      `total publishes=${all.length}, distinct=${new Set(all).size}, unpublished left=${await unpublishedCount(db)}`);
    expect([ra.locked, rb.locked].filter(Boolean)).toHaveLength(1);
    expect(all).toHaveLength(1000);
    expect(new Set(all)).toEqual(new Set(expected));
    expect(await unpublishedCount(db)).toBe(0);
  });

  it("2 instances claiming concurrently without the lock → still each id exactly once, both publish", async () => {
    const expected = await outboxIds(db);
    const a: string[] = [];
    const b: string[] = [];
    const log = memLog();
    const [ra, rb] = await Promise.all([
      publishClaimed(svcPool(), recorder(a), log, { batchSize: 25 }),
      publishClaimed(svcPool(), recorder(b), log, { batchSize: 25 }),
    ]);
    const counts = countBy([...a, ...b]);
    const dupes = [...counts.values()].filter((n) => n > 1).length;
    console.log(`no lock: A published=${ra.published}, B published=${rb.published}, distinct=${counts.size}, duplicated ids=${dupes}`);
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
    expect(a.length + b.length).toBe(1000);
    expect(dupes).toBe(0);
    expect(new Set(counts.keys())).toEqual(new Set(expected));
  });

  it("advisory lock: a second sweeper skips while the first holds it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let firstStarted!: () => void;
    const started = new Promise<void>((r) => (firstStarted = r));
    const a: string[] = [];
    const b: string[] = [];
    const blocking: Publisher = {
      publish: async (row) => {
        if (a.length === 0) {
          firstStarted();
          await gate;
        }
        a.push(row.id);
      },
    };
    const log = memLog();
    const first = sweepOutbox(svcPool(), blocking, log, { batchSize: 100 });
    await started;
    const second = await sweepOutbox(svcPool(), recorder(b), log, { batchSize: 100 });
    console.log(`while held: second locked=${second.locked} published=${second.published}`);
    expect(second).toEqual({ locked: false, published: 0, publishFailed: false });
    expect(log.lines.filter((l) => l.event === "outbox-sweep.skipped")).toHaveLength(1);
    release();
    const done = await first;
    expect(done).toEqual({ locked: true, published: 1000, publishFailed: false });
    // Once released, a later sweeper takes the lock (and finds nothing left).
    expect((await sweepOutbox(svcPool(), recorder(b), log)).locked).toBe(true);
    expect(b).toHaveLength(0);
  });

  it("lock connection killed mid-sweep → logged, no uncaught error, the sweep still publishes every row", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let firstStarted!: () => void;
    const started = new Promise<void>((r) => (firstStarted = r));
    const out: string[] = [];
    const publisher: Publisher = {
      publish: async (row) => {
        if (out.length === 0) {
          firstStarted();
          await gate;
        }
        out.push(row.id);
      },
    };
    const log = memLog();
    const sweep = sweepOutbox(svcPool(), publisher, log, { batchSize: 100 });
    await started;
    let killed: number;
    try {
      // Scoped to this file's clone: other test files hold advisory locks in their own databases.
      const { rows } = await db.admin<{ n: number }>(
        `SELECT count(pg_terminate_backend(l.pid))::int AS n FROM pg_locks l
          WHERE l.locktype = 'advisory' AND l.granted AND l.database = (SELECT oid FROM pg_database WHERE datname = $1)`,
        [db.database]);
      killed = rows[0]!.n;
      await new Promise((r) => setTimeout(r, 200)); // let the client see the termination
    } finally {
      release();
    }
    expect(killed).toBe(1);
    const result = await sweep;
    console.log(`lock backend terminated: result=${JSON.stringify(result)}, logged=${log.lines.filter((l) => l.event === "outbox-sweep.lock_connection_lost").length}`);
    expect(result).toEqual({ locked: true, published: 1000, publishFailed: false });
    expect(log.lines.filter((l) => l.event === "outbox-sweep.lock_connection_lost").length).toBeGreaterThanOrEqual(1);
    expect(await unpublishedCount(db)).toBe(0);
  });

  it("crash after publish, before marking → that id twice, every other id once", async () => {
    const expected = await outboxIds(db);
    const target = expected[42]!;
    const published: string[] = [];
    const child = fork(fileURLToPath(new URL("./fixtures/crash-child.ts", import.meta.url)),
      [connString(db, "munim_svc"), target], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
    child.on("message", (m: { published?: string }) => {
      if (m.published) published.push(m.published);
    });
    const exit = await new Promise<{ code: number | null; signal: string | null }>((r) =>
      child.on("exit", (code, signal) => r({ code, signal })));
    expect(exit.signal).toBe("SIGKILL");
    expect(published).toHaveLength(43);
    expect(published.at(-1)).toBe(target);
    const { rows } = await db.admin<{ marked: boolean }>("SELECT published_at IS NOT NULL AS marked FROM core.outbox WHERE id = $1", [target]);
    expect(rows[0]!.marked).toBe(false);

    // A fresh worker after the 1 s lease: retries until it gets the lock the dead backend held.
    await new Promise((r) => setTimeout(r, 1200));
    const pool = svcPool();
    const log = memLog();
    for (let i = 0; i < 50 && (await unpublishedCount(db)) > 0; i++) {
      const r = await sweepOutbox(pool, recorder(published), log, { batchSize: 100 });
      if (!r.locked) await new Promise((res) => setTimeout(res, 100));
    }
    const counts = countBy(published);
    const twice = [...counts].filter(([, n]) => n === 2).map(([id]) => id);
    const once = [...counts.values()].filter((n) => n === 1).length;
    console.log(`after crash + resweep: publishes=${published.length}, ids published twice=${twice.length} (target=${twice[0] === target}), ids once=${once}`);
    expect(twice).toEqual([target]);
    expect(once).toBe(999);
    expect(new Set(counts.keys())).toEqual(new Set(expected));
    expect(await unpublishedCount(db)).toBe(0);
  });
});
