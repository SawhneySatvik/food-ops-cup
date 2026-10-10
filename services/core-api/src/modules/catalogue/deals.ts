// Deal judgement (02-schema §2.3, project rule 9): a deal is judged at the PROMISED time, in the outlet's IANA
// zone, by local wall-clock time — so a window keeps its local hours across a DST change (on Melbourne's
// spring-forward day, 03:00 local is one real hour after 01:59). Pure; callers pass the outlet's zone.
// Validity dates are compared with the outlet's business date of that instant (as prices and recipes are).
import type { DealRule, DealWindow } from "@munim/contracts/catalogue";
import { localDate, localTime } from "@munim/core-domain/tz";
import { mulDiv } from "@munim/core-domain/money";

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** ISO weekday (1 = Monday … 7 = Sunday) of a calendar date. */
function isoWeekday(date: string): number {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

/** Whether `at` falls inside any window (no windows = any time). A window whose `to` is at or before its
 *  `from` opens on a listed day and closes on the following day. `from` inclusive, `to` exclusive. */
export function inWindows(windows: readonly DealWindow[], at: Date | string, tz: string): boolean {
  if (windows.length === 0) return true;
  const day = isoWeekday(localDate(at, tz));
  const prev = day === 1 ? 7 : day - 1;
  const t = minutes(localTime(at, tz));
  return windows.some((w) => {
    const from = minutes(w.from);
    const to = minutes(w.to);
    if (from < to) return w.days.includes(day) && t >= from && t < to;
    return (w.days.includes(day) && t >= from) || (w.days.includes(prev) && t < to);
  });
}

export type DealRow = {
  id: string;
  rule: DealRule;
  windows: DealWindow[];
  outlet_ids: string[];
  valid_from: string;
  valid_to: string | null;
  active: boolean;
};

/** A deal applies at an outlet at an instant: active, inside its validity (business date), outlet scope and a window. */
export function dealOpen(deal: DealRow, outlet_id: string, at: Date | string, tz: string, business_date: string): boolean {
  return deal.active
    && deal.valid_from <= business_date && (deal.valid_to === null || business_date < deal.valid_to)
    && (deal.outlet_ids.length === 0 || deal.outlet_ids.includes(outlet_id))
    && inWindows(deal.windows, at, tz);
}

/** The discount a deal gives one line (0 when the item is not eligible). `amount` = qty × unit price incl.
 *  options, before any discount; never exceeded. */
export function dealDiscount(rule: DealRule, line: { item_id: string; qty_milli: number; unit_minor: number; amount_minor: number }): number {
  if (rule.item_ids.length > 0 && !rule.item_ids.includes(line.item_id)) return 0;
  let d: number;
  switch (rule.kind) {
    case "percent_off":
      d = mulDiv(line.amount_minor, rule.bp, 10000);
      break;
    case "amount_off":
      d = mulDiv(line.qty_milli, rule.amount_minor, 1000);
      break;
    case "buy_x_get_y": {
      const units = Math.floor(line.qty_milli / 1000);
      d = Math.floor(units / (rule.buy_qty + rule.get_qty)) * rule.get_qty * line.unit_minor;
      break;
    }
  }
  return Math.min(Math.max(d, 0), line.amount_minor);
}
