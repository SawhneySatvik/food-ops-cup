"use client";
// "/o/[outletId]/checkout": pickup time, review (server-priced preview), details, place. Follows 01 §8.4 exactly:
// one frozen attempt per confirmation, resent unchanged after a network error, timeout, 429 or 5xx.
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { munim } from "@/lib/munim";
import type { MunimError } from "@/lib/munim/client";
import {
  ASAP, attemptFingerprint, COUPON_PATTERN, dealIdsOf, EMAIL_PATTERN, newAttempt, retryable, type Attempt, type Contact,
} from "@/lib/munim/checkout";
import { canOrder, errorText, payAtCounterText, readyInMinutes, RECORDED_ONLY, refusalText } from "@/lib/munim/copy";
import { dayLabel, formatRate, formatTime } from "@/lib/munim/format";
import { clearAttempt, clearCart, loadAttempt, loadGuestToken, saveAttempt, saveGuestToken } from "@/lib/munim/storage";
import type { Schemas } from "@/lib/munim/types";
import { dealLabel, SITE, toE164, UUID7 } from "@/lib/site";
import { useCart, useCountdown, useOnline, usePreview } from "@/lib/hooks";
import { copyContext, lineLabel, money, QtyStepper } from "../cart-bits";
import { AlertIcon, PhoneIcon } from "../icons";
import { ErrorNote, MockPanel, NotValid, OfflineBanner, OutletContact, SiteHeader, StateBanner } from "../ui";

type Menu = Schemas["StorefrontMenuResponse"];
type Window = Schemas["StorefrontPickupWindowsResponse"]["windows"][number];
type Outlets = Schemas["StorefrontOutletsResponse"];
/** A Date.now()-based deadline, for countdowns. */
const inMs = (ms: number) => Date.now() + ms;

type Field = "name" | "phone" | "email" | "reach";

export function CheckoutPage() {
  const { outletId } = useParams<{ outletId: string }>();
  if (!UUID7.test(outletId)) return <><SiteHeader /><NotValid /></>;
  return <CheckoutView outletId={outletId} />;
}

function CheckoutView({ outletId }: { outletId: string }) {
  const router = useRouter();
  const online = useOnline();
  const { cart, setCart, ready } = useCart(outletId);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [outlets, setOutlets] = useState<Outlets | null>(null);
  const [windows, setWindows] = useState<Window[] | null>(null);
  const [loadError, setLoadError] = useState<MunimError | null>(null);
  const [bump, setBump] = useState(0);
  const { preview, loading, error: previewError } = usePreview(cart, menu, true, bump);

  const [coupon, setCoupon] = useState("");
  const [couponError, setCouponError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", phone: "", email: "", marketing: false });
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({});
  const [placing, setPlacing] = useState(false);
  const placingRef = useRef(false);
  const [placeError, setPlaceError] = useState<{ text: string; retry: boolean; phone?: boolean } | null>(null);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const seconds = useCountdown(retryAt, () => setRetryAt(null));

  const outlet = outlets?.outlets.find((o) => o.outlet_id === outletId) ?? null;

  const loadWindows = useCallback(async () => {
    const r = await munim.getPickupWindows(outletId);
    if (r.ok) setWindows(r.data.windows);
  }, [outletId]);

  const loadAll = useCallback(async () => {
    setLoadError(null);
    const [m, o] = await Promise.all([munim.getMenu(outletId), munim.listOutlets()]);
    if (!m.ok) {
      if (m.error.kind === "not_found") return router.replace("/not-valid");
      return setLoadError(m.error);
    }
    setMenu(m.data);
    if (o.ok) setOutlets(o.data);
    void loadWindows();
  }, [outletId, router, loadWindows]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set after the response
    void loadAll();
  }, [loadAll]);

  const ordering = menu ? canOrder(menu.accepting) : false;
  const refusals = preview?.refusals ?? [];
  const ctx = copyContext(menu, cart, outlet?.name ?? "This bakehouse", menu?.accepting.next_open ?? null, menu?.accepting.tz ?? "UTC");
  const tz = menu?.accepting.tz ?? "UTC";

  // React to refusals the preview reports: a full window sends the shopper back to ASAP with fresh windows.
  const sawWindowFull = refusals.some((r) => r.reason_code === "window_full");
  useEffect(() => {
    if (!sawWindowFull) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- re-fetch windows after a window_full refusal
    void loadWindows();
  }, [sawWindowFull, loadWindows]);

  const grouped = useMemo(() => {
    const g: { label: string; items: Window[] }[] = [];
    for (const w of windows ?? []) {
      const label = dayLabel(w.starts_at, tz, SITE.locale);
      const last = g[g.length - 1];
      if (last?.label === label) last.items.push(w);
      else g.push({ label, items: [w] });
    }
    return g;
  }, [windows, tz]);

  function validate(f = form): Partial<Record<Field, string>> {
    const e: Partial<Record<Field, string>> = {};
    if (f.name.trim().length < 1 || f.name.trim().length > 200) e.name = "Enter your name.";
    if (f.phone.trim() && !toE164(f.phone)) e.phone = "Enter a 10-digit mobile number.";
    if (f.email.trim() && !EMAIL_PATTERN.test(f.email.trim())) e.email = "Enter a valid email address.";
    if (!f.phone.trim() && !f.email.trim()) e.reach = "Add a mobile number or an email so the outlet can reach you.";
    return e;
  }
  // Typing clears a field's error (and the "reach" one); leaving a field only ever adds its own error. Clearing on
  // blur would shift the layout between mousedown and mouseup and swallow a click on "Place order".
  const edit = (field: "name" | "phone" | "email", value: string) => {
    setForm((f) => ({ ...f, [field]: value }));
    setErrors((cur) => ({ ...cur, [field]: undefined, ...(field !== "name" && value.trim() ? { reach: undefined } : {}) }));
  };
  const blur = (field: Field) => {
    const e = validate();
    if (e[field]) setErrors((cur) => ({ ...cur, [field]: e[field] }));
  };

  const applyCoupon = () => {
    const code = coupon.trim().toUpperCase();
    if (!COUPON_PATTERN.test(code)) return setCouponError("Enter a valid code");
    setCouponError(null);
    setCart((c) => ({ ...c, couponCodes: [code] }));
  };
  const removeCoupon = () => {
    setCart((c) => ({ ...c, couponCodes: [] }));
    setCoupon("");
  };
  const removeLine = (lineNo: number) => setCart((c) => ({ ...c, lines: c.lines.filter((_, i) => i !== lineNo - 1) }));
  const setQty = (key: string, q: number) => setCart((c) => ({ ...c, lines: q <= 0 ? c.lines.filter((l) => l.key !== key) : c.lines.map((l) => (l.key === key ? { ...l, qty: q } : l)) }));

  const canPlace = !!preview && !loading && refusals.length === 0 && ordering && !placing && retryAt === null && cart.lines.length > 0;

  async function place(keyReusedOnce = false): Promise<void> {
    if (placingRef.current || !preview || !menu) return;
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length > 0) {
      const first = (["name", "phone", "email", "reach"] as Field[]).find((f) => e[f]);
      document.getElementById(first === "reach" ? "f-phone" : `f-${first}`)?.focus();
      return;
    }
    const contact: Contact = { name: form.name, phone: form.phone.trim() ? toE164(form.phone) : null, email: form.email.trim() || null, marketing: form.marketing };
    const fp = attemptFingerprint(cart, contact, preview.total_minor);
    let attempt: Attempt | null = loadAttempt(outletId);
    if (!attempt || attempt.fingerprint !== fp) {
      attempt = newAttempt(cart, menu, contact, preview.total_minor);
      saveAttempt(outletId, attempt);
    }
    placingRef.current = true;
    setPlacing(true);
    setPlaceError(null);
    const r = await munim.placeOrder(attempt.body);
    placingRef.current = false;
    setPlacing(false);

    if (r.ok) {
      const orderId = r.data.order_id;
      if (r.data.guest_access_token) saveGuestToken(orderId, r.data.guest_access_token); // first, before anything renders
      else if (!loadGuestToken(orderId)) {
        clearAttempt(outletId);
        setPlaceError({ text: "We couldn't confirm your order on this device. Please check with the outlet.", retry: false, phone: true });
        return;
      }
      clearAttempt(outletId);
      clearCart(outletId);
      router.replace(`/o/${outletId}/order/${orderId}`);
      return;
    }
    const err = r.error;
    if (retryable(err)) {
      setPlaceError({ text: errorText(err, "checkout"), retry: true });
      if (err.kind === "rate_limited") setRetryAt(inMs(err.retryAfterMs ?? 5000));
      return;
    }
    clearAttempt(outletId);
    if (err.kind === "not_found") return router.replace("/not-valid");
    if (err.kind === "key_reused" && !keyReusedOnce) return place(true);
    if (err.kind === "refusal" && err.reasonCode) {
      setPlaceError({ text: refusalText(err.reasonCode, err.params, ctx), retry: false });
      if (err.reasonCode === "window_full") {
        setCart((c) => ({ ...c, slot: ASAP }));
        void loadWindows();
      }
      if (err.reasonCode === "outlet_paused") {
        const s = await munim.getState(outletId);
        if (s.ok) setMenu((m) => (m ? { ...m, accepting: s.data } : m));
      }
      setBump((b) => b + 1); // re-run the preview
      return;
    }
    setPlaceError({ text: errorText(err, "checkout"), retry: false });
  }

  const header = <SiteHeader />;
  // Until the cart has been read from storage and the menu has loaded, hold one full-height blank area: the page
  // then lays out once, and nothing visible shifts.
  if (!ready || (!menu && !loadError && cart.lines.length > 0)) {
    return (
      <>
        {header}
        <div className="min-h-[100dvh]" aria-busy="true" />
      </>
    );
  }
  if (cart.lines.length === 0 && !placing) {
    return (
      <>
        {header}
        <div className="wrap grid min-h-[100dvh] content-start justify-items-center py-16">
          <div className="card w-full max-w-[520px] p-8 text-center">
            <h1 className="text-[34px]">Your order</h1>
            <p className="mt-3 font-semibold">Your cart is empty.</p>
            <Link href={`/o/${outletId}`} className="btn btn-primary mt-6">Back to menu</Link>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      {header}
      <StateBanner accepting={menu?.accepting ?? null} />
      <OfflineBanner show={!online || previewError?.kind === "network" || loadError?.kind === "network"} text="You're offline. Your cart is kept on this phone." />
      <main className="wrap max-w-[688px] pb-10 pt-8 lg:max-w-[1120px]">
        <Link href={`/o/${outletId}`} className="inline-flex min-h-12 items-center font-semibold">← Back to menu</Link>
        <h1 className="mt-2 text-[clamp(36px,7vw,52px)]">Your order</h1>
        {outlet && <p className="mt-1 text-muted">Pickup from {outlet.name}</p>}
        {loadError && loadError.kind !== "network" && (
          <div className="card mt-6 p-6">
            <ErrorNote>{errorText(loadError, "menu")}</ErrorNote>
            <button type="button" className="btn btn-primary mt-4" onClick={() => void loadAll()}>Try again</button>
          </div>
        )}

        {/* Phones keep the four steps in order; from 1024 px the review and Place sit in a sticky column on the right. */}
        <div className="mt-8 flex flex-col gap-6 lg:grid lg:grid-cols-[minmax(0,1fr)_420px] lg:items-start lg:gap-8">
        <div className="contents lg:block lg:space-y-6">
        <fieldset className="card order-1 p-6" disabled={placing}>
          <legend className="sr-only">Pickup time</legend>
          <h2 className="text-[26px]"><span className="text-secondary">1 · </span>Pickup time</h2>
          <div className="mt-4 grid gap-2">
            <label className="choice">
              <input type="radio" name="slot" checked={cart.slot.pickupWindowId === null} onChange={() => setCart((c) => ({ ...c, slot: ASAP }))} />
              <span className="flex-1 font-semibold">As soon as possible</span>
              {menu && ordering && <span className="text-[14px] text-muted">Ready in about {readyInMinutes(menu.accepting)} min</span>}
            </label>
            {windows === null && <div className="skeleton h-12" aria-hidden="true" />}
            {windows && windows.length === 0 && menu && !ordering && <p className="text-muted">No pickup times are available right now.</p>}
            {grouped.map((g) => (
              <div key={g.label} className="mt-3">
                <h3 className="font-sans text-[16px] font-bold tracking-normal">{g.label}</h3>
                <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {g.items.map((w) => (
                    <label key={w.pickup_window_id} className="choice">
                      <input type="radio" name="slot" checked={cart.slot.pickupWindowId === w.pickup_window_id} onChange={() => setCart((c) => ({ ...c, slot: { pickupWindowId: w.pickup_window_id, promisedAt: null } }))} />
                      <span className="num text-[15px] leading-tight">{formatTime(w.starts_at, tz, SITE.locale)}<span className="block text-[14px] text-muted">to {formatTime(w.ends_at, tz, SITE.locale)}</span></span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </fieldset>

        <fieldset className="card order-3 space-y-4 p-6" disabled={placing}>
          <legend className="sr-only">Your details</legend>
          <h2 className="text-[26px]"><span className="text-secondary">3 · </span>Your details</h2>
          <Input id="f-name" label="Name" value={form.name} error={errors.name} autoComplete="name" onChange={(v) => edit("name", v)} onBlur={() => blur("name")} />
          <div>
            <label htmlFor="f-phone" className="font-bold">Mobile number</label>
            <div className="mt-1 flex items-stretch">
              <span className="inline-flex items-center rounded-l-[14px] border-[1.5px] border-r-0 border-line bg-bg-deep px-3 font-semibold" aria-hidden="true">+91</span>
              <input
                id="f-phone"
                inputMode="tel"
                autoComplete="tel-national"
                className="!rounded-l-none"
                value={form.phone}
                onChange={(e) => edit("phone", e.target.value)}
                onBlur={() => blur("phone")}
                aria-invalid={!!(errors.phone || errors.reach)}
                aria-describedby={[errors.phone && "f-phone-err", errors.reach && "f-reach-err"].filter(Boolean).join(" ") || undefined}
              />
            </div>
            {errors.phone && <FieldError id="f-phone-err">{errors.phone}</FieldError>}
          </div>
          <Input id="f-email" label="Email" value={form.email} error={errors.email} autoComplete="email" inputMode="email" onChange={(v) => edit("email", v)} onBlur={() => blur("email")} />
          {errors.reach && <FieldError id="f-reach-err">{errors.reach}</FieldError>}
          <label className="choice">
            <input type="checkbox" checked={form.marketing} onChange={(e) => setForm({ ...form, marketing: e.target.checked })} />
            <span>Send me offers</span>
          </label>
        </fieldset>
        </div>

        <div className="contents lg:sticky lg:top-[88px] lg:block lg:space-y-6">
        <section className="card order-2 p-6" aria-labelledby="review-h">
          <h2 id="review-h" className="text-[26px]"><span className="text-secondary">2 · </span>Review</h2>
          <ul className="mt-4 space-y-4">
            {cart.lines.map((l, i) => {
              const { name, detail } = lineLabel(menu, l);
              const pl = preview?.lines[i];
              const deals = pl ? dealIdsOf(pl.deal_refs).map((id) => menu?.deals.find((d) => d.deal_id === id)).filter(Boolean) : [];
              return (
                <li key={l.key} className="border-b-[1.5px] border-bg-deep pb-4">
                  <div className="flex justify-between gap-3">
                    <div>
                      <p className="font-bold">{name}</p>
                      {detail && <p className="text-[14px] text-muted">{detail}</p>}
                      {l.note && <p className="text-[14px] italic text-muted">“{l.note}”</p>}
                      {deals.map((d) => <span key={d!.deal_id} className="badge badge-accent mt-2">Deal applied · {dealLabel(d!.name_key)}</span>)}
                    </div>
                    {pl && refusals.length === 0 && <p className="num whitespace-nowrap font-semibold">{money(pl.line_total_minor, preview!.currency)}</p>}
                  </div>
                  <div className="mt-2"><QtyStepper qty={l.qty} name={name} onChange={(q) => setQty(l.key, q)} disabled={placing} /></div>
                </li>
              );
            })}
          </ul>

          <div className="mt-6">
            <label htmlFor="f-coupon" className="font-bold">Coupon code</label>
            {cart.couponCodes.length > 0 ? (
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <span className="badge num">{cart.couponCodes[0]}</span>
                <button type="button" className="btn btn-plain" onClick={removeCoupon} disabled={placing}>Remove</button>
              </div>
            ) : (
              <div className="mt-2 flex gap-2">
                <input
                  id="f-coupon"
                  value={coupon}
                  autoCapitalize="characters"
                  autoComplete="off"
                  onChange={(e) => setCoupon(e.target.value.toUpperCase())}
                  onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), applyCoupon())}
                  aria-describedby={couponError ? "coupon-err" : undefined}
                  aria-invalid={!!couponError}
                  disabled={placing}
                />
                <button type="button" className="btn btn-plain" onClick={applyCoupon} disabled={placing}>Apply</button>
              </div>
            )}
            {couponError && <p id="coupon-err" className="mt-2 flex items-center gap-2 font-semibold text-danger"><AlertIcon size={18} /> {couponError}</p>}
          </div>

          <div className="mt-6 rounded-[16px] bg-bg p-5" aria-busy={loading} aria-live="polite">
            {refusals.length > 0 ? (
              <ul className="space-y-3">
                {refusals.map((r, i) => (
                  <li key={i} className="space-y-2">
                    <ErrorNote>{refusalText(r.reason_code, r.params ?? {}, ctx)}</ErrorNote>
                    {(r.reason_code === "item_sold_out" || r.reason_code === "item_unavailable") && r.line_no !== null && (
                      <button type="button" className="btn btn-plain" onClick={() => removeLine(r.line_no!)}>Remove</button>
                    )}
                    {r.reason_code.startsWith("coupon_") && <button type="button" className="btn btn-plain" onClick={removeCoupon}>Remove coupon</button>}
                    {r.reason_code === "window_full" && <button type="button" className="btn btn-plain" onClick={() => setCart((c) => ({ ...c, slot: ASAP }))}>Pick up as soon as possible</button>}
                  </li>
                ))}
              </ul>
            ) : preview ? (
              <dl className={`num space-y-2 ${loading ? "opacity-60" : ""}`}>
                <div className="flex justify-between"><dt>Subtotal</dt><dd>{money(preview.subtotal_minor, preview.currency)}</dd></div>
                {preview.discount_minor !== 0 && <div className="flex justify-between text-ok"><dt>Discount</dt><dd>−{money(preview.discount_minor, preview.currency)}</dd></div>}
                {preview.tax_components.map((t) => (
                  <div key={t.code} className="flex justify-between text-muted"><dt>{t.code} {formatRate(t.rate_bp, SITE.locale)}</dt><dd>{money(t.amount_minor, preview.currency)}</dd></div>
                ))}
                <div className="flex items-center justify-between border-t-[1.5px] border-line pt-3 text-[20px] font-bold">
                  <dt className="flex items-center gap-2">Total <span className="badge badge-accent text-[14px]">Preview</span></dt>
                  <dd>{money(preview.total_minor, preview.currency)}</dd>
                </div>
              </dl>
            ) : previewError ? (
              <ErrorNote>{errorText(previewError, "checkout")}</ErrorNote>
            ) : (
              <div className="space-y-2" aria-hidden="true"><div className="skeleton h-5" /><div className="skeleton h-5" /><div className="skeleton h-7" /></div>
            )}
          </div>
        </section>

        <section className="card order-4 p-6" aria-labelledby="place-h">
          <h2 id="place-h" className="text-[26px]"><span className="text-secondary">4 · </span>Place</h2>
          <p className="mt-3 font-semibold">{payAtCounterText(menu?.pay_at_counter_methods ?? null)}</p>
          <p className="text-muted">{RECORDED_ONLY}</p>
          {placeError && (
            <div className="mt-4 space-y-2">
              <ErrorNote>{placeError.text}</ErrorNote>
              {placeError.phone && outlet?.phone && (
                <a href={`tel:${outlet.phone}`} className="inline-flex min-h-12 items-center gap-2 font-semibold"><PhoneIcon size={20} /> {outlet.phone}</a>
              )}
              {placeError.phone && outlet && !outlet.phone && <p>{outlet.address}</p>}
            </div>
          )}
          <button
            type="button"
            className="btn btn-primary mt-5 w-full text-[18px]"
            disabled={!canPlace}
            onClick={() => void place()}
          >
            {placing ? "Placing…" : retryAt !== null ? `Try again in ${seconds} s` : placeError?.retry ? "Try again" : "Place order"}
          </button>
          {!ordering && menu && <p className="mt-3 text-muted">Not taking orders right now.</p>}
        </section>
        </div>
        </div>
      </main>
      <OutletContact outlet={outlet} />
      <MockPanel onChange={() => { void loadAll(); setBump((b) => b + 1); }} />
    </>
  );
}

function FieldError({ id, children }: { id: string; children: React.ReactNode }) {
  return <p id={id} className="mt-1 flex items-center gap-2 font-semibold text-danger"><AlertIcon size={18} /> {children}</p>;
}

function Input({ id, label, value, error, onChange, onBlur, autoComplete, inputMode }: { id: string; label: string; value: string; error?: string; onChange: (v: string) => void; onBlur: () => void; autoComplete: string; inputMode?: "email" | "text" }) {
  return (
    <div>
      <label htmlFor={id} className="font-bold">{label}</label>
      <input id={id} className="mt-1" value={value} autoComplete={autoComplete} inputMode={inputMode} onChange={(e) => onChange(e.target.value)} onBlur={onBlur} aria-invalid={!!error} aria-describedby={error ? `${id}-err` : undefined} />
      {error && <FieldError id={`${id}-err`}>{error}</FieldError>}
    </div>
  );
}
