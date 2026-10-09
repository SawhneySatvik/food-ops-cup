import { PACKS } from "@munim/contracts/packs";
import { describe, expect, it } from "vitest";
import { add, allocate, decimalString, formatMoney, money, MoneyError, mulDiv, sub, sum } from "../money/index.ts";

describe("money: minor-unit integers, half-up rounding", () => {
  it("rounds half away from zero", () => {
    expect([mulDiv(1, 1, 2), mulDiv(3, 1, 2), mulDiv(5, 1, 2), mulDiv(-1, 1, 2), mulDiv(-3, 1, 2)]).toEqual([1, 2, 3, -1, -2]);
    expect(mulDiv(10101, 250, 10000)).toBe(253); // 252.525
    expect(mulDiv(1010, 250, 10000)).toBe(25); // 25.25
    expect(mulDiv(2390, 1000, 11000)).toBe(217); // 217.27
  });

  it("multiplies through BigInt (no float drift at large values)", () => {
    expect(mulDiv(9_007_199_254_740_991, 1, 1)).toBe(9_007_199_254_740_991);
    expect(mulDiv(900_719_925_474_099, 10, 10)).toBe(900_719_925_474_099);
    expect(() => mulDiv(9_007_199_254_740_991, 2, 1)).toThrow(MoneyError);
  });

  it("allocates a total across weights without drift", () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(-100, [1, 1, 1])).toEqual([-34, -33, -33]);
    expect(allocate(1000, [24000, 10101, 1010])).toEqual([683, 288, 29]); // 683.55, 287.69, 28.77 → largest remainders
    for (const [total, weights] of [[1, [1, 1, 1]], [99999, [3, 7, 11, 13]], [5, [0, 1, 0]]] as const) {
      const parts = allocate(total, [...weights]);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
    }
    expect(() => allocate(10, [0, 0])).toThrow(MoneyError);
  });

  it("refuses arithmetic across currencies", () => {
    expect(add(money(100, "INR"), money(250, "INR"))).toEqual({ amount_minor: 350, currency: "INR" });
    expect(sub(money(100, "AUD"), money(250, "AUD"))).toEqual({ amount_minor: -150, currency: "AUD" });
    expect(sum([money(1, "AUD"), money(2, "AUD")], "AUD")).toEqual({ amount_minor: 3, currency: "AUD" });
    const err = (() => { try { add(money(100, "INR"), money(1, "AUD")); } catch (e) { return e; } })();
    expect(err).toBeInstanceOf(MoneyError);
    expect((err as MoneyError).code).toBe("currency_mismatch");
    expect(() => sum([money(1, "INR")], "AUD")).toThrow(MoneyError);
    expect(() => money(1.5, "INR")).toThrow(MoneyError);
  });

  it("formats from the pack locale (lakh/crore grouping comes from en-IN, not a country check)", () => {
    expect(formatMoney(money(1_234_567_805, "INR"), PACKS.IN)).toBe("₹1,23,45,678.05");
    expect(formatMoney(money(123_456_750, "AUD"), PACKS.AU)).toBe("$1,234,567.50");
    expect(formatMoney(money(-500, "INR"), PACKS.IN)).toBe("-₹5.00");
    expect(formatMoney(money(5, "AUD"), PACKS.AU)).toBe("$0.05");
    expect(() => formatMoney(money(5, "AUD"), PACKS.IN)).toThrow(MoneyError);
  });

  it("builds exact decimal strings", () => {
    expect([decimalString(5, 2), decimalString(-5, 2), decimalString(1500, 3), decimalString(250, 4), decimalString(7, 0)]).toEqual([
      "0.05",
      "-0.05",
      "1.500",
      "0.0250",
      "7",
    ]);
  });
});
