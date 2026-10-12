// Munim Cares derivations (ADR-015 §1.4) and the B2B claim total. Pure: core-api reads the rows, calls these, and writes
// each result under its seeded rule (db/migrations/0028: inventory.cares_handover, inventory.cares_handover_void,
// inventory.cares_claim_receive). These rows have 5-value seeds, so rules-parity.test.ts does not see them (db/README).
//
// A hand-over leaves stock in each ingredient's base unit (the binding pins n.unit = base_unit):
//   raw / packaged line: its handed qty × the exact factor from the line's unit (kg → g, l → ml, ×1000); a line naming a
//                        batch draws that batch, any other draws any batch (FEFO, core-api);
//   cooked line:         handed portions × the dish's recipe in force on the hand-over's business date (variant-less
//                        version, base-unit recipe lines only — as inventory.consume_order), summed per ingredient as
//                        an exact rational and rounded half-up once. The binding bounds it by the ceiling, so it holds.
import { roundDiv } from "../money/index.ts";

export const CARES_RULES = {
  handover: "inventory.cares_handover",
  void: "inventory.cares_handover_void",
  receive: "inventory.cares_claim_receive",
} as const;

/** Exact conversions into a base unit (0028's binding table, upward only: a g line against a kg base would leave
 *  fractional milli-units, so it is refused). Returns the factor, or null. */
const FACTORS: Record<string, Record<string, number>> = { kg: { g: 1000 }, l: { ml: 1000 } };
export function caresBaseFactor(unit: string, base: string): number | null {
  return unit === base ? 1 : FACTORS[unit]?.[base] ?? null;
}

type RecipeLine = { ingredient_id: string; qty_milli: number; unit: string; waste_pct_bp: number };
export type HandoverInput = {
  /** The hand-over's business date at its outlet (core stamps handed_at; never client-sent). */
  business_date: string;
  /** One per hand-over line, with its listing line's subject; qty_milli in the listing line's unit. */
  lines: ReadonlyArray<{ food_kind: "cooked" | "raw" | "packaged"; item_id: string | null; ingredient_id: string | null; batch_id: string | null; unit: string; qty_milli: number }>;
  ingredients: ReadonlyArray<{ ingredient_id: string; base_unit: string }>;
  recipe_versions: ReadonlyArray<{
    recipe_version_id: string;
    item_id: string;
    variant_id: string | null;
    valid_from: string;
    /** Exclusive end; null = open. */
    valid_to: string | null;
    yield_qty_milli: number;
    lines: readonly RecipeLine[];
  }>;
};

/** Stock leaving, positive, in the ingredient's base unit. `batch_id` set: that batch; null: any batch (core picks FEFO). */
export type HandoverOut = { ingredient_id: string; unit: string; batch_id: string | null; qty_milli: number };
export type HandoverIssue =
  | { kind: "unit_mismatch"; ingredient_id: string }
  | { kind: "recipe_missing"; item_id: string };

const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? (a < 0n ? -a : a) : gcd(b, a % b));

export function handoverOuts(input: HandoverInput): { outs: HandoverOut[]; issues: HandoverIssue[] } {
  const base = new Map(input.ingredients.map((i) => [i.ingredient_id, i.base_unit]));
  const issues: HandoverIssue[] = [];
  const fixed = new Map<string, HandoverOut>();
  const pooled = new Map<string, number>();
  const cooked = new Map<string, { num: bigint; den: bigint }>();

  for (const l of input.lines) {
    if (l.food_kind !== "cooked") {
      const unit = base.get(l.ingredient_id!);
      const f = unit === undefined ? null : caresBaseFactor(l.unit, unit);
      if (f === null) {
        issues.push({ kind: "unit_mismatch", ingredient_id: l.ingredient_id! });
        continue;
      }
      if (l.batch_id === null) {
        pooled.set(l.ingredient_id!, (pooled.get(l.ingredient_id!) ?? 0) + l.qty_milli * f);
      } else {
        const k = `${l.ingredient_id}|${l.batch_id}`;
        const prev = fixed.get(k);
        fixed.set(k, { ingredient_id: l.ingredient_id!, unit: unit!, batch_id: l.batch_id, qty_milli: (prev?.qty_milli ?? 0) + l.qty_milli * f });
      }
      continue;
    }
    const d = input.business_date;
    const recipe = input.recipe_versions.find((v) => v.item_id === l.item_id && v.variant_id === null && v.valid_from <= d && (v.valid_to === null || d < v.valid_to));
    if (!recipe) {
      issues.push({ kind: "recipe_missing", item_id: l.item_id! });
      continue;
    }
    for (const rl of recipe.lines) {
      if (base.get(rl.ingredient_id) !== rl.unit) {
        issues.push({ kind: "unit_mismatch", ingredient_id: rl.ingredient_id });
        continue;
      }
      const n = BigInt(l.qty_milli) * BigInt(rl.qty_milli) * BigInt(10000 + rl.waste_pct_bp);
      const dd = BigInt(recipe.yield_qty_milli) * 10000n;
      const cur = cooked.get(rl.ingredient_id) ?? { num: 0n, den: 1n };
      let num = cur.num * dd + n * cur.den;
      let den = cur.den * dd;
      const g = gcd(num, den) || 1n;
      num /= g;
      den /= g;
      cooked.set(rl.ingredient_id, { num, den });
    }
  }
  for (const [id, { num, den }] of cooked) pooled.set(id, (pooled.get(id) ?? 0) + Number(roundDiv(num, den)));

  const byKey = (a: HandoverOut, b: HandoverOut) =>
    a.ingredient_id !== b.ingredient_id ? (a.ingredient_id < b.ingredient_id ? -1 : 1) : (a.batch_id ?? "") < (b.batch_id ?? "") ? -1 : 1;
  const outs = [
    ...fixed.values(),
    ...[...pooled].map(([ingredient_id, qty_milli]) => ({ ingredient_id, unit: base.get(ingredient_id)!, batch_id: null, qty_milli })),
  ].filter((o) => o.qty_milli > 0).sort(byKey);
  return { outs, issues };
}

/** A B2B claim's recorded total (rule 9: re-derived by core, never client-sent): Σ qty × unit price, where the price is
 *  per one unit and qty is in thousandths of it — exact, rounded half-up once. The buyer's claim and the offerer's
 *  allocation both use this, so the two sides cannot differ. Recorded, never processed. */
export function claimTotal(lines: ReadonlyArray<{ qty_milli: number; unit_price_minor: number }>): number {
  const n = lines.reduce((acc, l) => acc + BigInt(l.qty_milli) * BigInt(l.unit_price_minor), 0n);
  return Number(roundDiv(n, 1000n));
}
