// T-042 round-trip (test fixture): replays the `traces:batch` bodies intel's TraceBuffer sent (a JSON array of request
// bodies, path in argv[2]) through the real core-api app on embedded Postgres — run token + service secret →
// munim_svc under the token's RLS → `writeTraces` → intel.trace_event. Then sends every body a second time (a flush
// retried after lost responses). Prints one JSON object on stdout; exits non-zero on any failure (gotcha 33: the
// harness fixes embedded-postgres' exit hook, and main() sets the exit code itself). No .env, no .run.
//   node services/intel/tests/trace/core_roundtrip.mts <bodies.json>
import { readFileSync } from "node:fs";
import { createLogger } from "../../../../packages/config/src/index.ts";
import { buildWorld, startTestDb } from "../../../../db/src/index.ts";
import { createApp, type Deps } from "../../../core-api/src/app.ts";
import { IdpError } from "../../../core-api/src/auth/port.ts";
import { svcTx, testKeys } from "../../../core-api/src/commit/testkit.ts";
import { configureInternal } from "../../../core-api/src/internal/index.ts";
import { mintRunToken } from "../../../core-api/src/runtoken/index.ts";

const SECRET = "t042-roundtrip-service-secret-not-real-0123456789";
// Only internal routes are called (run token + service secret); no member token is ever verified here.
const noMembers: Deps["idp"] = { verify: async () => { throw new IdpError("no member tokens in this fixture"); } };

async function main() {
  const bodies = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as unknown[];
  const db = await startTestDb();
  try {
    const w = await buildWorld(db);
    const keys = testKeys();
    const pools = { core: db.pool("munim_core", 2), svc: db.pool("munim_svc", 2) };
    const config = { nodeEnv: "test", redact: (s: string) => s };
    const deps: Deps = { pools, idp: noMembers, storefronts: async () => null, config, log: createLogger(config, () => {}) };
    const app = await createApp(deps);
    configureInternal(deps, { serviceSecret: SECRET, keys, watchWindowMs: 60_000 });
    const { token, claims } = await mintRunToken({ ...keys, svc: svcTx(db) },
      { tenantId: w.tenant, outletScope: ["*"], trigger: "ask", actor: "brief" });
    const send = async (body: unknown) => {
      const r = await app.request("/internal/intel/v1/traces:batch", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "x-munim-service-secret": SECRET, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: await r.json() };
    };
    const first = [];
    for (const b of bodies) first.push(await send(b));
    const retry = [];
    for (const b of bodies) retry.push(await send(b));
    const rows = await db.admin(`SELECT seq, actor, kind FROM intel.trace_event WHERE run_id = $1 ORDER BY seq`, [claims.run_id]);
    for (const p of Object.values(pools)) await p.end();
    console.log(JSON.stringify({ first, retry, rows: rows.rows }));
  } finally {
    await db.stop();
  }
}

main().then(() => process.exit(0), (e) => {
  console.error("core_roundtrip failed:", e);
  process.exit(1);
});
