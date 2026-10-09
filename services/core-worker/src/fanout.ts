// Per-tenant fan-out (03-architecture §1.9, 04-agent-framework §1, §5): list tenants through
// `core.active_tenants()`, mint one run token per tenant, call intel. Bounded concurrency; one tenant's
// failure is logged (ids and an error label only) and never stops the others.
import type pg from "pg";
import { errorLabel, type IntelClient, type IntelPath, type Log, type RunTokenMinter } from "./ports.ts";

export async function activeTenants(pool: pg.Pool): Promise<string[]> {
  const { rows } = await pool.query<{ t: string }>("SELECT t FROM core.active_tenants() AS t");
  return rows.map((r) => r.t);
}

/** Runs fn over items with at most `limit` in flight; never starts a new item once `signal` aborts. */
export async function forEachBounded<T>(items: T[], limit: number, signal: AbortSignal, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length && !signal.aborted) await fn(items[next++] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

export interface FanoutDeps {
  minter: RunTokenMinter;
  intel: IntelClient;
  log: Log;
  concurrency: number;
}

const KINDS = {
  "/watch:sweep": { trigger: "watch_sweep", actor: "watcher:sweep" },
  "/brief": { trigger: "brief", actor: "brief" },
} as const;

export async function fanout(deps: FanoutDeps, path: IntelPath, tenants: string[], signal: AbortSignal): Promise<{ ok: number; failed: number }> {
  let ok = 0;
  let failed = 0;
  const { trigger, actor } = KINDS[path];
  await forEachBounded(tenants, deps.concurrency, signal, async (tenant) => {
    let runId: string | null = null;
    try {
      const run = await deps.minter.mint({ tenantId: tenant, trigger, actor, outletScope: ["*"] });
      runId = run.run_id;
      await deps.intel.call(path, run.token);
      ok++;
    } catch (e) {
      failed++;
      deps.log("fanout.tenant_failed", { path, tenant_id: tenant, run_id: runId, error: errorLabel(e) });
    } finally {
      // intel does a sweep/brief inside the request, so once it returned (or we gave up) the run is over.
      if (runId && deps.minter.end) {
        await deps.minter.end(tenant, runId).catch((e: unknown) =>
          deps.log("fanout.run_end_failed", { path, tenant_id: tenant, run_id: runId, error: errorLabel(e) }));
      }
    }
  });
  deps.log("fanout.done", { path, ok, failed });
  return { ok, failed };
}

export class IntelHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`intel responded ${status}`);
    this.name = "IntelHttpError";
    this.status = status;
  }
}

/** Header names of core → intel calls. Shared with the event publisher (T-005) and intel (T-041). */
export const INTEL_AUTH_HEADERS = { runToken: "authorization", serviceSecret: "x-munim-service-secret" } as const;

/** fetch-based IntelClient. The response body is discarded unread: it is untrusted text and never logged. */
export function intelHttp(opts: { baseUrl: string; serviceSecret: string; timeoutMs?: number }): IntelClient {
  return {
    async call(path, runToken) {
      const res = await fetch(new URL(path, opts.baseUrl), {
        method: "POST",
        headers: {
          [INTEL_AUTH_HEADERS.runToken]: `Bearer ${runToken}`,
          [INTEL_AUTH_HEADERS.serviceSecret]: opts.serviceSecret,
          "content-type": "application/json",
        },
        body: "{}",
        signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
      });
      await res.body?.cancel();
      if (!res.ok) throw new IntelHttpError(res.status);
    },
  };
}
