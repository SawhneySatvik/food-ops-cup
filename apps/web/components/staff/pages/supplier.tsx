// file: components/staff/pages/supplier.tsx
"use client";
// /staff/suppliers/[supplierId] (15): one simulated supplier, its recorded prices (row fields, shown as they are), its
// purchase orders touching this outlet, and a new purchase order to it. Owners and managers only.
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useOnline } from "@/lib/hooks";
import type { MunimError } from "@/lib/munim/client";
import { dayKey, formatDate, formatMoney } from "@/lib/munim/format";
import { can } from "@/lib/munim/session";
import { staffErrorText } from "@/lib/munim/staff-copy";
import { ingredientOf, type PurchaseOrder, type Supplier } from "@/lib/munim/supply-flow";
import type { Schemas } from "@/lib/munim/types";
import { SITE, UUID7 } from "@/lib/site";
import { useStaff } from "../shell";
import { SimulatedSupplier } from "../source";
import { NewPoForm } from "../suppliers/new-po";
import { ErrorNote } from "../../ui";
import { NotForSuppliers, NotFoundPage, PanelWait, PoRow } from "./suppliers";

type Outlet = Schemas["V1Outlets"]["outlets"][number];

export function SupplierScreen() {
  const { supplierId } = useParams<{ supplierId: string }>();
  const { session, outlet } = useStaff();
  if (!can(session, "suppliers")) return <NotForSuppliers />;
  if (!UUID7.test(supplierId)) return <NotFoundPage />;
  if (!outlet) return <main className="wrap staff-main"><div className="state-box" role="status">Loading</div></main>;
  return <SupplierOutlet key={`${outlet.id}:${supplierId}`} outlet={outlet} supplierId={supplierId} />;
}

function SupplierOutlet({ outlet, supplierId }: { outlet: Outlet; supplierId: string }) {
  const { session, client, handleAuth } = useStaff();
  const router = useRouter();
  const [supplier, setSupplier] = useState<Supplier | "not_found" | null>(null);
  const [tenant, setTenant] = useState<Schemas["V1Tenant"] | null>(null);
  const [ingredients, setIngredients] = useState<Schemas["V1InventoryIngredients"]["items"] | null>(null);
  const [orders, setOrders] = useState<PurchaseOrder[] | null>(null);
  const [error, setError] = useState<MunimError | null>(null);
  const [ordersError, setOrdersError] = useState<MunimError | undefined>(undefined);
  const [form, setForm] = useState(false);
  const online = useOnline();

  const loadOrders = useCallback(async () => {
    const r = await client.listPurchaseOrders();
    if (!r.ok) {
      if (!handleAuth(r.error)) setOrdersError(r.error);
      return;
    }
    setOrders(r.data.items.filter((p) => p.supplier.supplier_id === supplierId && p.outlet_ids.includes(outlet.id)));
    setOrdersError(undefined);
  }, [client, handleAuth, supplierId, outlet.id]);

  const load = useCallback(async () => {
    void loadOrders();
    const [s, t, i] = await Promise.all([client.getSupplier(supplierId), client.getTenant(), client.listIngredients()]);
    if (!s.ok && s.error.kind === "not_found") return setSupplier("not_found");
    if (!(s.ok && t.ok && i.ok)) {
      const bad = [s, t, i].find((x) => !x.ok);
      if (bad && !bad.ok && !handleAuth(bad.error)) setError(bad.error);
      return;
    }
    setSupplier(s.data);
    setTenant(t.data);
    setIngredients(i.data.items);
    setError(null);
  }, [client, handleAuth, supplierId, loadOrders]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set after the responses
    void load();
  }, [load]);

  if (supplier === "not_found") return <NotFoundPage />;
  if (error && !supplier) {
    return (
      <main className="wrap staff-main space-y-3">
        <ErrorNote>{staffErrorText(error, "suppliers")}</ErrorNote>
        <button type="button" className="btn btn-plain" onClick={() => void load()}>Try again</button>
      </main>
    );
  }
  if (!supplier || !tenant || !ingredients) return <main className="wrap staff-main"><div className="skeleton h-96" role="status" aria-label="Loading" /></main>;

  const tz = outlet.tz;
  const offline = !online || error?.kind === "network" || ordersError?.kind === "network";

  return (
    <main className="wrap staff-main max-w-[960px] space-y-5">
      {offline && <div className="offline-bar" role="status">You&apos;re offline. Showing the last update.</div>}
      <header className="space-y-2">
        <h1 className="section-title flex flex-wrap items-center gap-3">{supplier.name} {supplier.label && <SimulatedSupplier />}</h1>
        <div className="scallop" aria-hidden="true" />
        {supplier.payment_days !== null && <p>Pay within {supplier.payment_days} days</p>}
        {supplier.notes && <p className="whitespace-pre-wrap text-muted">{supplier.notes}</p>}
        {!supplier.active && <p className="font-semibold">Not active</p>}
      </header>

      <section aria-labelledby="prices-title" className="card space-y-3 p-5">
        <h2 id="prices-title" className="text-[24px]">Price list</h2>
        {supplier.prices.length === 0 ? <p className="text-muted">No prices recorded.</p> : (
          <div className="overflow-x-auto">
            <table className="snap-table">
              <thead>
                <tr><th scope="col">Item</th><th scope="col">Unit</th><th scope="col" className="num">Price per unit</th><th scope="col">Seen on</th></tr>
              </thead>
              <tbody>
                {supplier.prices.map((p) => (
                  <tr key={p.price_id}>
                    <td>{ingredientOf(ingredients, p.ingredient_id).name}</td>
                    <td>{p.unit}</td>
                    <td className="num">{formatMoney(p.unit_price_minor, p.currency, SITE.locale)}</td>
                    <td>{formatDate(dayKey(p.observed_at, tz), SITE.locale)} <span className="text-muted">· {p.source_ref}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="orders-title" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="orders-title" className="text-[24px]">Purchase orders</h2>
          {supplier.active && <button type="button" className="btn btn-primary" onClick={() => setForm(true)}>New purchase order</button>}
        </div>
        {!orders ? <PanelWait error={ordersError} onRetry={() => void loadOrders()} height="h-32" />
          : orders.length === 0 ? <div className="state-box"><p>No purchase orders yet.</p></div>
          : <ul className="grid gap-3">{orders.map((po) => <PoRow key={po.po_id} po={po} tz={tz} />)}</ul>}
      </section>

      {form && (
        // Only this supplier is offered, so the form opens with it chosen.
        <NewPoForm
          suppliers={[supplier]} ingredients={ingredients} outletId={outlet.id} currency={tenant.base_currency} locale={SITE.locale} tz={tz}
          prefillIngredient={null} session={session} client={client} onAuth={handleAuth} onCreated={(poId) => router.push(`/staff/purchase-orders/${poId}`)}
        />
      )}
    </main>
  );
}
