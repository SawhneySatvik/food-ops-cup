// App pools (03-arch §1.2): `core` logs in as munim_core (member routes, draft execution), `svc` as
// munim_svc (internal routes, jobs), `platform` as munim_platform (operator routes, T-031). Session/LISTEN
// connections belong to the stream (T-006), not here.
import pg from "pg";

export interface Pools {
  core: pg.Pool;
  svc: pg.Pool;
  /** Unset in compositions without the operator surface (gates, tools): its routes refuse with `unavailable`. */
  platform?: pg.Pool;
}

/** The `SET LOCAL app.*` context of one transaction (03-arch §1.4; db/README "Context keys"). */
export interface AppContext {
  tenant_id?: string;
  /** "*" → '{*}' (every outlet); an array → '{uuid,…}' ('{}' = no outlet). */
  outlet_ids?: "*" | readonly string[];
  role?: "owner" | "manager" | "staff" | "advisor" | "judge" | "customer" | "guest" | "operator" | "service";
  member_id?: string;
  customer_id?: string;
  operator_id?: string;
  command_type?: string;
  decision_id?: string;
  posting_rule?: string;
  source_ref?: string;
  /** Shoppers (db/README "Shoppers"): codes the request presents → '{CODE,…}' (coupon_scope reads only these). */
  coupon_codes?: readonly string[];
  /** hex(sha256(guest token)): a guest's one order, or a customer claiming a guest order. */
  guest_access_hash?: string;
}

const COUPON_CODE = /^[A-Z0-9][A-Z0-9-]{2,31}$/;

/**
 * BEGIN; set_config('app.<k>', v, true) for every key (the parameterised SET LOCAL — never session-level,
 * gotcha 2: the transaction pooler would leak it to the next client); fn; COMMIT. ROLLBACK and rethrow on
 * error; a client whose ROLLBACK also failed is destroyed rather than returned to the pool.
 * `snapshot`: one REPEATABLE READ, READ ONLY transaction, so every read in `fn` sees the same committed state.
 */
export async function withContext<T>(pool: pg.Pool, ctx: AppContext, fn: (c: pg.PoolClient) => Promise<T>, opts: { snapshot?: boolean } = {}): Promise<T> {
  const c = await pool.connect();
  let broken: Error | undefined;
  try {
    await c.query(opts.snapshot ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN");
    try {
      for (const [k, v] of Object.entries(ctx)) {
        if (v === undefined) continue;
        if (k === "coupon_codes" && !(v as string[]).every((x) => COUPON_CODE.test(x))) throw new Error("withContext: malformed coupon code");
        const value = Array.isArray(v) ? `{${v.join(",")}}` : v === "*" && k === "outlet_ids" ? "{*}" : String(v);
        await c.query("SELECT set_config($1, $2, true)", [`app.${k}`, value]);
      }
      const out = await fn(c);
      await c.query("COMMIT");
      return out;
    } catch (e) {
      await c.query("ROLLBACK").catch((re: Error) => {
        broken = re;
      });
      throw e;
    }
  } finally {
    c.release(broken);
  }
}

export function createPool(connectionString: string, max: number): pg.Pool {
  const pool = new pg.Pool({ connectionString, max, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000 });
  // An idle client dropped by the server must not crash the process; the next checkout reconnects.
  pool.on("error", () => {});
  // pg-pool's listener above covers IDLE clients only; a checked-out client with no 'error' listener makes the
  // EventEmitter throw and kills the process (hosted pooler sent a malformed packet mid-query, T-096). This one
  // stays for the client's whole life: the in-flight query rejects and the caller releases the client with the
  // error, so pg-pool destroys it. Label only — never the server's text or the connection string.
  pool.on("connect", (client) => {
    client.on("error", (e: Error & { code?: string }) => console.warn(`pg client error: ${e.code ?? e.name}`));
  });
  return pool;
}

/**
 * Core-owned writes inside a shopper request (command_log, audit_log, outbox, derived rows): customers and
 * guests can neither read nor write those (0014 customer_scope / guest_scope deny), so core-api clears
 * app.role for `fn` (set_config('app.role', '', true) — still transaction-local) and restores it after.
 * The tenant and every other key stay set. On a throw the role is not restored: the caller's transaction is
 * already failing and will roll back.
 */
export async function asSystem<T>(c: Pick<pg.ClientBase, "query">, fn: () => Promise<T>): Promise<T> {
  const prev = (await c.query<{ r: string | null }>("SELECT current_setting('app.role', true) AS r")).rows[0]?.r ?? "";
  await c.query("SELECT set_config('app.role', '', true)");
  const out = await fn();
  await c.query("SELECT set_config('app.role', $1, true)", [prev]);
  return out;
}
