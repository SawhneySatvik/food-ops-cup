// The long-running core-worker (R35; 03-architecture §0): outbox sweeper + per-tenant fan-out + nightly
// jobs on one cron registry, over one munim_svc pool. munim_svc holds no INSERT/UPDATE on any book table
// (03-architecture §1.3), so nothing this process runs can change the books; start() refuses any other role.
import pg from "pg";
import { Cron } from "./cron.ts";
import { activeTenants, fanout, forEachBounded } from "./fanout.ts";
import { outletNightsDue, tenantsDueAt, type OutletNight } from "./local-time.ts";
import { PoisonRows, sweepOutbox } from "./sweeper.ts";
import { errorLabel, jsonLog, systemClock, type Clock, type IntelClient, type Log, type Publisher, type RunTokenMinter } from "./ports.ts";

export const WORKER_ROLE = "munim_svc";

/** A per-outlet close-of-day task (none in W1; e.g. the audit-chain check lands with its owner). */
export interface NightlyTask {
  name: string;
  run(night: OutletNight, signal: AbortSignal): Promise<void>;
}

export interface WorkerOptions {
  /** Postgres connection string for the munim_svc login (from packages/config at the composition root). */
  connectionString: string;
  publisher: Publisher;
  minter: RunTokenMinter;
  intel: IntelClient;
  clock?: Clock;
  log?: Log;
  fanoutConcurrency?: number;
  /** Home-zone wall time of the tenant brief: 06:00 = the interactive fallback time (04-agent-framework §5).
   *  The nightly job has no time of its own: it runs at each outlet's business-day cutoff (ruling #60). */
  briefAt?: string;
  nightly?: NightlyTask[];
}

export class Worker {
  readonly cron: Cron;
  readonly #pool: pg.Pool;
  readonly #log: Log;

  constructor(o: WorkerOptions) {
    const log = o.log ?? jsonLog;
    const pool = new pg.Pool({ connectionString: o.connectionString, max: 4, idleTimeoutMillis: 10_000 });
    // An idle client's error (server restart) must not crash the process; the next checkout reconnects.
    pool.on("error", (e) => log("worker.pool_error", { error: errorLabel(e) }));
    // Checked-out clients need their own listener or a dropped connection kills the process (T-096).
    pool.on("connect", (c) => c.on("error", (e) => log("worker.client_error", { error: errorLabel(e) })));
    const fan = { minter: o.minter, intel: o.intel, log, concurrency: o.fanoutConcurrency ?? 4 };
    const nightly = o.nightly ?? [];
    const poison = new PoisonRows();
    this.#pool = pool;
    this.#log = log;
    this.cron = new Cron(o.clock ?? systemClock, log)
      .add({ name: "outbox-sweep", everyMinutes: 1, run: async (_slot, signal) => {
        await sweepOutbox(pool, o.publisher, log, { signal, poison });
      } })
      .add({ name: "fanout-watch", everyMinutes: 15, run: async (_slot, signal) => {
        await fanout(fan, "/watch:sweep", await activeTenants(pool), signal);
      } })
      // Every IANA offset in use is a multiple of 15 min, so a 15-min tick sees each local hh:00.
      .add({ name: "fanout-brief", everyMinutes: 15, run: async (slot, signal) => {
        const due = await tenantsDueAt(pool, await activeTenants(pool), o.briefAt ?? "06:00", slot);
        if (due.length > 0) await fanout(fan, "/brief", due, signal);
      } })
      .add({ name: "nightly", everyMinutes: 15, run: async (slot, signal) => {
        const due = await outletNightsDue(pool, await activeTenants(pool), slot);
        await forEachBounded(due, fan.concurrency, signal, async (night) => {
          for (const task of nightly) {
            try {
              await task.run(night, signal);
            } catch (e) {
              log("nightly.task_failed", { task: task.name, tenant_id: night.tenant_id, outlet_id: night.outlet_id, error: errorLabel(e) });
            }
          }
        });
      } });
  }

  async start(): Promise<void> {
    const { rows } = await this.#pool.query<{ u: string }>("SELECT current_user AS u");
    if (rows[0]?.u !== WORKER_ROLE) {
      await this.#pool.end();
      throw new Error(`core-worker must connect as ${WORKER_ROLE} (the role with no book grants), not ${rows[0]?.u}`);
    }
    this.cron.start();
    this.#log("worker.started", { jobs: this.cron.jobNames.join(",") });
  }

  /** Stop scheduling, let in-flight jobs finish their current unit of work, close the pool (releasing the
   *  sweep lock). true = finished in time. false = timed out: the pool is closed without waiting, because
   *  pg's Pool.end() waits for checked-out clients and a hung job never returns its own (measured); the
   *  caller exits, the sockets close, and the server releases the lock and the job's transaction. */
  async stop(timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const clean = await Promise.race([this.cron.stop().then(() => true as const), timedOut]);
    clearTimeout(timer);
    const ended = this.#pool.end().catch(() => {});
    if (clean) await ended;
    this.#log("worker.stopped", { clean });
    return clean;
  }
}
