// Cloud Run entry for core-worker (copied to services/core-worker/src/cloud-run-entry.mjs by core-worker.Dockerfile).
// Why not main.ts: its entry loads `.env`, signs with a per-instance dev key (intel could not verify it) and stores
// uploads in a local directory. Here the run-token keys, the role password and the blob store come from the environment,
// exactly as core-api's env-only boot takes them. Cloud Run needs a listener on $PORT, so a bare health server answers
// 200; it exposes nothing. Run exactly one instance (the service is pinned to min = max = 1).
import { createServer } from "node:http";
import { createLogger, loadConfig } from "../../../packages/config/src/index.ts";
import { loadContracts } from "../../core-api/src/lib/contracts.ts";
import { blobStoreFromEnv } from "../../core-api/src/env-root.ts"; // the store core-api writes to
import { composeWorker } from "./main.ts";
import { jsonLog } from "./ports.ts";
import { runUntilSignal } from "./process.ts";

const config = loadConfig({ env: process.env, envOnly: true });
const fail = createLogger(config);
try {
  await loadContracts(); // gotcha 28: register every draftable type before any job runs
  const { worker } = composeWorker({
    svcUrl: config.dbUrl("munim_svc"),
    keys: config.runTokenKeyPems(),
    intelUrl: config.intelUrl,
    serviceSecret: config.serviceSecret(),
    blobs: blobStoreFromEnv(config),
  });
  createServer((_, res) => res.writeHead(200, { "content-type": "text/plain" }).end("ok")).listen(Number(process.env.PORT ?? 8080), "0.0.0.0");
  await runUntilSignal(worker, jsonLog);
} catch (e) {
  fail("core-worker: failed to start", e);
  process.exit(1);
}
