"use client";
// "/": hero, outlet picker with each outlet's live state, the ribbon, and teasers for gifting, story and Cares.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { munim } from "@/lib/munim";
import type { MunimError } from "@/lib/munim/client";
import { acceptingText, canOrder, errorText, payAtCounterText, readyInMinutes } from "@/lib/munim/copy";
import { cartCount } from "@/lib/munim/checkout";
import { formatWhen } from "@/lib/munim/format";
import { loadCart } from "@/lib/munim/storage";
import type { Schemas } from "@/lib/munim/types";
import { categoryLabel, SITE } from "@/lib/site";
import { useCountdown, useOnline } from "@/lib/hooks";
import { CategoryMotif, HeroArt, Hazelnut } from "../art";
import { ChevronIcon, GiftIcon, PinIcon } from "../icons";
import { MockPanel, OfflineBanner, SiteHeader, StateIcon } from "../ui";

type Outlets = Schemas["StorefrontOutletsResponse"];
type Accepting = Schemas["StorefrontAcceptingResponse"];

export function HomePage() {
  const router = useRouter();
  const online = useOnline();
  const [outlets, setOutlets] = useState<Outlets | null>(null);
  const [states, setStates] = useState<Record<string, Accepting>>({});
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [error, setError] = useState<MunimError | null>(null);
  const [retryAt, setRetryAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const r = await munim.listOutlets();
    if (!r.ok) {
      if (r.error.kind === "not_found") return router.replace("/not-valid");
      setError(r.error);
      if (r.error.kind === "rate_limited") setRetryAt(Date.now() + (r.error.retryAfterMs ?? 5000));
      return;
    }
    // Each state call fails on its own: a failed one just leaves that card without a badge. Cards render once,
    // with their badges, so nothing shifts when a state arrives.
    const pairs = await Promise.all(r.data.outlets.map(async (o) => [o.outlet_id, await munim.getState(o.outlet_id)] as const));
    setRetryAt(null);
    setStates(Object.fromEntries(pairs.flatMap(([id, s]) => (s.ok ? [[id, s.data]] : []))));
    setCounts(Object.fromEntries(r.data.outlets.map((o) => [o.outlet_id, cartCount(loadCart(o.outlet_id) ?? { outletId: o.outlet_id, lines: [], slot: { pickupWindowId: null, promisedAt: null }, couponCodes: [] })])));
    setOutlets(r.data);
  }, [router]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set after the response
    void load();
  }, [load]);
  const seconds = useCountdown(retryAt, () => void load());

  return (
    <>
      <SiteHeader />
      <OfflineBanner show={!online || error?.kind === "network"} text="You're offline. Your cart is kept on this phone." />

      <section className="wrap grid items-center gap-6 py-10 sm:grid-cols-[1.1fr_1fr] sm:py-16">
        <div>
          <p className="badge badge-accent mb-4">Lucknow · two bakehouses · pickup only</p>
          <h1 className="text-[clamp(44px,9vw,84px)]">
            Cobnut <span className="italic text-secondary">Bakehouse</span>
          </h1>
          <p className="mt-4 max-w-[30ch] text-[20px] text-muted">{SITE.tagline}</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <a href="#outlets" className="btn btn-primary">Order for pickup <ChevronIcon size={20} /></a>
            <Link href="/story" className="btn btn-plain">Our story</Link>
          </div>
        </div>
        <HeroArt className="bob mx-auto w-full max-w-[420px]" />
      </section>

      <div className="scallop" aria-hidden="true" />
      <section id="outlets" className="scroll-mt-20 bg-bg-deep pb-12 pt-6" aria-labelledby="outlets-title">
        <div className="wrap">
          <h2 id="outlets-title" className="section-title">Pick your bakehouse</h2>
          <div className="mt-6" aria-busy={!outlets && !error}>
            {error && error.kind !== "network" ? (
              <div className="card p-6">
                <p className="font-semibold">{errorText(error, "menu")}</p>
                {error.kind === "rate_limited" && seconds > 0 ? (
                  <p className="mt-2 text-muted num">Trying again in {seconds} s</p>
                ) : (
                  <button type="button" className="btn btn-primary mt-4" onClick={() => void load()}>Try again</button>
                )}
              </div>
            ) : error ? (
              <button type="button" className="btn btn-primary" onClick={() => void load()}>Try again</button>
            ) : !outlets ? (
              <div className="grid gap-4 sm:grid-cols-2">
                {[0, 1].map((i) => <div key={i} className="card h-[220px] p-6"><div className="skeleton h-7 w-1/2" /><div className="skeleton mt-4 h-4 w-3/4" /><div className="skeleton mt-10 h-12 w-48 rounded-full" /></div>)}
              </div>
            ) : outlets.outlets.length === 0 ? (
              <p className="card p-6 font-semibold">This menu is being set up. Please check back soon.</p>
            ) : (
              <ul className="grid gap-4 sm:grid-cols-2">
                {outlets.outlets.map((o) => {
                  const s = states[o.outlet_id];
                  const next = s?.next_open ? formatWhen(s.next_open, s.tz, SITE.locale) : null;
                  return (
                    <li key={o.outlet_id} className="card card-link flex flex-col p-6">
                      <h3 className="text-[28px]">{o.name}</h3>
                      <p className="mt-2 flex items-start gap-2 text-muted"><PinIcon size={20} className="mt-0.5 flex-none" />{o.address}</p>
                      <div className="mt-4 flex min-h-[28px] flex-wrap gap-2">
                        {s && <span className={`badge ${s.state === "busy" ? "badge-accent" : ""}`}><StateIcon state={s.state} /> {acceptingText(s, next)}</span>}
                        {s && canOrder(s) && <span className="badge">Ready in about {readyInMinutes(s)} min</span>}
                        {counts[o.outlet_id] ? <span className="badge num">{counts[o.outlet_id]} in your cart</span> : null}
                      </div>
                      <Link href={`/o/${o.outlet_id}`} className="btn btn-primary mt-6 self-start">Order from {o.name}</Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </section>
      <div className="scallop scallop-up" aria-hidden="true" />

      <Ribbon items={[...SITE.categoryOrder.map(categoryLabel), "Pickup only", outlets ? payAtCounterText(outlets.pay_at_counter_methods) : "Pay at the counter."]} />

      <section className="wrap mt-12 grid gap-4 md:grid-cols-3">
        <div className="card p-6">
          <span aria-hidden="true" className="grid size-12 place-items-center rounded-full bg-accent"><GiftIcon className="text-secondary" size={26} /></span>
          <h3 className="mt-4 text-[24px]">Build a gift box</h3>
          <p className="mt-2 text-muted">Pick a box size and two to four truffle-cookie flavours, add a ribbon and a card. Choose an outlet to start.</p>
        </div>
        <div className="card p-6">
          <span aria-hidden="true" className="grid size-12 place-items-center rounded-full bg-accent"><CategoryMotif slug="cakes" size={28} /></span>
          <h3 className="mt-4 text-[24px]">Cakes with a message</h3>
          <p className="mt-2 text-muted">Celebration cakes by weight, classic or eggless, with your words piped on top.</p>
        </div>
        <Link href="/cares" className="card card-link block p-6 text-ink no-underline">
          <span aria-hidden="true" className="grid size-12 place-items-center rounded-full bg-accent"><Hazelnut size={26} /></span>
          <h3 className="mt-4 text-[24px]">Munim Cares</h3>
          <p className="mt-2 text-muted">Surplus bakes from our counters, offered to simulated recipients.</p>
          <span className="mt-3 inline-flex items-center gap-1 font-semibold text-primary">See donations <ChevronIcon size={18} /></span>
        </Link>
      </section>
      <MockPanel onChange={() => void load()} />
    </>
  );
}

/** A slow ribbon of words (two copies for the loop). Decorative: it repeats what the page already says. */
export function Ribbon({ items }: { items: string[] }) {
  const list = (
    <>
      {items.map((t, i) => (
        <span key={i} className="inline-flex items-center gap-3 whitespace-nowrap font-semibold">
          <span aria-hidden="true">✦</span>
          {t}
        </span>
      ))}
    </>
  );
  return (
    <div className="ribbon" aria-hidden="true">
      <div className="ribbon-track">
        {list}
        {list}
      </div>
    </div>
  );
}
