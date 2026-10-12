// T-095a: Munim Cares hand-over derivation and the B2B claim total (core-domain cares). Expected values are typed by
// hand from the recipe arithmetic in the file header, never computed by the code under test. Synthetic data only.
import { describe, expect, it } from "vitest";
import { caresBaseFactor, claimTotal, handoverOuts, type HandoverInput } from "../cares/index.ts";

const ONION = "00000000-0000-7000-8000-000000000001";
const RICE = "00000000-0000-7000-8000-000000000002";
const TOMATO = "00000000-0000-7000-8000-000000000003";
const BATCH = "00000000-0000-7000-8000-0000000000b1";
const DISH = "00000000-0000-7000-8000-0000000000d1";

const base: Omit<HandoverInput, "lines"> = {
  business_date: "2026-10-13",
  ingredients: [{ ingredient_id: ONION, base_unit: "g" }, { ingredient_id: RICE, base_unit: "g" }, { ingredient_id: TOMATO, base_unit: "g" }],
  recipe_versions: [
    // An expired version (must not be used) and the one in force: 1 portion = 120 g onion + 200 g rice with 5% waste.
    { recipe_version_id: "v1", item_id: DISH, variant_id: null, valid_from: "2026-01-01", valid_to: "2026-10-01", yield_qty_milli: 1000,
      lines: [{ ingredient_id: ONION, qty_milli: 999000, unit: "g", waste_pct_bp: 0 }] },
    { recipe_version_id: "v2", item_id: DISH, variant_id: null, valid_from: "2026-10-01", valid_to: null, yield_qty_milli: 1000,
      lines: [{ ingredient_id: ONION, qty_milli: 120000, unit: "g", waste_pct_bp: 0 }, { ingredient_id: RICE, qty_milli: 200000, unit: "g", waste_pct_bp: 500 }] },
  ],
};
const cooked = (portions_milli: number) => ({ food_kind: "cooked" as const, item_id: DISH, ingredient_id: null, batch_id: null, unit: "portion", qty_milli: portions_milli });

describe("handoverOuts", () => {
  it("6 cooked portions = the recipe in force × 6: onion 720 g, rice 1260 g (5% waste), one row per recipe line, any batch", () => {
    const r = handoverOuts({ ...base, lines: [cooked(6000)] });
    expect(r.issues).toEqual([]);
    expect(r.outs).toEqual([
      { ingredient_id: ONION, unit: "g", batch_id: null, qty_milli: 720000 },
      { ingredient_id: RICE, unit: "g", batch_id: null, qty_milli: 1260000 },
    ]);
  });

  it("raw lines convert kg → g exactly; a named batch stays on its batch; a batchless raw line pools with the cooked use", () => {
    const r = handoverOuts({ ...base, lines: [
      { food_kind: "raw", item_id: null, ingredient_id: TOMATO, batch_id: BATCH, unit: "kg", qty_milli: 2000 },
      { food_kind: "raw", item_id: null, ingredient_id: ONION, batch_id: null, unit: "g", qty_milli: 50000 },
      cooked(1000),
    ] });
    expect(r.outs).toEqual([
      { ingredient_id: ONION, unit: "g", batch_id: null, qty_milli: 170000 },
      { ingredient_id: RICE, unit: "g", batch_id: null, qty_milli: 210000 },
      { ingredient_id: TOMATO, unit: "g", batch_id: BATCH, qty_milli: 2000000 },
    ]);
  });

  it("cooked use is summed exactly per ingredient and rounded half-up once (1/3 portion twice = 2/3 of 100 g = 66667)", () => {
    const third = { ...base, recipe_versions: [{ recipe_version_id: "v3", item_id: DISH, variant_id: null, valid_from: "2026-10-01", valid_to: null, yield_qty_milli: 3000,
      lines: [{ ingredient_id: ONION, qty_milli: 100000, unit: "g", waste_pct_bp: 0 }] }] };
    // Each line alone is 33333.33… (33333 rounded); together exactly 66666.67 → 66667, not 66666.
    expect(handoverOuts({ ...third, lines: [cooked(1000), cooked(1000)] }).outs).toEqual([{ ingredient_id: ONION, unit: "g", batch_id: null, qty_milli: 66667 }]);
  });

  it("refusals are reported, not guessed: a g line against a kg base, a non-base recipe line, a dish with no recipe in force", () => {
    const r = handoverOuts({ ...base, business_date: "2025-12-31", ingredients: [{ ingredient_id: ONION, base_unit: "kg" }],
      lines: [{ food_kind: "raw", item_id: null, ingredient_id: ONION, batch_id: null, unit: "g", qty_milli: 1000 }, cooked(1000)] });
    expect(r.outs).toEqual([]);
    expect(r.issues).toEqual([{ kind: "unit_mismatch", ingredient_id: ONION }, { kind: "recipe_missing", item_id: DISH }]);
    expect([caresBaseFactor("kg", "g"), caresBaseFactor("l", "ml"), caresBaseFactor("g", "g"), caresBaseFactor("g", "kg"), caresBaseFactor("unit", "g")]).toEqual([1000, 1000, 1, null, null]);
  });
});

describe("claimTotal (recorded, never processed)", () => {
  it("Σ qty × unit price / 1000, rounded half-up once: 20 kg in g at 30 a gram = 600000; 1.5 units at 3 = 5", () => {
    expect(claimTotal([{ qty_milli: 20000000, unit_price_minor: 30 }])).toBe(600000);
    expect(claimTotal([{ qty_milli: 1500, unit_price_minor: 3 }])).toBe(5);
    // Rounded once over the sum: 0.5 + 0.5 = 1, where per-line rounding would give 2.
    expect(claimTotal([{ qty_milli: 500, unit_price_minor: 1 }, { qty_milli: 500, unit_price_minor: 1 }])).toBe(1);
  });
});
