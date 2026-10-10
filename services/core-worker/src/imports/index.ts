// Import parsing job (T-030; 03-architecture §0: core-worker runs import parsing into staging). Logs in as
// munim_svc — no book grants — so parsing can stage, quarantine and draft, never commit. For each active
// tenant, each run still `parsing` is parsed in its own transaction (`parseRun` in core-api's imports module);
// `FOR UPDATE … SKIP LOCKED` there lets two workers share the queue without parsing a run twice.
// Wiring: composeWorker (main.ts) adds `importParseJob(...)` to the Worker's cron registry (W2 B3).
import type pg from "pg";
import { withContext } from "../../../core-api/src/lib/db.ts";
import { type BlobStore, parseRun } from "../../../core-api/src/modules/imports/index.ts";
import type { Job } from "../cron.ts";
import { activeTenants } from "../fanout.ts";
import { errorLabel, type Log } from "../ports.ts";

export interface ImportParseDeps {
  /** munim_svc pool. */
  pool: pg.Pool;
  blobs: BlobStore;
  log: Log;
  /** Runs parsed per tenant per pass (the rest wait for the next tick). */
  batch?: number;
}

export type ParseTally = { previewed: number; failed: number; skipped: number; errors: number };

const svcCtx = (tenantId: string) => ({ tenant_id: tenantId, outlet_ids: "*" as const, role: "service" as const });

/** One pass over every tenant's pending runs. One run's error is logged (ids and a label only) and the pass goes on. */
export async function parsePendingImports(deps: ImportParseDeps, tenants?: string[], signal?: AbortSignal): Promise<ParseTally> {
  const tally: ParseTally = { previewed: 0, failed: 0, skipped: 0, errors: 0 };
  for (const tenant of tenants ?? (await activeTenants(deps.pool))) {
    if (signal?.aborted) break;
    const ids = await withContext(deps.pool, svcCtx(tenant), async (c) =>
      (await c.query<{ id: string }>(`SELECT id FROM core.import_run WHERE status = 'parsing' ORDER BY created_at, id LIMIT $1`,
        [deps.batch ?? 20])).rows.map((r) => r.id));
    for (const id of ids) {
      if (signal?.aborted) break;
      try {
        tally[await withContext(deps.pool, svcCtx(tenant), (c) => parseRun(c, deps.blobs, id))]++;
      } catch (e) {
        tally.errors++;
        deps.log("imports.parse_failed", { tenant_id: tenant, import_run_id: id, error: errorLabel(e) });
      }
    }
  }
  return tally;
}

/** The cron entry for Worker's registry (`new Cron(...).add(importParseJob(deps))`). */
export function importParseJob(deps: ImportParseDeps): Job {
  return {
    name: "imports-parse",
    everyMinutes: 1,
    run: async (_slot, signal) => {
      const t = await parsePendingImports(deps, undefined, signal);
      if (t.previewed + t.failed + t.errors > 0) deps.log("imports.parsed", t);
    },
  };
}
