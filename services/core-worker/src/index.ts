// @munim/core-worker. The composition root (config from packages/config, Publisher + RunTokenMinter from
// T-005) calls `runUntilSignal(new Worker({...}), log)`.
export { Cron } from "./cron.ts";
export type { Job, JobResult, Slot, SlotLedger } from "./cron.ts";
export { INTEL_AUTH_HEADERS, IntelHttpError, intelHttp } from "./fanout.ts";
export { errorLabel, jsonLog, PoisonRowError, systemClock } from "./ports.ts";
export type { Clock, IntelClient, IntelPath, Log, MintRequest, OutboxRow, Publisher, RunTokenMinter } from "./ports.ts";
export type { OutletNight } from "./local-time.ts";
export { runUntilSignal } from "./process.ts";
export { POISON_ATTEMPTS, SWEEP_LOCK, sweepOutbox } from "./sweeper.ts";
export { TICK_LOCK, Worker, WORKER_ROLE } from "./worker.ts";
export type { NightlyTask, TickResult, WorkerOptions } from "./worker.ts";
