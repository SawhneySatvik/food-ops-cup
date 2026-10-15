// Shared fixtures for the T-029 gates (compliance + goals): a canonical world (buildWorld) with login subs for the
// owner, staff (outlet 1), an outlet-1 manager and an outlet-2 manager, the real app, and a `call` helper.
// Test-only snapshot templates stand in for the W3 compliance/goals templates. Synthetic data only.
import { createLogger } from "@munim/config";
import { snapRef } from "@munim/contracts";
import { buildWorld, type TestDb, type World } from "@munim/db";
import type { Hono } from "hono";
import type pg from "pg";
import { type AppEnv, createApp, TENANT_HEADER } from "../src/app.ts";
import { uuidv7 } from "../src/commit/index.ts";
import { runTemplate } from "../src/modules/approvals/snapshots.ts";
import { createLocalIdp } from "../src/auth/local-idp.ts";
import { openDb } from "./db.ts";

export { snapRef, uuidv7 };
export type Who = "owner" | "staff" | "mgr1" | "mgr2";
export type Res = Omit<Response, "json"> & { json(): Promise<any> };

export interface Env {
  db: TestDb;
  w: World;
  app: Hono<AppEnv>;
  pools: { core: pg.Pool; svc: pg.Pool };
  ids: Record<Who, string>;
  call(method: string, path: string, who: Who, body?: unknown): Promise<Res>;
  /** POST a command envelope to `path`. */
  cmd(path: string, who: Who, type: string, payload: Record<string, unknown>, key?: string): Promise<Res>;
  one<R extends pg.QueryResultRow>(sql: string, params?: unknown[]): Promise<R>;
  count(sql: string, params?: unknown[]): Promise<number>;
  /** Mints a snapshot of a test template the way intel would, returns its id. */
  mint(templateId: string, params: Record<string, unknown>, scope?: string[]): Promise<string>;
  /** A proposed draft (as intel would write it) for the module's draftable command. */
  draft(command_type: string, payload: Record<string, unknown>, basedOn: string[], outlets: string[]): Promise<string>;
  approve(who: Who, draftId: string, command_type: string): Promise<Res>;
  stop(): Promise<void>;
}

export async function startEnv(country: "IN" | "AU" = "IN"): Promise<Env> {
  const idp = createLocalIdp();
  const db = await openDb();
  const w = await buildWorld(db, { country });
  const ids: Record<Who, string> = { owner: w.owner, staff: w.staff, mgr1: uuidv7(), mgr2: uuidv7() };
  const subs: Record<Who, string> = { owner: `owner-${uuidv7()}`, staff: `staff-${uuidv7()}`, mgr1: `mgr1-${uuidv7()}`, mgr2: `mgr2-${uuidv7()}` };
  await db.withContext("munim_core", { tenant_id: w.tenant, outlet_ids: "*", role: "owner", member_id: w.owner, command_type: "tenancy.member.invite.v1" }, async (c) => {
    await c.query(`UPDATE core.member SET idp_sub = $2 WHERE id = $1`, [w.owner, subs.owner]);
    await c.query(`UPDATE core.member SET idp_sub = $2 WHERE id = $1`, [w.staff, subs.staff]);
    for (const [who, outlet] of [["mgr1", w.outlets[0]], ["mgr2", w.outlets[1]]] as const) {
      await c.query(`INSERT INTO core.member (tenant_id, id, idp_sub, name, email) VALUES ($1, $2, $3, $4, $5)`, [w.tenant, ids[who], subs[who], `Synthetic ${who}`, `${who}@example.test`]);
      await c.query(`INSERT INTO core.membership (tenant_id, member_id, role, outlet_ids) VALUES ($1, $2, 'manager', $3)`, [w.tenant, ids[who], [outlet]]);
    }
  });
  const pools = { core: db.pool("munim_core", 8), svc: db.pool("munim_svc", 2) };
  const config = { nodeEnv: "test", redact: (s: string) => s };
  const app = await createApp({ pools, idp, storefronts: async () => null, config, log: createLogger(config, () => {}) });

  const call: Env["call"] = async (method, path, who, body) =>
    (await app.request(path, {
      method,
      headers: { Authorization: `Bearer ${idp.sign({ sub: subs[who] })}`, [TENANT_HEADER]: w.tenant, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })) as Res;
  const one: Env["one"] = async (sql, params = []) => (await db.admin(sql, params)).rows[0] as any;
  const svc = { tenant_id: w.tenant, outlet_ids: "*" as const, role: "service" as const };

  return {
    db, w, app, pools, ids, call, one,
    cmd: (path, who, type, payload, key = `k-${uuidv7()}`) =>
      call("POST", path, who, { command_id: uuidv7(), idempotency_key: key, type, payload }),
    count: async (sql, params = []) => Number((await one<{ n: string }>(sql, params)).n),
    async mint(templateId, params, scope = ["*"]) {
      const id = uuidv7();
      await db.withContext("munim_svc", svc, async (c) => {
        const run = uuidv7();
        await c.query(`INSERT INTO intel.run (tenant_id, id, trigger, actor, outlet_scope, expires_at) VALUES ($1, $2, 'event', 'watcher:events', $3, now() + interval '1 hour')`, [w.tenant, run, scope]);
        const { rows } = await runTemplate(c, templateId, 1, params);
        await c.query(`INSERT INTO evidence.snapshot (tenant_id, id, template_id, template_version, params, run_id, outlet_scope, rows, row_count, sha256)
                       VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, repeat('0', 64))`, [w.tenant, id, templateId, params, run, scope, JSON.stringify(rows), rows.length]);
      });
      return id;
    },
    async draft(command_type, payload, basedOn, outlets) {
      const id = uuidv7();
      await db.withContext("munim_svc", svc, (c) =>
        c.query(`INSERT INTO core.draft (tenant_id, id, outlet_ids, source, command_type, command_payload, based_on) VALUES ($1, $2, $3, 'intel:compliance', $4, $5, $6)`,
          [w.tenant, id, outlets, command_type, payload, JSON.stringify(basedOn)]));
      return id;
    },
    approve: (who, draftId, command_type) =>
      call("POST", `/v1/drafts/${draftId}:approve`, who, {
        command_id: uuidv7(), idempotency_key: `approve-${uuidv7()}`, type: "drafts.approve.v1",
        payload: { draft_id: draftId, command_type, edited_payload: null, reason: null },
      }),
    async stop() {
      await pools.core.end();
      await pools.svc.end();
      await db.stop();
    },
  };
}

/** Test-only template: one numeric cell tied to a real book column (stands in for the W3 templates). */
export async function addTemplate(db: TestDb, id: string, sql: string, columns: unknown[]) {
  await db.admin(`INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES ($1, 1, $2, '{"type":"object"}', $3, 'manager')`,
    [id, sql, JSON.stringify(columns)]);
}
