// Gate: the canonical IN and AU pack documents validate against the country-pack schema (zod AND the
// generated JSON Schema's required keys); mutated copies are refused; `@munim/contracts/packs` resolves
// by package name (T-003 and the migrator import it that way).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CountryPack } from "../src/packs/index.ts";
import { PKG } from "./helpers.ts";

const load = (c: string) => JSON.parse(readFileSync(join(PKG, "packs", `${c}.json`), "utf8"));

describe("country packs", () => {
  it.each(["IN", "AU"])("%s.json validates", (c) => {
    const r = CountryPack.safeParse(load(c));
    expect(r.error?.issues ?? []).toEqual([]);
    expect(r.data?.code).toBe(c);
  });

  it("IN carries the ledger's facts", () => {
    const p = CountryPack.parse(load("IN"));
    expect([p.currency.code, p.currency.minor_unit, p.formats.number_grouping, p.payroll_scope, p.surcharges.card_surcharge]).toEqual(["INR", 2, "indian", "drafts", "not_applicable"]);
    const def = p.tax.classes.find((c) => c.code === p.tax.default_class)!;
    expect([def.rate_bp, def.input_tax_credit, def.supply]).toEqual([500, false, "service"]);
    expect(p.tax.classes.filter((c) => c.supply === "goods").map((c) => c.rate_bp)).toEqual([0, 500, 1200, 1800]);
    expect(p.tax.classes.find((c) => c.rate_bp === 1200 && c.supply === "goods")?._unverified?.length).toBeGreaterThan(0);
    expect(p.tax_ids.filter((t) => t.required && t.on_receipt).map((t) => t.code)).toEqual(["GSTIN", "FSSAI"]);
    expect(p.invoice.required_fields).toContain("fssai_number");
    expect(p.aggregators.map((a) => [a.code, a.tax_treatment])).toEqual([["swiggy", "operator_collects_excluded"], ["zomato", "operator_collects_excluded"]]);
    expect(p.printed_price.rule).toBe("sale_above_mrp_refused");
    expect(p.formats.magnitude_words.map((m) => m.word)).toEqual(["thousand", "lakh", "crore"]);
    expect(p.timezones).toEqual(["Asia/Kolkata"]);
    expect(p.licence_kinds.map((k) => k.code)).toEqual(["fssai", "gst", "trade_licence", "fire_noc", "shops_establishment"]);
    expect([p.expired_sale_override, p.status_channels]).toEqual([false, ["in_app"]]);
    expect(Object.keys(p.detectors).length).toBe(44);
    expect(p.detectors["inventory.waste_spike"]?.thresholds).toEqual({ waste_vs_median_bp_gte: 15000, excess_minor_gte: 150000 });
    expect(p.severity_ladder.critical_minor_gte).toBe(5000000);
  });

  it("AU carries the ledger's facts", () => {
    const p = CountryPack.parse(load("AU"));
    expect([p.currency.code, p.currency.minor_unit, p.tax.price_display, p.formats.number_grouping, p.payroll_scope, p.surcharges.card_surcharge]).toEqual(["AUD", 2, "inclusive", "thousands", "roster_only", "prohibited"]);
    expect(p.tax.classes.find((c) => c.code === p.tax.default_class)?.rate_bp).toBe(1000);
    expect([p.invoice.title, p.invoice.every_receipt_is_tax_invoice, p.invoice.buyer_identity_above_minor]).toEqual(["Tax invoice", true, 100000]);
    expect(p.invoice.required_fields).toEqual(expect.arrayContaining(["tax_invoice_words", "abn", "gst_amount"]));
    expect(p.aggregators.map((a) => a.code)).toEqual(["ubereats", "doordash"]);
    expect(p.printed_price.rule).toBe("none");
    expect(p.timezones).toEqual(["Australia/Melbourne", "Australia/Sydney", "Australia/Brisbane", "Australia/Adelaide", "Australia/Perth", "Australia/Darwin", "Australia/Hobart"]);
    expect(p.licence_kinds.map((k) => k.code)).toEqual(["food_business_registration", "abn"]);
    expect([p.expired_sale_override, p.status_channels]).toEqual([false, ["in_app"]]);
    // AU has no payroll (roster_only), so the IN-only advance detector is absent.
    expect(Object.keys(p.detectors).length).toBe(43);
    expect(p.detectors["people.advance_unrecovered"]).toBeUndefined();
    expect(p.detectors["inventory.waste_spike"]?.thresholds).toEqual({ waste_vs_median_bp_gte: 15000, excess_minor_gte: 3000 });
  });

  it("every detector carries an INFERENCE note and the same threshold names in IN and AU", () => {
    const IN = CountryPack.parse(load("IN"));
    const AU = CountryPack.parse(load("AU"));
    for (const p of [IN, AU]) for (const d of Object.values(p.detectors)) expect(d._notes[0]).toMatch(/^INFERENCE: transcribed from docs\/plan\/packs\//);
    for (const [id, d] of Object.entries(AU.detectors)) expect(Object.keys(d.thresholds)).toEqual(Object.keys(IN.detectors[id]!.thresholds));
  });

  it.each([
    ["unknown field", (p: any) => ({ ...p, menulog: true })],
    ["fractional rate", (p: any) => ({ ...p, tax: { ...p.tax, classes: [{ ...p.tax.classes[0], rate_bp: 10.5 }, ...p.tax.classes.slice(1)] } })],
    ["components not summing", (p: any) => ({ ...p, tax: { ...p.tax, classes: [{ ...p.tax.classes[0], components: [{ code: "GST", rate_bp: 900 }] }, ...p.tax.classes.slice(1)] } })],
    ["default tz outside list", (p: any) => ({ ...p, default_timezone: "Asia/Kolkata" })],
    ["bad payroll scope", (p: any) => ({ ...p, payroll_scope: "full" })],
    ["rule none with applies_to", (p: any) => ({ ...p, printed_price: { rule: "none", applies_to: "packaged goods" } })],
    ["empty _unverified", (p: any) => ({ ...p, _unverified: [] })],
    ["missing expired_sale_override", ({ expired_sale_override: _, ...p }: any) => p],
    ["status channel without in_app", (p: any) => ({ ...p, status_channels: ["email"] })],
    ["WhatsApp status channel", (p: any) => ({ ...p, status_channels: ["in_app", "whatsapp"] })],
    ["fractional detector threshold", (p: any) => ({ ...p, detectors: { ...p.detectors, "inventory.shortfall": { thresholds: { lead_days: 2.5 }, _notes: ["x"] } } })],
    ["detector without notes", (p: any) => ({ ...p, detectors: { ...p.detectors, "inventory.shortfall": { thresholds: { lead_days: 2 }, _notes: [] } } })],
  ])("a mutated AU pack is refused: %s", (_label, mutate) => {
    expect(CountryPack.safeParse(mutate(load("AU"))).success).toBe(false);
  });

  it("the generated JSON Schema requires every top-level key the packs carry", () => {
    const js = JSON.parse(readFileSync(join(PKG, "generated", "json-schema", "country-pack.schema.json"), "utf8"));
    const keys = Object.keys(load("IN")).filter((k) => k !== "_unverified");
    expect([...js.required].sort()).toEqual(keys.sort());
  });

  it("@munim/contracts/packs resolves by package name and exports the validated docs", async () => {
    const m = await import("@munim/contracts/packs");
    expect(Object.keys(m.PACKS).sort()).toEqual(["AU", "IN"]);
    expect(m.PACKS.IN.currency.code).toBe("INR");
    const grammar = await import("@munim/contracts/grammar");
    expect(grammar.ENGLISH_CARDINALS.length).toBe(113);
  });
});
