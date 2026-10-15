// What the worker needs from outside, by injection (03-architecture §0, §1.6, §1.7). T-005 implements
// Publisher and RunTokenMinter in core-api (commit/publisher-http.ts, runtoken); the composition root wires them.

/** One `core.outbox` row, as `core.outbox_claim()` returns it (db/migrations/0003). */
export interface OutboxRow {
  tenant_id: string;
  id: string;
  aggregatetype: string;
  aggregateid: string;
  type: string;
  payload: unknown;
  created_at: Date;
  published_at: Date | null;
  claimed_until: Date | null;
}

/** Encodes the row as a CloudEvent (minting its `munimrun` token) and delivers it to intel `/events`.
 *  Resolves only once intel accepted it; the worker marks `published_at` after that (at-least-once).
 *  Rejects with PoisonRowError when the stored row itself cannot be published (it fails its contract);
 *  any other rejection is a delivery failure. */
export interface Publisher {
  publish(row: OutboxRow): Promise<void>;
}

/** The row, as stored, can never become a valid event (unregistered type, data its schema refuses, an
 *  envelope that disagrees with its row). The sweeper retries it a few times — a newer core-api may have
 *  written a type this worker does not know yet — then dead-letters it and keeps sweeping the rest. */
export class PoisonRowError extends Error {
  /** A fixed reason code; never row content. */
  readonly reason: string;
  constructor(reason: string) {
    super(`outbox row cannot be published: ${reason}`);
    this.name = "PoisonRowError";
    this.reason = reason;
  }
}

// Field names follow T-005's MintInput (services/core-api/src/runtoken), so its minter plugs in with a
// one-line wrapper returning { run_id: claims.run_id, token }.
export interface MintRequest {
  tenantId: string;
  trigger: "watch_sweep" | "brief";
  /** Run-token actor (contracts RunTokenClaims): a whole-tenant sweep uses `watcher:sweep`. */
  actor: "watcher:sweep" | "brief";
  outletScope: ["*"];
}

/** Inserts the `intel.run` row and returns its Ed25519-signed compact JWT. `end` sets the run's `ended_at`
 *  (T-005 `endRun`): the fan-out ends each run once intel has returned, so its token stops verifying. */
export interface RunTokenMinter {
  mint(req: MintRequest): Promise<{ run_id: string; token: string }>;
  end?(tenantId: string, runId: string): Promise<unknown>;
}

export type IntelPath = "/watch:sweep" | "/brief";

/** core → intel calls of the fan-out (03-architecture §1.9). Rejects on any non-2xx. */
export interface IntelClient {
  call(path: IntelPath, runToken: string): Promise<void>;
}

/** Time source for the cron registry; tests inject a fake one. */
export interface Clock {
  now(): Date;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => new Date(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Structured log line. Fields are scalars only, so a token, payload or response body cannot ride along
 *  by accident — callers pass ids and labels (the project rules: traces/logs carry ids and labels, never secrets). */
export type Log = (event: string, fields?: Record<string, string | number | boolean | null>) => void;

export const jsonLog: Log = (event, fields = {}) => {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`);
};

/** A loggable label for an error: SQLSTATE, HTTP status or class name — never its message, which can carry
 *  a URL with credentials, a token, or untrusted response text. */
export function errorLabel(e: unknown): string {
  const err = e as { code?: unknown; status?: unknown; name?: unknown };
  if (typeof err?.code === "string") return err.code;
  if (typeof err?.status === "number") return `http_${err.status}`;
  return typeof err?.name === "string" ? err.name : "unknown";
}
