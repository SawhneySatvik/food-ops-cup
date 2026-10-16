// file: components/staff/pages/purchase-order.tsx
"use client";
// /staff/purchase-orders/[poId] (15): one purchase order to a simulated supplier. Its lines are row fields side by
// side (never multiplied), its total is the one core worked out, the quotes behind it (when a negotiation proposed it)
// are a snapshot this page mints, and goods received are recorded against it by a named person. No live topic carries
// purchasing, so the page refetches on focus, on "Refresh" and after goods are recorded. Owners and managers only.
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOnline } from "@/lib/hooks";
import type { MunimError } from "@/lib/munim/client";
import { personName } from "@/lib/munim/drafts";
import { formatDate, formatDayTime, formatMoney, formatQty } from "@/lib/munim/format";
import { outletNames, type CellFormat, type Snapshot } from "@/lib/munim/refs";
import { can } from "@/lib/munim/session";
import { PO_STATUS, staffErrorText, VERDICT } from "@/lib/munim/staff-copy";
import { ingredientOf, quoteParams, type GoodsReceived, type PurchaseOrder, type Supplier } from "@/lib/munim/supply-flow";
import { templateWords } from "@/lib/munim/template-words";
import type { Schemas } from "@/lib/munim/types";
import { SITE, UUID7 } from "@/lib/site";
import { useStaff } from "../shell";
import { SimulatedSupplier, SnapshotDrawer, StatusPill } from "../source";
import { QuoteTable } from "../suppliers/quotes";
import { ReceiveForm } from "../suppliers/receive";
import { ErrorNote, OfflineBanner, Toast, useToast } from "../../ui";
import { NotForSuppliers, NotFoundPage, PO_TONE } from "./suppliers";

/** The rest of the page, loaded once: the tenant (currency), the stock items (names) and the suppliers (quote rows). */
interface Base {
  tenant: Schemas["V1Tenant"];
  ingredients: Schemas["V1InventoryIngredients"]["items"];
  suppliers: Supplier[];
}

export function PurchaseOrderScreen() {
  const { poId } = useParams<{ poId: string }>();
  const { session, outlet } = useStaff();
  if (!can(session, "suppliers")) return <NotForSuppliers />;
  if (!UUID7.test(poId)) return <NotFoundPage />;
  if (!outlet) return <main className="wrap staff-main"><div className="state-box" role="status">Loading</div></main>;
  return <PurchaseOrderView key={poId} poId={poId} />;
}

function PurchaseOrderView({ poId }: { poId: string }) {
  const { session, client, outlet, outlets, handleAuth } = useStaff();
  const me = session.me;
  const [po, setPo] = useState<PurchaseOrder | "not_found" | null>(null);
  const [grns, setGrns] = useState<GoodsReceived[] | null>(null);
  const [base, setBase] = useState<Base | null>(null);
  const [quotes, setQuotes] = useState<Snapshot | "failed" | null>(null);
  /** Who approved the proposal that made this order (GET /v1/lineage), or null: a person's own order, or no answer. */
  const [approval, setApproval] = useState<Schemas["V1LineageRow"]["chains"][number]["decision"]>(null);
  const [error, setError] = useState<MunimError | null>(null);
  const [drawer, setDrawer] = useState<{ snapshotId: string; refToken: string } | null>(null);
  const [toast, setToast] = useToast();
  const online = useOnline();
  // The quote comparison is minted once per page: a refresh or a focus does not write another snapshot row.
  const minted = useRef(false);

  const failed = useCallback((e: MunimError) => {
    if (!handleAuth(e)) setError(e);
  }, [handleAuth]);

  /** The order's lineage: the chain that holds a decision (a later chain, such as goods received, has none). A 404 or
   *  any other failure shows nothing: the line is extra, never in the way. */
  const loadApproval = useCallback(async () => {
    const r = await client.getRowLineage(`core.purchase_order:${poId}`);
    if (r.ok) setApproval(r.data.chains.find((c) => c.decision !== null)?.decision ?? null);
    else handleAuth(r.error);
  }, [client, poId, handleAuth]);

  /** The order and the goods received against it (then who approved it): on load, on focus, on "Refresh" and after
   *  the receive form answers. */
  const loadOrder = useCallback(async () => {
    const [p, g] = await Promise.all([client.getPurchaseOrder(poId), client.listGoodsReceived()]);
    if (!p.ok && p.error.kind === "not_found") return setPo("not_found");
    if (!p.ok) return failed(p.error);
    if (!g.ok) return failed(g.error);
    setPo(p.data);
    setGrns(g.data.items.filter((x) => x.po_id === poId));
    setError(null);
    void loadApproval();
    const run = p.data.negotiation_run_id;
    if (run && !minted.current) {
      minted.current = true;
      const q = await client.mintSnapshot({ template_id: "purchasing.quote_compare", params: quoteParams(run) });
      if (!q.ok) {
        minted.current = false;
        handleAuth(q.error);
      }
      setQuotes(q.ok ? q.data : "failed");
    }
  }, [client, poId, failed, handleAuth, loadApproval]);

  const loadBase = useCallback(async () => {
    const [t, i, s] = await Promise.all([client.getTenant(), client.listIngredients(), client.listSuppliers()]);
    if (!(t.ok && i.ok && s.ok)) {
      const bad = [t, i, s].find((x) => !x.ok);
      if (bad && !bad.ok) failed(bad.error);
      return;
    }
    setBase({ tenant: t.data, ingredients: i.data.items, suppliers: s.data.items });
  }, [client, failed]);

  const load = useCallback(() => {
    void loadOrder();
    void loadBase();
  }, [loadOrder, loadBase]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set after the responses
    load();
  }, [load]);

  useEffect(() => {
    const onShow = () => { if (document.visibilityState === "visible") void loadOrder(); };
    document.addEventListener("visibilitychange", onShow);
    return () => document.removeEventListener("visibilitychange", onShow);
  }, [loadOrder]);

  if (po === "not_found") return <NotFoundPage />;
  if (error && (!po || !base)) {
    return (
      <main className="wrap staff-main space-y-3">
        <h1 className="section-title">Purchase order</h1>
        <ErrorNote>{staffErrorText(error, "suppliers")}</ErrorNote>
        <button type="button" className="btn btn-plain" onClick={load}>Try again</button>
      </main>
    );
  }
  if (!po || !grns || !base) return <main className="wrap staff-main"><div className="skeleton h-96" role="status" aria-label="Loading" /></main>;

  const tz = outlets.find((o) => po.outlet_ids.includes(o.id))?.tz ?? outlet?.tz ?? base.tenant.home_tz ?? "UTC";
  const fmt: CellFormat = { locale: SITE.locale, currency: base.tenant.base_currency, outletNames: outletNames(outlets) };
  const offline = !online || error?.kind === "network";
  const mine = outlets.filter((o) => po.outlet_ids.includes(o.id)).map((o) => ({ id: o.id, name: o.name }));
  const outletName = (id: string) => outlets.find((o) => o.id === id)?.name ?? "another outlet";
  const name = (ingredientId: string) => ingredientOf(base.ingredients, ingredientId).name;

  return (
    <>
      <OfflineBanner top="staff" show={offline} text="You're offline. Showing the last update." />
      <main className="wrap staff-main space-y-5">
        <header className="space-y-2">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h1 className="section-title">Purchase order</h1>
            <button type="button" className="btn btn-plain" onClick={() => void loadOrder()}>Refresh</button>
          </div>
          <p className="flex flex-wrap items-center gap-2 text-[20px] font-semibold">
            {po.supplier.name} {po.supplier.label && <SimulatedSupplier />}
            <StatusPill tone={PO_TONE[po.status] ?? "new"}>{PO_STATUS[po.status] ?? po.status}</StatusPill>
          </p>
          <p>For {po.outlet_ids.map(outletName).join(", ")}</p>
          <p>{po.expected_on ? `Expected ${formatDate(po.expected_on, SITE.locale)}` : "No expected date"}</p>
          <p className="text-[15px] text-muted">Placed {formatDayTime(po.created_at, tz, SITE.locale)}</p>
          {approval && approval.verdict !== "rejected" && (
            <p className="text-[15px] text-muted">{VERDICT[approval.verdict]} by {personName(approval.decided_by)} · {formatDayTime(approval.decided_at, tz, SITE.locale)}</p>
          )}
        </header>

        <section aria-label="Lines" className="card space-y-3 p-5">
          <div className="overflow-x-auto">
            <table className="snap-table">
              <thead>
                <tr><th scope="col">Item</th><th scope="col" className="num">Quantity</th><th scope="col">Unit</th><th scope="col" className="num">Price per unit</th></tr>
              </thead>
              <tbody>
                {po.lines.map((l) => (
                  <tr key={l.po_line_id}>
                    <td>{name(l.ingredient_id)}</td>
                    <td className="num">{formatQty(l.qty_milli, SITE.locale)}</td>
                    <td>{l.unit}</td>
                    <td className="num">{formatMoney(l.unit_price_minor, po.currency, SITE.locale)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[20px] font-semibold">Total (worked out by Munim) <span className="num">{formatMoney(po.total_minor, po.currency, SITE.locale)}</span></p>
          <p className="text-[14px] text-muted">Recorded only — Munim does not process payments.</p>
        </section>

        {po.negotiation_run_id && (
          <details className="card p-5">
            <summary className="min-h-12 cursor-pointer font-semibold">Quotes from simulated suppliers</summary>
            <div className="mt-3">
              {quotes === null ? <div className="skeleton h-24" role="status" aria-label="Loading" />
                : quotes === "failed" ? <p className="text-muted">The quotes can&apos;t be opened.</p>
                : <QuoteTable snapshot={quotes} suppliers={base.suppliers} citedRow={null} fmt={fmt} onOpen={(snapshotId, refToken) => setDrawer({ snapshotId, refToken })} />}
            </div>
          </details>
        )}

        <section aria-labelledby="grn-title" className="space-y-3">
          <h2 id="grn-title" className="text-[24px]">Goods received</h2>
          {grns.length === 0 ? <p className="text-muted">Nothing received yet.</p> : grns.map((g) => (
            <article key={g.grn_id} className="card space-y-2 p-5">
              <p className="font-semibold">Received {formatDayTime(g.received_at, tz, SITE.locale)}{g.received_by === me.member_id ? " · recorded by you" : ""}</p>
              <div className="overflow-x-auto">
                <table className="snap-table">
                  <thead>
                    <tr><th scope="col">Item</th><th scope="col" className="num">Quantity</th><th scope="col">Unit</th><th scope="col" className="num">Cost per unit</th></tr>
                  </thead>
                  <tbody>
                    {g.lines.map((l) => (
                      <tr key={l.grn_line_id}>
                        <td>{name(l.ingredient_id)}</td>
                        <td className="num">{formatQty(l.qty_milli, SITE.locale)}</td>
                        <td>{l.unit}</td>
                        <td className="num">{formatMoney(l.unit_cost_minor, l.currency, SITE.locale)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {g.note && <p className="whitespace-pre-wrap">{g.note}</p>}
            </article>
          ))}
        </section>

        {po.status === "committed" && mine.length > 0 && (
          // Keyed on what has come in, so the form starts empty again after a part delivery.
          <ReceiveForm
            key={grns.length} po={po} grns={grns} outlets={mine} ingredients={base.ingredients} session={session} client={client} currency={po.currency}
            onAuth={handleAuth} onDone={(text) => { if (text) setToast(text); void loadOrder(); }}
          />
        )}

        <SnapshotDrawer client={client} open={drawer} onClose={() => setDrawer(null)} fmt={fmt} tz={tz} label={templateWords} />
        <Toast message={toast} />
      </main>
    </>
  );
}
