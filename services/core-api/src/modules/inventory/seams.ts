// Cross-module seams owned by inventory (W2 lane brief): pickSaleBatches, deriveOrderConsumption,
// deriveGoodsReceipt — plus consumeExpiredOverrides and deriveSaleReturn for the orders module. Each runs inside
// the caller's transaction and writes only what its seeded rule (or the caller's command) allows.
import { consumeOrder, consumeSku, type ConsumeInput } from "@munim/core-domain/inventory";
import { mulDiv } from "@munim/core-domain/money";
import { orderTax } from "@munim/core-domain/packs";
import type { EventDraft } from "../../commit/index.ts";
import { ApiError } from "../../lib/errors.ts";
import type { Queryable } from "../../runtoken/index.ts";
import { bindingMrp, type BatchPick, fefoPick, type OverrideGrant, type PickLine } from "./fefo.ts";
import {
  batchStock, first, inSourceState, insertMovement, type Kind, movementEvents, type NegativeOnHand, negativeAfter, outletBusinessDate,
  tenantPack, toBaseFactor, underRule,
} from "./stock.ts";

type ItemRow = { id: string; kind: string; stock_ingredient_id: string | null; mrp_minor: number | null };
type IngredientRow = { id: string; base_unit: string; tracked_by_batch: boolean };

async function itemsOf(c: Queryable, ids: readonly string[]): Promise<Map<string, ItemRow>> {
  const r = await c.query<{ id: string; kind: string; stock_ingredient_id: string | null; mrp_minor: string | null }>(
    `SELECT id, kind, stock_ingredient_id, mrp_minor::text FROM core.item WHERE id = ANY ($1::uuid[])`, [ids]);
  return new Map(r.rows.map((i) => [i.id, { ...i, mrp_minor: i.mrp_minor === null ? null : Number(i.mrp_minor) }]));
}

async function ingredientsOf(c: Queryable, ids: readonly string[]): Promise<Map<string, IngredientRow>> {
  const r = await c.query<IngredientRow>(`SELECT id, base_unit, tracked_by_batch FROM core.ingredient WHERE id = ANY ($1::uuid[])`, [ids]);
  return new Map(r.rows.map((i) => [i.id, i]));
}

/** SKU lines whose stock record is batch-tracked: these are picked by batch and may be refused. */
function skuPickLines(lines: ReadonlyArray<{ line_id: string; item_id: string; qty_milli: number }>, items: Map<string, ItemRow>, ings: Map<string, IngredientRow>): PickLine[] {
  return lines.flatMap((l) => {
    const item = items.get(l.item_id);
    const ing = item?.kind === "sku" && item.stock_ingredient_id ? ings.get(item.stock_ingredient_id) : undefined;
    return ing?.tracked_by_batch ? [{ line_id: l.line_id, ingredient_id: ing.id, qty_milli: l.qty_milli }] : [];
  });
}

// ---------------------------------------------------------------------------------------------------------
// pickSaleBatches — placement / preview, before the order row exists
// ---------------------------------------------------------------------------------------------------------

export type SaleLineIn = {
  /** The order line id the client will place (an expired-sale override is bound to it). */
  line_id: string;
  /** Echoed on each pick when given (callers index their cart by it). */
  line_no?: number;
  item_id: string;
  qty_milli: number;
  /** When given, the line is checked against its binding MRP with the pack's own rule (core-domain orderTax). */
  unit_price_minor?: number;
  option_delta_minor?: number;
  tax_class?: string | null;
};
export type SalePickRefusal =
  | { line_id: string; reason_code: "expired_batch"; batch_id: string }
  | { line_id: string; reason_code: "price_above_mrp"; mrp_minor: number };
/** One batch draw; `mrp_minor` is its line's binding MRP (the same on every pick of the line). */
export type SalePick = BatchPick & { line_no: number | null; item_id: string; mrp_minor: number | null };
export type SalePicks = {
  business_date: string;
  /** Every draw, in line order (the brief's `picks`). */
  picks: SalePick[];
  /** Per line: its binding MRP even when nothing was drawn by batch (untracked SKU, dish). */
  lines: Array<{ line_id: string; item_id: string; ingredient_id: string | null; mrp_minor: number | null; picks: SalePick[] }>;
  refusals: SalePickRefusal[];
};

/** FEFO picks for sale lines (fefo.ts), expired batches refused unless an unused override of this cart line
 *  covers them (only where the pack allows overrides), and each line's binding MRP (batch MRP when picked, item
 *  MRP otherwise) checked with the pack rule when a price is given. Writes nothing. */
export async function pickSaleBatches(c: Queryable, outletId: string, lines: readonly SaleLineIn[]): Promise<SalePicks> {
  const business_date = await outletBusinessDate(c, outletId);
  const items = await itemsOf(c, [...new Set(lines.map((l) => l.item_id))]);
  const ings = await ingredientsOf(c, [...items.values()].flatMap((i) => (i.stock_ingredient_id ? [i.stock_ingredient_id] : [])));
  const pickLines = skuPickLines(lines, items, ings);
  const pack = await tenantPack(c);
  const overrides = pack.expired_sale_override ? await unusedOverrides(c, outletId, lines.map((l) => l.line_id)) : [];
  const stock = await batchStock(c, outletId, [...new Set(pickLines.map((l) => l.ingredient_id))]);
  const { picks, refusals } = fefoPick(stock, pickLines, business_date, overrides);
  const mrpOf = new Map(stock.map((b) => [b.batch_id, b.mrp_minor]));

  const out: SalePicks = { business_date, picks: [], lines: [], refusals: [...refusals] };
  for (const l of lines) {
    const item = items.get(l.item_id);
    if (!item) throw new ApiError("not_found");
    const mine = picks.filter((p) => p.line_id === l.line_id);
    const mrp = bindingMrp(item.mrp_minor, mine.filter((p) => p.batch_id !== null).map((p) => mrpOf.get(p.batch_id!) ?? null));
    const sale = mine.map((p) => ({ ...p, line_no: l.line_no ?? null, item_id: l.item_id, mrp_minor: mrp }));
    out.picks.push(...sale);
    out.lines.push({ line_id: l.line_id, item_id: l.item_id, ingredient_id: item.kind === "sku" ? item.stock_ingredient_id : null, mrp_minor: mrp, picks: sale });
    if (l.unit_price_minor === undefined || mrp === null) continue;
    const priced = orderTax(pack, { channel_kind: "counter", lines: [{ name: l.item_id, qty_milli: l.qty_milli, unit_price_minor: l.unit_price_minor,
      option_delta_minor: l.option_delta_minor ?? 0, tax_class: l.tax_class ?? null, mrp_minor: mrp }] });
    if (!priced.ok && priced.refusal.reason_code === "price_above_mrp") out.refusals.push({ line_id: l.line_id, reason_code: "price_above_mrp", mrp_minor: mrp });
  }
  return out;
}

async function unusedOverrides(c: Queryable, outletId: string, lineIds: readonly string[]): Promise<OverrideGrant[]> {
  const r = await c.query<{ id: string; cart_line_id: string; batch_id: string; qty_milli: string }>(
    `SELECT id, cart_line_id, batch_id, qty_milli::text FROM core.expired_sale_override
      WHERE outlet_id = $1 AND cart_line_id = ANY ($2::uuid[]) AND used_at IS NULL ORDER BY id`, [outletId, lineIds]);
  return r.rows.map((o) => ({ override_id: o.id, line_id: o.cart_line_id, batch_id: o.batch_id, qty_milli: Number(o.qty_milli) }));
}

// ---------------------------------------------------------------------------------------------------------
// Placed orders
// ---------------------------------------------------------------------------------------------------------

type OrderRow = { id: string; outlet_id: string; business_date: string; created_at: Date };
type OrderLineRow = { id: string; line_no: number; item_id: string; variant_id: string | null; options: unknown; qty_milli: string; recipe_version_id: string | null };

async function orderOf(c: Queryable, orderId: string) {
  const order = await first<OrderRow>(c, `SELECT id, outlet_id, business_date::text, created_at FROM core."order" WHERE id = $1`, [orderId]);
  if (!order) throw new ApiError("not_found");
  const lines = (await c.query<OrderLineRow>(
    `SELECT id, line_no, item_id, variant_id, options, qty_milli::text, recipe_version_id FROM core.order_line WHERE order_id = $1 ORDER BY line_no`, [orderId])).rows;
  const items = await itemsOf(c, [...new Set(lines.map((l) => l.item_id))]);
  return { order, lines, items };
}

/** order_line.options: the selected option ids (an array of ids, or of objects carrying `option_id`). */
const optionIds = (options: unknown): string[] =>
  Array.isArray(options) ? options.flatMap((o) => (typeof o === "string" ? [o] : typeof o?.option_id === "string" ? [o.option_id as string] : [])) : [];

/** Consumes (used_at, order_line_id) the unused overrides the placement's FEFO pick actually draws on. Call it
 *  under `orders.place.v1` (it lists core.expired_sale_override), after the order lines are inserted and before
 *  deriveOrderConsumption. Single use is the database's (MB005). Returns the consumed override ids. */
export async function consumeExpiredOverrides(c: Queryable, orderId: string): Promise<string[]> {
  const { order, lines, items } = await orderOf(c, orderId);
  const pack = await tenantPack(c);
  if (!pack.expired_sale_override) return [];
  const ings = await ingredientsOf(c, [...items.values()].flatMap((i) => (i.stock_ingredient_id ? [i.stock_ingredient_id] : [])));
  const pickLines = skuPickLines(lines.map((l) => ({ line_id: l.id, item_id: l.item_id, qty_milli: Number(l.qty_milli) })), items, ings);
  const overrides = await unusedOverrides(c, order.outlet_id, pickLines.map((l) => l.line_id));
  if (overrides.length === 0) return [];
  const stock = await batchStock(c, order.outlet_id, [...new Set(pickLines.map((l) => l.ingredient_id))]);
  const { picks } = fefoPick(stock, pickLines, order.business_date, overrides);
  const used = [...new Set(picks.flatMap((p) => (p.override_id ? [p.override_id] : [])))];
  for (const id of used) {
    await c.query(`UPDATE core.expired_sale_override SET used_at = now(), order_line_id = cart_line_id WHERE id = $1 AND used_at IS NULL`, [id]);
  }
  return used;
}

export type DerivationResult = {
  /** false: nothing written — already derived (idempotent), or nothing to derive. */
  derived: boolean;
  movement_ids: string[];
  /** `munim.inventory.movement.recorded.v1` drafts for the caller's HandlerOutput.events. */
  events: EventDraft[];
  negative_on_hand: NegativeOnHand[];
};

export type ConsumptionResult = DerivationResult & {
  /** The recipe version each exploded line used (for order_line.recipe_version_id, written by orders). */
  recipe_lines: Array<{ line_no: number; recipe_version_id: string }>;
  /** Dish lines with no recipe in force: no movement (core-domain `recipe_missing`). */
  recipe_missing: Array<{ line_no: number; item_id: string }>;
  issues: ReturnType<typeof consumeOrder>["issues"];
};

const refused = () => new ApiError("book_write_refused", "authority_denied");

/** Rules inventory.consume_order (dishes through the recipe version stamped on each line at placement — R2-S3-3: a
 *  version created or closed afterwards changes nothing — or, for a line written without a stamp, the version in force
 *  on the order row's business_date; plus option deltas) and inventory.consume_sku (SKUs 1:1 into their stock record), core-domain arithmetic. Batch-tracked
 *  stock is split FEFO (fefo.ts) by the order row's business date: SKU lines first, refused on expired stock
 *  without a consumed override (`expired_batch`); recipe ingredients take unexpired stock, then unbatched.
 *  Refused (writes nothing) for an order outside the rules' source_state. Idempotent per order. */
export async function deriveOrderConsumption(c: Queryable, orderId: string): Promise<ConsumptionResult> {
  const { order, lines, items } = await orderOf(c, orderId);
  for (const rule of ["inventory.consume_order", "inventory.consume_sku"]) {
    if (!(await inSourceState(c, rule, "core.order", orderId))) throw refused();
  }
  const done = (await c.query<{ id: string }>(
    `SELECT id FROM core.stock_movement WHERE ref_type = 'core.order' AND ref_id = $1 AND kind = 'sale_consumption' ORDER BY id`, [orderId])).rows;
  if (done.length > 0) return { derived: false, movement_ids: done.map((m) => m.id), events: [], negative_on_hand: [], recipe_lines: [], recipe_missing: [], issues: [] };

  const itemIds = [...items.keys()];
  const all = (await c.query<{ id: string; item_id: string; variant_id: string | null; version: number; valid_from: string; valid_to: string | null; yield_qty_milli: string }>(
    `SELECT id, item_id, variant_id, version, valid_from::text, valid_to::text, yield_qty_milli::text FROM core.recipe_version WHERE item_id = ANY ($1::uuid[])`, [itemIds])).rows;
  // An item whose lines carry a stamp is exploded through exactly the stamped version(s), whatever their validity
  // window says now (core-domain picks the version in force on the business date, so the window is opened for it).
  const stamped = new Set(lines.flatMap((l) => (l.recipe_version_id ? [l.recipe_version_id] : [])));
  const stampedItems = new Set(all.filter((v) => stamped.has(v.id)).map((v) => v.item_id));
  const versions = all.flatMap((v) => (stamped.has(v.id) ? [{ ...v, valid_from: "0001-01-01", valid_to: null }] : stampedItems.has(v.item_id) ? [] : [v]));
  const recipeLines = (await c.query<{ recipe_version_id: string; ingredient_id: string; qty_milli: string; unit: string; waste_pct_bp: number }>(
    `SELECT recipe_version_id, ingredient_id, qty_milli::text, unit, waste_pct_bp FROM core.recipe_line WHERE recipe_version_id = ANY ($1::uuid[])`, [versions.map((v) => v.id)])).rows;
  const allOptions = [...new Set(lines.flatMap((l) => optionIds(l.options)))];
  const deltas = (await c.query<{ option_id: string; ingredient_id: string; qty_milli: string; unit: string; waste_pct_bp: number }>(
    `SELECT option_id, ingredient_id, qty_milli::text, unit, waste_pct_bp FROM core.option_ingredient_delta WHERE option_id = ANY ($1::uuid[])`, [allOptions])).rows;
  const ings = await ingredientsOf(c, [...new Set([
    ...recipeLines.map((l) => l.ingredient_id), ...deltas.map((d) => d.ingredient_id),
    ...[...items.values()].flatMap((i) => (i.stock_ingredient_id ? [i.stock_ingredient_id] : [])),
  ])]);

  const input: ConsumeInput = {
    order: { order_id: order.id, outlet_id: order.outlet_id, placed_at: order.created_at.toISOString(), business_date: order.business_date,
      lines: lines.map((l) => ({ line_no: l.line_no, item_id: l.item_id, variant_id: l.variant_id, option_ids: optionIds(l.options), qty_milli: Number(l.qty_milli) })) },
    items: [...items.values()].map((i) => ({ item_id: i.id, kind: i.kind, stock_ingredient_id: i.stock_ingredient_id })),
    ingredients: [...ings.values()].map((i) => ({ ingredient_id: i.id, base_unit: i.base_unit })),
    recipe_versions: versions.map((v) => ({ recipe_version_id: v.id, item_id: v.item_id, variant_id: v.variant_id, version: v.version, valid_from: v.valid_from,
      valid_to: v.valid_to, yield_qty_milli: Number(v.yield_qty_milli),
      lines: recipeLines.filter((l) => l.recipe_version_id === v.id).map((l) => ({ ingredient_id: l.ingredient_id, qty_milli: Number(l.qty_milli), unit: l.unit, waste_pct_bp: l.waste_pct_bp })) })),
    option_deltas: deltas.map((d) => ({ option_id: d.option_id, ingredient_id: d.ingredient_id, qty_milli: Number(d.qty_milli), unit: d.unit, waste_pct_bp: d.waste_pct_bp })),
  };
  const dish = consumeOrder(input);
  const sku = consumeSku(input);

  // Batch split: SKU lines (blocking) then each tracked recipe ingredient (never refused), one shared stock map.
  const tracked = (id: string) => ings.get(id)?.tracked_by_batch === true;
  const skuLines = skuPickLines(lines.map((l) => ({ line_id: l.id, item_id: l.item_id, qty_milli: Number(l.qty_milli) })), items, ings);
  const dishLines: PickLine[] = dish.movements.filter((m) => tracked(m.ingredient_id))
    .map((m) => ({ line_id: `recipe:${m.ingredient_id}`, ingredient_id: m.ingredient_id, qty_milli: -m.qty_milli, expired_blocks: false }));
  const consumed = (await c.query<{ id: string; order_line_id: string; batch_id: string; qty_milli: string }>(
    `SELECT id, order_line_id, batch_id, qty_milli::text FROM core.expired_sale_override WHERE order_line_id = ANY ($1::uuid[]) AND used_at IS NOT NULL`,
    [lines.map((l) => l.id)])).rows.map((o) => ({ override_id: o.id, line_id: o.order_line_id, batch_id: o.batch_id, qty_milli: Number(o.qty_milli) }));
  const stock = await batchStock(c, order.outlet_id, [...new Set([...skuLines, ...dishLines].map((l) => l.ingredient_id))]);
  const fefo = fefoPick(stock, [...skuLines, ...dishLines], order.business_date, consumed);
  if (fefo.refusals.length > 0) throw new ApiError("conflict", "expired_batch");

  type Planned = { rule: string; ingredient_id: string; batch_id: string | null; qty: number; override: string | null };
  const planned: Planned[] = [];
  const add = (rule: string, ingredient_id: string, batch_id: string | null, qty: number, override: string | null) => {
    const hit = planned.find((p) => p.rule === rule && p.ingredient_id === ingredient_id && p.batch_id === batch_id && p.override === override);
    if (hit) hit.qty += qty;
    else planned.push({ rule, ingredient_id, batch_id, qty, override });
  };
  for (const p of fefo.picks) add(p.line_id.startsWith("recipe:") ? dish.rule_id : sku.rule_id, p.ingredient_id, p.batch_id, p.qty_milli, p.override_id);
  for (const m of dish.movements) if (!tracked(m.ingredient_id)) add(dish.rule_id, m.ingredient_id, null, -m.qty_milli, null);
  for (const m of sku.movements) if (!tracked(m.ingredient_id)) add(sku.rule_id, m.ingredient_id, null, -m.qty_milli, null);

  const moves: Array<{ id: string; outlet_id: string; ingredient_id: string; kind: Kind }> = [];
  for (const rule of [dish.rule_id, sku.rule_id]) {
    const mine = planned.filter((p) => p.rule === rule && p.qty > 0);
    if (mine.length === 0) continue;
    await underRule(c, rule, `core.order:${orderId}`, async () => {
      for (const p of mine) {
        const id = await insertMovement(c, { outlet_id: order.outlet_id, ingredient_id: p.ingredient_id, batch_id: p.batch_id, qty_milli: -p.qty,
          unit: ings.get(p.ingredient_id)!.base_unit, kind: "sale_consumption", ref_type: "core.order", ref_id: orderId, expired_sale_override_id: p.override, at: order.created_at });
        moves.push({ id, outlet_id: order.outlet_id, ingredient_id: p.ingredient_id, kind: "sale_consumption" });
      }
    });
  }
  return {
    derived: moves.length > 0,
    movement_ids: moves.map((m) => m.id),
    events: movementEvents({ type: "core.order", id: orderId }, moves),
    negative_on_hand: await negativeAfter(c, moves),
    recipe_lines: dish.lines,
    recipe_missing: dish.recipe_missing,
    issues: [...dish.issues, ...sku.issues],
  };
}

// ---------------------------------------------------------------------------------------------------------
// Goods received (T-025) and sale returns (T-022)
// ---------------------------------------------------------------------------------------------------------

/** Rule inventory.reverse_order_consumption (W2-R6; source state: the order cancelled / rejected): the stock the
 *  order consumed at placement comes back as `sale_return` movements on the same ingredient, batch and unit, once.
 *  Called by orders when the order enters cancelled / rejected, in that transaction. Refused (writes nothing) for an
 *  order outside the source state; idempotent per order. */
export async function reverseOrderConsumption(c: Queryable, orderId: string): Promise<DerivationResult> {
  const nothing: DerivationResult = { derived: false, movement_ids: [], events: [], negative_on_hand: [] };
  const order = await first<{ outlet_id: string }>(c, `SELECT outlet_id FROM core."order" WHERE id = $1`, [orderId]);
  if (!order) throw new ApiError("not_found");
  if (!(await inSourceState(c, "inventory.reverse_order_consumption", "core.order", orderId))) throw refused();
  const back = (await c.query<{ ingredient_id: string; batch_id: string | null; unit: string; qty: string }>(
    `SELECT ingredient_id, batch_id, unit, (-sum(qty_milli))::text AS qty FROM core.stock_movement
      WHERE ref_type = 'core.order' AND ref_id = $1 AND kind = 'sale_consumption'
        AND NOT EXISTS (SELECT 1 FROM core.stock_movement r WHERE r.ref_type = 'core.order' AND r.ref_id = $1 AND r.kind = 'sale_return')
      GROUP BY ingredient_id, batch_id, unit HAVING sum(qty_milli) < 0 ORDER BY ingredient_id, batch_id`, [orderId])).rows;
  if (back.length === 0) return nothing;
  const moves: Array<{ id: string; outlet_id: string; ingredient_id: string; kind: Kind }> = [];
  await underRule(c, "inventory.reverse_order_consumption", `core.order:${orderId}`, async () => {
    for (const m of back) {
      const id = await insertMovement(c, { outlet_id: order.outlet_id, ingredient_id: m.ingredient_id, batch_id: m.batch_id, qty_milli: Number(m.qty),
        unit: m.unit, kind: "sale_return", ref_type: "core.order", ref_id: orderId });
      moves.push({ id, outlet_id: order.outlet_id, ingredient_id: m.ingredient_id, kind: "sale_return" });
    }
  });
  return { derived: true, movement_ids: moves.map((m) => m.id), events: movementEvents({ type: "core.order", id: orderId }, moves), negative_on_hand: [] };
}

/** Rule inventory.receive_grn: one receipt movement per GRN line, in the ingredient's base unit (kg → g and
 *  l → ml convert exactly, and so does the cost of 1000 base units — a ₹/kg price is that cost per 1000 g), into the
 *  line's batch, at the receipt time. Idempotent per GRN. */
export async function deriveGoodsReceipt(c: Queryable, grnId: string): Promise<DerivationResult> {
  const grn = await first<{ id: string; outlet_id: string; received_at: Date }>(c, `SELECT id, outlet_id, received_at FROM core.goods_received WHERE id = $1`, [grnId]);
  if (!grn) throw new ApiError("not_found");
  if (!(await inSourceState(c, "inventory.receive_grn", "core.goods_received", grnId))) throw refused();
  const done = (await c.query<{ id: string }>(`SELECT id FROM core.stock_movement WHERE ref_type = 'core.goods_received' AND ref_id = $1 ORDER BY id`, [grnId])).rows;
  if (done.length > 0) return { derived: false, movement_ids: done.map((m) => m.id), events: [], negative_on_hand: [] };

  const lines = (await c.query<{ id: string; ingredient_id: string; batch_id: string | null; qty_milli: string; unit: string; unit_cost_minor: string; currency: string; base_unit: string }>(
    `SELECT g.id, g.ingredient_id, g.batch_id, g.qty_milli::text, g.unit, g.unit_cost_minor::text, g.currency, i.base_unit
       FROM core.grn_line g JOIN core.ingredient i ON i.tenant_id = g.tenant_id AND i.id = g.ingredient_id
      WHERE g.goods_received_id = $1 ORDER BY g.id`, [grnId])).rows;
  const factors = lines.map((l) => toBaseFactor(l.unit, l.base_unit));
  if (factors.some((f) => f === null)) throw new ApiError("bad_request", "unit_mismatch");

  const moves: Array<{ id: string; outlet_id: string; ingredient_id: string; kind: Kind }> = [];
  await underRule(c, "inventory.receive_grn", `core.goods_received:${grnId}`, async () => {
    for (const [i, l] of lines.entries()) {
      const f = factors[i]!;
      const id = await insertMovement(c, { outlet_id: grn.outlet_id, ingredient_id: l.ingredient_id, batch_id: l.batch_id, qty_milli: Number(l.qty_milli) * f,
        unit: l.base_unit, kind: "receipt", ref_type: "core.goods_received", ref_id: grnId,
        unit_cost_per_1000_minor: mulDiv(Number(l.unit_cost_minor), 1000, f), currency: l.currency, at: grn.received_at });
      moves.push({ id, outlet_id: grn.outlet_id, ingredient_id: l.ingredient_id, kind: "receipt" });
    }
  });
  return { derived: moves.length > 0, movement_ids: moves.map((m) => m.id), events: movementEvents({ type: "core.goods_received", id: grnId }, moves), negative_on_hand: [] };
}

/** Rule inventory.sale_return (source state: restock): goods a customer brought back go back on the shelf. Only a
 *  SKU line restocks (a dish cannot); the quantity returns into the batches that order drew for that stock
 *  record, earliest expiry first, up to what each gave less what earlier returns put back (INFERENCE: the
 *  physical batch is unknown — earliest expiry is the food-safe guess); any rest is unbatched. A return that
 *  is not restocked derives nothing. Idempotent per return. */
export async function deriveSaleReturn(c: Queryable, saleReturnId: string): Promise<DerivationResult> {
  const sr = await first<{ id: string; outlet_id: string; order_id: string; order_line_id: string; qty_milli: string; restock: boolean; at: Date }>(c,
    `SELECT id, outlet_id, order_id, order_line_id, qty_milli::text, restock, at FROM core.sale_return WHERE id = $1`, [saleReturnId]);
  if (!sr) throw new ApiError("not_found");
  const nothing: DerivationResult = { derived: false, movement_ids: [], events: [], negative_on_hand: [] };
  if (!(await inSourceState(c, "inventory.sale_return", "core.sale_return", saleReturnId))) return nothing;
  const done = (await c.query<{ id: string }>(`SELECT id FROM core.stock_movement WHERE ref_type = 'core.sale_return' AND ref_id = $1 ORDER BY id`, [saleReturnId])).rows;
  if (done.length > 0) return { ...nothing, movement_ids: done.map((m) => m.id) };
  const line = await first<{ kind: string; stock_ingredient_id: string | null; base_unit: string | null }>(c,
    `SELECT i.kind, i.stock_ingredient_id, g.base_unit FROM core.order_line l JOIN core.item i ON i.tenant_id = l.tenant_id AND i.id = l.item_id
       LEFT JOIN core.ingredient g ON g.tenant_id = i.tenant_id AND g.id = i.stock_ingredient_id WHERE l.id = $1`, [sr.order_line_id]);
  if (line?.kind !== "sku" || !line.stock_ingredient_id) return nothing;

  const sources = (await c.query<{ batch_id: string; remaining: string }>(
    `SELECT m.batch_id, (-sum(m.qty_milli) - coalesce((SELECT sum(r.qty_milli) FROM core.stock_movement r JOIN core.sale_return s ON s.tenant_id = r.tenant_id AND s.id = r.ref_id
                                                    WHERE r.ref_type = 'core.sale_return' AND s.order_id = $1 AND r.batch_id = m.batch_id), 0))::text AS remaining
       FROM core.stock_movement m JOIN core.batch b ON b.tenant_id = m.tenant_id AND b.id = m.batch_id
      WHERE m.ref_type = 'core.order' AND m.ref_id = $1 AND m.kind = 'sale_consumption' AND m.ingredient_id = $2
      GROUP BY m.batch_id, b.expires_on, b.received_at ORDER BY b.expires_on NULLS LAST, b.received_at, m.batch_id`, [sr.order_id, line.stock_ingredient_id])).rows;
  let rest = Number(sr.qty_milli);
  const parts: Array<{ batch_id: string | null; qty: number }> = [];
  for (const s of sources) {
    const q = Math.min(rest, Number(s.remaining));
    if (q > 0) {
      parts.push({ batch_id: s.batch_id, qty: q });
      rest -= q;
    }
  }
  if (rest > 0) parts.push({ batch_id: null, qty: rest });

  const moves: Array<{ id: string; outlet_id: string; ingredient_id: string; kind: Kind }> = [];
  await underRule(c, "inventory.sale_return", `core.sale_return:${saleReturnId}`, async () => {
    for (const p of parts) {
      const id = await insertMovement(c, { outlet_id: sr.outlet_id, ingredient_id: line.stock_ingredient_id!, batch_id: p.batch_id, qty_milli: p.qty,
        unit: line.base_unit!, kind: "sale_return", ref_type: "core.sale_return", ref_id: saleReturnId, at: sr.at });
      moves.push({ id, outlet_id: sr.outlet_id, ingredient_id: line.stock_ingredient_id!, kind: "sale_return" });
    }
  });
  return { derived: true, movement_ids: moves.map((m) => m.id), events: movementEvents({ type: "core.sale_return", id: saleReturnId }, moves), negative_on_hand: [] };
}
