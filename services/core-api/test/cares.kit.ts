// T-095a fixtures: two canonical worlds in one database (both IN, both opted in to Munim Cares in "mumbai" by buildWorld's
// operator-approved enablement), login subs for each side's owner, outlet-1 staff and per-outlet managers, the operator,
// the real app, and per-side `call` / `cmd` helpers. Fixture rows are written as the world writes them: each under the
// command type whose target_tables list the table. Synthetic data only.
import { createLogger } from "@munim/config";
import { buildWorld, ownerCtx, type TestDb, uuidv7, type World } from "@munim/db";
import type { Hono } from "hono";
import type pg from "pg";
import { createLocalIdp } from "../src/auth/local-idp.ts";
import { type AppEnv, createApp, TENANT_HEADER } from "../src/app.ts";
import { router as caresRouter } from "../src/modules/cares/index.ts";
import { openDb } from "./db.ts";

export { uuidv7 };
export type Who = "owner" | "staff" | "mgr1" | "mgr2";
export type Res = Omit<Response, "json"> & { json(): Promise<any> };

export interface Side {
  w: World;
  ids: Record<Who, string>;
  subs: Record<Who, string>;
  call(method: string, path: string, who: Who, body?: unknown): Promise<Res>;
  /** POST a command envelope; `key` defaults to a fresh idempotency key. */
  cmd(path: string, who: Who, type: string, payload: Record<string, unknown>, key?: string): Promise<Res>;
  /** A munim_core transaction as this side's owner under `command_type` (fixture writes). */
  asOwner<T>(command_type: string, fn: (c: pg.Client) => Promise<T>): Promise<T>;
}

export interface Env {
  db: TestDb;
  app: Hono<AppEnv>;
  pools: { core: pg.Pool; svc: pg.Pool; platform: pg.Pool };
  A: Side;
  B: Side;
  /** As the world operator of side A (an active platform.operator): platform routes. */
  operator(method: string, path: string, body?: unknown): Promise<Res>;
  one<R extends pg.QueryResultRow = any>(sql: string, params?: unknown[]): Promise<R>;
  count(sql: string, params?: unknown[]): Promise<number>;
  stop(): Promise<void>;
}

async function side(db: TestDb, app: () => Hono<AppEnv>, idp: ReturnType<typeof createLocalIdp>, label: string): Promise<Side> {
  const w = await buildWorld(db);
  const ids: Record<Who, string> = { owner: w.owner, staff: w.staff, mgr1: uuidv7(), mgr2: uuidv7() };
  const subs = Object.fromEntries((["owner", "staff", "mgr1", "mgr2"] as const).map((k) => [k, `${label}-${k}-${uuidv7()}`])) as Record<Who, string>;
  await db.withContext("munim_core", ownerCtx(w, { command_type: "tenancy.member.invite.v1" }), async (c) => {
    await c.query(`UPDATE core.member SET idp_sub = $2 WHERE id = $1`, [w.owner, subs.owner]);
    await c.query(`UPDATE core.member SET idp_sub = $2 WHERE id = $1`, [w.staff, subs.staff]);
    for (const [who, outlet] of [["mgr1", w.outlets[0]], ["mgr2", w.outlets[1]]] as const) {
      await c.query(`INSERT INTO core.member (tenant_id, id, idp_sub, name, email) VALUES ($1, $2, $3, $4, $5)`, [w.tenant, ids[who], subs[who], `Synthetic ${who}`, `${label}-${who}@example.test`]);
      await c.query(`INSERT INTO core.membership (tenant_id, member_id, role, outlet_ids) VALUES ($1, $2, 'manager', $3)`, [w.tenant, ids[who], [outlet]]);
    }
  });
  const call: Side["call"] = async (method, path, who, body) =>
    (await app().request(path, {
      method,
      headers: { Authorization: `Bearer ${idp.sign({ sub: subs[who] })}`, [TENANT_HEADER]: w.tenant, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })) as Res;
  return {
    w, ids, subs, call,
    cmd: (path, who, type, payload, key = `k-${uuidv7()}`) => call("POST", path, who, { command_id: uuidv7(), idempotency_key: key, type, payload }),
    asOwner: (command_type, fn) => db.withContext("munim_core", ownerCtx(w, { command_type }), fn),
  };
}

export async function startCares(): Promise<Env> {
  const idp = createLocalIdp();
  const db = await openDb();
  let app!: Hono<AppEnv>;
  const A = await side(db, () => app, idp, "a");
  const B = await side(db, () => app, idp, "b");
  const pools = { core: db.pool("munim_core", 8), svc: db.pool("munim_svc", 2), platform: db.pool("munim_platform", 2) };
  const config = { nodeEnv: "test", redact: (s: string) => s };
  app = await createApp({ pools, idp, storefronts: async () => null, config, log: createLogger(config, () => {}) } as never);
  // Until modules/index.ts lists "cares" (orchestrator: T-004 owns the module registry), the gates mount the router here.
  if (!app.routes.some((r) => r.path.startsWith("/v1/cares/"))) app.route("/", caresRouter);
  const one: Env["one"] = async (sql, params = []) => (await db.admin(sql, params)).rows[0] as any;
  return {
    db, app, pools, A, B, one,
    operator: async (method, path, body) =>
      (await app.request(path, {
        method,
        headers: { Authorization: `Bearer ${idp.sign({ sub: `world-operator-${A.w.operator}` })}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })) as Res,
    count: async (sql, params = []) => Number((await one<{ n: string }>(sql, params)).n),
    async stop() {
      await Promise.allSettled([pools.core.end(), pools.svc.end(), pools.platform.end()]);
      await db.stop();
    },
  };
}

/** An ingredient with opening stock at an outlet (inventory.stock.receive.v1's own-command rows, untracked). */
export async function stocked(s: Side, name: string, base_unit: string, outlet: string, qty_milli: number): Promise<string> {
  const id = uuidv7();
  await s.asOwner("inventory.ingredient.upsert.v1", (c) =>
    c.query(`INSERT INTO core.ingredient (tenant_id, id, name, base_unit, tracked_by_batch) VALUES ($1, $2, $3, $4, false)`, [s.w.tenant, id, name, base_unit]));
  await s.asOwner("inventory.stock.receive.v1", (c) =>
    c.query(`INSERT INTO core.stock_movement (tenant_id, id, outlet_id, ingredient_id, qty_milli, unit, kind) VALUES ($1, $2, $3, $4, $5, $6, 'receipt')`,
      [s.w.tenant, uuidv7(), outlet, id, qty_milli, base_unit]));
  return id;
}

/** A dish whose recipe (valid from 1 Oct 2026, 1 portion) is the given lines (catalogue.recipe.version.create.v1). */
export async function dish(s: Side, lines: Array<{ ingredient_id: string; qty_milli: number; unit: string; waste_pct_bp: number }>): Promise<string> {
  const item = uuidv7();
  const version = uuidv7();
  await s.asOwner("catalogue.item.upsert.v1", (c) =>
    c.query(`INSERT INTO core.item (tenant_id, id, kind, name_key, category) VALUES ($1, $2, 'dish', 'menu.veg_pulao', 'mains')`, [s.w.tenant, item]));
  await s.asOwner("catalogue.recipe.version.create.v1", async (c) => {
    await c.query(`INSERT INTO core.recipe_version (tenant_id, id, item_id, version, valid_from, yield_qty_milli) VALUES ($1, $2, $3, 1, '2026-10-01', 1000)`, [s.w.tenant, version, item]);
    for (const l of lines) {
      await c.query(`INSERT INTO core.recipe_line (tenant_id, id, recipe_version_id, ingredient_id, qty_milli, unit, waste_pct_bp) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [s.w.tenant, uuidv7(), version, l.ingredient_id, l.qty_milli, l.unit, l.waste_pct_bp]);
    }
  });
  return item;
}

/** ISO instant `minutes` from now (pickup windows must be live: pickup_to > now()). */
export const inMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
/** A calendar date `days` from today (UTC). */
export const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
