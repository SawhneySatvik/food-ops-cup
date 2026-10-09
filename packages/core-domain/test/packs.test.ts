import { readFileSync } from "node:fs";
import { PACKS, type CountryPack } from "@munim/contracts/packs";
import { describe, expect, it } from "vitest";
import discountSales from "./fixtures/discount-sales.json" with { type: "json" };
import labels from "./fixtures/labels-en.json" with { type: "json" };
import IN_RECEIPT from "./fixtures/receipt-IN.json" with { type: "json" };
import AU_RECEIPT from "./fixtures/receipt-AU.json" with { type: "json" };
import cash from "./goldens/cash-rounding.json" with { type: "json" };
import totals from "./goldens/tax-totals.json" with { type: "json" };
import { buildReceipt, cardSurchargeAllowed, cashTender, orderTax, payrollDrafted, renderReceipt, type ReceiptInput, type SaleLine } from "../packs/index.ts";

const golden = (name: string) => readFileSync(new URL(`./goldens/${name}`, import.meta.url));
const { _note: _a, ...inInput } = IN_RECEIPT;
const { _note: _b, ...auInput } = AU_RECEIPT;
const IN = inInput as ReceiptInput;
const AU = auInput as ReceiptInput;
const CASES: Array<[string, CountryPack, ReceiptInput]> = [
  ["receipt-IN.txt", PACKS.IN, IN],
  ["receipt-AU.txt", PACKS.AU, AU],
  // Sec 9(5): the platform pays the tax and issues the tax invoice; the merchant prints a record only.
  ["receipt-IN-aggregator.txt", PACKS.IN, { ...IN, channel_kind: "aggregator:swiggy" }],
];

describe("country-pack engine: golden receipts (byte-equal)", () => {
  for (const [file, pack, input] of CASES) {
    it(`${file}`, () => {
      const r = buildReceipt(pack, input);
      if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.refusal)}`);
      const out = Buffer.from(renderReceipt(r.receipt, pack, labels), "utf8");
      const want = golden(file);
      expect(want.length).toBeGreaterThan(300);
      expect(out.toString("utf8")).toBe(want.toString("utf8"));
      expect(out.equals(want)).toBe(true);
    });
  }

  it("a record-only receipt carries no tax-invoice title and no tax component lines", () => {
    const r = buildReceipt(PACKS.IN, { ...IN, channel_kind: "aggregator:zomato" });
    if (!r.ok) throw new Error("refused");
    expect(r.receipt.kind).toBe("record");
    const text = renderReceipt(r.receipt, PACKS.IN, labels);
    expect(text).not.toContain(PACKS.IN.invoice.title);
    expect(text).not.toMatch(/CGST|SGST/);
    // AU aggregators are merchant_collects: still a tax invoice.
    const au = buildReceipt(PACKS.AU, { ...AU, channel_kind: "aggregator:ubereats" });
    expect(au.ok && au.receipt.kind).toBe("tax_invoice");
  });
});

describe("country-pack engine: tax totals by channel", () => {
  const expected = totals as unknown as Record<string, unknown>;
  const runs: Array<[string, CountryPack, SaleLine[], string]> = [
    ["IN:counter", PACKS.IN, IN.lines, "counter"],
    ["IN:aggregator:swiggy", PACKS.IN, IN.lines, "aggregator:swiggy"],
    ["AU:counter", PACKS.AU, AU.lines, "counter"],
    ["AU:aggregator:ubereats", PACKS.AU, AU.lines, "aggregator:ubereats"],
    ["IN:discount", PACKS.IN, discountSales.IN, "counter"],
    ["AU:discount", PACKS.AU, discountSales.AU, "counter"],
  ];
  for (const [key, pack, lines, channel_kind] of runs) {
    it(key, () => {
      const r = orderTax(pack, { channel_kind, lines });
      if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.refusal)}`);
      const { net_minor, tax_minor, total_minor, components, own_liability_minor, operator_liability_minor } = r.tax;
      expect({ net_minor, tax_minor, total_minor, components, own_liability_minor, operator_liability_minor }).toEqual(expected[key]);
    });
  }

  it("discounts: exclusive packs tax the discounted net, inclusive packs discount the gross", () => {
    const inR = orderTax(PACKS.IN, { channel_kind: "counter", lines: discountSales.IN });
    const auR = orderTax(PACKS.AU, { channel_kind: "counter", lines: discountSales.AU });
    if (!inR.ok || !auR.ok) throw new Error("refused");
    expect(inR.tax.lines[0]).toMatchObject({ amount_minor: 56000, discount_minor: 5600, net_minor: 50400, tax_minor: 2520, total_minor: 52920 });
    expect(auR.tax.lines[0]).toMatchObject({ amount_minor: 2050, discount_minor: 205, net_minor: 1677, tax_minor: 168, total_minor: 1845 });
    const r = buildReceipt(PACKS.AU, { ...AU, lines: discountSales.AU });
    if (!r.ok) throw new Error("refused");
    expect(renderReceipt(r.receipt, PACKS.AU, labels)).toContain("\n  1 x $20.50 = $20.50\n  Discount -$2.05\n  GST 10% $1.68\n");
  });

  it("refuses an unknown tax class and an aggregator the pack does not list (reason codes)", () => {
    const line = { name: "X", qty_milli: 1000, unit_price_minor: 100, tax_class: "no_such_class", mrp_minor: null };
    expect(orderTax(PACKS.IN, { channel_kind: "counter", lines: [line] })).toEqual({ ok: false, refusal: { reason_code: "unknown_tax_class", line_no: 1, code: "no_such_class" } });
    expect(orderTax(PACKS.AU, { channel_kind: "aggregator:swiggy", lines: [{ ...line, tax_class: null }] })).toEqual({
      ok: false,
      refusal: { reason_code: "unknown_channel", code: "aggregator:swiggy" },
    });
  });
});

describe("country-pack engine: MRP, buyer identity, tax ids, surcharge, payroll, cash rounding", () => {
  const shopLine = (mrp_minor: number | null, tax_class: string, batch?: { mrp_minor: number | null }) => ({
    name: "Packaged juice",
    qty_milli: 1000,
    unit_price_minor: 10000,
    tax_class,
    mrp_minor,
    ...(batch ? { batch } : {}),
  });
  const sale = (pack: CountryPack, l: SaleLine) => orderTax(pack, { channel_kind: "counter", lines: [l] });
  const refused = { ok: false, refusal: { reason_code: "price_above_mrp", line_no: 1 } };

  it("IN: a sale above the printed MRP (tax-inclusive) is refused; at the MRP it is accepted", () => {
    // 100.00 + 18% = 118.00 inclusive: an MRP of 110.00 refuses, 118.00 accepts.
    expect(sale(PACKS.IN, shopLine(11000, "goods_18"))).toEqual(refused);
    expect(sale(PACKS.IN, shopLine(11800, "goods_18")).ok).toBe(true);
    expect(sale(PACKS.IN, shopLine(11799, "goods_18")).ok).toBe(false);
  });

  it("IN: the sold batch's MRP binds when a batch is picked, else the item's", () => {
    expect(sale(PACKS.IN, shopLine(11800, "goods_18", { mrp_minor: 11000 }))).toEqual(refused);
    expect(sale(PACKS.IN, shopLine(11000, "goods_18", { mrp_minor: 12000 })).ok).toBe(true);
    expect(sale(PACKS.IN, shopLine(11000, "goods_18", { mrp_minor: null }))).toEqual(refused);
  });

  it("IN: option price deltas count toward the MRP comparison", () => {
    expect(sale(PACKS.IN, { ...shopLine(11800, "goods_18"), option_delta_minor: 1 })).toEqual(refused);
  });

  it("AU: the pack has no MRP rule", () => {
    expect(sale(PACKS.AU, shopLine(100, "gst_10")).ok).toBe(true);
  });

  it("AU: buyer identity is required above AUD 1,000 (strictly above; boundary UNVERIFIED in the pack)", () => {
    const big = (unit_price_minor: number, buyer: ReceiptInput["buyer"]): ReceiptInput => ({
      ...AU,
      buyer,
      lines: [{ name: "Catering tray", qty_milli: 1000, unit_price_minor, tax_class: "gst_10", mrp_minor: null }],
    });
    expect(buildReceipt(PACKS.AU, big(100000, null)).ok).toBe(true);
    expect(buildReceipt(PACKS.AU, big(100001, null))).toEqual({ ok: false, refusal: { reason_code: "buyer_identity_required" } });
    const withBuyer = buildReceipt(PACKS.AU, big(100001, { name: "Acme Events Pty Ltd (synthetic)" }));
    if (!withBuyer.ok) throw new Error("refused");
    expect(renderReceipt(withBuyer.receipt, PACKS.AU, labels)).toContain("\nBuyer: Acme Events Pty Ltd (synthetic)\n");
    // IN has no buyer-identity threshold: a large bill without a buyer is accepted.
    expect(buildReceipt(PACKS.IN, { ...IN, lines: [{ ...IN.lines[0]!, unit_price_minor: 99_000_000 }] }).ok).toBe(true);
  });

  it("required tax ids must be present and match the pack pattern", () => {
    const seller = (tax_ids: Record<string, string>) => ({ ...IN, seller: { ...IN.seller, tax_ids } });
    expect(buildReceipt(PACKS.IN, seller({ GSTIN: "29ABCDE1234F1Z5" }))).toEqual({ ok: false, refusal: { reason_code: "tax_id_missing", code: "FSSAI", problem: "absent" } });
    expect(buildReceipt(PACKS.IN, seller({ GSTIN: "29ABCDE1234F1Z", FSSAI: "11226999000123" }))).toEqual({
      ok: false,
      refusal: { reason_code: "tax_id_missing", code: "GSTIN", problem: "pattern" },
    });
    expect(buildReceipt(PACKS.AU, { ...AU, seller: { ...AU.seller, tax_ids: {} } })).toEqual({
      ok: false,
      refusal: { reason_code: "tax_id_missing", code: "ABN", problem: "absent" },
    });
  });

  it("an invoice field the engine does not know fails closed", () => {
    const pack = { ...PACKS.AU, invoice: { ...PACKS.AU.invoice, required_fields: [...PACKS.AU.invoice.required_fields, "mystery_field"] } };
    expect(() => buildReceipt(pack, AU)).toThrow(/mystery_field/);
  });

  it("card surcharge and payroll scope come from the pack", () => {
    expect([cardSurchargeAllowed(PACKS.IN), cardSurchargeAllowed(PACKS.AU)]).toEqual([true, false]);
    expect([payrollDrafted(PACKS.IN), payrollDrafted(PACKS.AU)]).toEqual([true, false]);
  });

  it(`cash rounding: ${cash.cases.length} committed cases (cash only, half-up to the pack step)`, () => {
    expect(cash.cases.length).toBe(8);
    for (const c of cash.cases) {
      const pack = PACKS[c.pack as "IN" | "AU"];
      expect(pack.cash_rounding_minor).toBe(c.step);
      expect(cashTender(pack, c.method, c.due_minor)).toEqual({ amount_minor: c.amount_minor, rounding_minor: c.rounding_minor });
    }
  });
});
