// Stock-count history (stock_count_v1, T-093, 0021): a count is judged whole, like a bill (one bad line → its siblings
// are quarantined `count_rejected`), and written as the count `submitted`, its lines, then one `inventory.count_adjust`
// derivation group per count (the movement is core's, never a command of the approver's). `expected_qty_milli` is core's
// on-hand at `counted_at` (Σ movements with at ≤ counted_at), not the file's. An ingredient counted again later in the
// same file starts from the earlier count's adjustment: counts are taken in (counted_at, count no) order and each is
// held to the figure the previous one leaves, at the preview and again at the approval (one that moved makes the draft
// stale, 409 `stale_draft`, R-A 6). A count dated before a submitted count (or a count adjustment) of the same outlet,
// ingredient and batch is refused (`later_count_exists`, R-A 3): its adjustment would land under the later count and
// shift today's stock, which that later count already fixed. At the approval the same rule, like the same count already
// in the books, makes the draft stale too (it never clears on a retry); approvals and live counts at one outlet are
// serialised before these checks (R-A 2).
// A batch-tracked ingredient is counted per batch (the "Batch" column, a batch code at that outlet; expected is that
// batch's own stock, as countSubmit's); an untracked one has no batch. Quantities are in the base unit.
import { uuidv7 } from "../../commit/index.ts";
import { ApiError } from "../../lib/errors.ts";
import type { Queryable } from "../../runtoken/index.ts";
import { lockOutlets } from "../../lib/locks.ts";
import { dateRefusal, type HistoryCtx, instantOf, one } from "./history.ts";
import type { RowOutcome } from "./rows.ts";
import { type Group, writeDerived } from "./write.ts";

type Value = string | number | null;
type Row = Record<string, Value>;

/** Core's on-hand of each counted line at one outlet, counting movements up to and including `at` (countSubmit's expected, cut in
 *  time): the batch's own stock for a batch line, else the ingredient's whole stock. One figure per input line, in order. */
async function onHandAt(c: Queryable, outletId: string, lines: ReadonlyArray<{ ingredient_id: string; batch_id: string | null }>, at: string): Promise<number[]> {
  const r = await c.query<{ k: number; q: string }>(
    `SELECT x.k, coalesce(sum(m.qty_milli), 0)::text AS q
       FROM jsonb_to_recordset($1::jsonb) AS x (k int, ingredient_id uuid, batch_id uuid)
       LEFT JOIN core.stock_movement m ON m.outlet_id = $2 AND m.ingredient_id = x.ingredient_id AND m.at <= $3::timestamptz
                                       AND (x.batch_id IS NULL OR m.batch_id = x.batch_id)
      GROUP BY x.k`, [JSON.stringify(lines.map((l, k) => ({ k, ...l }))), outletId, at]);
  const out: number[] = [];
  for (const row of r.rows) out[row.k] = Number(row.q);
  return out;
}

/** The lines (by index) with a submitted count line or a count adjustment of the same outlet, ingredient and batch AFTER `at`. */
async function countedLater(c: Queryable, outletId: string, lines: ReadonlyArray<{ ingredient_id: string; batch_id: string | null }>, at: string): Promise<Set<number>> {
  const r = await c.query<{ k: number }>(
    `SELECT x.k FROM jsonb_to_recordset($1::jsonb) AS x (k int, ingredient_id uuid, batch_id uuid)
      WHERE EXISTS (SELECT 1 FROM core.stock_count sc JOIN core.stock_count_line l ON l.tenant_id = sc.tenant_id AND l.stock_count_id = sc.id
                     WHERE sc.outlet_id = $2 AND sc.status = 'submitted' AND sc.counted_at > $3::timestamptz
                       AND l.ingredient_id = x.ingredient_id AND l.batch_id IS NOT DISTINCT FROM x.batch_id)
         OR EXISTS (SELECT 1 FROM core.stock_movement m
                     WHERE m.outlet_id = $2 AND m.kind = 'count_adjust' AND m.at > $3::timestamptz
                       AND m.ingredient_id = x.ingredient_id AND m.batch_id IS NOT DISTINCT FROM x.batch_id)`,
    [JSON.stringify(lines.map((l, k) => ({ k, ...l }))), outletId, at]);
  return new Set(r.rows.map((x) => x.k));
}

interface Line { line: number; v: Row; ingredient_id?: string; batch_id?: string | null; base_unit?: string; out?: RowOutcome }

export async function checkCounts(c: Queryable, rows: ReadonlyArray<{ line: number; v: Row }>, outletIdOf: (name: Value | undefined) => string | undefined,
  h: HistoryCtx): Promise<RowOutcome[]> {
  const no = (reason: string): RowOutcome => ({ ok: false, reason });
  const s = (v: Row, k: string) => (v[k] === null || v[k] === undefined ? null : String(v[k]).trim());
  const all: Line[] = rows.map((r) => ({ line: r.line, v: r.v }));
  const counts = new Map<string, Line[]>();
  for (const r of all) counts.set(s(r.v, "count_no")!, [...(counts.get(s(r.v, "count_no")!) ?? []), r]);

  const batches = new Map<string, string[]>();
  for (const b of (await c.query<{ id: string; outlet_id: string; ingredient_id: string; batch_code: string }>(
    `SELECT id, outlet_id, ingredient_id, batch_code FROM core.batch`)).rows) {
    const k = `${b.outlet_id}|${b.ingredient_id}|${b.batch_code.trim().toLowerCase()}`;
    batches.set(k, [...(batches.get(k) ?? []), b.id]);
  }
  const existing = new Set((await c.query<{ outlet_id: string; at: Date }>(`SELECT outlet_id, counted_at AS at FROM core.stock_count`)).rows
    .map((e) => `${e.outlet_id}|${e.at.toISOString()}`));
  type Good = { no: string; lines: Line[]; outletId: string; countedBy: string; at: string; date: string };
  const good: Good[] = [];
  for (const [countNo, lines] of counts) {
    const fail = (bad: Map<Line, string>) => { for (const r of lines) r.out = no(bad.get(r) ?? "count_rejected"); };
    const head = lines[0]!.v;
    const key = (v: Row) => JSON.stringify(["count_date", "count_time", "outlet", "counted_by"].map((k) => v[k] ?? null));
    if (lines.some((r) => key(r.v) !== key(head))) { fail(new Map(lines.map((r) => [r, "count_header_differs"]))); continue; }
    const outletId = outletIdOf(head.outlet);
    const countedBy = one(h.members, s(head, "counted_by")!.toLowerCase());
    const date = String(head.count_date);
    const at = outletId ? instantOf(h, outletId, date, s(head, "count_time")) : null;
    const headReason = !outletId ? "outlet_unknown" : !countedBy ? "member_unknown" : dateRefusal(h, outletId, date)
      ?? (!at ? "time_unreadable" : existing.has(`${outletId}|${at}`) ? "already_imported" : null);
    if (headReason) { fail(new Map(lines.map((r) => [r, headReason]))); continue; }
    const bad = new Map<Line, string>();
    const seen = new Set<string>();
    for (const r of lines) {
      const ing = one(h.ingredients, s(r.v, "ingredient")!.toLowerCase());
      const code = s(r.v, "batch");
      const batch = !ing || code === null ? undefined : one(batches, `${outletId}|${ing.id}|${code.toLowerCase()}`);
      const why = !ing ? "ingredient_unknown"
        : ing.tracked && code === null ? "batch_required"
        : !ing.tracked && code !== null ? "batch_not_tracked"
        : code !== null && !batch ? "batch_unknown"
        : s(r.v, "unit")!.toLowerCase() !== ing.base_unit ? "unit_mismatch"
        : (r.v.qty as number) < 0 ? "qty_invalid"
        : seen.has(`${ing.id}|${batch ?? ""}`) ? "duplicate_ingredient"
        : null;
      if (why) bad.set(r, why);
      else { r.ingredient_id = ing!.id; r.batch_id = batch ?? null; r.base_unit = ing!.base_unit; seen.add(`${ing!.id}|${batch ?? ""}`); }
    }
    if (bad.size) { fail(bad); continue; }
    const later = await countedLater(c, outletId!, lines.map((l) => ({ ingredient_id: l.ingredient_id!, batch_id: l.batch_id! })), at!);
    if (later.size) { fail(new Map(lines.flatMap((l, j) => (later.has(j) ? [[l, "later_count_exists"] as const] : [])))); continue; }
    good.push({ no: countNo, lines, outletId: outletId!, countedBy: countedBy!, at: at!, date });
  }

  const carried = new Map<string, number>();
  for (const g of good.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.no < b.no ? -1 : 1))) {
    const onHand = await onHandAt(c, g.outletId, g.lines.map((l) => ({ ingredient_id: l.ingredient_id!, batch_id: l.batch_id! })), g.at);
    for (const [j, l] of g.lines.entries()) {
      const k = `${g.outletId}|${l.ingredient_id}|${l.batch_id ?? ""}`;
      const expected = onHand[j]! + (carried.get(k) ?? 0);
      const counted = l.v.qty as number;
      carried.set(k, (carried.get(k) ?? 0) + counted - expected);
      l.out = { ok: true, row: { target_table: "core.stock_count_line", amount_minor: null, external_ref: g.no, data: {
        count_no: g.no, count_date: g.date, at: g.at, outlet_id: g.outletId, counted_by: g.countedBy, ingredient_id: l.ingredient_id!, batch_id: l.batch_id!,
        unit: l.base_unit!, counted_qty_milli: counted, expected_qty_milli: expected,
      } } };
    }
  }
  return all.map((r) => r.out!);
}

export interface StagedCountLine {
  count_no: string; at: string; outlet_id: string; counted_by: string; ingredient_id: string; batch_id: string | null; unit: string; counted_qty_milli: number; expected_qty_milli: number;
}

/** Writes each count (submitted), its lines and its adjustment movements, in counted_at order so a later count reads the
 *  earlier one's adjustment. Returns the numbers for the audit entry. */
export async function writeCounts(c: Queryable, staged: readonly StagedCountLine[]): Promise<{ counts: number; lines: number; adjustments: number }> {
  const counts = new Map<string, StagedCountLine[]>();
  for (const l of staged) counts.set(l.count_no, [...(counts.get(l.count_no) ?? []), l]);
  const ordered = [...counts.values()].sort((a, b) => Date.parse(a[0]!.at) - Date.parse(b[0]!.at) || (a[0]!.count_no < b[0]!.count_no ? -1 : 1));
  await lockOutlets(c, "stock_count", staged.map((l) => l.outlet_id));
  let lines = 0, adjustments = 0;
  for (const ls of ordered) {
    const head = ls[0]!;
    // Another file approved since the preview may hold this very count (same outlet and instant): already imported; or a
    // later count of one of its ingredients (R-A 3).
    if ((await c.query(`SELECT 1 FROM core.stock_count WHERE outlet_id = $1 AND counted_at = $2::timestamptz`, [head.outlet_id, head.at])).rowCount
        || (await countedLater(c, head.outlet_id, ls, head.at)).size) throw new ApiError("stale_draft", "stale_draft");
    const onHand = await onHandAt(c, head.outlet_id, ls, head.at);
    // The figure the approver saw in the preview must still be core's, or nothing is written: the draft is stale.
    if (ls.some((l, j) => onHand[j]! !== l.expected_qty_milli)) throw new ApiError("stale_draft", "stale_draft");
    const countId = uuidv7();
    // 0024's UNIQUE (tenant, outlet, counted_at) is the same rule as the check above, held by the database.
    await c.query(
      `INSERT INTO core.stock_count (tenant_id, id, outlet_id, counted_by, counted_at, status)
       VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, 'submitted')`, [countId, head.outlet_id, head.counted_by, head.at])
      .catch((e: { code?: string }) => { throw e.code === "23505" ? new ApiError("stale_draft", "stale_draft") : e; });
    await c.query(
      `INSERT INTO core.stock_count_line (tenant_id, id, stock_count_id, ingredient_id, batch_id, expected_qty_milli, counted_qty_milli, unit)
       SELECT current_setting('app.tenant_id')::uuid, x.id, $1, x.ingredient_id, x.batch_id, x.expected_qty_milli, x.counted_qty_milli, x.unit
         FROM jsonb_to_recordset($2::jsonb) AS x (id uuid, ingredient_id uuid, batch_id uuid, expected_qty_milli bigint, counted_qty_milli bigint, unit text)`,
      [countId, JSON.stringify(ls.map((l) => ({ ...l, id: uuidv7() })))]);
    const moves = ls.filter((l) => l.counted_qty_milli !== l.expected_qty_milli).map((l) => ({
      id: uuidv7(), outlet_id: l.outlet_id, ingredient_id: l.ingredient_id, batch_id: l.batch_id, qty_milli: l.counted_qty_milli - l.expected_qty_milli, unit: l.unit,
      kind: "count_adjust", unit_cost_per_1000_minor: null, currency: null, expired_sale_override_id: null, at: l.at }));
    if (moves.length) {
      const group: Group = { rule: "inventory.count_adjust", source_ref: `core.stock_count:${countId}`, stock_movement: moves };
      await writeDerived(c, [group]);
    }
    lines += ls.length;
    adjustments += moves.length;
  }
  return { counts: ordered.length, lines, adjustments };
}
