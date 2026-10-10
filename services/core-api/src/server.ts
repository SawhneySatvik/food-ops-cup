// core-api entry (`node src/server.ts`) and its composition. `composeCoreApi` builds the dependencies from
// connection strings and keys it is handed — the entry block below takes them from the config module (which
// alone reads the founder's `.env` and redacts its secrets); the smoke test hands it embedded-Postgres URLs.
import { join, resolve } from "node:path";
import { serve } from "@hono/node-server";
import { type Config, createLogger, type DbRole, type Logger, loadRepoConfig } from "@munim/config";
import type { Hono } from "hono";
import pg from "pg";
import { createApp } from "./app.ts";
import type { IdP } from "./auth/port.ts";
import { storefrontResolver } from "./auth/resolve.ts";
import type { PublishDeps } from "./commit/index.ts";
import { createHttpPublisher, devhostIdp } from "./dev-root.ts";
import { createPool, type Pools, withContext } from "./lib/db.ts";
import { type BlobStore, localBlobStore, setBlobStore } from "./modules/imports/index.ts";
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
  config: Pick<Config, "nodeEnv" | "redact">;
  log: Logger;
  keys: { privateKeyPem: string; publicKeyPem: string };
  intelUrl: string;
  serviceSecret: string;
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
  const pools: Pools = { core: createPool(w.coreUrl, 10), svc: createPool(w.svcUrl, 5), ...(w.platformUrl ? { platform: createPool(w.platformUrl, 2) } : {}) };
  if (w.blobs) setBlobStore(w.blobs);
  const keys = loadRunTokenKeys(w.keys);
  const svc = svcTxOf(pools.svc);
  const publish: PublishDeps = { publisher: createHttpPublisher({ url: w.intelUrl, serviceSecret: w.serviceSecret }), svc, keys };
  const deps: Deps = { pools, idp: w.idp, storefronts: storefrontResolver(pools.core), publish, config: w.config, log: w.log };
  // Keyed by this exact Deps object (a WeakMap in stream/index.ts) — never pass createApp a copy.
  configureStream(deps, {
    connect: () => new pg.Client({ connectionString: w.listenUrl, application_name: "munim_stream_listen", keepAlive: true }),
  });
  // createApp awaits loadContracts() → loadRegistry(), so every draftable type is registered before serving (gotcha 28).
  const app = await createApp(deps);
  return {
    app, deps, publish, svc, keys,
    async close() {
      await closeStream(deps);
      await Promise.all([pools.core.end(), pools.svc.end(), pools.platform?.end()]);
    },
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
    const api = await composeCoreApi({
      coreUrl: config.dbUrl("munim_core"),
      svcUrl: config.dbUrl("munim_svc"),
      // DbRole names only munim_core / munim_svc; munim_platform's password is in db-roles.json (bootstrap-roles
      // LOGIN_ROLES). Widening DbRole in packages/config is requested (W2 B3).
      platformUrl: config.dbUrl("munim_platform" as DbRole),
      blobs: localBlobStore(join(config.runDir, "blobs")),
      listenUrl: config.sessionDbUrl("munim_core"),
      idp: devhostIdp({ projectUrl: config.require("DEVHOST_PROJECT_URL"), publishableKey: config.require("DEVHOST_PUBLISHABLE_KEY") }),
      config,
      log,
      keys: ensureDevRunTokenKeys(config.runTokenKeyDir),
      intelUrl: config.intelUrl,
      serviceSecret: config.serviceSecret(),
    });
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
