// Outbox sweeper (03-architecture §1.6, §9): publishes rows the in-request publisher missed. Delivery is
// at least once — a row is marked only after the Publisher resolved, so a crash between the two re-sends
// it after its lease expires; intel dedupes through `events:claim`.
import type pg from "pg";
import { errorLabel, PoisonRowError, type Log, type OutboxRow, type Publisher } from "./ports.ts";

export const SWEEP_LOCK = "core-worker:outbox-sweep";
/** A poison row is dead-lettered (core.outbox.dead_at) at its POISON_ATTEMPTS-th failed publish. */
export const POISON_ATTEMPTS = 5;

export interface SweepOptions {
  batchSize?: number;
  /** Rows younger than this are left to the request that wrote them. */
  minAgeSeconds?: number;
  /** How long a claimed row stays invisible to other sweepers. */
  leaseSeconds?: number;
  /** Checked between batches: a stopping worker finishes the batch it claimed, then returns. */
  signal?: AbortSignal;
}

export interface SweepResult {
  locked: boolean;
  published: number;
  /** The publisher refused a row; the sweep stopped and the remaining rows retry after their lease. */
  publishFailed: boolean;
}

/** One sweep, only if no other sweeper in the cluster holds the lock. The lock is transaction-scoped on a
 *  connection held for the whole sweep: correct behind a transaction-mode pooler (project gotcha 2) and
 *  released by the server if this process dies. */
export async function sweepOutbox(pool: pg.Pool, publisher: Publisher, log: Log, opts: SweepOptions = {}): Promise<SweepResult> {
  const lock = await pool.connect();
  let broken = false;
  // The lock connection sits idle in its transaction while rows publish. A checked-out pg client that loses
  // its connection then emits 'error' with no listener — an uncaught exception that kills the worker. The
  // server has released the lock by then; the sweep's own claims and marks carry on (leases keep it safe).
  const onError = (e: Error) => {
    broken = true;
    log("outbox-sweep.lock_connection_lost", { error: errorLabel(e) });
  };
  lock.on("error", onError);
  try {
    await lock.query("BEGIN");
    const { rows } = await lock.query<{ got: boolean }>(
      "SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)) AS got", [SWEEP_LOCK]);
    if (!rows[0]?.got) {
      log("outbox-sweep.skipped", { reason: "lock_held" });
      return { locked: false, published: 0, publishFailed: false };
    }
    return { locked: true, ...(await publishClaimed(pool, publisher, log, opts)) };
  } finally {
    try {
      if (!broken) await lock.query("ROLLBACK");
    } catch {
      broken = true;
    }
    lock.off("error", onError);
    lock.release(broken);
  }
}

/** Claim → publish → mark, batch after batch, until no claimable row is left. Safe to run concurrently
 *  without the lock: `core.outbox_claim` leases rows with FOR UPDATE SKIP LOCKED. */
export async function publishClaimed(
  pool: pg.Pool,
  publisher: Publisher,
  log: Log,
  opts: SweepOptions = {},
): Promise<Omit<SweepResult, "locked">> {
  const batch = opts.batchSize ?? 100;
  let published = 0;
  while (!opts.signal?.aborted) {
    const { rows } = await pool.query<OutboxRow>(
      "SELECT * FROM core.outbox_claim($1, make_interval(secs => $2), make_interval(secs => $3))",
      [batch, opts.minAgeSeconds ?? 30, opts.leaseSeconds ?? 120]);
    for (const row of rows) {
      try {
        await publisher.publish(row);
      } catch (e) {
        if (e instanceof PoisonRowError) {
          // The row is the problem, not intel: count it and keep sweeping the others.
          const attempts = await recordPoison(pool, row);
          log(attempts >= POISON_ATTEMPTS ? "outbox-sweep.dead_lettered" : "outbox-sweep.poison_row",
            { tenant_id: row.tenant_id, outbox_id: row.id, attempts, reason: e.reason });
          continue;
        }
        log("outbox-sweep.publish_failed", { tenant_id: row.tenant_id, outbox_id: row.id, error: errorLabel(e) });
        return { published, publishFailed: true };
      }
      await markPublished(pool, row);
      published++;
    }
    if (rows.length < batch) break;
  }
  if (published > 0) log("outbox-sweep.published", { count: published });
  return { published, publishFailed: false };
}

/** munim_svc may UPDATE only `published_at`, `publish_attempts` and `dead_at`, and only under the row's tenant (FORCE RLS
 *  on core.outbox). */
async function markPublished(pool: pg.Pool, row: OutboxRow): Promise<void> {
  await inTenant(pool, row.tenant_id, (c) =>
    c.query("UPDATE core.outbox SET published_at = now() WHERE tenant_id = $1 AND id = $2 AND published_at IS NULL", [row.tenant_id, row.id]));
}

/** One failed publish of a poison row, counted on the row itself, so every worker process and every tick instance adds to the
 *  same count (in memory, each serverless instance started from zero and the row never died). At POISON_ATTEMPTS the row gets
 *  dead_at and outbox_claim never returns it again. Returns the new count (0: published or dead-lettered meanwhile). */
async function recordPoison(pool: pg.Pool, row: OutboxRow): Promise<number> {
  const { rows } = await inTenant(pool, row.tenant_id, (c) => c.query<{ n: number }>(
    `UPDATE core.outbox SET publish_attempts = publish_attempts + 1,
            dead_at = CASE WHEN publish_attempts + 1 >= $3 THEN now() END
      WHERE tenant_id = $1 AND id = $2 AND published_at IS NULL AND dead_at IS NULL
      RETURNING publish_attempts AS n`, [row.tenant_id, row.id, POISON_ATTEMPTS]));
  return rows[0]?.n ?? 0;
}

async function inTenant<T>(pool: pg.Pool, tenantId: string, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT set_config('app.tenant_id', $1, true), set_config('app.role', 'service', true)", [tenantId]);
    const out = await fn(c);
    await c.query("COMMIT");
    c.release();
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    c.release(true);
    throw e;
  }
}
