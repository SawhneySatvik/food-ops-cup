// T-043 end-to-end fixture: embedded Postgres 18 + the real core-api, seeded by worldgen through the API (synthetic
// data, no .env, no network beyond 127.0.0.1), then driven by intel's Python pipeline over a JSON-lines bridge on
// stdin/stdout — intel's tests block sockets, so its InternalClient talks to core through `app.request` in-process.
//   node services/intel/tests/watch/core_stack.mts <days> <world>...      (prints {"ready": …} once seeded)
// Each stdin line is one request; each stdout line its answer:
//   {"op":"http","method","path","headers","body"}        → {"status","body"}  (core-api's own app, in-process)
//   {"op":"token","world","trigger","scope":["*"]|[ids]}   → {"token","run_id"}  (core's real mintRunToken)
//   {"op":"frame","world","narration"}                     → the tenant's pack document + outlets, as run-frame would give
//   {"op":"event","world","type","outlet"}                 → a CloudEvent built from that tenant's latest outbox row of the type
//   {"op":"visible","world","outlet"}                      → finding ids a manager of that one outlet sees (RLS)
//   {"op":"id","world","key"}                              → worldgen's seed id for a key (e.g. "outlet:1")
//   {"op":"sql","q","params"}                              → rows, as the cluster superuser (gate counts only)
//   {"op":"stop"}
// The watch window is 0 (04 §5: "0 in tests") so every watch:claim goes. Exits non-zero on any failure (gotcha 33).
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createLogger, loadConfig } from "../../../../packages/config/src/index.ts";
import { startTestDb } from "../../../../db/src/index.ts";
import { createLocalIdp } from "../../../../services/core-api/src/auth/local-idp.ts";
import { localBlobStore } from "../../../../services/core-api/src/modules/imports/index.ts";
import { composeCoreApi, serveApi } from "../../../../services/core-api/src/server.ts";
import { configureInternal } from "../../../../services/core-api/src/internal/index.ts";
import { eventOutletScope, outboxRowToCloudEvent } from "../../../../services/core-api/src/commit/index.ts";
import { mintRunToken } from "../../../../services/core-api/src/runtoken/index.ts";
import { createPool } from "../../../../services/core-api/src/lib/db.ts";
import { parsePendingImports } from "../../../../services/core-worker/src/imports/index.ts";
import { startIntelStub } from "../../../../scripts/dev/intel-stub.ts";
import { personaIdentity } from "../../../../tools/worldgen/src/api.ts";
import { idOf } from "../../../../tools/worldgen/src/ids.ts";
import { DEFAULT_SEED, runWorld, type WorldName } from "../../../../tools/worldgen/src/run.ts";

const SECRET = "t043-stack-service-secret-not-real-0123456789";
/** The worldgen gate profile's fixed outlet-local "today" (tools/worldgen/test/profile.ts). */
const AS_OF = "2026-10-10";

type Req = { op: string; [k: string]: unknown };

async function main() {
  const days = Number(process.argv[2]);
  const worlds = process.argv.slice(3) as WorldName[];
  const db = await startTestDb();
  const stub = await startIntelStub();
  const blobDir = await mkdtemp(join(tmpdir(), "t043-blobs-"));
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
  // T-040b: the run-frame's clock is pinned to noon IST on AS_OF, so core's business dates equal the profile's "today".
  configureInternal(api.deps, { serviceSecret: SECRET, keys: api.keys, watchWindowMs: 0, clock: () => new Date(`${AS_OF}T06:30:00Z`) });
  const served = await serveApi(api.app, 0);
  const svcPool = createPool(url("munim_svc"), 2);
  const timer = setInterval(() => void parsePendingImports({ pool: svcPool, blobs, log: () => {} }).catch(() => {}), 150);
  const tenants: Record<string, string> = {};
  try {
    for (const world of worlds) {
      const r = await runWorld({ world, asOf: AS_OF, days, baseUrl: `http://127.0.0.1:${served.port}`, token: (p) => idp.sign(personaIdentity(world, p)) });
      tenants[world] = r.api.tenantId!;
    }
    clearInterval(timer);
    console.log(JSON.stringify({ ready: true, tenants, public_key_pem: publicKeyPem, secret: SECRET, as_of: AS_OF }));

    const handle = async (m: Req): Promise<unknown> => {
      if (m.op === "http") {
        const r = await api.app.request(m.path as string, {
          method: m.method as string, headers: m.headers as Record<string, string>, ...(m.body === undefined ? {} : { body: m.body as string }),
        });
        return { status: r.status, body: await r.text() };
      }
      if (m.op === "token") {
        const { token, claims } = await mintRunToken({ ...api.keys, svc: api.svc },
          { tenantId: tenants[m.world as string]!, outletScope: m.scope as ["*"], trigger: m.trigger as "watch_sweep", actor: "watcher:sweep" });
        return { token, run_id: claims.run_id };
      }
      if (m.op === "frame") {
        const tenant = tenants[m.world as string]!;
        const pack = await db.admin(
          `SELECT cp.doc FROM core.tenant t JOIN platform.country_pack cp ON cp.code = t.country_code AND cp.status = 'active'
            WHERE t.tenant_id = $1 ORDER BY cp.version DESC LIMIT 1`, [tenant]);
        const outlets = await db.admin(`SELECT id, kind FROM core.outlet WHERE tenant_id = $1 ORDER BY id`, [tenant]);
        return { pack: pack.rows[0]!.doc, outlets: outlets.rows.map((o) => ({ id: o.id, kind: o.kind, business_date: AS_OF })), narration: m.narration };
      }
      if (m.op === "event") {
        const tenant = tenants[m.world as string]!;
        const r = await db.admin<{ tenant_id: string; id: string; payload: unknown }>(
          `SELECT tenant_id, id, payload FROM core.outbox WHERE tenant_id = $1 AND type = $2 AND payload -> 'data' ->> 'outlet_id' = $3
            ORDER BY created_at DESC, id DESC LIMIT 1`, [tenant, m.type, m.outlet]);
        const row = r.rows[0]!;
        const { token } = await mintRunToken({ ...api.keys, svc: api.svc },
          { tenantId: tenant, outletScope: eventOutletScope(row.payload), trigger: "event", actor: "watcher:events" });
        return outboxRowToCloudEvent(row, token);
      }
      if (m.op === "visible") {
        // What a manager of one outlet sees under RLS (munim_core, SET LOCAL app.* as core-api sets them).
        return db.withContext("munim_core", { tenant_id: tenants[m.world as string]!, outlet_ids: [m.outlet as string], role: "manager" },
          async (c) => (await c.query(`SELECT id::text FROM intel.finding ORDER BY id`)).rows.map((r) => r.id as string));
      }
      if (m.op === "id") return idOf(DEFAULT_SEED, m.world as string, m.key as string);
      if (m.op === "sql") return (await db.admin(m.q as string, (m.params as unknown[]) ?? [])).rows;
      throw new Error(`unknown op ${m.op}`);
    };

    for await (const line of createInterface({ input: process.stdin })) {
      const m = JSON.parse(line) as Req;
      if (m.op === "stop") break;
      console.log(JSON.stringify({ ok: await handle(m) }));
    }
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
  console.error("core_stack failed:", e);
  process.exit(1);
});
