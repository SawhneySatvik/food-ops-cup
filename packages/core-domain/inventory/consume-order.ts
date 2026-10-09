// Derivation rules `inventory.consume_order` and `inventory.consume_sku` (02-schema §2.5). Pure: core-api
// posts each result under its own `app.posting_rule` with the order as `app.source_ref`.
//   consume_order — dish/combo lines exploded through the recipe version in force on the order row's
//                   business_date, plus the selected options' ingredient deltas;
//   consume_sku   — `sku` lines consume the item's stock_ingredient_id 1:1 by quantity.
//
// Recipe arithmetic (exact rationals, summed per ingredient, rounded half-up once at the end):
//   recipe line:  line_qty_milli × qty_milli × (10000 + waste_pct_bp) / (yield_qty_milli × 10000)
//   option delta: line_qty_milli × qty_milli × (10000 + waste_pct_bp) / (1000 × 10000)   (per portion)
// Waste is a gross-up on the recipe quantity (INFERENCE: the schema names `waste_pct_bp` without a formula).
// Neither rule throws at sale time: a bad unit or an over-removing option is skipped and reported in
// `issues` (core raises an alert); `validateRecipe` refuses the unit mismatch when the recipe is saved.
import type { ReasonCode } from "@munim/contracts";
import { roundDiv } from "../money/index.ts";
import { RULES } from "./rules.ts";

type QtyLine = { ingredient_id: string; qty_milli: number; unit: string; waste_pct_bp: number };
type Ingredients = ReadonlyArray<{ ingredient_id: string; base_unit: string }>;

export type ConsumeInput = {
  order: {
    order_id: string;
    outlet_id: string;
    placed_at: string;
    /** The order row's business_date (outlet tz + cutoff, set by the database at placement). */
    business_date: string;
    lines: ReadonlyArray<{ line_no: number; item_id: string; variant_id: string | null; option_ids: readonly string[]; qty_milli: number }>;
  };
  items: ReadonlyArray<{ item_id: string; kind: string; stock_ingredient_id: string | null }>;
  ingredients: Ingredients;
  recipe_versions: ReadonlyArray<{
    recipe_version_id: string;
    item_id: string;
    variant_id: string | null;
    version: number;
    valid_from: string;
    /** Exclusive end; null = open. */
    valid_to: string | null;
    yield_qty_milli: number;
    lines: readonly QtyLine[];
  }>;
  /** core.option_ingredient_delta rows: per one portion; negative removes. */
  option_deltas: ReadonlyArray<QtyLine & { option_id: string }>;
};

export type MovementIntent = {
  outlet_id: string;
  ingredient_id: string;
  /** Signed; consumption is negative. */
  qty_milli: number;
  unit: string;
  kind: "sale_consumption";
  ref_type: "core.order";
  ref_id: string;
  at: string;
};

export type ConsumeIssue =
  | { kind: "unit_mismatch"; line_no: number; ingredient_id: string }
  | { kind: "negative_net"; ingredient_id: string }
  | { kind: "sku_without_stock_ingredient"; line_no: number; item_id: string };

export type ConsumeOrderResult = {
  rule_id: "inventory.consume_order";
  business_date: string;
  movements: MovementIntent[];
  /** The recipe version each exploded line used (core stamps it on order_line.recipe_version_id). */
  lines: Array<{ line_no: number; recipe_version_id: string }>;
  /** Non-SKU lines with no recipe in force: no movement; core raises `recipe_missing`. */
  recipe_missing: Array<{ line_no: number; item_id: string }>;
  issues: ConsumeIssue[];
};

export type ConsumeSkuResult = { rule_id: "inventory.consume_sku"; business_date: string; movements: MovementIntent[]; issues: ConsumeIssue[] };

export const RECIPE_REFUSAL_CODES = ["unit_mismatch"] as const satisfies readonly ReasonCode[];

/** Save-time check for a recipe version's lines or an option's deltas: every unit is the ingredient's base unit. */
export function validateRecipe(
  recipe: { lines: ReadonlyArray<{ ingredient_id: string; unit: string }> },
  ingredients: Ingredients,
): { ok: true } | { ok: false; reason_code: (typeof RECIPE_REFUSAL_CODES)[number]; line_no: number; ingredient_id: string } {
  for (const [i, l] of recipe.lines.entries()) {
    if (ingredients.find((x) => x.ingredient_id === l.ingredient_id)?.base_unit !== l.unit)
      return { ok: false, reason_code: "unit_mismatch", line_no: i + 1, ingredient_id: l.ingredient_id };
  }
  return { ok: true };
}

const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? (a < 0n ? -a : a) : gcd(b, a % b));
const byId = <T>([a]: [string, T], [b]: [string, T]) => (a < b ? -1 : a > b ? 1 : 0);
const SKU = "sku";

function movement(order: ConsumeInput["order"], ingredient_id: string, qty: number, unit: string): MovementIntent {
  return { outlet_id: order.outlet_id, ingredient_id, qty_milli: -qty, unit, kind: "sale_consumption", ref_type: "core.order", ref_id: order.order_id, at: order.placed_at };
}

export function consumeOrder(input: ConsumeInput): ConsumeOrderResult {
  const { order } = input;
  const date = order.business_date;
  const baseUnit = new Map(input.ingredients.map((i) => [i.ingredient_id, i.base_unit]));
  const kind = new Map(input.items.map((i) => [i.item_id, i.kind]));
  const acc = new Map<string, { num: bigint; den: bigint; unit: string }>();
  const issues: ConsumeIssue[] = [];

  const add = (l: QtyLine, line_no: number, lineQty: number, den: bigint) => {
    const unit = baseUnit.get(l.ingredient_id);
    if (unit === undefined || l.unit !== unit) {
      issues.push({ kind: "unit_mismatch", line_no, ingredient_id: l.ingredient_id });
      return;
    }
    const n = BigInt(lineQty) * BigInt(l.qty_milli) * BigInt(10000 + l.waste_pct_bp);
    const d = den * 10000n;
    const cur = acc.get(l.ingredient_id) ?? { num: 0n, den: 1n, unit };
    let num = cur.num * d + n * cur.den;
    let dd = cur.den * d;
    const g = gcd(num, dd) || 1n;
    num /= g;
    dd /= g;
    acc.set(l.ingredient_id, { num, den: dd, unit });
  };

  const inForce = (v: ConsumeInput["recipe_versions"][number]) => v.valid_from <= date && (v.valid_to === null || date < v.valid_to);
  const lines: ConsumeOrderResult["lines"] = [];
  const recipe_missing: ConsumeOrderResult["recipe_missing"] = [];

  for (const line of order.lines) {
    if (kind.get(line.item_id) === SKU) continue; // inventory.consume_sku
    const candidates = input.recipe_versions.filter((v) => v.item_id === line.item_id && inForce(v));
    const recipe =
      (line.variant_id !== null ? candidates.find((v) => v.variant_id === line.variant_id) : undefined) ?? candidates.find((v) => v.variant_id === null);
    if (!recipe) {
      recipe_missing.push({ line_no: line.line_no, item_id: line.item_id });
      continue;
    }
    lines.push({ line_no: line.line_no, recipe_version_id: recipe.recipe_version_id });
    for (const rl of recipe.lines) add(rl, line.line_no, line.qty_milli, BigInt(recipe.yield_qty_milli));
    for (const optionId of line.option_ids)
      for (const d of input.option_deltas.filter((x) => x.option_id === optionId)) add(d, line.line_no, line.qty_milli, 1000n);
  }

  const movements: MovementIntent[] = [];
  for (const [ingredient_id, { num, den, unit }] of [...acc].sort(byId)) {
    if (num < 0n) {
      issues.push({ kind: "negative_net", ingredient_id });
      continue;
    }
    const qty = Number(roundDiv(num, den));
    if (qty !== 0) movements.push(movement(order, ingredient_id, qty, unit));
  }
  return { rule_id: RULES[0].rule_id, business_date: date, movements, lines, recipe_missing, issues };
}

export function consumeSku(input: ConsumeInput): ConsumeSkuResult {
  const { order } = input;
  const baseUnit = new Map(input.ingredients.map((i) => [i.ingredient_id, i.base_unit]));
  const items = new Map(input.items.map((i) => [i.item_id, i]));
  const acc = new Map<string, number>();
  const issues: ConsumeIssue[] = [];
  for (const line of order.lines) {
    const item = items.get(line.item_id);
    if (item?.kind !== SKU) continue;
    if (item.stock_ingredient_id === null || !baseUnit.has(item.stock_ingredient_id)) {
      issues.push({ kind: "sku_without_stock_ingredient", line_no: line.line_no, item_id: line.item_id });
      continue;
    }
    acc.set(item.stock_ingredient_id, (acc.get(item.stock_ingredient_id) ?? 0) + line.qty_milli);
  }
  const movements = [...acc].sort(byId).map(([id, qty]) => movement(order, id, qty, baseUnit.get(id)!));
  return { rule_id: RULES[1].rule_id, business_date: order.business_date, movements, issues };
}
