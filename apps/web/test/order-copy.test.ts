// T-063: every refusal the storefront can meet resolves to its literal spec copy; amounts are the server's params
// formatted, never computed; unknown reasons fall back to the generic line (never server text).
import { STOREFRONT_REFUSAL_COPY } from "@munim/contracts/storefront";
import { expect, test } from "vitest";
import { messages } from "../lib/i18n/index.ts";
import { refusalText, type CopyContext } from "../lib/order/copy.ts";
import { dayRuns, formatterFor } from "../lib/order/format.ts";
import { newAttempt } from "../lib/order/api.ts";

const ctx: CopyContext = {
  fmt: formatterFor("INR", "Asia/Kolkata")!, outletName: "Spice Route North", nextOpen: "14 Oct 2026, 11:00",
  itemName: (id) => (id === "i1" ? "Paneer tikka" : null), dealName: () => null, pickedTime: "12:30",
};

test("the spec's literal refusal copy", () => {
  expect(refusalText("window_full", "conflict", {}, null, ctx)).toBe("That pickup time just filled up. Please choose another.");
  expect(refusalText("outlet_paused", "conflict", {}, null, ctx)).toBe("Spice Route North stopped taking orders a moment ago. Back at 14 Oct 2026, 11:00.");
  expect(refusalText("item_sold_out", "conflict", { item_id: "i1" }, null, ctx)).toBe("Paneer tikka just sold out. Remove it to continue.");
  expect(refusalText("deal_rejudged", "conflict", { old_total_minor: 11200, new_total_minor: 14000, currency: "INR" }, null, ctx))
    .toBe("The promotional deal isn't available at 12:30. Your total changed from ₹112.00 to ₹140.00.");
  expect(refusalText("coupon_min_spend", "conflict", { shortfall_minor: 2000, currency: "INR" }, null, ctx)).toBe("Spend ₹20.00 more to use this coupon.");
  expect(refusalText("coupon_cap_reached", "conflict", {}, null, ctx)).toBe("This coupon has reached its limit.");
  expect(refusalText("coupon_out_of_scope", "conflict", {}, null, ctx)).toBe("This coupon isn't valid at this outlet.");
  expect(refusalText("coupon_expired", "conflict", {}, null, ctx)).toBe("This coupon has expired.");
  expect(refusalText("change_window_closed", "conflict", {}, null, ctx)).toBe("It's too late to change this order online. Please call the outlet.");
  expect(refusalText("rate_limited", "unavailable", {}, null, ctx)).toBe("Too many requests. Please wait a moment and try again.");
  expect(refusalText("something_new", "conflict", {}, null, ctx)).toBe("Your order was not placed. Please try again.");
  expect(refusalText(null, "internal", {}, null, ctx)).toBe("We're having trouble right now. Please try again in a moment.");
});

// The renderer reads the contracts' map, so every code in it must render its own copy: not the generic line, and with
// no `{placeholder}` left over (a code added to the map without a message or a var would fail here).
test("every STOREFRONT_REFUSAL_COPY code renders its specific copy", () => {
  const generic = refusalText("nothing_like_this", "conflict", {}, null, ctx);
  const params = { item_id: "i1", old_total_minor: 100, new_total_minor: 200, shortfall_minor: 300, currency: "INR" };
  const codes = Object.keys(STOREFRONT_REFUSAL_COPY);
  expect(codes.length).toBeGreaterThan(8);
  for (const reason of codes) {
    const text = refusalText(reason, "conflict", params, null, ctx);
    expect(text, reason).not.toBe(generic);
    expect(text, reason).not.toMatch(/[{}]/);
    expect(messages[STOREFRONT_REFUSAL_COPY[reason as keyof typeof STOREFRONT_REFUSAL_COPY]], reason).toBeTypeOf("string");
  }
});

test("deal days collapse to runs", () => {
  const name = (d: number) => ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][d]!;
  expect(dayRuns([5, 1, 2, 3, 4], name)).toBe("Mon–Fri");
  expect(dayRuns([6, 7], name)).toBe("Sat, Sun");
});

test("a new attempt has fresh ids each time", () => {
  const a = newAttempt("x"), b = newAttempt("x");
  expect(a.orderId).not.toBe(b.orderId);
  expect(a.orderKey).not.toBe(b.orderKey);
});
