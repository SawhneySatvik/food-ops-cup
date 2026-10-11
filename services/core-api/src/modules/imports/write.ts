// Writing approved history (R44b, c): bills (POS exports, pos_bills_v2) and waste, inside the approving transaction
// (app.decision_id set by approvals). The rows a person approved (orders, lines, voids, tenders, refunds, waste
// entries) are written under the decision; everything derived from them is written under its seeded rule, so the
// book guard judges every row as it judges a live sale.
//
// Two paths, the same rows:
//   "seams"   — per bill, through the owners' seams: finance's postFor (post_order, post_tender, post_refund) and
//               inventory's deriveOrderConsumption. One round trip per row and per read: ~32 queries a bill.
//   "batched" — the commit path. Base rows go in as multi-row INSERTs per chunk; the derived rows are computed here
//               with the same core-domain functions the seams call (postOrder, postTender, postRefund, consumeOrder,
//               consumeSku, fefoPick) and written by core.write_derived (0018) in one statement per chunk, where the
//               guard still fires per row. The equivalence gate (imports-history.test.ts) holds the two to the same
//               rows, postings, origins and audit entries.
import type { CountryPack } from "@munim/contracts/packs";
import { channelTreatment, type Line, postLoyaltyRedemption, postOrder, postRefund, postTender, roleResolver, type TenderMethod } from "@munim/core-domain/finance";
import { type ConsumeInput, consumeOrder, consumeSku } from "@munim/core-domain/inventory";
import { businessDate } from "@munim/core-domain/tz";
import { uuidv7 } from "../../commit/index.ts";
import { ApiError } from "../../lib/errors.ts";
import type { Queryable } from "../../runtoken/index.ts";
import { postFor } from "../finance/index.ts";
import { deriveOrderConsumption, fefoPick } from "../inventory/index.ts";

export type WriteMode = "seams" | "batched";
/** Bills per chunk of the batched path (a chunk is ~10 statements whatever its size). */
export const CHUNK = 500;
const VOID_NOTE = "Synthetic history import";

export interface BillLine {
  item_id: string;
  variant_id: string | null;
  qty_milli: number;
  unit_price_minor: number;
  line_discount_minor: number;
  tax_minor: number;
  total_minor: number;
  /** A line void (a remake written off) on a completed bill. */
  void_reason: string | null;
}
export interface Bill {
  bill_no: string;
  business_date: string;
  /** The bill's instant (ISO): the order's created_at, its tenders' and its stock movements' time. */
  at: string;
  outlet_id: string;
  channel_id: string;
  channel_kind: string;
  brand_id: string | null;
  kind: string;
  customer_id: string | null;
  status: "completed" | "cancelled";
  subtotal_minor: number;
  discount_minor: number;
  tax_minor: number;
  total_minor: number;
  lines: BillLine[];
  tenders: Array<{ method: TenderMethod; amount_minor: number }>;
  refund: { method: TenderMethod; amount_minor: number; reason_code: string; at: string } | null;
  /** The whole-bill void of a cancelled bill. */
  void_reason: string | null;
  snapshot: Record<string, unknown>;
}

interface Who { by: string; currency: string }

// ---- base rows (the approved rows; the same SQL on both paths) --------------------------------------------------

interface Ids { order: string; lines: string[]; tenders: string[]; refund: string | null }

async function insertBase(c: Queryable, bills: readonly Bill[], w: Who): Promise<Ids[]> {
  const ids: Ids[] = bills.map((b) => ({ order: uuidv7(), lines: b.lines.map(() => uuidv7()), tenders: b.tenders.map(() => uuidv7()), refund: b.refund ? uuidv7() : null }));
  const T = "current_setting('app.tenant_id')::uuid";
  // Orders in file order: the database numbers tickets per outlet and business date in insertion order.
  await c.query(
    `INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, brand_id, kind, status, business_date, customer_id, subtotal_minor, discount_minor,
                               tax_minor, total_minor, currency, pricing_snapshot, external_ref, created_at, created_by)
     SELECT ${T}, x.id, x.outlet_id, x.channel_id, x.brand_id, x.kind, x.status, x.business_date, x.customer_id, x.subtotal_minor, x.discount_minor,
            x.tax_minor, x.total_minor, $2, x.snapshot, x.bill_no, x.at, $3
       FROM jsonb_to_recordset($1::jsonb) AS x (id uuid, outlet_id uuid, channel_id uuid, brand_id uuid, kind text, status text,
            business_date date, customer_id uuid, subtotal_minor bigint, discount_minor bigint, tax_minor bigint, total_minor bigint, snapshot jsonb,
            bill_no text, at timestamptz, ord int)
      ORDER BY x.ord`,
    [JSON.stringify(bills.map((b, i) => ({ ...b, id: ids[i]!.order, ord: i, lines: undefined, tenders: undefined, refund: undefined }))), w.currency, w.by]);
  const lines = bills.flatMap((b, i) => b.lines.map((l, j) => ({ ...l, id: ids[i]!.lines[j], order_id: ids[i]!.order, outlet_id: b.outlet_id, line_no: j + 1, at: b.at })));
  if (lines.length) {
    await c.query(
      `INSERT INTO core.order_line (tenant_id, id, outlet_id, order_id, line_no, item_id, variant_id, qty_milli, unit_price_minor, line_discount_minor,
                                    tax_minor, created_at, created_by)
       SELECT ${T}, x.id, x.outlet_id, x.order_id, x.line_no, x.item_id, x.variant_id, x.qty_milli, x.unit_price_minor, x.line_discount_minor,
              x.tax_minor, x.at, $2
         FROM jsonb_to_recordset($1::jsonb) AS x (id uuid, outlet_id uuid, order_id uuid, line_no int, item_id uuid, variant_id uuid, qty_milli bigint,
              unit_price_minor bigint, line_discount_minor bigint, tax_minor bigint, at timestamptz)`,
      [JSON.stringify(lines), w.by]);
  }
  // Voids: a line written off (the line's own total, as orders.void.record.v1 values it) or a whole cancelled bill.
  const voids = bills.flatMap((b, i) => [
    ...b.lines.flatMap((l, j) => (l.void_reason ? [{ order_line_id: ids[i]!.lines[j], reason_code: l.void_reason, amount_minor: l.total_minor }] : [])),
    ...(b.status === "cancelled" ? [{ order_line_id: null, reason_code: b.void_reason, amount_minor: b.total_minor }] : []),
  ].map((v) => ({ ...v, id: uuidv7(), order_id: ids[i]!.order, outlet_id: b.outlet_id, at: b.at })));
  if (voids.length) {
    await c.query(
      `INSERT INTO core.void (tenant_id, id, outlet_id, order_id, order_line_id, reason_code, note, amount_minor, currency, actor, at)
       SELECT ${T}, x.id, x.outlet_id, x.order_id, x.order_line_id, x.reason_code, $2, x.amount_minor, $3, $4, x.at
         FROM jsonb_to_recordset($1::jsonb) AS x (id uuid, outlet_id uuid, order_id uuid, order_line_id uuid, reason_code text, amount_minor bigint, at timestamptz)`,
      [JSON.stringify(voids), VOID_NOTE, w.currency, w.by]);
  }
  const tenders = bills.flatMap((b, i) => b.tenders.map((t, j) => ({ ...t, id: ids[i]!.tenders[j], order_id: ids[i]!.order, outlet_id: b.outlet_id, ref: b.bill_no, at: b.at })));
  if (tenders.length) {
    await c.query(
      `INSERT INTO core.tender (tenant_id, id, outlet_id, order_id, method, amount_minor, currency, recorded_by, ref, at)
       SELECT ${T}, x.id, x.outlet_id, x.order_id, x.method, x.amount_minor, $2, $3, x.ref, x.at
         FROM jsonb_to_recordset($1::jsonb) AS x (id uuid, outlet_id uuid, order_id uuid, method text, amount_minor bigint, ref text, at timestamptz)`,
      [JSON.stringify(tenders), w.currency, w.by]);
  }
  // A refund names the bill's tender of the same method when there is one.
  const refunds = bills.flatMap((b, i) => (b.refund ? [{ ...b.refund, id: ids[i]!.refund, order_id: ids[i]!.order, outlet_id: b.outlet_id,
    tender_id: ids[i]!.tenders[b.tenders.findIndex((t) => t.method === b.refund!.method)] ?? null }] : []));
  if (refunds.length) {
    await c.query(
      `INSERT INTO core.refund (tenant_id, id, outlet_id, order_id, tender_id, method, amount_minor, currency, reason_code, note, actor, at)
       SELECT ${T}, x.id, x.outlet_id, x.order_id, x.tender_id, x.method, x.amount_minor, $2, x.reason_code, $3, $4, x.at
         FROM jsonb_to_recordset($1::jsonb) AS x (id uuid, outlet_id uuid, order_id uuid, tender_id uuid, method text, amount_minor bigint, reason_code text,
              at timestamptz)`,
      [JSON.stringify(refunds), w.currency, VOID_NOTE, w.by]);
  }
  return ids;
}

// ---- the seams path ---------------------------------------------------------------------------------------------

async function billViaSeams(c: Queryable, b: Bill, w: Who): Promise<void> {
  const [ids] = await insertBase(c, [b], w);
  if (b.status !== "completed") return;
  await postFor(c, "finance.post_order", `core.order:${ids!.order}`);
  for (const t of ids!.tenders) await postFor(c, "finance.post_tender", `core.tender:${t}`);
  if (ids!.refund) await postFor(c, "finance.post_refund", `core.refund:${ids!.refund}`);
  if (b.lines.length) await deriveOrderConsumption(c, ids!.order);
}

// ---- the batched path -------------------------------------------------------------------------------------------

export type Group = { rule: string; source_ref: string; journal_entry?: unknown[]; posting?: unknown[]; stock_movement?: unknown[] };
type BatchStock = Parameters<typeof fefoPick>[0][number];

/** What the derivations read, once per commit (the seams read it per row). */
async function loadContext(c: Queryable, bills: readonly Bill[]) {
  // finance's tenantPack and chartRoles, read the same way.
  const pack = (await c.query<{ doc: CountryPack }>(
    `SELECT p.doc FROM core.tenant t JOIN platform.country_pack p ON p.code = t.country_code AND p.status = 'active'
      WHERE t.tenant_id = current_setting('app.tenant_id')::uuid ORDER BY p.version DESC LIMIT 1`)).rows[0]!.doc;
  const roles = roleResolver((await c.query<{ id: string; code: string; type: string }>(`SELECT id, code, type FROM core.account WHERE active`)).rows);
  const outlets = new Map((await c.query<{ id: string; tz: string; cutoff: string }>(
    `SELECT id, tz, to_char(business_day_cutoff, 'HH24:MI') AS cutoff FROM core.outlet`)).rows.map((o) => [o.id, o]));
  // inventory's catalogue reads for consumption (deriveOrderConsumption), for every item of these bills.
  const itemIds = [...new Set(bills.flatMap((b) => b.lines.map((l) => l.item_id)))];
  const items = new Map((await c.query<{ id: string; kind: string; stock_ingredient_id: string | null }>(
    `SELECT id, kind, stock_ingredient_id FROM core.item WHERE id = ANY ($1::uuid[])`, [itemIds])).rows.map((i) => [i.id, i]));
  const versions = (await c.query<{ id: string; item_id: string; variant_id: string | null; version: number; valid_from: string; valid_to: string | null; yield_qty_milli: string }>(
    `SELECT id, item_id, variant_id, version, valid_from::text, valid_to::text, yield_qty_milli::text FROM core.recipe_version WHERE item_id = ANY ($1::uuid[])`, [itemIds])).rows;
  const recipeLines = (await c.query<{ recipe_version_id: string; ingredient_id: string; qty_milli: string; unit: string; waste_pct_bp: number }>(
    `SELECT recipe_version_id, ingredient_id, qty_milli::text, unit, waste_pct_bp FROM core.recipe_line WHERE recipe_version_id = ANY ($1::uuid[])`,
    [versions.map((v) => v.id)])).rows;
  const ings = new Map((await c.query<{ id: string; base_unit: string; tracked_by_batch: boolean }>(
    `SELECT id, base_unit, tracked_by_batch FROM core.ingredient WHERE id = ANY ($1::uuid[])`,
    [[...new Set([...recipeLines.map((l) => l.ingredient_id), ...[...items.values()].flatMap((i) => (i.stock_ingredient_id ? [i.stock_ingredient_id] : []))])]])).rows
    .map((i) => [i.id, i]));
  // inventory's batchStock (batches with stock > 0) for every tracked ingredient at every outlet of these bills; the
  // batched path draws it down in memory exactly as the movements it writes would.
  const tracked = [...ings.values()].filter((i) => i.tracked_by_batch).map((i) => i.id);
  const stock = new Map<string, BatchStock[]>();
  for (const outletId of new Set(bills.map((b) => b.outlet_id))) {
    stock.set(outletId, tracked.length === 0 ? [] : (await c.query<{ batch_id: string; ingredient_id: string; expires_on: string | null; received_at: Date; remaining: string }>(
      `SELECT b.id AS batch_id, b.ingredient_id, b.expires_on::text AS expires_on, b.received_at, sum(m.qty_milli)::text AS remaining
         FROM core.batch b JOIN core.stock_movement m ON m.tenant_id = b.tenant_id AND m.outlet_id = b.outlet_id AND m.batch_id = b.id
        WHERE b.outlet_id = $1 AND b.ingredient_id = ANY ($2::uuid[])
        GROUP BY b.tenant_id, b.id HAVING sum(m.qty_milli) > 0`, [outletId, tracked])).rows
      .map((b) => ({ batch_id: b.batch_id, ingredient_id: b.ingredient_id, expires_on: b.expires_on, received_at: b.received_at.toISOString(), remaining_milli: Number(b.remaining) })));
  }
  return { pack, roles, outlets, items, versions, recipeLines, ings, stock };
}
type Ctx = Awaited<ReturnType<typeof loadContext>>;

/** An entry group for finance's write (header + postings) — the shape postFor writes. */
function entry(ctx: Ctx, rule: string, sourceRef: string, h: { outlet_id: string; brand_id: string | null; channel_id: string; entry_date: string },
  currency: string, lines: Line[] | null): Group | null {
  if (!lines) return null;
  const id = uuidv7();
  return { rule, source_ref: sourceRef, journal_entry: [{ id, ...h }],
    posting: lines.map((l) => ({ id: uuidv7(), journal_entry_id: id, account_id: ctx.roles.need(l.role).id, amount_minor: l.amount_minor, currency })) };
}

/** deriveOrderConsumption's plan for one order, on the preloaded catalogue and the in-memory batch stock. */
function consumption(ctx: Ctx, b: Bill, orderId: string, lineIds: readonly string[]): Group[] {
  const items = new Map(b.lines.map((l) => [l.item_id, ctx.items.get(l.item_id)!]));
  const versions = ctx.versions.filter((v) => items.has(v.item_id));
  const ingIds = new Set([...ctx.recipeLines.filter((l) => versions.some((v) => v.id === l.recipe_version_id)).map((l) => l.ingredient_id),
    ...[...items.values()].flatMap((i) => (i.stock_ingredient_id ? [i.stock_ingredient_id] : []))]);
  const ings = new Map([...ingIds].flatMap((id) => (ctx.ings.has(id) ? [[id, ctx.ings.get(id)!] as const] : [])));
  const input: ConsumeInput = {
    order: { order_id: orderId, outlet_id: b.outlet_id, placed_at: new Date(b.at).toISOString(), business_date: b.business_date,
      lines: b.lines.map((l, j) => ({ line_no: j + 1, item_id: l.item_id, variant_id: l.variant_id, option_ids: [], qty_milli: l.qty_milli })) },
    items: [...items.values()].map((i) => ({ item_id: i.id, kind: i.kind, stock_ingredient_id: i.stock_ingredient_id })),
    ingredients: [...ings.values()].map((i) => ({ ingredient_id: i.id, base_unit: i.base_unit })),
    recipe_versions: versions.map((v) => ({ recipe_version_id: v.id, item_id: v.item_id, variant_id: v.variant_id, version: v.version, valid_from: v.valid_from,
      valid_to: v.valid_to, yield_qty_milli: Number(v.yield_qty_milli),
      lines: ctx.recipeLines.filter((l) => l.recipe_version_id === v.id).map((l) => ({ ingredient_id: l.ingredient_id, qty_milli: Number(l.qty_milli), unit: l.unit, waste_pct_bp: l.waste_pct_bp })) })),
    option_deltas: [],
  };
  const dish = consumeOrder(input);
  const sku = consumeSku(input);
  const tracked = (id: string) => ings.get(id)?.tracked_by_batch === true;
  const skuLines = b.lines.flatMap((l, j) => {
    const item = items.get(l.item_id)!;
    const ing = item.kind === "sku" && item.stock_ingredient_id ? ings.get(item.stock_ingredient_id) : undefined;
    return ing?.tracked_by_batch ? [{ line_id: lineIds[j]!, ingredient_id: ing.id, qty_milli: l.qty_milli }] : [];
  });
  const dishLines = dish.movements.filter((m) => tracked(m.ingredient_id))
    .map((m) => ({ line_id: `recipe:${m.ingredient_id}`, ingredient_id: m.ingredient_id, qty_milli: -m.qty_milli, expired_blocks: false }));
  const need = new Set([...skuLines, ...dishLines].map((l) => l.ingredient_id));
  const stock = (ctx.stock.get(b.outlet_id) ?? []).filter((s) => need.has(s.ingredient_id) && s.remaining_milli > 0).map((s) => ({ ...s }));
  const fefo = fefoPick(stock, [...skuLines, ...dishLines], b.business_date, []);
  if (fefo.refusals.length > 0) throw new ApiError("conflict", "expired_batch");
  for (const p of fefo.picks) {
    const s = p.batch_id ? ctx.stock.get(b.outlet_id)!.find((x) => x.batch_id === p.batch_id) : undefined;
    if (s) s.remaining_milli -= p.qty_milli;
  }

  type Planned = { rule: string; ingredient_id: string; batch_id: string | null; qty: number };
  const planned: Planned[] = [];
  const add = (rule: string, ingredient_id: string, batch_id: string | null, qty: number) => {
    const hit = planned.find((p) => p.rule === rule && p.ingredient_id === ingredient_id && p.batch_id === batch_id);
    if (hit) hit.qty += qty;
    else planned.push({ rule, ingredient_id, batch_id, qty });
  };
  for (const p of fefo.picks) add(p.line_id.startsWith("recipe:") ? dish.rule_id : sku.rule_id, p.ingredient_id, p.batch_id, p.qty_milli);
  for (const m of dish.movements) if (!tracked(m.ingredient_id)) add(dish.rule_id, m.ingredient_id, null, -m.qty_milli);
  for (const m of sku.movements) if (!tracked(m.ingredient_id)) add(sku.rule_id, m.ingredient_id, null, -m.qty_milli);
  return [dish.rule_id, sku.rule_id].flatMap((rule) => {
    const mine = planned.filter((p) => p.rule === rule && p.qty > 0);
    return mine.length === 0 ? [] : [{ rule, source_ref: `core.order:${orderId}`, stock_movement: mine.map((p) => ({
      id: uuidv7(), outlet_id: b.outlet_id, ingredient_id: p.ingredient_id, batch_id: p.batch_id, qty_milli: -p.qty, unit: ings.get(p.ingredient_id)!.base_unit,
      kind: "sale_consumption", unit_cost_per_1000_minor: null, currency: null, expired_sale_override_id: null, at: b.at })) }];
  });
}

/** Every derived group of one bill, in the order the seams path writes them. */
function derived(ctx: Ctx, b: Bill, ids: Ids, currency: string): Group[] {
  if (b.status !== "completed") return [];
  const tr = channelTreatment(ctx.pack, b.channel_kind);
  const o = ctx.outlets.get(b.outlet_id)!;
  const head = { outlet_id: b.outlet_id, brand_id: b.brand_id, channel_id: b.channel_id };
  const ref = `core.order:${ids.order}`;
  const sale = postOrder({ ...tr, total_minor: b.total_minor, tax_minor: b.tax_minor });
  const groups: Array<Group | null> = [
    entry(ctx, "finance.post_order", ref, { ...head, entry_date: b.business_date }, currency, sale),
    // History carries no loyalty: the redemption rule derives nothing, as postFor's second call finds.
    entry(ctx, "finance.post_loyalty_redemption", ref, { ...head, entry_date: b.business_date }, currency,
      postLoyaltyRedemption({ aggregator: tr.aggregator, value_minor: 0 })),
    ...b.tenders.map((t, j) => entry(ctx, "finance.post_tender", `core.tender:${ids.tenders[j]}`,
      { ...head, entry_date: businessDate(b.at, o.tz, o.cutoff) }, currency,
      postTender({ aggregator: tr.aggregator, method: t.method, amount_minor: t.amount_minor, rounding_minor: 0 }))),
    b.refund ? entry(ctx, "finance.post_refund", `core.refund:${ids.refund}`, { ...head, entry_date: businessDate(b.refund.at, o.tz, o.cutoff) }, currency,
      postRefund({ aggregator: tr.aggregator, operator_collects: tr.operator_collects, method: b.refund.method, amount_minor: b.refund.amount_minor,
        order_total_minor: b.total_minor, order_tax_minor: b.tax_minor, prior_refunded_minor: 0, sale_posted: sale !== null })) : null,
  ];
  return [...groups.filter((g): g is Group => g !== null), ...(b.lines.length ? consumption(ctx, b, ids.order, ids.lines) : [])];
}

export async function writeDerived(c: Queryable, groups: readonly Group[]): Promise<void> {
  if (groups.length === 0) return;
  await c.query(`SELECT core.write_derived($1::jsonb)`, [JSON.stringify(groups)]);
  // finance's checkBalancedNow: the deferred balance checks fire here, so an imbalance surfaces at the call site.
  await c.query(`SET CONSTRAINTS core.entry_balanced, core.posting_balanced IMMEDIATE`);
  await c.query(`SET CONSTRAINTS core.entry_balanced, core.posting_balanced DEFERRED`);
}

export async function writeBills(c: Queryable, bills: readonly Bill[], w: Who, mode: WriteMode): Promise<void> {
  if (mode === "seams") {
    for (const b of bills) await billViaSeams(c, b, w);
    return;
  }
  const ctx = await loadContext(c, bills);
  for (let i = 0; i < bills.length; i += CHUNK) {
    const chunk = bills.slice(i, i + CHUNK);
    const ids = await insertBase(c, chunk, w);
    await writeDerived(c, chunk.flatMap((b, j) => derived(ctx, b, ids[j]!, w.currency)));
  }
}

// ---- waste ------------------------------------------------------------------------------------------------------

export interface Waste { at: string; outlet_id: string; ingredient_id: string; qty_milli: number; unit: string; reason: string; note: string | null }

async function insertWaste(c: Queryable, rows: readonly Waste[], w: Who): Promise<string[]> {
  const ids = rows.map(() => uuidv7());
  await c.query(
    `INSERT INTO core.waste_log (tenant_id, id, outlet_id, ingredient_id, batch_id, qty_milli, unit, reason, note, recorded_by, at)
     SELECT current_setting('app.tenant_id')::uuid, x.id, x.outlet_id, x.ingredient_id, NULL, x.qty_milli, x.unit, x.reason, x.note, $2, x.at
       FROM jsonb_to_recordset($1::jsonb) AS x (id uuid, outlet_id uuid, ingredient_id uuid, qty_milli bigint, unit text, reason text, note text, at timestamptz)`,
    [JSON.stringify(rows.map((r, i) => ({ ...r, id: ids[i] }))), w.by]);
  return ids;
}

/** The movement inventory.waste.record.v1 derives from a waste entry (inventory.record_waste). */
const wasteMovement = (r: Waste) => ({ id: uuidv7(), outlet_id: r.outlet_id, ingredient_id: r.ingredient_id, batch_id: null, qty_milli: -r.qty_milli, unit: r.unit,
  kind: "waste", unit_cost_per_1000_minor: null, currency: null, expired_sale_override_id: null, at: r.at });

export async function writeWaste(c: Queryable, rows: readonly Waste[], w: Who, mode: WriteMode): Promise<void> {
  if (mode === "seams") {
    // inventory exports no waste seam: the per-row form of what its waste handler writes (underRule + INSERT).
    for (const r of rows) {
      const [id] = await insertWaste(c, [r], w);
      const m = wasteMovement(r);
      await c.query(`SELECT set_config('app.posting_rule', 'inventory.record_waste', true), set_config('app.source_ref', $1, true)`, [`core.waste_log:${id}`]);
      await c.query(
        `INSERT INTO core.stock_movement (tenant_id, id, outlet_id, ingredient_id, batch_id, qty_milli, unit, kind, ref_type, ref_id, at, created_by)
         VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, NULL, $4, $5, 'waste', 'core.waste_log', $6, $7, nullif(current_setting('app.member_id', true), '')::uuid)`,
        [m.id, m.outlet_id, m.ingredient_id, m.qty_milli, m.unit, id, m.at]);
      await c.query(`SELECT set_config('app.posting_rule', '', true), set_config('app.source_ref', '', true)`);
    }
    return;
  }
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const ids = await insertWaste(c, chunk, w);
    await writeDerived(c, chunk.map((r, j) => ({ rule: "inventory.record_waste", source_ref: `core.waste_log:${ids[j]}`, stock_movement: [wasteMovement(r)] })));
  }
}
