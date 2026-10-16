"use client";
// /staff/cares (14): Munim Cares for the bakery's own people. Food at risk of going to waste (a snapshot this page
// mints), the AI's donation proposals waiting for the owner, the owner's own listing, tonight's listings with their
// hand-overs, and the food shared this month. Every recipient is simulated; every number on screen is a row field or a
// snapshot cell with its source chip. Nothing here adds a quantity up. Staff see the header and the listings only.
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOnline } from "@/lib/hooks";
import type { MunimError } from "@/lib/munim/client";
import {
  atRiskParams, atRiskRows, caresCan, caresGate, FOOD_KIND, GATE_TEXT, IMPACT_CELLS, impactParams, isListingDraft, listingDraftView, unitLabel,
  type AtRiskRow, type CaresProfile, type ListingDraft, type Listing, type Recipient,
} from "@/lib/munim/cares-flow";
import type { Outcome } from "@/lib/munim/drafts";
import { formatClock, formatDate, titleCase } from "@/lib/munim/format";
import { formatCell, snapRef, outletNames, type CellFormat, type Snapshot } from "@/lib/munim/refs";
import { can } from "@/lib/munim/session";
import { watchFor } from "@/lib/munim/staff-app";
import { staffErrorText } from "@/lib/munim/staff-copy";
import { topic, type LiveState } from "@/lib/munim/staff-stream";
import { templateWords } from "@/lib/munim/template-words";
import type { Schemas } from "@/lib/munim/types";
import { SITE } from "@/lib/site";
import { ErrorNote, FullPage, OfflineBanner, Toast, useToast } from "../../ui";
import { ListingCard } from "../cares/listing-card";
import { ListingDraftCard } from "../cares/listing-draft";
import { OwnListingForm } from "../cares/own-listing";
import { useStaff } from "../shell";
import { CannotVerify, SimulatedRecipient, SnapshotDrawer, SourcedValue } from "../source";
import { LiveLine } from "./inbox";

type Outlet = Schemas["V1Outlets"]["outlets"][number];
type Menu = Schemas["V1CatalogueMenu"];
type Ingredient = Schemas["V1InventoryIngredients"]["items"][number];
type Detail = Schemas["V1DraftDetail"] & { draft: ListingDraft };
type Proposal = { detail: Detail; match: Snapshot | null | "failed" };
/** A panel's data: null while loading, an error when its call failed. */
type Panel<T> = T | MunimError | null;
const failed = <T,>(p: Panel<T>): p is MunimError => p !== null && typeof p === "object" && "kind" in p && "status" in p && !("snapshot_id" in p);

const STALE = "The numbers behind this changed since it was proposed. It can no longer be approved or rejected; a new proposal will replace it.";

export function CaresScreen() {
  const { session, outlet } = useStaff();
  if (!can(session, "cares")) {
    return (
      <FullPage title="Munim Cares isn't part of your role." action={<Link href="/staff" className="btn btn-primary">Go to my screen</Link>}>
        <p>Ask the owner if you need it.</p>
      </FullPage>
    );
  }
  if (!outlet) return <main className="wrap staff-main"><div className="state-box" role="status">Loading</div></main>;
  return <Cares key={outlet.id} outlet={outlet} />;
}

function Cares({ outlet }: { outlet: Outlet }) {
  const { session, client, outlets, handleAuth } = useStaff();
  const role = session.me.role;
  const insight = caresCan(role, "insight");
  // inbox:<tenant> is owner and manager only: opening it for anyone else would make the whole stream 404.
  const watches = role === "owner" || role === "manager";
  const online = useOnline();
  const [toast, say] = useToast();
  const [profile, setProfile] = useState<Panel<CaresProfile>>(null);
  const [tenant, setTenant] = useState<Schemas["V1Tenant"] | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [ingredients, setIngredients] = useState<Ingredient[]>([]);
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [listings, setListings] = useState<Panel<Listing[]>>(null);
  const [atRisk, setAtRisk] = useState<Panel<Snapshot>>(null);
  const [impact, setImpact] = useState<Panel<Snapshot>>(null);
  const [proposals, setProposals] = useState<Panel<Proposal[]>>(null);
  const [notFound, setNotFound] = useState(false);
  const [netDown, setNetDown] = useState(false);
  const [live, setLive] = useState<LiveState>("connecting");
  const [drawer, setDrawer] = useState<{ snapshotId: string; refToken: string } | null>(null);
  const [own, setOwn] = useState<{ prefill: AtRiskRow | null; n: number } | null>(null);
  // The owner's last own listing, confirmed in place (a toast cannot carry the recipient's badge).
  const [listed, setListed] = useState<{ name: string; when: string } | null>(null);
  const ownRef = useRef<HTMLElement>(null);
  const today = menu?.business_date ?? null;
  const gate = profile && !failed(profile) ? caresGate(profile, outlet.id) : null;
  const showInsight = insight && gate === "on";

  /** Every failed call: a 401 signs out; a network failure shows the offline bar. Returns the error to keep. */
  const seen = useCallback((e: MunimError): MunimError | null => {
    if (handleAuth(e)) return null;
    if (e.kind === "network") setNetDown(true);
    return e;
  }, [handleAuth]);
  const ok = () => setNetDown(false);

  const loadListings = useCallback(async () => {
    const r = await client.listListings({ outlet: outlet.id });
    if (r.ok) { ok(); setListings(r.data.items); return; }
    if (r.error.kind === "not_found") { setNotFound(true); return; }
    const e = seen(r.error);
    if (e) setListings((was) => (was && !failed(was) ? was : e)); // a list already shown stays
  }, [client, outlet.id, seen]);

  const mintImpact = useCallback(async (day: string) => {
    const r = await client.mintSnapshot({ template_id: "cares.impact", params: impactParams(outlet.id, day) });
    if (r.ok) setImpact(r.data);
    else { const e = seen(r.error); if (e) setImpact(e); }
  }, [client, outlet.id, seen]);

  const mintAtRisk = useCallback(async (day: string) => {
    const r = await client.mintSnapshot({ template_id: "inventory.expiry_risk", params: atRiskParams(outlet.id, day) });
    if (r.ok) setAtRisk(r.data);
    else { const e = seen(r.error); if (e) setAtRisk(e); }
  }, [client, outlet.id, seen]);

  /** The proposals chain (14 §3): proposed Cares drafts for this outlet, each one's detail, and its ranking. */
  const loadProposals = useCallback(async () => {
    const list = await client.listDrafts({ status: "proposed", outlet: outlet.id });
    if (!list.ok) { const e = seen(list.error); if (e) setProposals((was) => (was && !failed(was) ? was : e)); return; }
    const mine = list.data.items.filter((i) => isListingDraft(i.draft));
    const details = await Promise.all(mine.map((i) => client.getDraft(i.draft.draft_id)));
    const out: Proposal[] = [];
    for (const d of details) {
      if (!d.ok) { seen(d.error); continue; } // a draft that left (404) or failed: the next refetch tries again
      if (!isListingDraft(d.data.draft) || d.data.draft.status !== "proposed") continue;
      const detail = d.data as Detail;
      const id = listingDraftView(detail.draft, detail.unverified_refs).matchSnapshotId;
      const snap = id ? await client.getSnapshot(id) : null;
      out.push({ detail, match: snap && snap.ok ? snap.data : "failed" });
    }
    setProposals(out);
  }, [client, outlet.id, seen]);

  /** First load (and "Try again" on the base calls). Insight panels follow once Cares is known to be on here. */
  const loadAll = useCallback(async () => {
    const [p, t, m, ing, rec] = await Promise.all([client.getCaresProfile(), client.getTenant(), client.getMenu(outlet.id, "counter"), client.listIngredients(), client.listRecipients(outlet.id)]);
    void loadListings();
    if (t.ok) setTenant(t.data);
    if (ing.ok) setIngredients(ing.data.items);
    if (rec.ok) setRecipients(rec.data.items);
    if (m.ok) setMenu(m.data);
    for (const r of [p, t, m, ing, rec]) if (!r.ok && r.error.kind === "not_found") { setNotFound(true); return; }
    for (const r of [t, m, ing, rec]) if (!r.ok) seen(r.error);
    if (!p.ok) { const e = seen(p.error); if (e) setProfile(e); return; }
    setProfile(p.data);
    if (!insight || caresGate(p.data, outlet.id) !== "on" || !m.ok) return;
    const day = m.data.business_date;
    void mintAtRisk(day);
    void mintImpact(day);
    void loadProposals();
  }, [client, outlet.id, insight, loadListings, loadProposals, mintAtRisk, mintImpact, seen]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set after the responses
    void loadAll();
  }, [loadAll]);

  // inbox:<tenant> wakes the proposals, for the roles that may open it.
  useEffect(() => {
    if (!showInsight || !watches) return;
    return watchFor(session, [topic.inbox(session.tenantId)], () => void loadProposals(), setLive);
  }, [showInsight, watches, session, loadProposals]);

  // There is no live topic for listings: refetch when the tab comes back (snapshots are not re-minted on focus).
  const refresh = useCallback(() => {
    void loadListings();
    if (showInsight) void loadProposals();
  }, [loadListings, loadProposals, showInsight]);
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  /** After the person's own command: the listings, and for insight roles a fresh impact snapshot. */
  const afterCommand = () => {
    void loadListings();
    if (showInsight && today) void mintImpact(today);
  };
  const onOutcome = (o: Outcome) => {
    if (o.kind === "signed_out") { handleAuth(o.error); return; }
    if (o.kind === "done") say(o.type === "drafts.reject.v1" ? "Rejected. Nothing was listed." : "Approved. The listing is published.");
    if (o.kind === "stale") say(STALE);
    if (o.kind === "decided_elsewhere") say("Someone else already decided this. It has been refreshed.");
    if (o.kind === "cannot_verify") say("Cannot verify — some numbers in this draft no longer trace to their source rows.");
    // Cares was switched off, or the outlet left it, since the page loaded: load the profile again (the gate card shows).
    if (o.kind === "refused" && o.error.reasonCode?.startsWith("cares_not_")) {
      void loadAll();
      return;
    }
    void loadProposals();
    afterCommand();
  };

  if (notFound) return <FullPage title="Not found."><p>It may have been removed, or it isn&apos;t in your outlets.</p></FullPage>;

  const fmt: CellFormat | null = tenant ? { locale: SITE.locale, currency: tenant.base_currency, outletNames: outletNames(outlets) } : null;
  const tz = outlet.tz;
  const openDrawer = (snapshotId: string, refToken: string) => setDrawer({ snapshotId, refToken });
  const here = profile && !failed(profile) ? profile.outlets.find((o) => o.outlet_id === outlet.id) : undefined;
  const labels = profile && !failed(profile) ? profile.labels : null;
  const proposalBatches = new Set(proposals && !failed(proposals) ? proposals.flatMap((p) => p.detail.draft.payload.lines.map((l) => l.batch_id)) : []);
  const ingName = (id: string) => ingredients.find((i) => i.ingredient_id === id)?.name;
  const published = listings && !failed(listings) ? listings.filter((l) => l.status === "published") : [];
  const earlier = listings && !failed(listings) ? listings.filter((l) => l.status !== "published") : [];
  const openOwn = (prefill: AtRiskRow | null) => {
    setListed(null);
    setOwn((o) => ({ prefill, n: (o?.n ?? 0) + 1 }));
    requestAnimationFrame(() => ownRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  const retryLine = (e: MunimError, again: () => void) => (
    <div className="space-y-2"><ErrorNote>{staffErrorText(e, "cares")}</ErrorNote><button type="button" className="btn btn-plain" onClick={again}>Try again</button></div>
  );

  const gateCard = gate && gate !== "on" && (
    <section className="card p-5" aria-label="Munim Cares status"><p className="text-[19px] font-semibold">{GATE_TEXT[gate]}</p></section>
  );

  const impactCard = showInsight && (
    <section aria-labelledby="impact-title" className="card space-y-3 p-5">
      <h2 id="impact-title" className="text-[22px]">Food shared this month</h2>
      {impact === null || !fmt ? <div className="skeleton h-36" role="status" aria-label="Loading" />
        : failed(impact) ? <><p><CannotVerify /></p>{retryLine(impact, () => today && void mintImpact(today))}</>
        : (
          <div className="space-y-2 text-[17px] font-semibold">
            {IMPACT_CELLS.map((c) => {
              const v = impact.rows[0]?.[c.column];
              return (
                <p key={c.column}>
                  {c.label}{" "}
                  {v === undefined ? <CannotVerify /> : <SourcedValue text={`${formatCell(v, c.column, fmt)}${c.after}`} refToken={snapRef(impact.snapshot_id, 0, c.column)} onOpen={openDrawer} />}
                </p>
              );
            })}
          </div>
        )}
      {labels && <p className="text-[14px] text-muted">{labels.data} · {labels.recipients}</p>}
    </section>
  );

  const profileStrip = profile && !failed(profile) && (
    <section aria-label="Cares profile" className="card space-y-1 p-5">
      <p className="text-[19px] font-semibold">{profile.profile?.public_name ?? outlet.name}</p>
      {here && <p>Pickup hours {formatClock(here.pickup_from, SITE.locale)} – {formatClock(here.pickup_to, SITE.locale)}</p>}
      {here && <p className="text-muted">{titleCase(here.city_code)}</p>}
    </section>
  );

  return (
    <>
      <OfflineBanner top="staff" show={!online || netDown} text="You're offline. Showing the last update." />
      <main className="pb-12">
        <div className="wrap staff-main space-y-6">
          <header className="space-y-2">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <h1 className="section-title">Munim Cares</h1>
              <div className="flex flex-wrap items-center gap-2">
                <LiveLine state={showInsight && watches ? live : "open"} onRefresh={refresh} />
                <button type="button" className="btn btn-plain" onClick={refresh}>Refresh</button>
              </div>
            </div>
            <p className="font-semibold">Surplus food to simulated recipients · Measured on synthetic data · Check your local food-donation rules</p>
            {failed(profile) && retryLine(profile, () => void loadAll())}
          </header>

          <div className="grid items-start gap-6 min-[1100px]:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
            <aside className="grid gap-4 min-[1100px]:sticky min-[1100px]:top-[132px] min-[1100px]:col-start-2 min-[1100px]:row-start-1">
              {profile === null && <div className="skeleton h-28" role="status" aria-label="Loading" />}
              {profileStrip}
              {impactCard}
            </aside>

            <div className="grid min-w-0 gap-8 min-[1100px]:col-start-1 min-[1100px]:row-start-1">
              {gateCard}

              {showInsight && (
                <section aria-labelledby="risk-title" className="space-y-3">
                  <h2 id="risk-title" className="text-[26px]">Food at risk</h2>
                  {atRisk === null || !fmt ? <div className="skeleton h-32" role="status" aria-label="Loading" />
                    : failed(atRisk) ? retryLine(atRisk, () => today && void mintAtRisk(today))
                    : atRiskRows(atRisk).length === 0 ? <p className="text-muted">Nothing at {outlet.name} is close to its use-by date.</p>
                    : (
                      <ul className="grid gap-3">
                        {atRiskRows(atRisk).map((r) => {
                          const cell = (column: string, after = "") => {
                            const v = atRisk.rows[r.row]?.[column];
                            return v === undefined ? <CannotVerify /> : <SourcedValue text={`${formatCell(v, column, fmt)}${after}`} refToken={snapRef(atRisk.snapshot_id, r.row, column)} onOpen={openDrawer} />;
                          };
                          return (
                            <li key={r.batchId} className="card grid gap-2 p-4 sm:grid-cols-[1fr_auto] sm:items-center">
                              <div className="space-y-1">
                                <p className="flex flex-wrap items-center gap-2 text-[19px] font-semibold">
                                  {ingName(r.ingredientId) ?? String(atRisk.rows[r.row]?.ingredient_name ?? "Stock item")}
                                  <span className="badge">{FOOD_KIND[r.foodKind]}</span>
                                  {proposalBatches.has(r.batchId) && <span className="badge badge-new">A donation is proposed</span>}
                                </p>
                                <p className="text-muted">Use by {formatDate(r.expiresOn, SITE.locale)}</p>
                                <p>At risk: {cell("at_risk_qty_milli", ` ${unitLabel(r.unit)}`)}</p>
                                <p>Worth {cell("at_risk_minor")} at cost</p>
                              </div>
                              {caresCan(role, "publish") && <button type="button" className="btn btn-plain" onClick={() => openOwn(r)}>List this</button>}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                </section>
              )}

              {showInsight && (
                <section aria-labelledby="proposals-title" className="space-y-3">
                  <h2 id="proposals-title" className="text-[26px]">Proposed by Munim</h2>
                  {proposals === null || !fmt ? <div className="skeleton h-64" role="status" aria-label="Loading" />
                    : failed(proposals) ? retryLine(proposals, () => void loadProposals())
                    : proposals.length === 0 ? <p className="text-muted">No proposals waiting.</p>
                    : proposals.map((p) => (
                      <ListingDraftCard key={p.detail.draft.draft_id} detail={p.detail} match={p.match} recipients={recipients} menu={menu} ingredients={ingredients}
                        session={session} client={client} fmt={fmt} tz={tz} onOpen={openDrawer} onOutcome={onOutcome} />
                    ))}
                </section>
              )}

              {gate === "on" && caresCan(role, "publish") && fmt && (
                <section ref={ownRef} aria-labelledby={own ? "own-listing" : "own-title"} className="scroll-mt-36 space-y-3">
                  {!own && <h2 id="own-title" className="text-[26px]">List food yourself</h2>}
                  {own ? (
                    <OwnListingForm key={`${own.prefill?.batchId ?? "blank"}:${own.n}`} outletId={outlet.id} prefill={own.prefill} menu={menu} ingredients={ingredients}
                      session={session} client={client} fmt={fmt} tz={tz} onOpen={openDrawer} onAuth={handleAuth}
                      onPublished={(l) => { setListed(l); setOwn(null); afterCommand(); }} onCancel={() => setOwn(null)} />
                  ) : (
                    <>
                      {listed && (
                        <p className="card flex flex-wrap items-center gap-2 p-4 font-semibold" role="status">
                          Listed. {listed.name} <SimulatedRecipient /> can pick it up {listed.when}.
                        </p>
                      )}
                      <div className="card flex flex-wrap items-center justify-between gap-3 p-5">
                        <p className="max-w-[48ch] text-muted">Have something left that Munim didn&apos;t spot? List it for a simulated recipient to collect.</p>
                        <button type="button" className="btn btn-secondary" onClick={() => openOwn(null)}>Start a listing</button>
                      </div>
                    </>
                  )}
                </section>
              )}

              <section aria-labelledby="listings-title" className="space-y-4">
                <h2 id="listings-title" className="text-[26px]">Listings</h2>
                {listings === null || !tenant ? <div className="skeleton h-48" role="status" aria-label="Loading" />
                  : failed(listings) ? retryLine(listings, () => void loadListings())
                  : listings.length === 0 ? <div className="state-box"><p>No food listed today.</p></div>
                  : (
                    <>
                      <h3 className="text-[20px]">Waiting for pickup</h3>
                      {published.length === 0 ? <p className="text-muted">No food listed today.</p> : published.map((l) => (
                        <ListingCard key={l.listing_id} listing={l} recipients={recipients} menu={menu} ingredients={ingredients} session={session} client={client}
                          tz={tz} locale={SITE.locale} currency={tenant.base_currency} onAuth={handleAuth} onChanged={(text) => { if (text) say(text); afterCommand(); }} />
                      ))}
                      {earlier.length > 0 && <h3 className="pt-2 text-[20px]">Earlier</h3>}
                      {earlier.map((l) => (
                        <ListingCard key={l.listing_id} listing={l} recipients={recipients} menu={menu} ingredients={ingredients} session={session} client={client}
                          tz={tz} locale={SITE.locale} currency={tenant.base_currency} onAuth={handleAuth} onChanged={(text) => { if (text) say(text); afterCommand(); }} />
                      ))}
                    </>
                  )}
              </section>
            </div>
          </div>
        </div>
        {fmt && <SnapshotDrawer client={client} open={drawer} onClose={() => setDrawer(null)} fmt={fmt} tz={tz} label={templateWords} />}
        <Toast message={toast} />
      </main>
    </>
  );
}
