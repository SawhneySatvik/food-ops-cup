// core-api entry (`node src/server.ts`) and its composition. `composeCoreApi` builds the dependencies from
// connection strings and keys it is handed — the entry block below takes them from the config module (which
// alone reads the founder's `.env` and redacts its secrets); the smoke test hands it embedded-Postgres URLs.
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { type Config, createLogger, type IdpMode, type Logger, loadRepoConfig, resolveIdpMode } from "@munim/config";
import type { Hono } from "hono";
import pg from "pg";
import { createApp, parseCorsOrigins } from "./app.ts";
import type { IdP } from "./auth/port.ts";
import { storefrontResolver } from "./auth/resolve.ts";
import { blobStoreFromEnv } from "./blob-store.ts";
import type { PublishDeps } from "./commit/index.ts";
import { createHttpPublisher } from "./commit/publisher-http.ts";
import { setIdpMode } from "./health/index.ts";
import { idpFromConfig } from "./idp.ts";
import { configureInternal } from "./internal/index.ts";
import { createPool, type Pools, withContext } from "./lib/db.ts";
import { configureCaresNetwork } from "./modules/cares-network/index.ts";
import { type BlobStore, blobs as defaultBlobs } from "./modules/imports/index.ts";
import { configureInvestigations, createHttpNarratePort } from "./modules/investigations/index.ts";
import { configureRfq, createHttpNegotiatePort } from "./modules/purchasing/index.ts";
import { configureThreads, createHttpAskPort } from "./modules/threads/index.ts";
import type { AppEnv, Deps } from "./lib/types.ts";
import { loadRunTokenKeys, type RunTokenKeys, type SvcTx } from "./runtoken/index.ts";
import { ensureDevRunTokenKeys } from "./runtoken/keys.ts";
import { closeStream, configureStream } from "./stream/index.ts";

export interface CoreApiWiring {
  /** munim_core app pool (transaction pooler). */
  coreUrl: string;
  /** munim_svc app pool (transaction pooler). */
  svcUrl: string;
  /** munim_platform app pool (transaction pooler) for the operator routes; unset → they refuse `unavailable`. */
  platformUrl?: string;
  /** Uploaded documents' bytes; the worker's import parse job must be handed the same store. Unset → the
   *  imports module's default local store. */
  blobs?: BlobStore;
  /** munim_core on a session-mode connection, for the stream's LISTEN (a transaction pooler drops NOTIFY). */
  listenUrl: string;
  idp: IdP;
  /** Reported by /health (MUNIM_IDP's value); unset → null. */
  idpMode?: IdpMode;
  config: Pick<Config, "nodeEnv" | "redact">;
  log: Logger;
  keys: { privateKeyPem: string; publicKeyPem: string };
  intelUrl: string;
  serviceSecret: string;
  /** Exact browser origins for the public routes (lib/cors.ts); unset or empty = no CORS headers. */
  corsOrigins?: readonly string[];
  /** Proxies in front of core-api (the Cares-network rate limiter's client address); unset = the module's default 0. */
  trustedProxyHops?: number;
  /** When an SSE stream is ended with a reconnect hint (config `MUNIM_STREAM_MAX_AGE_S`); unset = the stream's 55 min. */
  streamMaxAgeMs?: number;
  /** Ceiling on every app pool's size (config `MUNIM_DB_POOL_MAX`); unset = core 10, svc 5, platform 2. */
  poolMax?: number;
}

export interface CoreApi {
  app: Hono<AppEnv>;
  deps: Deps;
  /** Post-commit publishing for executeCommand — the same object as deps.publish. */
  publish: PublishDeps;
  svc: SvcTx;
  keys: RunTokenKeys;
  /** Ends every open stream and the LISTEN connection, then both pools. */
  close(): Promise<void>;
}

/** A munim_svc transaction under the run's tenant and outlet scope (role 'service'). */
export function svcTxOf(pool: pg.Pool): SvcTx {
  return (scope, fn) => withContext(pool, {
    tenant_id: scope.tenantId,
    outlet_ids: scope.outletScope[0] === "*" ? "*" : scope.outletScope,
    role: "service",
  }, fn);
}

export async function composeCoreApi(w: CoreApiWiring): Promise<CoreApi> {
  const size = (n: number) => Math.min(n, w.poolMax ?? n);
  const pools: Pools = { core: createPool(w.coreUrl, size(10)), svc: createPool(w.svcUrl, size(5)), ...(w.platformUrl ? { platform: createPool(w.platformUrl, size(2)) } : {}) };
  const keys = loadRunTokenKeys(w.keys);
  const svc = svcTxOf(pools.svc);
  const publish: PublishDeps = { publisher: createHttpPublisher({ url: w.intelUrl, serviceSecret: w.serviceSecret }), svc, keys };
  const deps: Deps = { pools, idp: w.idp, storefronts: storefrontResolver(pools.core), publish, blobs: w.blobs ?? defaultBlobs(), config: w.config, log: w.log };
  if (w.idpMode) setIdpMode(deps, w.idpMode);
  // Keyed by this exact Deps object (a WeakMap in stream/index.ts) — never pass createApp a copy.
  configureStream(deps, {
    connect: () => new pg.Client({ connectionString: w.listenUrl, application_name: "munim_stream_listen", keepAlive: true }),
    ...(w.streamMaxAgeMs ? { maxAgeMs: w.streamMaxAgeMs } : {}),
  });
  // createApp awaits loadContracts() → loadRegistry(), so every draftable type is registered before serving (gotcha 28).
  if (w.trustedProxyHops !== undefined) configureCaresNetwork({ trustedProxyHops: w.trustedProxyHops });
  const app = await createApp(deps, { corsOrigins: w.corsOrigins ?? [] });
  configureInternal(deps, { serviceSecret: w.serviceSecret, keys });
  // T-082b: `POST /v1/ask` calls intel's `/ask` synchronously (a test may re-configure the port on the same deps).
  configureThreads(deps, { keys, intel: createHttpAskPort({ url: w.intelUrl, serviceSecret: w.serviceSecret }) });
  configureInvestigations(deps, { keys, narrate: createHttpNarratePort({ url: w.intelUrl, serviceSecret: w.serviceSecret }) });
  // T-114: `POST /v1/rfq-requests` calls intel's `/negotiate` synchronously.
  configureRfq(deps, { keys, intel: createHttpNegotiatePort({ url: w.intelUrl, serviceSecret: w.serviceSecret }) });
  return {
    app, deps, publish, svc, keys,
    async close() {
      await closeStream(deps);
      await Promise.all([pools.core.end(), pools.svc.end(), pools.platform?.end()]);
    },
  };
}

/** The wiring every composition root takes from the config module: the entry below (`.env` + `.run/`) and
 *  env-root.ts (env only). `keys` and `blobs` differ between the two, so they are passed in. */
export function wiringFromConfig(config: Config, log: Logger, o: { idpMode: IdpMode; idp: IdP; keys: CoreApiWiring["keys"]; blobs: BlobStore }): CoreApiWiring {
  return {
    idpMode: o.idpMode,
    coreUrl: config.dbUrl("munim_core"),
    svcUrl: config.dbUrl("munim_svc"),
    platformUrl: config.dbUrl("munim_platform"),
    blobs: o.blobs,
    listenUrl: config.sessionDbUrl("munim_core"),
    idp: o.idp,
    config,
    log,
    keys: o.keys,
    intelUrl: config.intelUrl,
    serviceSecret: config.serviceSecret(),
    corsOrigins: parseCorsOrigins(config.corsOrigins),
    trustedProxyHops: config.trustedProxyHops,
    streamMaxAgeMs: config.streamMaxAgeMs,
    ...(config.dbPoolMax ? { poolMax: config.dbPoolMax } : {}),
  };
}

/** Serves the app over HTTP (port 0 = any free port); resolves once listening. */
export function serveApi(app: Hono<AppEnv>, port: number): Promise<{ port: number; server: ReturnType<typeof serve> }> {
  return new Promise((ok) => {
    const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => ok({ port: info.port, server }));
  });
}

if (import.meta.filename === resolve(process.argv[1] ?? "")) {
  const root = resolve(import.meta.dirname, "../../..");
  const config = loadRepoConfig(root);
  const log = createLogger(config);
  try {
    // Before anything connects: a refused MUNIM_IDP (unknown value, production, non-dev) fails the boot here.
    const idpMode = resolveIdpMode(process.env, process.argv.slice(2));
    if (idpMode === "local") log("core-api: DEV LOCAL SIGN-IN ENABLED — not for real users");
    const api = await composeCoreApi(wiringFromConfig(config, log, {
      idpMode,
      idp: idpFromConfig(config, idpMode),
      keys: config.runTokenKeyPems() ?? ensureDevRunTokenKeys(config.runTokenKeyDir),
      blobs: blobStoreFromEnv(config, join(config.runDir, "blobs")),
    }));
    const { port, server } = await serveApi(api.app, config.port);
    log(`core-api: listening on ${port}`);
    let stopping = false;
    const stop = () => {
      if (stopping) process.exit(1);
      stopping = true;
      // Backstop: a hung client or pool must not keep a stopped service alive.
      setTimeout(() => process.exit(1), 10_000).unref();
      // Streams first: an open SSE response would hold server.close() for up to 55 min.
      void closeStream(api.deps).then(() => server.close(() => void api.close().then(() => process.exit(0), () => process.exit(1))));
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  } catch (e) {
    log("core-api: failed to start", e);
    process.exit(1);
  }
}
