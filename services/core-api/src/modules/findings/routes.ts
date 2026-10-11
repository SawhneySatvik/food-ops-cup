// Wiki read routes (T-092b; hand list row 24), hosted in the findings module (the intel read models; the MODULES registry
// is the orchestrator's, so no new directory). Pages and versions are written only by intel through /internal/intel/v1/wiki:batch
// after core's validator; these routes read them under the member's tenant RLS (the wiki is tenant-wide: outlet isolation N/A).
//   GET /v1/wiki/pages?kind=&limit=&cursor= · GET /v1/wiki/pages/{id} (with its current body) · GET /v1/wiki/pages/{id}/versions
import { Hono, type Context } from "hono";
import { requireMember } from "../../auth/resolve.ts";
import { ApiError } from "../../lib/errors.ts";
import { cursorOf, ID, limitOf, memberOf, methodGuard, page, readAs } from "../../lib/reads.ts";
import type { AppEnv } from "../../lib/types.ts";

const PAGE = `SELECT p.id, p.entity_id, p.kind, p.slug, p.title, p.current_version, p.updated_at FROM intel.wiki_page p`;
const pageView = (p: Record<string, any>) => ({
  page_id: p.id, entity_id: p.entity_id, kind: p.kind, slug: p.slug, title: p.title, current_version: p.current_version, updated_at: p.updated_at.toISOString(),
});

// The wiki is not for staff (W3 close ruling) until W4 decides per-outlet pages; managers and above read it.
function notStaff(c: Context<AppEnv>): void {
  if (memberOf(c).role === "staff") throw new ApiError("forbidden", "authority_denied");
}

export const readRoutes = methodGuard(
  new Hono<AppEnv>()
    .get("/v1/wiki/pages", requireMember, async (c) => {
      notStaff(c);
      const kind = c.req.query("kind") ?? null;
      if (kind !== null && !/^[a-z][a-z0-9_]*$/.test(kind)) throw new ApiError("bad_request");
      const limit = limitOf(c);
      const cursor = cursorOf(c);
      const rows = await readAs(c, async (db) => (await db.query<Record<string, any>>(
        `${PAGE} WHERE ($1::text IS NULL OR p.kind = $1) AND ($2::uuid IS NULL OR p.id < $2) ORDER BY p.id DESC LIMIT $3`, [kind, cursor, limit + 1])).rows);
      return c.json(page(rows, limit, pageView), 200);
    })
    .get(`/v1/wiki/pages/:id{${ID}}`, requireMember, async (c) => {
      notStaff(c);
      const out = await readAs(c, async (db) => {
        const p = (await db.query<Record<string, any>>(`${PAGE} WHERE p.id = $1`, [c.req.param("id")])).rows[0];
        if (!p) throw new ApiError("not_found");
        const v = p.current_version === null ? undefined : (await db.query<Record<string, any>>(
          `SELECT body FROM intel.wiki_version WHERE page_id = $1 AND version = $2`, [p.id, p.current_version])).rows[0];
        return { ...pageView(p), body: v?.body ?? [] };
      });
      return c.json(out, 200);
    })
    .get(`/v1/wiki/pages/:id{${ID}}/versions`, requireMember, async (c) => {
      notStaff(c);
      const limit = limitOf(c, 20, 100);
      const cursor = cursorOf(c);
      const out = await readAs(c, async (db) => {
        if (!(await db.query(`SELECT 1 FROM intel.wiki_page WHERE id = $1`, [c.req.param("id")])).rows[0]) throw new ApiError("not_found");
        const rows = (await db.query<Record<string, any>>(
          `SELECT id, version, body, run_id, created_at FROM intel.wiki_version WHERE page_id = $1 AND ($2::uuid IS NULL OR id < $2) ORDER BY id DESC LIMIT $3`,
          [c.req.param("id"), cursor, limit + 1])).rows;
        return page(rows, limit, (v) => ({ version_id: v.id, version: v.version, body: v.body, run_id: v.run_id, created_at: v.created_at.toISOString() }));
      });
      return c.json(out, 200);
    }),
  [["/v1/wiki/pages", "GET"], [`/v1/wiki/pages/:id{${ID}}`, "GET"], [`/v1/wiki/pages/:id{${ID}}/versions`, "GET"]],
);
