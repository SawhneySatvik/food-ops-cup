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

export type JobResult = "ok" | "failed" | "aborted" | "skipped" | "already-ran";

/** Which job has run for which slot, kept outside the process (Worker: core.tick_claim). `claim` answers null when the
 *  (job, slot) was claimed before, else the newest earlier slot the job was claimed for (null if none); `finish` records how
 *  the claimed run ended. */
export interface SlotLedger {
  claim(job: string, slotAt: Date): Promise<{ last: Date | null } | null>;
  finish(job: string, slotAt: Date, outcome: "ok" | "failed" | "aborted"): Promise<void>;
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

  /** Every job once, in registration order, for one given slot: what a scheduler that calls over HTTP (the tick
   *  route) gets instead of the timers. A job still in flight from the timers is skipped; once `signal` aborts,
   *  the running job finishes its current unit of work and the rest are reported "aborted" without starting.
   *  With a ledger, a job runs only if this pass is the first to claim (job, slot.at); a repeated call for the same
   *  slot reports it "already-ran". Only a job that starts is claimed, so one skipped or aborted before it started
   *  still runs on a retry. A claim that cannot be made (the database is down) runs nothing and reports "failed".
   *  Windows tile across calls: when the job's last claimed slot is later than slot.prev (a manual call a few hours
   *  after the scheduled one), its window starts there, so what fell in the last window (a 06:00 brief) is not due again. */
  async runOnce(slot: Slot, signal: AbortSignal, ledger?: SlotLedger): Promise<Record<string, JobResult>> {
    const out: Record<string, JobResult> = {};
    for (const job of this.#jobs) {
      if (signal.aborted) {
        out[job.name] = "aborted";
        continue;
      }
      if (this.#inFlight.has(job.name)) {
        out[job.name] = "skipped";
        continue;
      }
      let window = slot;
      if (ledger) {
        let claim: { last: Date | null } | null;
        try {
          claim = await ledger.claim(job.name, slot.at);
        } catch (e) {
          this.#log("cron.claim_failed", { job: job.name, error: errorLabel(e) });
          out[job.name] = "failed";
          continue;
        }
        if (!claim) {
          this.#log("cron.already_ran", { job: job.name, at: slot.at.toISOString() });
          out[job.name] = "already-ran";
          continue;
        }
        if (claim.last && claim.last > slot.prev) window = { at: slot.at, prev: claim.last };
      }
      this.fired.set(job.name, (this.fired.get(job.name) ?? 0) + 1);
      this.#log("cron.fired", { job: job.name, at: slot.at.toISOString() });
      let result: "ok" | "failed" | "aborted";
      try {
        await job.run(window, signal);
        result = signal.aborted ? "aborted" : "ok";
      } catch (e) {
        this.#log("cron.failed", { job: job.name, error: errorLabel(e) });
        result = "failed";
      }
      out[job.name] = result;
      // The claim stands either way; a lost outcome only leaves finished_at empty.
      await ledger?.finish(job.name, slot.at, result).catch((e: unknown) => this.#log("cron.finish_failed", { job: job.name, error: errorLabel(e) }));
    }
    return out;
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
