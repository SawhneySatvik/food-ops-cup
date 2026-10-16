// Orders / POS module (T-022). Mounted by modules/index.ts. Routes (packages/contracts/src/orders/routes.ts):
//   POST /v1/orders:preview                  price a cart; writes nothing; labelled Preview (R40 C1)
//   POST /v1/orders                          orders.place.v1            (201)
//   GET  /v1/orders/{id}                     the order, lines, tenders; paid / remaining by core
//   GET  /v1/orders/{id}/receipt             the pack's bill (IN / AU tax invoice, Sec 9(5) record)
//   POST /v1/orders/{id}:accept · :reject · :advance   orders.order.accept.v1 / .reject.v1 / .advance.v1 (status steps)
//   POST /v1/orders/{id}:push-back           orders.promise.push_back.v1
//   POST /v1/orders/{id}/tenders             orders.tender.record.v1
//   POST /v1/orders/{id}/voids               orders.void.record.v1    (a whole-order void cancels the order)
//   POST /v1/orders/{id}/refunds             orders.refund.record.v1   (role cap, cumulative per order: refundHandler)
//   POST /v1/shifts · /v1/shifts/{id}:close  orders.shift.open.v1 / orders.shift.close.v1
//   GET  /v1/orders · /v1/shifts · /v1/pickup-windows   lists (T-092; routes.ts)
//   GET  /v1/shifts/{id}                     the shift row: float, counted / expected cash, variance
//   POST /v1/pickup-windows                  orders.pickup_window.generate.v1 (idempotent per slot)
// Seams for other modules: placeHandler / previewIn on the caller's transaction (T-032 storefront), placeOrder /
// previewOrder, advanceOrder / mover / orderStatusHandler (kitchen, storefront cancel, the POS status routes).
import { commandEnvelopeOf, type CommandEnvelope } from "@munim/contracts";
import {
  OrdersOrderAcceptV1, OrdersOrderAdvanceV1, OrdersOrderRejectV1, OrdersPickupWindowGenerateV1, OrdersPlaceV1, OrdersPromisePushBackV1, OrdersRefundRecordV1, OrdersShiftCloseV1, OrdersShiftOpenV1, OrdersTenderRecordV1, OrdersVoidRecordV1,
} from "@munim/contracts/orders";
import { Hono, type Context } from "hono";
import { contextOf, requireMember } from "../../auth/resolve.ts";
import { type CommandHandler, executeCommand, replayHeaders } from "../../commit/index.ts";
import { withContext } from "../../lib/db.ts";
import { ApiError } from "../../lib/errors.ts";
import type { AppEnv } from "../../lib/types.ts";
import type { Queryable } from "../../runtoken/index.ts";
import { posStatusHandler, pushBackHandler } from "./lifecycle.ts";
import { pickupWindowHandler, refundHandler, shiftCloseHandler, shiftOpenHandler, tenderHandler, voidHandler } from "./money.ts";
import { authorise, placeOrder, previewOrder } from "./place.ts";
import { orderView, receiptView, shiftView } from "./read.ts";
import { readRoutes } from "./routes.ts";

export { advanceOrder, applyReprice, mover, orderStatusHandler, quoteReprice, refuseIfTendered } from "./lifecycle.ts";
export { assertCartBounds, CART_BOUNDS, placeHandler, placeOrder, previewBody, previewIn, previewOrder } from "./place.ts";
export { setOrderSeams } from "./seams.ts";

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
type Member = Extract<AppEnv["Variables"]["principal"], { kind: "member" }>;

function member(c: Context<AppEnv>): Member {
  const p = c.var.principal;
  if (p.kind !== "member") throw new ApiError("forbidden");
  return p;
}

async function body(c: Context<AppEnv>): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ApiError("bad_request");
  }
}

const read = <T>(c: Context<AppEnv>, fn: (db: Queryable) => Promise<T>) => withContext(c.var.deps.pools.core, contextOf(member(c)), fn);

async function run(c: Context<AppEnv>, m: Member, env: CommandEnvelope, handler: CommandHandler, status: 200 | 201 = 200) {
  const deps = c.var.deps;
  const out = await executeCommand({
    tx: (fn) => withContext(deps.pools.core, contextOf(m), fn),
    tenantId: m.tenant_id,
    actor: { kind: "member", id: m.member_id, role: m.role },
    ...(deps.publish ? { publish: deps.publish } : {}),
    onPublishDeferred: (ids) => deps.log(`orders: ${ids.length} event(s) left for the sweeper`),
  }, env, handler);
  return c.body(out.body, status, { "Content-Type": "application/json", ...replayHeaders(out) });
}

/** The outlet a command acts on, read under the member's own RLS (another outlet's order → 404). */
async function outletOf(c: Context<AppEnv>, sql: string, id: string): Promise<string> {
  const row = await read(c, async (db) => (await db.query<{ outlet_id: string }>(sql, [id])).rows[0]);
  if (!row) throw new ApiError("not_found");
  return row.outlet_id;
}
const ORDER_OUTLET = `SELECT outlet_id FROM core."order" WHERE id = $1`;

/** An order command: envelope parsed, path id = payload order id, role + outlet authority before the handler.
 *  `verb` names a `/v1/orders/{id}:<verb>` route (the id is the path segment before it). */
function orderCommand(type: string, payload: Parameters<typeof commandEnvelopeOf>[1], handler: CommandHandler, verb?: string) {
  const Envelope = commandEnvelopeOf(type, payload);
  return async (c: Context<AppEnv>) => {
    const m = member(c);
    const env = Envelope.safeParse(await body(c));
    if (!env.success) throw new ApiError("invalid_payload");
    const p = env.data.payload as { order_id: string; amount_minor?: number | null };
    const pathId = verb ? c.req.param("action")!.slice(0, -verb.length) : c.req.param("id");
    if (p.order_id !== pathId) throw new ApiError("invalid_payload");
    const outlet = await outletOf(c, ORDER_OUTLET, p.order_id);
    await read(c, (db) => authorise(db, m, type, outlet, p.amount_minor ?? null));
    return run(c, m, env.data as CommandEnvelope, handler);
  };
}

const PlaceEnvelope = commandEnvelopeOf("orders.place.v1", OrdersPlaceV1);
const Windows = commandEnvelopeOf("orders.pickup_window.generate.v1", OrdersPickupWindowGenerateV1);
const ShiftOpen = commandEnvelopeOf("orders.shift.open.v1", OrdersShiftOpenV1);
const ShiftClose = commandEnvelopeOf("orders.shift.close.v1", OrdersShiftCloseV1);

export const router = new Hono<AppEnv>()
  .post("/v1/orders:preview", requireMember, async (c) =>
    c.json(await previewOrder({ deps: c.var.deps, principal: member(c) }, await body(c)), 200))
  .post("/v1/orders", requireMember, async (c) => {
    const env = PlaceEnvelope.safeParse(await body(c));
    if (!env.success) throw new ApiError("invalid_payload");
    const { out } = await placeOrder({ deps: c.var.deps, principal: member(c) }, env.data as CommandEnvelope);
    return c.body(out.body, 201, { "Content-Type": "application/json", ...replayHeaders(out) });
  })
  .get(`/v1/orders/:id{${ID}}`, requireMember, async (c) => c.json(await read(c, (db) => orderView(db, c.req.param("id"))), 200))
  .get(`/v1/orders/:id{${ID}}/receipt`, requireMember, async (c) => c.json(await read(c, (db) => receiptView(db, c.req.param("id"))), 200))
  .post(`/v1/orders/:id{${ID}}/tenders`, requireMember, orderCommand("orders.tender.record.v1", OrdersTenderRecordV1, tenderHandler))
  .post(`/v1/orders/:id{${ID}}/voids`, requireMember, orderCommand("orders.void.record.v1", OrdersVoidRecordV1, voidHandler))
  .post(`/v1/orders/:id{${ID}}/refunds`, requireMember, orderCommand("orders.refund.record.v1", OrdersRefundRecordV1, refundHandler))
  .post(`/v1/orders/:action{${ID}:accept}`, requireMember, orderCommand("orders.order.accept.v1", OrdersOrderAcceptV1, posStatusHandler("orders.order.accept.v1"), ":accept"))
  .post(`/v1/orders/:action{${ID}:reject}`, requireMember, orderCommand("orders.order.reject.v1", OrdersOrderRejectV1, posStatusHandler("orders.order.reject.v1"), ":reject"))
  .post(`/v1/orders/:action{${ID}:advance}`, requireMember, orderCommand("orders.order.advance.v1", OrdersOrderAdvanceV1, posStatusHandler("orders.order.advance.v1"), ":advance"))
  .post(`/v1/orders/:action{${ID}:push-back}`, requireMember, async (c) => {
    const m = member(c);
    const env = commandEnvelopeOf("orders.promise.push_back.v1", OrdersPromisePushBackV1).safeParse(await body(c));
    if (!env.success) throw new ApiError("invalid_payload");
    if (env.data.payload.order_id !== c.req.param("action")!.slice(0, -":push-back".length)) throw new ApiError("invalid_payload");
    const outlet = await outletOf(c, ORDER_OUTLET, env.data.payload.order_id);
    await read(c, (db) => authorise(db, m, "orders.promise.push_back.v1", outlet));
    return run(c, m, env.data, pushBackHandler);
  })
  .post("/v1/pickup-windows", requireMember, async (c) => {
    const m = member(c);
    const env = Windows.safeParse(await body(c));
    if (!env.success) throw new ApiError("invalid_payload");
    await read(c, (db) => authorise(db, m, "orders.pickup_window.generate.v1", env.data.payload.outlet_id));
    return run(c, m, env.data, pickupWindowHandler);
  })
  .post("/v1/shifts", requireMember, async (c) => {
    const m = member(c);
    const env = ShiftOpen.safeParse(await body(c));
    if (!env.success) throw new ApiError("invalid_payload");
    await read(c, (db) => authorise(db, m, "orders.shift.open.v1", env.data.payload.outlet_id));
    return run(c, m, env.data, shiftOpenHandler);
  })
  .get(`/v1/shifts/:id{${ID}}`, requireMember, async (c) => c.json(await read(c, (db) => shiftView(db, c.req.param("id"))), 200))
  .post(`/v1/shifts/:action{${ID}:close}`, requireMember, async (c) => {
    const m = member(c);
    const env = ShiftClose.safeParse(await body(c));
    if (!env.success) throw new ApiError("invalid_payload");
    if (env.data.payload.shift_id !== c.req.param("action")!.slice(0, -":close".length)) throw new ApiError("invalid_payload");
    const outlet = await outletOf(c, `SELECT outlet_id FROM core.shift WHERE id = $1`, env.data.payload.shift_id);
    await read(c, (db) => authorise(db, m, "orders.shift.close.v1", outlet));
    return run(c, m, env.data, shiftCloseHandler);
  })
  .route("/", readRoutes);
