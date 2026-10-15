// The env-only composition root, for a host that runs core-api from the process environment alone: a container entry
// (infra/gcp/entries) or request-scoped functions on a read-only, per-instance filesystem. Differences from server.ts's entry:
//   - config from the process environment only (`envOnly`): no `.env` file and nothing read or written under `.run/`;
//     a missing secret (role password, service secret, run-token PEMs) fails the boot, never generates one per instance
//   - the IdP MUNIM_IDP names (idpFromConfig), never "local" (a dev mode whose signing key lives under `.run/`)
//   - core-worker's jobs run behind the tick route (`/internal/cron/v1/tick`) when MUNIM_CRON_SECRET is set, instead of
//     in a long-running process: the same Worker, the same munim_svc role
//   - uploaded documents go to the store MUNIM_BLOB names (blobStoreFromEnv): a shared bucket in production, because an
//     upload and the tick's parse that reads it may land on different instances; "fs" (a per-instance temp directory) is
//     the default only for a single-instance trial
// Nothing here listens on a port; the host calls `app.fetch`.
import { type Config, ConfigError, createLogger, type Logger, loadConfig, resolveIdpMode } from "@munim/config";
import { composeWorker } from "../../core-worker/src/main.ts";
import { blobStoreFromEnv } from "./blob-store.ts";
import { configureTick } from "./cron/index.ts";
import { idpFromConfig } from "./idp.ts";
import { composeCoreApi, type CoreApi, wiringFromConfig } from "./server.ts";

// The one store chooser, for every host's entry (the Cup's core-worker entry imports it from here).
export { blobStoreFromEnv };

export async function composeFromEnv(env: Record<string, string | undefined> = process.env): Promise<CoreApi> {
  const config = loadConfig({ env, envOnly: true });
  const log = createLogger(config);
  try {
    return await compose(config, log, env);
  } catch (e) {
    // As server.ts's entry: a pg or config error can carry a URL, so it is logged redacted and not rethrown as is.
    log("core-api: failed to start", e);
    throw new Error("core-api: failed to start (see the redacted log line)");
  }
}

async function compose(config: Config, log: Logger, env: Record<string, string | undefined>): Promise<CoreApi> {
  const idpMode = resolveIdpMode(env);
  if (idpMode === "local") throw new ConfigError("the env-only boot refuses MUNIM_IDP=local");
  const keys = config.runTokenKeyPems()!; // envOnly: throws when unset, never null
  const blobs = blobStoreFromEnv(config);
  const api = await composeCoreApi(wiringFromConfig(config, log, { idpMode, idp: idpFromConfig(config, idpMode), keys, blobs }));
  const cronSecret = config.cronSecret();
  if (cronSecret) {
    const { worker } = composeWorker({
      svcUrl: config.dbUrl("munim_svc"), keys, intelUrl: config.intelUrl, serviceSecret: config.serviceSecret(), blobs,
    });
    configureTick(api.deps, {
      secret: cronSecret,
      tick: (now) => worker.tick(now, { periodMinutes: config.tickPeriodMinutes, budgetMs: config.tickBudgetMs }),
    });
  }
  return api;
}
