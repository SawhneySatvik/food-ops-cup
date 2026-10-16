// Who may call /internal/intel/v1 (03-architecture §1.7, §1.9; project rule 15): intel only, with BOTH the
// service secret (`x-munim-service-secret`, dev; Cup: a Cloud Run ID token) and a run token. core checks the
// Ed25519 signature, the claims and the intel.run row (verifyRunToken); tenant and outlet scope come only from that
// verified token. Every refusal is the same 404 (gotcha 16: a bad capability never says why); neither the secret nor
// the token is ever logged. Without configureInternal() every route refuses `unavailable` (fail closed).
import { createHash, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { withContext } from "../lib/db.ts";
import { ApiError } from "../lib/errors.ts";
import type { AppEnv, Deps } from "../lib/types.ts";
import { type OutletScope, type Queryable, type RunTokenKeys, type RunTrigger, verifyRunToken } from "../runtoken/index.ts";

export const SERVICE_SECRET_HEADER = "x-munim-service-secret";

export interface InternalConfig {
  serviceSecret: string;
  /** Only the public key is used here; core-api already holds the pair (server.ts `keys`). */
  keys: RunTokenKeys;
  /** Leading-edge watcher debounce (04 §5): 15 min in production, 0 in tests. */
  watchWindowMs?: number;
  /** Unix ms; injectable so expiry is tested without sleeping. */
  now?: () => number;
  /** Wall clock of the run-frame (business dates, the budget month) and of spend stamps. Separate from `now` so a
   *  test can pin the calendar without moving token expiry. */
  clock?: () => Date;
}

const configs = new WeakMap<Deps, InternalConfig>();

/** Wires the internal API into one composed app — keyed by that exact Deps object (as configureStream). */
export function configureInternal(deps: Deps, cfg: InternalConfig): void {
  // An empty secret would match a request that sends none.
  if (cfg.serviceSecret.length < 16) throw new Error("configureInternal: the service secret is missing or too short");
  configs.set(deps, cfg);
}

export interface Run { tenantId: string; runId: string; scope: OutletScope; actor: string; trigger: RunTrigger }

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

/** A munim_svc transaction under the run's tenant and outlet scope (role 'service'). */
export function runTx<T>(deps: Deps, run: Pick<Run, "tenantId" | "scope">, fn: (c: Queryable) => Promise<T>): Promise<T> {
  return withContext(deps.pools.svc, { tenant_id: run.tenantId, outlet_ids: run.scope[0] === "*" ? "*" : run.scope, role: "service" }, fn);
}

/** How long after core ends a run (its HTTP wait for intel is over: answered, failed or timed out) the run's spend and
 *  traces are still taken (`afterEnd`). intel may still be finishing calls it already made; refusing their spend would
 *  leave them off the month's AI cap (R47). 300 s: no function on the Hobby plan (R55) runs longer, so no intel request
 *  outlives core's wait by more. Every other route refuses an ended run at once. */
export const ENDED_GRACE_S = 300;

export async function authenticate(c: Context<AppEnv>, o: { afterEnd?: boolean } = {}): Promise<{ run: Run; cfg: InternalConfig }> {
  const deps = c.var.deps;
  const cfg = configs.get(deps);
  if (!cfg) throw new ApiError("unavailable");
  if (!timingSafeEqual(digest(c.req.header(SERVICE_SECRET_HEADER) ?? ""), digest(cfg.serviceSecret))) throw new ApiError("not_found");
  const m = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(c.req.header("Authorization") ?? "");
  if (!m) throw new ApiError("not_found");
  const v = await verifyRunToken({
    ...cfg.keys, ...(cfg.now ? { now: cfg.now } : {}),
    svc: (scope, fn) => runTx(deps, { tenantId: scope.tenantId, scope: scope.outletScope }, fn),
  }, m[1]!, o.afterEnd ? { endedGraceS: ENDED_GRACE_S } : {});
  if (!v.ok) throw new ApiError("not_found");
  const k = v.claims;
  return { run: { tenantId: k.tenant_id, runId: k.run_id, scope: k.outlet_scope as OutletScope, actor: k.actor, trigger: k.trigger }, cfg };
}
