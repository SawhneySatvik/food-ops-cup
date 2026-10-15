// Pickup windows: 30-minute slots from 08:00 to 21:00 outlet time, today and tomorrow. Ids and the seeded
// bookings are derived from the outlet and the slot start, so every instance agrees; orders placed into a window
// add to an in-memory count (per server instance, like the Munim mock).
import { createHash } from "node:crypto";
import { OPEN_FROM_MIN, OPEN_TO_MIN, PREP_MIN, TZ_OFFSET_MIN, WINDOW_CAPACITY, id7 } from "./data";

export interface Window {
  pickup_window_id: string;
  starts_at: string;
  ends_at: string;
  capacity_orders: number;
  booked: number;
}

const placedInto = new Map<string, number>();

/** Seeded part-bookings: most slots empty, some nearly full, the odd one already full. */
function seeded(key: string): number {
  const n = parseInt(createHash("sha256").update(key).digest("hex").slice(0, 4), 16) % 10;
  return n < 5 ? 0 : n < 7 ? 2 : n < 9 ? 5 : 6;
}

/** Every slot of today and tomorrow (outlet time), full or not, past or not. */
function allSlots(outletId: string, now: Date): Window[] {
  const localMidnight = new Date(now.getTime() + TZ_OFFSET_MIN * 60_000);
  localMidnight.setUTCHours(0, 0, 0, 0);
  const out: Window[] = [];
  for (let day = 0; day < 2; day++) {
    for (let m = OPEN_FROM_MIN; m < OPEN_TO_MIN; m += 30) {
      const start = new Date(localMidnight.getTime() + (day * 1440 + m - TZ_OFFSET_MIN) * 60_000);
      const key = `${outletId}:${start.toISOString()}`;
      const id = id7(`window:${key}`);
      out.push({
        pickup_window_id: id,
        starts_at: start.toISOString(),
        ends_at: new Date(start.getTime() + 30 * 60_000).toISOString(),
        capacity_orders: WINDOW_CAPACITY,
        booked: Math.min(WINDOW_CAPACITY, seeded(key) + (placedInto.get(id) ?? 0)),
      });
    }
  }
  return out;
}

/** Windows a shopper can still pick: starting after the prep time, with spare capacity, at most 24. */
export function openWindows(outletId: string, now: Date): Window[] {
  const earliest = now.getTime() + PREP_MIN * 60_000;
  return allSlots(outletId, now)
    .filter((w) => new Date(w.starts_at).getTime() >= earliest && w.booked < w.capacity_orders)
    .slice(0, 24);
}

/** A window by id (full ones included, so a stale choice can be refused as window_full). */
export function findWindow(outletId: string, windowId: string, now: Date): Window | null {
  const w = allSlots(outletId, now).find((x) => x.pickup_window_id === windowId);
  if (!w || new Date(w.starts_at).getTime() < now.getTime()) return null;
  return w;
}

export function book(windowId: string): void {
  placedInto.set(windowId, (placedInto.get(windowId) ?? 0) + 1);
}
