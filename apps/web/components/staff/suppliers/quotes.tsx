// file: components/staff/suppliers/quotes.tsx
"use client";
// The simulated suppliers' quotes in one negotiation: a purchasing.quote_compare snapshot the viewer minted, shown as
// its rows in the order core sorted them (round, then supplier). The whole table is that snapshot, so its caption
// carries the one source chip; the browser compares nothing (no "cheapest", no "saves").
import { formatCell, snapRef, type CellFormat, type Snapshot } from "@/lib/munim/refs";
import { quoteRows, type Supplier } from "@/lib/munim/supply-flow";
import { SimulatedSupplier, SourcedValue, StatusPill } from "../source";

const COLUMNS = [
  { name: "round", label: "Round" },
  { name: "unit_price_minor", label: "Price per unit, as quoted" },
  { name: "qty_milli", label: "Quantity" },
  { name: "min_order_qty_milli", label: "Smallest order" },
  { name: "payment_days", label: "Pay within (days)" },
] as const;

export function QuoteTable({ snapshot, suppliers, citedRow, fmt, onOpen }: {
  snapshot: Snapshot;
  suppliers: readonly Supplier[];
  /** The row the proposal's price cites (poDraftLines' quoteRow): it is marked "Proposed". */
  citedRow: number | null;
  fmt: CellFormat;
  onOpen: (snapshotId: string, refToken: string) => void;
}) {
  const rows = quoteRows(snapshot);
  if (rows.length === 0) return <p className="text-muted">No quotes were recorded for this negotiation.</p>;
  const cited = rows.find((r) => r.row === citedRow) ?? rows[0]!;
  return (
    <div className="overflow-x-auto">
      <table className="snap-table">
        <caption className="pb-2 text-left font-semibold">
          <SourcedValue text="Quotes from simulated suppliers" refToken={snapRef(snapshot.snapshot_id, cited.row, "unit_price_minor")} onOpen={onOpen} />
        </caption>
        <thead>
          <tr><th scope="col">Supplier</th>{COLUMNS.map((c) => <th key={c.name} scope="col" className="num">{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((q) => {
            const s = suppliers.find((x) => x.supplier_id === q.supplierId);
            return (
              <tr key={q.quoteId} aria-current={q.row === citedRow ? "true" : undefined}>
                <td>
                  <span className="flex flex-wrap items-center gap-2">{s?.name ?? "A supplier no longer listed"} <SimulatedSupplier />{q.row === citedRow && <StatusPill tone="new">Proposed</StatusPill>}</span>
                </td>
                {COLUMNS.map((c) => <td key={c.name} className="num">{formatCell(snapshot.rows[q.row]![c.name] ?? null, c.name, fmt)}</td>)}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2 text-[14px] text-muted">Quotes from simulated suppliers, recorded during a simulated negotiation. Units as quoted.</p>
    </div>
  );
}
