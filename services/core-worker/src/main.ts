// core-worker entry (`node services/core-worker/src/main.ts`) and its composition. `composeWorker` wires the
// Worker's ports from connection strings and keys it is handed — the entry block takes them from the config
// module; the smoke test hands it embedded-Postgres URLs. Everything here logs in as munim_svc (no book grants).
//   Publisher  per claimed row: T-005's createRowPublisher on munim_svc — mints the event run (scoped to the
//              event's outlets, ruling #18), encodes the stored CloudEvent, POSTs it to intel /events
//              (publisher-http). A stored row that fails its contract is reported as poison, so the sweeper
//              dead-letters it instead of stalling on it. The worker marks published_at after delivery.
//   Minter     mintRunToken on munim_svc; the fan-out calls its `end` (endRun) as soon as intel's call returns —
//              orchestrator ruling 10 Oct: fan-out tokens live only as long as the call.
//   Intel      intelHttp → intel's base URL with the service secret.
//   Imports    importParseJob (T-030) on the same munim_svc pool, reading uploads from the blob store core-api
//              writes (both entries build it from config.runDir).
//   Auto       autoImportJob / autoDailyJob (T-089b) on the same pool: Auto investigation steps under their standing
//              grant, narrated through intel's /investigate:narrate with the step's auto_step run token.
import { join, resolve } from "node:path";
import type pg from "pg";
import { createLogger, loadRepoConfig } from "../../../packages/config/src/index.ts";
import { createRowPublisher, outboxRowToCloudEvent, type Publisher as EventPublisher } from "../../core-api/src/commit/outbox.ts";
import { createHttpPublisher } from "../../core-api/src/dev-root.ts";
import { loadContracts } from "../../core-api/src/lib/contracts.ts";
import { createPool } from "../../core-api/src/lib/db.ts";
import { blobs as defaultBlobs, type BlobStore, localBlobStore } from "../../core-api/src/modules/imports/index.ts";
import { createHttpNarratePort } from "../../core-api/src/modules/investigations/index.ts";
import { endRun, loadRunTokenKeys, mintRunToken, type RunTokenKeys, type SvcTx } from "../../core-api/src/runtoken/index.ts";
import { ensureDevRunTokenKeys } from "../../core-api/src/runtoken/keys.ts";
import { svcTxOf } from "../../core-api/src/server.ts";
import { jsonLog, PoisonRowError, type Clock, type Log, type OutboxRow, type Publisher, type RunTokenMinter } from "./ports.ts";
import { intelHttp } from "./fanout.ts";
import { importParseJob } from "./imports/index.ts";
import { autoDailyJob, autoImportJob } from "./investigations/index.ts";
import { runUntilSignal } from "./process.ts";
import { Worker } from "./worker.ts";

export interface WorkerWiring {
  /** munim_svc login (transaction pooler): the Worker's own pool and the publisher/minter pool. */
  svcUrl: string;
  keys: { privateKeyPem: string; publicKeyPem: string };
  intelUrl: string;
  serviceSecret: string;
  /** Where uploaded documents' bytes live; unset → the imports module's default local store. */
  blobs?: BlobStore;
  log?: Log;
  clock?: Clock;
}

/** The worker's per-row Publisher. The stored row is checked against its contract first (the check
 *  createRowPublisher repeats; the empty token builds nothing that is sent): a row that fails it can never
 *  be delivered, and the sweeper must tell that apart from intel being down. */
export function rowPublisher(svc: SvcTx, keys: RunTokenKeys, http: EventPublisher): Publisher {
  const inner = createRowPublisher({ publisher: http, svc, keys });
  return {
    async publish(row: OutboxRow) {
      try {
        outboxRowToCloudEvent(row, "");
      } catch {
        throw new PoisonRowError("contract_invalid");
      }
      await inner.publish(row);
    },
  };
}

/** Fan-out minter: the fan-out ends each run (`end` → endRun) once intel's call returns, delivered or not. */
export function runMinter(svc: SvcTx, keys: RunTokenKeys): RunTokenMinter {
  return {
    async mint(req) {
      const { token, claims } = await mintRunToken({ ...keys, svc }, req);
      return { run_id: claims.run_id, token };
    },
    end: (tenantId, runId) => endRun({ svc }, tenantId, runId),
  };
}

export function composeWorker(w: WorkerWiring): { worker: Worker; pool: pg.Pool; close(): Promise<void> } {
  const log = w.log ?? jsonLog;
  const keys = loadRunTokenKeys(w.keys);
  const pool = createPool(w.svcUrl, 2);
  const svc = svcTxOf(pool);
  const worker = new Worker({
    connectionString: w.svcUrl,
    publisher: rowPublisher(svc, keys, createHttpPublisher({ url: w.intelUrl, serviceSecret: w.serviceSecret })),
    minter: runMinter(svc, keys),
    intel: intelHttp({ baseUrl: w.intelUrl, serviceSecret: w.serviceSecret }),
    log,
    ...(w.clock ? { clock: w.clock } : {}),
  });
  worker.cron.add(importParseJob({ pool, blobs: w.blobs ?? defaultBlobs(), log }));
  const auto = { pool, keys, narrate: createHttpNarratePort({ url: w.intelUrl, serviceSecret: w.serviceSecret }), log };
  worker.cron.add(autoImportJob(auto)).add(autoDailyJob(auto));
  return { worker, pool, close: () => pool.end() };
}

if (import.meta.filename === resolve(process.argv[1] ?? "")) {
  const root = resolve(import.meta.dirname, "../../..");
  const config = loadRepoConfig(root);
  // Startup failures go through the config's redacting logger (a pg or config error can carry a URL).
  const fail = createLogger(config);
  try {
    await loadContracts(); // gotcha 28: register every draftable type before any job runs
    const { worker } = composeWorker({
      svcUrl: config.dbUrl("munim_svc"),
      keys: ensureDevRunTokenKeys(config.runTokenKeyDir),
      intelUrl: config.intelUrl,
      serviceSecret: config.serviceSecret(),
      blobs: localBlobStore(join(config.runDir, "blobs")),
    });
    // runUntilSignal ends the Worker's pool and exits; the publisher/minter pool closes with the process.
    await runUntilSignal(worker, jsonLog);
  } catch (e) {
    fail("core-worker: failed to start", e);
    process.exit(1);
  }
}
