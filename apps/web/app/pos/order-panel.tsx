"use client";
// P3 Tender, P4 Receipt and the void sheet for one committed order. Every number is a field core returned: totals,
// paid, remaining and change come from GET /v1/orders/{id} (core computes them in the same read — G-POS-2).
import { Badge, Button, Card, Input, RecordedOnlyNote, Sheet, Skeleton, StateDeny, StateError, StateOffline, createFormatter, parseMinor, type Formatter } from "@munim/ui";
import type { Schemas } from "@munim/sdk";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../lib/api.ts";
import { t } from "../../lib/i18n/index.ts";
import { formatSpec, usePos } from "../../lib/pos/context.tsx";
import { classify, createIntents, entryName, settle, titleCase, VOID_REASONS, type MenuEntry, type Outcome } from "../../lib/pos/logic.ts";

type Order = Schemas["V1Order"];
type Receipt = Schemas["V1OrderReceipt"];
type Load<T> = { status: "load" } | { status: "ok"; data: T } | { status: "err" } | { status: "off" } | { status: "deny" };

function useLoad<T>(fetcher: () => Promise<{ data?: T; response?: Response }>, deps: unknown[]): [Load<T>, () => void] {
  const [state, setState] = useState<Load<T>>({ status: "load" });
  const [n, setN] = useState(0);
  const reload = useCallback(() => setN((x) => x + 1), []);
  useEffect(() => {
    let live = true;
    void settle(fetcher).then((r) => {
      if (!live) return;
      const res = r as { data?: T; response?: Response };
      if (res.data) setState({ status: "ok", data: res.data });
      else if (!res.response) setState({ status: "off" });
      else setState({ status: res.response.status === 403 ? "deny" : "err" });
    });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are the caller's keys
  }, [...deps, n]);
  return [state, reload];
}

export function OrderPanel({ orderId, view, entries, outletId }: { orderId: string; view: "tender" | "receipt"; entries: MenuEntry[]; outletId: string }) {
  const pos = usePos();
  const fmt = createFormatter(formatSpec(pos, outletId));
  const [order, reload] = useLoad<Order>(() => api.GET("/v1/orders/{id}", { params: { path: { id: orderId } } }), [orderId]);
  if (order.status === "load") return <Card><Skeleton rows={4} /></Card>;
  if (order.status === "deny") return <StateDeny />;
  if (order.status === "off") return <StateOffline onRetry={reload} />;
  if (order.status === "err") return <StateError onRetry={reload} />;
  return view === "receipt"
    ? <ReceiptView order={order.data} entries={entries} fmt={fmt} isDemo={pos.tenant.isDemo} />
    : <Tender order={order.data} fmt={fmt} reload={reload} />;
}

function Tender({ order, fmt, reload }: { order: Order; fmt: Formatter; reload: () => void }) {
  const router = useRouter();
  const pack = fmt.pack;
  const [method, setMethod] = useState<"cash" | "card" | "upi">("cash");
  const [typed, setTyped] = useState("");
  const [exact, setExact] = useState(false);
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [voiding, setVoiding] = useState(false);
  const intents = useRef(createIntents());

  // "Exact amount" sends the remaining core reported; otherwise the typed amount is parsed to minor units (no arithmetic).
  const amount = exact ? order.remaining_minor : parseMinor(typed, pack);
  const money = (n: number) => fmt.money(n, order.currency);
  const cancelled = order.status === "cancelled" || order.status === "rejected";
  const settled = !cancelled && order.tenders.length > 0 && order.remaining_minor === 0;

  const record = async () => {
    if (!amount || amount <= 0) return;
    setBusy(true);
    const intent = intents.current.get(JSON.stringify([order.order_id, method, amount, ref, order.tenders.length]));
    const cash = method === "cash";
    const res = await settle(() => api.POST("/v1/orders/{id}/tenders", {
      params: { path: { id: order.order_id } },
      body: { command_id: intent.command_id, idempotency_key: intent.idempotency_key, type: "orders.tender.record.v1",
        payload: { tender_id: intent.entity_id, order_id: order.order_id, method, tendered_minor: cash ? amount : null, amount_minor: cash ? null : amount, currency: order.currency, ref: cash || !ref.trim() ? null : ref.trim() } },
    }));
    const o = classify(res, { overAmountIsInvalid: !cash });
    setBusy(false);
    setOutcome(o.kind === "ok" ? null : o);
    if (o.kind === "ok") { intents.current.clear(); setTyped(""); setExact(false); setRef(""); reload(); }
    else if (o.kind === "refused") intents.current.clear();
  };

  return (
    <Card className="pos-tender" aria-labelledby="pos-p3">
      <h1 id="pos-p3">{t("pos.p3.heading")}</h1>
      <p>{t("pos.p3.order", { ticket: String(order.ticket_no), invoice: order.invoice_no === null ? "—" : String(order.invoice_no) })} <Badge tone={cancelled ? "danger" : "neutral"}>{t(`pos.status.${order.status}`)}</Badge></p>
      <dl className="pos-totals" data-testid="pos-order-totals">
        <div><dt>{t("pos.preview.subtotal")}</dt><dd data-k="subtotal">{money(order.subtotal_minor)}</dd></div>
        {order.discount_minor > 0 && <div><dt>{t("pos.preview.discount")}</dt><dd>{money(order.discount_minor)}</dd></div>}
        <div><dt>{t("pos.preview.tax")}</dt><dd data-k="tax">{money(order.tax_minor)}</dd></div>
        <div className="pos-grand"><dt>{t("pos.p3.total")}</dt><dd data-k="total">{money(order.total_minor)}</dd></div>
        <div><dt>{t("pos.p3.paid")}</dt><dd data-k="paid">{money(order.paid_minor)}</dd></div>
        <div><dt>{t("pos.p3.remaining")}</dt><dd data-k="remaining">{money(order.remaining_minor)}</dd></div>
      </dl>
      <ul className="pos-tenders">
        {order.tenders.map((x) => (
          <li key={x.tender_id} data-testid="pos-tender-row">
            {t("pos.p3.recorded_line", { method: t(`pos.p3.${x.method}`), amount: money(x.amount_minor) })}
            {x.change_minor !== null && x.change_minor > 0 && <strong> · {t("pos.p3.change")} <span data-k="change">{money(x.change_minor)}</span></strong>}
          </li>
        ))}
      </ul>

      {cancelled && <p role="status" data-testid="pos-voided">{t("pos.p3.voided")}</p>}
      {settled && <p role="status">{t("pos.p3.settled")}</p>}

      {!cancelled && !settled && (
        <>
          <div role="group" aria-label={t("pos.p3.method")} className="pos-seg">
            {(["cash", "card", "upi"] as const).map((m) => (
              <Button key={m} variant={method === m ? "primary" : "secondary"} aria-pressed={method === m} onClick={() => { setMethod(m); setOutcome(null); }}>{t(`pos.p3.${m}`)}</Button>
            ))}
          </div>
          <div className="pos-amount-row">
            <Input id="pos-amount" inputMode="decimal" label={method === "cash" ? t("pos.p3.amount_cash") : t("pos.p3.amount")} value={exact ? "" : typed}
              placeholder={exact ? money(order.remaining_minor) : ""} disabled={exact} onChange={(e) => setTyped(e.target.value)} />
            <Button aria-pressed={exact} onClick={() => setExact((v) => !v)}>{t("pos.p3.exact")}</Button>
          </div>
          {method !== "cash" && <Input id="pos-ref" label={t("pos.p3.ref")} hint={t("pos.p3.ref_hint")} value={ref} maxLength={100} onChange={(e) => setRef(e.target.value)} />}
          {outcome?.kind === "off" && <StateOffline onRetry={() => void record()} />}
          {outcome?.kind === "deny" && <StateDeny />}
          {outcome?.kind === "err" && <StateError onRetry={() => void record()} />}
          {outcome?.kind === "refused" && <p role="alert" className="pos-refusal" data-testid="pos-refusal">{t(outcome.copyKey)}</p>}
        </>
      )}
      <RecordedOnlyNote />
      <div className="pos-actions">
        {!cancelled && !settled && <Button variant="primary" size="lg" busy={busy} disabled={!amount || amount <= 0} onClick={() => void record()}>{t("pos.p3.record")}</Button>}
        <Button size="lg" variant="secondary" onClick={() => router.push(`/pos?order=${order.order_id}&view=receipt`)}>{t("pos.p3.receipt")}</Button>
        {!cancelled && order.tenders.length === 0 && <Button size="lg" variant="danger" onClick={() => setVoiding(true)}>{t("pos.p3.void")}</Button>}
        {(cancelled || settled) && <Button size="lg" variant="primary" onClick={() => router.push("/pos")}>{t("pos.p4.new_sale")}</Button>}
      </div>
      <VoidSheet open={voiding} onClose={() => setVoiding(false)} order={order} onDone={() => { setVoiding(false); reload(); }} />
    </Card>
  );
}

function VoidSheet({ open, onClose, order, onDone }: { open: boolean; onClose: () => void; order: Order; onDone: () => void }) {
  return (
    <Sheet open={open} onClose={onClose} side="bottom" title={t("pos.p3.void_title")}>
      <VoidForm order={order} onClose={onClose} onDone={onDone} />
    </Sheet>
  );
}

function VoidForm({ order, onClose, onDone }: { order: Order; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const intents = useRef(createIntents());
  const ready = reason !== "" && note.trim() !== "";

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    const intent = intents.current.get(JSON.stringify([order.order_id, reason, note.trim()]));
    const res = await settle(() => api.POST("/v1/orders/{id}/voids", {
      params: { path: { id: order.order_id } },
      body: { command_id: intent.command_id, idempotency_key: intent.idempotency_key, type: "orders.void.record.v1",
        payload: { void_id: intent.entity_id, order_id: order.order_id, order_line_id: null, reason_code: reason, note: note.trim() } },
    }));
    const o = classify(res);
    setBusy(false);
    if (o.kind === "ok") { intents.current.clear(); onDone(); return; }
    if (o.kind === "refused") intents.current.clear();
    setOutcome(o);
  };

  return (
    <>
      <div className="mu-field">
        <label htmlFor="pos-void-reason">{t("pos.p3.void_reason")}</label>
        <select id="pos-void-reason" className="mu-input" value={reason} onChange={(e) => setReason(e.target.value)}>
          <option value="">{t("pos.p3.void_pick")}</option>
          {VOID_REASONS.map((r) => <option key={r} value={r}>{t(`pos.void.${r}`)}</option>)}
        </select>
      </div>
      <div className="mu-field">
        <label htmlFor="pos-void-note">{t("pos.p3.void_note")}</label>
        <textarea id="pos-void-note" className="mu-input" rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      {outcome?.kind === "off" && <StateOffline onRetry={() => void submit()} />}
      {outcome?.kind === "deny" && <StateDeny />}
      {outcome?.kind === "err" && <StateError onRetry={() => void submit()} />}
      {outcome?.kind === "refused" && <p role="alert" className="pos-refusal">{t(outcome.copyKey)}</p>}
      <div className="pos-sheet-actions">
        <Button onClick={onClose}>{t("pos.p2.cancel")}</Button>
        <Button variant="danger" size="lg" busy={busy} disabled={!ready} onClick={() => void submit()}>{t("pos.p3.void_confirm")}</Button>
      </div>
    </>
  );
}

function ReceiptView({ order, entries, fmt, isDemo }: { order: Order; entries: MenuEntry[]; fmt: Formatter; isDemo: boolean }) {
  const router = useRouter();
  const [rec, reload] = useLoad<Receipt>(() => api.GET("/v1/orders/{id}/receipt", { params: { path: { id: order.order_id } } }), [order.order_id]);
  if (rec.status === "load") return <Card><Skeleton rows={6} /></Card>;
  if (rec.status !== "ok") {
    return (
      <Card>
        <div className="mu-state" data-state="err" role="alert"><div className="mu-state-body"><p>{t("pos.p4.load_failed")}</p><Button onClick={reload}>{t("common.action.try_again")}</Button></div></div>
      </Card>
    );
  }
  const r = rec.data;
  const money = (n: number) => fmt.money(n, r.currency);
  const names = new Map(entries.map((e) => [e.item_id, entryName(e)]));
  return (
    <Card className="pos-receipt" aria-labelledby="pos-p4">
      <h1 id="pos-p4">{t("pos.p4.heading")}</h1>
      <div className="pos-paper" data-testid="pos-receipt">
        <h2>{r.title}</h2>
        <p><strong>{r.seller.name}</strong><br />{r.seller.address}</p>
        <ul className="pos-taxids">{r.tax_ids.map((x) => <li key={x.code}>{x.label}: {x.value}</li>)}</ul>
        <p>{t("pos.p4.number", { number: r.number })} · {t("pos.p4.date", { date: r.date })}</p>
        <table className="mu-table">
          <tbody>
            {r.lines.map((l) => (
              <tr key={l.line_no} data-testid="pos-receipt-line">
                <td>{fmt.qtyMilli(l.qty_milli)} × {names.get(l.item_id) ?? titleCase(l.name_key)}</td>
                <td className="pos-amount">{money(l.total_minor)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <dl className="pos-totals">
          <div><dt>{t("pos.p4.net")}</dt><dd data-k="net">{money(r.net_minor)}</dd></div>
          {r.components.map((c) => <div key={c.code}><dt>{c.code} {fmt.percentBp(c.rate_bp)}</dt><dd>{money(c.amount_minor)}</dd></div>)}
          <div><dt>{t("pos.p4.tax")}</dt><dd data-k="tax">{money(r.tax_minor)}</dd></div>
          <div className="pos-grand"><dt>{t("pos.p4.total")}</dt><dd data-k="total">{money(r.total_minor)}</dd></div>
        </dl>
        <ul className="pos-tenders">
          {order.tenders.map((x) => <li key={x.tender_id}>{t("pos.p3.recorded_line", { method: t(`pos.p3.${x.method}`), amount: fmt.money(x.amount_minor, x.currency) })}</li>)}
        </ul>
        {isDemo && <p className="pos-muted">{t("pos.p4.sample")}</p>}
      </div>
      <RecordedOnlyNote />
      <div className="pos-actions">
        <Button size="lg" onClick={() => router.push(`/pos?order=${order.order_id}`)}>{t("pos.back")}</Button>
        <Button size="lg" onClick={() => window.print()}>{t("pos.p4.print")}</Button>
        <Button size="lg" variant="primary" onClick={() => router.push("/pos")}>{t("pos.p4.new_sale")}</Button>
      </div>
    </Card>
  );
}
