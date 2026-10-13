"use client";
// Listings: the rows (donations and offers), the person's own commands on them (record hand-over, withdraw, publish),
// and the drafts waiting in the inbox. Every write here is a named person's command with an idempotency key; AI-proposed
// listings are drafts approved on T-064's screen, linked, not rebuilt (R16).
import { AiGate, Badge, Button, Card, Skeleton, StateEmpty, StateError, parseMinor } from "@munim/ui";
import { api } from "../api.ts";
import Link from "next/link";
import { useState } from "react";
import { useConsole, type Role } from "../console/context.tsx";
import { t } from "../i18n/index.ts";
import { newIntent, send, type CaresData, type Intent, type Outcome } from "./data.ts";
import { milliToInput, parseMilli, zonedToIso, type Listing } from "./model.ts";
import { OutcomeView, RecipientName, StatusBadge, useFormatters } from "./shared.tsx";

const PUBLISH: readonly Role[] = ["owner", "judge"];
const WITHDRAW: readonly Role[] = ["owner", "manager", "judge"];
const HANDOVER: readonly Role[] = ["owner", "manager", "staff", "judge"];

export type FilterId = "all" | "published" | "handed_over" | "closed" | "withdrawn";
const FILTERS: readonly FilterId[] = ["all", "published", "handed_over", "closed", "withdrawn"];

export function matchesFilter(l: Pick<Listing, "status" | "handovers">, f: FilterId): boolean {
  if (f === "all") return true;
  if (f === "handed_over") return l.status === "closed" && l.handovers.some((h) => h.status === "recorded");
  if (f === "closed") return l.status === "closed" && !l.handovers.some((h) => h.status === "recorded");
  return l.status === f;
}

export function ListingCard({ listing: l, data, onChanged }: { listing: Listing; data: CaresData; onChanged: () => void }) {
  const c = useConsole();
  const f = useFormatters().forOutlet(l.outlet_id);
  const outlet = c.outlets.find((o) => o.id === l.outlet_id);
  const [panel, setPanel] = useState<"none" | "handover">("none");
  const [askWithdraw, setAskWithdraw] = useState(false);
  const [handedNote, setHandedNote] = useState(false);
  const [withdraw, setWithdraw] = useState<{ intent: Intent; outcome: Outcome | null; busy: boolean }>({ intent: newIntent(), outcome: null, busy: false });
  const published = l.status === "published";
  const recipient = l.recipient_id ? data.recipients.get(l.recipient_id)?.name ?? null : null;

  const lineLabel = (ln: Listing["lines"][number]) =>
    (ln.batch_id ? data.batches.get(ln.batch_id)?.batch_code : null) ?? t(ln.food_kind === "cooked" ? "cares.label.dish" : "cares.label.ingredient");
  const lineById = new Map(l.lines.map((ln) => [ln.line_id, ln]));

  async function doWithdraw() {
    setWithdraw((w) => ({ ...w, busy: true }));
    const outcome = await send(() => api.POST("/v1/cares/listings/{id}:withdraw", {
      params: { path: { id: l.listing_id } },
      body: { command_id: withdraw.intent.command_id, idempotency_key: withdraw.intent.idempotency_key, type: "cares.listing.withdraw.v1", payload: { listing_id: l.listing_id } },
    }));
    setWithdraw((w) => ({ ...w, busy: false, outcome }));
    if (outcome.ok) onChanged();
  }

  return (
    <Card className="cares-listing" data-listing-id={l.listing_id} data-kind={l.kind} data-status={l.status}>
      <div className="cares-row">
        <StatusBadge listing={l} />
        <strong>{outlet?.name ?? ""}</strong>
        <span>{t("cares.listing.pickup", { date: f.date(l.pickup_from), from: f.time(l.pickup_from), to: f.time(l.pickup_to) })}</span>
        {l.kind === "donation" && <RecipientName name={recipient} />}
      </div>
      <ul className="cares-lines">
        {l.lines.map((ln) => (
          <li key={ln.line_id} data-line-id={ln.line_id}>
            {ln.expires_on
              ? t("cares.listing.line", { label: lineLabel(ln), qty: f.qtyMilli(ln.qty_milli), unit: ln.unit, date: f.date(ln.expires_on) })
              : t("cares.listing.line_noexpiry", { label: lineLabel(ln), qty: f.qtyMilli(ln.qty_milli), unit: ln.unit })}
            {ln.unit_price_minor !== null && ln.currency && <> · {t("cares.listing.price", { price: f.money(ln.unit_price_minor, ln.currency), unit: ln.unit })} <Badge tone="evidence">{t("cares.money.label")}</Badge></>}
          </li>
        ))}
      </ul>
      {l.handovers.length > 0 && (
        <ul className="cares-handovers">
          {l.handovers.map((h) => (
            <li key={h.handover_id} data-handover={h.status}>
              {h.status === "voided"
                ? t("cares.listing.handover_voided", { time: f.dateTime(h.handed_at) })
                : h.lines.map((hl) => {
                    const ln = lineById.get(hl.listing_line_id);
                    return <span key={hl.listing_line_id}>{t("cares.listing.handover", { time: f.dateTime(h.handed_at), qty: f.qtyMilli(hl.qty_milli), unit: ln?.unit ?? "" })} </span>;
                  })}
            </li>
          ))}
        </ul>
      )}
      {published && l.kind === "donation" && panel === "none" && (
        <div className="cares-actions">
          {HANDOVER.includes(c.member.role) && <Button variant="primary" onClick={() => setPanel("handover")}>{t("cares.action.handover")}</Button>}
          {WITHDRAW.includes(c.member.role) && <Button variant="ghost" onClick={() => setAskWithdraw(true)}>{t("cares.action.withdraw")}</Button>}
        </div>
      )}
      {published && l.kind === "offer" && WITHDRAW.includes(c.member.role) && (
        <div className="cares-actions"><Button variant="ghost" onClick={() => setAskWithdraw(true)}>{t("cares.action.withdraw")}</Button></div>
      )}
      {askWithdraw && published && !withdraw.outcome?.ok && (
        <div className="cares-panel" data-panel="withdraw-confirm">
          <p>{t("cares.withdraw.ask")}</p>
          <div className="cares-actions">
            <Button variant="danger" busy={withdraw.busy} onClick={doWithdraw}>{t("cares.action.withdraw_confirm")}</Button>
            <Button variant="ghost" onClick={() => setAskWithdraw(false)}>{t("cares.action.cancel")}</Button>
          </div>
        </div>
      )}
      <OutcomeView outcome={withdraw.outcome} done={t("cares.withdraw.done")} onRetry={doWithdraw} />
      {handedNote && <p className="mu-recorded" role="status" data-outcome="ok">{t("cares.handover.done")}</p>}
      {panel === "handover" && <HandoverPanel listing={l} lineLabel={lineLabel} onClose={() => setPanel("none")} onDone={() => { setPanel("none"); setHandedNote(true); onChanged(); }} />}
    </Card>
  );
}

function HandoverPanel({ listing: l, lineLabel, onClose, onDone }: { listing: Listing; lineLabel: (ln: Listing["lines"][number]) => string; onClose: () => void; onDone: () => void }) {
  const [qty, setQty] = useState<Record<string, string>>(() => Object.fromEntries(l.lines.map((ln) => [ln.line_id, milliToInput(ln.qty_milli)])));
  const [intent, setIntent] = useState(newIntent);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false);
  const parsed = l.lines.map((ln) => ({ ln, milli: parseMilli(qty[ln.line_id] ?? "") }));
  const valid = parsed.every((p) => p.milli !== null);

  async function submit() {
    if (!valid) return;
    setBusy(true);
    const out = await send(() => api.POST("/v1/cares/handovers", {
      body: {
        command_id: intent.command_id, idempotency_key: intent.idempotency_key, type: "cares.handover.record.v1",
        payload: { handover_id: intent.handover_id, listing_id: l.listing_id, allocation_id: null, lines: parsed.map((p) => ({ listing_line_id: p.ln.line_id, qty_milli: p.milli! })) },
      },
    }));
    setBusy(false);
    setOutcome(out);
    if (out.ok) onDone();
  }

  return (
    <div className="cares-panel" data-panel="handover">
      {parsed.map(({ ln }) => (
        <div className="mu-field" key={ln.line_id}>
          <label htmlFor={`ho-${ln.line_id}`}>{lineLabel(ln)} — {t("cares.handover.qty", { unit: ln.unit })}</label>
          <input id={`ho-${ln.line_id}`} className="mu-input" type="text" inputMode="decimal" value={qty[ln.line_id] ?? ""}
            onChange={(e) => { setQty({ ...qty, [ln.line_id]: e.target.value }); setIntent(newIntent()); setOutcome(null); }} />
        </div>
      ))}
      {!valid && <p className="mu-field-error">{t("cares.form.invalid")}</p>}
      <div className="cares-actions">
        <Button variant="primary" busy={busy} disabled={!valid || outcome?.ok === true} onClick={submit}>{t("cares.action.handover_confirm")}</Button>
        <Button variant="ghost" onClick={onClose}>{t("cares.action.cancel")}</Button>
      </div>
      <OutcomeView outcome={outcome} done={t("cares.handover.done")} onRetry={submit} />
    </div>
  );
}

const UNITS = ["kg", "g", "l", "ml", "unit"] as const;

/** The owner's own `cares.listing.publish.v1`. Raw and packaged stock only (GAP-2: cooked needs an item picker). */
export function NewListingForm({ data, outletIds, onClose, onDone }: { data: CaresData; outletIds: readonly string[]; onClose: () => void; onDone: () => void }) {
  const c = useConsole();
  const formatters = useFormatters();
  const [kind, setKind] = useState<"donation" | "offer">("donation");
  const [outletId, setOutletId] = useState(outletIds[0] ?? "");
  const [batchId, setBatchId] = useState("");
  const [qty, setQty] = useState("");
  const [unit, setUnit] = useState<(typeof UNITS)[number]>("kg");
  const [price, setPrice] = useState("");
  const [recipientId, setRecipientId] = useState("");
  const [date, setDate] = useState("");
  const [from, setFrom] = useState("10:00");
  const [to, setTo] = useState("12:00");
  const [intent, setIntent] = useState(newIntent);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false);

  const outlet = c.outlets.find((o) => o.id === outletId);
  const f = formatters.forOutlet(outletId);
  const batches = data.batchesByOutlet.get(outletId) ?? [];
  const recipients = data.recipientsByOutlet.get(outletId) ?? [];
  const batch = batches.find((b) => b.batch_id === batchId);
  const milli = parseMilli(qty);
  const minor = kind === "offer" ? parseMinor(price, f.pack) : null;
  const pickupFrom = outlet ? zonedToIso(date, from, outlet.tz) : null;
  const pickupTo = outlet ? zonedToIso(date, to, outlet.tz) : null;
  const valid = !!batch && milli !== null && pickupFrom !== null && pickupTo !== null && pickupTo > pickupFrom
    && (kind === "offer" ? minor !== null && minor > 0 : !!recipientId);
  const edit = <T,>(set: (v: T) => void) => (v: T) => { set(v); setIntent(newIntent()); setOutcome(null); };

  async function submit() {
    if (!valid || !batch || milli === null || !pickupFrom || !pickupTo) return;
    setBusy(true);
    const out = await send(() => api.POST("/v1/cares/listings", {
      body: {
        command_id: intent.command_id, idempotency_key: intent.idempotency_key, type: "cares.listing.publish.v1",
        payload: {
          listing_id: intent.listing_id, outlet_id: outletId, kind, recipient_id: kind === "donation" ? recipientId : null,
          pickup_from: pickupFrom, pickup_to: pickupTo,
          lines: [{
            line_id: intent.line_id, food_kind: "raw", item_id: null, ingredient_id: batch.ingredient_id, batch_id: batch.batch_id,
            qty_milli: milli, unit, expires_on: batch.expires_on,
            unit_price_minor: kind === "offer" ? minor : null, currency: kind === "offer" ? f.pack.currency.code : null,
          }],
        },
      },
    }));
    setBusy(false);
    setOutcome(out);
    if (out.ok) onDone();
  }

  return (
    <Card className="cares-form" data-panel="new-listing">
      <div className="cares-grid">
        <div className="mu-field">
          <label htmlFor="cl-kind">{t("cares.form.kind")}</label>
          <select id="cl-kind" className="mu-input" value={kind} onChange={(e) => edit(setKind)(e.target.value as "donation" | "offer")}>
            <option value="donation">{t("cares.form.kind_donation")}</option>
            <option value="offer">{t("cares.form.kind_offer")}</option>
          </select>
        </div>
        <div className="mu-field">
          <label htmlFor="cl-outlet">{t("cares.form.outlet")}</label>
          <select id="cl-outlet" className="mu-input" value={outletId} onChange={(e) => { edit(setOutletId)(e.target.value); setBatchId(""); setRecipientId(""); }}>
            {outletIds.map((id) => <option key={id} value={id}>{c.outlets.find((o) => o.id === id)?.name ?? ""}</option>)}
          </select>
        </div>
        <div className="mu-field">
          <label htmlFor="cl-batch">{t("cares.form.batch")}</label>
          <select id="cl-batch" className="mu-input" value={batchId} onChange={(e) => edit(setBatchId)(e.target.value)}>
            <option value="" />
            {batches.map((b) => (
              <option key={b.batch_id} value={b.batch_id}>
                {b.expires_on ? t("cares.form.batch_line", { code: b.batch_code, date: f.date(b.expires_on) }) : t("cares.form.batch_line_noexpiry", { code: b.batch_code })}
              </option>
            ))}
          </select>
        </div>
        <div className="mu-field">
          <label htmlFor="cl-qty">{t("cares.form.qty")}</label>
          <input id="cl-qty" className="mu-input" type="text" inputMode="decimal" value={qty} onChange={(e) => edit(setQty)(e.target.value)} />
        </div>
        <div className="mu-field">
          <label htmlFor="cl-unit">{t("cares.form.unit")}</label>
          <select id="cl-unit" className="mu-input" value={unit} onChange={(e) => edit(setUnit)(e.target.value as (typeof UNITS)[number])}>
            {UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
          </select>
        </div>
        {kind === "offer" ? (
          <div className="mu-field">
            <label htmlFor="cl-price">{t("cares.form.price")}</label>
            <input id="cl-price" className="mu-input" type="text" inputMode="decimal" value={price} onChange={(e) => edit(setPrice)(e.target.value)} aria-describedby="cl-price-hint" />
            <span id="cl-price-hint" className="mu-field-hint" data-label="money">{t("cares.money.label")}</span>
          </div>
        ) : (
          <div className="mu-field">
            <label htmlFor="cl-recipient">{t("cares.form.recipient")}</label>
            <select id="cl-recipient" className="mu-input" value={recipientId} onChange={(e) => edit(setRecipientId)(e.target.value)}>
              <option value="" />
              {recipients.map((r) => <option key={r.recipient_id} value={r.recipient_id}>{r.name}</option>)}
            </select>
          </div>
        )}
        <div className="mu-field">
          <label htmlFor="cl-date">{t("cares.form.date")}</label>
          <input id="cl-date" className="mu-input" type="date" value={date} onChange={(e) => edit(setDate)(e.target.value)} />
        </div>
        <div className="mu-field">
          <label htmlFor="cl-from">{t("cares.form.from")}</label>
          <input id="cl-from" className="mu-input" type="time" value={from} onChange={(e) => edit(setFrom)(e.target.value)} />
        </div>
        <div className="mu-field">
          <label htmlFor="cl-to">{t("cares.form.to")}</label>
          <input id="cl-to" className="mu-input" type="time" value={to} onChange={(e) => edit(setTo)(e.target.value)} />
        </div>
      </div>
      <p className="mu-field-hint">{t("cares.form.cooked_note")}</p>
      <div className="cares-actions">
        <Button variant="primary" busy={busy} disabled={!valid || outcome?.ok === true} onClick={submit}>{t("cares.action.publish")}</Button>
        <Button variant="ghost" onClick={onClose}>{t("cares.action.cancel")}</Button>
      </div>
      <OutcomeView outcome={outcome} done={t("cares.publish.done")} onRetry={submit} />
    </Card>
  );
}

/** Inbox drafts for `cares.listing.publish.v1`: linked, never repeated (their numbers are refs on the detail screen). */
export function DraftsWaiting() {
  const c = useConsole();
  const f = useFormatters();
  const drafts = (c.inbox?.items ?? []).flatMap((i) => (i.kind === "draft" && i.draft.command_type === "cares.listing.publish.v1" ? [i.draft] : []));
  if (drafts.length === 0) return null;
  return (
    <AiGate enabled={c.aiEnabled}>
      <Card className="cares-drafts" data-block="drafts">
        <h3>{t("cares.drafts.title")}</h3>
        <ul>
          {drafts.map((d) => {
            const outlet = c.outlets.find((o) => d.outlet_ids.includes(o.id));
            return (
              <li key={d.draft_id} data-draft-id={d.draft_id}>
                <Badge tone="accent">{t("draft.label")}</Badge>{" "}
                {t("cares.drafts.item", { outlet: outlet?.name ?? "", created: f.fallback.dateTime(d.created_at) })}{" "}
                <Link href={`/console/inbox/${d.draft_id}`} className="mu-btn" data-variant="secondary" data-size="sm">{t("cares.drafts.review")}</Link>
              </li>
            );
          })}
        </ul>
      </Card>
    </AiGate>
  );
}

export function ListingsTab({ data, filter, setFilter, canCreate, onNew }: { data: CaresData; filter: FilterId; setFilter: (f: FilterId) => void; canCreate: boolean; onNew: () => void }) {
  if (data.listings.status === "loading") return <Skeleton rows={4} />;
  if (data.listings.status === "err") return <StateError onRetry={data.reload} />;
  const donations = data.listings.data.filter((l) => l.kind === "donation");
  const shown = donations.filter((l) => matchesFilter(l, filter));
  return (
    <>
      <DraftsWaiting />
      <div className="cares-filter" role="group">
        {FILTERS.map((id) => (
          <Button key={id} size="sm" variant={filter === id ? "primary" : "secondary"} aria-pressed={filter === id} onClick={() => setFilter(id)}>{t(`cares.filter.${id}`)}</Button>
        ))}
      </div>
      {donations.length === 0 ? (
        <StateEmpty message={t("cares.listings.empty")} action={canCreate ? <Button variant="primary" onClick={onNew}>{t("cares.action.new")}</Button> : undefined} />
      ) : (
        shown.map((l) => <ListingCard key={l.listing_id} listing={l} data={data} onChanged={data.reload} />)
      )}
    </>
  );
}

export { PUBLISH };
