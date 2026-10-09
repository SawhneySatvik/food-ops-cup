// GET /health (03-arch §9): a DB round-trip on both app pools and the latest applied migration version.
// 200 only if both pass; 503 otherwise. No auth; the body carries no hostnames or error text.
import { Hono } from "hono";
import { errorBody } from "../lib/errors.ts";
import type { AppEnv } from "../lib/types.ts";

export const health = new Hono<AppEnv>().get("/health", async (c) => {
  const { pools, log } = c.var.deps;
  try {
    const [v] = await Promise.all([
      pools.core.query<{ version: number | null }>("SELECT max(version)::int AS version FROM munim_meta.schema_migrations"),
      pools.svc.query("SELECT 1"),
    ]);
    const version = v.rows[0]?.version ?? null;
    if (version === null) return c.json(errorBody("unavailable"), 503);
    return c.json({ status: "ok", migration_version: version }, 200);
  } catch (e) {
    log("health: database check failed", e);
    return c.json(errorBody("unavailable"), 503);
  }
});
