// T-058 fixture: embedded Postgres 18 (migrated) + two canonical worlds (tenants A and B) + core-api's own app, driven from
// Python over stdin/stdout JSON lines — intel's tests block sockets. Exits non-zero on any failure (gotcha 33).
//   {"op":"write","world","what":"entities"|"claims"|"edges","body"}  → {inserted, existing}   (munim_svc, tenant's context)
//   {"op":"http","world","method","path","headers","body"}            → {status, body}: core-api's real app in-process; the
//        bridge adds the world's run token and the service secret (InternalClient's transport, tests/watch/stack.py Bridge)
//   {"op":"admin_graph","world","template","args"}                     → rows of core's own graph statement (graph/index.ts
//        graphStatement, `:tenant_id` bound from the world) run as the cluster superuser, which bypasses RLS: only each
//        template's `tenant_id = :tenant_id` predicates isolate the tenant there
//   {"op":"count","world","table"}                                     → rows of intel.<table> for that tenant (admin)
//   {"op":"stop"}
import { createInterface } from "node:readline";
import { createLogger } from "../../../../packages/config/src/index.ts";
import { buildWorld, startTestDb } from "../../../../db/src/index.ts";
import { createLocalIdp } from "../../../../services/core-api/src/dev-root.ts";
import { createApp, type Deps } from "../../../../services/core-api/src/app.ts";
import { svcTx, testKeys } from "../../../../services/core-api/src/commit/testkit.ts";
import { writeClaims, writeEdges, writeEntities } from "../../../../services/core-api/src/internal/batches.ts";
import { graphStatement } from "../../../../services/core-api/src/internal/graph/index.ts";
import { configureInternal } from "../../../../services/core-api/src/internal/index.ts";
import { mintRunToken } from "../../../../services/core-api/src/runtoken/index.ts";

type Req = { op: string; [k: string]: unknown };
const SECRET = "t058-bridge-service-secret-not-real-0123456789";

async function main() {
  const db = await startTestDb();
  const pools = { core: db.pool("munim_core", 2), svc: db.pool("munim_svc", 2) };
  try {
    const worlds: Record<string, Awaited<ReturnType<typeof buildWorld>>> = {};
    worlds.A = await buildWorld(db);
    worlds.B = await buildWorld(db);
    const keys = testKeys();
    const config = { nodeEnv: "test", redact: (s: string) => s };
    const deps: Deps = { pools, idp: createLocalIdp(), storefronts: async () => null, config, log: createLogger(config, () => {}) };
    const app = await createApp(deps);
    configureInternal(deps, { serviceSecret: SECRET, keys, watchWindowMs: 0 });
    const tokens: Record<string, string> = {};
    for (const [k, w] of Object.entries(worlds)) {
      tokens[k] = (await mintRunToken({ ...keys, svc: svcTx(db) }, { tenantId: w.tenant, outletScope: ["*"], trigger: "ask", actor: w.owner })).token;
    }
    const ctx = (w: string) => ({ tenant_id: worlds[w]!.tenant, outlet_ids: "*" as const, role: "service" });
    console.log(JSON.stringify({ ready: Object.fromEntries(Object.entries(worlds).map(([k, w]) => [k, { tenant: w.tenant, message: w.message, message_body: w.messageBody }])) }));

    const handle = async (m: Req): Promise<unknown> => {
      const w = worlds[m.world as string]!;
      if (m.op === "write") {
        const run = { tenantId: w.tenant, runId: w.run, scope: ["*"] as ["*"], actor: "watcher:test", trigger: "watch_sweep" as const };
        const fn = { entities: writeEntities, claims: writeClaims, edges: writeEdges }[m.what as "entities"];
        return db.withContext("munim_svc", ctx(m.world as string), (c) => fn(c, run, m.body));
      }
      if (m.op === "http") {
        const headers = { ...(m.headers as Record<string, string>), authorization: `Bearer ${tokens[m.world as string]}`, "x-munim-service-secret": SECRET };
        const r = await app.request(m.path as string, { method: m.method as string, headers, ...(m.body ? { body: m.body as string } : {}) });
        return { status: r.status, body: await r.text() };
      }
      if (m.op === "admin_graph") {
        const { text, values } = graphStatement(m.template as string, m.args as Record<string, unknown>, w.tenant);
        return (await db.admin(text, values)).rows;
      }
      if (m.op === "count") {
        const t = m.table as string;
        if (!["entity", "edge", "claim"].includes(t)) throw new Error("bad table");
        return (await db.admin(`SELECT count(*)::int AS n FROM intel.${t} WHERE tenant_id = $1`, [w.tenant])).rows[0]!.n;
      }
      throw new Error(`unknown op ${m.op}`);
    };

    for await (const line of createInterface({ input: process.stdin })) {
      const m = JSON.parse(line) as Req;
      if (m.op === "stop") break;
      try {
        console.log(JSON.stringify({ ok: await handle(m) }));
      } catch (e) {
        console.log(JSON.stringify({ error: String((e as Error).message ?? e) }));
      }
    }
  } finally {
    await pools.core.end();
    await pools.svc.end();
    await db.stop();
  }
}

main().then(() => process.exit(0), (e) => {
  console.error("pg_bridge failed:", e);
  process.exit(1);
});
