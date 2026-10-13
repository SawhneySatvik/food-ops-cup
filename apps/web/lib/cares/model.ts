// Pure helpers for the Cares screen (docs/plan/screens/cares.md): no React, no fetch, no arithmetic on money or kg.
import type { Schemas } from "@munim/sdk";

export type Listing = Schemas["V1CaresListings"]["items"][number];
export type Profile = Schemas["V1CaresProfile"];
export type Recipient = Schemas["V1CaresRecipients"]["items"][number];
export type Batch = Schemas["V1InventoryBatches"]["batches"][number];

export type ListingBadge = "published" | "allocated" | "handed_over" | "closed" | "withdrawn";

/** The API has no "handed over" status: a closed listing with a recorded (not voided) hand-over is one. */
export function listingBadge(l: Pick<Listing, "status" | "handovers">): ListingBadge {
  if (l.status === "closed") return l.handovers.some((h) => h.status === "recorded") ? "handed_over" : "closed";
  return l.status;
}

/** Typed quantity → thousandths by string parsing (no float). null when it is not a positive amount with ≤ 3 decimals. */
export function parseMilli(input: string): number | null {
  const m = /^(\d{1,9})(?:\.(\d{0,3}))?$/.exec(input.trim());
  if (!m) return null;
  const milli = Number(m[1]) * 1000 + Number((m[2] ?? "").padEnd(3, "0"));
  return milli > 0 ? milli : null;
}

function offsetMs(utcMs: number, tz: string): number {
  const p: Record<string, number> = {};
  for (const { type, value } of new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(utcMs))) {
    if (type !== "literal") p[type] = Number(value);
  }
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - utcMs;
}

/** A wall-clock date + time in an IANA zone → the UTC instant as ISO. null when the inputs are malformed. */
export function zonedToIso(date: string, time: string, tz: string): string | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!d || !t) return null;
  const wallAsUtc = Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3]), Number(t[1]), Number(t[2]));
  let utc = wallAsUtc - offsetMs(wallAsUtc, tz);
  utc = wallAsUtc - offsetMs(utc, tz); // second pass lands on the right side of a DST change
  return new Date(utc).toISOString();
}

/** Today's business-calendar date in a zone, and the date `days` earlier (UTC date arithmetic on the string). */
export function dateIn(tz: string, now: Date, minusDays = 0): string {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now).split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! - minusDays)).toISOString().slice(0, 10);
}

/** `⟨snap:<id>·<row>·<col>⟩` → its parts, or null for anything else (a forged or malformed ref is "cannot verify"). */
export function parseRef(token: string): { snapshot_id: string; row: number; column: string } | null {
  const m = /^⟨snap:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})·(\d+)·([a-z][a-z0-9_]*)⟩$/.exec(token);
  return m ? { snapshot_id: m[1]!, row: Number(m[2]), column: m[3]! } : null;
}

/** Thousandths → a plain decimal for a text input default ("6000" → "6"), by string slicing; display uses the formatter. */
export function milliToInput(milli: number): string {
  const s = String(milli).padStart(4, "0");
  const frac = s.slice(-3).replace(/0+$/, "");
  return frac ? `${s.slice(0, -3)}.${frac}` : s.slice(0, -3);
}

/** No read returns a city's display name, so the code is title-cased: "bengaluru" → "Bengaluru", "new_delhi" → "New Delhi". */
export const cityName = (code: string): string => code.split("_").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
