// Storefront module (T-032): the customer-facing API behind a storefront key (X-Munim-Storefront-Key → tenant +
// channel; the channel and the customer are never read from a payload). Customer sign-in is optional; guest
// checkout returns the one-time guest access token. Payments are simulated: every confirmation says
// "Pay at the counter" and no route takes card data.
//   GET  /v1/storefront/outlets
//   GET  /v1/storefront/outlets/{outlet_id}/menu | /state | /pickup-windows
//   POST /v1/storefront/orders:preview            POST /v1/storefront/orders
//   GET  /v1/storefront/orders/{id}               (customer token, or X-Munim-Guest-Token for that one order)
//   POST /v1/storefront/orders/{id}:cancel | :reschedule-preview | :reschedule   (signed-in customers; a guest-token
//        holder is refused 403 guest_cannot_change — W2-R2)
import { CommandEnvelope } from "@munim/contracts";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { contextOf, GUEST_TOKEN_HEADER, requireCustomer, requireGuest } from "../../auth/resolve.ts";
import { replayHeaders } from "../../commit/index.ts";
import { withContext } from "../../lib/db.ts";
import { ApiError } from "../../lib/errors.ts";
import type { AppEnv } from "../../lib/types.ts";
import { type CustomerPrincipal, placeFlow, previewFlow } from "./checkout.ts";
import { accepting, channelKind, menu, outletRow, outlets, pickupWindows } from "./read.ts";
import { cancelHandler, getOrder, rescheduleHandler, reschedulePreview, runShopperCommand } from "./orders.ts";
import { router as caresSection } from "./cares.ts";
import { router as caresNetwork } from "../cares-network/index.ts";
import { router as pages } from "./pages.ts";

export { configureStorefront, resetStorefront } from "./config.ts";
export type { SaleEntry, Seams } from "./config.ts";

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

function customer(c: Context<AppEnv>): CustomerPrincipal {
  const p = c.var.principal;
  if (p.kind !== "customer") throw new ApiError("not_found");
  return p;
}
/** A signed-in customer who has a profile at this merchant. */
const signedIn: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.req.header(GUEST_TOKEN_HEADER)) throw new ApiError("forbidden", "guest_cannot_change"); // W2-R2: guests call the outlet
  await requireCustomer(c, async () => {
    if (!customer(c).profile) throw new ApiError("not_found");
    await next();
  });
};
/** A guest-token holder for that one order, else a signed-in customer. */
const shopperOrGuest: MiddlewareHandler<AppEnv> = async (c, next) =>
  c.req.header(GUEST_TOKEN_HEADER)
    ? requireGuest(c, next)
    : requireCustomer(c, async () => {
        if (!customer(c).profile) throw new ApiError("not_found");
        await next();
      });

async function json(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ApiError("bad_request");
  }
}

/** A public read as the (anonymous or signed-in) shopper: customer_scope shows the catalogue and outlet facts. */
const read = <T>(c: Context<AppEnv>, fn: (q: import("../../runtoken/index.ts").Queryable, p: CustomerPrincipal) => Promise<T>) => {
  const p = customer(c);
  return withContext(c.var.deps.pools.core, contextOf(p), (q) => fn(q, p));
};

const command = async (c: Context<AppEnv>) => {
  const env = CommandEnvelope.safeParse(await json(c));
  if (!env.success) throw new ApiError("invalid_payload");
  return env.data;
};
const action = (c: Context<AppEnv>, suffix: string) => c.req.param("action")!.slice(0, -suffix.length);

export const router = new Hono<AppEnv>()
  .get("/v1/storefront/outlets", requireCustomer, async (c) => c.json(await read(c, (q) => outlets(q)), 200))
  .get(`/v1/storefront/outlets/:id{${ID}}/menu`, requireCustomer, async (c) =>
    c.json(await read(c, async (q, p) => menu(q, await outletRow(q, c.req.param("id")), await channelKind(q, p.channel_id), p.channel_id)), 200))
  .get(`/v1/storefront/outlets/:id{${ID}}/state`, requireCustomer, async (c) =>
    c.json(await read(c, async (q, p) => (await channelKind(q, p.channel_id), accepting(q, await outletRow(q, c.req.param("id"))))), 200))
  .get(`/v1/storefront/outlets/:id{${ID}}/pickup-windows`, requireCustomer, async (c) =>
    c.json(await read(c, async (q, p) => (await channelKind(q, p.channel_id), pickupWindows(q, await outletRow(q, c.req.param("id"))))), 200))
  .post("/v1/storefront/:resource{orders:preview}", requireCustomer, async (c) =>
    c.json(await previewFlow(c.var.deps, customer(c), await json(c)), 200))
  .post("/v1/storefront/orders", requireCustomer, async (c) => {
    const { placed, replayed } = await placeFlow(c, customer(c), await json(c));
    return c.json(placed, 201, replayHeaders({ replayed }));
  })
  .get(`/v1/storefront/orders/:id{${ID}}`, shopperOrGuest, async (c) => {
    const p = c.var.principal;
    if (p.kind !== "customer" && p.kind !== "guest") throw new ApiError("not_found");
    return c.json(await getOrder(c.var.deps, p, c.req.param("id")), 200);
  })
  .post(`/v1/storefront/orders/:action{${ID}:cancel}`, signedIn, async (c) => {
    const id = action(c, ":cancel");
    const out = await runShopperCommand(c.var.deps, customer(c), await command(c), cancelHandler(customer(c), id));
    return c.body(out.body, 200, { "Content-Type": "application/json", ...replayHeaders(out) });
  })
  .post(`/v1/storefront/orders/:action{${ID}:reschedule-preview}`, signedIn, async (c) =>
    c.json(await reschedulePreview(c.var.deps, customer(c), action(c, ":reschedule-preview"), await json(c)), 200))
  .post(`/v1/storefront/orders/:action{${ID}:reschedule}`, signedIn, async (c) => {
    const id = action(c, ":reschedule");
    const out = await runShopperCommand(c.var.deps, customer(c), await command(c), rescheduleHandler(customer(c), id));
    return c.body(out.body, 200, { "Content-Type": "application/json", ...replayHeaders(out) });
  });
// T-095b: the storefront's Cares section, and the public Cares network pages (mounted here so modules/index.ts, owned by
// T-004, is unchanged).
router.route("/", caresSection);
router.route("/", caresNetwork);
// T-128: the storefront page (theme and home page sections): member edits and the shopper's read of the live version.
router.route("/", pages);
