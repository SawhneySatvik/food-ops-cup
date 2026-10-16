// The storefront page (T-128, R66): a business's storefront theme and the order of its home page's sections, as data
// (design-system §9). Saved as numbered versions by the owner or an all-outlet manager (a person's own command) and put
// live by the owner's publish; nothing here is ever proposed by intel. Text fields are plain text, rendered only as text
// nodes (gotcha 15). Locked, so not in the document: fonts, the semantic tokens (danger, warning, success, the source
// chip), the focus ring, the demo and simulated labels, "Pay at the counter" and every tax line.
//   GET  /v1/storefront-pages                  → the versions, newest first, and which one is live
//   GET  /v1/storefront-pages/{id}             → one version with its document
//   POST /v1/storefront-pages                  storefront.page.save.v1 → 201 (the next version number)
//   POST /v1/storefront-pages/{id}:publish     storefront.page.publish.v1 → 200 (that version goes live; an older one = restore)
//   GET  /v1/storefront/page                   (storefront key) → the live version's document, or null (the built-in look)
import { z } from "zod";
import { IsoDateTime, Uuid7 } from "../shared/primitives.ts";
import type { Route } from "../shared/routes.ts";

const Hex = z.string().regex(/^#[0-9a-f]{6}$/);
const Plain = (max: number) => z.string().min(1).max(max);

/** Colours are checked by core when saved: primary and secondary each need a text colour (white or ink) at 4.5:1 and must
 *  read at 4.5:1 on the page background; ink must read at 4.5:1 on the accent. A theme that fails is refused with
 *  `theme_contrast` (the editor shows the measured ratio). */
export const StorefrontPageTheme = z.strictObject({
  primary: Hex,
  secondary: Hex,
  accent: Hex,
  radius: z.enum(["soft", "round"]),
  /** The home page's layout preset: a large hero with art, or a short hero over the outlets as a grid or a list. */
  layout: z.enum(["hero-banner", "menu-grid", "menu-list"]),
});

/** One home page section. `outlets` is how a shopper reaches the menu, so it is always shown. */
export const StorefrontPageSection = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("hero"), visible: z.boolean(), badge: Plain(60), tagline: Plain(160) }),
  z.strictObject({ kind: z.literal("outlets"), visible: z.literal(true), title: Plain(60) }),
  z.strictObject({ kind: z.literal("ribbon"), visible: z.boolean() }),
  /** Two cards the owner writes; the Munim Cares card beside them is fixed. */
  z.strictObject({ kind: z.literal("cards"), visible: z.boolean(), cards: z.array(z.strictObject({ title: Plain(60), body: Plain(240) })).length(2) }),
]);

export const StorefrontPageDoc = z.strictObject({
  theme: StorefrontPageTheme,
  /** All four sections, each once, in the order the home page shows them. */
  sections: z.array(StorefrontPageSection).length(4)
    .refine((s) => new Set(s.map((x) => x.kind)).size === 4, "each section kind once"),
});

/** A new version. `based_on_version` is the newest version the editor loaded (null when there was none): another save
 *  since then → 409 `page_version_stale`, so two people never overwrite each other. */
export const StorefrontPageSaveV1 = z.strictObject({ page_id: Uuid7, based_on_version: z.int().min(1).nullable(), doc: StorefrontPageDoc });

/** Puts a saved version live (owner). Publishing an older version restores it; the live version again → 409. */
export const StorefrontPagePublishV1 = z.strictObject({ publish_id: Uuid7, page_id: Uuid7 });

const Version = {
  page_id: Uuid7,
  version: z.int().min(1),
  created_at: IsoDateTime,
  created_by: Uuid7,
  created_by_name: z.string(),
};
const Live = z.strictObject({ page_id: Uuid7, version: z.int().min(1), published_at: IsoDateTime, published_by: Uuid7, published_by_name: z.string() });

export const StorefrontPagesResponse = z.strictObject({
  /** Newest first. */
  versions: z.array(z.strictObject(Version)),
  /** The live version, or null (never published: the storefront shows its built-in look). */
  live: Live.nullable(),
});
export const StorefrontPageView = z.strictObject({ ...Version, doc: StorefrontPageDoc });
export const StorefrontPagePublic = z.strictObject({
  page: z.strictObject({ version: z.int().min(1), published_at: IsoDateTime, doc: StorefrontPageDoc }).nullable(),
});

export const PAGE_SCHEMAS = {
  "storefront.page.doc": StorefrontPageDoc,
  "storefront.page.save.v1": StorefrontPageSaveV1,
  "storefront.page.publish.v1": StorefrontPagePublishV1,
  "v1.storefront-pages": StorefrontPagesResponse,
  "v1.storefront-page": StorefrontPageView,
  "storefront.page.public": StorefrontPagePublic,
};

const id = [{ name: "id", uuid: true }];
export const PAGE_ROUTES: readonly Route[] = [
  { surface: "public", method: "get", path: "/v1/storefront-pages", operationId: "listStorefrontPages", summary: "The storefront page's saved versions and the live one", auth: "member", response: "v1.storefront-pages", status: 200 },
  { surface: "public", method: "get", path: "/v1/storefront-pages/{id}", operationId: "getStorefrontPage", summary: "One saved version of the storefront page with its theme and sections", auth: "member", response: "v1.storefront-page", status: 200, pathParams: id },
  { surface: "public", method: "post", path: "/v1/storefront-pages", operationId: "saveStorefrontPage", summary: "storefront.page.save.v1 — save the next version of the storefront page (owner; all-outlet manager)", auth: "member", command: "storefront.page.save.v1", response: "command-result", status: 201, conflict: true },
  { surface: "public", method: "post", path: "/v1/storefront-pages/{id}:publish", operationId: "publishStorefrontPage", summary: "storefront.page.publish.v1 — put a saved version live; an older one restores it (owner)", auth: "member", command: "storefront.page.publish.v1", response: "command-result", status: 200, conflict: true, pathParams: id },
  { surface: "public", method: "get", path: "/v1/storefront/page", operationId: "storefrontPage", summary: "The live storefront page (theme and home page sections), or null for the built-in look", auth: "storefront", response: "storefront.page.public", status: 200 },
];
