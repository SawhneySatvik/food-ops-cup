// T-089b wiring: composeWorker schedules the two Auto jobs on its munim_svc pool (every minute for import commits,
// daily at 00:00 UTC); one tenant's failure is logged with ids and
// a label only and the pass goes on. The resume logic and its gates run against the database in
// services/core-api/test/investigations-auto.test.ts (through autoPass).
import { generateKeyPairSync } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import type { AutoTally } from "../../core-api/src/modules/investigations/index.ts";
import { loadRunTokenKeys } from "../../core-api/src/runtoken/index.ts";
import { autoDailyJob, autoImportJob, autoPass } from "../src/investigations/index.ts";
import { composeWorker } from "../src/main.ts";

const k = generateKeyPairSync("ed25519");
const pem = { privateKeyPem: k.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKeyPem: k.publicKey.export({ type: "spki", format: "pem" }).toString() };
const keys = loadRunTokenKeys(pem);
const ZERO: AutoTally = { resumed: 0, steps: 0, cancelled: 0, budget: 0, ceiling: 0 };

describe("Auto jobs", () => {
  it("composeWorker registers investigations-auto-imports (1 min) and investigations-auto-daily (1440 min) after the import parser", async () => {
    const c = composeWorker({ svcUrl: "postgresql://munim_svc:x@127.0.0.1:1/none", keys: pem, intelUrl: "http://127.0.0.1:1", serviceSecret: "s".repeat(40), log: () => {} });
    expect(c.worker.cron.jobNames.slice(-3)).toEqual(["imports-parse", "investigations-auto-imports", "investigations-auto-daily"]);
    await c.worker.stop(1000);
    await c.close();
  });

  it("one tenant's error is logged (ids, label) and the next tenant still runs", async () => {
    const pool = new pg.Pool({ connectionString: "postgresql://munim_svc:x@127.0.0.1:1/none" });
    const logs: Array<[string, unknown]> = [];
    const seen: string[] = [];
    const d = { pool, keys, narrate: null, log: (e: string, f?: unknown) => void logs.push([e, f]) };
    const sum = await autoPass(d, async (_deps, tenant) => {
      seen.push(tenant);
      if (tenant === "t1") throw Object.assign(new Error("secret text"), { code: "MB015" });
      return { ...ZERO, resumed: 1, steps: 2 };
    }, ["t1", "t2"]);
    expect([seen, sum]).toEqual([["t1", "t2"], { ...ZERO, resumed: 1, steps: 2 }]);
    expect(logs).toEqual([["investigations.auto_failed", { tenant_id: "t1", error: "MB015" }]]);
    expect([autoImportJob(d).everyMinutes, autoDailyJob(d).everyMinutes]).toEqual([1, 1440]);
    await pool.end();
  });
});
