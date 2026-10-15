// W3.2 gate — POST /internal/intel/v1/drafts refuses a payroll draft outside the country pack's `payroll_scope` at
// proposal time (packs/people.md §6, case P6), through the real app (run token + service secret → munim_svc under the
// token's RLS). Paired: the same proposal from an IN tenant (pack `payroll_scope = drafts`) is stored `proposed`; from
// an AU tenant (`roster_only`) it is 422 `payroll_out_of_scope` with 0 new rows. Hand values: IN.json / AU.json
// `payroll_scope`. Embedded Postgres, no model. Synthetic data only.
import { createLogger } from "@munim/config";
import { Snapshot, snapRef } from "@munim/contracts";
import { DraftsResponse } from "@munim/contracts/internal";
import { buildWorld, type TestDb, uuidv7, type World } from "@munim/db";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalIdp } from "../src/auth/local-idp.ts";
import { createApp, type Deps } from "../src/app.ts";
import { svcTx, testKeys } from "../src/commit/testkit.ts";
import { configureInternal } from "../src/internal/index.ts";
import { mintRunToken } from "../src/runtoken/index.ts";
import { openDb } from "./db.ts";

const keys = testKeys();
const SECRET = "w32-payroll-scope-service-secret-not-real-0123456789";
let db: TestDb;
let pools: { core: pg.Pool; svc: pg.Pool };
let app: Awaited<ReturnType<typeof createApp>>;
let IN: World;
let AU: World;

type Res = Omit<Response, "json"> & { json(): Promise<any> };
const token = async (w: World) =>
  (await mintRunToken({ ...keys, svc: svcTx(db) }, { tenantId: w.tenant, outletScope: ["*"], trigger: "watch_sweep", actor: "watcher:people" })).token;
const intel = async (tok: string, path: string, body: unknown): Promise<Res> =>
  (await app.request(`/internal/intel/v1/${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${tok}`, "x-munim-service-secret": SECRET, "content-type": "application/json" },
    body: JSON.stringify(body),
  })) as Res;
const drafts = async (w: World) => Number((await db.admin(`SELECT count(*) n FROM core.draft WHERE tenant_id = $1`, [w.tenant])).rows[0]!.n);

/** One payroll line per outlet: test-only template (this clone), every amount a cell the proposal cites by ref. */
const TEMPLATE = "test.w32_payroll_line";

async function proposal(w: World, currency: string) {
  const tok = await token(w);
  const r = await intel(tok, "snapshots", { template_id: TEMPLATE, params: { outlet_id: w.outlets[0] } });
  expect(r.status).toBe(201);
  const s = Snapshot.parse(await r.json());
  const ref = (col: string) => snapRef(s.snapshot_id, 0, col);
  const body = {
    draft_id: uuidv7(), pack: "people", command_type: "people.payroll_draft.create.v1",
    payload: { payroll_draft_id: uuidv7(), outlet_id: w.outlets[0], period_month: "2026-09-01", currency,
      lines: [{ staff_id: s.rows[0]!.staff_id, base_minor: ref("base_minor"), overtime_minor: ref("overtime_minor"),
        advance_recovery_minor: ref("advance_recovery_minor"), tips_minor: ref("tips_minor"), net_minor: ref("net_minor") }] },
    outlet_ids: [w.outlets[0]], finding_id: null, evidence: [`snap:${s.snapshot_id}`], based_on: [ref("net_minor")],
  };
  return { tok, body };
}

beforeAll(async () => {
  db = await openDb();
  IN = await buildWorld(db);
  AU = await buildWorld(db, { country: "AU" });
  pools = { core: db.pool("munim_core", 4), svc: db.pool("munim_svc", 4) };
  const config = { nodeEnv: "test", redact: (s: string) => s };
  const deps: Deps = { pools, idp: createLocalIdp(), storefronts: async () => null, config, log: createLogger(config, () => {}) };
  app = await createApp(deps);
  configureInternal(deps, { serviceSecret: SECRET, keys, watchWindowMs: 0 });
  // The outlet's own id stands in for a staff id: the drafts route resolves refs, it does not look the staff member up.
  await db.admin(`INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES ($1, 1, $2, $3, $4, 'manager')`, [
    TEMPLATE,
    `SELECT o.id AS staff_id, 120000::bigint AS base_minor, 0::bigint AS overtime_minor, 0::bigint AS advance_recovery_minor,
            0::bigint AS tips_minor, 120000::bigint AS net_minor FROM core.outlet o WHERE o.id = :outlet_id::uuid`,
    JSON.stringify({ type: "object", required: ["outlet_id"], additionalProperties: false, properties: { outlet_id: { type: "string" } } }),
    JSON.stringify(["base_minor", "overtime_minor", "advance_recovery_minor", "tips_minor", "net_minor"].reduce(
      (cols, name) => [...cols, { name, type: "integer", numeric_source: "core.staff.monthly_salary_minor" }], [{ name: "staff_id", type: "uuid" }] as object[])),
  ]);
});

afterAll(async () => {
  await pools?.core.end();
  await pools?.svc.end();
  await db?.stop();
});

describe("payroll drafts follow the pack's payroll_scope (P6)", () => {
  it("IN (drafts): the proposal is stored proposed — the accept case", async () => {
    const before = await drafts(IN);
    const { tok, body } = await proposal(IN, "INR");
    const r = await intel(tok, "drafts", body);
    expect([r.status, DraftsResponse.parse(await r.json()).status]).toEqual([201, "proposed"]);
    expect(await drafts(IN)).toBe(before + 1);
  });

  it("AU (roster_only): the same proposal is 422 payroll_out_of_scope and nothing is stored", async () => {
    const before = await drafts(AU);
    const { tok, body } = await proposal(AU, "AUD");
    const r = await intel(tok, "drafts", body);
    expect([r.status, (await r.json()).error]).toEqual([422, expect.objectContaining({ code: "out_of_pack_scope", reason_code: "payroll_out_of_scope" })]);
    expect(await drafts(AU)).toBe(before);
  });
});
