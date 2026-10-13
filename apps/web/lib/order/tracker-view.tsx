"use client";
// O3 · Tracker. Status, promise and total are the order row's own fields, re-read on every stream event (the event
// carries ids and statuses only, never reason text) and every 15 s while the stream is down (R4 §E 9). Only the server
// moves the bar. Guests cannot change or cancel: the outlet's phone is shown instead.
import { StateEmpty, StateError, StateLoading, StateNotFound } from "@munim/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { t } from "../i18n/index.ts";
import { readGuestToken, readRefusal, trackingClient, type OrderView } from "./api.ts";
import { formatterFor } from "./format.ts";
import { titleCase } from "./names.ts";
import { PayLine } from "./pay.tsx";
import { useStream } from "../live.ts";
import { useStore } from "./store.tsx";

const STEPS = ["placed", "accepted", "preparing", "ready", "completed"] as const;
const STEP_KEY = {
  placed: "order.track.step.placed", accepted: "order.track.step.accepted", preparing: "order.track.step.preparing",
  ready: "order.track.step.ready", completed: "order.track.step.completed",
} as const;

type Load = { kind: "load" } | { kind: "ok" } | { kind: "404" } | { kind: "err" } | { kind: "off" };

export function TrackerView({ orderId }: { orderId: string }) {
  const store = useStore();
  const router = useRouter();
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [order, setOrder] = useState<OrderView | null>(null);
  const [load, setLoad] = useState<Load>({ kind: "load" });
  useEffect(() => setToken(readGuestToken(orderId)), [orderId]);

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      const { data, response, error } = await trackingClient(store.storeKey, token).GET("/v1/storefront/orders/{id}", { params: { path: { id: orderId } } });
      if (data) { setOrder(data); setLoad({ kind: "ok" }); }
      else setLoad(readRefusal(response, error).status === 404 ? { kind: "404" } : { kind: "err" });
    } catch {
      setLoad({ kind: "off" });
    }
  }, [store.storeKey, token, orderId]);

  useEffect(() => { void refresh(); }, [refresh]);
  const live = useStream(token ? [`order:${orderId}`] : null, () => void refresh(), { storefrontKey: store.storeKey, ...(token ? { guestToken: token } : {}) });
  useEffect(() => {
    if (!token || live === "open") return;
    const id = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(id);
  }, [token, live, refresh]);

  const outlet = store.outlets?.find((o) => o.outlet_id === order?.outlet_id) ?? null;
  // No outlet (the outlets call failed) or no pack for the currency: promised times cannot be shown honestly -> S-err.
  const fmt = useMemo(() => formatterFor(order?.currency ?? null, outlet?.tz), [order?.currency, outlet?.tz]);

  // A browser without this order's guest token, a wrong id or a wrong key: the same not-valid page (kit 10 §4).
  if (token === null || load.kind === "404") return <StateNotFound />;
  if (!order) {
    return (
      <main className="sf-main">
        {load.kind === "err" && <StateEmpty message={t("order.track.err")} />}
        {load.kind === "off" && <StateEmpty message={t("order.track.off")} />}
        {(load.kind === "load" || token === undefined) && <StateLoading rows={4} />}
      </main>
    );
  }

  const rejected = [...order.events].reverse().find((e) => e.kind === "status" && e.to_status === "rejected");
  const firstPromise = order.events.find((e) => e.kind === "promised_at");
  const was = firstPromise?.from_promised_at && order.promised_at && new Date(order.promised_at) > new Date(firstPromise.from_promised_at) ? firstPromise.from_promised_at : null;
  if (!fmt) return <main className="sf-main"><StateError detail={t("order.track.err")} onRetry={() => router.refresh()} /></main>;
  const stepIx = STEPS.indexOf(order.status as (typeof STEPS)[number]);
  const stale = load.kind === "err" || load.kind === "off";

  return (
    <main className="sf-main" lang={fmt.pack.locale}>
      <header className="sf-bar">
        <h1>{t("order.track.title", { ticket: String(order.ticket_no) })}</h1>
        <span className="mu-live" data-state={live === "open" ? "open" : "retrying"} role="status">
          <span className="mu-live-dot" aria-hidden="true" />{live === "open" ? t("order.track.live") : t("order.track.updating")}
        </span>
      </header>
      {outlet && <p>{outlet.name}</p>}
      {stale && <p className="sf-note" data-tone="warning" role="status">{load.kind === "off" ? t("order.track.off") : t("order.track.err")}</p>}

      {order.status === "rejected" && (
        <p className="sf-note" data-tone="danger" role="status" data-status="rejected">
          {rejected?.reason ? t("order.track.rejected", { reason: titleCase(rejected.reason).toLowerCase() }) : t("order.track.rejected_plain")}
        </p>
      )}
      {order.status === "cancelled" && <p className="sf-note" data-tone="warning" role="status" data-status="cancelled">{t("order.track.cancelled")}</p>}

      {stepIx >= 0 && (
        <>
          <ol className="sf-steps" aria-label={t("order.track.progress")}>
            {STEPS.map((s, i) => (
              <li key={s} data-done={i < stepIx} data-step={s} aria-current={i === stepIx ? "step" : undefined}>{t(STEP_KEY[s])}</li>
            ))}
          </ol>
          <p role="status" aria-live="polite" data-testid="status-text">{t("order.track.now", { step: t(STEP_KEY[STEPS[stepIx]!]) })}</p>
        </>
      )}
      {order.status === "completed" && <p><strong>{t("order.track.completed")}</strong></p>}

      {order.promised_at && stepIx >= 0 && order.status !== "completed" && (
        <p>
          {t("order.track.ready_at", { time: fmt.time(order.promised_at) })}{" "}
          {was && <span className="mu-field-hint">{t("order.track.was", { earlier: fmt.time(was) })}</span>}
        </p>
      )}

      <dl className="sf-dl">
        <dt>{t("order.track.total")}</dt>
        <dd data-testid="order-total" data-minor={order.total_minor}>{fmt.money(order.total_minor, order.currency)}</dd>
      </dl>
      <PayLine />

      <section className="sf-col">
        <p>{t("order.track.call")}</p>
        {outlet?.phone && <a className="mu-btn" data-variant="secondary" href={`tel:${outlet.phone}`}>{t("order.track.call_number", { phone: outlet.phone })}</a>}
        {outlet && !outlet.phone && <p className="mu-field-hint">{outlet.address}</p>}
        {outlet && outlet.tax_ids.length > 0 && (
          <ul className="sf-list mu-field-hint" aria-label={t("order.track.tax_ids")}>
            {outlet.tax_ids.map((x) => <li key={x.code}>{x.label}: {x.value}</li>)}
          </ul>
        )}
      </section>
      <Link className="mu-btn" data-variant="ghost" href={`/order/${store.storeKey}`}>{t("order.checkout.back")}</Link>
    </main>
  );
}
