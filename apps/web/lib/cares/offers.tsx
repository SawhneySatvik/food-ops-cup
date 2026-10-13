"use client";
// Offers: the business's own B2B offers (with the claims on them) and the market of other businesses' offers. Money is
// a row field labelled "Recorded, never processed" (the API's own string). Claiming and offer hand-over are not here
// (GAP-3 in docs/plan/screens/cares.md): they need ids no read returns.
import type { Schemas } from "@munim/sdk";
import { Badge, Card, Skeleton, StateEmpty, StateError } from "@munim/ui";
import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { t } from "../i18n/index.ts";
import type { CaresData, Load } from "./data.ts";
import { ListingCard } from "./listings.tsx";
import { useFormatters } from "./shared.tsx";

type Market = Schemas["V1CaresMarket"];
type Claims = Schemas["V1CaresInboundClaims"];

function InboundClaims({ listingId }: { listingId: string }) {
  const [claims, setClaims] = useState<Load<Claims["items"]>>({ status: "loading" });
  useEffect(() => {
    let live = true;
    api.GET("/v1/cares/listings/{id}/claims", { params: { path: { id: listingId } } }).then(
      (r) => live && setClaims(r.data ? { status: "ok", data: r.data.items } : { status: "err" }),
      () => live && setClaims({ status: "err" }),
    );
    return () => { live = false; };
  }, [listingId]);
  if (claims.status !== "ok" || claims.data.length === 0) return null;
  return (
    <div className="cares-claims" data-block="claims">
      <strong>{t("cares.offers.claims")}</strong>
      <ul>{claims.data.map((cl) => <li key={`${cl.claim_tenant_id}:${cl.claim_id}`}>{t("cares.offers.claim", { buyer: cl.buyer_public_name, status: cl.status })}</li>)}</ul>
    </div>
  );
}

function MarketList({ b2bEnabled }: { b2bEnabled: boolean }) {
  const fmt = useFormatters();
  const [market, setMarket] = useState<Load<Market>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!b2bEnabled) return;
    let live = true;
    api.GET("/v1/cares/market").then(
      (r) => live && setMarket(r.data ? { status: "ok", data: r.data } : { status: "err" }),
      () => live && setMarket({ status: "err" }),
    );
    return () => { live = false; };
  }, [b2bEnabled, attempt]);
  if (!b2bEnabled) return <StateEmpty message={t("cares.offers.market_off")} />;
  if (market.status === "loading") return <Skeleton rows={3} />;
  if (market.status === "err") return <StateError onRetry={() => { setMarket({ status: "loading" }); setAttempt((n) => n + 1); }} />;
  if (market.data.items.length === 0) return <StateEmpty message={t("cares.offers.market_empty")} />;
  const f = fmt.fallback;
  return (
    <>
      <Badge tone="evidence">{market.data.money_label}</Badge>
      {market.data.items.map((o) => (
        <Card key={`${o.offer_tenant_id}:${o.listing_id}`} data-market-offer={o.listing_id}>
          <p>{t("cares.offers.market_row", { business: o.business_name, outlet: o.outlet_name, date: f.date(o.pickup_from), from: f.time(o.pickup_from), to: f.time(o.pickup_to) })}</p>
          <ul>
            {o.lines.map((ln) => (
              <li key={ln.offer_line_id}>
                {t("cares.listing.line_noexpiry", { label: ln.label, qty: f.qtyMilli(ln.qty_milli), unit: ln.unit })} · {t("cares.listing.price", { price: f.money(ln.unit_price_minor, ln.currency), unit: ln.unit })}
              </li>
            ))}
          </ul>
        </Card>
      ))}
    </>
  );
}

export function OffersTab({ data, b2bEnabled }: { data: CaresData; b2bEnabled: boolean }) {
  if (data.listings.status === "loading") return <Skeleton rows={4} />;
  if (data.listings.status === "err") return <StateError onRetry={data.reload} />;
  const offers = data.listings.data.filter((l) => l.kind === "offer");
  return (
    <>
      <h3>{t("cares.offers.mine")}</h3>
      {offers.length === 0 ? <StateEmpty message={t("cares.offers.mine_empty")} /> : offers.map((l) => (
        <div key={l.listing_id}>
          <ListingCard listing={l} data={data} onChanged={data.reload} />
          <InboundClaims listingId={l.listing_id} />
        </div>
      ))}
      <h3>{t("cares.offers.market")}</h3>
      <div data-block="market"><MarketList b2bEnabled={b2bEnabled} /></div>
    </>
  );
}
