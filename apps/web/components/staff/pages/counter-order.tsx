// file: components/staff/pages/counter-order.tsx
"use client";
// /staff/counter/orders/[orderId]: one order at the counter. The order as core stored it, the tender panel, the
// counter's status steps (accept / reject a web order, cancel, picked up), and the receipt. It refetches on every
// event of order:<id>; nothing is patched from an event and nothing is added up.
import Link from "next/link";
import { useParams } from "next/navigation";
import { useRef, useState } from "react";
import { useOnline } from "@/lib/hooks";
import { useOrder, useTillSetup } from "@/lib/counter-hooks";
import type { MunimError } from "@/lib/munim/client";
import { retryable } from "@/lib/munim/commands";
import { formatMoney, formatQty, formatTime } from "@/lib/munim/format";
import { can } from "@/lib/munim/session";
import { ORDER_STATUS, staffErrorText } from "@/lib/munim/staff-copy";
import { counterSteps, itemNames, KIND_LABEL, ORDER_REASONS, orderLineLabel, stepIds, writeErrorText, type StepIds } from "@/lib/munim/till";
import { SITE, UUID7 } from "@/lib/site";
import { ErrorNote, FullPage, OfflineBanner, Toast, useToast } from "../../ui";
import { ReceiptBlock, TenderPanel } from "../order-bits";
import { useStaff } from "../shell";
import { ORDER_TONE, StatusPill } from "../source";
import { NotForRole } from "./counter";

const money = (minor: number, currency: string) => formatMoney(minor, currency, SITE.locale);

export function CounterOrderPage() {
  const { orderId } = useParams<{ orderId: string }>();
  const { session } = useStaff();
  if (!can(session, "counter")) return <NotForRole />;
  if (!UUID7.test(orderId)) return <NotFound />;
  return <OrderScreen key={orderId} orderId={orderId} />;
}

const NotFound = () => (
  <FullPage title="Not found." action={<Link href="/staff/counter" className="btn btn-primary">Back to the counter</Link>}>
    <p>It may have been removed, or it isn&apos;t in your outlets.</p>
  </FullPage>
);

type Step = { verb: "accept" | "reject" | "advance"; to: "accepted" | "rejected" | "cancelled" | "completed"; reason: string | null };

function OrderScreen({ orderId }: { orderId: string }) {
  const { session, client, outlets, handleAuth } = useStaff();
  const online = useOnline();
  const [toast, say] = useToast();
  const { order, error, missing, refresh, liveOff } = useOrder(client, session, orderId, handleAuth);
  const { load } = useTillSetup(client, order?.outlet_id ?? null, handleAuth);
  const setup = load.state === "ready" ? load.data : null;
  const names = itemNames(setup?.menu.entries ?? []);
  const tz = outlets.find((o) => o.id === order?.outlet_id)?.tz ?? "UTC";
  const ids = useRef<StepIds | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [stepError, setStepError] = useState<string | null>(null);
  const [reasonFor, setReasonFor] = useState<"reject" | "cancel" | null>(null);
  const [reason, setReason] = useState<string>("");
  const [unpaidOk, setUnpaidOk] = useState(false);

  if (missing) return <NotFound />;
  if (!order) {
    if (error) return <main className="staff-main-wide"><ErrorNote>{staffErrorText(error, "counter")}</ErrorNote><button type="button" className="btn btn-plain mt-3" onClick={() => void refresh()}>Try again</button></main>;
    return <main className="staff-main-wide"><div className="skeleton h-96" role="status" aria-label="Loading" /></main>;
  }

  const steps = counterSteps(order, setup?.counter.id ?? null);
  const ended = order.status === "cancelled" || order.status === "rejected";
  const run = async (s: Step) => {
    setBusy(s.to);
    setStepError(null);
    const fp = JSON.stringify([order.order_id, order.status, s]);
    const r = await send(s, fp);
    setBusy(null);
    if (r.ok) {
      setReasonFor(null);
      setReason("");
      say(`Order #${order.ticket_no}: ${ORDER_STATUS[s.to]}`);
    } else if (!handleAuth(r.error)) setStepError(writeErrorText(r.error)); // refund_first, reason_required, a stale step, a dropped connection
    void refresh();
  };
  const send = async (s: Step, fp: string): Promise<{ ok: true } | { ok: false; error: MunimError }> => {
    const id = order.order_id;
    const { command_id, idempotency_key } = (ids.current = stepIds(ids.current, fp));
    const r = s.verb === "accept" ? await client.acceptOrder(id, { command_id, idempotency_key, type: "orders.order.accept.v1", payload: { order_id: id } })
      : s.verb === "reject" ? await client.rejectOrder(id, { command_id, idempotency_key, type: "orders.order.reject.v1", payload: { order_id: id, reason_code: s.reason ?? "" } })
      : await client.advanceOrder(id, { command_id, idempotency_key, type: "orders.order.advance.v1", payload: { order_id: id, from_status: order.status, to_status: s.to === "completed" ? "completed" : "cancelled", reason_code: s.reason } });
    if (r.ok || !retryable(r.error)) ids.current = null;
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  };

  return (
    <>
      <OfflineBanner top="staff" show={!online} text="You're offline. Showing the last update." />
      <main className="staff-main-wide">
        <div className="pos">
          <section className="card grid gap-3 p-4" aria-labelledby="order-title">
            <div className="flex flex-wrap items-center gap-3">
              <h1 id="order-title" className="text-[34px]">Order #{order.ticket_no}</h1>
              <StatusPill tone={ORDER_TONE[order.status]!}>{ORDER_STATUS[order.status]}</StatusPill>
              {liveOff && <span className="text-[14px] text-muted">Live updates are off. Tap Refresh to update. <button type="button" className="btn btn-ghost" onClick={() => void refresh()}>Refresh</button></span>}
            </div>
            <p className="text-muted">
              {KIND_LABEL[order.kind]}{order.table_ref ? ` · Table ${order.table_ref}` : ""} · {order.channel_id === setup?.counter.id ? "Counter" : (setup?.channels.find((c) => c.id === order.channel_id)?.name ?? "Web")} · {formatTime(order.created_at, tz, SITE.locale)}
              {order.invoice_no !== null && ` · Invoice ${order.invoice_no}`}
              {order.promised_at && ` · Ready by ${formatTime(order.promised_at, tz, SITE.locale)}`}
            </p>
            <ul className="grid gap-2">
              {order.lines.map((l) => {
                const label = setup ? orderLineLabel(setup.menu.entries, l) : { name: "…", detail: "" };
                return (
                  <li key={l.line_id} className="cart-line">
                    <div><p className="text-[18px] font-semibold">{label.name}</p>{label.detail && <p className="text-[15px] text-muted">{label.detail}</p>}</div>
                    {/* Two fields side by side, never multiplied. */}
                    <p className="num text-right">{formatQty(l.qty_milli, SITE.locale)} × {money(l.unit_price_minor, order.currency)}{l.line_discount_minor > 0 && <span className="block text-[14px]">Discount {money(l.line_discount_minor, order.currency)}</span>}<span className="block text-[14px] text-muted">Tax {money(l.tax_minor, order.currency)}</span></p>
                  </li>
                );
              })}
            </ul>
            <p className="text-[14px] text-muted">The cake message and other notes show on the kitchen ticket; this order view doesn&apos;t carry them yet.</p>
            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1">
              <dt>Subtotal</dt><dd className="num text-right">{money(order.subtotal_minor, order.currency)}</dd>
              {order.discount_minor > 0 && (<><dt>Discount</dt><dd className="num text-right">−{money(order.discount_minor, order.currency)}</dd></>)}
              <dt>Tax</dt><dd className="num text-right">{money(order.tax_minor, order.currency)}</dd>
              <dt className="text-[20px] font-bold">Total</dt><dd className="num text-right text-[22px] font-bold">{money(order.total_minor, order.currency)}</dd>
            </dl>

            <div className="flex flex-wrap gap-2">
              {steps.accept && <button type="button" className="btn btn-primary min-h-16" disabled={busy !== null} onClick={() => void run({ verb: "accept", to: "accepted", reason: null })}>{busy === "accepted" ? "Saving…" : "Accept"}</button>}
              {steps.reject && <button type="button" className="btn btn-plain min-h-16" disabled={busy !== null} onClick={() => setReasonFor("reject")}>Reject…</button>}
              {steps.cancel && <button type="button" className="btn btn-plain min-h-16 text-danger" disabled={busy !== null} onClick={() => setReasonFor("cancel")}>Cancel order…</button>}
              {steps.pickedUp && (order.remaining_minor === 0 || unpaidOk
                ? <button type="button" className="btn btn-secondary min-h-16" disabled={busy !== null} onClick={() => void run({ verb: "advance", to: "completed", reason: null })}>{busy === "completed" ? "Saving…" : order.remaining_minor === 0 ? "Picked up" : "Hand over unpaid"}</button>
                : <button type="button" className="btn btn-plain min-h-16" onClick={() => setUnpaidOk(true)}>Picked up</button>)}
            </div>
            {steps.pickedUp && unpaidOk && order.remaining_minor > 0 && <p className="font-semibold text-danger">{money(order.remaining_minor, order.currency)} is still to pay. Take the payment first, or hand it over unpaid.</p>}
            {reasonFor && (
              <fieldset className="grid gap-2">
                <legend className="font-bold">{reasonFor === "reject" ? "Why can't you take this order?" : "Why is it cancelled?"}</legend>
                <select value={reason} onChange={(e) => setReason(e.target.value)}>
                  <option value="">Choose a reason</option>
                  {ORDER_REASONS.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
                </select>
                <div className="flex gap-2">
                  <button type="button" className="btn btn-primary min-h-16" disabled={!reason || busy !== null} onClick={() => void run(reasonFor === "reject" ? { verb: "reject", to: "rejected", reason } : { verb: "advance", to: "cancelled", reason })}>
                    {busy ? "Saving…" : reasonFor === "reject" ? "Reject order" : "Cancel order"}
                  </button>
                  <button type="button" className="btn btn-plain min-h-16" disabled={busy !== null} onClick={() => setReasonFor(null)}>Keep it</button>
                </div>
              </fieldset>
            )}
            {stepError && <ErrorNote>{stepError}</ErrorNote>}
            <ReceiptBlock client={client} orderId={order.order_id} names={names} onAuth={handleAuth} />
          </section>

          <aside className="grid gap-3">
            {ended ? <p className="card p-4 text-[18px] font-semibold">This order was {order.status === "rejected" ? "not accepted" : "cancelled"}. Nothing is left to take.</p>
              : <TenderPanel client={client} order={order} meId={session.me.member_id} meName={session.me.name} onChanged={() => void refresh()} onAuth={handleAuth} />}
            <Link href="/staff/counter" className="btn btn-primary pay-btn">New order</Link>
          </aside>
        </div>
        <Toast message={toast} />
      </main>
    </>
  );
}
