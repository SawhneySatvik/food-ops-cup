// Inventory module (T-024). Mounted by modules/index.ts.
//   POST /v1/inventory/ingredients                    inventory.ingredient.upsert.v1
//   POST /v1/inventory/stock:receive                  inventory.stock.receive.v1   (opening stock, dated batches)
//   POST /v1/inventory/waste                          inventory.waste.record.v1    (+ waste movement, rule record_waste)
//   POST /v1/inventory/counts                         inventory.count.submit.v1    (blind; count_adjust movements)
//   POST /v1/inventory/reorder-levels                 inventory.reorder_level.set.v1 (draftable)
//   POST /v1/inventory/batches:update                 inventory.batch.update.v1
//   POST /v1/inventory/transfers                      inventory.transfer.create.v1 (draftable; rule transfer_out)
//   POST /v1/inventory/transfers/{id}:receive         inventory.transfer.receive.v1 (rule transfer_in)
//   POST /v1/inventory/expired-sale-overrides         inventory.expired_sale.override.v1 (R40 C7; pack flag)
//   GET  /v1/inventory/movements?outlet=&ingredient=&kind=&ref=&limit=&cursor=
//   GET  /v1/inventory/ingredients · waste · counts (+ /{id}) · transfers   row lists (T-092a, routes.ts)
//   GET  /v1/inventory/batches?outlet=&ingredient=
//   GET  /v1/inventory/reorder-levels?outlet=&ingredient=
// Seams (W2 lane brief): pickSaleBatches, deriveOrderConsumption, deriveGoodsReceipt; also consumeExpiredOverrides
// and deriveSaleReturn for orders (T-022), onNegativeOnHand for the alert path; deriveCaresHandover, reverseCaresHandover and
// deriveCaresReceive for Munim Cares (T-095a, cares.ts).
import { commandEnvelopeOf, type CommandEnvelope } from "@munim/contracts";
import {
  InventoryBatchUpdateV1, InventoryCountSubmitV1, InventoryExpiredSaleOverrideV1, InventoryIngredientUpsertV1, InventoryReorderLevelSetV1,
  InventoryStockReceiveV1, InventoryTransferCreateV1, InventoryTransferReceiveV1, InventoryWasteRecordV1,
} from "@munim/contracts/inventory";
import { Hono, type Context } from "hono";
import { contextOf, requireMember } from "../../auth/resolve.ts";
import { executeCommand, replayHeaders, type CommandHandler } from "../../commit/index.ts";
import { withContext } from "../../lib/db.ts";
import { ApiError } from "../../lib/errors.ts";
import type { AppEnv } from "../../lib/types.ts";
import { registerDraftHandler } from "../approvals/index.ts";
import {
  batchUpdate, countSubmit, expiredSaleOverride, ingredientUpsert, reorderLevelSet, stockReceive, transferCreate, transferReceive, wasteRecord,
} from "./handlers.ts";
import { listBatches, listMovements, listReorderLevels } from "./read.ts";
import { readRoutes } from "./routes.ts";

export { consumeExpiredOverrides, deriveGoodsReceipt, deriveOrderConsumption, deriveSaleReturn, pickSaleBatches, reverseOrderConsumption } from "./seams.ts";
export type { ConsumptionResult, DerivationResult, SaleLineIn, SalePick, SalePickRefusal, SalePicks } from "./seams.ts";
export { deriveCaresHandover, deriveCaresReceive, reverseCaresHandover } from "./cares.ts";
export { onHand, onNegativeOnHand, type NegativeOnHand, tenantPack } from "./stock.ts";
export { bindingMrp, fefoPick } from "./fefo.ts";

// Draftable commands (pack §6): approvals runs these under the approver's decision. Once per process even when
// this file is loaded twice (by path in tests, by file URL in loadRouters).
const REGISTERED = Symbol.for("munim.inventory.draftHandlers");
const g = globalThis as unknown as Record<symbol, boolean | undefined>;
if (!g[REGISTERED]) {
  g[REGISTERED] = true;
  for (const h of [reorderLevelSet, transferCreate]) registerDraftHandler(h);
}

const ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID = new RegExp(`^${ID}$`);

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

/** Parses the envelope, runs the handler through executeCommand under the member's own context. The book guard
 *  judges role, outlet scope and tables (0007/0014); its refusals map to 403 in app.onError. */
function commandRoute(type: string, schema: Parameters<typeof commandEnvelopeOf>[1], handler: CommandHandler,
  check?: (payload: Record<string, unknown>, c: Context<AppEnv>) => void) {
  const Envelope = commandEnvelopeOf(type, schema);
  return async (c: Context<AppEnv>) => {
    const m = member(c);
    const env = Envelope.safeParse(await body(c));
    if (!env.success) throw new ApiError("invalid_payload");
    check?.(env.data.payload as Record<string, unknown>, c);
    const deps = c.var.deps;
    const out = await executeCommand({
      tx: (fn) => withContext(deps.pools.core, contextOf(m), fn),
      tenantId: m.tenant_id,
      actor: { kind: "member", id: m.member_id, role: m.role },
      ...(deps.publish ? { publish: deps.publish } : {}),
      onPublishDeferred: (ids) => deps.log(`inventory: ${ids.length} event(s) left for the sweeper`),
    }, env.data as CommandEnvelope, handler);
    return c.body(out.body, 200, { "Content-Type": "application/json", ...replayHeaders(out) });
  };
}

/** A read's outlet must be in the member's scope (404 otherwise, like RLS). */
function readOutlet(c: Context<AppEnv>, m: Member): string {
  const outlet = c.req.query("outlet");
  if (!outlet || !UUID.test(outlet)) throw new ApiError("bad_request");
  if (m.outlet_ids !== "*" && !m.outlet_ids.includes(outlet)) throw new ApiError("not_found");
  return outlet;
}
const MOVEMENT_KINDS = ["receipt", "sale_consumption", "waste", "transfer_out", "transfer_in", "count_adjust", "supplier_return", "sale_return", "donation", "surplus_out", "surplus_in", "cares_reversal"];
function optionalId(c: Context<AppEnv>, name: string): string | undefined {
  const v = c.req.query(name);
  if (v !== undefined && !UUID.test(v)) throw new ApiError("bad_request");
  return v;
}

export const router = new Hono<AppEnv>()
  .post("/v1/inventory/ingredients", requireMember, commandRoute("inventory.ingredient.upsert.v1", InventoryIngredientUpsertV1, ingredientUpsert))
  .post("/v1/inventory/stock:receive", requireMember, commandRoute("inventory.stock.receive.v1", InventoryStockReceiveV1, stockReceive))
  .post("/v1/inventory/waste", requireMember, commandRoute("inventory.waste.record.v1", InventoryWasteRecordV1, wasteRecord))
  .post("/v1/inventory/counts", requireMember, commandRoute("inventory.count.submit.v1", InventoryCountSubmitV1, countSubmit))
  .post("/v1/inventory/reorder-levels", requireMember, commandRoute("inventory.reorder_level.set.v1", InventoryReorderLevelSetV1, reorderLevelSet))
  .post("/v1/inventory/batches:update", requireMember, commandRoute("inventory.batch.update.v1", InventoryBatchUpdateV1, batchUpdate))
  .post("/v1/inventory/transfers", requireMember, commandRoute("inventory.transfer.create.v1", InventoryTransferCreateV1, transferCreate))
  .post(`/v1/inventory/transfers/:action{${ID}:receive}`, requireMember,
    commandRoute("inventory.transfer.receive.v1", InventoryTransferReceiveV1, transferReceive, (p, c) => {
      if (p.transfer_id !== c.req.param("action")!.slice(0, -":receive".length)) throw new ApiError("invalid_payload");
    }))
  .post("/v1/inventory/expired-sale-overrides", requireMember,
    commandRoute("inventory.expired_sale.override.v1", InventoryExpiredSaleOverrideV1, expiredSaleOverride))
  .get("/v1/inventory/movements", requireMember, async (c) => {
    const m = member(c);
    const outlet = readOutlet(c, m);
    const limit = Number(c.req.query("limit") ?? 100);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new ApiError("bad_request");
    const kind = c.req.query("kind") ?? null;
    if (kind !== null && !MOVEMENT_KINDS.includes(kind)) throw new ApiError("bad_request");
    const q = { outlet, limit, ingredient: optionalId(c, "ingredient"), cursor: optionalId(c, "cursor"), kind, ref: optionalId(c, "ref") };
    return c.json(await withContext(c.var.deps.pools.core, contextOf(m), (db) => listMovements(db, q)), 200);
  })
  .get("/v1/inventory/batches", requireMember, async (c) => {
    const m = member(c);
    const q = { outlet: readOutlet(c, m), ingredient: optionalId(c, "ingredient") };
    return c.json(await withContext(c.var.deps.pools.core, contextOf(m), (db) => listBatches(db, q)), 200);
  })
  .get("/v1/inventory/reorder-levels", requireMember, async (c) => {
    const m = member(c);
    const q = { outlet: readOutlet(c, m), ingredient: optionalId(c, "ingredient") };
    return c.json(await withContext(c.var.deps.pools.core, contextOf(m), (db) => listReorderLevels(db, q)), 200);
  })
  .route("/", readRoutes);
