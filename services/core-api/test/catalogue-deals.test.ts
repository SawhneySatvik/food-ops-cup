// T-021 gate: the deal-window matrix — 12 hand-written cases, judged at the promised instant in the outlet's
// zone by local wall-clock time. Includes a window that crosses midnight (Fri/Sat 22:00–02:00) and both
// Melbourne DST days of 2026 (spring forward Sun 4 Oct 02:00 AEST → 03:00 AEDT; fall back Sun 5 Apr 03:00 AEDT
// → 02:00 AEST). Each expected value is worked out by hand from the UTC instant and the zone's offset on that
// date (IST is +05:30 all year; AEST +10, AEDT +11), never by calling the code under test.
import type { DealWindow } from "@munim/contracts/catalogue";
import { describe, expect, it } from "vitest";
import { dealOpen, inWindows, type DealRow } from "../src/modules/catalogue/deals.ts";

const IST = "Asia/Kolkata";
const MEL = "Australia/Melbourne";
const TEA: DealWindow = { days: [1, 2, 3, 4, 5], from: "15:00", to: "18:00" }; // weekdays
const LATE: DealWindow = { days: [5, 6], from: "22:00", to: "02:00" }; // Fri and Sat nights, into the next morning
const EARLY_SUN: DealWindow = { days: [7], from: "01:00", to: "03:30" };

const MATRIX: Array<[string, DealWindow, string, string, boolean]> = [
  ["Wed 14 Oct 15:00 IST — tea opens (from is inclusive)", TEA, "2026-10-14T09:30:00Z", IST, true],
  ["Wed 14 Oct 17:59 IST — last minute of tea", TEA, "2026-10-14T12:29:00Z", IST, true],
  ["Wed 14 Oct 18:00 IST — tea closed (to is exclusive)", TEA, "2026-10-14T12:30:00Z", IST, false],
  ["Sat 17 Oct 15:30 IST — Saturday is not a tea day", TEA, "2026-10-17T10:00:00Z", IST, false],
  ["Fri 16 Oct 23:30 IST — late window opened Friday", LATE, "2026-10-16T18:00:00Z", IST, true],
  ["Sat 17 Oct 01:30 IST — after midnight, Friday's window still open", LATE, "2026-10-16T20:00:00Z", IST, true],
  ["Sat 17 Oct 02:00 IST — Friday's window closed (to is exclusive)", LATE, "2026-10-16T20:30:00Z", IST, false],
  ["Sun 18 Oct 01:30 IST — Saturday's window crossed into Sunday", LATE, "2026-10-17T20:00:00Z", IST, true],
  ["Mon 19 Oct 01:30 IST — Sunday opened no window", LATE, "2026-10-18T20:00:00Z", IST, false],
  ["Melbourne spring-forward Sun 4 Oct 01:59 AEST — inside", EARLY_SUN, "2026-10-03T15:59:00Z", MEL, true],
  ["Melbourne spring-forward Sun 4 Oct 03:45 AEDT — past 03:30 (a fixed +10 offset would say 02:45, inside)", EARLY_SUN, "2026-10-03T16:45:00Z", MEL, false],
  ["Melbourne fall-back Sun 5 Apr 02:45 AEST — inside (a fixed +11 offset would say 03:45, outside)", EARLY_SUN, "2026-04-04T16:45:00Z", MEL, true],
];

describe("deal-window matrix (12 committed cases)", () => {
  it("has exactly 12 cases, 7 inside and 5 outside", () => {
    expect(MATRIX.length).toBe(12);
    expect(MATRIX.filter((m) => m[4]).length).toBe(7);
  });
  it.each(MATRIX)("%s", (_name, w, at, tz, expected) => {
    expect(inWindows([w], at, tz)).toBe(expected);
  });
});

describe("deal validity around the window", () => {
  const deal = (o: Partial<DealRow> = {}): DealRow => ({
    id: "d", rule: { kind: "percent_off", bp: 1000, item_ids: [] }, windows: [TEA], outlet_ids: [], valid_from: "2026-10-01", valid_to: "2026-10-15", active: true, ...o,
  });
  const wedTea = "2026-10-14T10:00:00Z"; // Wed 15:30 IST, business date 2026-10-14
  it("no windows = any time while valid; inactive, out-of-outlet or ended deals never apply", () => {
    expect(inWindows([], "2026-10-17T10:00:00Z", IST)).toBe(true);
    expect(dealOpen(deal(), "o1", wedTea, IST, "2026-10-14")).toBe(true);
    expect(dealOpen(deal({ active: false }), "o1", wedTea, IST, "2026-10-14")).toBe(false);
    expect(dealOpen(deal({ outlet_ids: ["o2"] }), "o1", wedTea, IST, "2026-10-14")).toBe(false);
    expect(dealOpen(deal({ outlet_ids: ["o1"] }), "o1", wedTea, IST, "2026-10-14")).toBe(true);
    expect(dealOpen(deal({ valid_to: "2026-10-14" }), "o1", wedTea, IST, "2026-10-14")).toBe(false); // valid_to is exclusive
    expect(dealOpen(deal({ valid_from: "2026-10-15", valid_to: null }), "o1", wedTea, IST, "2026-10-14")).toBe(false);
  });
});
