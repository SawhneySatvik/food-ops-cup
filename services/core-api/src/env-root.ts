// The env-only composition root, for a host that runs core-api as request-scoped functions on a read-only,
// per-instance filesystem (a serverless host's function entry imports this). Differences from server.ts's entry:
//   - config from the process environment only (`envOnly`): no `.env` file and nothing read or written under `.run/`;
//     a missing secret (role password, service secret, run-token PEMs) fails the boot, never generates one per instance
//   - the dev IdP only (MUNIM_IDP=local is a dev mode with token files under `.run/`)
//   - core-worker's jobs run behind the tick route (`/internal/cron/v1/tick`) when MUNIM_CRON_SECRET is set, instead of
//     in a long-running process: the same Worker, the same munim_svc role
//   - uploaded documents go to a per-instance temp directory (no shared blob store exists yet: an upload and the parse
//     that reads it may land on different instances — reported, lane B2)
// Nothing here listens on a port; the host calls `app.fetch`.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Config, ConfigError, createLogger, type Logger, loadConfig, resolveIdpMode } from "@munim/config";
import { composeWorker } from "../../core-worker/src/main.ts";
import { configureTick } from "./cron/index.ts";
import { devhostIdp } from "./dev-root.ts";
import { localBlobStore } from "./modules/imports/index.ts";
import { composeCoreApi, type CoreApi, wiringFromConfig } from "./server.ts";

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
  if (idpMode !== "devhost") throw new ConfigError("the env-only boot supports MUNIM_IDP=devhost only");
  const keys = config.runTokenKeyPems()!; // envOnly: throws when unset, never null
  const blobs = localBlobStore(join(tmpdir(), "munim-blobs"));
  const api = await composeCoreApi(wiringFromConfig(config, log, {
    idpMode,
    idp: devhostIdp({ projectUrl: config.require("DEVHOST_PROJECT_URL"), publishableKey: config.require("DEVHOST_PUBLISHABLE_KEY") }),
    keys,
    blobs,
  }));
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
