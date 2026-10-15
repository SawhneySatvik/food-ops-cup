// The long-running core-worker (R35; 03-architecture §0): outbox sweeper + per-tenant fan-out + nightly
// jobs on one cron registry, over one munim_svc pool. munim_svc holds no INSERT/UPDATE on any book table
// (03-architecture §1.3), so nothing this process runs can change the books; start() refuses any other role.
import pg from "pg";
import { Cron, type JobResult, type SlotLedger } from "./cron.ts";
import { activeTenants, fanout, forEachBounded } from "./fanout.ts";
import { outletNightsDue, tenantsDueAt, type OutletNight } from "./local-time.ts";
import { sweepOutbox } from "./sweeper.ts";
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

export const TICK_LOCK = "core-worker:tick";

export interface TickResult {
  /** false: another tick holds the cluster-wide lock; nothing ran. */
  ran: boolean;
  /** The slot: (prev, at]. A job whose last claimed slot is later than prev saw (that slot, at] instead (Cron.runOnce). */
  prev: string;
  at: string;
  /** "already-ran": an earlier call for this slot claimed the job (core.tick_claim), so it did not run again. */
  jobs: Record<string, JobResult>;
}

export class Worker {
  readonly cron: Cron;
  readonly #pool: pg.Pool;
  readonly #log: Log;
  readonly #connectionString: string;

  constructor(o: WorkerOptions) {
    const log = o.log ?? jsonLog;
    const pool = new pg.Pool({ connectionString: o.connectionString, max: 4, idleTimeoutMillis: 10_000 });
    // An idle client's error (server restart) must not crash the process; the next checkout reconnects.
    pool.on("error", (e) => log("worker.pool_error", { error: errorLabel(e) }));
    // Checked-out clients need their own listener or a dropped connection kills the process (T-096).
    pool.on("connect", (c) => c.on("error", (e) => log("worker.client_error", { error: errorLabel(e) })));
    const fan = { minter: o.minter, intel: o.intel, log, concurrency: o.fanoutConcurrency ?? 4 };
    const nightly = o.nightly ?? [];
    this.#pool = pool;
    this.#log = log;
    this.#connectionString = o.connectionString;
    this.cron = new Cron(o.clock ?? systemClock, log)
      .add({ name: "outbox-sweep", everyMinutes: 1, run: async (_slot, signal) => {
        await sweepOutbox(pool, o.publisher, log, { signal });
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
    await this.#checkRole();
    this.cron.start();
    this.#log("worker.started", { jobs: this.cron.jobNames.join(",") });
  }

  #roleChecked = false;
  async #checkRole(): Promise<void> {
    if (this.#roleChecked) return;
    const { rows } = await this.#pool.query<{ u: string }>("SELECT current_user AS u");
    if (rows[0]?.u !== WORKER_ROLE) {
      await this.#pool.end();
      throw new Error(`core-worker must connect as ${WORKER_ROLE} (the role with no book grants), not ${rows[0]?.u}`);
    }
    this.#roleChecked = true;
  }

  /** One pass of every job, for a host without a long-running worker (core-api's tick route). The slot is
   *  aligned, so a scheduler that fires anywhere inside its hour sees the same window as its neighbours and
   *  consecutive ticks tile time: `at` = now floored to min(period, 60) minutes, `prev` = at − period (a daily
   *  tick at 01:xx UTC covers (yesterday 01:00, today 01:00], so 06:00 IST and every outlet cutoff fall in exactly
   *  one window). One tick at a time cluster-wide: a transaction-scoped advisory lock on its own connection, outside
   *  the pool, so the jobs keep all of the pool (the sweeper alone holds two at once). After `budgetMs` the running job
   *  finishes its unit of work and the rest do not start.
   *  Each job claims (job, slot) in core.tick_claim just before it starts, so a retried or repeated call for the same
   *  slot (a scheduler retry, a manual call) runs nothing twice — the brief is posted once; a call in a later hour is a new
   *  slot whose window, per job, starts at that job's last claimed slot (Cron.runOnce), so it is not posted again either.
   *  The claim commits on its own pool connection, not in the lock transaction (which never commits, and whose commit
   *  would release the lock): a tick killed mid-job keeps its claims, so a job runs at most once per slot. */
  async tick(now: Date, o: { periodMinutes: number; budgetMs: number }): Promise<TickResult> {
    const period = o.periodMinutes * 60_000;
    const align = Math.min(period, 60 * 60_000);
    const at = new Date(Math.floor(now.getTime() / align) * align);
    const prev = new Date(at.getTime() - period);
    const slot = { prev: prev.toISOString(), at: at.toISOString() };
    await this.#checkRole();
    const lock = new pg.Client({ connectionString: this.#connectionString });
    // A lost lock connection must not crash the process; the server has released the lock by then.
    lock.on("error", () => {});
    await lock.connect();
    try {
      await lock.query("BEGIN");
      const { rows } = await lock.query<{ got: boolean }>("SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS got", [TICK_LOCK]);
      if (!rows[0]?.got) {
        this.#log("worker.tick_skipped", { reason: "lock_held" });
        return { ran: false, ...slot, jobs: {} };
      }
      const jobs = await this.cron.runOnce({ at, prev }, AbortSignal.timeout(o.budgetMs), this.#ledger);
      this.#log("worker.tick", { ...slot, ...jobs });
      return { ran: true, ...slot, jobs };
    } finally {
      await lock.end().catch(() => {});
    }
  }

  readonly #ledger: SlotLedger = {
    claim: async (job, slotAt) => {
      const { rows } = await this.#pool.query<{ claimed: boolean; last: Date | null }>(
        `WITH claim AS (INSERT INTO core.tick_claim (job, slot_at) VALUES ($1, $2) ON CONFLICT (job, slot_at) DO NOTHING RETURNING job)
         SELECT EXISTS (SELECT 1 FROM claim) AS claimed, (SELECT max(slot_at) FROM core.tick_claim WHERE job = $1 AND slot_at < $2) AS last`,
        [job, slotAt]);
      return rows[0]!.claimed ? { last: rows[0]!.last } : null;
    },
    finish: async (job, slotAt, outcome) => {
      await this.#pool.query("UPDATE core.tick_claim SET finished_at = now(), outcome = $3 WHERE job = $1 AND slot_at = $2 AND finished_at IS NULL",
        [job, slotAt, outcome]);
    },
  };

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
