"use client";
// "/o/[outletId]/order/[orderId]": live order tracking. The SSE stream wakes us up, the order read is the truth,
// polling covers stream outages. Only the server moves status.
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { API_BASE, munim, STOREFRONT_KEY } from "@/lib/munim";
import { payAtCounterText, RECORDED_ONLY, STATUS_LABEL } from "@/lib/munim/copy";
import { formatQty, formatWhen, titleCase } from "@/lib/munim/format";
import { loadGuestToken } from "@/lib/munim/storage";
import { trackOrder, type OrderView } from "@/lib/munim/track";
import type { Schemas } from "@/lib/munim/types";
import { SITE, UUID7 } from "@/lib/site";
import { useOnline } from "@/lib/hooks";
import { findItem, money } from "../cart-bits";
import { CheckIcon, Dot, PhoneIcon, PinIcon } from "../icons";
import { NotValid, OfflineBanner, OutletContact, SiteHeader } from "../ui";

type Menu = Schemas["StorefrontMenuResponse"];
type Outlets = Schemas["StorefrontOutletsResponse"];

const STEPS = ["placed", "accepted", "preparing", "ready", "completed"] as const;
const FINAL = new Set(["completed", "rejected", "cancelled"]);

export function statusLine(o: OrderView): string {
  switch (o.status) {
    case "placed": return "Order placed. Waiting for the kitchen to accept it.";
    case "accepted": return "The kitchen accepted your order.";
    case "preparing": return "Your order is being prepared.";
    case "ready": return "Your order is ready for pickup.";
    case "completed": return "Picked up. Enjoy!";
    case "rejected": {
      const ev = [...o.events].reverse().find((e) => e.to_status === "rejected");
      return ev?.reason ? `Sorry — the outlet couldn't take this order: ${titleCase(ev.reason)}.` : "Sorry — the outlet couldn't take this order.";
    }
    case "cancelled": return "This order was cancelled.";
    default: return "Order placed.";
  }
}

/** The kitchen pushed the time back: the latest promised_at event moved it later, for a reason other than the customer. */
export function pushedBack(o: OrderView): string | null {
  const ev = [...o.events].reverse().find((e) => e.kind === "promised_at");
  if (!ev || !ev.from_promised_at || !ev.to_promised_at || ev.reason === "customer_rescheduled") return null;
  return new Date(ev.to_promised_at) > new Date(ev.from_promised_at) ? ev.from_promised_at : null;
}

export function TrackerPage() {
  const { outletId, orderId } = useParams<{ outletId: string; orderId: string }>();
  const [token, setToken] = useState<string | null | undefined>(undefined);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is only readable after hydration
  useEffect(() => setToken(UUID7.test(orderId) ? loadGuestToken(orderId) : null), [orderId]);
  if (!UUID7.test(outletId) || !UUID7.test(orderId)) return <><SiteHeader /><NotValid /></>;
  if (token === undefined) return <><SiteHeader /><TrackerSkeleton /></>;
  if (token === null) return <><SiteHeader /><NotValid extra="Orders can be followed only on the device that placed them." /></>;
  return <TrackerView outletId={outletId} orderId={orderId} token={token} />;
}

function TrackerView({ outletId, orderId, token }: { outletId: string; orderId: string; token: string }) {
  const online = useOnline();
  const [order, setOrder] = useState<OrderView | null>(null);
  const [live, setLive] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [readError, setReadError] = useState<"network" | "other" | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [outlets, setOutlets] = useState<Outlets | null>(null);

  useEffect(() => {
    void munim.getMenu(outletId).then((r) => r.ok && setMenu(r.data));
    void munim.listOutlets().then((r) => r.ok && setOutlets(r.data));
    return trackOrder({
      client: munim,
      baseUrl: API_BASE,
      storefrontKey: STOREFRONT_KEY,
      orderId,
      guestToken: token,
      onOrder: (o) => { setOrder(o); setReadError(null); },
      onLive: setLive,
      onNotFound: () => setNotFound(true),
      onError: setReadError,
    });
  }, [outletId, orderId, token]);

  if (notFound) return <><SiteHeader /><NotValid /></>;
  if (!order) return <><SiteHeader /><OfflineBanner show={!online} text="You're offline. Showing the last update." /><TrackerSkeleton /></>;

  const outlet = outlets?.outlets.find((o) => o.outlet_id === order.outlet_id) ?? null;
  const tz = menu?.accepting.tz ?? "Asia/Kolkata";
  const final = FINAL.has(order.status);
  const offPath = order.status === "rejected" || order.status === "cancelled";
  const stepIndex = STEPS.indexOf(order.status as (typeof STEPS)[number]);
  const was = pushedBack(order);

  return (
    <>
      <SiteHeader />
      <OfflineBanner show={!online || readError === "network"} text="You're offline. Showing the last update." />
      <main className="wrap max-w-[688px] pb-10 pt-8">
        <p className="badge badge-accent">Pickup order</p>
        <h1 className="num mt-3 text-[clamp(40px,9vw,64px)]">Order #{order.ticket_no}</h1>
        <p className="mt-3 text-[20px] font-semibold" aria-live="polite">{statusLine(order)}</p>
        {readError === "other" && <p className="mt-2 text-muted">Can&apos;t load your order right now. It is still placed.</p>}

        {!final && (
          <p className="mt-3 inline-flex items-center gap-2 text-[14px] font-semibold">
            {live ? <><Dot className="bg-ok" /> Live</> : <span className="text-muted">Updating…</span>}
          </p>
        )}

        {!offPath && (
          <ol className="mt-8 grid grid-cols-5 gap-1" aria-label="Order progress">
            {STEPS.map((s, i) => {
              const done = stepIndex > i;
              const now = stepIndex === i;
              return (
                <li key={s} className="relative flex flex-col items-center text-center" aria-current={now ? "step" : undefined}>
                  {i > 0 && <span aria-hidden="true" className={`absolute right-1/2 top-[15px] h-[2px] w-full ${stepIndex >= i ? "bg-ink" : "bg-line/50"}`} />}
                  <span
                    key={now ? `${s}-now` : s}
                    className={`relative z-10 grid h-8 w-8 place-items-center rounded-full border-[1.5px] ${now ? "step-now border-primary bg-primary text-on-primary" : done ? "border-ink bg-ink text-white" : "border-line bg-card"}`}
                  >
                    {done ? <CheckIcon size={16} /> : now ? <span className="h-2 w-2 rounded-full bg-white" /> : null}
                  </span>
                  <span className={`mt-2 text-[14px] ${now ? "font-bold" : done ? "" : "text-muted"}`}>{STATUS_LABEL[s]}</span>
                </li>
              );
            })}
          </ol>
        )}

        {!final && order.promised_at && (
          <p className="num mt-8 text-[18px]">
            Ready at about <strong>{formatWhen(order.promised_at, tz, SITE.locale)}</strong>
            {was && <span className="text-muted"> (was {formatWhen(was, tz, SITE.locale)}) The kitchen pushed this back.</span>}
          </p>
        )}

        <section className="card mt-6 p-6" aria-labelledby="order-h">
          <h2 id="order-h" className="text-[24px]">Your order</h2>
          <ul className="mt-4 space-y-3">
            {order.lines.map((l) => {
              const item = findItem(menu, l.item_id);
              const variant = item?.variants.find((v) => v.variant_id === l.variant_id);
              return (
                <li key={l.line_no} className="flex justify-between gap-3">
                  <div>
                    <p className="font-bold">{item ? (item.display_name ?? titleCase(item.name_key)) : "Item"}</p>
                    {variant && <p className="text-[14px] text-muted">{variant.display_name ?? titleCase(variant.name_key)}</p>}
                  </div>
                  <p className="num whitespace-nowrap">{formatQty(l.qty_milli, SITE.locale)} × {money(l.unit_price_minor, order.currency)}</p>
                </li>
              );
            })}
          </ul>
          <dl className="num mt-5 space-y-2 border-t-[1.5px] border-bg-deep pt-4">
            <div className="flex justify-between"><dt>Subtotal</dt><dd>{money(order.subtotal_minor, order.currency)}</dd></div>
            {order.discount_minor > 0 && <div className="flex justify-between text-ok"><dt>Discount</dt><dd>−{money(order.discount_minor, order.currency)}</dd></div>}
            <div className="flex justify-between text-muted"><dt>{order.prices_include_tax ? "Includes tax" : "Tax"}</dt><dd>{money(order.tax_minor, order.currency)}</dd></div>
            <div className="flex justify-between border-t-[1.5px] border-line pt-3 text-[20px] font-bold"><dt>Total</dt><dd>{money(order.total_minor, order.currency)}</dd></div>
          </dl>
        </section>

        <section className="card mt-6 space-y-2 p-6" aria-label="Payment and changes">
          <p className="font-semibold">{payAtCounterText(outlets?.pay_at_counter_methods ?? null)}</p>
          <p className="text-muted">{RECORDED_ONLY}</p>
          <p className="pt-3 font-semibold">Call the outlet to change this order</p>
          {outlet?.phone ? (
            <a href={`tel:${outlet.phone}`} className="inline-flex min-h-12 items-center gap-2 font-semibold"><PhoneIcon size={20} /> {outlet.phone}</a>
          ) : outlet ? (
            <p className="flex items-start gap-2 text-muted"><PinIcon size={20} className="mt-0.5 flex-none" />{outlet.address}</p>
          ) : null}
        </section>
        <Link href={`/o/${outletId}`} className="btn btn-plain mt-6">Back to the menu</Link>
      </main>
      <OutletContact outlet={outlet} />
    </>
  );
}

function TrackerSkeleton() {
  return (
    <div className="wrap max-w-[688px] pt-8" aria-busy="true">
      <div className="skeleton h-12 w-2/3" />
      <div className="skeleton mt-4 h-6 w-4/5" />
      <div className="card mt-8 h-[260px] p-6"><div className="skeleton h-6 w-1/3" /><div className="skeleton mt-4 h-4" /><div className="skeleton mt-2 h-4" /></div>
    </div>
  );
}
