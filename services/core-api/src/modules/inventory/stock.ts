// Shared inventory plumbing: derivation-rule context, movement inserts, on-hand, batch stock, the outlet's
// business date and the tenant's country pack. Every function runs inside the caller's transaction.
import { CountryPack } from "@munim/contracts/packs";
import { businessDate } from "@munim/core-domain/tz";
import type { EventDraft } from "../../commit/index.ts";
import { uuidv7 } from "../../commit/index.ts";
import { ApiError } from "../../lib/errors.ts";
import type { Queryable } from "../../runtoken/index.ts";
import type { BatchStock } from "./fefo.ts";

export const T = "current_setting('app.tenant_id')::uuid";
export const ME = "nullif(current_setting('app.member_id', true), '')::uuid";

type Row = Record<string, unknown>;
export const first = async <R extends Row>(c: Queryable, sql: string, params: unknown[] = []): Promise<R | undefined> =>
  (await c.query<R>(sql, params)).rows[0];

/** Runs `fn` under a seeded derivation rule and its source row (03-arch §1.3 branch 3), then restores what was
 *  set before — a seam may run inside a caller that is itself under a rule. */
export async function underRule<R>(c: Queryable, rule: string, sourceRef: string, fn: () => Promise<R>): Promise<R> {
  const prev = (await c.query<{ r: string; s: string }>(
    `SELECT coalesce(current_setting('app.posting_rule', true), '') AS r, coalesce(current_setting('app.source_ref', true), '') AS s`)).rows[0]!;
  await c.query(`SELECT set_config('app.posting_rule', $1, true), set_config('app.source_ref', $2, true)`, [rule, sourceRef]);
  const out = await fn();
  await c.query(`SELECT set_config('app.posting_rule', $1, true), set_config('app.source_ref', $2, true)`, [prev.r, prev.s]);
  return out;
}

/** True when the source row satisfies the rule's seeded `source_state` (the predicate the guard applies). The
 *  predicate text comes only from core.derivation_rule, which migrations alone write. */
export async function inSourceState(c: Queryable, rule: string, table: string, id: string): Promise<boolean> {
  const r = await first<{ source_state: string }>(c,
    `SELECT source_state FROM core.derivation_rule WHERE rule_id = $1 AND source_table = $2 AND target_table = 'core.stock_movement'`, [rule, table]);
  if (!r) return false;
  const [schema, name] = table.split(".");
  const hit = await first<{ ok: boolean }>(c,
    `SELECT EXISTS (SELECT 1 FROM ${quoteIdent(schema!)}.${quoteIdent(name!)} s WHERE s.id = $1 AND (${r.source_state})) AS ok`, [id]);
  return hit!.ok;
}
const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;

export type Kind = "receipt" | "sale_consumption" | "waste" | "transfer_out" | "transfer_in" | "count_adjust" | "supplier_return" | "sale_return" | "donation" | "surplus_out" | "surplus_in" | "cares_reversal";
export type MovementInsert = {
  outlet_id: string;
  ingredient_id: string;
  batch_id: string | null;
  qty_milli: number;
  unit: string;
  kind: Kind;
  ref_type: string | null;
  ref_id: string | null;
  /** R2-S2-8 (0016): the cost of 1000 base units in minor units — exact for a price per kg / l / 1000 units, where a
   *  per-base-unit cost (paise per g) is not. The database fills unit_cost_minor from it (rounded). */
  unit_cost_per_1000_minor?: number | null;
  currency?: string | null;
  expired_sale_override_id?: string | null;
  at?: string | Date | null;
  id?: string;
};

export async function insertMovement(c: Queryable, m: MovementInsert): Promise<string> {
  const id = m.id ?? uuidv7();
  await c.query(
    `INSERT INTO core.stock_movement (tenant_id, id, outlet_id, ingredient_id, batch_id, qty_milli, unit, kind, ref_type, ref_id,
                                      unit_cost_per_1000_minor, currency, expired_sale_override_id, at, created_by)
     VALUES (${T}, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, coalesce($13::timestamptz, now()), ${ME})`,
    [id, m.outlet_id, m.ingredient_id, m.batch_id, m.qty_milli, m.unit, m.kind, m.ref_type, m.ref_id,
     m.unit_cost_per_1000_minor ?? null, m.unit_cost_per_1000_minor == null ? null : m.currency, m.expired_sale_override_id ?? null, m.at ?? null]);
  return id;
}

/** One `munim.inventory.movement.recorded.v1` per (outlet, kind) of the movements written — ids only. */
export function movementEvents(ref: { type: string; id: string }, moves: ReadonlyArray<{ id: string; outlet_id: string; ingredient_id: string; kind: Kind }>): EventDraft[] {
  const groups = new Map<string, typeof moves[number][]>();
  for (const m of moves) groups.set(`${m.outlet_id}|${m.kind}`, [...(groups.get(`${m.outlet_id}|${m.kind}`) ?? []), m]);
  return [...groups.values()].map((g) => ({
    type: "munim.inventory.movement.recorded.v1",
    subject: ref.id,
    aggregateType: "stock_movement",
    data: { outlet_id: g[0]!.outlet_id, movement_ids: g.map((m) => m.id), ingredient_ids: [...new Set(g.map((m) => m.ingredient_id))],
      kind: g[0]!.kind, ref_type: ref.type, ref_id: ref.id },
  }));
}

/** On-hand per ingredient at one outlet = Σ qty_milli (base unit). Internal: screens get it from a snapshot. */
export async function onHand(c: Queryable, outletId: string, ingredientIds: readonly string[]): Promise<Map<string, number>> {
  const r = await c.query<{ ingredient_id: string; q: string }>(
    `SELECT ingredient_id, sum(qty_milli)::text AS q FROM core.stock_movement
      WHERE outlet_id = $1 AND ingredient_id = ANY ($2::uuid[]) GROUP BY ingredient_id`, [outletId, ingredientIds]);
  return new Map(ingredientIds.map((i) => [i, Number(r.rows.find((x) => x.ingredient_id === i)?.q ?? 0)]));
}

/** Negative on-hand is allowed (02-schema §2.5) and raises an alert: in-process listeners get ids only. */
export type NegativeOnHand = { outlet_id: string; ingredient_id: string };
const LISTENERS_KEY = Symbol.for("munim.inventory.negativeOnHand");
const g = globalThis as unknown as Record<symbol, Set<(alerts: NegativeOnHand[]) => void> | undefined>;
const LISTENERS = (g[LISTENERS_KEY] ??= new Set());

/** Subscribe to negative on-hand alerts (called inside the writing transaction, ids only). Returns unsubscribe. */
export function onNegativeOnHand(fn: (alerts: NegativeOnHand[]) => void): () => void {
  LISTENERS.add(fn);
  return () => void LISTENERS.delete(fn);
}

/** The (outlet, ingredient) pairs among `touched` whose on-hand is now below zero; listeners are told. */
export async function negativeAfter(c: Queryable, touched: ReadonlyArray<{ outlet_id: string; ingredient_id: string }>): Promise<NegativeOnHand[]> {
  const out: NegativeOnHand[] = [];
  for (const outlet of new Set(touched.map((t) => t.outlet_id))) {
    const ids = [...new Set(touched.filter((t) => t.outlet_id === outlet).map((t) => t.ingredient_id))];
    for (const [ingredient_id, q] of await onHand(c, outlet, ids)) if (q < 0) out.push({ outlet_id: outlet, ingredient_id });
  }
  if (out.length > 0) for (const fn of LISTENERS) fn(out);
  return out;
}

/** Batches of the ingredients at the outlet with their remaining stock (> 0 only), batch MRP included. */
export async function batchStock(c: Queryable, outletId: string, ingredientIds: readonly string[]): Promise<Array<BatchStock & { mrp_minor: number | null }>> {
  const r = await c.query<{ batch_id: string; ingredient_id: string; expires_on: string | null; received_at: Date; remaining: string; mrp_minor: string | null }>(
    `SELECT b.id AS batch_id, b.ingredient_id, b.expires_on::text AS expires_on, b.received_at, b.mrp_minor::text AS mrp_minor,
            sum(m.qty_milli)::text AS remaining
       FROM core.batch b JOIN core.stock_movement m ON m.tenant_id = b.tenant_id AND m.outlet_id = b.outlet_id AND m.batch_id = b.id
      WHERE b.outlet_id = $1 AND b.ingredient_id = ANY ($2::uuid[])
      GROUP BY b.tenant_id, b.id HAVING sum(m.qty_milli) > 0`, [outletId, ingredientIds]);
  return r.rows.map((b) => ({ batch_id: b.batch_id, ingredient_id: b.ingredient_id, expires_on: b.expires_on, received_at: b.received_at.toISOString(),
    remaining_milli: Number(b.remaining), mrp_minor: b.mrp_minor === null ? null : Number(b.mrp_minor) }));
}

/** The outlet's business date now, the way the order trigger computes it (0014: local date of now − cutoff, now()
 *  being the transaction's start), through the one tz module. */
export async function outletBusinessDate(c: Queryable, outletId: string): Promise<string> {
  const o = await first<{ tz: string; cutoff: string; now: Date }>(c,
    `SELECT tz, to_char(business_day_cutoff, 'HH24:MI') AS cutoff, now() AS now FROM core.outlet WHERE id = $1`, [outletId]);
  if (!o) throw new ApiError("not_found");
  return businessDate(o.now, o.tz, o.cutoff);
}

/** The tenant's country pack in force: its country's active version with the highest number already effective. */
export async function tenantPack(c: Queryable): Promise<CountryPack> {
  const r = await first<{ doc: unknown }>(c,
    `SELECT p.doc FROM platform.country_pack p JOIN core.tenant t ON t.country_code = p.code
      WHERE t.tenant_id = ${T} AND p.status = 'active' AND p.effective_from <= current_date
      ORDER BY p.version DESC LIMIT 1`);
  if (!r) throw new ApiError("unavailable");
  return CountryPack.parse(r.doc);
}

/** Exact conversions into an ingredient's base unit (INFERENCE: mass and volume only, ×1000). Anything else is
 *  refused — never guessed. Returns the factor (qty in `unit` × factor = qty in base unit). */
const FACTORS: Record<string, Record<string, number>> = { kg: { g: 1000 }, l: { ml: 1000 } };
export function toBaseFactor(unit: string, base: string): number | null {
  return unit === base ? 1 : FACTORS[unit]?.[base] ?? null;
}
