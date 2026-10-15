// file: components/staff/order-bits.tsx
"use client";
// The counter's order pieces: the tender panel (cash / card / UPI, recorded only) and the receipt. Every amount is a
// field of GET /v1/orders/{id} or GET /v1/orders/{id}/receipt; the panel never works out change or what is left.
import { useState } from "react";
import { useCountdown } from "@/lib/hooks";
import type { MunimError } from "@/lib/munim/client";
import { RECORDED_ONLY } from "@/lib/munim/copy";
import { formatMoney, formatQty, formatRate } from "@/lib/munim/format";
import { parseTyped } from "@/lib/munim/refs";
import type { StaffClient } from "@/lib/munim/staff";
import { staffErrorText, TENDER_METHOD } from "@/lib/munim/staff-copy";
import { cardTender, cashTender, tenderOf, typedFromMinor, writeErrorText, type OrderView, type TenderMethod } from "@/lib/munim/till";
import type { Schemas } from "@/lib/munim/types";
import { useTender } from "@/lib/counter-hooks";
import { SITE } from "@/lib/site";
import { ErrorNote } from "../ui";

type Receipt = Schemas["V1OrderReceipt"];
const money = (minor: number, currency: string) => formatMoney(minor, currency, SITE.locale);

/** Copy for a failed tender. Two refusals have no words in staff-copy: "nothing due" (409 conflict, no reason code)
 *  and a card / UPI amount above what is left (422). */
export function tenderErrorText(e: MunimError, method: TenderMethod): string {
  if (e.code === "conflict" && !e.reasonCode) return "Nothing is left to pay on this order.";
  if (e.code === "invalid_payload" && method !== "cash") return "Card and UPI can't be more than what's left to pay.";
  return writeErrorText(e);
}

export function TenderPanel({ client, order, meId, meName, onChanged, onAuth }: {
  client: StaffClient;
  order: OrderView;
  meId: string;
  meName: string;
  /** Refetch the order (the panel calls it after every attempt that reached the server). */
  onChanged: () => void;
  onAuth: (e: MunimError) => boolean;
}) {
  const { record, busy } = useTender(client, order.order_id);
  const [method, setMethod] = useState<TenderMethod>("cash");
  const [text, setText] = useState("");
  const [ref, setRef] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [waitUntil, setWaitUntil] = useState<number | null>(null);
  const [lastTender, setLastTender] = useState<string | null>(null);
  const wait = useCountdown(waitUntil, () => setWaitUntil(null));
  const c = order.currency;
  const typed = parseTyped(text, method === "cash" ? "tendered_minor" : "amount_minor", c);
  const tooMuch = method !== "cash" && typed !== null && typed > order.remaining_minor; // a comparison, not a sum
  const problem = text.trim() === "" ? null : typed === null || typed === 0 ? "Enter an amount like 250 or 250.50." : tooMuch ? "Card and UPI can't be more than what's left to pay." : null;
  const last = lastTender ? tenderOf(order, lastTender) : null;
  const choose = (m: TenderMethod) => {
    setMethod(m);
    setError(null);
    setText(m === "cash" ? "" : typedFromMinor(order.remaining_minor, c)); // card / UPI start at what is left (a field)
  };
  const submit = async () => {
    if (typed === null || typed === 0 || tooMuch) return;
    setError(null);
    const note = ref.trim().slice(0, 100) || null;
    const r = await record((prev) => (method === "cash" ? cashTender(prev, order.order_id, typed, c) : cardTender(prev, order.order_id, method, typed, c, note)));
    if (r.ok) {
      setLastTender(r.tenderId);
      setText("");
      setRef("");
      onChanged();
      return;
    }
    if (onAuth(r.error)) return;
    if (r.error.kind === "rate_limited") setWaitUntil(Date.now() + (r.error.retryAfterMs ?? 5000));
    setError(tenderErrorText(r.error, method));
    if (r.error.kind !== "network") onChanged();
  };

  return (
    <section className="card grid gap-3 p-4" aria-labelledby="pay-title">
      <h2 id="pay-title" className="text-[24px]">Take payment</h2>
      <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-[18px]">
        <dt>Total</dt><dd className="num text-right font-semibold">{money(order.total_minor, c)}</dd>
        <dt>Paid</dt><dd className="num text-right">{money(order.paid_minor, c)}</dd>
        <dt className="font-bold">Left to pay</dt><dd className="num text-right text-[24px] font-bold">{money(order.remaining_minor, c)}</dd>
      </dl>
      {last && (
        <p className="note-ok text-[18px] font-semibold" role="status">
          {TENDER_METHOD[last.method]} {money(last.amount_minor, c)} recorded{last.recorded_by === meId ? ` by ${meName}` : ""}.
          {last.change_minor !== null && last.change_minor > 0 && <span className="block text-[26px] font-bold">Change to give: {money(last.change_minor, c)}</span>}
          {last.rounding_minor !== null && last.rounding_minor !== 0 && <span className="block text-[15px]">Cash rounding: {money(last.rounding_minor, c)}</span>}
        </p>
      )}
      {order.remaining_minor === 0 ? (
        <p className="text-[20px] font-bold">Paid in full</p>
      ) : (
        <>
          <div role="radiogroup" aria-label="How they paid" className="grid grid-cols-3 gap-2">
            {(["cash", "card", "upi"] as const).map((m) => (
              <button key={m} type="button" role="radio" aria-checked={method === m} className={`btn ${method === m ? "btn-primary" : "btn-plain"} min-h-16`} onClick={() => choose(m)} disabled={busy}>{TENDER_METHOD[m]}</button>
            ))}
          </div>
          <label className="block font-semibold">
            {method === "cash" ? `Cash handed over (${c})` : `Amount taken (${c})`}
            <input inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} disabled={busy} aria-invalid={problem !== null} />
          </label>
          {method === "cash" && <button type="button" className="btn btn-plain" disabled={busy} onClick={() => setText(typedFromMinor(order.remaining_minor, c))}>Exact amount</button>}
          {method !== "cash" && (
            <label className="block font-semibold">
              Slip or UPI reference (optional)
              <input value={ref} maxLength={100} onChange={(e) => setRef(e.target.value)} disabled={busy} />
            </label>
          )}
          {problem && <p className="font-semibold text-danger">{problem}</p>}
          <button type="button" className="btn btn-primary pay-btn" disabled={busy || wait > 0 || typed === null || typed === 0 || tooMuch} onClick={() => void submit()}>
            {busy ? "Saving…" : wait > 0 ? `Try again in ${wait} s` : `Record ${TENDER_METHOD[method]} payment`}
          </button>
        </>
      )}
      {error && <ErrorNote>{error}</ErrorNote>}
      <p className="text-[14px] text-muted">{RECORDED_ONLY} Nothing is charged here: record what the customer paid at the counter.</p>
      {order.tenders.length > 0 && (
        <ul className="grid gap-1 text-[15px]" aria-label="Payments recorded">
          {order.tenders.map((t) => (
            <li key={t.tender_id} className="flex justify-between gap-2">
              <span>{TENDER_METHOD[t.method]}{t.ref ? ` · ${t.ref}` : ""}{t.recorded_by === meId ? ` · by ${meName}` : ""}</span>
              <span className="num">{money(t.amount_minor, c)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

type ReceiptLoad = { state: "idle" } | { state: "loading" } | { state: "ready"; receipt: Receipt } | { state: "failed"; text: string };

/** The receipt's own words for a failed load (the sale itself is saved either way). */
export function receiptErrorText(e: MunimError): string {
  if (e.kind === "not_found") return "The receipt isn't available for this order.";
  if (e.reasonCode === "tax_id_missing") return "This outlet's tax ids are missing, so a bill can't be printed. The sale is saved.";
  if (e.kind === "network") return "The receipt couldn't load. The sale is saved.";
  return staffErrorText(e, "counter");
}

/** GET /v1/orders/{id}/receipt on request, rendered field by field. `names` maps a receipt line's name_key. */
export function ReceiptBlock({ client, orderId, names, onAuth }: { client: StaffClient; orderId: string; names: (nameKey: string) => string; onAuth: (e: MunimError) => boolean }) {
  const [load, setLoad] = useState<ReceiptLoad>({ state: "idle" });
  const open = async () => {
    setLoad({ state: "loading" });
    const r = await client.getReceipt(orderId);
    if (r.ok) setLoad({ state: "ready", receipt: r.data });
    else if (!onAuth(r.error)) setLoad({ state: "failed", text: receiptErrorText(r.error) });
  };
  if (load.state === "idle") return <button type="button" className="btn btn-plain" onClick={() => void open()}>Show receipt</button>;
  if (load.state === "loading") return <div className="skeleton h-64" role="status" aria-label="Loading the receipt" />;
  if (load.state === "failed") return (<div className="space-y-2"><ErrorNote>{load.text}</ErrorNote><button type="button" className="btn btn-plain" onClick={() => void open()}>Try again</button></div>);
  const r = load.receipt;
  const m = (x: number) => money(x, r.currency);
  return (
    <section className="card grid gap-2 p-4 text-[15px]" aria-label="Receipt">
      <h2 className="text-[22px]">{r.title}</h2>
      {r.operator && <p>{r.operator}</p>}
      <p className="font-semibold">{r.seller.name}</p>
      <p className="text-muted">{r.seller.address}</p>
      {r.tax_ids.map((t) => <p key={t.code} className="num">{t.label} {t.value}</p>)}
      <p className="num">No. {r.number} · {r.date}</p>
      <table className="snap-table">
        <thead><tr><th scope="col">Item</th><th scope="col" className="num">Qty</th><th scope="col" className="num">Price</th><th scope="col" className="num">Discount</th><th scope="col" className="num">Tax</th><th scope="col" className="num">Total</th></tr></thead>
        <tbody>
          {r.lines.map((l) => (
            <tr key={l.line_no}>
              <td>{names(l.name_key)}{l.components.length > 0 && <span className="block text-[13px] text-muted">{l.components.map((x) => `${x.code} ${formatRate(x.rate_bp, SITE.locale)} ${m(x.amount_minor)}`).join(" · ")}</span>}</td>
              <td className="num">{formatQty(l.qty_milli, SITE.locale)}</td>
              <td className="num">{m(l.unit_price_minor)}</td>
              <td className="num">{l.discount_minor ? m(l.discount_minor) : "—"}</td>
              <td className="num">{m(l.tax_minor)}</td>
              <td className="num">{m(l.total_minor)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <dl className="grid grid-cols-[1fr_auto] gap-x-4">
        <dt>Net</dt><dd className="num text-right">{m(r.net_minor)}</dd>
        {r.components.map((x) => (<FragmentRow key={x.code} label={`${x.code} ${formatRate(x.rate_bp, SITE.locale)}`} value={m(x.amount_minor)} />))}
        <dt>Tax</dt><dd className="num text-right">{m(r.tax_minor)}</dd>
        <dt className="font-bold">Total</dt><dd className="num text-right font-bold">{m(r.total_minor)}</dd>
      </dl>
      <p className="text-[14px] text-muted">{RECORDED_ONLY}</p>
      <p className="text-[14px] text-muted">Sample shop — not a real sale.</p>
    </section>
  );
}

const FragmentRow = ({ label, value }: { label: string; value: string }) => (<><dt>{label}</dt><dd className="num text-right">{value}</dd></>);
