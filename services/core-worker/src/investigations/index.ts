// Investigation Auto mode jobs (T-089b; ledger R45 F10, F11 O-1). core-worker resumes `auto` investigations under their
// creator's standing grant: every minute for approved import commits newer than an investigation's last step (no import
// commit writes an outbox event, so the commit is found by polling core.import_run), and daily at 00:00 UTC. The logic
// and every re-check are core-api's (modules/investigations/auto.ts); this file only schedules it over the active
// tenants on the munim_svc pool, as imports/ does. One tenant's error is logged (ids and a label) and the pass goes on.
import type pg from "pg";
import { type AutoDeps, type AutoTally, autoDeps, type NarratePort, resumeDaily, resumeOnImports } from "../../../core-api/src/modules/investigations/index.ts";
import type { RunTokenKeys } from "../../../core-api/src/runtoken/index.ts";
import type { Job } from "../cron.ts";
import { activeTenants } from "../fanout.ts";
import { errorLabel, type Log } from "../ports.ts";

export interface AutoJobDeps {
  /** munim_svc pool. */
  pool: pg.Pool;
  keys: RunTokenKeys;
  /** intel's /investigate:narrate; null → core's template narration only. */
  narrate: NarratePort | null;
  log: Log;
}

type Pass = (deps: AutoDeps, tenantId: string) => Promise<AutoTally>;

/** One pass over `tenants` (default: every active tenant), summed. */
export async function autoPass(d: AutoJobDeps, pass: Pass, tenants?: string[], signal?: AbortSignal): Promise<AutoTally> {
  const deps = autoDeps({ svc: d.pool, keys: d.keys, narrate: d.narrate, log: (msg) => d.log("investigations.auto_narration", { message: msg }) });
  const sum: AutoTally = { resumed: 0, steps: 0, cancelled: 0, budget: 0, ceiling: 0 };
  for (const tenant of tenants ?? (await activeTenants(d.pool))) {
    if (signal?.aborted) break;
    try {
      const t = await pass(deps, tenant);
      for (const k of Object.keys(sum) as Array<keyof AutoTally>) sum[k] += t[k];
    } catch (e) {
      d.log("investigations.auto_failed", { tenant_id: tenant, error: errorLabel(e) });
    }
  }
  return sum;
}

const logged = (d: AutoJobDeps, job: string, t: AutoTally) => {
  if (t.steps + t.cancelled + t.budget + t.ceiling > 0) d.log("investigations.auto", { job, ...t });
};

/** Every minute: Auto investigations waiting on an import kind that an approved import has since committed. */
export function autoImportJob(d: AutoJobDeps): Job {
  return {
    name: "investigations-auto-imports",
    everyMinutes: 1,
    run: async (_slot, signal) => logged(d, "imports", await autoPass(d, resumeOnImports, undefined, signal)),
  };
}

/** Daily (00:00 UTC): every open or waiting Auto investigation with no step since that boundary and new data since its last step
 *  (R47 D4: core-api's `newData`; a quiet day steps nothing). */
export function autoDailyJob(d: AutoJobDeps): Job {
  return {
    name: "investigations-auto-daily",
    everyMinutes: 24 * 60,
    run: async (slot, signal) => logged(d, "daily", await autoPass(d, (deps, t) => resumeDaily(deps, t, slot.at), undefined, signal)),
  };
}
