// All wall-clock work goes through core-domain's tz module (gotcha 14): outlet-local dates and times in, instants
// out. Calendar arithmetic uses Date.UTC and the getUTC* readers only, so the process TZ cannot leak in.
import { localDate, localToInstant } from "../../../packages/core-domain/tz/index.ts";

export { localDate };

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** ISO weekday of a calendar date, 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay() || 7;
}

/** The Monday on or before `date`. */
export const mondayOf = (date: string): string => addDays(date, 1 - isoWeekday(date));

/** The instant `HH:mm` on outlet-local `date` names in `tz`, as an ISO-8601 string. */
export const at = (date: string, hhmm: string, tz: string): string => localToInstant(date, hhmm, tz).toISOString();

/** `at` plus whole minutes (real minutes, so a DST night adds the real elapsed time). */
export const atPlus = (date: string, hhmm: string, minutes: number, tz: string): string =>
  new Date(localToInstant(date, hhmm, tz).getTime() + minutes * 60_000).toISOString();

/** Whole days from `a` to `b` (positive when b is later). */
export function daysBetween(a: string, b: string): number {
  const ms = (d: string) => Date.UTC(...(d.split("-").map(Number) as [number, number, number]).map((x, i) => (i === 1 ? x - 1 : x)) as [number, number, number]);
  return Math.round((ms(b) - ms(a)) / 86_400_000);
}
