// Crash fixture: sweeps as munim_svc, reporting each published id to the parent over IPC; right after the
// parent has the target id (published) and before the sweeper can mark it, the process SIGKILLs itself.
import pg from "pg";
import { sweepOutbox } from "../../src/sweeper.ts";

const [connectionString, target] = process.argv.slice(2);
const pool = new pg.Pool({ connectionString, max: 3 });
const publisher = {
  publish: (row: { id: string }) =>
    new Promise<void>((resolve) => {
      process.send!({ published: row.id }, () => {
        if (row.id === target) process.kill(process.pid, "SIGKILL");
        else resolve();
      });
    }),
};
await sweepOutbox(pool, publisher as never, () => {}, { batchSize: 100, leaseSeconds: 1 });
process.send!({ done: true }, () => process.exit(0));
