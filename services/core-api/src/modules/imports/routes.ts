// Conversation read routes (T-092b; hand list row 25), hosted in the imports module (core.conversation / core.message
// are 0009's documents-and-imports tables; the MODULES registry is the orchestrator's). READ-ONLY: there is no write
// verb on these paths. A title or message body is ingested, untrusted text: it leaves as a JSON string and is never
// HTML (gotcha 15); the screens render it as text. Conversations carry an outlet policy (NULL outlet = tenant-wide).
//   GET /v1/conversations?outlet=&kind=&limit=&cursor= · GET /v1/conversations/{id}/messages?limit=&cursor=  (oldest first)
import { Hono, type Context } from "hono";
import { requireMember } from "../../auth/resolve.ts";
import { ApiError } from "../../lib/errors.ts";
import { cursorOf, ID, inScope, limitOf, memberOf, methodGuard, optEnum, optUuid, page, readAs } from "../../lib/reads.ts";
import type { AppEnv } from "../../lib/types.ts";

// Conversations are not for staff (W3 close ruling) until W4 decides message masking; managers and above read them.
function notStaff(c: Context<AppEnv>): void {
  if (memberOf(c).role === "staff") throw new ApiError("forbidden", "authority_denied");
}

export const readRoutes = methodGuard(
  new Hono<AppEnv>()
    .get("/v1/conversations", requireMember, async (c) => {
      notStaff(c);
      const outlet = optUuid(c, "outlet");
      if (outlet !== null) inScope(memberOf(c), outlet);
      const kind = optEnum(c, "kind", ["handover", "supplier", "customer", "imported_chat", "other"] as const);
      const limit = limitOf(c);
      const cursor = cursorOf(c);
      const rows = await readAs(c, async (db) => (await db.query<Record<string, any>>(
        `SELECT id, outlet_id, kind, title, document_id, created_at FROM core.conversation
          WHERE ($1::uuid IS NULL OR outlet_id = $1) AND ($2::text IS NULL OR kind = $2) AND ($3::uuid IS NULL OR id < $3)
          ORDER BY id DESC LIMIT $4`, [outlet, kind, cursor, limit + 1])).rows);
      return c.json(page(rows, limit, (r) => ({
        conversation_id: r.id, outlet_id: r.outlet_id, kind: r.kind, title: r.title, document_id: r.document_id, created_at: r.created_at.toISOString(),
      })), 200);
    })
    .get(`/v1/conversations/:id{${ID}}/messages`, requireMember, async (c) => {
      notStaff(c);
      const limit = limitOf(c, 100, 500);
      const cursor = cursorOf(c);
      const out = await readAs(c, async (db) => {
        // core.message is readable exactly when its conversation is (0019 O2): a conversation outside scope is not found.
        if (!(await db.query(`SELECT 1 FROM core.conversation WHERE id = $1`, [c.req.param("id")])).rows[0]) throw new ApiError("not_found");
        const rows = (await db.query<Record<string, any>>(
          `SELECT id, conversation_id, author_member_id, author_label, body, sent_at FROM core.message
            WHERE conversation_id = $1 AND ($2::uuid IS NULL OR (sent_at, id) > (SELECT x.sent_at, x.id FROM core.message x WHERE x.id = $2))
            ORDER BY sent_at, id LIMIT $3`, [c.req.param("id"), cursor, limit + 1])).rows;
        return page(rows, limit, (r) => ({
          message_id: r.id, conversation_id: r.conversation_id, author_member_id: r.author_member_id, author_label: r.author_label,
          body: r.body, sent_at: r.sent_at.toISOString(),
        }));
      });
      return c.json(out, 200);
    }),
  [["/v1/conversations", "GET"], [`/v1/conversations/:id{${ID}}/messages`, "GET"]],
);
