// The core-api Hono app. Dependencies are injected (server.ts builds them from config; gates pass embedded-
// Postgres pools and idp-local), so no gate ever reads `.env`.
import { AccountMissing } from "@munim/core-domain/finance";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { CommandTypeMismatch, IdempotencyConflict } from "./commit/index.ts";
import { ApiError, errorBody, fromSqlState } from "./lib/errors.ts";
import { loadContracts } from "./lib/contracts.ts";
import { cors } from "./lib/cors.ts";
import type { AppEnv, Deps } from "./lib/types.ts";
import { health } from "./health/index.ts";
import { probe } from "./health/probe.ts";
import { loadRouters } from "./modules/index.ts";

export type { AppEnv, Deps } from "./lib/types.ts";
export type { AppContext, Pools } from "./lib/db.ts";
export { asSystem, createPool, withContext } from "./lib/db.ts";
export { ApiError, errorBody, fromSqlState } from "./lib/errors.ts";
export { parseCorsOrigins } from "./lib/cors.ts";
export type { Identity, IdP } from "./auth/port.ts";
export { IdpError } from "./auth/port.ts";
export type { Principal, ShopperExtras, Storefront, StorefrontResolver } from "./auth/resolve.ts";
export {
  contextOf, GUEST_TOKEN_HEADER, requireCustomer, requireGuest, requireMember, requireOperator, STOREFRONT_KEY_HEADER, storefrontResolver, TENANT_HEADER,
} from "./auth/resolve.ts";

export interface AppOptions {
  /** Exact browser origins allowed to call the public storefront / stream / Cares-network routes (lib/cors.ts, G-09);
   *  the composition root passes `parseCorsOrigins(MUNIM_CORS_ORIGINS)`. Absent or empty = no CORS headers at all. */
  corsOrigins?: readonly string[];
}

// C1 S2-5: every request body is capped before any route reads it (a Content-Length over the cap is refused unread). 256 KiB
// fits every member, storefront and platform command; the upload route takes a 5 MiB file as base64 (6.7 MiB) in JSON; intel's
// batches (service secret and run token, checked before any body is read) reach ~12 MB at the contracts' maxima (500 chunks of
// 8000 three-byte characters).
const KIB = 1024;
const tooLarge = (c: Parameters<MiddlewareHandler>[0]) => c.json(errorBody("bad_request"), 413);
const limit = (maxSize: number) => bodyLimit({ maxSize, onError: tooLarge });
const LIMITS: ReadonlyArray<[RegExp, MiddlewareHandler]> = [
  [/^\/internal\/intel\/v1\//, limit(16 * 1024 * KIB)],
  [/^\/v1\/imports\/documents$/, limit(8 * 1024 * KIB)],
];
const DEFAULT_LIMIT = limit(256 * KIB);
const bodyLimits: MiddlewareHandler = (c, next) => (LIMITS.find(([path]) => path.test(c.req.path))?.[1] ?? DEFAULT_LIMIT)(c, next);

export async function createApp(deps: Deps, opts: AppOptions = {}): Promise<Hono<AppEnv>> {
  await loadContracts();
  const app = new Hono<AppEnv>();
  // First: a preflight is answered before any router (and its rate limiter) sees it.
  app.use(cors(opts.corsOrigins ?? []));
  app.use(bodyLimits);
  app.use(async (c, next) => {
    c.set("deps", deps);
    await next();
  });
  app.route("/", health);
  if (deps.config.nodeEnv === "test") app.route("/", probe);
  for (const { router } of await loadRouters()) app.route("/", router);

  app.notFound((c) => c.json(errorBody("not_found"), 404));
  // Bodies come only from the fixed table in lib/errors.ts: an exception's text (SQL, driver, model) is
  // logged redacted and never returned.
  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json(err.body(), err.status);
    if (err instanceof IdempotencyConflict) return c.json(errorBody("idempotency_conflict"), 409);
    if (err instanceof CommandTypeMismatch) return c.json(errorBody("command_type_mismatch"), 422);
    const refused = fromSqlState(err);
    if (refused) return c.json(errorBody(refused.code, refused.reason_code), refused.status);
    // The tenant's chart has no account for a role a posting rule needs: the write is refused as a whole. The
    // error's own text names the role and is not used.
    if (err instanceof AccountMissing) return c.json(errorBody("chart_incomplete"), 409);
    if (err instanceof HTTPException && err.status < 500) {
      return c.json(errorBody(err.status === 401 ? "unauthenticated" : err.status === 404 ? "not_found" : "bad_request"), err.status === 401 || err.status === 404 ? err.status : 400);
    }
    deps.log(`${c.req.method} ${c.req.routePath}: unhandled`, err);
    return c.json(errorBody("internal"), 500);
  });
  return app;
}
