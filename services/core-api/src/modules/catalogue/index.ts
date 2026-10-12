// Catalogue module (T-021): items/variants/options, versioned recipes, prices per outlet and channel kind, deals
// with windows, coupons, per-outlet sold-out, barcode lookup — and the W2 seams `priceLines` (the one pricing
// function) and `itemsForSale` (menu read), which other modules import from here.
//   POST /v1/catalogue/items | recipes | prices | deals | coupons | availability   (command envelopes)
//   POST /v1/catalogue/deals/{id}:end
//   GET  /v1/catalogue/menu?outlet=&channel_kind=
//   GET  /v1/catalogue/barcodes/{code}?outlet=&channel_kind=
// Draftable types registered with approvals: price set, recipe version create, deal end, coupon set.
import { CommandEnvelope } from "@munim/contracts";
import { Hono, type Context } from "hono";
import { contextOf, requireMember, type Principal } from "../../auth/resolve.ts";
import { type CommandHandler, executeCommand, replayHeaders } from "../../commit/index.ts";
import { withContext } from "../../lib/db.ts";
import { ApiError } from "../../lib/errors.ts";
import type { AppEnv } from "../../lib/types.ts";
import type { Queryable } from "../../runtoken/index.ts";
import { registerDraftHandler } from "../approvals/index.ts";
import { availabilitySet, couponSet, dealEnd, dealUpsert, DRAFT_HANDLERS, itemUpsert, priceSet, recipeVersionCreate } from "./handlers.ts";
import { itemsForSale, lookupBarcode } from "./menu.ts";
import { readRoutes } from "./routes.ts";

export { couponUses, priceLines, tenantPack, type PriceRequest, type PriceResult, type PricedLine, type PriceRefusal } from "./pricing.ts";
export { itemsForSale, type MenuEntry } from "./menu.ts";
export { inWindows } from "./deals.ts";

// Once per process: approvals' registry is process-global and refuses a second handler for a type, and this
// file can be imported twice (tests by path, loadRouters by file URL).
const ONCE = Symbol.for("munim.catalogue.draftHandlers");
const g = globalThis as unknown as Record<symbol, boolean | undefined>;
if (!g[ONCE]) {
  for (const h of DRAFT_HANDLERS) registerDraftHandler(h);
  g[ONCE] = true;
}

type Member = Extract<Principal, { kind: "member" }>;
const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID = new RegExp(`^${ID}$`);
const CHANNEL = /^(counter|table_qr|pickup|own_site|aggregator:[a-z][a-z0-9_]*)$/;

function member(c: Context<AppEnv>): Member {
  const p = c.var.principal;
  if (p.kind !== "member") throw new ApiError("forbidden");
  return p;
}

// Constraint refusals raised by the database (no text from them reaches the client).
const PG: Record<string, ApiError> = {
  "23P01": new ApiError("conflict"), // exclusion: overlapping validity
  "23505": new ApiError("conflict"), // unique: barcode, coupon code, one delta per option and ingredient
  "23503": new ApiError("bad_request"), // a referenced row does not exist
  "23514": new ApiError("bad_request"),
};

async function run(c: Context<AppEnv>, handler: CommandHandler, check?: (payload: Record<string, unknown>) => boolean) {
  const m = member(c);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ApiError("bad_request");
  }
  const env = CommandEnvelope.safeParse(body);
  if (!env.success || (check && !check(env.data.payload))) throw new ApiError("invalid_payload");
  const { deps } = c.var;
  try {
    const out = await executeCommand({
      tx: <T>(fn: (q: Queryable) => Promise<T>) => withContext(deps.pools.core, contextOf(m), fn),
      tenantId: m.tenant_id,
      actor: { kind: "member", id: m.member_id, role: m.role },
      ...(deps.publish ? { publish: deps.publish } : {}),
    }, env.data, handler);
    return c.body(out.body, 200, { "Content-Type": "application/json", ...replayHeaders(out) });
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    if (typeof code === "string" && PG[code]) throw PG[code];
    throw e;
  }
}

/** The member reads an outlet's menu only inside their outlet scope (404 outside it, gotcha 16). */
function readArgs(c: Context<AppEnv>) {
  const m = member(c);
  const outlet = c.req.query("outlet") ?? "";
  const channel = c.req.query("channel_kind") ?? "";
  if (!UUID.test(outlet) || !CHANNEL.test(channel)) throw new ApiError("bad_request");
  if (m.outlet_ids !== "*" && !m.outlet_ids.includes(outlet)) throw new ApiError("not_found");
  return { m, outlet, channel };
}

export const router = new Hono<AppEnv>()
  .post("/v1/catalogue/items", requireMember, (c) => run(c, itemUpsert))
  .post("/v1/catalogue/recipes", requireMember, (c) => run(c, recipeVersionCreate))
  .post("/v1/catalogue/prices", requireMember, (c) => run(c, priceSet))
  .post("/v1/catalogue/deals", requireMember, (c) => run(c, dealUpsert))
  .post(`/v1/catalogue/deals/:action{${ID}:end}`, requireMember, (c) =>
    run(c, dealEnd, (p) => p.deal_id === c.req.param("action")!.slice(0, -":end".length)))
  .post("/v1/catalogue/coupons", requireMember, (c) => run(c, couponSet))
  .post("/v1/catalogue/availability", requireMember, (c) => run(c, availabilitySet))
  .get("/v1/catalogue/menu", requireMember, async (c) => {
    const { m, outlet, channel } = readArgs(c);
    return c.json(await withContext(c.var.deps.pools.core, contextOf(m), (tx) => itemsForSale(tx, outlet, channel)), 200);
  })
  .get("/v1/catalogue/barcodes/:code{[0-9A-Za-z-]{4,32}}", requireMember, async (c) => {
    const { m, outlet, channel } = readArgs(c);
    return c.json(await withContext(c.var.deps.pools.core, contextOf(m), (tx) => lookupBarcode(tx, c.req.param("code"), outlet, channel)), 200);
  })
  .route("/", readRoutes);
