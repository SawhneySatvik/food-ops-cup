"use client";
// Munim Cares (docs/plan/screens/cares.md): enrolment, listings, offers, impact. Every write is a named person's own
// command (or an AI draft approved on T-064's screen); every number is a row field or a snapshot cell.
import { Badge, Button, Skeleton, StateEmpty, StateError } from "@munim/ui";
import { useState } from "react";
import { useConsole } from "../../../lib/console/context.tsx";
import { useCaresData } from "../../../lib/cares/data.ts";
import { cityName } from "../../../lib/cares/model.ts";
import { ImpactTab } from "../../../lib/cares/impact.tsx";
import { NewListingForm, ListingsTab, PUBLISH, type FilterId } from "../../../lib/cares/listings.tsx";
import { OffersTab } from "../../../lib/cares/offers.tsx";
import { CaresLabels } from "../../../lib/cares/shared.tsx";
import { t } from "../../../lib/i18n/index.ts";
import "./cares.css";

const TABS = ["listings", "offers", "impact"] as const;
type Tab = (typeof TABS)[number];

export default function CaresPage() {
  const c = useConsole();
  const data = useCaresData(c.outletId, c.outlets.map((o) => o.id));
  const [tab, setTab] = useState<Tab>("listings");
  const [filter, setFilter] = useState<FilterId>("all");
  const [creating, setCreating] = useState(false);
  const shownOutlets = c.outlets.filter((o) => c.outletId === null || o.id === c.outletId);
  const canCreate = PUBLISH.includes(c.member.role) && data.enrolledIds.length > 0;

  if (data.profile.status === "loading") return <Skeleton rows={5} />;
  if (data.profile.status === "err") return <StateError onRetry={data.reload} />;
  const p = data.profile.data;

  return (
    <div className="cares" data-screen="cares">
      <header className="cares-head">
        <h1>{t("cares.title")}</h1>
        <CaresLabels labels={p.labels} />
      </header>

      {!p.available && <StateEmpty message={t("cares.unavailable")} />}
      {p.available && !p.enabled && <StateEmpty message={t("cares.not_enabled")} />}
      {p.available && p.enabled && !p.profile && <StateEmpty message={t("cares.not_joined")} />}

      {p.available && p.enabled && p.profile && (
        <>
          {shownOutlets.length === 0 ? <StateEmpty message={t("cares.enrolment.none")} /> : (
          <section className="cares-enrolment" data-block="enrolment">
            <h2>{t("cares.enrolment.title")}</h2>
            <ul>
              {shownOutlets.map((o) => {
                const e = p.outlets.find((x) => x.outlet_id === o.id);
                return (
                  <li key={o.id} data-outlet-id={o.id} data-enrolled={e ? (e.active ? "yes" : "paused") : "no"}>
                    <strong>{o.name}</strong>{" "}
                    {e && <>{cityName(e.city_code)} · {t("cares.enrolment.pickup", { from: e.pickup_from, to: e.pickup_to })} </>}
                    <Badge tone={e?.active ? "success" : "neutral"}>{t(e ? (e.active ? "cares.enrolment.enrolled" : "cares.enrolment.paused") : "cares.enrolment.not")}</Badge>
                  </li>
                );
              })}
            </ul>
          </section>
          )}

          <div className="cares-tabs" role="tablist">
            {TABS.map((id) => (
              <Button key={id} role="tab" aria-selected={tab === id} variant={tab === id ? "primary" : "secondary"} onClick={() => setTab(id)}>{t(`cares.tab.${id}`)}</Button>
            ))}
            {canCreate && !creating && <Button variant="primary" onClick={() => { setTab("listings"); setCreating(true); }}>{t("cares.action.new")}</Button>}
          </div>

          {creating && <NewListingForm data={data} outletIds={data.enrolledIds} onClose={() => setCreating(false)} onDone={data.reload} />}
          <div role="tabpanel" data-tab={tab}>
            {tab === "listings" && <ListingsTab data={data} filter={filter} setFilter={setFilter} canCreate={canCreate} onNew={() => setCreating(true)} />}
            {tab === "offers" && <OffersTab data={data} b2bEnabled={p.profile.b2b_enabled} />}
            {tab === "impact" && <ImpactTab />}
          </div>
        </>
      )}
    
    </div>
  );
}
