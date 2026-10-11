// Inventory reads: rows only (a row's own fields trace as themselves). On-hand totals and count variance values
// are aggregates — screens get them from snapshot templates (requested from M-C: inventory.on_hand,
// inventory.count_variance), never from here.
import type { Queryable } from "../../runtoken/index.ts";

export async function listMovements(c: Queryable, q: { outlet: string; ingredient: string | undefined; limit: number; cursor: string | undefined; kind?: string | null; ref?: string | undefined }) {
  const r = await c.query<{
    id: string; outlet_id: string; ingredient_id: string; batch_id: string | null; qty_milli: string; unit: string; kind: string;
    ref_type: string | null; ref_id: string | null; unit_cost_minor: string | null; per1000: string | null; currency: string | null; expired_sale_override_id: string | null; at: Date;
  }>(
    `SELECT id, outlet_id, ingredient_id, batch_id, qty_milli::text, unit, kind, ref_type, ref_id, unit_cost_minor::text, unit_cost_per_1000_minor::text AS per1000, currency,
            expired_sale_override_id, at
       FROM core.stock_movement
      WHERE outlet_id = $1 AND ($2::uuid IS NULL OR ingredient_id = $2) AND ($3::uuid IS NULL OR id < $3)
        AND ($5::text IS NULL OR kind = $5) AND ($6::uuid IS NULL OR ref_id = $6)
      ORDER BY id DESC LIMIT $4`,
    [q.outlet, q.ingredient ?? null, q.cursor ?? null, q.limit + 1, q.kind ?? null, q.ref ?? null]);
  const page = r.rows.slice(0, q.limit);
  return {
    movements: page.map((m) => ({
      movement_id: m.id, outlet_id: m.outlet_id, ingredient_id: m.ingredient_id, batch_id: m.batch_id, qty_milli: Number(m.qty_milli), unit: m.unit,
      kind: m.kind, ref_type: m.ref_type, ref_id: m.ref_id,
      unit_cost: m.unit_cost_minor === null ? null : { amount_minor: Number(m.unit_cost_minor), currency: m.currency! },
      unit_cost_per_1000: m.per1000 === null ? null : { amount_minor: Number(m.per1000), currency: m.currency! },
      expired_sale_override_id: m.expired_sale_override_id, at: m.at.toISOString(),
    })),
    next_cursor: r.rows.length > q.limit ? page.at(-1)!.id : null,
  };
}

export async function listBatches(c: Queryable, q: { outlet: string; ingredient: string | undefined }) {
  const r = await c.query<{ id: string; outlet_id: string; ingredient_id: string; batch_code: string; expires_on: string | null; received_at: Date; mrp_minor: string | null; currency: string | null }>(
    `SELECT id, outlet_id, ingredient_id, batch_code, expires_on::text, received_at, mrp_minor::text, currency
       FROM core.batch WHERE outlet_id = $1 AND ($2::uuid IS NULL OR ingredient_id = $2)
      ORDER BY expires_on NULLS LAST, received_at, id`, [q.outlet, q.ingredient ?? null]);
  return {
    batches: r.rows.map((b) => ({
      batch_id: b.id, outlet_id: b.outlet_id, ingredient_id: b.ingredient_id, batch_code: b.batch_code, expires_on: b.expires_on, received_at: b.received_at.toISOString(),
      mrp: b.mrp_minor === null ? null : { amount_minor: Number(b.mrp_minor), currency: b.currency! },
    })),
  };
}

export async function listReorderLevels(c: Queryable, q: { outlet: string; ingredient: string | undefined }) {
  const r = await c.query<{ id: string; outlet_id: string; ingredient_id: string; min_qty_milli: string; par_qty_milli: string; updated_at: Date }>(
    `SELECT id, outlet_id, ingredient_id, min_qty_milli::text, par_qty_milli::text, updated_at
       FROM core.reorder_level WHERE outlet_id = $1 AND ($2::uuid IS NULL OR ingredient_id = $2) ORDER BY ingredient_id`, [q.outlet, q.ingredient ?? null]);
  return {
    reorder_levels: r.rows.map((x) => ({
      reorder_level_id: x.id, outlet_id: x.outlet_id, ingredient_id: x.ingredient_id, min_qty_milli: Number(x.min_qty_milli), par_qty_milli: Number(x.par_qty_milli),
      updated_at: x.updated_at.toISOString(),
    })),
  };
}
