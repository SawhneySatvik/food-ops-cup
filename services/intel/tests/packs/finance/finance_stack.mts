// T-047 end-to-end fixture: T-043's tests/watch/core_stack.mts (embedded Postgres 18 + the real core-api, seeded by
// worldgen through the API; synthetic data, no .env, no network beyond 127.0.0.1) plus the one thing the finance gates
// need that it does not offer: the owner approving a held payout import (RG-F7's ZM-C-H1), through core's own
// `/v1/drafts/{id}:approve` under the owner's identity — never SQL. Same JSON-lines protocol on stdin/stdout:
//   {"op":"http","method","path","headers","body"}     → {"status","body"}  (core-api's own app, in-process)
//   {"op":"token","world","trigger","scope":["*"]}      → {"token","run_id"}
//   {"op":"frame","world","narration"}                  → the tenant's pack document + outlets, as run-frame would give
//   {"op":"id","world","key"}                           → worldgen's seed id for a key (e.g. "outlet:1")
//   {"op":"approve_held","world","filename"}            → the owner approves the held import of that file: {"status"}
//   {"op":"approve_draft","world","draft_id","command_type"} → the owner approves that draft as proposed: {"status","body"}
//   {"op":"sql","q","params"}                           → rows ([] for a multi-statement script), as the cluster superuser
//   {"op":"stop"}
//   node services/intel/tests/packs/finance/finance_stack.mts <days> <world>...
// The watch window is 0 and core's clock is pinned to the profile's AS_OF. Exits non-zero on any failure (gotcha 33).
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { createLogger, loadConfig } from "../../../../../packages/config/src/index.ts";
import { startTestDb } from "../../../../../db/src/index.ts";
import { createLocalIdp } from "../../../../../services/core-api/src/auth/local-idp.ts";
import { localBlobStore } from "../../../../../services/core-api/src/modules/imports/index.ts";
import { composeCoreApi, serveApi } from "../../../../../services/core-api/src/server.ts";
import { configureInternal } from "../../../../../services/core-api/src/internal/index.ts";
import { mintRunToken } from "../../../../../services/core-api/src/runtoken/index.ts";
import { createPool } from "../../../../../services/core-api/src/lib/db.ts";
import { parsePendingImports } from "../../../../../services/core-worker/src/imports/index.ts";
import { startIntelStub } from "../../../../../scripts/dev/intel-stub.ts";
import type { Api } from "../../../../../tools/worldgen/src/api.ts";
import { personaIdentity } from "../../../../../tools/worldgen/src/api.ts";
import { idOf } from "../../../../../tools/worldgen/src/ids.ts";
import { DEFAULT_SEED, runWorld, type WorldName } from "../../../../../tools/worldgen/src/run.ts";

const SECRET = "t047-stack-service-secret-not-real-0123456789";
/** The worldgen gate profile's fixed outlet-local "today" (tools/worldgen/test/profile.ts). */
const AS_OF = "2026-10-10";

type Req = { op: string; [k: string]: unknown };

async function main() {
  const days = Number(process.argv[2]);
  const worlds = process.argv.slice(3) as WorldName[];
  const db = await startTestDb();
  const stub = await startIntelStub();
  const blobDir = await mkdtemp(join(tmpdir(), "t047-blobs-"));
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
  const tenants: Record<string, string> = {};
  const apis: Record<string, Api> = {};
  try {
    for (const world of worlds) {
      const r = await runWorld({ world, asOf: AS_OF, days, baseUrl: `http://127.0.0.1:${served.port}`, token: (p) => idp.sign(personaIdentity(world, p)) });
      tenants[world] = r.api.tenantId!;
      apis[world] = r.api;
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
      if (m.op === "approve_held") {
        // The held file's import run is previewed with its commit draft proposed; the owner approves it as worldgen does.
        const world = m.world as string;
        const r = await db.admin<{ draft_id: string }>(
          `SELECT d.id::text AS draft_id FROM core.import_run ir JOIN core.document doc ON doc.tenant_id = ir.tenant_id AND doc.id = ir.document_id
             JOIN core.draft d ON d.tenant_id = ir.tenant_id AND d.id = ir.draft_id
            WHERE ir.tenant_id = $1 AND doc.filename = $2 AND ir.status = 'previewed' AND d.status = 'proposed'`, [tenants[world], m.filename]);
        if (r.rows.length !== 1) throw new Error(`approve_held: ${r.rows.length} held drafts for ${String(m.filename)}`);
        const draft = r.rows[0]!.draft_id;
        const out = await apis[world]!.cmd("owner", "/v1/drafts/{id}:approve", "drafts.approve.v1", `t047:approve:${String(m.filename)}`, {
          draft_id: draft, command_type: "imports.run.commit.v1", edited_payload: null, reason: null,
        }, { params: { id: draft } });
        return { status: out.status };
      }
      if (m.op === "approve_draft") {
        // R-B S1-C pairing: the owner approves an intel dispute draft through core's own route (never SQL).
        const draft = m.draft_id as string;
        const out = await apis[m.world as string]!.cmd("owner", "/v1/drafts/{id}:approve", "drafts.approve.v1", `fintel:approve:${draft}`, {
          draft_id: draft, command_type: m.command_type as string, edited_payload: null, reason: null,
        }, { params: { id: draft }, expect: [200, 201, 409, 422] });
        return { status: out.status, body: out.body };
      }
      if (m.op === "id") return idOf(DEFAULT_SEED, m.world as string, m.key as string);
      if (m.op === "sql") {
        // A multi-statement script (the template fixture) answers with one result per statement: no rows to return.
        const r = await db.admin(m.q as string, (m.params as unknown[]) ?? []);
        return Array.isArray(r) ? [] : r.rows;
      }
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
  console.error("finance_stack failed:", e);
  process.exit(1);
});
