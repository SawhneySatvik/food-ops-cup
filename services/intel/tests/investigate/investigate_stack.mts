// T-083 end-to-end fixture: embedded Postgres 18 + the real core-api, seeded by worldgen through the API (synthetic data,
// no .env, no network beyond 127.0.0.1), whose investigations module calls intel through a bridged NarratePort: the port
// writes `{"intel_narrate": {id, token, body}}` on stdout and waits for `{"op":"intel_reply", id, status, body}` on stdin.
// The Python side runs intel's real `/investigate:narrate` app in-process and calls back into core over the same pipe, so
// lines are handled CONCURRENTLY (as tests/manager/ask_stack.mts).
//   node services/intel/tests/investigate/investigate_stack.mts <days> <world>     (prints {"ready": …} once seeded)
//   {"op":"as","persona","method","path","body"?}    → {"status","body","replayed"}  (core-api's app, as that member)
//   {"op":"http","method","path","headers","body"}   → {"status","body"}               (intel's callbacks into core)
//   {"op":"sql","q","params"}                        → rows ([] for a multi-statement script), as the cluster superuser
//   {"op":"approve_held","filename"}                 → the owner approves the held import of that file: {"status"}
//   {"op":"import_shifts","months":["2026-08",…]}    → one closed shift per trading outlet-day of those months, through
//                                                      the shift_log_v1 history import the owner approves: {"rows","status"}
//   {"op":"ai","on":bool}                             → intel.enabled, as an operator sets it
//   {"op":"intel_reply","id","status","body"}        → (no answer; resolves the pending NarratePort call)
//   {"op":"stop"}
// AI is on for the world's tenant (intel.enabled + a month budget) and core's clock is pinned to the profile's AS_OF.
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
import { configureInvestigations } from "../../../../services/core-api/src/modules/investigations/index.ts";
import { composeCoreApi, serveApi } from "../../../../services/core-api/src/server.ts";
import { configureInternal } from "../../../../services/core-api/src/internal/index.ts";
import { createPool } from "../../../../services/core-api/src/lib/db.ts";
import { parsePendingImports } from "../../../../services/core-worker/src/imports/index.ts";
import { startIntelStub } from "../../../../scripts/dev/intel-stub.ts";
import { personaIdentity } from "../../../../tools/worldgen/src/api.ts";
import { runWorld, type WorldName } from "../../../../tools/worldgen/src/run.ts";

const SECRET = "t083-stack-service-secret-not-real-0123456789";
/** The worldgen gate profile's fixed outlet-local "today" (tools/worldgen/test/profile.ts). */
const AS_OF = "2026-10-10";

type Req = { op: string; [k: string]: unknown };
const say = (o: unknown) => process.stdout.write(`${JSON.stringify(o)}\n`);
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const money = (minor: number) => `${minor < 0 ? "-" : ""}${Math.trunc(Math.abs(minor) / 100)}.${String(Math.abs(minor) % 100).padStart(2, "0")}`;

async function main() {
  const days = Number(process.argv[2]);
  const world = process.argv[3] as WorldName;
  const db = await startTestDb();
  const stub = await startIntelStub();
  const blobDir = await mkdtemp(join(tmpdir(), "t083-blobs-"));
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

  const pending = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
  let next = 0;
  configureInvestigations(api.deps, {
    keys: api.keys,
    narrate: (token, body) => new Promise((ok, fail) => {
      const id = next++;
      pending.set(id, { ok, fail });
      say({ intel_narrate: { id, token, body } });
    }),
  });

  try {
    const r = await runWorld({ world, asOf: AS_OF, days, baseUrl: `http://127.0.0.1:${served.port}`, token: (p) => idp.sign(personaIdentity(world, p)) });
    const wg = r.api;
    const tenant = wg.tenantId!;
    const currency = (await db.admin(`SELECT base_currency FROM core.tenant WHERE tenant_id = $1`, [tenant])).rows[0]!.base_currency as string;
    await db.admin(`UPDATE platform.feature_flag SET value = 'true' WHERE key = 'intel.enabled'`);
    await db.admin(`INSERT INTO platform.llm_budget (tenant_id, month, limit_minor, currency) VALUES ($1, $2, 100000000, $3)`,
      [tenant, `${AS_OF.slice(0, 8)}01`, currency]);
    say({ ready: true, tenant, public_key_pem: publicKeyPem, secret: SECRET, as_of: AS_OF });

    const approve = async (draft: string, key: string) => (await wg.cmd("owner", "/v1/drafts/{id}:approve", "drafts.approve.v1", key, {
      draft_id: draft, command_type: "imports.run.commit.v1", edited_payload: null, reason: null,
    }, { params: { id: draft } })).status;

    const handle = async (m: Req): Promise<unknown> => {
      if (m.op === "as") {
        const res = await api.app.request(m.path as string, {
          method: m.method as string,
          headers: { Authorization: `Bearer ${idp.sign(personaIdentity(world, m.persona as string))}`, [TENANT_HEADER]: tenant, "content-type": "application/json" },
          ...(m.body === undefined || m.body === null ? {} : { body: JSON.stringify(m.body) }),
        });
        return { status: res.status, body: await res.text(), replayed: res.headers.get("x-munim-replayed") };
      }
      if (m.op === "http") {
        const res = await api.app.request(m.path as string, {
          method: m.method as string, headers: m.headers as Record<string, string>, ...(m.body === undefined || m.body === null ? {} : { body: m.body as string }),
        });
        return { status: res.status, body: await res.text() };
      }
      if (m.op === "sql") {
        const out = await db.admin(m.q as string, (m.params as unknown[]) ?? []);
        return Array.isArray(out) ? [] : out.rows;
      }
      if (m.op === "ai") {
        await db.admin(`UPDATE platform.feature_flag SET value = $1 WHERE key = 'intel.enabled'`, [m.on ? "true" : "false"]);
        return {};
      }
      if (m.op === "approve_held") {
        const d = await db.admin<{ draft_id: string }>(
          `SELECT d.id::text AS draft_id FROM core.import_run ir JOIN core.document doc ON doc.tenant_id = ir.tenant_id AND doc.id = ir.document_id
             JOIN core.draft d ON d.tenant_id = ir.tenant_id AND d.id = ir.draft_id
            WHERE ir.tenant_id = $1 AND doc.filename = $2 AND ir.status = 'previewed' AND d.status = 'proposed'`, [tenant, m.filename]);
        if (d.rows.length !== 1) throw new Error(`approve_held: ${d.rows.length} held drafts for ${String(m.filename)}`);
        return { status: await approve(d.rows[0]!.draft_id, `t083:approve:${String(m.filename)}`) };
      }
      if (m.op === "import_shifts") {
        // One drawer session per trading outlet-day, 04:00 → 03:59 local (the business day at a 04:00 cutoff). The file's
        // cash column is a control total core checks against its own figure, so it is read here with core's predicate
        // (imports/shifts.ts cashIn: history-imported, device-less orders' cash tenders − cash refunds in the window).
        const months = m.months as string[];
        const owner = (await db.admin<{ name: string }>(
          `SELECT m.name FROM core.member m JOIN core.membership ms ON ms.tenant_id = m.tenant_id AND ms.member_id = m.id
            WHERE m.tenant_id = $1 AND ms.role = 'owner'`, [tenant])).rows[0]!.name;
        // Cash Tenders may be negative (a cash refund above the day's cash takings — RG North, 18 Aug).
        const days = await db.admin<{ outlet: string; d: string; closed: string; cash: string }>(
          `WITH d AS (
             SELECT DISTINCT o.outlet_id, ou.name, ou.tz, o.business_date FROM core."order" o JOIN core.outlet ou ON ou.tenant_id = o.tenant_id AND ou.id = o.outlet_id
              WHERE o.tenant_id = $1 AND o.status = 'completed' AND to_char(o.business_date, 'YYYY-MM') = ANY ($2::text[])),
           w AS (SELECT d.*, (d.business_date + time '04:00') AT TIME ZONE d.tz AS opened_at, (d.business_date + 1 + time '03:59') AT TIME ZONE d.tz AS closed_at
                   FROM d)
           SELECT w.name AS outlet, w.business_date::text AS d, '03:59' AS closed,
                  ((SELECT coalesce(sum(t.amount_minor), 0) FROM core.tender t JOIN core."order" o ON o.tenant_id = t.tenant_id AND o.id = t.order_id
                     WHERE t.tenant_id = $1 AND t.method = 'cash' AND o.outlet_id = w.outlet_id AND o.device_id IS NULL AND o.pricing_snapshot ? 'import_run_id'
                       AND t.at >= w.opened_at AND t.at <= w.closed_at)
                 - (SELECT coalesce(sum(f.amount_minor), 0) FROM core.refund f JOIN core."order" o ON o.tenant_id = f.tenant_id AND o.id = f.order_id
                     WHERE f.tenant_id = $1 AND f.method = 'cash' AND o.outlet_id = w.outlet_id AND o.device_id IS NULL AND o.pricing_snapshot ? 'import_run_id'
                       AND f.at >= w.opened_at AND f.at <= w.closed_at))::text AS cash
             FROM w ORDER BY w.name, w.business_date`, [tenant, months]);
        const FLOAT = 100_000;
        const csv = ["Shift No,Date,Outlet,Opened At,Closed At,Opened By,Closed By,Float,Counted Cash,Cash Tenders",
          ...days.rows.map((x, i) => `T083-${i + 1},${x.d},${x.outlet},04:00,${x.closed},${owner},${owner},${money(FLOAT)},${money(FLOAT + Number(x.cash))},${money(Number(x.cash))}`)].join("\n");
        const csvLines = csv.split("\n");
        const up = await wg.post("owner", "/v1/imports/documents", {
          kind: "shift_log", filename: `t083-shifts-${months.join("_")}.csv`, media_type: "text/csv", content_base64: Buffer.from(csv, "utf8").toString("base64"),
        });
        const runId = (up.run as { import_run_id: string }).import_run_id;
        let run: Record<string, unknown> = up.run as Record<string, unknown>;
        for (let i = 0; i < 600 && run.status === "parsing"; i++) {
          await sleep(100);
          run = await wg.get("owner", "/v1/imports/runs/{id}", { params: { id: runId } });
        }
        if (run.status !== "previewed" || run.rows_quarantined !== 0) {
          const rows = await wg.get("owner", "/v1/imports/runs/{id}/rows", { params: { id: runId } }) as { quarantined?: Array<{ row_no: number; reason_code: string }> };
          throw new Error(`import_shifts: run ${String(run.status)}, quarantined ${JSON.stringify(rows.quarantined?.map((q) => [q.row_no, q.reason_code, csvLines[q.row_no - 1], csvLines[q.row_no], csvLines[q.row_no + 1]]))}`);
        }
        return { rows: days.rows.length, rows_ok: run.rows_ok, status: await approve(run.draft_id as string, `t083:shifts:${months.join("_")}`) };
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
          else p?.fail(new Error(`intel /investigate:narrate: HTTP ${m.status}`));
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
  console.error("investigate_stack failed:", e);
  process.exit(1);
});
