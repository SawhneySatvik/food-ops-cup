// T-058 fixture: embedded Postgres 18 (migrated) + two canonical worlds (tenants A and B) + core-api's own batch writers
// (writeEntities / writeClaims / writeEdges, the code behind /internal/intel/v1/*:batch), driven from Python over
// stdin/stdout JSON lines — intel's tests block sockets. Exits non-zero on any failure (gotcha 33).
//   {"op":"write","world","what":"entities"|"claims"|"edges","body"}  → {inserted, existing}   (munim_svc, tenant's context)
//   {"op":"read","world","sql","params","as":"svc"|"admin"}           → rows. `sql` uses :name parameters; `:tenant_id` is bound
//        here from the world — the stand-in for core binding it from the run token. "svc" runs under RLS (munim_svc,
//        SET LOCAL app.tenant_id); "admin" is the superuser, which bypasses RLS, so only the SQL's own predicate isolates.
//   {"op":"count","world","table"}                                     → rows of intel.<table> for that tenant (admin)
//   {"op":"stop"}
import { createInterface } from "node:readline";
import { buildWorld, startTestDb } from "../../../../db/src/index.ts";
import { writeClaims, writeEdges, writeEntities } from "../../../../services/core-api/src/internal/batches.ts";

type Req = { op: string; [k: string]: unknown };

/** `:name` -> `$n`, the same name always the same `$n`; `::cast` is left alone; `--` comments are dropped first (a `:name` in
 *  a comment would otherwise take a `$n` that nothing types). */
function positional(sql: string, params: Record<string, unknown>): { text: string; values: unknown[] } {
  const order: string[] = [];
  const text = sql.replace(/--.*$/gm, "").replace(/(?<!:):([a-z_]+)/g, (_, name: string) => {
    if (!(name in params)) throw new Error(`parameter :${name} not bound`);
    if (!order.includes(name)) order.push(name);
    return `$${order.indexOf(name) + 1}`;
  });
  return { text, values: order.map((n) => params[n]) };
}

async function main() {
  const db = await startTestDb();
  try {
    const worlds: Record<string, Awaited<ReturnType<typeof buildWorld>>> = {};
    worlds.A = await buildWorld(db);
    worlds.B = await buildWorld(db);
    const ctx = (w: string) => ({ tenant_id: worlds[w]!.tenant, outlet_ids: "*" as const, role: "service" });
    console.log(JSON.stringify({ ready: Object.fromEntries(Object.entries(worlds).map(([k, w]) => [k, { tenant: w.tenant, message: w.message, message_body: w.messageBody }])) }));

    const handle = async (m: Req): Promise<unknown> => {
      const w = worlds[m.world as string]!;
      if (m.op === "write") {
        const run = { tenantId: w.tenant, runId: w.run, scope: ["*"] as ["*"], actor: "watcher:test", trigger: "watch_sweep" as const };
        const fn = { entities: writeEntities, claims: writeClaims, edges: writeEdges }[m.what as "entities"];
        return db.withContext("munim_svc", ctx(m.world as string), (c) => fn(c, run, m.body));
      }
      if (m.op === "read") {
        const { text, values } = positional(m.sql as string, { ...(m.params as object), tenant_id: w.tenant });
        if (m.as === "admin") return (await db.admin(text, values)).rows;
        return db.withContext("munim_svc", ctx(m.world as string), async (c) => (await c.query(text, values)).rows);
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
    await db.stop();
  }
}

main().then(() => process.exit(0), (e) => {
  console.error("pg_bridge failed:", e);
  process.exit(1);
});
