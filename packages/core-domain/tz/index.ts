// The one tz module (project gotcha 14). Built on Intl only: Node 22 ships no Temporal (`typeof Temporal`
// is "undefined" on the pinned runtime), and Intl reads the ICU tz database bundled with Node, so there is
// no second date library to disagree with it. Zones are IANA names from the outlet / pack.
//
// Wall-clock → instant resolution (the only ambiguous direction):
//   • a local time inside a spring-forward gap resolves forward by the gap (02:30 → 03:30);
//   • a local time inside a fall-back overlap resolves to the earlier instant.

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MIN = 60_000;

const formatters = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

type Parts = { year: number; month: number; day: number; hour: number; minute: number; second: number };

function parts(instant: Date, tz: string): Parts {
  const p: Record<string, number> = {};
  for (const { type, value } of fmt(tz).formatToParts(instant)) if (type !== "literal") p[type] = Number(value);
  return { year: p.year!, month: p.month!, day: p.day!, hour: p.hour!, minute: p.minute!, second: p.second! };
}

/** UTC offset of `tz` at `instant`, in minutes (seconds are dropped; no modern zone uses them). */
function offsetMinutes(instant: Date, tz: string): number {
  const p = parts(instant, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / MIN);
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

function toInstant(instant: Date | string): Date {
  const d = typeof instant === "string" ? new Date(instant) : instant;
  if (Number.isNaN(d.getTime())) throw new Error(`tz: invalid instant ${String(instant)}`);
  return d;
}

/** Outlet-local calendar date (YYYY-MM-DD) of an instant — e.g. an invoice date. */
export function localDate(instant: Date | string, tz: string): string {
  const p = parts(toInstant(instant), tz);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

/** Default outlet business-day cutoff (W1 ruling #60): sales before 04:00 local belong to the day before. */
export const DEFAULT_BUSINESS_DAY_CUTOFF = "04:00";

function cutoffMinutes(cutoff: string): number {
  const t = TIME.exec(cutoff);
  if (!t) throw new Error(`tz: bad cutoff ${cutoff}`);
  return Number(t[1]) * 60 + Number(t[2]);
}

/** Business date: the local date of (local wall time − cutoff). Wall-clock arithmetic, the same as
 *  Postgres `((ts AT TIME ZONE tz) - cutoff)::date` — an hour after a spring-forward is still that day. */
export function businessDate(instant: Date | string, tz: string, cutoff: string = DEFAULT_BUSINESS_DAY_CUTOFF): string {
  const p = parts(toInstant(instant), tz);
  const shifted = new Date(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - cutoffMinutes(cutoff) * MIN);
  return `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** Outlet-local wall time (HH:mm) of an instant. */
export function localTime(instant: Date | string, tz: string): string {
  const p = parts(toInstant(instant), tz);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** The instant a local date + wall time names in `tz` (gap → forward, overlap → earlier). */
export function localToInstant(date: string, time: string, tz: string): Date {
  const d = DATE.exec(date);
  const t = TIME.exec(time);
  if (!d || !t) throw new Error(`tz: bad local date/time ${date} ${time}`);
  const wall = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
  // The offsets in force a day either side bracket any transition near this wall time.
  const before = offsetMinutes(new Date(wall - 86_400_000), tz);
  const after = offsetMinutes(new Date(wall + 86_400_000), tz);
  const hits = [...new Set([before, after])]
    .map((off) => wall - off * MIN)
    .filter((ms) => {
      const p = parts(new Date(ms), tz);
      return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) === wall;
    })
    .sort((a, b) => a - b);
  // No hit: the wall time is in a gap; reading it with the pre-transition offset moves it forward.
  return new Date(hits[0] ?? wall - before * MIN);
}

function nextDate(date: string): string {
  const d = DATE.exec(date);
  if (!d) throw new Error(`tz: bad date ${date}`);
  const n = new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]) + 1));
  return `${pad(n.getUTCFullYear(), 4)}-${pad(n.getUTCMonth() + 1)}-${pad(n.getUTCDate())}`;
}

/** [start, end) of a business date in `tz`: from `cutoff` local on `date` to `cutoff` local the next day —
 *  23 or 25 hours long when a DST transition falls inside. */
export function dayBounds(date: string, tz: string, cutoff: string = DEFAULT_BUSINESS_DAY_CUTOFF): { start: Date; end: Date } {
  cutoffMinutes(cutoff);
  return { start: localToInstant(date, cutoff, tz), end: localToInstant(nextDate(date), cutoff, tz) };
}

/** Back-to-back slots of `minutes` real minutes from local `from` to local `to` on `date`; a trailing
 *  partial slot is dropped. Real (not wall-clock) minutes, so every slot holds the same capacity even
 *  when a DST transition falls inside the range. */
export function slots(date: string, from: string, to: string, minutes: number, tz: string): Array<{ starts_at: string; ends_at: string }> {
  const start = localToInstant(date, from, tz).getTime();
  const end = localToInstant(date, to, tz).getTime();
  if (!(end > start) || !(minutes > 0)) throw new Error(`tz: empty slot range ${date} ${from}–${to}`);
  const out: Array<{ starts_at: string; ends_at: string }> = [];
  for (let s = start; s + minutes * MIN <= end; s += minutes * MIN)
    out.push({ starts_at: new Date(s).toISOString(), ends_at: new Date(s + minutes * MIN).toISOString() });
  return out;
}
