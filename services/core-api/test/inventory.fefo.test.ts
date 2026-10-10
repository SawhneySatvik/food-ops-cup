// T-024 gate — FEFO picks the earliest expiry (hand-written cases, fixed dates; business date 2026-10-10) and the
// binding MRP per line. Pure: no database. Every expected pick below was written by hand from the case table.
import { describe, expect, it } from "vitest";
import { bindingMrp, fefoPick } from "../src/modules/inventory/index.ts";

const BD = "2026-10-10";
const ING = "ing-a";
const batch = (batch_id: string, expires_on: string | null, remaining_milli: number, received_at = "2026-10-01T00:00:00.000Z", ingredient_id = ING) =>
  ({ batch_id, ingredient_id, expires_on, received_at, remaining_milli });
const line = (line_id: string, qty_milli: number, extra: { expired_blocks?: boolean; ingredient_id?: string } = {}) =>
  ({ line_id, ingredient_id: extra.ingredient_id ?? ING, qty_milli, ...(extra.expired_blocks === undefined ? {} : { expired_blocks: extra.expired_blocks }) });
/** [line, batch, qty, override] — the shape every expectation is written in. */
const short = (r: ReturnType<typeof fefoPick>) => r.picks.map((p) => [p.line_id, p.batch_id, p.qty_milli, p.override_id]);

describe("FEFO picks the earliest expiry (committed cases)", () => {
  it("1 · the earlier expiry is picked even when it was received later", () => {
    const r = fefoPick([batch("late", "2026-10-20", 5000, "2026-09-01T00:00:00.000Z"), batch("early", "2026-10-12", 5000, "2026-10-05T00:00:00.000Z")], [line("L1", 2000)], BD);
    expect(short(r)).toEqual([["L1", "early", 2000, null]]);
    expect(r.refusals).toEqual([]);
  });

  it("2 · same expiry → the earlier receipt first", () => {
    const r = fefoPick([batch("b2", "2026-10-15", 5000, "2026-10-03T00:00:00.000Z"), batch("b1", "2026-10-15", 5000, "2026-10-02T00:00:00.000Z")], [line("L1", 1000)], BD);
    expect(short(r)).toEqual([["L1", "b1", 1000, null]]);
  });

  it("3 · same expiry and receipt → batch id order (deterministic)", () => {
    const r = fefoPick([batch("zz", "2026-10-15", 5000), batch("aa", "2026-10-15", 5000)], [line("L1", 1000)], BD);
    expect(short(r)).toEqual([["L1", "aa", 1000, null]]);
  });

  it("4 · a batch with no expiry goes last", () => {
    const r = fefoPick([batch("none", null, 5000, "2026-01-01T00:00:00.000Z"), batch("dated", "2027-03-01", 5000)], [line("L1", 1000)], BD);
    expect(short(r)).toEqual([["L1", "dated", 1000, null]]);
  });

  it("5 · a line larger than the first batch spans the next by expiry", () => {
    const r = fefoPick([batch("c", "2026-11-01", 9000), batch("a", "2026-10-11", 3000), batch("b", "2026-10-20", 2000)], [line("L1", 6000)], BD);
    expect(short(r)).toEqual([["L1", "a", 3000, null], ["L1", "b", 2000, null], ["L1", "c", 1000, null]]);
  });

  it("6 · a batch expiring ON the business date is still sold (expired = before it)", () => {
    const r = fefoPick([batch("today", BD, 2000), batch("later", "2026-10-30", 2000)], [line("L1", 1000)], BD);
    expect(short(r)).toEqual([["L1", "today", 1000, null]]);
    expect(r.refusals).toEqual([]);
  });

  it("7 · expired stock on the shelf does not block a sale fresh stock covers", () => {
    const r = fefoPick([batch("old", "2026-10-09", 4000), batch("fresh", "2026-10-25", 3000)], [line("L1", 3000)], BD);
    expect(short(r)).toEqual([["L1", "fresh", 3000, null]]);
    expect(r.refusals).toEqual([]);
  });

  it("8 · fresh stock short and expired stock left → expired_batch (never negative instead)", () => {
    const r = fefoPick([batch("old", "2026-10-09", 4000), batch("fresh", "2026-10-25", 1000)], [line("L1", 3000)], BD);
    expect(r.refusals).toEqual([{ line_id: "L1", reason_code: "expired_batch", batch_id: "old" }]);
  });

  it("9 · an unused override of THIS line and batch covers the shortfall, up to its quantity", () => {
    const r = fefoPick([batch("old", "2026-10-09", 4000), batch("fresh", "2026-10-25", 1000)], [line("L1", 3000)], BD,
      [{ override_id: "ov1", line_id: "L1", batch_id: "old", qty_milli: 2000 }]);
    expect(short(r)).toEqual([["L1", "fresh", 1000, null], ["L1", "old", 2000, "ov1"]]);
    expect(r.refusals).toEqual([]);
    // The same override with too small a quantity still refuses.
    const small = fefoPick([batch("old", "2026-10-09", 4000), batch("fresh", "2026-10-25", 1000)], [line("L1", 3000)], BD,
      [{ override_id: "ov1", line_id: "L1", batch_id: "old", qty_milli: 1000 }]);
    expect(small.refusals).toEqual([{ line_id: "L1", reason_code: "expired_batch", batch_id: "old" }]);
  });

  it("10 · an override bound to another cart line does not apply", () => {
    const r = fefoPick([batch("old", "2026-10-09", 4000)], [line("L1", 1000)], BD, [{ override_id: "ov1", line_id: "L2", batch_id: "old", qty_milli: 1000 }]);
    expect(r.picks).toEqual([]);
    expect(r.refusals).toEqual([{ line_id: "L1", reason_code: "expired_batch", batch_id: "old" }]);
  });

  it("11 · two lines of one ingredient share the stock: the second line starts where the first stopped", () => {
    const r = fefoPick([batch("a", "2026-10-12", 2000), batch("b", "2026-10-14", 5000)], [line("L1", 2000), line("L2", 1500)], BD);
    expect(short(r)).toEqual([["L1", "a", 2000, null], ["L2", "b", 1500, null]]);
  });

  it("12 · no stock at all → the line is an unbatched draw (on-hand goes negative; the alert path)", () => {
    const r = fefoPick([batch("other", "2026-10-20", 9000, undefined, "ing-b")], [line("L1", 1000)], BD);
    expect(short(r)).toEqual([["L1", null, 1000, null]]);
    expect(r.refusals).toEqual([]);
  });

  it("13 · recipe consumption (expired_blocks false): fresh stock, then unbatched — never refused", () => {
    const r = fefoPick([batch("old", "2026-10-01", 9000), batch("fresh", "2026-10-15", 1000)], [line("recipe:a", 2500, { expired_blocks: false })], BD);
    expect(short(r)).toEqual([["recipe:a", "fresh", 1000, null], ["recipe:a", null, 1500, null]]);
    expect(r.refusals).toEqual([]);
  });
});

describe("binding MRP (W1 ruling #61)", () => {
  it("the lowest printed MRP among the picked batches binds, below the item's", () => expect(bindingMrp(5000, [4500, 4800])).toBe(4500));
  it("a picked batch without a printed MRP stands in with the item's", () => expect(bindingMrp(5000, [null])).toBe(5000));
  it("a mix: the batch MRP still binds when it is lower", () => expect(bindingMrp(5000, [null, 4700])).toBe(4700));
  it("no batch picked → the item's MRP", () => expect(bindingMrp(3000, [])).toBe(3000));
  it("no MRP anywhere → none applies", () => expect(bindingMrp(null, [null])).toBe(null));
});
