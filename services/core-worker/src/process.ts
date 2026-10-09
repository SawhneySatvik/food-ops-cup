// Process lifecycle: start the worker, and on SIGTERM/SIGINT stop scheduling, let the in-flight job
// finish, close the pool, exit 0 — or exit 1 if that takes longer than the timeout or a second signal comes.
import type { Log } from "./ports.ts";
import type { Worker } from "./worker.ts";

export async function runUntilSignal(worker: Worker, log: Log, timeoutMs = 30_000): Promise<void> {
  let stopping = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (stopping) {
      log("worker.forced_exit", { signal });
      process.exit(1);
    }
    stopping = true;
    log("worker.stopping", { signal });
    // Backstop: whatever stop() is waiting on, the process is gone shortly after the timeout.
    setTimeout(() => process.exit(1), timeoutMs + 5_000).unref();
    worker.stop(timeoutMs).then(
      (clean) => process.exit(clean ? 0 : 1),
      () => process.exit(1),
    );
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  await worker.start();
}
