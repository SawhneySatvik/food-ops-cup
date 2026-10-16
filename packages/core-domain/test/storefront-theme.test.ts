// T-128 storefront theme contrast (design-system §9, §10). Reference ratios are WCAG's published worked values (black on white
// 21:1; #777777 on white 4.48:1, the classic just-below-AA grey) and the 02-design §2 table for Cobnut's own pairs (accent with
// ink 12.49:1), typed by hand; the verdicts are what §9 says a theme must meet.
import { describe, expect, it } from "vitest";
import { contrast, judgeTheme } from "../storefront/index.ts";

const COBNUT = { primary: "#7b3f1d", secondary: "#9e2f4e", accent: "#f6d9c8" };

describe("contrast", () => {
  it("matches WCAG's reference values", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(Number(contrast("#777777", "#ffffff").toFixed(2))).toBe(4.48);
    expect(Number(contrast("#2a1a12", "#f6d9c8").toFixed(2))).toBe(12.49);
    expect(contrast("#ffffff", "#777777")).toBe(contrast("#777777", "#ffffff"));
  });
});

describe("judgeTheme", () => {
  it("Cobnut's own colours pass, with white text on primary and secondary", () => {
    expect(judgeTheme(COBNUT)).toEqual({ ok: true, onPrimary: "#ffffff", onSecondary: "#ffffff" });
  });
  it("a light primary takes ink text but cannot be read on the page → refused, primary, its measured ratio", () => {
    const v = judgeTheme({ ...COBNUT, primary: "#f0b429" });
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.token).toBe("primary");
      expect(v.ratio).toBeLessThan(4.5);
      expect(Number(v.ratio.toFixed(2))).toBe(Number(contrast("#f0b429", "#fbf4ea").toFixed(2)));
    }
  });
  it("a mid grey secondary reads with neither white nor ink at 4.5 → refused, secondary", () => {
    const v = judgeTheme({ ...COBNUT, secondary: "#8a6a5a" });
    expect(v).toMatchObject({ ok: false, token: "secondary" });
  });
  it("a dark accent under ink → refused, accent", () => {
    expect(judgeTheme({ ...COBNUT, accent: "#5b3a78" })).toMatchObject({ ok: false, token: "accent" });
  });
  it("a deep green primary passes with white text", () => {
    expect(judgeTheme({ ...COBNUT, primary: "#1f5132" })).toMatchObject({ ok: true, onPrimary: "#ffffff" });
  });
});
