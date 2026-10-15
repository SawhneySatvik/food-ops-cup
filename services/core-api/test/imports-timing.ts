// Import-commit timing (h-1, R44c). Everything happens in ONE transaction on an admin connection that is always
// rolled back: the run is created as munim_core, parsed as munim_svc (SET LOCAL ROLE), approved and committed as the
// tenant's owner under a real decision — the same SQL the app runs, so it can be pointed at the hosted dev database
// without leaving a row behind. Measures the commit handler only: queries sent and wall time.
//   node services/core-api/test/imports-timing.ts hosted <kind> <bills> [unbatched]   (hosted, via packages/config)
// The embedded-PG run is the vitest gate imports-history.test.ts ("timing").
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type pg from "pg";
import { uuidv7 } from "../src/commit/index.ts";
import type { BlobStore } from "../src/modules/imports/index.ts";
import { commitRun, parseRun } from "../src/modules/imports/index.ts";

export interface Timing { kind: string; rows_ok: number; quarantined: number; queries: number; ms: number; per_row_ms: number; per_row_queries: number }

const memBlobs = (bytes: Uint8Array): BlobStore => ({ put: async () => {}, get: async () => bytes });

async function setCtx(c: pg.ClientBase, ctx: Record<string, string>) {
  for (const [k, v] of Object.entries(ctx)) await c.query(`SELECT set_config($1, $2, true)`, [`app.${k}`, v]);
}

/** Builds the file from the tenant's facts, runs upload → parse → approve → commit, rolls everything back. */
export async function timeCommit(admin: pg.ClientBase, kind: string, parser: string,
  file: (t: { tenant: string; owner: string; outlet: { id: string; name: string } }) => string, opts: { batched?: boolean; tenant?: string; outlet?: string } = {}): Promise<Timing> {
  await admin.query("BEGIN");
  // Hosted: the admin role may not SET ROLE munim_core / munim_svc (membership without SET); it runs as the tables'
  // owner munim_migrator instead. The guard, RLS and triggers judge app.* settings, not current_user, so the work
  // per row is the same; only the grants are not exercised (the embedded gate exercises them).
  const canSet = (await admin.query<{ ok: boolean }>(`SELECT pg_has_role(current_user, 'munim_core', 'SET') AND pg_has_role(current_user, 'munim_svc', 'SET') AS ok`)).rows[0]!.ok;
  const role = (r: string) => `SET LOCAL ROLE ${canSet ? r : "munim_migrator"}`;
  try {
    const t = (await admin.query<{ tenant: string; owner: string; outlet_id: string; outlet_name: string }>(
      `SELECT t.tenant_id AS tenant, m.member_id AS owner, o.id AS outlet_id, o.name AS outlet_name
         FROM core.tenant t
         JOIN core.membership m ON m.tenant_id = t.tenant_id AND m.role = 'owner'
         JOIN LATERAL (SELECT id, name FROM core.outlet WHERE tenant_id = t.tenant_id AND ($2::uuid IS NULL OR id = $2) ORDER BY created_at, id LIMIT 1) o ON true
        WHERE ($1::uuid IS NULL OR t.tenant_id = $1)
          AND EXISTS (SELECT 1 FROM core.channel ch WHERE ch.tenant_id = t.tenant_id AND ch.kind = 'counter' AND ch.active)
          AND EXISTS (SELECT 1 FROM core.account a WHERE a.tenant_id = t.tenant_id AND a.code = '1110')
        ORDER BY t.created_at, t.tenant_id LIMIT 1`, [opts.tenant ?? null, opts.outlet ?? null])).rows[0];
    if (!t) throw new Error("timing: no tenant with a counter channel and a chart");
    const bytes = new TextEncoder().encode(file({ tenant: t.tenant, owner: t.owner, outlet: { id: t.outlet_id, name: t.outlet_name } }));
    const sha = createHash("sha256").update(bytes).digest("hex");
    const owner = { tenant_id: t.tenant, outlet_ids: "{*}", role: "owner", member_id: t.owner };

    // A database without 0018 (hosted, until the founder applies it): core.write_derived exactly as 0018 creates it,
    // inside this transaction, so it is rolled back with everything else. Nothing else of 0018 is needed by pos_export.
    if (!(await admin.query<{ f: string | null }>(`SELECT to_regprocedure('core.write_derived(jsonb)')::text AS f`)).rows[0]!.f) {
      const sql = readFileSync(new URL("../../../db/migrations/0018_history_imports.sql", import.meta.url), "utf8");
      await admin.query("SET LOCAL ROLE munim_migrator");
      await admin.query(/CREATE FUNCTION core\.write_derived[\s\S]*?\nEND \$\$;/.exec(sql)![0]);
      await admin.query(`GRANT EXECUTE ON FUNCTION core.write_derived(jsonb) TO munim_core`);
    }
    await admin.query(role("munim_core"));
    await setCtx(admin, owner);
    const docId = uuidv7();
    const runId = uuidv7();
    await admin.query(
      `INSERT INTO core.document (tenant_id, id, kind, media_type, filename, byte_size, sha256, storage_ref, uploaded_by)
       VALUES ($1, $2, $3, 'text/csv', 'timing.csv', $4, $5, $6, $7)`, [t.tenant, docId, kind, bytes.length, sha, `${t.tenant}/${sha}`, t.owner]);
    await admin.query(`INSERT INTO core.import_run (tenant_id, id, document_id, kind, parser, created_by) VALUES ($1, $2, $3, $4, $5, $6)`,
      [t.tenant, runId, docId, kind, parser, t.owner]);

    await admin.query(role("munim_svc"));
    await setCtx(admin, { role: "service", member_id: "" });
    if ((await parseRun(admin, memBlobs(bytes), runId)) !== "previewed") throw new Error("timing: parse did not preview");
    const run = (await admin.query<{ draft_id: string; rows_ok: number; rows_quarantined: number }>(
      `SELECT draft_id, rows_ok, rows_quarantined FROM core.import_run WHERE id = $1`, [runId])).rows[0]!;

    await admin.query(role("munim_core"));
    await setCtx(admin, { ...owner, command_type: "" });
    await admin.query(`UPDATE core.draft SET status = 'executing', exec_txid = txid_current() WHERE id = $1 AND status = 'proposed'`, [run.draft_id]);
    const decisionId = uuidv7();
    await admin.query(`INSERT INTO core.decision (tenant_id, id, draft_id, verdict, final_payload, reason, decided_by) VALUES ($1, $2, $3, 'approved', $4, 'timing', $5)`,
      [t.tenant, decisionId, run.draft_id, { import_run_id: runId }, t.owner]);
    await admin.query(`SELECT set_config('app.decision_id', $1, true)`, [decisionId]);

    let queries = 0;
    const counted = { query: (...a: Parameters<pg.ClientBase["query"]>) => { queries++; return (admin.query as (...x: unknown[]) => unknown)(...a); } } as unknown as pg.ClientBase;
    const env = { command_id: uuidv7(), idempotency_key: `timing-${uuidv7()}`, type: "imports.run.commit.v1", payload: { import_run_id: runId } };
    const t0 = performance.now();
    await commitRun(counted, env, opts.batched === false ? "seams" : "batched");
    // The deferred balance triggers fire at COMMIT; fire them here so their cost is inside the measurement.
    await admin.query(`SET CONSTRAINTS ALL IMMEDIATE`);
    const ms = performance.now() - t0;
    return { kind, rows_ok: run.rows_ok, quarantined: run.rows_quarantined, queries, ms: Math.round(ms),
      per_row_ms: Number((ms / Math.max(run.rows_ok, 1)).toFixed(2)), per_row_queries: Number((queries / Math.max(run.rows_ok, 1)).toFixed(2)) };
  } finally {
    await admin.query("ROLLBACK");
  }
}

/** A pos_export_v1 file of `n` bills over the 20 days before `today` (UTC date), every row valid. */
export function posExportV1(n: number, outlet: string, today = new Date()): string {
  const rows = [["Bill No", "Bill Date", "Outlet", "Order Type", "Payment Mode", "Subtotal", "Discount", "Tax", "Total"].join(",")];
  const tag = uuidv7().slice(-8);
  for (let i = 0; i < n; i++) {
    const d = new Date(today.getTime() - (2 + (i % 20)) * 86_400_000).toISOString().slice(0, 10);
    const sub = 10000 + (i % 37) * 500;
    const tax = Math.round(sub * 0.05);
    const pay = ["cash", "upi", "card"][i % 3]!;
    rows.push([`T${tag}-${i + 1}`, d, `"${outlet.replaceAll('"', '""')}"`, "takeaway", pay, (sub / 100).toFixed(2), "0.00", (tax / 100).toFixed(2), ((sub + tax) / 100).toFixed(2)].join(","));
  }
  return `${rows.join("\n")}\n`;
}

// CLI: hosted timing through packages/config (never reads .env itself).
if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , where, kind = "pos_export", nArg = "100", mode] = process.argv;
  if (where !== "hosted") throw new Error("usage: imports-timing.ts hosted <kind> <bills> [unbatched]");
  const { loadRepoConfig } = await import("@munim/config");
  const { default: pgm } = await import("pg");
  const cfg = loadRepoConfig(new URL("../../../", import.meta.url).pathname);
  const admin = new pgm.Client({ connectionString: cfg.require("MUNIM_DB_URL_SESSION"), ssl: { rejectUnauthorized: false } });
  await admin.connect();
  try {
    const files: Record<string, [string, (n: number, outlet: string) => string]> = { pos_export: ["pos_export_v1", posExportV1] };
    const [parser, gen] = files[kind]!;
    const r = await timeCommit(admin, kind, parser, (t) => gen(Number(nArg), t.outlet.name), { batched: mode !== "unbatched" });
    console.log(JSON.stringify({ where: "hosted", ...r }));
  } catch (e) {
    console.error(cfg.redact(String((e as Error).stack ?? e)));
    process.exitCode = 1;
  } finally {
    await admin.end();
  }
}
