// Shutdown fixture: the real process entry (runUntilSignal + Worker) on a clock shifted to 300 ms before a
// minute boundary, so the outbox sweep starts at once. Each publish takes 20 ms and prints start/done.
import { runUntilSignal } from "../../src/process.ts";
import { jsonLog, type Clock } from "../../src/ports.ts";
import { Worker } from "../../src/worker.ts";

const [connectionString] = process.argv.slice(2);
const now = Date.now();
const offset = Math.floor(now / 900_000) * 900_000 + 60_000 - 300 - now;
const clock: Clock = {
  now: () => new Date(Date.now() + offset),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};
const worker = new Worker({
  connectionString: connectionString!,
  clock,
  publisher: {
    publish: async (row) => {
      process.stdout.write(`publish:start ${row.id}\n`);
      await new Promise((r) => setTimeout(r, 20));
      process.stdout.write(`publish:done ${row.id}\n`);
    },
  },
  minter: { mint: async () => ({ run_id: "unused", token: "unused" }) },
  intel: { call: async () => {} },
});
await runUntilSignal(worker, jsonLog, 10_000);
