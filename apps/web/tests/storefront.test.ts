// [unit] items from the acceptance checklist the mock cannot produce, plus the mock's own pricing rules.
import { describe, expect, it } from "vitest";
import { parseError } from "@/lib/munim/client";
import { refusalText, type CopyContext } from "@/lib/munim/copy";
import { addToCart, attemptFingerprint, newAttempt, newCartLine, previewRequest, type Cart } from "@/lib/munim/checkout";
import { pushedBack, statusLine } from "@/components/pages/tracker";
import { toE164 } from "@/lib/site";
import type { Schemas } from "@/lib/munim/types";
import { ITEMS, OUTLETS, itemId, optionId, variantId } from "@/mock-server/data";
import { price } from "@/mock-server/pricing";

const ctx: CopyContext = {
  itemName: (id) => (id === "i1" ? "Hazelnut Croissant" : null),
  lineName: (n) => (n === 1 ? "Hazelnut Croissant" : null),
  dealName: () => "Morning bake",
  outletName: "Cobnut Hazratganj",
  nextOpen: "8:00 am",
  money: (m, c) => new Intl.NumberFormat("en-IN", { style: "currency", currency: c }).format(m / 100),
};

describe("refusal copy (stubbed refusals)", () => {
  it("window_full", () => expect(refusalText("window_full", {}, ctx)).toBe("That pickup time just filled up. Please choose another."));
  it("preview_total_changed", () => expect(refusalText("preview_total_changed", {}, ctx)).toBe("The total changed since the preview. Review it and try again."));
  it("deal_changed", () => expect(refusalText("deal_changed", { deal_id: "d" }, ctx)).toBe("The Morning bake deal was updated. Please review your cart."));
  it("item_unavailable names the line", () => expect(refusalText("item_unavailable", { line_no: 1 }, ctx)).toBe("Hazelnut Croissant isn't available right now. Remove it to continue."));
  it("coupon_min_spend uses the server's shortfall", () =>
    expect(refusalText("coupon_min_spend", { shortfall_minor: 27000, currency: "INR" }, ctx)).toBe("Spend ₹270.00 more to use this coupon."));
  it("outlet_paused with the next opening", () => expect(refusalText("outlet_paused", {}, ctx)).toBe("Cobnut Hazratganj stopped taking orders a moment ago. Back at 8:00 am."));
});

describe("client error parsing", () => {
  it("429 waits Retry-After and keeps no server message", () => {
    const res = new Response(null, { status: 429, headers: { "Retry-After": "5" } });
    const e = parseError(res, { error: { code: "unavailable", message: "SERVER TEXT", reason_code: "rate_limited" } });
    expect(e).toEqual({ kind: "rate_limited", status: 429, code: "unavailable", reasonCode: "rate_limited", params: {}, retryAfterMs: 5000 });
    expect(JSON.stringify(e)).not.toContain("SERVER TEXT");
  });
  it("every 404 is not_found", () => expect(parseError(new Response(null, { status: 404 }), "not json").kind).toBe("not_found"));
  it("idempotency_conflict is key_reused", () => expect(parseError(new Response(null, { status: 409 }), { error: { code: "idempotency_conflict", message: "x", reason_code: null } }).kind).toBe("key_reused"));
});

type OrderView = Schemas["StorefrontOrderView"];
const order = (over: Partial<OrderView>): OrderView => ({
  order_id: "o", outlet_id: "x", kind: "pickup", status: "placed", ticket_no: 7, business_date: "2026-10-14", promised_at: null, pickup_window_id: null,
  subtotal_minor: 0, discount_minor: 0, tax_minor: 0, total_minor: 0, currency: "INR", created_at: "2026-10-14T00:00:00Z", cancel_window_min: 1,
  reschedule_window_min: 1, pay_at_counter: true, prices_include_tax: false, lines: [], events: [], ...over,
});
const ev = (o: Partial<OrderView["events"][number]>): OrderView["events"][number] => ({ kind: "status", from_status: null, to_status: null, from_promised_at: null, to_promised_at: null, reason: null, at: "2026-10-14T00:00:00Z", ...o });

describe("tracker copy (stubbed orders)", () => {
  it("rejected with a reason", () => expect(statusLine(order({ status: "rejected", events: [ev({ to_status: "rejected", reason: "out_of_stock" })] }))).toBe("Sorry — the outlet couldn't take this order: Out of stock."));
  it("rejected without a reason", () => expect(statusLine(order({ status: "rejected", events: [ev({ to_status: "rejected" })] }))).toBe("Sorry — the outlet couldn't take this order."));
  const moved = (reason: string) => order({ events: [ev({ kind: "promised_at", from_promised_at: "2026-10-14T10:00:00Z", to_promised_at: "2026-10-14T10:20:00Z", reason })] });
  it("kitchen pushed back", () => expect(pushedBack(moved("kitchen_busy"))).toBe("2026-10-14T10:00:00Z"));
  it("customer reschedule is not a push-back", () => expect(pushedBack(moved("customer_rescheduled"))).toBeNull());
});

describe("phone numbers", () => {
  it.each([["98123 45678", "+919812345678"], ["098123-45678", "+919812345678"], ["+91 98123 45678", "+919812345678"], ["919812345678", "+919812345678"], ["12345", null], ["51234 56789", null]])("%s", (input, want) => expect(toE164(input)).toBe(want));
});

describe("cart and attempts", () => {
  const cart: Cart = { outletId: OUTLETS[0]!.outlet_id, lines: [], slot: { pickupWindowId: null, promisedAt: null }, couponCodes: [] };
  it("merges identical lines but keeps differently noted cakes apart", () => {
    const cake = itemId("praline_celebration_cake");
    let c = addToCart(cart, newCartLine(cake, null, [], 1, "Happy birthday"));
    c = addToCart(c, newCartLine(cake, null, [], 1, "Happy birthday"));
    c = addToCart(c, newCartLine(cake, null, [], 1, "Congratulations"));
    expect(c.lines.map((l) => [l.qty, l.note])).toEqual([[2, "Happy birthday"], [1, "Congratulations"]]);
  });
  it("sends the note only when placing, and a new note means a new attempt", () => {
    const c = addToCart(cart, newCartLine(itemId("hazelnut_croissant"), null, [], 1, "warm please"));
    const menu = { channel_id: "019a0c5e-0000-7000-8000-000000000001", items: [] } as unknown as Schemas["StorefrontMenuResponse"];
    expect(previewRequest(c, menu).lines[0]).not.toHaveProperty("note");
    const a = newAttempt(c, menu, { name: "A", phone: null, email: "a@example.com", marketing: false }, 100);
    expect(a.body.order.payload.lines[0]!.note).toBe("warm please");
    const other = { ...c, lines: c.lines.map((l) => ({ ...l, note: "cold" })) };
    expect(attemptFingerprint(other, { name: "A", phone: null, email: "a@example.com", marketing: false }, 100)).not.toBe(a.fingerprint);
  });
});

describe("mock pricing (the stand-in server)", () => {
  const hz = OUTLETS[0]!;
  const gn = OUTLETS[1]!;
  const noon = new Date("2026-10-14T06:30:00Z"); // 12:00 in Lucknow, a Wednesday: outside the morning deal
  const req = (lines: Schemas["OrdersPreviewRequest"]["lines"], coupons: string[] = []): Schemas["OrdersPreviewRequest"] => ({
    outlet_id: hz.outlet_id, channel_id: "c", brand_id: null, kind: "pickup", pickup_window_id: null, promised_at: null, coupon_codes: coupons, loyalty_redeem_points: 0, lines,
  });
  const line = (slug: string, qty = 1, variant: string | null = null, options: string[] = []) => ({ item_id: itemId(slug), variant_id: variant, option_ids: options, qty_milli: qty * 1000, barcode: null });

  it("adds 5% GST as CGST + SGST and totals are consistent", () => {
    const { preview } = price(req([line("hazelnut_croissant", 2)]), hz, "open", noon);
    expect(preview.subtotal_minor).toBe(36000);
    expect(preview.tax_components.map((t) => t.amount_minor)).toEqual([900, 900]);
    expect(preview.total_minor).toBe(37800);
  });
  it("cake price = variant + eggless option", () => {
    const cake = "praline_celebration_cake";
    const { preview } = price(req([line(cake, 1, variantId(cake, "one_kg"), [optionId(cake, "sponge", "eggless")])]), hz, "open", noon);
    expect(preview.lines[0]!.unit_price_minor + preview.lines[0]!.options_minor).toBe(148000);
  });
  it("COBNUT10 below the minimum spend reports the shortfall", () => {
    const { preview } = price(req([line("brown_butter_cookie")], ["COBNUT10"]), hz, "open", noon);
    expect(preview.refusals).toEqual([{ line_no: null, reason_code: "coupon_min_spend", params: { code: "COBNUT10", min_spend_minor: 50000, shortfall_minor: 41000, currency: "INR" } }]);
  });
  it("GANJ5 is out of scope at Gomti Nagar", () => {
    const { preview } = price({ ...req([line("truffle_tin")], ["GANJ5"]), outlet_id: gn.outlet_id }, gn, "busy", noon);
    expect(preview.refusals[0]!.reason_code).toBe("coupon_out_of_scope");
  });
  it("sold out everywhere, and only at Gomti Nagar", () => {
    expect(price(req([line("pistachio_danish")]), hz, "open", noon).preview.refusals[0]!.reason_code).toBe("item_sold_out");
    expect(price(req([line("rose_tres_leches")]), hz, "open", noon).preview.refusals).toEqual([]);
    expect(price(req([line("rose_tres_leches")]), gn, "busy", noon).preview.refusals[0]!.reason_code).toBe("item_sold_out");
  });
  it("morning bake deal applies at 09:00 and not at noon", () => {
    const nine = new Date("2026-10-14T03:30:00Z");
    expect(price(req([line("cardamom_knot")]), hz, "open", nine).preview.lines[0]!.deal_refs).toHaveLength(1);
    expect(price(req([line("cardamom_knot")]), hz, "open", noon).preview.lines[0]!.deal_refs).toHaveLength(0);
  });
  it("paused outlets refuse", () => expect(price(req([line("cold_coffee", 1, null, [optionId("cold_coffee", "milk", "oat")])]), hz, "paused", noon).preview.refusals[0]!.reason_code).toBe("outlet_paused"));
  it("every catalogue item has a category the site labels", () => expect(new Set(ITEMS.map((i) => i.category))).toEqual(new Set(["pastries", "cakes", "cookies", "gift_boxes", "drinks"])));
});
