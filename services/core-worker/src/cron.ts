// Cron registry: named jobs fired on wall-clock boundaries (every N minutes since the epoch, UTC). A job
// whose previous run is still in flight skips that boundary — never overlaps itself, never queues, never
// bursts to catch up. Each run gets the window (prev, at] since its previous run, so per-tenant local-time
// jobs (brief, nightly) see skipped boundaries too.
import { errorLabel, type Clock, type Log } from "./ports.ts";

export interface Slot {
  /** The boundary this run is for. */
  at: Date;
  /** The previous run's boundary (one period earlier on the first run). */
  prev: Date;
}

export interface Job {
  name: string;
  everyMinutes: number;
  run(slot: Slot, signal: AbortSignal): Promise<void>;
}

export class Cron {
  readonly #clock: Clock;
  readonly #log: Log;
  readonly #jobs: Job[] = [];
  readonly #timers = new Map<string, unknown>();
  readonly #inFlight = new Map<string, Promise<void>>();
  readonly #last = new Map<string, Date>();
  readonly #stopping = new AbortController();
  #stopped = false;
  readonly fired = new Map<string, number>();
  readonly skipped = new Map<string, number>();

  constructor(clock: Clock, log: Log) {
    this.#clock = clock;
    this.#log = log;
  }

  add(job: Job): this {
    if (this.#jobs.some((j) => j.name === job.name)) throw new Error(`cron: duplicate job ${job.name}`);
    if (!Number.isInteger(job.everyMinutes) || job.everyMinutes < 1) throw new Error(`cron: bad period for ${job.name}`);
    this.#jobs.push(job);
    return this;
  }

  start(): void {
    for (const job of this.#jobs) this.#schedule(job, this.#clock.now().getTime());
  }

  get jobNames(): string[] {
    return this.#jobs.map((j) => j.name);
  }

  #schedule(job: Job, from: number): void {
    const period = job.everyMinutes * 60_000;
    const at = (Math.floor(from / period) + 1) * period;
    this.#timers.set(job.name, this.#clock.setTimeout(() => this.#fire(job, at), at - this.#clock.now().getTime()));
  }

  #fire(job: Job, at: number): void {
    if (this.#stopped) return;
    // max(): a timer that fires a millisecond early must not schedule the same boundary again.
    this.#schedule(job, Math.max(at, this.#clock.now().getTime()));
    if (this.#inFlight.has(job.name)) {
      this.skipped.set(job.name, (this.skipped.get(job.name) ?? 0) + 1);
      this.#log("cron.skipped", { job: job.name, reason: "previous_run_in_flight" });
      return;
    }
    const slot = { at: new Date(at), prev: this.#last.get(job.name) ?? new Date(at - job.everyMinutes * 60_000) };
    this.#last.set(job.name, slot.at);
    this.fired.set(job.name, (this.fired.get(job.name) ?? 0) + 1);
    this.#log("cron.fired", { job: job.name, at: slot.at.toISOString() });
    const run = (async () => {
      try {
        await job.run(slot, this.#stopping.signal);
      } catch (e) {
        this.#log("cron.failed", { job: job.name, error: errorLabel(e) });
      } finally {
        this.#inFlight.delete(job.name);
      }
    })();
    this.#inFlight.set(job.name, run);
  }

  /** Stop scheduling and signal in-flight runs to wind down (they finish their current unit of work — a
   *  claimed batch, a tenant call — and start no new one); resolves when every in-flight run has ended. */
  async stop(): Promise<void> {
    this.#stopped = true;
    for (const t of this.#timers.values()) this.#clock.clearTimeout(t);
    this.#timers.clear();
    this.#stopping.abort();
    await Promise.all(this.#inFlight.values());
  }
}
