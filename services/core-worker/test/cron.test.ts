// Cron registry gates (T-007) on a fake clock: a 1-minute job fires exactly N times in N minutes; a job
// slower than its period never overlaps itself; stop() waits for the in-flight run.
import { describe, expect, it } from "vitest";
import { Cron } from "../src/cron.ts";
import { FakeClock } from "./fake-clock.ts";
import { memLog } from "./db.ts";

describe("cron registry", () => {
  for (const n of [1, 7, 60]) {
    it(`a job every minute fires exactly ${n} times across ${n} minutes`, async () => {
      const clock = new FakeClock("2026-10-10T00:00:30Z");
      const slots: string[] = [];
      const cron = new Cron(clock, memLog()).add({ name: "test", everyMinutes: 1, run: async (s) => void slots.push(`${s.prev.toISOString()}→${s.at.toISOString()}`) });
      cron.start();
      await clock.advance(n * 60_000);
      await cron.stop();
      console.log(`N=${n}: fired=${slots.length}, first=${slots[0]}, last=${slots.at(-1)}`);
      expect(slots).toHaveLength(n);
      expect(cron.fired.get("test")).toBe(n);
      // Consecutive windows tile time: each run's prev is the previous run's at.
      for (let i = 1; i < slots.length; i++) expect(slots[i]!.split("→")[0]).toBe(slots[i - 1]!.split("→")[1]);
    });
  }

  it("a job slower than its period never overlaps itself (skips, does not queue)", async () => {
    const clock = new FakeClock("2026-10-10T00:00:30Z");
    let running = 0;
    let maxRunning = 0;
    let completed = 0;
    const log = memLog();
    const cron = new Cron(clock, log).add({
      name: "slow", everyMinutes: 1, run: async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await clock.sleep(150_000);
        running--;
        completed++;
      },
    });
    cron.start();
    await clock.advance(10 * 60_000);
    const fired = cron.fired.get("slow") ?? 0;
    const skipped = cron.skipped.get("slow") ?? 0;
    console.log(`slow job over 10 boundaries: fired=${fired}, skipped=${skipped}, max concurrent=${maxRunning}`);
    expect(maxRunning).toBe(1);
    expect(fired).toBe(4); // 00:01, 00:04, 00:07, 00:10 — each run spans the next two boundaries
    expect(skipped).toBe(6);
    expect(log.lines.filter((l) => l.event === "cron.skipped")).toHaveLength(6);
    // stop(): no new runs, but the in-flight one (started 00:10) completes.
    const stopped = cron.stop();
    await clock.advance(150_000);
    await stopped;
    expect(completed).toBe(4);
    expect(cron.fired.get("slow")).toBe(4);
  });

  it("a failing run is logged by label and the job keeps its schedule", async () => {
    const clock = new FakeClock("2026-10-10T00:00:00Z");
    const log = memLog();
    let calls = 0;
    const cron = new Cron(clock, log).add({ name: "boom", everyMinutes: 1, run: async () => {
      calls++;
      throw Object.assign(new Error("secret-bearing message"), { code: "XX000" });
    } });
    cron.start();
    await clock.advance(3 * 60_000);
    await cron.stop();
    expect(calls).toBe(3);
    expect(log.lines.filter((l) => l.event === "cron.failed").map((l) => l.fields.error)).toEqual(["XX000", "XX000", "XX000"]);
    expect(log.text()).not.toContain("secret-bearing");
  });

  it("stop() stops scheduling: no run fires after it", async () => {
    const clock = new FakeClock("2026-10-10T00:00:30Z");
    const cron = new Cron(clock, memLog()).add({ name: "quick", everyMinutes: 1, run: async () => {} });
    cron.start();
    await clock.advance(2 * 60_000);
    expect(cron.fired.get("quick")).toBe(2);
    await cron.stop();
    await clock.advance(5 * 60_000);
    console.log(`after stop: fired=${cron.fired.get("quick")} (2 before stop, 5 more minutes advanced)`);
    expect(cron.fired.get("quick")).toBe(2);
  });
});
