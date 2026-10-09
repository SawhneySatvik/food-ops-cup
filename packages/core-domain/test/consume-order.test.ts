import { describe, expect, it } from "vitest";
import fixture from "./fixtures/consume-order.json" with { type: "json" };
import golden from "./goldens/consume-order.expected.json" with { type: "json" };
import skuGolden from "./goldens/consume-sku.expected.json" with { type: "json" };
import { consumeOrder, consumeSku, RULES, validateRecipe, type ConsumeInput } from "../inventory/index.ts";

const { _note, ...base } = fixture;
const input = (over: Partial<ConsumeInput> = {}): ConsumeInput => ({ ...(base as ConsumeInput), ...over });

describe("derivation rules inventory.consume_order / inventory.consume_sku", () => {
  it("are registered with their source and target tables", () => {
    expect(RULES).toContainEqual({ rule_id: "inventory.consume_order", source_table: "core.order", target_table: "core.stock_movement" });
    expect(RULES).toContainEqual({ rule_id: "inventory.consume_sku", source_table: "core.order", target_table: "core.stock_movement" });
  });

  it("consume_order explodes the committed order fixture into the hand-computed movements", () => {
    const { _note: _n, ...expected } = golden;
    expect(expected.movements.length).toBe(5);
    expect(consumeOrder(input())).toEqual(expected);
  });

  it("consume_sku: a SKU consumes its stock ingredient 1:1 by quantity", () => {
    const { _note: _n, ...expected } = skuGolden;
    expect(expected.movements.length).toBe(1);
    expect(consumeSku(input())).toEqual(expected);
  });

  it("uses the order row's business_date (v1 on 9 Oct), never recomputing it from placed_at", () => {
    const line1 = fixture.order.lines[0]!;
    const out = consumeOrder(input({ order: { ...fixture.order, business_date: "2026-10-09", lines: [line1] } }));
    expect(out.business_date).toBe("2026-10-09");
    expect(out.lines).toEqual([{ line_no: 1, recipe_version_id: "0192f000-0000-7000-8000-000000000101" }]);
    // v1: 3000/4000 * 800 = 600; option f1: 3 * 100 * 1.05 = 315.
    expect(out.movements.map((m) => [m.ingredient_id.slice(-2), m.qty_milli])).toEqual([["a1", -915]]);
  });

  it("a unit mismatch at sale time never throws: the contribution is skipped and reported", () => {
    const recipe_versions = fixture.recipe_versions.map((v) => ({ ...v, lines: v.lines.map((l) => (l.ingredient_id.endsWith("a3") ? { ...l, unit: "ml" } : l)) }));
    const out = consumeOrder(input({ recipe_versions }));
    expect(out.movements.map((m) => m.ingredient_id.slice(-2))).toEqual(["a1", "a2", "a4", "a5"]);
    expect(out.issues).toEqual([
      { kind: "unit_mismatch", line_no: 1, ingredient_id: "0192f000-0000-7000-8000-0000000000a3" },
      { kind: "unit_mismatch", line_no: 2, ingredient_id: "0192f000-0000-7000-8000-0000000000a3" },
    ]);
  });

  it("save-time validation refuses a recipe line or option delta whose unit is not the ingredient base unit", () => {
    const v2 = fixture.recipe_versions[1]!;
    expect(validateRecipe({ lines: v2.lines }, fixture.ingredients)).toEqual({ ok: true });
    const bad = { lines: v2.lines.map((l, i) => (i === 1 ? { ...l, unit: "g" } : l)) };
    expect(validateRecipe(bad, fixture.ingredients)).toEqual({ ok: false, reason_code: "unit_mismatch", line_no: 2, ingredient_id: v2.lines[1]!.ingredient_id });
    expect(validateRecipe({ lines: [{ ...fixture.option_deltas[0]!, unit: "g" }] }, fixture.ingredients)).toMatchObject({ ok: false, reason_code: "unit_mismatch" });
  });
});
