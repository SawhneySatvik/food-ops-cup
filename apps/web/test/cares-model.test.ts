// Cares pure helpers: no float on quantities, zone conversion across both DST transitions (IN has none, AU has two),
// refs that are forged or malformed never parse, and the "handed over" badge comes from a recorded hand-over only.
import { expect, test } from "vitest";
import { dateIn, listingBadge, milliToInput, parseMilli, parseRef, zonedToIso } from "../lib/cares/model.ts";

test("parseMilli reads decimals by string and refuses everything else", () => {
  expect(parseMilli("6")).toBe(6000);
  expect(parseMilli("2.5")).toBe(2500);
  expect(parseMilli("0.001")).toBe(1);
  expect(parseMilli("0")).toBeNull();
  expect(parseMilli("1.2345")).toBeNull();
  expect(parseMilli("-1")).toBeNull();
  expect(parseMilli("1e3")).toBeNull();
  expect(parseMilli("")).toBeNull();
  expect(milliToInput(6000)).toBe("6");
  expect(milliToInput(2500)).toBe("2.5");
  expect(milliToInput(1)).toBe("0.001");
});

test("zonedToIso: Asia/Kolkata is +05:30; Melbourne is +11 in summer, +10 in winter, and both DST days resolve", () => {
  expect(zonedToIso("2026-10-20", "15:00", "Asia/Kolkata")).toBe("2026-10-20T09:30:00.000Z");
  expect(zonedToIso("2026-01-15", "12:00", "Australia/Melbourne")).toBe("2026-01-15T01:00:00.000Z");
  expect(zonedToIso("2026-07-15", "12:00", "Australia/Melbourne")).toBe("2026-07-15T02:00:00.000Z");
  // Spring forward 4 Oct 2026 (02:00 AEST -> 03:00 AEDT): 12:00 that day is already +11.
  expect(zonedToIso("2026-10-04", "12:00", "Australia/Melbourne")).toBe("2026-10-04T01:00:00.000Z");
  // Fall back 5 Apr 2026 (03:00 AEDT -> 02:00 AEST): 12:00 that day is +10.
  expect(zonedToIso("2026-04-05", "12:00", "Australia/Melbourne")).toBe("2026-04-05T02:00:00.000Z");
  // Wall times just before each change, where a single offset lookup lands on the wrong side.
  expect(zonedToIso("2026-10-04", "01:30", "Australia/Melbourne")).toBe("2026-10-03T15:30:00.000Z");
  expect(zonedToIso("2026-04-05", "01:30", "Australia/Melbourne")).toBe("2026-04-04T14:30:00.000Z");
  expect(zonedToIso("", "", "Asia/Kolkata")).toBeNull();
});

test("dateIn gives the zone's own calendar date", () => {
  const instant = new Date("2026-10-13T20:00:00Z"); // 01:30 on the 14th in Kolkata
  expect(dateIn("Asia/Kolkata", instant)).toBe("2026-10-14");
  expect(dateIn("America/New_York", instant)).toBe("2026-10-13");
  expect(dateIn("Asia/Kolkata", instant, 30)).toBe("2026-09-14");
});

const ID = "01a134ca-4628-7da4-8557-d5f33fd1b49a";
test("parseRef accepts only a well-formed snapshot ref", () => {
  expect(parseRef(`⟨snap:${ID}·1·weight_g⟩`)).toEqual({ snapshot_id: ID, row: 1, column: "weight_g" });
  for (const bad of ["6000", `snap:${ID}·1·weight_g`, `⟨snap:${ID}·x·weight_g⟩`, `⟨snap:not-a-uuid·1·weight_g⟩`, `⟨snap:${ID}·1·weight_g⟩ extra`, `⟨snap:${ID}·1·Weight G⟩`]) expect(parseRef(bad)).toBeNull();
});

test("a recorded hand-over makes a closed listing 'handed over'; a voided one does not", () => {
  const h = (status: "recorded" | "voided") => ({ handover_id: "x", allocation_id: null, status, handed_at: "", recorded_by: "", voided_by: null, void_reason_code: null, lines: [] });
  expect(listingBadge({ status: "closed", handovers: [h("recorded")] })).toBe("handed_over");
  expect(listingBadge({ status: "closed", handovers: [h("voided")] })).toBe("closed");
  expect(listingBadge({ status: "published", handovers: [] })).toBe("published");
});

test("cityName title-cases a code", async () => {
  const { cityName } = await import("../lib/cares/model.ts");
  expect(cityName("bengaluru")).toBe("Bengaluru");
  expect(cityName("new_delhi")).toBe("New Delhi");
});
