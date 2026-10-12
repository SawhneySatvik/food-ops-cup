// Local-time jobs (W1 fix rulings #60, #62). Outlet-level jobs run in each outlet's own zone; the tenant
// brief runs at the tenant's home zone (`tenant.home_tz`, default = first outlet's zone). The nightly
// close-of-day job runs at each outlet's business-day cutoff (`outlet.business_day_cutoff`, default 04:00)
// for the business date that just closed — at a fixed 02:00 it would run inside a still-open business day.
import type pg from "pg";
import { businessDate, localDate, localToInstant } from "@munim/core-domain/tz";
import type { Slot } from "./cron.ts";

/** The instant the local wall time `hhmm` in `tz` falls inside the slot window (prev, at], or null. Each
 *  local calendar date maps to one instant (DST gap → shifted forward, overlap → the earlier one: the tz
 *  module's rule), and consecutive windows do not overlap, so a job fires exactly once per local date. */
export function dueInWindow(tz: string, hhmm: string, slot: Slot): Date | null {
  for (const d of new Set([localDate(slot.prev, tz), localDate(slot.at, tz)])) {
    const due = localToInstant(d, hhmm, tz);
    if (due.getTime() > slot.prev.getTime() && due.getTime() <= slot.at.getTime()) return due;
  }
  return null;
}

export interface OutletClock {
  outlet_id: string;
  tz: string;
  /** HH:MM local. */
  cutoff: string;
}

export interface TenantClocks {
  /** null → the tenant has no outlet and no home zone yet: nothing local-time to run. */
  homeTz: string | null;
  outlets: OutletClock[];
}

/** Zones and cutoffs of one tenant, read under its RLS context (columns from 0014: `tenant.home_tz` is
 *  nullable → first outlet's zone; `outlet.business_day_cutoff` is NOT NULL DEFAULT '04:00'). */
export async function tenantClocks(pool: pg.Pool, tenantId: string): Promise<TenantClocks> {
  const c = await pool.connect();
  let failed: Error | undefined;
  try {
    await c.query("BEGIN");
    await c.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.outlet_ids', '{*}', true), set_config('app.role', 'service', true)",
      [tenantId]);
    const t = await c.query<{ home_tz: string | null }>(
      "SELECT home_tz FROM core.tenant WHERE tenant_id = $1", [tenantId]);
    const o = await c.query<{ id: string; tz: string; cutoff: string }>(
      "SELECT id, tz, to_char(business_day_cutoff, 'HH24:MI') AS cutoff FROM core.outlet ORDER BY created_at, id");
    await c.query("COMMIT");
    const outlets = o.rows.map((r) => ({ outlet_id: r.id, tz: r.tz, cutoff: r.cutoff }));
    return { homeTz: t.rows[0]?.home_tz ?? outlets[0]?.tz ?? null, outlets };
  } catch (e) {
    failed = e as Error;
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release(failed); // a failed client is destroyed, not handed to the next job (T-096)
  }
}

/** Tenants whose home-zone `hhmm` falls inside the slot window (the brief). */
export async function tenantsDueAt(pool: pg.Pool, tenants: string[], hhmm: string, slot: Slot): Promise<string[]> {
  const due: string[] = [];
  for (const t of tenants) {
    const { homeTz } = await tenantClocks(pool, t);
    if (homeTz && dueInWindow(homeTz, hhmm, slot)) due.push(t);
  }
  return due;
}

export interface OutletNight {
  tenant_id: string;
  outlet_id: string;
  /** The business date that closed at this outlet's cutoff. */
  business_date: string;
}

/** The close-of-day run of an outlet whose cutoff falls inside the slot window, or null. */
export function nightDue(o: OutletClock, slot: Slot): { business_date: string } | null {
  const due = dueInWindow(o.tz, o.cutoff, slot);
  return due ? { business_date: businessDate(new Date(due.getTime() - 1), o.tz, o.cutoff) } : null;
}

/** Every (tenant, outlet) whose business day closed inside the slot window. */
export async function outletNightsDue(pool: pg.Pool, tenants: string[], slot: Slot): Promise<OutletNight[]> {
  const due: OutletNight[] = [];
  for (const t of tenants) {
    for (const o of (await tenantClocks(pool, t)).outlets) {
      const n = nightDue(o, slot);
      if (n) due.push({ tenant_id: t, outlet_id: o.outlet_id, business_date: n.business_date });
    }
  }
  return due;
}
