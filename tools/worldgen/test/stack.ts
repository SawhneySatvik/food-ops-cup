// Test-mode composition (the way tests/smoke does it): embedded Postgres 18, the real core-api app served over
// HTTP on 127.0.0.1, the import-parse pass of core-worker (the same job the worker runs, called on a timer),
// the local IdP for persona tokens. Lives in test/ so that tools/worldgen/src stays free of SQL clients and
// core-api internals (gate d). Synthetic data only; nothing here reads .env.
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, loadConfig } from "../../../packages/config/src/index.ts";
import { startTestDb, type TestDb } from "../../../db/src/harness.ts";
import { createLocalIdp } from "../../../services/core-api/src/auth/local-idp.ts";
import { createPool } from "../../../services/core-api/src/lib/db.ts";
import { localBlobStore } from "../../../services/core-api/src/modules/imports/index.ts";
import { composeCoreApi, serveApi, type CoreApi } from "../../../services/core-api/src/server.ts";
import { parsePendingImports } from "../../../services/core-worker/src/imports/index.ts";
import { startIntelStub, type IntelStub } from "../../../scripts/dev/intel-stub.ts";
import { personaIdentity } from "../src/api.ts";
import { idOf } from "../src/ids.ts";
import { WORLDS } from "../src/run.ts";

export interface Stack {
  baseUrl: string;
  /** Persona token factory for one world. */
  token(world: string): (persona: string) => string;
  /** Superuser query on the stack's database (read-only checks in gates). */
  admin: TestDb["admin"];
  stop(): Promise<void>;
}

export async function startStack(): Promise<Stack> {
  const db: TestDb = await startTestDb();
  const stub: IntelStub = await startIntelStub();
  const idp = createLocalIdp();
  // One platform operator per world (R47 D2): the demo business's AI budget is proposed and approved by an operator, as budgets are set.
  for (const w of WORLDS) await db.admin(`INSERT INTO platform.operator (id, idp_sub, email) VALUES ($1, $2, $3)`, [idOf("stack", w, "operator"), personaIdentity(w, "operator").sub, personaIdentity(w, "operator").email]);
  const url = (role: string) => `postgresql://${role}:${db.password}@127.0.0.1:${db.port}/${db.database}`;
  const config = loadConfig({ env: {} });
  const log = createLogger(config, () => {});
  const keys = generateKeyPairSync("ed25519");
  const blobDir = await mkdtemp(join(tmpdir(), "worldgen-blobs-"));
  const blobs = localBlobStore(blobDir);
  const api: CoreApi = await composeCoreApi({
    coreUrl: url("munim_core"), svcUrl: url("munim_svc"), platformUrl: url("munim_platform"), listenUrl: url("munim_core"), idp, config, log, blobs,
    keys: { privateKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString() },
    intelUrl: stub.url, serviceSecret: "worldgen-test-secret-not-real",
  });
  const served = await serveApi(api.app, 0);
  const svcPool = createPool(url("munim_svc"), 2);
  // core-worker parses a run within a minute; here the same pass runs every 150 ms so a file is previewed quickly.
  const timer = setInterval(() => void parsePendingImports({ pool: svcPool, blobs, log: () => {} }).catch(() => {}), 150);
  return {
    baseUrl: `http://127.0.0.1:${served.port}`,
    token: (world) => (persona) => idp.sign(personaIdentity(world, persona)),
    admin: (sql, params) => db.admin(sql, params),
    async stop() {
      clearInterval(timer);
      await new Promise((ok) => served.server.close(() => ok(undefined)));
      await api.close();
      await svcPool.end();
      await stub.close();
      await db.stop();
      await rm(blobDir, { recursive: true, force: true });
    },
  };
}
