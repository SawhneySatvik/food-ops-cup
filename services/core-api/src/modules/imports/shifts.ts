// Shift history (shift_log_v1, T-093, 0021): one closed drawer session per row. A history shift is device-less
// (history bills carry no device) and writes NO tender link: core.tender.shift_id is insert-only, so a shift reaches
// its tenders by drawer and time window exactly as orders' expectedCash does for a live shift. Expected cash is core's
// own figure from the committed tenders (float + cash tenders − cash refunds in the window), so a shift log commits
// after the bills of its days. The file's "Cash Tenders" column is a control total only: compared with core's figure
// at preview (mismatch → `tender_mismatch`) and never written. The figure is computed again at the approval; one that
// moved since the preview makes the draft stale (409 `stale_draft`, R-A 6) rather than commit a number the approver did
// not see (as billsOf). Only history-imported orders count (R-A 10): a live QR / storefront order is device-less too and
// may be paid in cash at the counter, and once its day has passed a history window could take it as drawer cash.
// A shift lies inside one business date: both of its times are read on the row's Date (a time before the outlet's
// cutoff belongs to the next calendar day, as for bills).
import { uuidv7 } from "../../commit/index.ts";
import { ApiError } from "../../lib/errors.ts";
import type { Queryable } from "../../runtoken/index.ts";
import { lockOutlets } from "../../lib/locks.ts";
import { dateRefusal, type HistoryCtx, instantOf, one } from "./history.ts";
import type { RowOutcome } from "./rows.ts";

type Value = string | number | null;
type Row = Record<string, Value>;

interface Window { outlet_id: string; opened_at: string; closed_at: string }

/** Net cash taken in each window at a device-less drawer: cash tenders − cash refunds of history-imported orders (their
 *  pricing snapshot names the import run). expectedCash's predicate with the shift's own bounds (it needs an existing
 *  shift row; these shifts do not exist yet). */
export async function cashIn(c: Queryable, windows: readonly Window[]): Promise<number[]> {
  if (windows.length === 0) return [];
  const r = await c.query<{ i: number; cash: string }>(
    `SELECT x.i,
            (SELECT coalesce(sum(t.amount_minor), 0) FROM core.tender t JOIN core."order" o ON o.tenant_id = t.tenant_id AND o.id = t.order_id
              WHERE t.method = 'cash' AND o.outlet_id = x.outlet_id AND o.device_id IS NULL AND o.pricing_snapshot ? 'import_run_id'
                AND t.at >= x.opened_at AND t.at <= x.closed_at)
          - (SELECT coalesce(sum(f.amount_minor), 0) FROM core.refund f JOIN core."order" o ON o.tenant_id = f.tenant_id AND o.id = f.order_id
              WHERE f.method = 'cash' AND o.outlet_id = x.outlet_id AND o.device_id IS NULL AND o.pricing_snapshot ? 'import_run_id'
                AND f.at >= x.opened_at AND f.at <= x.closed_at) AS cash
       FROM jsonb_to_recordset($1::jsonb) AS x (i int, outlet_id uuid, opened_at timestamptz, closed_at timestamptz)`,
    [JSON.stringify(windows.map((w, i) => ({ i, ...w })))]);
  const out: number[] = [];
  for (const row of r.rows) out[row.i] = Number(row.cash);
  return out;
}

export async function checkShifts(c: Queryable, rows: ReadonlyArray<{ line: number; v: Row }>, outletIdOf: (name: Value | undefined) => string | undefined,
  h: HistoryCtx): Promise<RowOutcome[]> {
  const no = (reason: string): RowOutcome => ({ ok: false, reason });
  const s = (v: Row, k: string) => String(v[k]).trim();
  const out: Array<RowOutcome | undefined> = rows.map(() => undefined);
  type Cand = { i: number; v: Row; outletId: string; openedBy: string; closedBy: string; openedAt: string; closedAt: string };
  const cands: Cand[] = [];
  for (const [i, { v }] of rows.entries()) {
    const outletId = outletIdOf(v.outlet);
    const openedBy = one(h.members, s(v, "opened_by").toLowerCase());
    const closedBy = one(h.members, s(v, "closed_by").toLowerCase());
    // Cash Tenders may be negative (cash refunded above cash taken in the window); the drawer's own figures may not.
    const money = ["float", "counted_cash"].map((k) => v[k] as number);
    if (!outletId) { out[i] = no("outlet_unknown"); continue; }
    if (!openedBy || !closedBy) { out[i] = no("member_unknown"); continue; }
    if (money.some((x) => x < 0)) { out[i] = no("amount_negative"); continue; }
    const refused = dateRefusal(h, outletId, String(v.shift_date));
    if (refused) { out[i] = no(refused); continue; }
    const openedAt = instantOf(h, outletId, String(v.shift_date), s(v, "opened_at"));
    const closedAt = instantOf(h, outletId, String(v.shift_date), s(v, "closed_at"));
    if (!openedAt || !closedAt) { out[i] = no("time_unreadable"); continue; }
    if (closedAt <= openedAt) { out[i] = no("shift_window_invalid"); continue; }
    cands.push({ i, v, outletId, openedBy, closedBy, openedAt, closedAt });
  }
  const cash = await cashIn(c, cands.map((x) => ({ outlet_id: x.outletId, opened_at: x.openedAt, closed_at: x.closedAt })));
  // Other device-less shifts of the books (an open one has no end yet): the same window again is an import of the same
  // shift twice; any other overlap would count a tender in two drawers.
  const existing = (await c.query<{ outlet_id: string; opened_at: Date; closed_at: Date | null }>(
    `SELECT outlet_id, opened_at, closed_at FROM core.shift WHERE device_id IS NULL`)).rows;
  const taken: Array<{ outlet_id: string; opened_at: number; closed_at: number; same: boolean }> = existing.map((e) => ({
    outlet_id: e.outlet_id, opened_at: e.opened_at.getTime(), closed_at: e.closed_at?.getTime() ?? Infinity, same: true }));
  const seenNo = new Set<string>();
  for (const [k, x] of cands.entries()) {
    const v = x.v;
    const float = v.float as number;
    const expected = float + cash[k]!;
    const o = Date.parse(x.openedAt), cl = Date.parse(x.closedAt);
    const clash = taken.find((t) => t.outlet_id === x.outletId && t.opened_at <= cl && o <= t.closed_at);
    const reason = seenNo.has(s(v, "shift_no")) ? "duplicate_row"
      : (v.cash_tenders as number) !== cash[k] ? "tender_mismatch"
      : expected < 0 ? "expected_negative"
      : clash ? (clash.opened_at === o && clash.closed_at === cl && clash.same ? "already_imported" : "shift_overlap")
      : null;
    if (reason) { out[x.i] = no(reason); continue; }
    seenNo.add(s(v, "shift_no"));
    taken.push({ outlet_id: x.outletId, opened_at: o, closed_at: cl, same: false });
    const counted = v.counted_cash as number;
    out[x.i] = { ok: true, row: { target_table: "core.shift", amount_minor: counted, external_ref: s(v, "shift_no"), data: {
      shift_no: s(v, "shift_no"), shift_date: String(v.shift_date), outlet_id: x.outletId, opened_at: x.openedAt, closed_at: x.closedAt,
      opened_by: x.openedBy, closed_by: x.closedBy, float_minor: float, counted_cash_minor: counted, expected_cash_minor: expected,
      variance_minor: counted - expected, cash_tenders_minor: cash[k]!,
    } } };
  }
  return out as RowOutcome[];
}

export interface StagedShift {
  outlet_id: string; shift_date: string; opened_at: string; closed_at: string; opened_by: string; closed_by: string;
  float_minor: number; counted_cash_minor: number; expected_cash_minor: number; variance_minor: number;
}

/** Inserts the approved shifts as closed in one INSERT each row (the 0004 CHECK), under the approver's decision. */
export async function writeShifts(c: Queryable, shifts: readonly StagedShift[], currency: string): Promise<void> {
  await lockOutlets(c, "shift", shifts.map((x) => x.outlet_id));
  const now = await cashIn(c, shifts.map((x) => ({ outlet_id: x.outlet_id, opened_at: x.opened_at, closed_at: x.closed_at })));
  shifts.forEach((x, i) => {
    if (x.counted_cash_minor - x.expected_cash_minor !== x.variance_minor) throw new ApiError("invalid_payload");
    if (x.float_minor + now[i]! !== x.expected_cash_minor) throw new ApiError("stale_draft", "stale_draft");
  });
  // Another file approved since this one was previewed may hold the same drawer time: a tender would count in two shifts.
  // That never clears on a retry, so the draft goes stale (R-A 6), as for a moved figure.
  const clash = await c.query(
    `SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS x (outlet_id uuid, opened_at timestamptz, closed_at timestamptz)
       JOIN core.shift s ON s.outlet_id = x.outlet_id AND s.device_id IS NULL AND s.opened_at <= x.closed_at AND x.opened_at <= coalesce(s.closed_at, 'infinity')
      LIMIT 1`, [JSON.stringify(shifts)]);
  if (clash.rowCount) throw new ApiError("stale_draft", "stale_draft");
  await c.query(
    `INSERT INTO core.shift (tenant_id, id, outlet_id, device_id, status, opened_by, opened_at, float_minor, currency, closed_by, closed_at,
                             counted_cash_minor, expected_cash_minor, variance_minor)
     SELECT current_setting('app.tenant_id')::uuid, x.id, x.outlet_id, NULL, 'closed', x.opened_by, x.opened_at, x.float_minor, $2, x.closed_by, x.closed_at,
            x.counted_cash_minor, x.expected_cash_minor, x.variance_minor
       FROM jsonb_to_recordset($1::jsonb) AS x (id uuid, outlet_id uuid, opened_by uuid, opened_at timestamptz, float_minor bigint, closed_by uuid,
            closed_at timestamptz, counted_cash_minor bigint, expected_cash_minor bigint, variance_minor bigint)`,
    [JSON.stringify(shifts.map((x) => ({ ...x, id: uuidv7() }))), currency]);
}
