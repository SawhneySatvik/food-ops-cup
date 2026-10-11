// Lineage module (T-084a): read-only.
//   GET /v1/lineage?row=<schema>.<table>:<uuid>   row → audit → decision → draft → finding → run (+ snapshots)
//   GET /v1/drafts/{id}/lineage                    a draft up and down, rejected / stale / failed ones included
//   GET /v1/draftables                              the registered draftable command types
// Another outlet's row, or a draft RLS hides, is 404 (gotcha 16). Mounted by modules/index.ts.
import { draftablesView } from "@munim/contracts/lineage";
import { Hono, type Context } from "hono";
import { contextOf, requireMember } from "../../auth/resolve.ts";
import { withContext } from "../../lib/db.ts";
import { ApiError } from "../../lib/errors.ts";
import type { AppEnv } from "../../lib/types.ts";
import { auditOf, chainOf, touchedBy, visibleIds } from "./chain.ts";

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ROW = new RegExp(`^(core|intel)\\.([a-z][a-z0-9_]*):(${ID})$`);

function member(c: Context<AppEnv>) {
  const p = c.var.principal;
  if (p.kind !== "member") throw new ApiError("forbidden");
  return p;
}

export const router = new Hono<AppEnv>()
  .get("/v1/lineage", requireMember, async (c) => {
    const m = member(c);
    const parsed = ROW.exec(c.req.query("row") ?? "");
    if (!parsed) throw new ApiError("bad_request");
    const [, schema, table, id] = parsed as unknown as [string, string, string, string];
    return c.json(await withContext(c.var.deps.pools.core, contextOf(m), async (db) => {
      // The row must be visible to THIS member first: audit_log is tenant-wide, so without this check another
      // outlet's history would leak. A table the role cannot read or with no uuid `id` column is the same 404 as a
      // missing row.
      if (!(await visibleIds(db, `${schema}.${table}`, [id])).has(id)) throw new ApiError("not_found");
      const audits = await auditOf(db, `${schema}.${table}`, id);
      if (audits.length === 0) throw new ApiError("not_found");
      const chains = [];
      for (const a of audits) chains.push((await chainOf(db, m, a, null)).chain);
      return { row: { table: `${schema}.${table}`, id }, chains };
    }), 200);
  })
  .get(`/v1/drafts/:id{${ID}}/lineage`, requireMember, async (c) => {
    const m = member(c);
    return c.json(await withContext(c.var.deps.pools.core, contextOf(m), async (db) => {
      const { chain, decisionId } = await chainOf(db, m, null, c.req.param("id"));
      if (!chain.draft) throw new ApiError("not_found");
      return { chain, touched: decisionId ? await touchedBy(db, decisionId) : [] };
    }), 200);
  })
  .get("/v1/draftables", requireMember, (c) => {
    member(c);
    return c.json(draftablesView(), 200);
  });
