// B13: every storefront refusal code and every W2 reason code has its own fixed message (not the generic
// code text), and the contract accepts it as a reason code.
import { COMMAND_REASON_CODES, PACK_RULE_REASON_CODES, ReasonCode, STOREFRONT_REASON_CODES, W2_REASON_CODES } from "@munim/contracts";
import { STOREFRONT_REFUSAL_COPY } from "@munim/contracts/storefront";
import { describe, expect, it } from "vitest";
import { errorBody } from "../src/lib/errors.ts";

describe("reason-code messages", () => {
  // Every refusal a core command or the storefront can attach (R3-M8): totality over the four reason-code lists.
  const codes = [...new Set([...Object.keys(STOREFRONT_REFUSAL_COPY), ...STOREFRONT_REASON_CODES, ...COMMAND_REASON_CODES, ...PACK_RULE_REASON_CODES, ...W2_REASON_CODES])] as ReasonCode[];
  it("each has a message distinct from the generic conflict text", () => {
    for (const named of ["window_full", "outlet_paused", "item_sold_out", "deal_rejudged", "coupon_invalid", "coupon_cap_reached", "coupon_min_spend", "change_window_closed",
      "not_applicable", "item_unavailable", "reason_required", "deal_changed", "duplicate_invoice", "guest_cannot_change",
      "refund_first", "order_tendered", "cash_below_rounding",
      "coupon_expired", "coupon_out_of_scope", "price_above_mrp", "expired_batch", "preview_total_changed", "unit_mismatch", "tax_id_missing", "period_closed", "model_blocked"]) expect(codes).toContain(named);
    expect(codes.length).toBeGreaterThanOrEqual(26);
    for (const r of codes) {
      expect(ReasonCode.safeParse(r).success).toBe(true);
      const m = errorBody("conflict", r).error.message;
      expect(m, r).not.toBe(errorBody("conflict").error.message);
    }
  });
  it("guest_cannot_change carries the ruled copy; no reason code keeps the code's text", () => {
    expect(errorBody("forbidden", "guest_cannot_change").error.message).toBe("Call the outlet to change this order");
    expect(errorBody("conflict").error.message).toBe("This changed since you loaded it.");
  });
  it("the three order-money refusals carry their ruled copy", () => {
    expect(errorBody("conflict", "refund_first").error.message).toBe("Refund the payments on this order before cancelling it.");
    expect(errorBody("conflict", "order_tendered").error.message).toBe("A payment is recorded on this order, so its time can't change.");
    expect(errorBody("conflict", "cash_below_rounding").error.message).toBe("Less than the smallest cash amount is due; take it by card or UPI.");
  });
});
