// All wall-clock work goes through core-domain's tz module (gotcha 14): outlet-local dates and times in, instants
// out. Calendar arithmetic uses Date.UTC and the getUTC* readers only, so the process TZ cannot leak in.
import { businessDate, DEFAULT_BUSINESS_DAY_CUTOFF, localDate, localToInstant } from "../../../packages/core-domain/tz/index.ts";

export { localDate };

/** Outlet-local "today" as the server counts it: the business date (a sale at 02:00 still belongs to the day before), with the outlet default
 *  cutoff (0014: 04:00). History must be dated strictly before the server's business date, so a seed run starting between 00:00 and the cutoff
 *  must not use the calendar date. */
export const businessToday = (now: Date, tz: string): string => businessDate(now, tz, DEFAULT_BUSINESS_DAY_CUTOFF);

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

/** First day of the calendar month before the one `date` falls in (`months` = 1), or before that (2). */
export function monthStartBefore(date: string, months = 1): string {
  const [y, m] = date.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 - months, 1)).toISOString().slice(0, 10);
}
