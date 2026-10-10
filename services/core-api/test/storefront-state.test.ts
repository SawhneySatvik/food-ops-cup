// Accepting-orders state (R4 §E 2) against hand-written fixtures: weekly hours + dated override + live toggle.
// Outlet zone Asia/Kolkata (UTC+05:30, no DST). 2026-10-12 and 2026-10-26 are Mondays, 2026-10-20 a Tuesday.
import { describe, expect, it } from "vitest";
import { effectiveState, openByCalendar, type CalendarRow } from "../src/modules/storefront/state.ts";

const TZ = "Asia/Kolkata";
const weekly = (weekday: number, opens: string, closes: string): CalendarRow => ({ kind: "weekly", weekday, on_date: null, opens_at: opens, closes_at: closes, closed: false });
const CAL: CalendarRow[] = [
  weekly(1, "09:00:00", "22:00:00"), // Monday
  weekly(2, "09:00:00", "22:00:00"), // Tuesday
  { kind: "override", weekday: null, on_date: "2026-10-20", opens_at: null, closes_at: null, closed: true }, // holiday Tuesday
  { kind: "override", weekday: null, on_date: "2026-10-13", opens_at: "12:00:00", closes_at: "15:00:00", closed: false }, // short Tuesday
];
const at = (iso: string) => new Date(iso);

describe("effectiveState", () => {
  it("open inside weekly hours (Mon 13:00 IST = 07:30Z)", () => {
    expect(effectiveState({ accepting_orders: "open", calendar: CAL, tz: TZ, at: at("2026-10-12T07:30:00Z") })).toEqual({ state: "open", next_open: null });
  });
  it("busy toggle inside hours stays busy", () => {
    expect(effectiveState({ accepting_orders: "busy", calendar: CAL, tz: TZ, at: at("2026-10-12T07:30:00Z") }).state).toBe("busy");
  });
  it("paused toggle wins, with no resume time", () => {
    expect(effectiveState({ accepting_orders: "paused", calendar: CAL, tz: TZ, at: at("2026-10-12T07:30:00Z") })).toEqual({ state: "paused", next_open: null });
  });
  it("closed after hours: next opening is Tuesday's override hours 12:00 IST = 06:30Z, not the weekly 09:00", () => {
    const e = effectiveState({ accepting_orders: "open", calendar: CAL, tz: TZ, at: at("2026-10-12T17:30:00Z") }); // Mon 23:00 IST
    expect(e.state).toBe("closed");
    expect(e.next_open?.toISOString()).toBe("2026-10-13T06:30:00.000Z");
  });
  it("closed before opening the same day: next opening Mon 09:00 IST = 03:30Z", () => {
    const e = effectiveState({ accepting_orders: "open", calendar: CAL, tz: TZ, at: at("2026-10-12T02:30:00Z") }); // Mon 08:00 IST
    expect(e).toEqual({ state: "closed", next_open: new Date("2026-10-12T03:30:00Z") });
  });
  it("a holiday override closes the whole day; days with no row are closed; next opening is the following Monday", () => {
    expect(openByCalendar(CAL, TZ, at("2026-10-20T07:30:00Z"))).toBe(false); // Tue 20th 13:00, holiday
    expect(openByCalendar(CAL, TZ, at("2026-10-21T07:30:00Z"))).toBe(false); // Wed, no row
    const e = effectiveState({ accepting_orders: "open", calendar: CAL, tz: TZ, at: at("2026-10-20T07:30:00Z") });
    expect(e.next_open?.toISOString()).toBe("2026-10-26T03:30:00.000Z");
  });
  it("opens_at is inclusive, closes_at exclusive", () => {
    expect(openByCalendar(CAL, TZ, at("2026-10-12T03:30:00Z"))).toBe(true); // 09:00 IST
    expect(openByCalendar(CAL, TZ, at("2026-10-12T16:30:00Z"))).toBe(false); // 22:00 IST
  });
  it("no calendar rows at all means no hours restriction", () => {
    expect(effectiveState({ accepting_orders: "open", calendar: [], tz: TZ, at: at("2026-10-10T20:00:00Z") })).toEqual({ state: "open", next_open: null });
  });
});
