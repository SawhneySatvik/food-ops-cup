// Test-only probe (mounted by app.ts only when NODE_ENV=test): reads core.device — a table under the
// tenant + outlet policy — through the real member auth and withContext path, so the gates prove RLS on
// the same code every module route uses.
import { Hono } from "hono";
import { contextOf, requireMember } from "../auth/resolve.ts";
import { withContext } from "../lib/db.ts";
import type { AppEnv } from "../lib/types.ts";

export const probe = new Hono<AppEnv>().get("/v1/_probe/devices", requireMember, async (c) => {
  const rows = await withContext(c.var.deps.pools.core, contextOf(c.var.principal), async (db) =>
    (await db.query<{ tenant_id: string; id: string; outlet_id: string }>(
      "SELECT tenant_id, id, outlet_id FROM core.device ORDER BY id",
    )).rows,
  );
  return c.json({ devices: rows }, 200);
});
