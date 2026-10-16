// The storefront page (T-128, R66; contracts storefront/page.ts): a business's theme and home page sections as numbered,
// insert-only versions (0034). Mounted from storefront/index.ts, so modules/index.ts (owned by T-004) is unchanged.
//   GET  /v1/storefront-pages               owner, manager, judge: the versions, newest first, and the live one
//   GET  /v1/storefront-pages/{id}          owner, manager, judge: one version with its document
//   POST /v1/storefront-pages               storefront.page.save.v1 → 201 (owner; a manager over every outlet — the guard)
//   POST /v1/storefront-pages/{id}:publish  storefront.page.publish.v1 → 200 (owner)
//   GET  /v1/storefront/page                a shopper (storefront key): the live version, or null (the built-in look)
// Every change is a person's own command (R27; nothing here is draftable), checked again by the book guard against 0034's
// command_authority rows. The theme's colours are judged by core-domain's contrast rule before anything is written.
import { commandEnvelopeOf } from "@munim/contracts";
import { StorefrontPageDoc, StorefrontPagePublishV1, StorefrontPageSaveV1 } from "@munim/contracts/storefront";
import { judgeTheme } from "@munim/core-domain/storefront";
import { Hono, type Context } from "hono";
import { contextOf, requireCustomer, requireMember } from "../../auth/resolve.ts";
import { type CommandHandler, executeCommand, replayHeaders } from "../../commit/index.ts";
import { withContext } from "../../lib/db.ts";
import { ApiError } from "../../lib/errors.ts";
import type { AppEnv } from "../../lib/types.ts";

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const TENANT = `current_setting('app.tenant_id')::uuid`;
const ME = `nullif(current_setting('app.member_id', true), '')::uuid`;
/** The newest publish row is the live page; a restore is a newer row naming an older version. */
const LIVE = `SELECT p.page_id, v.version, p.published_at, p.published_by, coalesce(m.name, '') AS published_by_name, v.doc
                FROM core.storefront_page_publish p
                JOIN core.storefront_page_version v ON v.tenant_id = p.tenant_id AND v.id = p.page_id
                LEFT JOIN core.member m ON m.tenant_id = p.tenant_id AND m.id = p.published_by
               ORDER BY p.published_at DESC, p.id DESC LIMIT 1`;

export const pageSave: CommandHandler = {
  type: "storefront.page.save.v1",
  async run(c, command) {
    const p = StorefrontPageSaveV1.safeParse(command.payload);
    if (!p.success) throw new ApiError("invalid_payload");
    if (!judgeTheme(p.data.doc.theme).ok) throw new ApiError("invalid_payload", "theme_contrast");
    const newest = (await c.query<{ n: number | null }>(`SELECT max(version) AS n FROM core.storefront_page_version`)).rows[0]?.n ?? null;
    if (newest !== p.data.based_on_version) throw new ApiError("conflict", "page_version_stale");
    const version = (newest ?? 0) + 1;
    try {
      await c.query(`INSERT INTO core.storefront_page_version (tenant_id, id, version, doc, created_by, origin) VALUES (${TENANT}, $1, $2, $3, ${ME}, '{}')`,
        [p.data.page_id, version, JSON.stringify(p.data.doc)]);
    } catch (e) {
      // Another save took this number between the read and the insert (the unique (tenant_id, version) key).
      if ((e as { code?: unknown }).code === "23505") throw new ApiError("conflict", "page_version_stale");
      throw e;
    }
    return { entityId: p.data.page_id, audit: [{ entity: "core.storefront_page_version", entityId: p.data.page_id, after: { version } }] };
  },
};

export const pagePublish: CommandHandler = {
  type: "storefront.page.publish.v1",
  async run(c, command) {
    const p = StorefrontPagePublishV1.safeParse(command.payload);
    if (!p.success) throw new ApiError("invalid_payload");
    const page = (await c.query<{ version: number }>(`SELECT version FROM core.storefront_page_version WHERE id = $1`, [p.data.page_id])).rows[0];
    if (!page) throw new ApiError("not_found");
    const live = (await c.query<{ page_id: string }>(LIVE)).rows[0];
    if (live?.page_id === p.data.page_id) throw new ApiError("illegal_transition");
    await c.query(`INSERT INTO core.storefront_page_publish (tenant_id, id, page_id, published_by, origin) VALUES (${TENANT}, $1, $2, ${ME}, '{}')`,
      [p.data.publish_id, p.data.page_id]);
    return { entityId: p.data.publish_id, audit: [{ entity: "core.storefront_page_publish", entityId: p.data.publish_id, after: { page_id: p.data.page_id, version: page.version } }] };
  },
};

type Member = Extract<AppEnv["Variables"]["principal"], { kind: "member" }>;
function editor(c: Context<AppEnv>): Member {
  const p = c.var.principal;
  if (p.kind !== "member") throw new ApiError("forbidden");
  if (!["owner", "manager", "judge"].includes(p.role)) throw new ApiError("forbidden");
  return p;
}
const iso = (d: Date) => d.toISOString();

async function command(c: Context<AppEnv>, type: string, schema: Parameters<typeof commandEnvelopeOf>[1], handler: CommandHandler, status: 200 | 201, pathId?: string) {
  const m = editor(c);
  const body: unknown = await c.req.json().catch(() => undefined);
  if (body === undefined) throw new ApiError("bad_request");
  const env = commandEnvelopeOf(type, schema).safeParse(body);
  if (!env.success) throw new ApiError("invalid_payload");
  if (pathId !== undefined && (env.data.payload as { page_id: string }).page_id !== pathId) throw new ApiError("invalid_payload");
  const { deps } = c.var;
  const out = await executeCommand(
    { tx: (fn) => withContext(deps.pools.core, contextOf(m), fn), tenantId: m.tenant_id, actor: { kind: "member", id: m.member_id, role: m.role },
      ...(deps.publish ? { publish: deps.publish } : {}) },
    env.data as Parameters<typeof executeCommand>[1], handler);
  return c.body(out.body, status, { "Content-Type": "application/json", ...replayHeaders(out) });
}

export const router = new Hono<AppEnv>()
  .get("/v1/storefront-pages", requireMember, async (c) => {
    const m = editor(c);
    return c.json(await withContext(c.var.deps.pools.core, contextOf(m), async (q) => {
      const v = await q.query<{ page_id: string; version: number; created_at: Date; created_by: string; created_by_name: string }>(
        `SELECT v.id AS page_id, v.version, v.created_at, v.created_by, coalesce(m.name, '') AS created_by_name
           FROM core.storefront_page_version v LEFT JOIN core.member m ON m.tenant_id = v.tenant_id AND m.id = v.created_by
          ORDER BY v.version DESC LIMIT 100`);
      const live = (await q.query<{ page_id: string; version: number; published_at: Date; published_by: string; published_by_name: string }>(LIVE)).rows[0];
      return {
        versions: v.rows.map((r) => ({ ...r, created_at: iso(r.created_at) })),
        live: live ? { page_id: live.page_id, version: live.version, published_at: iso(live.published_at), published_by: live.published_by, published_by_name: live.published_by_name } : null,
      };
    }), 200);
  })
  .get(`/v1/storefront-pages/:id{${ID}}`, requireMember, async (c) => {
    const m = editor(c);
    const r = await withContext(c.var.deps.pools.core, contextOf(m), (q) => q.query<{ page_id: string; version: number; created_at: Date; created_by: string; created_by_name: string; doc: unknown }>(
      `SELECT v.id AS page_id, v.version, v.created_at, v.created_by, coalesce(m.name, '') AS created_by_name, v.doc
         FROM core.storefront_page_version v LEFT JOIN core.member m ON m.tenant_id = v.tenant_id AND m.id = v.created_by WHERE v.id = $1`, [c.req.param("id")]));
    const row = r.rows[0];
    if (!row) throw new ApiError("not_found");
    return c.json({ ...row, created_at: iso(row.created_at) }, 200);
  })
  .post("/v1/storefront-pages", requireMember, (c) => command(c, "storefront.page.save.v1", StorefrontPageSaveV1, pageSave, 201))
  .post(`/v1/storefront-pages/:action{${ID}:publish}`, requireMember, (c) =>
    command(c, "storefront.page.publish.v1", StorefrontPagePublishV1, pagePublish, 200, c.req.param("action").slice(0, -":publish".length)))
  .get("/v1/storefront/page", requireCustomer, async (c) => {
    const p = c.var.principal;
    if (p.kind !== "customer") throw new ApiError("not_found");
    const live = (await withContext(c.var.deps.pools.core, contextOf(p), (q) =>
      q.query<{ version: number; published_at: Date; doc: unknown }>(LIVE))).rows[0];
    // A stored document was checked when it was saved; one that no longer parses is shown as the built-in look.
    const doc = live ? StorefrontPageDoc.safeParse(live.doc) : null;
    return c.json({ page: live && doc?.success ? { version: live.version, published_at: iso(live.published_at), doc: doc.data } : null }, 200);
  });
