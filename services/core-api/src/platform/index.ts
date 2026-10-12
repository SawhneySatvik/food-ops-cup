// Platform admin API (T-031; R21, R24, R36, R40 C4). Every route is operator-only: requireOperator answers 404
// to anyone who is not an active operator (the surface is not revealed). Reads and config writes run on the
// munim_platform pool (`deps.pools.platform`); an operator has no grant on a tenant's books.
// Config changes are drafts: propose -> approve (applies, audited) | reject. Merchants never see this.
import { Hono, type Context } from "hono";
import type pg from "pg";
import { ConfigDraftApprove, ConfigDraftPropose, ConfigDraftReject } from "@munim/contracts/platform";
import { requireOperator } from "../auth/resolve.ts";
import { replayHeaders } from "../commit/index.ts";
import { withContext } from "../lib/db.ts";
import { ApiError, errorBody } from "../lib/errors.ts";
import type { AppEnv } from "../lib/types.ts";
import { approve, getDraftRow, listDrafts, propose, reject } from "./drafts.ts";
import { provision } from "./provision.ts";
import * as read from "./read.ts";
import { listNetworkSnapshots, mintNetworkSnapshot } from "./network-snapshots.ts";
import { mintOperatorSnapshot } from "./snapshots.ts";

export { setProvisionTenant } from "./provision.ts";

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

function operatorId(c: Context<AppEnv>): string {
  const p = c.var.principal;
  if (p.kind !== "operator") throw new ApiError("not_found");
  return p.operator_id;
}

/** One munim_platform transaction as the signed-in operator. `pools.platform` is wired by server.ts. */
function asOperator<T>(c: Context<AppEnv>, fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
  const pool = c.var.deps.pools.platform;
  if (!pool) throw new ApiError("unavailable");
  return withContext(pool, { role: "operator", operator_id: operatorId(c) }, fn);
}

async function json(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ApiError("bad_request");
  }
}

function parse<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, v: unknown): T {
  const r = schema.safeParse(v);
  if (!r.success) throw new ApiError("bad_request");
  return r.data;
}

export const router = new Hono<AppEnv>();
router.use("/platform/v1/*", requireOperator);

router
  .get("/platform/v1/tenants", (c) => asOperator(c, read.tenants).then((x) => c.json(x, 200)))
  .get("/platform/v1/country-packs", (c) => asOperator(c, read.countryPacks).then((x) => c.json(x, 200)))
  .get("/platform/v1/country-packs/:code{[A-Z]{2}}/:version{[0-9]+}", async (c) => {
    const row = await asOperator(c, (db) => read.countryPack(db, c.req.param("code"), Number(c.req.param("version"))));
    if (!row) throw new ApiError("not_found");
    return c.json(row, 200);
  })
  .get("/platform/v1/plans", (c) => asOperator(c, read.plans).then((x) => c.json(x, 200)))
  .get("/platform/v1/feature-flags", (c) => asOperator(c, read.featureFlags).then((x) => c.json(x, 200)))
  .get("/platform/v1/budgets", (c) => asOperator(c, read.budgets).then((x) => c.json(x, 200)))
  .get(`/platform/v1/budgets/:tenant{${ID}}/spend`, async (c) => {
    const month = c.req.query("month") ?? null;
    if (month !== null && !/^\d{4}-(0[1-9]|1[0-2])-01$/.test(month)) throw new ApiError("bad_request");
    const out = await asOperator(c, (db) => read.tenantSpend(db, c.req.param("tenant"), month));
    if (!out) throw new ApiError("not_found");
    return c.json(out, 200);
  })
  .all(`/platform/v1/budgets/:tenant{${ID}}/spend`, (c) => c.json(errorBody("bad_request"), 405, { Allow: "GET" }))
  .get("/platform/v1/model-roles", (c) => asOperator(c, read.modelRoles).then((x) => c.json(x, 200)))
  .get("/platform/v1/operators", (c) => asOperator(c, read.operators).then((x) => c.json(x, 200)))
  .get("/platform/v1/config-drafts", async (c) => {
    const status = c.req.query("status") ?? "proposed";
    if (!["proposed", "applied", "rejected", "stale", "all"].includes(status)) throw new ApiError("bad_request");
    return c.json({ items: await asOperator(c, (db) => listDrafts(db, status)) }, 200);
  })
  .post("/platform/v1/config-drafts", async (c) => {
    const body = parse(ConfigDraftPropose, await json(c));
    const out = await asOperator(c, (db) => propose(db, operatorId(c), body));
    return c.json(out.draft, out.replayed ? 200 : 201, replayHeaders(out));
  })
  .get(`/platform/v1/config-drafts/:id{${ID}}`, async (c) => {
    const d = await asOperator(c, (db) => getDraftRow(db, c.req.param("id")));
    if (!d) throw new ApiError("not_found");
    return c.json(d, 200);
  })
  .post(`/platform/v1/config-drafts/:action{${ID}:approve}`, async (c) => {
    const body = parse(ConfigDraftApprove, await json(c));
    const id = c.req.param("action").slice(0, -":approve".length);
    return c.json(await asOperator(c, (db) => approve(db, operatorId(c), id, body.reason ?? null)), 200);
  })
  .post(`/platform/v1/config-drafts/:action{${ID}:reject}`, async (c) => {
    const body = parse(ConfigDraftReject, await json(c));
    const id = c.req.param("action").slice(0, -":reject".length);
    return c.json(await asOperator(c, (db) => reject(db, operatorId(c), id, body.reason)), 200);
  })
  .post("/platform/v1/snapshots", async (c) => c.json(await mintOperatorSnapshot(c, operatorId(c), await json(c)), 201))
  .post("/platform/v1/network-snapshots", async (c) => c.json(await mintNetworkSnapshot(c, operatorId(c), await json(c)), 201))
  .get("/platform/v1/network-snapshots", async (c) => c.json(await listNetworkSnapshots(c, operatorId(c)), 200))
  .post("/platform/v1/:seg{tenants:provision}", async (c) => {
    const out = await provision(c, operatorId(c), await json(c));
    return c.body(out.body, 201, { "Content-Type": "application/json", ...replayHeaders(out) });
  });
