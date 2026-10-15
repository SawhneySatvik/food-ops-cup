// T-082b end-to-end fixture: embedded Postgres 18 + the real core-api, seeded by worldgen through the API (synthetic
// data, no .env, no network beyond 127.0.0.1), whose `POST /v1/ask` calls intel through a bridged AskPort: the port
// writes `{"intel_ask": {id, token, body}}` on stdout and waits for `{"op":"intel_reply", id, status, body}` on stdin.
// The Python side runs intel's real `/ask` app in-process (its sockets are blocked) and calls back into core over the
// same pipe, so lines are handled CONCURRENTLY — a serial loop (tests/watch/core_stack.mts) would deadlock here.
//   node services/intel/tests/manager/ask_stack.mts <days> <world>          (prints {"ready": …} once seeded)
//   {"op":"ask","world","persona","question","thread_id"?}  → {"status","body"}  (core-api's /v1/ask as that member)
//   {"op":"http","method","path","headers","body"}          → {"status","body"}  (core-api's app, in-process)
//   {"op":"sql","q","params"}                               → rows, as the cluster superuser (gate reads only)
//   {"op":"budget"}                                         → core's own effectiveCap for AS_OF's month (T-090; the
//                                                             `intel.ai_budget_left` template the run-frame reads), or null
//   {"op":"frame"}                                          → core's own run-frame for an all-outlet run at the pinned clock
//   {"op":"intel_reply","id","status","body"}               → (no answer; resolves the pending AskPort call)
//   {"op":"stop"}
// AI is on for the world's tenant (intel.enabled + a month budget, as an operator sets them) and core's clock is pinned
// to the worldgen profile's AS_OF, so the run-frame — part of the recorded request — is the same on every run.
// Exits non-zero on any failure (gotcha 33).
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createLogger, loadConfig } from "../../../../packages/config/src/index.ts";
import { startTestDb } from "../../../../db/src/index.ts";
import { TENANT_HEADER } from "../../../../services/core-api/src/app.ts";
import { createLocalIdp } from "../../../../services/core-api/src/auth/local-idp.ts";
import { localBlobStore } from "../../../../services/core-api/src/modules/imports/index.ts";
import { configureThreads } from "../../../../services/core-api/src/modules/threads/index.ts";
import { composeCoreApi, serveApi } from "../../../../services/core-api/src/server.ts";
import { configureInternal } from "../../../../services/core-api/src/internal/index.ts";
import { createPool, withContext } from "../../../../services/core-api/src/lib/db.ts";
import { effectiveCap } from "../../../../services/core-api/src/modules/ai_policy/index.ts";
import { runFrame } from "../../../../services/core-api/src/internal/frame.ts";
import { parsePendingImports } from "../../../../services/core-worker/src/imports/index.ts";
import { startIntelStub } from "../../../../scripts/dev/intel-stub.ts";
import { personaIdentity } from "../../../../tools/worldgen/src/api.ts";
import { runWorld, type WorldName } from "../../../../tools/worldgen/src/run.ts";

const SECRET = "t082b-stack-service-secret-not-real-0123456789";
/** The worldgen gate profile's fixed outlet-local "today" (tools/worldgen/test/profile.ts). */
const AS_OF = "2026-10-10";

type Req = { op: string; [k: string]: unknown };
const say = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);

async function main() {
  const days = Number(process.argv[2]);
  const world = process.argv[3] as WorldName;
  const db = await startTestDb();
  const stub = await startIntelStub();
  const blobDir = await mkdtemp(join(tmpdir(), "t082b-blobs-"));
  const url = (role: string) => `postgresql://${role}:${db.password}@127.0.0.1:${db.port}/${db.database}`;
  const config = loadConfig({ env: {} });
  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const idp = createLocalIdp();
  const blobs = localBlobStore(blobDir);
  const api = await composeCoreApi({
    coreUrl: url("munim_core"), svcUrl: url("munim_svc"), listenUrl: url("munim_core"), idp, config, log: createLogger(config, () => {}), blobs,
    keys: { privateKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKeyPem },
    intelUrl: stub.url, serviceSecret: SECRET,
  });
  configureInternal(api.deps, { serviceSecret: SECRET, keys: api.keys, watchWindowMs: 0, clock: () => new Date(`${AS_OF}T06:30:00Z`) });
  const served = await serveApi(api.app, 0);
  const svcPool = createPool(url("munim_svc"), 2);
  const timer = setInterval(() => void parsePendingImports({ pool: svcPool, blobs, log: () => {} }).catch(() => {}), 150);

  // The bridged AskPort (replaces the HTTP one composeCoreApi wired): one pending call per id.
  const pending = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
  let next = 0;
  configureThreads(api.deps, {
    keys: api.keys,
    intel: (token, body) => new Promise((ok, fail) => {
      const id = next++;
      pending.set(id, { ok, fail });
      say({ intel_ask: { id, token, body } });
    }),
  });

  let tenant = "";
  try {
    const r = await runWorld({ world, asOf: AS_OF, days, baseUrl: `http://127.0.0.1:${served.port}`, token: (p) => idp.sign(personaIdentity(world, p)) });
    tenant = r.api.tenantId!;
    clearInterval(timer);
    const currency = (await db.admin(`SELECT base_currency FROM core.tenant WHERE tenant_id = $1`, [tenant])).rows[0]!.base_currency as string;
    await db.admin(`UPDATE platform.feature_flag SET value = 'true' WHERE key = 'intel.enabled'`);
    await db.admin(`INSERT INTO platform.llm_budget (tenant_id, month, limit_minor, currency) VALUES ($1, $2, 100000000, $3)`,
      [tenant, `${AS_OF.slice(0, 8)}01`, currency]);
    say({ ready: true, tenant, public_key_pem: publicKeyPem, secret: SECRET, as_of: AS_OF });

    const handle = async (m: Req): Promise<unknown> => {
      if (m.op === "ask") {
        const res = await api.app.request("/v1/ask", {
          method: "POST",
          headers: { Authorization: `Bearer ${idp.sign(personaIdentity(world, m.persona as string))}`, [TENANT_HEADER]: tenant, "content-type": "application/json" },
          body: JSON.stringify({ question: m.question, ...(m.thread_id ? { thread_id: m.thread_id } : {}) }),
        });
        return { status: res.status, body: await res.text() };
      }
      if (m.op === "http") {
        const res = await api.app.request(m.path as string, {
          method: m.method as string, headers: m.headers as Record<string, string>, ...(m.body === undefined || m.body === null ? {} : { body: m.body as string }),
        });
        return { status: res.status, body: await res.text() };
      }
      if (m.op === "sql") return (await db.admin(m.q as string, (m.params as unknown[]) ?? [])).rows;
      if (m.op === "budget") {
        return withContext(svcPool, { tenant_id: tenant, outlet_ids: "*", role: "service" }, (q) => effectiveCap(q, AS_OF.slice(0, 7)));
      }
      if (m.op === "frame") {
        const run = { tenantId: tenant, runId: "01920000-0000-7000-8000-00000000f4a3", scope: ["*"] as ["*"], actor: "manager", trigger: "ask" as const };
        return withContext(svcPool, { tenant_id: tenant, outlet_ids: "*", role: "service" }, (q) => runFrame(q, run, new Date(`${AS_OF}T06:30:00Z`)));
      }
      throw new Error(`unknown op ${m.op}`);
    };

    await new Promise<void>((done, fail) => {
      const rl = createInterface({ input: process.stdin });
      rl.on("line", (line) => {
        const m = JSON.parse(line) as Req;
        if (m.op === "stop") return void (rl.close(), done());
        if (m.op === "intel_reply") {
          const p = pending.get(m.id as number);
          pending.delete(m.id as number);
          if (m.status === 200) p?.ok(JSON.parse(m.body as string));
          else p?.fail(new Error(`intel /ask: HTTP ${m.status}`));
          return;
        }
        handle(m).then((out) => say({ ok: out }), fail);
      });
      rl.on("close", () => done());
    });
  } finally {
    clearInterval(timer);
    await new Promise((ok) => served.server.close(() => ok(undefined)));
    await api.close();
    await svcPool.end();
    await stub.close();
    await db.stop();
    await rm(blobDir, { recursive: true, force: true });
  }
}

main().then(() => process.exit(0), (e) => {
  console.error("ask_stack failed:", e);
  process.exit(1);
});
