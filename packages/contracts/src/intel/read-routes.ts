// Wiki read responses and routes (T-092b; hand list row 24). Pages and versions are written only by intel through core's
// validator (services/core-api/src/internal/batches.ts writeWiki -> validateSegments: grammar, every ref resolves for the run);
// the member reads them. A body is the stored segment array, returned as stored: its refs are NOT resolved here, so a screen
// shows "cannot verify" for one until a resolution route exists (R25/R26).
import { z } from "zod";
import { IsoDateTime, Uuid7 } from "../shared/primitives.ts";
import type { QueryParam, Route } from "../shared/routes.ts";

const WikiPageRow = z.strictObject({
  page_id: Uuid7, entity_id: Uuid7.nullable(), kind: z.string(), slug: z.string(), title: z.string(), current_version: z.int().min(1).nullable(), updated_at: IsoDateTime,
});

export const READ_SCHEMAS = {
  "v1.wiki.pages": z.strictObject({ items: z.array(WikiPageRow), next_cursor: Uuid7.nullable() }),
  "v1.wiki.page": z.strictObject({ ...WikiPageRow.shape, body: z.array(z.unknown()) }),
  "v1.wiki.versions": z.strictObject({
    items: z.array(z.strictObject({ version_id: Uuid7, version: z.int().min(1), body: z.array(z.unknown()), run_id: Uuid7.nullable(), created_at: IsoDateTime })),
    next_cursor: Uuid7.nullable(),
  }),
};

const uuid = { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" };
const param = (name: string, schema: Record<string, unknown>): QueryParam => ({ name, required: false, schema });
const id = [{ name: "id", uuid: true }];
const paging = [param("limit", { type: "integer", minimum: 1, maximum: 200 }), param("cursor", uuid)];
const read = (path: string, operationId: string, summary: string, response: string, extra: Partial<Route> = {}): Route =>
  ({ surface: "public", method: "get", path, operationId, summary, auth: "member", response, status: 200, ...extra });

export const READ_ROUTES: readonly Route[] = [
  read("/v1/wiki/pages", "listWikiPages", "Wiki pages, newest first", "v1.wiki.pages", { query: [param("kind", { type: "string", pattern: "^[a-z][a-z0-9_]*$" }), ...paging] }),
  read("/v1/wiki/pages/{id}", "getWikiPage", "One wiki page with its current body (refs unresolved)", "v1.wiki.page", { pathParams: id }),
  read("/v1/wiki/pages/{id}/versions", "listWikiVersions", "A page's versions with their bodies, newest first", "v1.wiki.versions", { pathParams: id, query: paging }),
];
