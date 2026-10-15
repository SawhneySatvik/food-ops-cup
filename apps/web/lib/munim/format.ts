// lib/munim/format.ts: from 01-api-client.md
// Display-only formatting with Intl. Every input is a field from an API response; nothing here is sent back to the
// API, and nothing here adds money up.

export function formatMoney(minor: number, currency: string, locale: string): string {
  const nf = new Intl.NumberFormat(locale, { style: "currency", currency });
  const digits = nf.resolvedOptions().maximumFractionDigits ?? 2;
  return nf.format(minor / 10 ** digits); // shifts the decimal point for display; never send this back
}

/** qty_milli 1000 -> "1", 500 -> "0.5". */
export const formatQty = (milli: number, locale: string): string =>
  new Intl.NumberFormat(locale, { maximumFractionDigits: 3 }).format(milli / 1000);

/** rate_bp 250 -> "2.5%", 1000 -> "10%". */
export const formatRate = (bp: number, locale: string): string =>
  new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 2 }).format(bp / 10_000);

export const formatTime = (iso: string, tz: string, locale: string): string =>
  new Intl.DateTimeFormat(locale, { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(iso));

/** A wall-clock "HH:MM" (an outlet's pickup hours) in the same style as formatTime, with no date or zone involved. */
export const formatClock = (hhmm: string, locale: string): string =>
  new Intl.DateTimeFormat(locale, { timeZone: "UTC", hour: "numeric", minute: "2-digit" }).format(new Date(`1970-01-01T${hhmm}:00Z`));

export const formatDayTime =(iso: string, tz: string, locale: string): string =>
  new Intl.DateTimeFormat(locale, { timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(iso));

/** A plain date ("2026-10-14", e.g. expires_on) without shifting it through a time zone. */
export const formatDate = (isoDate: string, locale: string): string =>
  new Intl.DateTimeFormat(locale, { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" }).format(new Date(`${isoDate}T00:00:00Z`));

/** The calendar date of an instant in a zone, "YYYY-MM-DD". */
export function dayKey(at: Date | string, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(at));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** "Today", "Tomorrow" or "Wednesday 14 Oct", judged in the outlet's zone (not the browser's). */
export function dayLabel(iso: string, tz: string, locale: string, now: Date = new Date()): string {
  const today = dayKey(now, tz);
  const [y, m, d] = today.split("-").map(Number);
  const tomorrow = new Date(Date.UTC(y!, m! - 1, d! + 1)).toISOString().slice(0, 10); // calendar arithmetic, DST-safe
  const key = dayKey(iso, tz);
  if (key === today) return "Today";
  if (key === tomorrow) return "Tomorrow";
  return new Intl.DateTimeFormat(locale, { timeZone: tz, weekday: "long", day: "numeric", month: "short" }).format(new Date(iso));
}

/** A time today ("10:00 am") or, on another day, with the day ("Wed 14 Oct, 10:00 am"). */
export const formatWhen = (iso: string, tz: string, locale: string, now: Date = new Date()): string =>
  dayKey(iso, tz) === dayKey(now, tz) ? formatTime(iso, tz, locale) : formatDayTime(iso, tz, locale);

/** Deal windows: ISO weekdays (1 = Monday) -> "Mon–Fri", "Every day" or "Mon, Wed". */
export function formatDays(days: number[], locale: string): string {
  const name = (d: number) => new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "short" }).format(new Date(Date.UTC(2024, 0, d))); // 1 Jan 2024 was a Monday
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  if (sorted.length === 7) return "Every day";
  const run = sorted.length > 2 && sorted.every((d, i) => i === 0 || d === sorted[i - 1]! + 1);
  return run ? `${name(sorted[0]!)}–${name(sorted[sorted.length - 1]!)}` : sorted.map(name).join(", ");
}

/** "item.paneer_tikka" -> "Paneer tikka". Fallback label when display_name is null. */
export const titleCase = (key: string): string =>
  key.replace(/^(item|variant|group|option|deal|category)\./, "").replace(/^[a-z0-9_]+\./, "").replaceAll(/[._]+/g, " ").replace(/^./, (c) => c.toUpperCase());

/** The owner's display name (plain text; render as text, never HTML), else a label for name_key. */
export const shownName = (x: { display_name: string | null; name_key: string }): string => x.display_name ?? titleCase(x.name_key);
