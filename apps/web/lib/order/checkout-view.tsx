"use client";
// O2 · Checkout. Every number on this screen is the server's: the lines, discount, tax components and total come from
// POST /v1/storefront/orders:preview (labelled "Preview"); nothing is added up here (rule 9, R25). Placing sends the
// preview's total back as `preview_total_minor`; a re-price that differs is refused (`preview_total_changed`) before commit.
import { Badge, Button, Input, StateEmpty, StateError, StateLoading, uiT } from "@munim/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../i18n/index.ts";
import { newAttempt, readGuestToken, readRefusal, saveGuestToken, storefrontClient, type PickupWindow, type Preview, type Refusal } from "./api.ts";
import { refusalOf, refusalText, type CopyContext } from "./copy.ts";
import { formatterFor } from "./format.ts";
import { labelOf, titleCase } from "./names.ts";
import { PayLine } from "./pay.tsx";
import { useMenu, useStore } from "./store.tsx";

type PreviewState = { kind: "load" } | { kind: "ok"; preview: Preview } | { kind: "off" } | { kind: "err"; refusal: Refusal | null };
type PlaceState = { kind: "idle" } | { kind: "placing" } | { kind: "off" } | { kind: "refused"; text: string } | { kind: "cooldown"; text: string; seconds: number };

const COUPON = /^[A-Z0-9][A-Z0-9-]{2,31}$/;
const E164 = /^\+[1-9][0-9]{6,14}$/;

export function CheckoutView() {
  const store = useStore();
  const router = useRouter();
  const outlet = store.outlet;
  const { cart } = store;
  const { state: menuState, reload: reloadMenu } = useMenu(store.storeKey, outlet?.outlet_id ?? null, null);
  const menu = "menu" in menuState ? menuState.menu : null;
  const [windows, setWindows] = useState<PickupWindow[]>([]);
  const [previewState, setPreviewState] = useState<PreviewState>({ kind: "load" });
  const [previewTick, setPreviewTick] = useState(0);
  const [place, setPlace] = useState<PlaceState>({ kind: "idle" });
  const [couponInput, setCouponInput] = useState("");
  const [couponErr, setCouponErr] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", phone: "", email: "", marketing: false });
  const [formErr, setFormErr] = useState<{ name?: string; contact?: string; phone?: string }>({});
  const seq = useRef(0);

  // Null (no pack for the priced currency, or no known zone) means S-err below: never a default country or UTC.
  const fmt = useMemo(() => formatterFor(menu?.items[0]?.currency ?? null, menu?.accepting.tz ?? outlet?.tz), [menu, outlet]);
  const itemById = (id: string | undefined) => menu?.items.find((i) => i.item_id === id);
  const selected = windows.find((w) => w.pickup_window_id === cart.windowId) ?? null;
  const windowLabel = (w: PickupWindow) => {
    const f = fmt!;
    const day = f.date(w.starts_at) === f.date(new Date()) ? "" : `${f.date(w.starts_at)} `;
    return `${day}${f.time(w.starts_at)}–${f.time(w.ends_at)}`;
  };
  const copyCtx = (): CopyContext => ({
    fmt: fmt!, outletName: outlet?.name ?? "", pickedTime: selected ? fmt!.time(selected.starts_at) : null,
    nextOpen: menu?.accepting.next_open ? fmt!.dateTime(menu.accepting.next_open) : null,
    dealName: (id) => { const d = menu?.deals.find((x) => x.deal_id === id); return d ? titleCase(d.name_key) : null; },
    itemName: (id, lineNo) => {
      const item = itemById(id ?? (lineNo ? cart.lines[lineNo - 1]?.itemId : undefined));
      return item ? labelOf(item) : null;
    },
  });

  const loadWindows = async () => {
    if (!outlet) return;
    try {
      const { data } = await storefrontClient(store.storeKey).GET("/v1/storefront/outlets/{outlet_id}/pickup-windows", { params: { path: { outlet_id: outlet.outlet_id } } });
      if (data) setWindows(data.windows);
    } catch { /* ASAP stays available; the preview shows the real state */ }
  };
  useEffect(() => { void loadWindows(); }, [store.storeKey, outlet?.outlet_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const brandId = useMemo(() => {
    const brands = new Set(cart.lines.map((l) => menu?.items.find((i) => i.item_id === l.itemId)?.brand_id ?? null));
    return brands.size === 1 ? [...brands][0]! : null;
  }, [cart.lines, menu]);

  // Re-price on any change of lines, window or coupons (debounced 300 ms); a stale answer is dropped.
  useEffect(() => {
    if (!store.ready || !outlet || !menu || cart.lines.length === 0) return;
    const mine = ++seq.current;
    setPreviewState({ kind: "load" });
    const timer = setTimeout(async () => {
      try {
        const { data, response, error } = await storefrontClient(store.storeKey).POST("/v1/storefront/orders:preview", {
          body: {
            outlet_id: outlet.outlet_id, channel_id: menu.channel_id, brand_id: brandId, kind: "pickup",
            pickup_window_id: cart.windowId, promised_at: null, coupon_codes: cart.coupons, loyalty_redeem_points: 0,
            lines: cart.lines.map((l) => ({ item_id: l.itemId, variant_id: l.variantId, option_ids: l.optionIds, qty_milli: l.qtyMilli, barcode: null })),
          },
        });
        if (mine !== seq.current) return;
        setPreviewState(data ? { kind: "ok", preview: data } : { kind: "err", refusal: readRefusal(response, error) });
      } catch {
        if (mine === seq.current) setPreviewState({ kind: "off" });
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [store.ready, store.storeKey, outlet, menu, brandId, cart.lines, cart.windowId, cart.coupons, previewTick]);

  if (store.outlets === null) return <main className="sf-main"><h1>{t("order.checkout.title")}</h1><StateError detail={t("order.menu.err")} onRetry={() => router.refresh()} /></main>;
  if (!store.ready || !menu) {
    if (store.ready && cart.lines.length === 0) return <Empty />;
    return <main className="sf-main"><h1>{t("order.checkout.title")}</h1><StateLoading rows={4} /></main>;
  }
  if (cart.lines.length === 0) return <Empty />;
  if (!fmt) return <main className="sf-main"><h1>{t("order.checkout.title")}</h1><StateError detail={t("order.menu.err")} onRetry={reloadMenu} /></main>;

  const preview = previewState.kind === "ok" ? previewState.preview : null;
  // Core may name the same refusal twice (one per cart line of the item): show each distinct one once.
  const previewRefusals = (preview?.refusals ?? []).filter((r, i, all) =>
    all.findIndex((x) => x.reason_code === r.reason_code && (x.params?.item_id ?? x.params?.code ?? x.line_no) === (r.params?.item_id ?? r.params?.code ?? r.line_no)) === i);
  const busy = place.kind === "placing" || place.kind === "cooldown";

  const applyCoupon = () => {
    const code = couponInput.trim().toUpperCase();
    if (!COUPON.test(code)) return setCouponErr(t("order.checkout.coupon_bad_format"));
    setCouponErr(null);
    setCouponInput("");
    if (!cart.coupons.includes(code)) store.setCoupons([...cart.coupons, code]);
  };

  const validate = () => {
    const err: typeof formErr = {};
    if (!form.name.trim()) err.name = t("order.checkout.name_need");
    if (!form.phone.trim() && !form.email.trim()) err.contact = t("order.checkout.contact_need");
    if (form.phone.trim() && !E164.test(form.phone.trim())) err.phone = t("order.checkout.phone_bad");
    setFormErr(err);
    return Object.keys(err).length === 0;
  };

  const submit = async () => {
    if (!preview || !outlet || !validate()) return;
    // The attempt (order id, command ids, idempotency keys, consent time) is reused while the body is unchanged: a retry
    // after S-off resends exactly the same request (kit 10 §2).
    const sig = JSON.stringify([cart.lines, cart.windowId, cart.coupons, form, preview.total_minor, brandId]);
    const a = cart.attempt?.sig === sig ? cart.attempt : newAttempt(sig);
    store.setAttempt(a);
    setPlace({ kind: "placing" });
    try {
      const { data, response, error } = await storefrontClient(store.storeKey).POST("/v1/storefront/orders", {
        body: {
          order: {
            command_id: a.orderCmd, idempotency_key: a.orderKey, type: "orders.place.v1",
            payload: {
              order_id: a.orderId, outlet_id: outlet.outlet_id, channel_id: menu.channel_id, brand_id: brandId, device_id: null, kind: "pickup",
              table_ref: null, pickup_window_id: cart.windowId, promised_at: null, external_ref: null,
              lines: cart.lines.map((l) => ({ line_id: l.lineId, item_id: l.itemId, variant_id: l.variantId, option_ids: l.optionIds, qty_milli: l.qtyMilli, barcode: null, note: null })),
              coupon_codes: cart.coupons, loyalty_redeem_points: 0, preview_total_minor: preview.total_minor, client_totals: null,
            },
          },
          guest: {
            command_id: a.guestCmd, idempotency_key: a.guestKey, type: "storefront.guest.create.v1",
            payload: { name: form.name.trim(), phone: form.phone.trim() || null, email: form.email.trim() || null, consent: { marketing: form.marketing, at: a.consentAt } },
          },
          contact: null,
        },
      });
      if (data) {
        // PERSIST FIRST: the guest token is returned once; a replay returns null.
        if (data.guest_access_token) saveGuestToken(data.order_id, data.guest_access_token);
        if (!readGuestToken(data.order_id)) return setPlace({ kind: "refused", text: t("order.checkout.lost_token") });
        store.clearCart();
        router.push(`/order/${store.storeKey}/t/${data.order_id}`);
        return;
      }
      const r = readRefusal(response, error);
      const text = refusalOf(r, copyCtx());
      if (r.reason === "rate_limited") return setPlace({ kind: "cooldown", text, seconds: r.retryAfter ?? 5 });
      if (r.reason === "window_full") { store.setWindow(null); void loadWindows(); }
      if (r.reason === "item_sold_out" || r.reason === "item_unavailable") reloadMenu();
      if (r.code === "idempotency_conflict") store.setAttempt(null);
      setPreviewTick((n) => n + 1);
      setPlace({ kind: "refused", text });
    } catch {
      setPlace({ kind: "off" });
    }
  };

  return (
    <main className="sf-main" lang={fmt.pack.locale}>
      <header className="sf-col">
        <h1>{t("order.checkout.title")}</h1>
        <p>{t("order.checkout.pickup")} · {outlet?.name}</p>
      </header>

      <label className="sf-col">
        <span>{t("order.checkout.time")}</span>
        <select className="sf-select" value={cart.windowId ?? ""} disabled={busy} onChange={(e) => store.setWindow(e.target.value || null)}>
          <option value="">{t("order.checkout.asap")}</option>
          {windows.map((w) => <option key={w.pickup_window_id} value={w.pickup_window_id}>{windowLabel(w)}</option>)}
        </select>
        {windows.length === 0 && <span className="mu-field-hint">{t("order.checkout.no_slots")}</span>}
      </label>

      <section className="sf-col" aria-label={t("order.checkout.title")}>
        <ul className="sf-list">
          {cart.lines.map((l, i) => {
            const item = itemById(l.itemId);
            const variant = item?.variants.find((v) => v.variant_id === l.variantId);
            const extras = item?.option_groups.flatMap((g) => g.options).filter((o) => l.optionIds.includes(o.option_id)).map(labelOf) ?? [];
            const name = [item ? labelOf(item) : "", variant ? labelOf(variant) : "", ...extras].filter(Boolean).join(" · ");
            const priced = preview?.lines[i];
            return (
              <li key={l.lineId} className="sf-item">
                <div className="sf-col">
                  <h3>{name}</h3>
                  {priced && priced.line_discount_minor > 0 && <p>{t("order.checkout.discount")} −{fmt.money(priced.line_discount_minor, preview.currency)}</p>}
                  <div className="sf-stepper">
                    <Button disabled={busy || l.qtyMilli <= 1000} aria-label={t("order.checkout.qty_less", { item: name })} onClick={() => store.setQty(l.lineId, l.qtyMilli - 1000)}>−</Button>
                    <output aria-label={name}>{l.qtyMilli / 1000}</output>
                    <Button disabled={busy} aria-label={t("order.checkout.qty_more", { item: name })} onClick={() => store.setQty(l.lineId, l.qtyMilli + 1000)}>+</Button>
                    <Button variant="ghost" disabled={busy} aria-label={t("order.checkout.remove", { item: name })} onClick={() => store.removeLine(l.lineId)}>{t("order.checkout.remove_short")}</Button>
                  </div>
                </div>
                <span className="sf-price" data-minor={priced?.line_total_minor}>{priced ? fmt.money(priced.line_total_minor, preview.currency) : ""}</span>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="sf-col">
        <div className="sf-row" style={{ alignItems: "end" }}>
          <Input id="sf-coupon" label={t("order.checkout.coupon")} value={couponInput} disabled={busy} autoCapitalize="characters" autoComplete="off"
            error={couponErr}
            onChange={(e) => setCouponInput(e.target.value.toUpperCase())} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); applyCoupon(); } }} />
          <Button onClick={applyCoupon} disabled={busy || !couponInput.trim()}>{t("order.checkout.coupon_apply")}</Button>
        </div>
        {cart.coupons.length > 0 && (
          <div className="sf-meta">
            {cart.coupons.map((c) => (
              <Badge key={c} tone="accent">
                {c}
                <button type="button" className="mu-btn" data-variant="ghost" aria-label={t("order.checkout.coupon_remove", { code: c })}
                  disabled={busy} onClick={() => store.setCoupons(cart.coupons.filter((x) => x !== c))}>×</button>
              </Badge>
            ))}
          </div>
        )}
      </section>

      <section className="sf-col" aria-live="polite" data-section="totals">
        <Badge tone="info">{t("order.checkout.preview_label")}</Badge>
        {previewState.kind === "load" && <p className="mu-field-hint">{t("order.checkout.pricing")}</p>}
        {previewState.kind === "off" && <p className="sf-note" data-tone="warning" role="alert">{uiT("common.state.off")} <Button onClick={() => setPreviewTick((n) => n + 1)}>{t("order.checkout.try_again")}</Button></p>}
        {previewState.kind === "err" && (
          <p className="sf-note" data-tone="danger" role="alert">
            {previewState.refusal?.reason === "rate_limited" ? t("order.refuse.rate_limited") : t("order.checkout.price_err")}{" "}
            <Button onClick={() => setPreviewTick((n) => n + 1)}>{t("order.checkout.try_again")}</Button>
          </p>
        )}
        {previewRefusals.map((r, i) => (
          <p key={i} className="sf-note" data-tone="danger" role="alert" data-reason={r.reason_code}>
            {refusalText(r.reason_code, null, r.params ?? {}, r.line_no, copyCtx())}
            {r.reason_code.startsWith("coupon_") && r.params?.code && (
              <> <Button onClick={() => store.setCoupons(cart.coupons.filter((x) => x !== r.params?.code))}>{t("order.checkout.coupon_remove", { code: r.params.code })}</Button></>
            )}
            {(r.reason_code === "item_sold_out" || r.reason_code === "item_unavailable") && (r.params?.item_id ?? (r.line_no ? cart.lines[r.line_no - 1]?.itemId : undefined)) && (
              <> <Button onClick={() => store.removeItem((r.params?.item_id ?? cart.lines[(r.line_no ?? 1) - 1]?.itemId)!)}>{t("order.checkout.remove_short")}</Button></>
            )}
          </p>
        ))}
        {preview && preview.refusals.length === 0 && (
          <dl className="sf-dl">
            <dt>{t("order.checkout.subtotal")}</dt><dd data-minor={preview.subtotal_minor}>{fmt.money(preview.subtotal_minor, preview.currency)}</dd>
            <dt>{t("order.checkout.discount")}</dt><dd data-minor={preview.discount_minor}>{fmt.money(preview.discount_minor, preview.currency)}</dd>
            {preview.tax_components.length > 0
              ? preview.tax_components.map((c) => (
                <FragmentRow key={c.code} label={`${c.code} ${fmt.percentBp(c.rate_bp)}`} minor={c.amount_minor} money={fmt.money(c.amount_minor, preview.currency)} />
              ))
              : <FragmentRow label={t("order.checkout.tax")} minor={preview.tax_minor} money={fmt.money(preview.tax_minor, preview.currency)} />}
            <dt className="sf-total">{t("order.checkout.total")}</dt>
            <dd className="sf-total" data-testid="preview-total" data-minor={preview.total_minor}>{fmt.money(preview.total_minor, preview.currency)}</dd>
          </dl>
        )}
      </section>

      <section className="sf-col">
        <h2>{t("order.checkout.details")}</h2>
        <Input id="sf-name" label={t("order.checkout.name")} value={form.name} autoComplete="name" disabled={busy} error={formErr.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <Input id="sf-phone" type="tel" inputMode="tel" label={t("order.checkout.phone")} hint={t("order.checkout.phone_hint")} value={form.phone} autoComplete="tel" disabled={busy}
          error={formErr.phone ?? formErr.contact} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        <Input id="sf-email" type="email" label={t("order.checkout.email")} value={form.email} autoComplete="email" disabled={busy}
          onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <label className="sf-check">
          <input type="checkbox" checked={form.marketing} disabled={busy} onChange={(e) => setForm({ ...form, marketing: e.target.checked })} />
          {t("order.checkout.marketing")}
        </label>
      </section>

      <PayLine />
      {place.kind === "off" && (
        <div className="sf-note" data-tone="danger" role="alert" data-state="off">
          <p>{t("order.checkout.off")}</p>
          <Button onClick={() => void submit()}>{t("order.checkout.try_again")}</Button>
        </div>
      )}
      {(place.kind === "refused" || place.kind === "cooldown") && <p className="sf-note" data-tone="danger" role="alert" data-state="refused">{place.text}</p>}
      {previewRefusals.length > 0 && <p className="mu-field-hint">{t("order.checkout.review")}</p>}
      <CooldownButton place={place} disabled={!preview || previewRefusals.length > 0 || previewState.kind !== "ok"} onPlace={() => void submit()} onDone={() => setPlace({ kind: "idle" })} />
    </main>
  );
}

function FragmentRow({ label, minor, money }: { label: string; minor: number; money: string }) {
  return (<><dt>{label}</dt><dd data-minor={minor}>{money}</dd></>);
}

/** The place button; after a 429 it stays disabled for Retry-After seconds, then frees up (same keys on the next tap). */
function CooldownButton({ place, disabled, onPlace, onDone }: { place: PlaceState; disabled: boolean; onPlace: () => void; onDone: () => void }) {
  const [left, setLeft] = useState(0);
  const seconds = place.kind === "cooldown" ? place.seconds : 0;
  useEffect(() => {
    if (!seconds) return;
    setLeft(seconds);
    const id = setInterval(() => setLeft((n) => (n <= 1 ? (clearInterval(id), onDone(), 0) : n - 1)), 1000);
    return () => clearInterval(id);
  }, [seconds]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Button variant="primary" size="lg" busy={place.kind === "placing"} disabled={disabled || place.kind === "cooldown"} onClick={onPlace}>
      {place.kind === "placing" ? t("order.checkout.placing") : place.kind === "cooldown" ? `${t("order.checkout.place")} (${left})` : t("order.checkout.place")}
    </Button>
  );
}

function Empty() {
  const { storeKey } = useStore();
  return (
    <main className="sf-main">
      <h1>{t("order.checkout.title")}</h1>
      <StateEmpty message={t("order.checkout.empty")} action={<Link className="mu-btn" data-variant="primary" href={`/order/${storeKey}`}>{t("order.checkout.back")}</Link>} />
    </main>
  );
}
