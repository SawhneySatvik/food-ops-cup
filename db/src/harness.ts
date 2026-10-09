// Embedded-Postgres test harness (BOARD standing rule: every DB gate runs on embedded Postgres; no Docker,
// no remote database). `startTestDb()` starts a private cluster on a free port with its data directory under
// the OS temp dir, applies every migration, seeds the country packs, and returns helpers that connect AS a
// runtime role (real login, not SET ROLE) and run a transaction under a `SET LOCAL app.*` context.
// `stop()` stops the cluster and deletes its data directory.
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type EmbeddedPostgresClass from "embedded-postgres";
import pg from "pg";
import { migrate, type MigrateResult } from "../migrate.ts";
import { seedPacks, type SeedPacksResult } from "../seeds/packs.ts";

export const RUNTIME_ROLES = ["munim_core", "munim_svc", "munim_platform", "munim_intel_ro"] as const;
export type RuntimeRole = (typeof RUNTIME_ROLES)[number];
export type Role = RuntimeRole | "admin";

/** The `SET LOCAL app.*` context of one transaction (03-architecture §1.4). Unset keys are not set. */
export interface AppContext {
  tenant_id?: string;
  /** "*" → '{*}' (every outlet); an array → '{uuid,…}'. */
  outlet_ids?: "*" | string[];
  role?: string;
  member_id?: string;
  customer_id?: string;
  operator_id?: string;
  command_type?: string;
  decision_id?: string;
  posting_rule?: string;
  source_ref?: string;
  /** Customer requests (0014): hex sha256 of a guest order's access token; codes the customer presented. */
  guest_access_hash?: string;
  coupon_codes?: string;
}

export interface ClusterInfo {
  port: number;
  password: string;
  database: string;
}

export interface TestDb extends ClusterInfo {
  migration: MigrateResult;
  packs: SeedPacksResult | null;
  /** A new connected client logged in as `role` ("admin" = the cluster superuser). Caller ends it. */
  connect(role: Role): Promise<pg.Client>;
  /** A pool logged in as `role`. Caller ends it. */
  pool(role: Role, max?: number): pg.Pool;
  /** BEGIN; SET LOCAL app.* from ctx; fn; COMMIT (ROLLBACK and rethrow on error), on a fresh connection. */
  withContext<T>(role: Role, ctx: AppContext, fn: (c: pg.Client) => Promise<T>): Promise<T>;
  /** Run one statement as the superuser (fixture plumbing and red-proof mutations only). */
  admin<R extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params?: unknown[]): Promise<pg.QueryResult<R>>;
  /** A fresh database copied from this one (CREATE DATABASE … TEMPLATE) on the same cluster. */
  clone(): Promise<TestDb>;
  /** Drop a clone, or stop the whole cluster when called on the database startTestDb() returned. */
  stop(): Promise<void>;
}

/**
 * embedded-postgres registers async-exit-hook when its module is evaluated; the hook's `beforeExit` handler
 * calls process.exit(0), which overwrites the exitCode = 1 a failing vitest run sets — a red gate exited 0
 * (measured by T-004) — and its `exit` handler calls the shutdown hook without its callback, which throws.
 * So the module is loaded here, only when a cluster is started (never by `attachTestDb` or the root import),
 * and the `beforeExit` and `exit` listeners that load added are removed. Its signal handlers stay, so Ctrl-C
 * still stops running clusters; `stop()` stops them on a normal exit.
 */
type Listener = (...a: unknown[]) => void;
const EXIT_EVENTS = ["beforeExit", "exit"];
const listenersOf = (e: string) => (process.listeners as (e: string) => Listener[])(e);
async function loadEmbeddedPostgres(): Promise<typeof EmbeddedPostgresClass> {
  const before = new Map(EXIT_EVENTS.map((e) => [e, new Set(listenersOf(e))]));
  const mod = await import("embedded-postgres");
  for (const e of EXIT_EVENTS) {
    for (const l of listenersOf(e)) if (!before.get(e)!.has(l)) process.removeListener(e, l);
  }
  return mod.default;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

/** Applies the context with set_config(…, true) — the parameterised form of SET LOCAL. */
export async function setContext(c: pg.Client | pg.PoolClient, ctx: AppContext): Promise<void> {
  for (const [k, v] of Object.entries(ctx)) {
    if (v === undefined) continue;
    const value = k === "outlet_ids" ? (v === "*" ? "{*}" : `{${(v as string[]).join(",")}}`) : String(v);
    await c.query("SELECT set_config($1, $2, true)", [`app.${k}`, value]);
  }
}

export async function inContext<T>(
  c: pg.Client | pg.PoolClient,
  ctx: AppContext,
  fn: (c: pg.Client | pg.PoolClient) => Promise<T>,
): Promise<T> {
  await c.query("BEGIN");
  try {
    await setContext(c, ctx);
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  }
}

function bind(info: ClusterInfo, extra: Pick<TestDb, "migration" | "packs">, stopFn: () => Promise<void>): TestDb {
  const conn = (role: Role) => ({
    host: "127.0.0.1",
    port: info.port,
    database: info.database,
    user: role === "admin" ? "postgres" : role,
    password: info.password,
  });
  const db: TestDb = {
    ...info,
    ...extra,
    async connect(role) {
      const c = new pg.Client(conn(role));
      await c.connect();
      return c;
    },
    pool(role, max = 10) {
      return new pg.Pool({ ...conn(role), max });
    },
    async withContext(role, ctx, fn) {
      const c = await db.connect(role);
      try {
        return await inContext(c, ctx, fn as (c: pg.Client | pg.PoolClient) => Promise<never>);
      } finally {
        await c.end();
      }
    },
    async admin(sql, params) {
      const c = await db.connect("admin");
      try {
        return await c.query(sql, params);
      } finally {
        await c.end();
      }
    },
    async clone() {
      const name = `munim_t_${randomBytes(6).toString("hex")}`;
      const c = new pg.Client({ ...conn("admin"), database: "postgres" });
      await c.connect();
      try {
        await c.query(`CREATE DATABASE ${name} TEMPLATE ${info.database}`);
      } finally {
        await c.end();
      }
      return bind({ ...info, database: name }, extra, async () => {
        const d = new pg.Client({ ...conn("admin"), database: "postgres" });
        await d.connect();
        try {
          await d.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
        } finally {
          await d.end();
        }
      });
    },
    stop: stopFn,
  };
  return db;
}

/** Connect to a cluster started elsewhere (vitest globalSetup) and work on a private clone of its database. */
export async function attachTestDb(info: ClusterInfo, extra: Pick<TestDb, "migration" | "packs">): Promise<TestDb> {
  return bind(info, extra, async () => {}).clone();
}

export async function startTestDb(
  opts: { migrationsDir?: string; seedPacks?: boolean; log?: (l: string) => void } = {},
): Promise<TestDb> {
  const port = await freePort();
  const password = randomBytes(12).toString("hex");
  const dataDir = mkdtempSync(join(tmpdir(), "munim-pg-"));
  const EmbeddedPostgres = await loadEmbeddedPostgres();
  const cluster = new EmbeddedPostgres({
    databaseDir: dataDir,
    port,
    user: "postgres",
    password,
    persistent: false,
    // 100 concurrent writers in the invoice gate plus the harness's own connections.
    postgresFlags: ["-c", "max_connections=250", "-c", "listen_addresses=127.0.0.1"],
    onLog: () => {},
    onError: () => {},
  });
  await cluster.initialise();
  await cluster.start();
  const database = "munim";
  const log = opts.log ?? (() => {});
  try {
    const root = new pg.Client({ host: "127.0.0.1", port, user: "postgres", password, database: "postgres" });
    await root.connect();
    await root.query(`CREATE DATABASE ${database}`);
    await root.end();

    const c = new pg.Client({ host: "127.0.0.1", port, user: "postgres", password, database });
    await c.connect();
    let migration: MigrateResult;
    let packs: SeedPacksResult | null = null;
    try {
      migration = await migrate(c, { log, ...(opts.migrationsDir ? { dir: opts.migrationsDir } : {}) });
      // Test-only login secrets; deployments set their own outside migrations.
      for (const r of RUNTIME_ROLES) await c.query(`ALTER ROLE ${r} PASSWORD '${password}'`);
      if (opts.seedPacks !== false) packs = await seedPacks(c, { log });
    } finally {
      await c.end();
    }
    return bind({ port, password, database }, { migration, packs }, async () => {
      await cluster.stop();
    });
  } catch (e) {
    await cluster.stop();
    throw e;
  }
}
