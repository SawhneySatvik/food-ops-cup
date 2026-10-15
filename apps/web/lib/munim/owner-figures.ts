// file: lib/munim/owner-figures.ts
// Owner home's figures (12 §3). Each one is a snapshot this screen mints (POST /v1/snapshots) for the outlet the
// shell's switcher chose, and one cell of it, shown with its source chip. Nothing is added up here: the only
// operations are picking a row and comparing two cells to find the larger. Dates start from the outlet's business
// date (GET /v1/catalogue/menu) and move by whole days; the tablet's clock is never read. Plain TypeScript, no React.
import type { MunimError } from "./client";
import { cellOf, snapRef, type Cell, type Snapshot } from "./refs";
import type { StaffClient } from "./staff";

/** The Monday of the ISO week holding a date: "2026-10-14" -> "2026-10-12". */
export function mondayOf(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
}

/** The first of the month: "2026-10-14" -> "2026-10-01". */
export const monthStartOf = (isoDate: string): string => `${isoDate.slice(0, 7)}-01`;

/** One shown cell: the value, the column that says how to format it (formatCell), and the ref its chip opens. */
export interface Figure {
  ref: string;
  column: string;
  value: Cell;
}

/** A figure, "none" (the snapshot has no rows: show a word, never a typed 0), or null ("Cannot verify": the mint
 *  failed or the cell is not there). */
export type FigureState = Figure | "none" | null;

export interface LowStockRow {
  ingredientId: string | null;
  /** The ingredient's name as the snapshot holds it (a text cell, shown as plain text). */
  name: string | null;
  onHand: Figure | null;
  minimum: Figure | null;
}

export interface OwnerFigures {
  tickets: FigureState;
  netSales: FigureState;
  /** The one ingredient with the most waste since Monday. Not a total: the template has no total row. */
  waste: { amount: Figure | null; ingredientId: string | null } | "none" | null;
  shared: { portions: Figure | null; units: Figure | null; handovers: Figure | null } | null;
  lowStock: LowStockRow[] | null;
  /** The first failed call: pass it to handleAuth; a 429 shows the wait. The cards it fed show "Cannot verify". */
  error: MunimError | null;
}

/** Every card "Cannot verify" (the business date itself could not be read). */
export const noFigures = (error: MunimError | null): OwnerFigures => ({ tickets: null, netSales: null, waste: null, shared: null, lowStock: null, error });

function at(s: Snapshot, row: number, column: string): Figure | null {
  const value = cellOf(s, { kind: "snap", snapshotId: s.snapshot_id, row, column });
  return value === undefined ? null : { ref: snapRef(s.snapshot_id, row, column), column, value };
}

const text = (v: Cell | undefined): string | null => (typeof v === "string" ? v : null);
/** For comparing two cells (bigint columns may arrive as numeric strings). Never used to compute a shown value. */
const num = (v: Cell | undefined): number => (typeof v === "number" ? v : Number(v ?? 0));

/** Mints the five snapshots for one outlet's business date and picks the cells the cards show. Params are exactly
 *  each template's keys (core refuses anything else with 422). Five calls, five new snapshot rows: call this on
 *  load, on an outlet change and on "Refresh figures" only. */
export async function loadOwnerFigures(client: StaffClient, outletId: string, today: string): Promise<OwnerFigures> {
  const monday = mondayOf(today);
  const [t, n, w, c, b] = await Promise.all([
    client.mintSnapshot({ template_id: "kitchen.ticket_coverage", params: { outlet_id: outletId, from: today, to: today } }),
    client.mintSnapshot({ template_id: "people.labour_pct", params: { outlet_id: outletId, from: monday, to: today } }),
    client.mintSnapshot({ template_id: "inventory.waste_week", params: { outlet_id: outletId, week_start: monday } }),
    client.mintSnapshot({ template_id: "cares.impact", params: { outlet_id: outletId, from: monthStartOf(today), to: today } }),
    client.mintSnapshot({ template_id: "inventory.below_reorder", params: {} }),
  ]);
  const failed = [t, n, w, c, b].flatMap((r) => (r.ok ? [] : [r.error]));

  // Monday..today lies inside one ISO week, so labour_pct answers at most one row: row 0 is this week.
  const netSales: FigureState = !n.ok ? null : n.data.rows.length === 0 ? "none" : at(n.data, 0, "net_sales_minor");

  let waste: OwnerFigures["waste"] = null;
  if (w.ok) {
    // Rows come ordered by ingredient id, not by size: find the largest by comparing, never by adding.
    let top = 0;
    w.data.rows.forEach((r, i) => {
      if (num(r.waste_minor) > num(w.data.rows[top]!.waste_minor)) top = i;
    });
    waste = w.data.rows.length === 0 ? "none" : { amount: at(w.data, top, "waste_minor"), ingredientId: text(w.data.rows[top]!.ingredient_id) };
  }

  let shared: OwnerFigures["shared"] = null;
  if (c.ok) {
    const total = c.data.rows.findIndex((r) => r.kind === "total");
    shared = { portions: at(c.data, total, "portions_milli"), units: at(c.data, total, "units_milli"), handovers: at(c.data, total, "handovers") };
  }

  // below_reorder takes no params and covers every outlet the person sees: keep the chosen outlet's rows.
  const lowStock = !b.ok ? null : b.data.rows.flatMap((r, i) => (r.outlet_id !== outletId ? [] : [{
    ingredientId: text(r.ingredient_id), name: text(r.ingredient_name), onHand: at(b.data, i, "on_hand_milli"), minimum: at(b.data, i, "min_qty_milli"),
  }]));

  return { tickets: t.ok ? at(t.data, 0, "tickets") : null, netSales, waste, shared, lowStock, error: failed[0] ?? null };
}
