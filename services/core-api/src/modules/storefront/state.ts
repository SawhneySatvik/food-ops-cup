// Effective accepting-orders state (R4 §E 2): the outlet's live toggle (open / busy +N / paused) on top of its
// weekly hours and dated overrides. Pure — rows and a clock in, a verdict out — so the hand fixtures in
// test/storefront-state.test.ts judge it without a database.
//
// Calendar reading (INFERENCE, tag for the log): `weekday` 0 = Sunday (Postgres `dow` / JS getDay); an outlet
// with NO calendar rows has no hours restriction; once it has any, a day without a row is closed; a dated
// override replaces that date's weekly row (closed = holiday, else its own hours); opens_at <= t < closes_at on
// one local date (overnight hours are not modelled — a row with closes_at <= opens_at never opens).
import { localDate, localTime, localToInstant } from "@munim/core-domain/tz";

export interface CalendarRow {
  kind: "weekly" | "override";
  weekday: number | null;
  on_date: string | null;
  opens_at: string | null;
  closes_at: string | null;
  closed: boolean;
}
export type Accepting = "open" | "busy" | "paused";
export type EffectiveState = "open" | "busy" | "paused" | "closed";

const hhmm = (t: string) => t.slice(0, 5);

const weekdayOf = (date: string) => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};
const addDays = (date: string, n: number) => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${String(t.getUTCFullYear()).padStart(4, "0")}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
};

/** The [opens, closes) local wall-time ranges that apply on a local date; [] = closed that day. */
export function hoursOn(calendar: readonly CalendarRow[], date: string): Array<{ opens: string; closes: string }> {
  if (calendar.length === 0) return [{ opens: "00:00", closes: "24:00" }];
  const override = calendar.filter((r) => r.kind === "override" && r.on_date === date);
  const rows = override.length > 0 ? override : calendar.filter((r) => r.kind === "weekly" && r.weekday === weekdayOf(date));
  return rows
    .filter((r) => !r.closed && r.opens_at !== null && r.closes_at !== null)
    .map((r) => ({ opens: hhmm(r.opens_at!), closes: hhmm(r.closes_at!) }))
    .filter((h) => h.closes > h.opens);
}

/** Do the weekly hours / overrides have the outlet open at this instant? (The live toggle is separate.) */
export function openByCalendar(calendar: readonly CalendarRow[], tz: string, at: Date): boolean {
  const date = localDate(at, tz);
  const t = localTime(at, tz);
  return hoursOn(calendar, date).some((h) => t >= h.opens && t < h.closes);
}

/** The first opening strictly after `at` within 14 local days, or null. */
export function nextOpening(calendar: readonly CalendarRow[], tz: string, at: Date): Date | null {
  const today = localDate(at, tz);
  for (let i = 0; i <= 14; i++) {
    const date = addDays(today, i);
    const starts = hoursOn(calendar, date)
      .map((h) => (h.opens === "00:00" && calendar.length === 0 ? null : localToInstant(date, h.opens, tz)))
      .filter((d): d is Date => d !== null && d.getTime() > at.getTime())
      .sort((a, b) => a.getTime() - b.getTime());
    if (starts[0]) return starts[0];
  }
  return null;
}

export interface Effective {
  state: EffectiveState;
  /** Paused by the live toggle has no resume time in the schema, so next_open is null there. */
  next_open: Date | null;
}

export function effectiveState(o: { accepting_orders: Accepting; calendar: readonly CalendarRow[]; tz: string; at: Date }): Effective {
  if (o.accepting_orders === "paused") return { state: "paused", next_open: null };
  if (!openByCalendar(o.calendar, o.tz, o.at)) return { state: "closed", next_open: nextOpening(o.calendar, o.tz, o.at) };
  return { state: o.accepting_orders, next_open: null };
}
