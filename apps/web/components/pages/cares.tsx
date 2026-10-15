"use client";
// "/cares": this business's surplus food, offered to SIMULATED recipients. Plus the network total on the real API.
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { munim } from "@/lib/munim";
import type { MunimError } from "@/lib/munim/client";
import { errorText } from "@/lib/munim/copy";
import { FOOD_KIND_LABEL, impactTotal, unitLabel, type CaresListing } from "@/lib/munim/cares";
import { dayLabel, formatDate, formatQty, formatTime, titleCase } from "@/lib/munim/format";
import type { Schemas } from "@/lib/munim/types";
import { SITE } from "@/lib/site";
import { useCountdown } from "@/lib/hooks";
import { Hazelnut } from "../art";
import { ClockIcon } from "../icons";
import { SiteHeader } from "../ui";

export function CaresPage() {
  const router = useRouter();
  const [items, setItems] = useState<CaresListing[] | null>(null);
  const [error, setError] = useState<MunimError | null>(null);
  const [impact, setImpact] = useState<Schemas["V1CaresNetworkImpact"] | null>(null);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [retried, setRetried] = useState(false);

  const load = useCallback(async () => {
    const r = await munim.getCares();
    if (r.ok) {
      setError(null);
      return setItems(r.data.items);
    }
    if (r.error.kind === "not_found") return router.replace("/not-valid");
    setError(r.error);
    if (r.error.kind === "rate_limited") setRetryAt(Date.now() + (r.error.retryAfterMs ?? 5000));
  }, [router]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set after the response
    void load();
    // Any failure hides the network block (the mock always answers 404).
    void munim.getNetworkImpact().then((r) => r.ok && setImpact(r.data));
  }, [load]);
  // One retry after a 429, never a poll.
  const seconds = useCountdown(retried ? null : retryAt, () => { setRetried(true); void load(); });

  const total = impact ? impactTotal(impact) : null;

  return (
    <>
      <SiteHeader />
      <main className="wrap max-w-[860px] pb-10 pt-10">
        <h1 className="section-title text-[clamp(36px,7vw,52px)]">Munim Cares</h1>
        <p className="mt-4 max-w-[52ch] text-[18px]">Surplus food from our kitchens, offered to simulated recipients.</p>

        {total && impact && (
          <div className="card mt-6 p-6" data-ref={total.meals_portions_milli.ref}>
            <p className="display text-[30px]">{formatQty(total.meals_portions_milli.value, SITE.locale)} meals shared across Munim</p>
            <p className="mt-1">{impact.labels.recipients}</p>
            <p className="mt-1 font-semibold">{impact.labels.data}</p>
            <details className="mt-3">
              <summary className="inline-flex min-h-12 cursor-pointer items-center font-semibold">Source</summary>
              <p className="break-all text-[14px] text-muted">{total.meals_portions_milli.ref}</p>
              <p className="text-[14px] text-muted">Snapshot {impact.snapshot_id} · {impact.as_of}</p>
            </details>
          </div>
        )}

        <div className="mt-8 space-y-4" aria-busy={!items && !error}>
          {error ? (
            <div className="card p-6">
              <p className="font-semibold">{error.kind === "rate_limited" ? "Too many requests. Please wait a moment and try again." : errorText(error, "cares")}</p>
              {error.kind === "rate_limited" && seconds > 0 && <p className="num mt-2 text-muted">Trying again in {seconds} s</p>}
            </div>
          ) : !items ? (
            [0, 1].map((i) => <div key={i} className="card h-[180px] p-6"><div className="skeleton h-6 w-1/3" /><div className="skeleton mt-4 h-4 w-2/3" /><div className="skeleton mt-6 h-8 w-1/2" /></div>)
          ) : items.length === 0 ? (
            <p className="card p-6 font-semibold">No donations are listed right now.</p>
          ) : (
            items.map((l) => (
              <article key={l.listing_id} className="card p-6">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <h2 className="text-[26px]">{l.outlet_name}</h2>
                  <span className="badge badge-accent">Simulated recipient</span>
                </div>
                <p className="num mt-2 flex items-center gap-2 text-muted">
                  <ClockIcon size={18} /> Pickup {dayLabel(l.pickup_from, l.tz, SITE.locale)} {formatTime(l.pickup_from, l.tz, SITE.locale)} – {formatTime(l.pickup_to, l.tz, SITE.locale)}
                </p>
                <ul className="mt-4 space-y-3">
                  {l.lines.map((x) => (
                    <li key={x.line_no} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="badge">{FOOD_KIND_LABEL[x.food_kind] ?? titleCase(x.food_kind)}</span>
                      <span className="font-semibold">{x.label ?? (x.label_key ? titleCase(x.label_key) : "Food")}</span>
                      <span className="num">{formatQty(x.qty_milli, SITE.locale)} {unitLabel(x.unit)}</span>
                      {x.expires_on && <span className={`num ${x.food_kind === "cooked" ? "font-bold text-danger" : "text-muted"}`}>Use by {formatDate(x.expires_on, SITE.locale)}</span>}
                    </li>
                  ))}
                </ul>
                <p className="mt-4 flex items-center gap-2 border-t-[1.5px] border-bg-deep pt-4">
                  <Hazelnut size={22} /> <span>To <strong>{l.recipient_name}</strong></span>
                </p>
              </article>
            ))
          )}
        </div>
        <p className="mt-8 rounded-[14px] border-[1.5px] border-dashed border-line px-4 py-3 text-[15px] text-muted">Check your local food-donation rules</p>
      </main>
    </>
  );
}
