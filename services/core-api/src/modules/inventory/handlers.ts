// Inventory command handlers. Each is bound to one seeded command type and writes only that command's
// target_tables (0007); the movements of waste and transfers are written under their seeded derivation rule
// (0008: inventory.record_waste, transfer_out, transfer_in) in the same transaction. Quantities are taken in the
// ingredient's base unit (anything else is `unit_mismatch`), so on-hand = Σ qty_milli stays one unit.
import {
  InventoryBatchUpdateV1, InventoryCountSubmitV1, InventoryExpiredSaleOverrideV1, InventoryIngredientUpsertV1, InventoryReorderLevelSetV1,
  InventoryStockReceiveV1, InventoryTransferCreateV1, InventoryTransferReceiveV1, InventoryWasteRecordV1,
} from "@munim/contracts/inventory";
import { mulDiv } from "@munim/core-domain/money";
import { type AuditEntry, type CommandHandler, uuidv7 } from "../../commit/index.ts";
import { ApiError } from "../../lib/errors.ts";
import { lockOutlets } from "../../lib/locks.ts";
import type { Queryable } from "../../runtoken/index.ts";
import { isExpired } from "./fefo.ts";
import {
  first, insertMovement, type Kind, ME, movementEvents, negativeAfter, onHand, outletBusinessDate, T, tenantPack, toBaseFactor, underRule,
} from "./stock.ts";

const bad = () => new ApiError("bad_request");
type Move = { id: string; outlet_id: string; ingredient_id: string; kind: Kind };

async function ingredient(c: Queryable, id: string): Promise<{ base_unit: string; tracked_by_batch: boolean }> {
  const r = await first<{ base_unit: string; tracked_by_batch: boolean }>(c, `SELECT base_unit, tracked_by_batch FROM core.ingredient WHERE id = $1`, [id]);
  if (!r) throw bad();
  return r;
}

/** The quantity's unit must be the ingredient's base unit. */
async function baseUnit(c: Queryable, ingredientId: string, unit: string): Promise<{ base_unit: string; tracked_by_batch: boolean }> {
  const ing = await ingredient(c, ingredientId);
  if (ing.base_unit !== unit) throw new ApiError("bad_request", "unit_mismatch");
  return ing;
}

/** A batch of this ingredient at this outlet (RLS hides other outlets' batches → bad_request). */
async function batchAt(c: Queryable, batchId: string, outletId: string, ingredientId: string) {
  const b = await first<{ batch_code: string; expires_on: string | null }>(c,
    `SELECT batch_code, expires_on::text FROM core.batch WHERE id = $1 AND outlet_id = $2 AND ingredient_id = $3`, [batchId, outletId, ingredientId]);
  if (!b) throw bad();
  return b;
}

// ---- ingredients ----
export const ingredientUpsert: CommandHandler = {
  type: "inventory.ingredient.upsert.v1",
  async run(c, command) {
    const p = InventoryIngredientUpsertV1.parse(command.payload);
    const prior = await first<{ base_unit: string; moved: boolean }>(c,
      `SELECT base_unit, EXISTS (SELECT 1 FROM core.stock_movement m WHERE m.ingredient_id = i.id) AS moved FROM core.ingredient i WHERE id = $1`, [p.ingredient_id]);
    if (prior) {
      // Movements are summed in the base unit: it cannot change once stock has moved.
      if (prior.moved && prior.base_unit !== p.base_unit) throw new ApiError("conflict", "unit_mismatch");
      await c.query(`UPDATE core.ingredient SET name = $2, base_unit = $3, shelf_life_days = $4, tracked_by_batch = $5 WHERE id = $1`,
        [p.ingredient_id, p.name, p.base_unit, p.shelf_life_days, p.tracked_by_batch]);
    } else {
      await c.query(`INSERT INTO core.ingredient (tenant_id, id, name, base_unit, shelf_life_days, tracked_by_batch, created_by) VALUES (${T}, $1, $2, $3, $4, $5, ${ME})`,
        [p.ingredient_id, p.name, p.base_unit, p.shelf_life_days, p.tracked_by_batch]);
    }
    return { entityId: p.ingredient_id, audit: [{ entity: "core.ingredient", entityId: p.ingredient_id, after: { base_unit: p.base_unit, tracked_by_batch: p.tracked_by_batch } }] };
  },
};

// ---- opening stock ----
export const stockReceive: CommandHandler = {
  type: "inventory.stock.receive.v1",
  async run(c, command) {
    const p = InventoryStockReceiveV1.parse(command.payload);
    const moves: Move[] = [];
    for (const l of p.lines) {
      const ing = await ingredient(c, l.ingredient_id);
      const f = toBaseFactor(l.unit, ing.base_unit);
      if (f === null) throw new ApiError("bad_request", "unit_mismatch");
      // Batch-tracked stock names its batch; untracked stock has none.
      if (ing.tracked_by_batch !== (l.batch_id !== null) || (l.batch !== null && l.batch_id === null)) throw bad();
      if (l.batch_id !== null && l.batch !== null) {
        await c.query(
          `INSERT INTO core.batch (tenant_id, id, outlet_id, ingredient_id, batch_code, expires_on, received_at, mrp_minor, currency, created_by)
           VALUES (${T}, $1, $2, $3, $4, $5, $6, $7, $8, ${ME})`,
          [l.batch_id, p.outlet_id, l.ingredient_id, l.batch.batch_code, l.batch.expires_on, p.at, l.batch.mrp_minor, l.batch.mrp_minor === null ? null : l.unit_cost.currency]);
      } else if (l.batch_id !== null) {
        await batchAt(c, l.batch_id, p.outlet_id, l.ingredient_id);
      }
      const id = await insertMovement(c, { id: l.movement_id, outlet_id: p.outlet_id, ingredient_id: l.ingredient_id, batch_id: l.batch_id, qty_milli: l.qty_milli * f,
        unit: ing.base_unit, kind: "receipt", ref_type: null, ref_id: null, unit_cost_per_1000_minor: mulDiv(l.unit_cost.amount_minor, 1000, f), currency: l.unit_cost.currency, at: p.at });
      moves.push({ id, outlet_id: p.outlet_id, ingredient_id: l.ingredient_id, kind: "receipt" });
    }
    // No event: opening stock has no source row to cite (movement.recorded.v1 requires ref_type + ref_id).
    return { entityId: p.lines[0]!.movement_id, audit: moves.map((m) => ({ entity: "core.stock_movement", entityId: m.id, after: { kind: "receipt", source: "opening" } })) };
  },
};

// ---- waste ----
export const wasteRecord: CommandHandler = {
  type: "inventory.waste.record.v1",
  async run(c, command) {
    const p = InventoryWasteRecordV1.parse(command.payload);
    const ing = await baseUnit(c, p.ingredient_id, p.unit);
    if (p.batch_id !== null) await batchAt(c, p.batch_id, p.outlet_id, p.ingredient_id);
    if (p.reason === "other" && p.note === null) throw bad();
    await c.query(
      `INSERT INTO core.waste_log (tenant_id, id, outlet_id, ingredient_id, batch_id, qty_milli, unit, reason, note, recorded_by)
       VALUES (${T}, $1, $2, $3, $4, $5, $6, $7, $8, ${ME})`, [p.waste_id, p.outlet_id, p.ingredient_id, p.batch_id, p.qty_milli, ing.base_unit, p.reason, p.note]);
    const at = (await first<{ at: Date }>(c, `SELECT at FROM core.waste_log WHERE id = $1`, [p.waste_id]))!.at;
    const id = await underRule(c, "inventory.record_waste", `core.waste_log:${p.waste_id}`, () => insertMovement(c, {
      outlet_id: p.outlet_id, ingredient_id: p.ingredient_id, batch_id: p.batch_id, qty_milli: -p.qty_milli, unit: ing.base_unit,
      kind: "waste", ref_type: "core.waste_log", ref_id: p.waste_id, at }));
    const moves: Move[] = [{ id, outlet_id: p.outlet_id, ingredient_id: p.ingredient_id, kind: "waste" }];
    await negativeAfter(c, moves);
    return {
      entityId: p.waste_id,
      audit: [{ entity: "core.waste_log", entityId: p.waste_id, after: { reason: p.reason, movement_id: id } }],
      events: movementEvents({ type: "core.waste_log", id: p.waste_id }, moves),
    };
  },
};

// ---- counts ----
export const countSubmit: CommandHandler = {
  type: "inventory.count.submit.v1",
  async run(c, command) {
    const p = InventoryCountSubmitV1.parse(command.payload);
    // The outlet's count lock, shared with history count approvals (R-A 3): a back-dated count approved meanwhile waits,
    // then sees this count as later than its own and goes stale.
    await lockOutlets(c, "stock_count", [p.outlet_id]);
    const keys = p.lines.map((l) => `${l.ingredient_id}|${l.batch_id}`);
    if (new Set(keys).size !== keys.length) throw bad();
    const lines = [];
    for (const l of p.lines) {
      const ing = await baseUnit(c, l.ingredient_id, l.unit);
      if (l.batch_id !== null) {
        if (!ing.tracked_by_batch) throw bad();
        await batchAt(c, l.batch_id, p.outlet_id, l.ingredient_id);
      }
      // Expected on-hand when counted: the batch's own stock for batch-tracked lines (null = the unbatched part),
      // else the ingredient's whole stock at the outlet. Never shown to the counter (blind count).
      const expected = ing.tracked_by_batch
        ? Number((await first<{ q: string }>(c,
            `SELECT coalesce(sum(qty_milli), 0)::text AS q FROM core.stock_movement WHERE outlet_id = $1 AND ingredient_id = $2 AND batch_id IS NOT DISTINCT FROM $3::uuid`,
            [p.outlet_id, l.ingredient_id, l.batch_id]))!.q)
        : (await onHand(c, p.outlet_id, [l.ingredient_id])).get(l.ingredient_id)!;
      lines.push({ ...l, expected, unit: ing.base_unit });
    }
    await c.query(`INSERT INTO core.stock_count (tenant_id, id, outlet_id, counted_by, status) VALUES (${T}, $1, $2, ${ME}, 'submitted')`, [p.count_id, p.outlet_id]);
    const moves: Move[] = [];
    for (const l of lines) {
      await c.query(
        `INSERT INTO core.stock_count_line (tenant_id, id, stock_count_id, ingredient_id, batch_id, expected_qty_milli, counted_qty_milli, unit)
         VALUES (${T}, $1, $2, $3, $4, $5, $6, $7)`, [l.line_id, p.count_id, l.ingredient_id, l.batch_id, l.expected, l.counted_qty_milli, l.unit]);
      const variance = l.counted_qty_milli - l.expected;
      if (variance === 0) continue;
      const id = await insertMovement(c, { outlet_id: p.outlet_id, ingredient_id: l.ingredient_id, batch_id: l.batch_id, qty_milli: variance, unit: l.unit,
        kind: "count_adjust", ref_type: "core.stock_count", ref_id: p.count_id });
      moves.push({ id, outlet_id: p.outlet_id, ingredient_id: l.ingredient_id, kind: "count_adjust" });
    }
    return {
      entityId: p.count_id,
      audit: [{ entity: "core.stock_count", entityId: p.count_id, after: { status: "submitted", lines: lines.length, adjustments: moves.length } }],
      events: movementEvents({ type: "core.stock_count", id: p.count_id }, moves),
    };
  },
};

// ---- reorder levels (draftable) ----
export const reorderLevelSet: CommandHandler = {
  type: "inventory.reorder_level.set.v1",
  async run(c, command) {
    const p = InventoryReorderLevelSetV1.parse(command.payload);
    if (p.par_qty_milli < p.min_qty_milli) throw bad();
    await ingredient(c, p.ingredient_id);
    const before = await first<{ min_qty_milli: string; par_qty_milli: string }>(c,
      `SELECT min_qty_milli::text, par_qty_milli::text FROM core.reorder_level WHERE outlet_id = $1 AND ingredient_id = $2`, [p.outlet_id, p.ingredient_id]);
    const r = await first<{ id: string }>(c,
      `INSERT INTO core.reorder_level (tenant_id, id, outlet_id, ingredient_id, min_qty_milli, par_qty_milli) VALUES (${T}, $5, $1, $2, $3, $4)
       ON CONFLICT (tenant_id, outlet_id, ingredient_id) DO UPDATE SET min_qty_milli = EXCLUDED.min_qty_milli, par_qty_milli = EXCLUDED.par_qty_milli
       RETURNING id`, [p.outlet_id, p.ingredient_id, p.min_qty_milli, p.par_qty_milli, uuidv7()]);
    return { entityId: r!.id, audit: [{ entity: "core.reorder_level", entityId: r!.id, before: before ?? null, after: { min_qty_milli: p.min_qty_milli, par_qty_milli: p.par_qty_milli } }] };
  },
};

// ---- batches ----
export const batchUpdate: CommandHandler = {
  type: "inventory.batch.update.v1",
  async run(c, command) {
    const p = InventoryBatchUpdateV1.parse(command.payload);
    const b = await first<{ expires_on: string | null; mrp_minor: string | null }>(c, `SELECT expires_on::text, mrp_minor::text FROM core.batch WHERE id = $1`, [p.batch_id]);
    if (!b) throw new ApiError("not_found");
    await c.query(
      `UPDATE core.batch SET expires_on = $2, mrp_minor = $3,
              currency = CASE WHEN $3::bigint IS NULL THEN NULL ELSE (SELECT base_currency FROM core.tenant WHERE tenant_id = ${T}) END
        WHERE id = $1`, [p.batch_id, p.expires_on, p.mrp_minor]);
    return { entityId: p.batch_id, audit: [{ entity: "core.batch", entityId: p.batch_id, before: b, after: { expires_on: p.expires_on, mrp_minor: p.mrp_minor } }] };
  },
};

// ---- transfers (create is draftable) ----
export const transferCreate: CommandHandler = {
  type: "inventory.transfer.create.v1",
  async run(c, command) {
    const p = InventoryTransferCreateV1.parse(command.payload);
    if (p.from_outlet_id === p.to_outlet_id) throw bad();
    for (const l of p.lines) {
      await baseUnit(c, l.ingredient_id, l.unit);
      if (l.batch_id !== null) await batchAt(c, l.batch_id, p.from_outlet_id, l.ingredient_id);
    }
    await c.query(`INSERT INTO core.transfer (tenant_id, id, from_outlet_id, to_outlet_id, sent_by) VALUES (${T}, $1, $2, $3, ${ME})`, [p.transfer_id, p.from_outlet_id, p.to_outlet_id]);
    for (const l of p.lines) {
      await c.query(`INSERT INTO core.transfer_line (tenant_id, id, transfer_id, ingredient_id, batch_id, qty_milli, unit) VALUES (${T}, $6, $1, $2, $3, $4, $5)`,
        [p.transfer_id, l.ingredient_id, l.batch_id, l.qty_milli, l.unit, uuidv7()]);
    }
    const moves: Move[] = [];
    await underRule(c, "inventory.transfer_out", `core.transfer:${p.transfer_id}`, async () => {
      for (const l of p.lines) {
        const id = await insertMovement(c, { outlet_id: p.from_outlet_id, ingredient_id: l.ingredient_id, batch_id: l.batch_id, qty_milli: -l.qty_milli,
          unit: l.unit, kind: "transfer_out", ref_type: "core.transfer", ref_id: p.transfer_id });
        moves.push({ id, outlet_id: p.from_outlet_id, ingredient_id: l.ingredient_id, kind: "transfer_out" });
      }
    });
    await negativeAfter(c, moves);
    return {
      entityId: p.transfer_id,
      audit: [{ entity: "core.transfer", entityId: p.transfer_id, after: { status: "sent", lines: p.lines.length } }],
      events: movementEvents({ type: "core.transfer", id: p.transfer_id }, moves),
    };
  },
};

export const transferReceive: CommandHandler = {
  type: "inventory.transfer.receive.v1",
  async run(c, command) {
    const p = InventoryTransferReceiveV1.parse(command.payload);
    const t = await first<{ status: string; from_outlet_id: string; to_outlet_id: string }>(c,
      `SELECT status, from_outlet_id, to_outlet_id FROM core.transfer WHERE id = $1`, [p.transfer_id]);
    if (!t) throw new ApiError("not_found");
    if (t.status !== "sent") throw new ApiError("illegal_transition");
    await c.query(`UPDATE core.transfer SET status = 'received', received_by = ${ME}, received_at = now() WHERE id = $1`, [p.transfer_id]);
    const lines = (await c.query<{ ingredient_id: string; qty_milli: string; unit: string; batch_id: string | null }>(
      `SELECT l.ingredient_id, l.qty_milli::text, l.unit, l.batch_id FROM core.transfer_line l WHERE l.transfer_id = $1 ORDER BY l.id`, [p.transfer_id])).rows;
    const moves: Move[] = [];
    const audit: AuditEntry[] = [{ entity: "core.transfer", entityId: p.transfer_id, before: { status: "sent" }, after: { status: "received" } }];
    await underRule(c, "inventory.transfer_in", `core.transfer:${p.transfer_id}`, async () => {
      for (const l of lines) {
        const batch = l.batch_id ? await destinationBatch(c, l.batch_id, t.from_outlet_id, t.to_outlet_id, audit) : null;
        const id = await insertMovement(c, { outlet_id: t.to_outlet_id, ingredient_id: l.ingredient_id, batch_id: batch, qty_milli: Number(l.qty_milli),
          unit: l.unit, kind: "transfer_in", ref_type: "core.transfer", ref_id: p.transfer_id });
        moves.push({ id, outlet_id: t.to_outlet_id, ingredient_id: l.ingredient_id, kind: "transfer_in" });
      }
    });
    return { entityId: p.transfer_id, audit, events: movementEvents({ type: "core.transfer", id: p.transfer_id }, moves) };
  },
};

/** R2-S1-7: a batch belongs to one outlet (FK), so transferred batch stock lands in the receiving outlet's batch of the
 *  same code — created here (inventory.transfer_in, 0015 A6) with the source batch's expiry, MRP and supplier when the
 *  destination has none, so FEFO and the expired-sale refusal see it at the destination too. The source batch sits at
 *  the sending outlet, outside a destination manager's scope: core reads it with the scope narrowed to that outlet,
 *  then restores the caller's scope before writing. */
async function destinationBatch(c: Queryable, srcId: string, fromOutlet: string, toOutlet: string, audit: AuditEntry[]): Promise<string> {
  const prev = (await c.query<{ o: string | null }>(`SELECT current_setting('app.outlet_ids', true) AS o`)).rows[0]!.o ?? "";
  await c.query(`SELECT set_config('app.outlet_ids', $1, true)`, [`{${fromOutlet}}`]);
  const src = await first<{ ingredient_id: string; batch_code: string; expires_on: string | null; mrp_minor: string | null; currency: string | null; supplier_id: string | null }>(c,
    `SELECT ingredient_id, batch_code, expires_on::text, mrp_minor::text, currency, supplier_id FROM core.batch WHERE id = $1 AND outlet_id = $2`, [srcId, fromOutlet]);
  await c.query(`SELECT set_config('app.outlet_ids', $1, true)`, [prev]);
  if (!src) throw bad();
  const have = await first<{ id: string }>(c, `SELECT id FROM core.batch WHERE outlet_id = $1 AND ingredient_id = $2 AND batch_code = $3`,
    [toOutlet, src.ingredient_id, src.batch_code]);
  if (have) return have.id;
  const id = uuidv7();
  await c.query(
    `INSERT INTO core.batch (tenant_id, id, outlet_id, ingredient_id, batch_code, expires_on, supplier_id, mrp_minor, currency, created_by)
     VALUES (${T}, $1, $2, $3, $4, $5, $6, $7, $8, ${ME})`,
    [id, toOutlet, src.ingredient_id, src.batch_code, src.expires_on, src.supplier_id, src.mrp_minor, src.currency]);
  audit.push({ entity: "core.batch", entityId: id, after: { outlet_id: toOutlet, batch_code: src.batch_code, expires_on: src.expires_on, mrp_minor: src.mrp_minor === null ? null : Number(src.mrp_minor), from_batch_id: srcId } });
  return id;
}

// ---- expired-sale override (R40 C7) ----
export const expiredSaleOverride: CommandHandler = {
  type: "inventory.expired_sale.override.v1",
  async run(c, command) {
    const p = InventoryExpiredSaleOverrideV1.parse(command.payload);
    // Whether the override exists at all is the country pack's call (default false: food safety).
    if (!(await tenantPack(c)).expired_sale_override) throw new ApiError("out_of_pack_scope");
    const b = await first<{ expires_on: string | null; ingredient_id: string; remaining: string }>(c,
      `SELECT b.expires_on::text, b.ingredient_id,
              (SELECT coalesce(sum(m.qty_milli), 0) FROM core.stock_movement m WHERE m.outlet_id = b.outlet_id AND m.batch_id = b.id)::text AS remaining
         FROM core.batch b WHERE b.id = $1 AND b.outlet_id = $2`, [p.batch_id, p.outlet_id]);
    if (!b) throw new ApiError("not_found");
    // Only an expired batch needs one (INFERENCE), and never for more than the batch still holds.
    if (!isExpired(b, await outletBusinessDate(c, p.outlet_id)) || p.qty_milli > Number(b.remaining)) throw bad();
    // decided_by is the signed-in member: the database refuses anyone else (MB005).
    await c.query(
      `INSERT INTO core.expired_sale_override (tenant_id, id, outlet_id, cart_line_id, batch_id, qty_milli, reason_code, note, decided_by)
       VALUES (${T}, $1, $2, $3, $4, $5, $6, $7, ${ME})`, [p.override_id, p.outlet_id, p.cart_line_id, p.batch_id, p.qty_milli, p.reason_code, p.note]);
    return { entityId: p.override_id, audit: [{ entity: "core.expired_sale_override", entityId: p.override_id, after: { batch_id: p.batch_id, cart_line_id: p.cart_line_id, reason_code: p.reason_code } }] };
  },
};
