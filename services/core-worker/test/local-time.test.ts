// DST suite for the local-time jobs (the project's verification: both transitions, IN + AU). Walks consecutive
// 15-minute slot windows (the cron's tiling) across each transition and counts firings per date.
// Melbourne 2026: clocks go back 03:00 → 02:00 on 5 Apr (02:00–02:59 happens twice) and forward
// 02:00 → 03:00 on 4 Oct (02:00–02:59 never happens). Kolkata has no DST (control).
// Nightly = an outlet's close of day: it fires at the outlet's business-day cutoff (ruling #60, default
// 04:00) for the business date that just closed. The brief fires at 06:00 in the tenant's home zone.
import { describe, expect, it } from "vitest";
import { localDate, localTime } from "@munim/core-domain/tz";
import { dueInWindow, nightDue } from "../src/local-time.ts";

const STEP = 15 * 60_000;
function walk(fromUtc: string, toUtc: string, fire: (slot: { prev: Date; at: Date }) => string | null): string[] {
  const out: string[] = [];
  for (let t = Date.parse(fromUtc); t < Date.parse(toUtc); t += STEP) {
    const r = fire({ prev: new Date(t), at: new Date(t + STEP) });
    if (r) out.push(r);
  }
  return out;
}
const at = (d: Date, tz: string) => `${localDate(d, tz)} ${localTime(d, tz)}`;

describe("nightly: once per outlet business date, at its cutoff, for the date that closed", () => {
  const cases: Array<[string, string, string, string, string, string[]]> = [
    // tz, cutoff, window (UTC), label, expected "fired at local → closed business date"
    ["Australia/Melbourne", "04:00", "2026-04-03T12:00:00Z", "2026-04-06T12:00:00Z", "default cutoff, fall back (5 Apr)",
      ["2026-04-04 04:00 → 2026-04-03", "2026-04-05 04:00 → 2026-04-04", "2026-04-06 04:00 → 2026-04-05"]],
    ["Australia/Melbourne", "04:00", "2026-10-02T12:00:00Z", "2026-10-05T12:00:00Z", "default cutoff, spring forward (4 Oct)",
      ["2026-10-03 04:00 → 2026-10-02", "2026-10-04 04:00 → 2026-10-03", "2026-10-05 04:00 → 2026-10-04"]],
    ["Australia/Melbourne", "02:00", "2026-04-03T12:00:00Z", "2026-04-06T12:00:00Z", "02:00 cutoff, fall back (02:00 twice → earlier)",
      ["2026-04-04 02:00 → 2026-04-03", "2026-04-05 02:00 → 2026-04-04", "2026-04-06 02:00 → 2026-04-05"]],
    ["Australia/Melbourne", "02:00", "2026-10-02T12:00:00Z", "2026-10-05T12:00:00Z", "02:00 cutoff, spring forward (02:00 absent → 03:00)",
      ["2026-10-03 02:00 → 2026-10-02", "2026-10-04 03:00 → 2026-10-03", "2026-10-05 02:00 → 2026-10-04"]],
    ["Asia/Kolkata", "04:00", "2026-10-02T12:00:00Z", "2026-10-05T12:00:00Z", "default cutoff, control (+05:30)",
      ["2026-10-03 04:00 → 2026-10-02", "2026-10-04 04:00 → 2026-10-03", "2026-10-05 04:00 → 2026-10-04"]],
  ];
  for (const [tz, cutoff, from, to, label, expected] of cases) {
    it(`${tz} ${label}`, () => {
      const got = walk(from, to, (slot) => {
        const n = nightDue({ outlet_id: "o", tz, cutoff }, slot);
        return n ? `${at(dueInWindow(tz, cutoff, slot)!, tz)} → ${n.business_date}` : null;
      });
      console.log(`nightly ${tz} cutoff ${cutoff}: ${got.join(" | ")}`);
      expect(got).toEqual(expected);
    });
  }
});

describe("brief: once per home-zone date at 06:00", () => {
  const cases: Array<[string, string, string, string[]]> = [
    ["Australia/Melbourne", "2026-04-03T12:00:00Z", "2026-04-06T12:00:00Z", ["2026-04-04 06:00", "2026-04-05 06:00", "2026-04-06 06:00"]],
    ["Australia/Melbourne", "2026-10-02T12:00:00Z", "2026-10-05T12:00:00Z", ["2026-10-03 06:00", "2026-10-04 06:00", "2026-10-05 06:00"]],
    ["Asia/Kolkata", "2026-04-03T12:00:00Z", "2026-04-06T12:00:00Z", ["2026-04-04 06:00", "2026-04-05 06:00", "2026-04-06 06:00"]],
  ];
  for (const [tz, from, to, expected] of cases) {
    it(`${tz} ${from.slice(0, 10)}…${to.slice(0, 10)}`, () => {
      const got = walk(from, to, (slot) => {
        const due = dueInWindow(tz, "06:00", slot);
        return due ? at(due, tz) : null;
      });
      console.log(`brief ${tz}: ${got.join(" | ")}`);
      expect(got).toEqual(expected);
    });
  }

  it("windows wider than one period (a skipped boundary) still fire once", () => {
    const tz = "Asia/Kolkata";
    // 05:45 → 06:30 local in one window (the 06:00 and 06:15 boundaries were skipped).
    expect(dueInWindow(tz, "06:00", { prev: new Date("2026-10-10T00:15:00Z"), at: new Date("2026-10-10T01:00:00Z") })).not.toBeNull();
    expect(dueInWindow(tz, "06:00", { prev: new Date("2026-10-10T01:00:00Z"), at: new Date("2026-10-10T01:15:00Z") })).toBeNull();
  });
});
