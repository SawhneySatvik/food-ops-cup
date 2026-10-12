// Munim Cares stock seams (ADR-015 §1.4; 0028 rules inventory.cares_handover, inventory.cares_handover_void and
// inventory.cares_claim_receive). The cares module calls each inside its command's transaction, once the source row is in
// the rule's source state; every row is written under its rule, so the guard holds it to the rule's binding (base unit,
// Σ within what the source's lines imply). No journal posting (as waste): Cares money is recorded, never processed.
import { CARES_RULES, handoverOuts } from "@munim/core-domain/cares";
import { businessDate } from "@munim/core-domain/tz";
import { uuidv7 } from "../../commit/index.ts";
import { ApiError } from "../../lib/errors.ts";
import type { Queryable } from "../../runtoken/index.ts";
import { fefoPick } from "./fefo.ts";
import type { DerivationResult } from "./seams.ts";
import { batchStock, first, inSourceState, insertMovement, type Kind, ME, movementEvents, negativeAfter, T, underRule } from "./stock.ts";

type Move = { id: string; outlet_id: string; ingredient_id: string; kind: Kind };
const refused = () => new ApiError("book_write_refused", "authority_denied");

/** A recorded hand-over leaves stock: `donation` for a donation listing, `surplus_out` for an offer, at its outlet, in each
 *  ingredient's base unit (core-domain handoverOuts: raw lines by their own qty, cooked portions × the recipe in force on
 *  the hand-over's business date). A line naming a batch draws it; any other batch-tracked use is split FEFO (unexpired
 *  first, then unbatched); untracked stock has no batch. Refused (writes nothing) for a dish with no recipe in force or a
 *  unit that does not convert exactly. */
export async function deriveCaresHandover(c: Queryable, handoverId: string): Promise<DerivationResult> {
  const h = await first<{ outlet_id: string; kind: "donation" | "offer"; handed_at: Date; tz: string; cutoff: string }>(c,
    `SELECT h.outlet_id, l.kind, h.handed_at, o.tz, to_char(o.business_day_cutoff, 'HH24:MI') AS cutoff
       FROM core.cares_handover h JOIN core.cares_listing l ON l.tenant_id = h.tenant_id AND l.id = h.listing_id
       JOIN core.outlet o ON o.tenant_id = h.tenant_id AND o.id = h.outlet_id WHERE h.id = $1`, [handoverId]);
  if (!h) throw new ApiError("not_found");
  if (!(await inSourceState(c, CARES_RULES.handover, "core.cares_handover", handoverId))) throw refused();
  const lines = (await c.query<{ food_kind: "cooked" | "raw" | "packaged"; item_id: string | null; ingredient_id: string | null; batch_id: string | null; unit: string; qty: string }>(
    `SELECT ll.food_kind, ll.item_id, ll.ingredient_id, ll.batch_id, ll.unit, hl.qty_milli::text AS qty
       FROM core.cares_handover_line hl JOIN core.cares_listing_line ll ON ll.tenant_id = hl.tenant_id AND ll.id = hl.listing_line_id
      WHERE hl.handover_id = $1 ORDER BY ll.line_no`, [handoverId])).rows;
  const items = [...new Set(lines.flatMap((l) => (l.item_id ? [l.item_id] : [])))];
  const versions = (await c.query<{ id: string; item_id: string; variant_id: string | null; valid_from: string; valid_to: string | null; yield: string }>(
    `SELECT id, item_id, variant_id, valid_from::text, valid_to::text, yield_qty_milli::text AS yield FROM core.recipe_version WHERE item_id = ANY ($1::uuid[])`, [items])).rows;
  const recipeLines = (await c.query<{ recipe_version_id: string; ingredient_id: string; qty: string; unit: string; waste_pct_bp: number }>(
    `SELECT recipe_version_id, ingredient_id, qty_milli::text AS qty, unit, waste_pct_bp FROM core.recipe_line WHERE recipe_version_id = ANY ($1::uuid[])`,
    [versions.map((v) => v.id)])).rows;
  const ingIds = [...new Set([...lines.flatMap((l) => (l.ingredient_id ? [l.ingredient_id] : [])), ...recipeLines.map((r) => r.ingredient_id)])];
  const ings = new Map((await c.query<{ id: string; base_unit: string; tracked_by_batch: boolean }>(
    `SELECT id, base_unit, tracked_by_batch FROM core.ingredient WHERE id = ANY ($1::uuid[])`, [ingIds])).rows.map((i) => [i.id, i]));

  const date = businessDate(h.handed_at, h.tz, h.cutoff);
  const { outs, issues } = handoverOuts({
    business_date: date,
    lines: lines.map((l) => ({ food_kind: l.food_kind, item_id: l.item_id, ingredient_id: l.ingredient_id, batch_id: l.batch_id, unit: l.unit, qty_milli: Number(l.qty) })),
    ingredients: [...ings.values()].map((i) => ({ ingredient_id: i.id, base_unit: i.base_unit })),
    recipe_versions: versions.map((v) => ({ recipe_version_id: v.id, item_id: v.item_id, variant_id: v.variant_id, valid_from: v.valid_from, valid_to: v.valid_to,
      yield_qty_milli: Number(v.yield),
      lines: recipeLines.filter((r) => r.recipe_version_id === v.id).map((r) => ({ ingredient_id: r.ingredient_id, qty_milli: Number(r.qty), unit: r.unit, waste_pct_bp: r.waste_pct_bp })) })),
  });
  if (issues.some((i) => i.kind === "recipe_missing")) throw new ApiError("conflict", "recipe_missing");
  if (issues.length > 0) throw new ApiError("bad_request", "unit_mismatch");

  // Named batches draw first; what they take is gone from the FEFO stock.
  const tracked = outs.filter((o) => ings.get(o.ingredient_id)!.tracked_by_batch);
  const stock = (await batchStock(c, h.outlet_id, [...new Set(tracked.map((o) => o.ingredient_id))])).map((b) => {
    const named = tracked.filter((o) => o.batch_id === b.batch_id).reduce((s, o) => s + o.qty_milli, 0);
    return { ...b, remaining_milli: b.remaining_milli - named };
  }).filter((b) => b.remaining_milli > 0);
  const pool = tracked.filter((o) => o.batch_id === null);
  const fefo = fefoPick(stock, pool.map((o) => ({ line_id: o.ingredient_id, ingredient_id: o.ingredient_id, qty_milli: o.qty_milli, expired_blocks: false })), date);
  const planned = [
    ...outs.filter((o) => o.batch_id !== null || !ings.get(o.ingredient_id)!.tracked_by_batch),
    ...fefo.picks.map((p) => ({ ingredient_id: p.ingredient_id, unit: ings.get(p.ingredient_id)!.base_unit, batch_id: p.batch_id, qty_milli: p.qty_milli })),
  ];

  const kind: Kind = h.kind === "donation" ? "donation" : "surplus_out";
  const moves: Move[] = [];
  await underRule(c, CARES_RULES.handover, `core.cares_handover:${handoverId}`, async () => {
    for (const p of planned) {
      const id = await insertMovement(c, { outlet_id: h.outlet_id, ingredient_id: p.ingredient_id, batch_id: p.batch_id, qty_milli: -p.qty_milli, unit: p.unit,
        kind, ref_type: "core.cares_handover", ref_id: handoverId, at: h.handed_at });
      moves.push({ id, outlet_id: h.outlet_id, ingredient_id: p.ingredient_id, kind });
    }
  });
  return { derived: moves.length > 0, movement_ids: moves.map((m) => m.id), events: movementEvents({ type: "core.cares_handover", id: handoverId }, moves),
    negative_on_hand: await negativeAfter(c, moves) };
}

/** A voided hand-over's stock comes back: one `cares_reversal` per (ingredient, batch, unit) of its out movements, once. */
export async function reverseCaresHandover(c: Queryable, handoverId: string): Promise<DerivationResult> {
  const h = await first<{ outlet_id: string }>(c, `SELECT outlet_id FROM core.cares_handover WHERE id = $1`, [handoverId]);
  if (!h) throw new ApiError("not_found");
  if (!(await inSourceState(c, CARES_RULES.void, "core.cares_handover", handoverId))) throw refused();
  const back = (await c.query<{ ingredient_id: string; batch_id: string | null; unit: string; qty: string }>(
    `SELECT ingredient_id, batch_id, unit, (-sum(qty_milli))::text AS qty FROM core.stock_movement
      WHERE ref_type = 'core.cares_handover' AND ref_id = $1 AND kind IN ('donation', 'surplus_out')
        AND NOT EXISTS (SELECT 1 FROM core.stock_movement r WHERE r.ref_type = 'core.cares_handover' AND r.ref_id = $1 AND r.kind = 'cares_reversal')
      GROUP BY ingredient_id, batch_id, unit HAVING sum(qty_milli) < 0 ORDER BY ingredient_id, batch_id`, [handoverId])).rows;
  const moves: Move[] = [];
  await underRule(c, CARES_RULES.void, `core.cares_handover:${handoverId}`, async () => {
    for (const m of back) {
      const id = await insertMovement(c, { outlet_id: h.outlet_id, ingredient_id: m.ingredient_id, batch_id: m.batch_id, qty_milli: Number(m.qty), unit: m.unit,
        kind: "cares_reversal", ref_type: "core.cares_handover", ref_id: handoverId });
      moves.push({ id, outlet_id: h.outlet_id, ingredient_id: m.ingredient_id, kind: "cares_reversal" });
    }
  });
  return { derived: moves.length > 0, movement_ids: moves.map((m) => m.id), events: movementEvents({ type: "core.cares_handover", id: handoverId }, moves), negative_on_hand: [] };
}

/** A received claim comes into the buyer's stock: per line with a received qty, `surplus_in` of the buyer's own
 *  ingredient in its base unit (the claim's unit, checked equal at claim time). A batch-tracked ingredient gets a new
 *  batch carrying the offer line's expiry (no MRP, supplier or GRN line: the rule admits only that); untracked stock has
 *  none. No cost on the movement: a surplus buy never becomes a receipt cost (ADR-015 §1.4). */
export async function deriveCaresReceive(c: Queryable, claimId: string): Promise<DerivationResult> {
  const cl = await first<{ outlet_id: string }>(c, `SELECT outlet_id FROM core.cares_claim WHERE id = $1`, [claimId]);
  if (!cl) throw new ApiError("not_found");
  if (!(await inSourceState(c, CARES_RULES.receive, "core.cares_claim", claimId))) throw refused();
  const lines = (await c.query<{ id: string; ingredient_id: string; unit: string; received: string; expires_on: string | null; tracked: boolean }>(
    `SELECT l.id, l.ingredient_id, l.unit, l.received_qty_milli::text AS received, l.expires_on::text, i.tracked_by_batch AS tracked
       FROM core.cares_claim_line l JOIN core.ingredient i ON i.tenant_id = l.tenant_id AND i.id = l.ingredient_id
      WHERE l.claim_id = $1 AND l.received_qty_milli > 0 ORDER BY l.id`, [claimId])).rows;
  const moves: Move[] = [];
  await underRule(c, CARES_RULES.receive, `core.cares_claim:${claimId}`, async () => {
    for (const l of lines) {
      let batch: string | null = null;
      if (l.tracked) {
        batch = uuidv7();
        await c.query(`INSERT INTO core.batch (tenant_id, id, outlet_id, ingredient_id, batch_code, expires_on, created_by) VALUES (${T}, $1, $2, $3, $4, $5, ${ME})`,
          [batch, cl.outlet_id, l.ingredient_id, `cares-${l.id}`, l.expires_on]);
      }
      const id = await insertMovement(c, { outlet_id: cl.outlet_id, ingredient_id: l.ingredient_id, batch_id: batch, qty_milli: Number(l.received), unit: l.unit,
        kind: "surplus_in", ref_type: "core.cares_claim", ref_id: claimId });
      moves.push({ id, outlet_id: cl.outlet_id, ingredient_id: l.ingredient_id, kind: "surplus_in" });
    }
  });
  return { derived: moves.length > 0, movement_ids: moves.map((m) => m.id), events: movementEvents({ type: "core.cares_claim", id: claimId }, moves), negative_on_hand: [] };
}
