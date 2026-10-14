"use client";
// /staff/suppliers, /staff/suppliers/[supplierId] and /staff/purchase-orders/[poId] (15). Stock below its minimum,
// the AI's purchase-order proposals with the simulated suppliers' quotes behind them, a person's own purchase order,
// the orders themselves and the goods received against them. Every supplier is simulated and wears its badge; every
// amount is a row field shown as it is or a snapshot cell with its source chip. Nothing is added up or multiplied here:
// core works out every purchase order's total. Owner, manager and judge only.
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOnline } from "@/lib/hooks";
import type { MunimError } from "@/lib/munim/client";
import type { Outcome } from "@/lib/munim/draft-decision";
import { formatDate, formatDayTime, formatMoney, formatQty } from "@/lib/munim/format";
import { formatCell, snapRef, type CellFormat, type Snapshot } from "@/lib/munim/refs";
import { can } from "@/lib/munim/session";
import { RECORDED_ONLY } from "@/lib/munim/copy";
import { watchFor } from "@/lib/munim/staff-app";
import { PO_STATUS, staffErrorText } from "@/lib/munim/staff-copy";
import { topic, type LiveState } from "@/lib/munim/staff-stream";
import { templateWords } from "@/lib/munim/template-words";
import { ingredientOf, isPoDraft, lowRowsFor, quoteParams, type GoodsReceived, type PoDraft, type PurchaseOrder, type Supplier } from "@/lib/munim/supply-flow";
import type { Schemas } from "@/lib/munim/types";
import { SITE, UUID7 } from "@/lib/site";
import { ErrorNote, FullPage, Toast, useToast } from "../../ui";
import { useStaff } from "../shell";
import { CannotVerify, SimulatedSupplier, SnapshotDrawer, SourcedValue, StatusPill, type PillTone } from "../source";
import { NewPoForm } from "../suppliers/new-po";
import { PoDraftCard } from "../suppliers/po-draft";
import { QuoteTable } from "../suppliers/quotes";
import { ReceiveForm } from "../suppliers/receive";
import { LiveLine } from "./inbox";

type Ingredient = Schemas["V1InventoryIngredients"]["items"][number];
type Detail = Schemas["V1DraftDetail"] & { draft: PoDraft };
type Proposal = { detail: Detail; quotes: Snapshot | null | "failed" };
type OpenRef = (snapshotId: string, refToken: string) => void;
/** A panel's data: null while loading, an error when its call failed. */
type Panel<T> = T | MunimError | null;
const failed = <T,>(p: Panel<T>): p is MunimError => p !== null && typeof p === "object" && "kind" in p && "status" in p && !("snapshot_id" in p);

const PO_TONE: Record<string, PillTone> = { committed: "work", received: "done", cancelled: "stop" };
const NOT_FOUND = <FullPage title="Not found."><p>It may have been removed, or it isn&apos;t in your outlets.</p></FullPage>;

function NotForRole() {
  return (
    <FullPage title="Suppliers are for the owner and managers." action={<Link href="/staff" className="btn btn-primary">Go to my screen</Link>}>
      <p>Ask the owner if you need something ordered.</p>
    </FullPage>
  );
}

function RetryLine({ error, onRetry }: { error: MunimError; onRetry: () => void }) {
  return (
    <div className="space-y-2">
      <ErrorNote>{staffErrorText(error, "suppliers")}</ErrorNote>
      <button type="button" className="btn btn-plain" onClick={onRetry}>Try again</button>
    </div>
  );
}

/** A supplier's name, always with its "Simulated supplier" badge when it is one. */
function SupplierName({ s }: { s: { name: string; label: string | null } | undefined }) {
  if (!s) return <span>A supplier no longer listed</span>;
  return <span className="inline-flex flex-wrap items-center gap-2">{s.name} {s.label && <SimulatedSupplier />}</span>;
}

/** One purchase-order row (the list on /staff/suppliers and on a supplier's page). */
function PoRow({ po, tz }: { po: PurchaseOrder; tz: string }) {
  return (
    <li>
      <Link href={`/staff/purchase-orders/${po.po_id}`} className="card card-link grid gap-1 p-4 no-underline">
        <span className="flex flex-wrap items-center gap-2 text-[18px] font-semibold">
          <SupplierName s={po.supplier} />
          <StatusPill tone={PO_TONE[po.status] ?? "work"}>{PO_STATUS[po.status] ?? po.status}</StatusPill>
        </span>
        <span className="text-muted">{po.expected_on ? `Expected ${formatDate(po.expected_on, SITE.locale)}` : "No expected date"} · Placed {formatDayTime(po.created_at, tz, SITE.locale)}</span>
        <span><span className="num font-semibold">{formatMoney(po.total_minor, po.currency, SITE.locale)}</span> <span className="text-[14px] text-muted">{RECORDED_ONLY}</span></span>
      </Link>
    </li>
  );
}

/** "Offline" bar for all three screens. */
const Offline = ({ show }: { show: boolean }) => (show ? <div className="offline-bar" role="status">You&apos;re offline. Showing the last update.</div> : null);

// =============================================================== /staff/suppliers
export function SuppliersScreen() {
  const { session, outlet } = useStaff();
  if (!can(session, "suppliers")) return <NotForRole />;
  if (!outlet) return <main className="wrap staff-main"><div className="state-box" role="status">Loading</div></main>;
  return <Suppliers key={outlet.id} />;
}

function Suppliers() {
  const { session, client, outlet: chosen, outlets, handleAuth } = useStaff();
  const outlet = chosen!;
  const router = useRouter();
  const online = useOnline();
  const [toast, say] = useToast();
  const [tenant, setTenant] = useState<Schemas["V1Tenant"] | null>(null);
  const [suppliers, setSuppliers] = useState<Panel<Supplier[]>>(null);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [pos, setPos] = useState<Panel<PurchaseOrder[]>>(null);
  const [low, setLow] = useState<Panel<Snapshot>>(null);
  const [proposals, setProposals] = useState<Panel<Proposal[]>>(null);
  const [approved, setApproved] = useState<string | null>(null);
  const [newPo, setNewPo] = useState<{ prefill: string | null; n: number } | null>(null);
  const [netDown, setNetDown] = useState(false);
  const [live, setLive] = useState<LiveState>("connecting");
  const [drawer, setDrawer] = useState<{ snapshotId: string; refToken: string } | null>(null);
  const formRef = useRef<HTMLElement>(null);

  const seen = useCallback((e: MunimError): MunimError | null => {
    if (handleAuth(e)) return null;
    if (e.kind === "network") setNetDown(true);
    return e;
  }, [handleAuth]);

  const loadPos = useCallback(async () => {
    const r = await client.listPurchaseOrders();
    if (r.ok) { setNetDown(false); setPos(r.data.items.filter((p) => p.outlet_ids.includes(outlet.id))); return; }
    const e = seen(r.error);
    if (e) setPos((was) => (was && !failed(was) ? was : e));
  }, [client, outlet.id, seen]);

  const mintLow = useCallback(async () => {
    const r = await client.mintSnapshot({ template_id: "inventory.below_reorder", params: {} });
    if (r.ok) setLow(r.data);
    else { const e = seen(r.error); if (e) setLow(e); }
  }, [client, seen]);

  /** The proposals chain (15 §3): proposed POs for this outlet, each one's detail, then one quote snapshot per run. */
  const loadProposals = useCallback(async () => {
    const list = await client.listDrafts({ status: "proposed", outlet: outlet.id });
    if (!list.ok) { const e = seen(list.error); if (e) setProposals((was) => (was && !failed(was) ? was : e)); return; }
    const details = await Promise.all(list.data.items.filter((i) => isPoDraft(i.draft)).map((i) => client.getDraft(i.draft.draft_id)));
    const kept = details.flatMap((d) => (d.ok && isPoDraft(d.data.draft) && d.data.draft.status === "proposed" ? [d.data as Detail] : (d.ok ? [] : (seen(d.error), []))));
    const runs = [...new Set(kept.flatMap((d) => (d.draft.payload.negotiation_run_id ? [d.draft.payload.negotiation_run_id] : [])))];
    const minted = new Map(await Promise.all(runs.map(async (run) => {
      const r = await client.mintSnapshot({ template_id: "purchasing.quote_compare", params: quoteParams(run) });
      return [run, r.ok ? r.data : "failed"] as const;
    })));
    setProposals(kept.map((detail) => ({ detail, quotes: detail.draft.payload.negotiation_run_id ? (minted.get(detail.draft.payload.negotiation_run_id) ?? "failed") : "failed" })));
  }, [client, outlet.id, seen]);

  const loadSuppliers = useCallback(async () => {
    const r = await client.listSuppliers();
    if (r.ok) setSuppliers(r.data.items);
    else { const e = seen(r.error); if (e) setSuppliers(e); }
  }, [client, seen]);

  useEffect(() => {
    void client.getTenant().then((r) => (r.ok ? setTenant(r.data) : seen(r.error)));
    void client.listIngredients().then((r) => (r.ok ? setIngredients(r.data.items) : seen(r.error)));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount and on an outlet change
    void loadSuppliers();
    void loadPos();
    void mintLow();
    void loadProposals();
  }, [client, seen, loadSuppliers, loadPos, mintLow, loadProposals]);

  // inbox:<tenant> (owner and manager): a proposal decided on another tablet leaves the list.
  useEffect(() => watchFor(session, [topic.inbox(session.tenantId)], () => void loadProposals(), setLive), [session, loadProposals]);

  const refresh = useCallback(() => { void loadPos(); void loadProposals(); }, [loadPos, loadProposals]);
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  const onOutcome = (o: Outcome) => {
    if (o.kind === "signed_out") { handleAuth(o.error); return; }
    if (o.kind === "done" && o.type === "purchasing.po.create.v1") { setApproved(o.entityId); say("Approved. The purchase order is recorded."); }
    if (o.kind === "done" && o.type === "drafts.reject.v1") say("Rejected. Nothing was ordered.");
    if (o.kind === "stale") say("The numbers behind this changed since it was proposed. It can no longer be approved; reject it or wait for a new one.");
    if (o.kind === "decided_elsewhere") say("Someone else already decided this. It has been refreshed.");
    if (o.kind === "cannot_verify") say("Cannot verify — some numbers in this draft no longer trace to their source rows.");
    void loadProposals();
    void loadPos();
  };
  const openForm = (prefill: string | null) => {
    setNewPo((p) => ({ prefill, n: (p?.n ?? 0) + 1 }));
    requestAnimationFrame(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };

  const tz = outlet.tz;
  const fmt: CellFormat | null = tenant ? { locale: SITE.locale, currency: tenant.base_currency } : null;
  const open: OpenRef = (snapshotId, refToken) => setDrawer({ snapshotId, refToken });
  const supplierList = suppliers && !failed(suppliers) ? suppliers : [];
  const outletName = (id: string) => outlets.find((o) => o.id === id)?.name ?? "another outlet";

  return (
    <main className="pb-12">
      <Offline show={!online || netDown} />
      <div className="wrap staff-main space-y-6">
        <header className="space-y-2">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h1 className="section-title">Suppliers</h1>
            <div className="flex flex-wrap items-center gap-2">
              <LiveLine state={live} onRefresh={refresh} />
              <button type="button" className="btn btn-primary" onClick={() => openForm(null)}>New purchase order</button>
              <button type="button" className="btn btn-plain" onClick={refresh}>Refresh</button>
            </div>
          </div>
          <p className="font-semibold">Every supplier here is simulated. Quotes and orders are part of the demo; nothing is sent to a real business.</p>
        </header>

        <div className="grid items-start gap-6 min-[1100px]:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
          <div className="grid min-w-0 gap-8">
            <section aria-labelledby="low-title" className="space-y-3">
              <h2 id="low-title" className="text-[26px]">Running low</h2>
              {low === null || !fmt ? <div className="skeleton h-28" role="status" aria-label="Loading" />
                : failed(low) ? <RetryLine error={low} onRetry={() => void mintLow()} />
                : lowRowsFor(low, outlet.id).length === 0 ? <p className="text-muted">Nothing at {outlet.name} is below its minimum.</p>
                : (
                  <ul className="grid gap-3">
                    {lowRowsFor(low, outlet.id).map((r) => {
                      const unit = ingredientOf(ingredients, r.ingredientId).baseUnit;
                      const cell = (column: string) => {
                        const v = low.rows[r.row]?.[column];
                        return v === undefined ? <CannotVerify /> : <SourcedValue text={`${formatCell(v, column, fmt)} ${unit}`.trim()} refToken={snapRef(low.snapshot_id, r.row, column)} onOpen={open} />;
                      };
                      return (
                        <li key={r.ingredientId} className="card grid gap-2 p-4 sm:grid-cols-[1fr_auto] sm:items-center">
                          <div className="space-y-1">
                            <p className="text-[19px] font-semibold">{r.name || ingredientOf(ingredients, r.ingredientId).name}</p>
                            <p>On hand {cell("on_hand_milli")} · Minimum {cell("min_qty_milli")} · Par {cell("par_qty_milli")}</p>
                          </div>
                          <button type="button" className="btn btn-plain" onClick={() => openForm(r.ingredientId)}>Order this</button>
                        </li>
                      );
                    })}
                  </ul>
                )}
            </section>

            <section aria-labelledby="proposals-title" className="space-y-3">
              <h2 id="proposals-title" className="text-[26px]">Proposed by Munim</h2>
              {approved && (
                <p className="card flex flex-wrap items-center gap-3 p-4 font-semibold" role="status">
                  Approved. The purchase order is recorded. <Link href={`/staff/purchase-orders/${approved}`} className="btn btn-plain">Open the purchase order</Link>
                </p>
              )}
              {proposals === null || !fmt ? <div className="skeleton h-64" role="status" aria-label="Loading" />
                : failed(proposals) ? <RetryLine error={proposals} onRetry={() => void loadProposals()} />
                : proposals.length === 0 ? <p className="text-muted">No proposals waiting.</p>
                : proposals.map((p) => (
                  <PoDraftCard key={p.detail.draft.draft_id} detail={p.detail} quotes={p.quotes} suppliers={supplierList} ingredients={ingredients} outletName={outletName}
                    session={session} client={client} fmt={fmt} tz={tz} onOpen={open} onOutcome={onOutcome} />
                ))}
            </section>

            {newPo && tenant && (
              <section ref={formRef} className="scroll-mt-36" aria-label="New purchase order">
                <NewPoForm key={`${newPo.prefill ?? "blank"}:${newPo.n}`} suppliers={supplierList} ingredients={ingredients} outletId={outlet.id} currency={tenant.base_currency}
                  locale={SITE.locale} tz={tz} prefillIngredient={newPo.prefill} session={session} client={client} onAuth={handleAuth}
                  onCreated={(poId) => router.push(`/staff/purchase-orders/${poId}`)} />
              </section>
            )}

            <section aria-labelledby="pos-title" className="space-y-3">
              <h2 id="pos-title" className="text-[26px]">Purchase orders</h2>
              {pos === null ? <div className="skeleton h-40" role="status" aria-label="Loading" />
                : failed(pos) ? <RetryLine error={pos} onRetry={() => void loadPos()} />
                : pos.length === 0 ? <div className="state-box"><p>No purchase orders yet.</p></div>
                : <ul className="grid gap-3">{pos.map((po) => <PoRow key={po.po_id} po={po} tz={tz} />)}</ul>}
            </section>
          </div>

          <aside aria-labelledby="suppliers-title" className="space-y-3 min-[1100px]:sticky min-[1100px]:top-[132px]">
            <h2 id="suppliers-title" className="text-[26px]">Suppliers</h2>
            {suppliers === null ? <div className="skeleton h-40" role="status" aria-label="Loading" />
              : failed(suppliers) ? <RetryLine error={suppliers} onRetry={() => void loadSuppliers()} />
              : suppliers.length === 0 ? <p className="text-muted">No suppliers yet.</p>
              : (
                <ul className="grid gap-3">
                  {suppliers.map((s) => (
                    <li key={s.supplier_id}>
                      <Link href={`/staff/suppliers/${s.supplier_id}`} className="card card-link grid gap-1 p-4 no-underline">
                        <span className="font-semibold"><SupplierName s={s} /></span>
                        {s.payment_days !== null && s.payment_days > 0 && <span className="text-muted">Pay within {s.payment_days} days</span>}
                        {!s.active && <span className="pill pill-done justify-self-start">Not active</span>}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
          </aside>
        </div>
      </div>
      {fmt && <SnapshotDrawer client={client} open={drawer} onClose={() => setDrawer(null)} fmt={fmt} tz={tz} label={templateWords} />}
      <Toast message={toast} />
    </main>
  );
}

// =============================================================== /staff/suppliers/[supplierId]
export function SupplierScreen() {
  const { session, outlet } = useStaff();
  const { supplierId } = useParams<{ supplierId: string }>();
  if (!can(session, "suppliers")) return <NotForRole />;
  if (!UUID7.test(supplierId)) return NOT_FOUND;
  if (!outlet) return <main className="wrap staff-main"><div className="state-box" role="status">Loading</div></main>;
  return <SupplierPage key={`${supplierId}:${outlet.id}`} supplierId={supplierId} />;
}

function SupplierPage({ supplierId }: { supplierId: string }) {
  const { session, client, outlet: chosen, handleAuth } = useStaff();
  const outlet = chosen!;
  const router = useRouter();
  const online = useOnline();
  const [supplier, setSupplier] = useState<Panel<Supplier>>(null);
  const [tenant, setTenant] = useState<Schemas["V1Tenant"] | null>(null);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [pos, setPos] = useState<Panel<PurchaseOrder[]>>(null);
  const [form, setForm] = useState(false);

  const load = useCallback(async () => {
    const [s, t, i, p] = await Promise.all([client.getSupplier(supplierId), client.getTenant(), client.listIngredients(), client.listPurchaseOrders()]);
    if (t.ok) setTenant(t.data);
    if (i.ok) setIngredients(i.data.items);
    if (s.ok) setSupplier(s.data);
    else if (!handleAuth(s.error)) setSupplier(s.error);
    if (p.ok) setPos(p.data.items.filter((x) => x.supplier.supplier_id === supplierId));
    else if (!handleAuth(p.error)) setPos(p.error);
  }, [client, supplierId, handleAuth]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount
    void load();
  }, [load]);

  if (failed(supplier) && supplier.kind === "not_found") return NOT_FOUND;
  const tz = outlet.tz;
  return (
    <main className="pb-12">
      <Offline show={!online || (failed(supplier) && supplier.kind === "network")} />
      <div className="wrap staff-main space-y-6">
        <p><Link href="/staff/suppliers">← Suppliers</Link></p>
        {supplier === null ? <div className="skeleton h-24" role="status" aria-label="Loading" />
          : failed(supplier) ? <RetryLine error={supplier} onRetry={() => void load()} />
          : (
            <>
              <header className="space-y-2">
                <h1 className="section-title"><SupplierName s={supplier} /></h1>
                {supplier.payment_days !== null && supplier.payment_days > 0 && <p>Pay within {supplier.payment_days} days</p>}
                {supplier.notes && <p className="text-muted">{supplier.notes}</p>}
                {!supplier.active && <span className="pill pill-done">Not active</span>}
              </header>

              <section aria-labelledby="prices-title" className="card space-y-3 p-5">
                <h2 id="prices-title" className="text-[24px]">Price list</h2>
                {supplier.prices.length === 0 ? <p className="text-muted">No prices recorded.</p> : (
                  <div className="overflow-x-auto">
                    <table className="snap-table">
                      <thead><tr><th scope="col">Item</th><th scope="col">Unit</th><th scope="col" className="num">Price per unit</th><th scope="col">Seen on</th><th scope="col">Source</th></tr></thead>
                      <tbody>
                        {supplier.prices.map((p) => (
                          <tr key={p.price_id}>
                            <td>{ingredientOf(ingredients, p.ingredient_id).name}</td>
                            <td>{p.unit}</td>
                            <td className="num">{formatMoney(p.unit_price_minor, p.currency, SITE.locale)}</td>
                            <td>{formatDayTime(p.observed_at, tz, SITE.locale)}</td>
                            <td>{p.source_ref}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <section aria-labelledby="supplier-pos" className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 id="supplier-pos" className="text-[24px]">Purchase orders</h2>
                  {supplier.active && <button type="button" className="btn btn-primary" onClick={() => setForm(true)}>New purchase order</button>}
                </div>
                {form && tenant && (
                  <NewPoForm suppliers={[supplier]} ingredients={ingredients} outletId={outlet.id} currency={tenant.base_currency} locale={SITE.locale} tz={tz}
                    prefillIngredient={null} session={session} client={client} onAuth={handleAuth} onCreated={(poId) => router.push(`/staff/purchase-orders/${poId}`)} />
                )}
                {pos === null ? <div className="skeleton h-28" role="status" aria-label="Loading" />
                  : failed(pos) ? <RetryLine error={pos} onRetry={() => void load()} />
                  : pos.length === 0 ? <div className="state-box"><p>No purchase orders yet.</p></div>
                  : <ul className="grid gap-3">{pos.map((po) => <PoRow key={po.po_id} po={po} tz={tz} />)}</ul>}
              </section>
            </>
          )}
      </div>
    </main>
  );
}

// =============================================================== /staff/purchase-orders/[poId]
export function PurchaseOrderScreen() {
  const { session, outlet } = useStaff();
  const { poId } = useParams<{ poId: string }>();
  if (!can(session, "suppliers")) return <NotForRole />;
  if (!UUID7.test(poId)) return NOT_FOUND;
  if (!outlet) return <main className="wrap staff-main"><div className="state-box" role="status">Loading</div></main>;
  return <PurchaseOrderPage key={poId} poId={poId} />;
}

function PurchaseOrderPage({ poId }: { poId: string }) {
  const { session, client, outlet: chosen, outlets, handleAuth } = useStaff();
  const outlet = chosen!;
  const online = useOnline();
  const [toast, say] = useToast();
  const [po, setPo] = useState<Panel<PurchaseOrder>>(null);
  const [tenant, setTenant] = useState<Schemas["V1Tenant"] | null>(null);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [grns, setGrns] = useState<Panel<GoodsReceived[]>>(null);
  const [quotes, setQuotes] = useState<Snapshot | "failed" | null>(null);
  const [drawer, setDrawer] = useState<{ snapshotId: string; refToken: string } | null>(null);

  const loadPo = useCallback(async () => {
    const [p, g] = await Promise.all([client.getPurchaseOrder(poId), client.listGoodsReceived()]);
    if (p.ok) setPo(p.data);
    else if (!handleAuth(p.error)) setPo((was) => (was && !failed(was) && p.error.kind !== "not_found" ? was : p.error));
    if (g.ok) setGrns(g.data.items.filter((x) => x.po_id === poId));
    else if (!handleAuth(g.error)) setGrns((was) => (was && !failed(was) ? was : g.error));
    return p.ok ? p.data : null;
  }, [client, poId, handleAuth]);

  useEffect(() => {
    void client.getTenant().then((r) => r.ok && setTenant(r.data));
    void client.listIngredients().then((r) => r.ok && setIngredients(r.data.items));
    void client.listSuppliers().then((r) => r.ok && setSuppliers(r.data.items));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; the quotes follow the order
    void loadPo().then((p) => {
      if (!p?.negotiation_run_id) return;
      void client.mintSnapshot({ template_id: "purchasing.quote_compare", params: quoteParams(p.negotiation_run_id) }).then((r) => setQuotes(r.ok ? r.data : "failed"));
    });
  }, [client, loadPo]);
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") void loadPo(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [loadPo]);

  if (failed(po) && po.kind === "not_found") return NOT_FOUND;
  const tz = outlet.tz;
  const fmt: CellFormat | null = tenant ? { locale: SITE.locale, currency: tenant.base_currency } : null;
  const mine = (id: string) => outlets.find((o) => o.id === id);
  const open: OpenRef = (snapshotId, refToken) => setDrawer({ snapshotId, refToken });

  return (
    <main className="pb-12">
      <Offline show={!online || (failed(po) && po.kind === "network")} />
      <div className="wrap staff-main space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Link href="/staff/suppliers">← Suppliers</Link>
          <button type="button" className="btn btn-plain" onClick={() => void loadPo()}>Refresh</button>
        </div>
        {po === null ? <div className="skeleton h-60" role="status" aria-label="Loading" />
          : failed(po) ? <RetryLine error={po} onRetry={() => void loadPo()} />
          : (
            <>
              <header className="space-y-2">
                <h1 className="section-title">Purchase order</h1>
                <p className="flex flex-wrap items-center gap-2 text-[20px] font-semibold">
                  <SupplierName s={po.supplier} />
                  <StatusPill tone={PO_TONE[po.status] ?? "work"}>{PO_STATUS[po.status] ?? po.status}</StatusPill>
                </p>
                <p>For {po.outlet_ids.map((id) => mine(id)?.name ?? "another outlet").join(", ")}</p>
                <p className="text-muted">{po.expected_on ? `Expected ${formatDate(po.expected_on, SITE.locale)}` : "No expected date"} · Placed {formatDayTime(po.created_at, tz, SITE.locale)}</p>
              </header>

              <section aria-label="Lines" className="card space-y-3 p-5">
                <div className="overflow-x-auto">
                  <table className="snap-table">
                    <thead><tr><th scope="col">Item</th><th scope="col" className="num">Quantity</th><th scope="col">Unit</th><th scope="col" className="num">Price per unit</th></tr></thead>
                    <tbody>
                      {po.lines.map((l) => (
                        <tr key={l.po_line_id}>
                          <td>{ingredientOf(ingredients, l.ingredient_id).name}</td>
                          <td className="num">{formatQty(l.qty_milli, SITE.locale)}</td>
                          <td>{l.unit}</td>
                          <td className="num">{formatMoney(l.unit_price_minor, po.currency, SITE.locale)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-[19px]">Total (worked out by Munim) <span className="num font-bold">{formatMoney(po.total_minor, po.currency, SITE.locale)}</span></p>
                <p className="text-[14px] text-muted">{RECORDED_ONLY}</p>
                {po.negotiation_run_id && (
                  <details>
                    <summary className="min-h-12 cursor-pointer font-semibold">Compare the quotes</summary>
                    <div className="mt-3">
                      {quotes === null || !fmt ? <div className="skeleton h-24" role="status" aria-label="Loading" />
                        : quotes === "failed" ? <p className="text-muted">The quotes can&apos;t be opened.</p>
                        : <QuoteTable snapshot={quotes} suppliers={suppliers} citedQuoteId={null} fmt={fmt} onOpen={open} />}
                    </div>
                  </details>
                )}
              </section>

              <section aria-labelledby="grn-title" className="space-y-3">
                <h2 id="grn-title" className="text-[24px]">Goods received</h2>
                {grns === null ? <div className="skeleton h-24" role="status" aria-label="Loading" />
                  : failed(grns) ? <RetryLine error={grns} onRetry={() => void loadPo()} />
                  : grns.length === 0 ? <p className="text-muted">Nothing received yet.</p>
                  : grns.map((g) => (
                    <article key={g.grn_id} className="card space-y-2 p-4">
                      <p className="font-semibold">Received {formatDayTime(g.received_at, tz, SITE.locale)}{g.received_by === session.me.member_id ? " · recorded by you" : ""}</p>
                      <ul className="space-y-1">
                        {g.lines.map((l) => (
                          <li key={l.grn_line_id}>
                            {ingredientOf(ingredients, l.ingredient_id).name} · <span className="num">{formatQty(l.qty_milli, SITE.locale)}</span> {l.unit} · Cost per unit <span className="num">{formatMoney(l.unit_cost_minor, l.currency, SITE.locale)}</span>
                          </li>
                        ))}
                      </ul>
                      {g.note && <p className="text-muted">{g.note}</p>}
                    </article>
                  ))}
              </section>

              {po.status === "committed" && tenant && grns !== null && !failed(grns) && (
                <ReceiveForm po={po} grns={grns} outlets={po.outlet_ids.flatMap((id) => (mine(id) ? [{ id, name: mine(id)!.name }] : []))} ingredients={ingredients}
                  session={session} client={client} currency={tenant.base_currency} onAuth={handleAuth}
                  onDone={(text) => { if (text) say(text); void loadPo(); }} />
              )}
            </>
          )}
      </div>
      {fmt && <SnapshotDrawer client={client} open={drawer} onClose={() => setDrawer(null)} fmt={fmt} tz={tz} label={templateWords} />}
      <Toast message={toast} />
    </main>
  );
}
