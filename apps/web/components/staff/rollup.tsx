// file: components/staff/rollup.tsx
"use client";
// Owner home's "All outlets" (T-128, R66): the whole business today, then outlet by outlet, then last month's profit and loss
// by outlet (and by brand where the business runs more than one). Every figure is one cell of a snapshot this screen mints:
// the business-wide ones with `outlet_id: null`, so the books work the total out; each outlet's own for that outlet alone, so
// its books stay apart. Nothing here is added up. The owner (and an advisor or judge) only: a manager sees one outlet.
import { useCallback, useEffect, useState } from "react";
import type { MunimError } from "@/lib/munim/client";
import { lastMonth, loadPnl, loadRollup, type Figure, type OwnerFigures, type PnlRow } from "@/lib/munim/owner-figures";
import { formatCell, type CellFormat } from "@/lib/munim/refs";
import { monthWords } from "@/lib/munim/investigation-words";
import type { StaffClient } from "@/lib/munim/staff";
import { staffErrorText } from "@/lib/munim/staff-copy";
import type { Schemas } from "@/lib/munim/types";
import { SITE } from "@/lib/site";
import { CannotVerify, SourcedValue, StatCard } from "./source";
import type { OpenRef } from "./pages/inbox";

type Outlet = Schemas["V1Outlets"]["outlets"][number];

const text = (f: Figure | null | "none" | undefined, fmt: CellFormat): string | null | undefined =>
  f === undefined ? undefined : f === null || f === "none" ? null : formatCell(f.value, f.column, fmt);
const Cell = ({ f, fmt, onOpen }: { f: Figure | null | "none"; fmt: CellFormat; onOpen: OpenRef }) =>
  f === "none" ? <span className="text-muted">None yet</span> : f === null ? <CannotVerify /> : <SourcedValue text={formatCell(f.value, f.column, fmt)} refToken={f.ref} onOpen={onOpen} />;

function PnlTable({ title, rows, nameOf, fmt, onOpen, error }: { title: string; rows: PnlRow[] | null; nameOf: (key: string) => string; fmt: CellFormat; onOpen: OpenRef; error: MunimError | null }) {
  return (
    <section className="card min-w-0 space-y-3 p-5">
      <h3 className="text-[22px]">{title}</h3>
      {rows === null ? <div className="skeleton h-20" role="status" aria-label="Loading" />
        : error ? <p className="flex flex-wrap items-center gap-2"><CannotVerify /> {staffErrorText(error, "home")}</p>
        : rows.length === 0 ? <p className="text-muted">No postings in that month.</p>
        : (
          <div className="overflow-x-auto">
            <table className="snap-table">
              <thead><tr><th scope="col">For</th><th scope="col" className="num">Sales</th><th scope="col" className="num">Labour</th><th scope="col" className="num">Net</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.key}>
                    <th scope="row" className="font-semibold">{nameOf(r.key)}</th>
                    <td className="num"><Cell f={r.revenue} fmt={fmt} onOpen={onOpen} /></td>
                    <td className="num"><Cell f={r.labour} fmt={fmt} onOpen={onOpen} /></td>
                    <td className="num"><Cell f={r.net} fmt={fmt} onOpen={onOpen} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </section>
  );
}

export function Rollup({ client, outlets, today, fmt, onOpen, onAuth }: {
  client: StaffClient; outlets: Outlet[]; today: string; fmt: CellFormat; onOpen: OpenRef; onAuth: (e: MunimError) => boolean;
}) {
  const [figures, setFigures] = useState<{ business: OwnerFigures; outlets: OwnerFigures[] } | null>(null);
  const [byOutlet, setByOutlet] = useState<{ rows: PnlRow[]; error: MunimError | null } | null>(null);
  const [brands, setBrands] = useState<Array<{ id: string; name: string }>>([]);
  const [byBrand, setByBrand] = useState<{ rows: PnlRow[]; error: MunimError | null } | null>(null);

  const load = useCallback(async () => {
    setFigures(null);
    setByOutlet(null);
    const [f, p, b] = await Promise.all([loadRollup(client, outlets.map((o) => o.id), today), loadPnl(client, today, "outlet"), client.listBrands()]);
    if (f.business.error && onAuth(f.business.error)) return;
    setFigures(f);
    setByOutlet(p);
    const active = b.ok ? b.data.brands.filter((x) => x.active) : [];
    setBrands(active);
    if (active.length > 1) setByBrand(await loadPnl(client, today, "brand"));
  }, [client, outlets, today, onAuth]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mint on mount and when the day changes
    void load();
  }, [load]);

  const b = figures?.business;
  const outletName = (key: string) => outlets.find((o) => o.id === key)?.name ?? (key === "unassigned" ? "Not tied to an outlet" : "An outlet");
  const brandName = (key: string) => brands.find((x) => x.id === key)?.name ?? (key === "unassigned" ? "Not tied to a brand" : "A brand");
  const month = monthWords(lastMonth(today), SITE.locale);

  return (
    <div className="min-w-0 space-y-6">
      <section aria-label="The whole business today" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Kitchen tickets today" value={b ? text(b.tickets, fmt) : undefined} refToken={b?.tickets && b.tickets !== "none" ? b.tickets.ref : null} note="Every outlet, from the books." onOpen={onOpen} />
        <StatCard label="Net sales this week" value={b ? (b.netSales === "none" ? null : text(b.netSales, fmt)) : undefined} refToken={b?.netSales && b.netSales !== "none" ? b.netSales.ref : null} note="Every outlet, since Monday." onOpen={onOpen} />
        <StatCard label="Most waste this week" value={b ? (b.waste === "none" || b.waste === null ? null : text(b.waste.amount, fmt)) : undefined} refToken={b?.waste && b.waste !== "none" ? (b.waste.amount?.ref ?? null) : null} note="The one ingredient with the most, across outlets." onOpen={onOpen} />
        <div className="card stat">
          <p className="stat-label">Food shared this month</p>
          {!b ? <div className="skeleton h-10 w-32" aria-hidden="true" /> : !b.shared ? <CannotVerify /> : <p className="text-[18px] font-semibold">Hand-overs <Cell f={b.shared.handovers} fmt={fmt} onOpen={onOpen} /></p>}
          <p className="text-[14px] text-muted">To simulated recipients.</p>
        </div>
      </section>

      <section aria-labelledby="by-outlet-title" className="card min-w-0 space-y-3 p-5">
        <h2 id="by-outlet-title" className="text-[24px]">Outlet by outlet</h2>
        <p className="text-muted">Each outlet&apos;s figures come from its own books. The figures above are worked out by the books for the whole business, not added up on this page.</p>
        {!figures ? <div className="skeleton h-24" role="status" aria-label="Loading" />
          : (
            <div className="overflow-x-auto">
              <table className="snap-table">
                <thead><tr><th scope="col">Outlet</th><th scope="col" className="num">Kitchen tickets today</th><th scope="col" className="num">Net sales this week</th><th scope="col" className="num">Most waste this week</th></tr></thead>
                <tbody>
                  {outlets.map((o, i) => {
                    const f = figures.outlets[i]!;
                    return (
                      <tr key={o.id}>
                        <th scope="row" className="font-semibold">{o.name}</th>
                        <td className="num"><Cell f={f.tickets} fmt={fmt} onOpen={onOpen} /></td>
                        <td className="num"><Cell f={f.netSales} fmt={fmt} onOpen={onOpen} /></td>
                        <td className="num">{f.waste === "none" ? <span className="text-muted">None</span> : <Cell f={f.waste?.amount ?? null} fmt={fmt} onOpen={onOpen} />}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        <button type="button" className="btn btn-plain" disabled={!figures} onClick={() => void load()}>Refresh figures</button>
      </section>

      <div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
        <PnlTable title={`Profit and loss for ${month}, by outlet`} rows={byOutlet?.rows ?? null} error={byOutlet?.error ?? null} nameOf={outletName} fmt={fmt} onOpen={onOpen} />
        {brands.length > 1 && <PnlTable title={`Profit and loss for ${month}, by brand`} rows={byBrand?.rows ?? null} error={byBrand?.error ?? null} nameOf={brandName} fmt={fmt} onOpen={onOpen} />}
      </div>
    </div>
  );
}
