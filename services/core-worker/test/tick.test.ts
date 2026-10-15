// T-117 gates: an idempotent tick. Worker.tick claims (job, slot) in core.tick_claim before each job starts.
//   lock    two concurrent ticks in one slot (two Worker instances, overlap forced by a latch, not by timing): one runs every
//           job, the other reports ran:false, runs nothing and claims nothing
//   replay  a second tick for the same slot, from another Worker instance: every job "already-ran", intel's /brief is not called
//           again, and an outbox row aged in between stays unpublished; the next slot runs everything again (brief + that row)
//   unstarted  a job that never started (budget spent) is not claimed: a retry in the same slot runs it, and only it
//   later   a manual call two hours after the scheduled tick is a new slot, but each job's window starts at its last claimed
//           slot, so the brief (06:00 IST, inside the earlier window) is not posted again; the next day's tick posts it
// Red-proofs: services/core-worker/test/redproof-t117.sh.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestDb } from "@munim/db";
import type { IntelPath } from "../src/ports.ts";
import { Worker } from "../src/worker.ts";
import { connString, makeTenant, memLog, openDb } from "./db.ts";

let db: TestDb;
const intelCalls: IntelPath[] = [];
const published: string[] = [];
const workers: Worker[] = [];
const BASE = { "outbox-sweep": "ok", "fanout-watch": "ok", "fanout-brief": "ok", nightly: "ok" };

beforeAll(async () => {
  db = await openDb();
  await makeTenant(db, ["Asia/Kolkata"]); // 06:00 IST falls in every daily window: the brief is due in each slot
});
afterAll(async () => {
  for (const w of workers) await w.stop(1_000);
  await db.stop();
});

function worker(): Worker {
  const w = new Worker({
    connectionString: connString(db, "munim_svc"), log: memLog(),
    publisher: { publish: async (row) => void published.push(row.id) },
    minter: { mint: async () => ({ run_id: randomUUID(), token: "t" }), end: async () => {} },
    intel: { call: async (path) => void intelCalls.push(path) },
  });
  workers.push(w);
  return w;
}

const briefs = () => intelCalls.filter((p) => p === "/brief").length;
const claims = async (slot: string) => (await db.admin<{ job: string; outcome: string | null }>(
  "SELECT job, outcome FROM core.tick_claim WHERE slot_at = $1 ORDER BY job", [slot])).rows;
const agedOutboxRow = async (): Promise<string> => {
  const id = randomUUID();
  const { rows } = await db.admin<{ t: string }>("SELECT tenant_id::text t FROM core.tenant LIMIT 1");
  await db.withContext("munim_svc", { tenant_id: rows[0]!.t, role: "service" }, (c) => c.query(
    `INSERT INTO core.outbox (tenant_id, id, aggregatetype, aggregateid, type, payload, created_at)
     VALUES ($1, $2, 'order', 'x', 'munim.orders.order.placed.v1', '{}'::jsonb, now() - interval '5 minutes')`, [rows[0]!.t, id]));
  return id;
};
const DAILY = { periodMinutes: 1440, budgetMs: 30_000 };

describe("tick ledger", () => {
  it("replay: a second tick in the same slot runs nothing (no second brief, an aged outbox row left alone); the next slot runs all", async () => {
    const first = await worker().tick(new Date("2026-10-15T01:20:00Z"), DAILY);
    const briefsAfterFirst = briefs();
    const row = await agedOutboxRow();
    const again = await worker().tick(new Date("2026-10-15T01:55:00Z"), DAILY); // another instance, same aligned slot
    const briefsAfterReplay = briefs();
    const unpublishedAfterReplay = !published.includes(row);
    const next = await worker().tick(new Date("2026-10-16T01:20:00Z"), DAILY);
    console.log(`replay: first ${JSON.stringify(first)}; briefs ${briefsAfterFirst}\n  again ${JSON.stringify(again)}; briefs ${briefsAfterReplay}, `
      + `aged row unpublished ${unpublishedAfterReplay}\n  next ${JSON.stringify(next.jobs)}; briefs ${briefs()}, aged row published ${published.includes(row)}`);
    expect(first).toMatchObject({ ran: true, at: "2026-10-15T01:00:00.000Z", jobs: BASE });
    expect(briefsAfterFirst).toBe(1);
    expect(again).toMatchObject({ ran: true, at: "2026-10-15T01:00:00.000Z",
      jobs: { "outbox-sweep": "already-ran", "fanout-watch": "already-ran", "fanout-brief": "already-ran", nightly: "already-ran" } });
    expect(briefsAfterReplay).toBe(1);
    expect(unpublishedAfterReplay).toBe(true);
    expect(next).toMatchObject({ ran: true, at: "2026-10-16T01:00:00.000Z", jobs: BASE });
    expect(briefs()).toBe(2);
    expect(published).toContain(row);
    expect(await claims("2026-10-15T01:00:00Z")).toEqual(
      ["fanout-brief", "fanout-watch", "nightly", "outbox-sweep"].map((job) => ({ job, outcome: "ok" })));
  });

  it("lock: two concurrent ticks in one slot — one runs every job, the other reports ran:false and claims nothing", async () => {
    const [w1, w2] = [worker(), worker()];
    let entered!: () => void;
    let release!: () => void;
    const inLatch = new Promise<void>((r) => (entered = r));
    const released = new Promise<void>((r) => (release = r));
    w1.cron.add({ name: "latch", everyMinutes: 1440, run: async () => {
      entered();
      await released;
    } });
    const now = new Date("2026-10-20T03:10:00Z");
    const running = w1.tick(now, DAILY);
    await inLatch; // w1 holds the tick lock and is inside its last job
    const second = await w2.tick(now, DAILY);
    release();
    const first = await running;
    console.log(`lock: first ${JSON.stringify(first.jobs)}; second ${JSON.stringify(second)}`);
    expect(second).toEqual({ ran: false, prev: "2026-10-19T03:00:00.000Z", at: "2026-10-20T03:00:00.000Z", jobs: {} });
    expect(first).toMatchObject({ ran: true, jobs: { ...BASE, latch: "ok" } });
    expect((await claims("2026-10-20T03:00:00Z")).map((c) => c.job)).toEqual(["fanout-brief", "fanout-watch", "latch", "nightly", "outbox-sweep"]);
  });

  it("unstarted: a job the budget stopped before it started is not claimed, so a retry in the slot runs it and only it", async () => {
    const make = (ran: string[]) => {
      const w = worker();
      w.cron.add({ name: "slow", everyMinutes: 1440, run: (_s, signal) => new Promise<void>((r) => signal.addEventListener("abort", () => r())) })
        .add({ name: "after", everyMinutes: 1440, run: async () => void ran.push("after") });
      return w;
    };
    const ranFirst: string[] = [];
    const ranRetry: string[] = [];
    const now = new Date("2026-10-25T05:30:00Z");
    const first = await make(ranFirst).tick(now, { periodMinutes: 1440, budgetMs: 5_000 }); // room for the four DB-backed jobs
    const retry = await make(ranRetry).tick(now, DAILY);
    console.log(`unstarted: first ${JSON.stringify(first.jobs)}; retry ${JSON.stringify(retry.jobs)}`);
    expect(first.jobs).toEqual({ ...BASE, slow: "aborted", after: "aborted" });
    expect(ranFirst).toEqual([]);
    expect(retry.jobs).toEqual({ "outbox-sweep": "already-ran", "fanout-watch": "already-ran", "fanout-brief": "already-ran", nightly: "already-ran",
      slow: "already-ran", after: "ok" });
    expect(ranRetry).toEqual(["after"]);
    expect(await claims("2026-10-25T05:00:00Z")).toEqual([
      { job: "after", outcome: "ok" }, { job: "fanout-brief", outcome: "ok" }, { job: "fanout-watch", outcome: "ok" }, { job: "nightly", outcome: "ok" },
      { job: "outbox-sweep", outcome: "ok" }, { job: "slow", outcome: "aborted" }]);
  });

  it("later: a manual call two hours after the scheduled tick runs every job, but its window starts where the last ended (no second brief)", async () => {
    const start = briefs();
    const scheduled = await worker().tick(new Date("2026-10-28T01:20:00Z"), DAILY);
    const afterScheduled = briefs();
    const manual = await worker().tick(new Date("2026-10-28T03:15:00Z"), DAILY);
    const afterManual = briefs();
    const nextDay = await worker().tick(new Date("2026-10-29T01:20:00Z"), DAILY);
    console.log(`later: scheduled ${JSON.stringify(scheduled.jobs)} briefs +${afterScheduled - start}; manual ${JSON.stringify(manual)} briefs +${afterManual - afterScheduled}; `
      + `next day briefs +${briefs() - afterManual}`);
    expect([scheduled.jobs, manual.jobs, nextDay.jobs]).toEqual([BASE, BASE, BASE]);
    expect(manual).toMatchObject({ prev: "2026-10-27T03:00:00.000Z", at: "2026-10-28T03:00:00.000Z" }); // nominal; the brief's window was (01:00, 03:00]
    expect([afterScheduled - start, afterManual - afterScheduled, briefs() - afterManual]).toEqual([1, 0, 1]);
  });
});
