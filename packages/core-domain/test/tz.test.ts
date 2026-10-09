import { describe, expect, it } from "vitest";
import expected from "./goldens/dst.expected.json" with { type: "json" };
import { businessDate, dayBounds, localDate, localToInstant, slots } from "../tz/index.ts";

describe("tz: DST suite (Australia/Melbourne 2026-04-05 and 2026-10-04; Asia/Kolkata control)", () => {
  it(`business dates with an outlet cutoff: ${expected.business_date.length} instants`, () => {
    expect(expected.business_date.length).toBe(23);
    for (const c of expected.business_date)
      expect(`${c.tz} ${c.instant} cutoff ${c.cutoff} → ${businessDate(c.instant, c.tz, c.cutoff)}`).toBe(`${c.tz} ${c.instant} cutoff ${c.cutoff} → ${c.date}`);
  });

  it("the default cutoff is 04:00", () => {
    const at4 = expected.business_date.filter((c) => c.cutoff === "04:00");
    expect(at4.length).toBe(10);
    for (const c of at4) expect(businessDate(c.instant, c.tz)).toBe(c.date);
  });

  it("local (calendar) date ignores the cutoff", () => {
    expect(expected.local_date.length).toBe(2);
    for (const c of expected.local_date) expect(localDate(c.instant, c.tz)).toBe(c.date);
  });

  it("business-day boundaries: transition days are 23 h / 25 h, the 04:00 cutoff moves which day holds them", () => {
    for (const c of expected.day_bounds) {
      const b = dayBounds(c.date, c.tz, c.cutoff);
      expect({ start: b.start.toISOString(), end: b.end.toISOString() }).toEqual({ start: c.start, end: c.end });
      expect((b.end.getTime() - b.start.getTime()) / 3_600_000).toBe(c.hours);
    }
    expect(expected.day_bounds.map((c) => c.hours)).toEqual([23, 25, 24, 24, 24, 23, 24, 25, 24]);
    expect(dayBounds("2026-10-04", "Australia/Melbourne").start.toISOString()).toBe("2026-10-03T17:00:00.000Z");
  });

  it("local wall time → instant (gap resolves forward, overlap to the earlier instant)", () => {
    expect(expected.local_to_instant.length).toBe(6);
    for (const c of expected.local_to_instant) expect(`${c.case}: ${localToInstant(c.date, c.time, c.tz).toISOString()}`).toBe(`${c.case}: ${c.instant}`);
  });

  it("slots are equal real durations across a transition", () => {
    for (const c of expected.slots) {
      const s = slots(c.date, c.from, c.to, c.minutes, c.tz);
      expect(s.map((x) => x.starts_at)).toEqual(c.starts);
      for (const x of s) expect(Date.parse(x.ends_at) - Date.parse(x.starts_at)).toBe(c.minutes * 60_000);
    }
    expect(expected.slots.map((c) => c.starts.length)).toEqual([4, 8, 6]);
    expect(() => slots("2026-10-04", "04:00", "01:00", 30, "Asia/Kolkata")).toThrow();
  });
});
