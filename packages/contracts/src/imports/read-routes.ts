// Conversation read responses and routes (T-092b; hand list row 25). READ-ONLY: no write verb exists on these paths.
// `title` and `body` are ingested, untrusted text (chats, pasted handovers): they are strings, rendered as text, never HTML.
import { z } from "zod";
import { IsoDateTime, Uuid7 } from "../shared/primitives.ts";
import type { QueryParam, Route } from "../shared/routes.ts";

export const ConversationKind = z.enum(["handover", "supplier", "customer", "imported_chat", "other"]);

const ConversationRow = z.strictObject({
  conversation_id: Uuid7, outlet_id: Uuid7.nullable(), kind: ConversationKind, title: z.string().nullable(), document_id: Uuid7.nullable(), created_at: IsoDateTime,
});
const MessageRow = z.strictObject({
  message_id: Uuid7, conversation_id: Uuid7, author_member_id: Uuid7.nullable(), author_label: z.string().nullable(), body: z.string(), sent_at: IsoDateTime,
});

export const READ_SCHEMAS = {
  "v1.conversations": z.strictObject({ items: z.array(ConversationRow), next_cursor: Uuid7.nullable() }),
  "v1.conversation.messages": z.strictObject({ items: z.array(MessageRow), next_cursor: Uuid7.nullable() }),
};

const uuid = { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" };
const param = (name: string, schema: Record<string, unknown>): QueryParam => ({ name, required: false, schema });
const paging = [param("limit", { type: "integer", minimum: 1, maximum: 500 }), param("cursor", uuid)];

export const READ_ROUTES: readonly Route[] = [
  { surface: "public", method: "get", path: "/v1/conversations", operationId: "listConversations", summary: "Conversations in the caller's outlet scope (handovers, supplier and imported chats); a conversation with no outlet is tenant-wide",
    auth: "member", response: "v1.conversations", status: 200, query: [param("outlet", uuid), param("kind", { type: "string", enum: ConversationKind.options }), ...paging] },
  { surface: "public", method: "get", path: "/v1/conversations/{id}/messages", operationId: "listConversationMessages", summary: "A conversation's messages, oldest first; bodies are untrusted text",
    auth: "member", response: "v1.conversation.messages", status: 200, pathParams: [{ name: "id", uuid: true }], query: paging },
];
