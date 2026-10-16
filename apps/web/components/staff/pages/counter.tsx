// file: components/staff/pages/counter.tsx
"use client";
// /staff/counter: the till. Left, the counter menu as tiles by category; right, the cart rail priced only by
// POST /v1/orders:preview; one "Place order" attempt, then the order's own page takes the payment. A second tab
// lists today's orders. Nothing on this screen adds money up.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCountdown, useOnline } from "@/lib/hooks";
import { useLive, usePlace, useTillPreview, useTillSetup, useTodayOrders } from "@/lib/counter-hooks";
import { formatMoney, formatTime, shownName } from "@/lib/munim/format";
import { can } from "@/lib/munim/session";
import { ORDER_STATUS, staffErrorText } from "@/lib/munim/staff-copy";
import { topic } from "@/lib/munim/staff-stream";
import {
  addLine, entrySelectionProblems, writeErrorText, KIND_LABEL, MAX_QTY, needsSheet, newTillLine, NOTE_MAX, setQty, tillLineLabel, tillRefusalText,
  type MenuEntry, type TillContext, type TillKind, type TillLine,
} from "@/lib/munim/till";
import type { Schemas } from "@/lib/munim/types";
import { categoryLabel, NOTE_FIELDS, SITE } from "@/lib/site";
import { CategoryMotif } from "../../art";
import { QtyStepper } from "../../cart-bits";
import { CloseIcon } from "../../icons";
import { DietBadge, ErrorNote, FullPage, OfflineBanner, Toast, useToast } from "../../ui";
import { useStaff } from "../shell";
import { SimulateWebOrder } from "../simulate";
import { ORDER_TONE, StatusPill } from "../source";
import { CartRailLine, Tile } from "../till";

type OrderItem = Schemas["V1OrdersList"]["items"][number];
const money = (minor: number, currency: string) => formatMoney(minor, currency, SITE.locale);

export function CounterPage() {
  const { session, outlet } = useStaff();
  if (!can(session, "counter")) return <NotForRole />;
  if (!outlet) return <div className="state-box" role="status">Loading</div>;
  return <Till key={outlet.id} />;
}

export function NotForRole() {
  return (
    <FullPage title="Not for your role" action={<Link href="/staff" className="btn btn-primary">Go to your start page</Link>}>
      <p>The counter and the kitchen are for owners, managers and staff. Ask the owner if you need them.</p>
    </FullPage>
  );
}

function Till() {
  const { session, client, outlet, handleAuth } = useStaff();
  const router = useRouter();
  const online = useOnline();
  const [toast, say] = useToast();
  const [view, setView] = useState<"new" | "orders">("new");
  const { load, reload } = useTillSetup(client, outlet!.id, handleAuth);
  const setup = load.state === "ready" ? load.data : null;
  const [lines, setLines] = useState<TillLine[]>([]);
  const [kind, setKind] = useState<TillKind>("takeaway");
  const [table, setTable] = useState("");
  const [sheet, setSheet] = useState<MenuEntry | null>(null);
  const [bump, setBump] = useState(0);
  const [placeError, setPlaceError] = useState<string | null>(null);
  const [waitUntil, setWaitUntil] = useState<number | null>(null);
  const wait = useCountdown(waitUntil, () => setWaitUntil(null));
  // A business with several brands (a cloud kitchen): the till shows one brand's menu at a time. Hidden with fewer than two.
  const [brands, setBrands] = useState<Array<{ id: string; name: string }>>([]);
  const [brand, setBrand] = useState<string | null>(null);
  useEffect(() => {
    void client.listBrands().then((r) => r.ok && setBrands(r.data.brands.filter((b) => b.active && b.outlet_ids.includes(outlet!.id))));
  }, [client, outlet]);
  const shown = (entries: readonly MenuEntry[]) => (brands.length > 1 && brand ? entries.filter((e) => e.brand_id === brand) : entries);
  const ctx: TillContext | null = useMemo(() => (setup ? { outletId: outlet!.id, channelId: setup.counter.id, deviceId: setup.deviceId, kind, tableRef: kind === "dine_in" ? table.trim().slice(0, 20) || null : null } : null), [setup, outlet, kind, table]);
  const { preview, loading, error: previewError } = useTillPreview(client, ctx, lines, bump);
  const { place, busy } = usePlace(client);
  const orders = useTodayOrders(client, outlet!.id, setup?.menu.business_date ?? null, handleAuth);
  const live = useLive(session, [topic.kds(outlet!.id)], orders.refresh);

  useEffect(() => { if (previewError) handleAuth(previewError); }, [previewError, handleAuth]);
  const refused = preview && preview.refusals.length > 0 ? preview.refusals : null;
  const canPlace = !!ctx && !!preview && !refused && !loading && !busy && wait === 0 && lines.length > 0;

  const doPlace = async () => {
    if (!ctx || !preview || refused) return;
    setPlaceError(null);
    const r = await place(ctx, lines, preview.total_minor);
    if (r.ok) {
      setLines([]);
      router.push(`/staff/counter/orders/${r.orderId}`);
      return;
    }
    if (handleAuth(r.error)) return;
    if (r.error.kind === "rate_limited") setWaitUntil(Date.now() + (r.error.retryAfterMs ?? 5000));
    setPlaceError(r.error.reasonCode ? tillRefusalText(r.error.reasonCode) : writeErrorText(r.error));
    if (!r.keep) setBump((b) => b + 1); // a refusal: re-preview so the rail shows what core says now
  };

  if (load.state === "failed") {
    if (load.error.kind === "not_found") return <FullPage title="Not found."><p>It may have been removed, or it isn&apos;t in your outlets.</p></FullPage>;
    return <main className="staff-main-wide"><ErrorNote>{staffErrorText(load.error, "counter")}</ErrorNote><button type="button" className="btn btn-plain mt-3" onClick={reload}>Try again</button></main>;
  }
  if (load.state === "noCounter") return <FullPage title="No counter yet"><p>This business has no counter channel switched on, so the till can&apos;t sell.</p></FullPage>;

  return (
    <>
      <OfflineBanner top="staff" show={!online} text="You're offline. Showing the last update." />
      <main className="staff-main-wide">
        <div className="flex flex-wrap items-center gap-3 pb-3">
          <div role="tablist" aria-label="Counter" className="flex gap-2">
            <button type="button" role="tab" aria-selected={view === "new"} className="chip" aria-current={view === "new" ? "true" : undefined} onClick={() => setView("new")}>New order</button>
            <button type="button" role="tab" aria-selected={view === "orders"} className="chip" aria-current={view === "orders" ? "true" : undefined} onClick={() => setView("orders")}>
              Today&apos;s orders{orders.items ? ` · ${orders.items.length}${orders.hasMore ? "+" : ""}` : ""}
            </button>
          </div>
          {live.off && (
            <p className="text-[14px] text-muted">Live updates are off. Tap Refresh to update. <button type="button" className="btn btn-ghost" onClick={orders.refresh}>Refresh</button></p>
          )}
          <span className="ml-auto"><SimulateWebOrder onDone={(ok) => { say(ok ? "A simulated web order was sent to the kitchen." : "The simulated order didn't go through."); orders.refresh(); }} /></span>
        </div>

        {view === "orders" ? (
          <OrdersList items={orders.items} hasMore={orders.hasMore} error={orders.error ? staffErrorText(orders.error, "counter") : null} onMore={orders.more} onRetry={orders.refresh} counterId={setup?.counter.id ?? null} channels={setup?.channels ?? []} tz={outlet!.tz} />
        ) : (
          <div className="pos">
            <section aria-label="Menu" className="space-y-5">
              {brands.length > 1 && (
                <div role="radiogroup" aria-label="Brand" className="flex flex-wrap gap-2">
                  <button type="button" role="radio" aria-checked={brand === null} className="chip" aria-current={brand === null ? "true" : undefined} onClick={() => setBrand(null)}>All brands</button>
                  {brands.map((b) => (
                    <button key={b.id} type="button" role="radio" aria-checked={brand === b.id} className="chip" aria-current={brand === b.id ? "true" : undefined} onClick={() => setBrand(b.id)}>{b.name}</button>
                  ))}
                </div>
              )}
              {!setup ? <div className="tile-grid">{Array.from({ length: 9 }, (_, i) => <div key={i} className="skeleton h-[104px]" aria-hidden="true" />)}</div>
                : setup.menu.entries.length === 0 ? <p className="state-box">Nothing is on sale at this counter right now.</p>
                : grouped(shown(setup.menu.entries)).map(([cat, entries]) => (
                  <div key={cat}>
                    <h2 className="mb-2 flex items-center gap-2 text-[22px]"><CategoryMotif slug={cat} size={26} /> {categoryLabel(cat)}</h2>
                    <div className="tile-grid">
                      {entries.map((e) => (
                        <Tile key={`${e.item_id}:${e.variant_id ?? "-"}`} entry={e} onAdd={(x) => (needsSheet(x, !!NOTE_FIELDS[x.name_key]) ? setSheet(x) : setLines((ls) => addLine(ls, newTillLine(x, []))))} />
                      ))}
                    </div>
                  </div>
                ))}
            </section>

            <aside className="card cart-rail" aria-label="This order">
              <h2 className="text-[24px]">New order</h2>
              <div role="radiogroup" aria-label="Order kind" className="grid grid-cols-2 gap-2">
                {(["takeaway", "dine_in"] as const).map((k) => (
                  <button key={k} type="button" role="radio" aria-checked={kind === k} className={`btn ${kind === k ? "btn-primary" : "btn-plain"}`} onClick={() => setKind(k)}>{KIND_LABEL[k]}</button>
                ))}
              </div>
              {kind === "dine_in" && (
                <label className="block font-semibold">Table (optional)<input value={table} maxLength={20} onChange={(e) => setTable(e.target.value)} /></label>
              )}
              {lines.length === 0 ? <p className="text-muted">Tap an item to start an order.</p> : (
                <div aria-busy={loading}>
                  {lines.map((l, i) => {
                    const label = tillLineLabel(l);
                    const pl = preview && !refused ? preview.lines[i] : undefined;
                    const why = refused?.filter((r) => r.line_no === i + 1) ?? [];
                    return (
                      <div key={l.key}>
                        <CartRailLine name={label.name} detail={label.detail} note={l.note} qty={l.qty} lineTotal={pl ? money(pl.line_total_minor, preview!.currency) : null} disabled={busy} onQty={(q) => setLines((ls) => setQty(ls, l.key, Math.min(q, MAX_QTY)))} />
                        {why.map((r) => <p key={r.reason_code} className="font-semibold text-danger">{tillRefusalText(r.reason_code)}</p>)}
                      </div>
                    );
                  })}
                </div>
              )}
              {refused ? (
                <div className="space-y-1">{refused.filter((r) => r.line_no === null).map((r) => <ErrorNote key={r.reason_code}>{tillRefusalText(r.reason_code)}</ErrorNote>)}<p className="text-muted">Fix the lines above to see the total.</p></div>
              ) : preview && lines.length > 0 ? (
                <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1" aria-busy={loading}>
                  <dt>Subtotal <span className="badge">Preview</span></dt><dd className="num text-right">{money(preview.subtotal_minor, preview.currency)}</dd>
                  {preview.discount_minor > 0 && (<><dt>Discount</dt><dd className="num text-right">−{money(preview.discount_minor, preview.currency)}</dd></>)}
                  <dt>Tax</dt><dd className="num text-right">{money(preview.tax_minor, preview.currency)}</dd>
                  <dt className="text-[20px] font-bold">Total</dt><dd className="num text-right text-[24px] font-bold">{money(preview.total_minor, preview.currency)}</dd>
                </dl>
              ) : null}
              {previewError && previewError.kind !== "auth" && (
                <div className="space-y-1"><ErrorNote>{staffErrorText(previewError, "counter")}</ErrorNote><button type="button" className="btn btn-plain" onClick={() => setBump((b) => b + 1)}>Try again</button></div>
              )}
              {placeError && <ErrorNote>{placeError}</ErrorNote>}
              <button type="button" className="btn btn-primary pay-btn" disabled={!canPlace} onClick={() => void doPlace()}>
                {busy ? "Placing…" : wait > 0 ? `Try again in ${wait} s` : preview && !refused && lines.length > 0 ? `Place order · ${money(preview.total_minor, preview.currency)}` : "Place order"}
              </button>
              {lines.length > 0 && <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setLines([])}>Clear order</button>}
              <p className="text-[14px] text-muted">Payment is recorded on the next screen. Recorded only — Munim does not process payments.</p>
            </aside>
          </div>
        )}
        <OptionsSheet entry={sheet} onClose={() => setSheet(null)} onAdd={(line) => { setLines((ls) => addLine(ls, line)); setSheet(null); }} />
        <Toast message={toast} />
      </main>
    </>
  );
}

/** Entries by category, in the site's order first, then any other category in API order. */
function grouped(entries: readonly MenuEntry[]): [string, MenuEntry[]][] {
  const cats = [...new Set(entries.map((e) => e.category))];
  const order = (c: string) => { const i = (SITE.categoryOrder as readonly string[]).indexOf(c); return i === -1 ? SITE.categoryOrder.length + cats.indexOf(c) : i; };
  return cats.sort((a, b) => order(a) - order(b)).map((c) => [c, entries.filter((e) => e.category === c)]);
}

function OptionsSheet({ entry, onClose, onAdd }: { entry: MenuEntry | null; onClose: () => void; onAdd: (l: TillLine) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (entry && !d.open) d.showModal();
    else if (!entry && d.open) d.close();
  }, [entry]);
  return (
    <dialog ref={ref} className="modal" onClose={onClose} aria-labelledby="sheet-title">
      {entry && <SheetForm key={`${entry.item_id}:${entry.variant_id ?? "-"}`} entry={entry} onClose={onClose} onAdd={onAdd} />}
    </dialog>
  );
}

function SheetForm({ entry, onClose, onAdd }: { entry: MenuEntry; onClose: () => void; onAdd: (l: TillLine) => void }) {
  const [optionIds, setOptionIds] = useState<string[]>([]);
  const [qty, setQtyN] = useState(1);
  const [note, setNote] = useState("");
  const problems = entrySelectionProblems(entry, optionIds);
  const noteField = NOTE_FIELDS[entry.name_key];
  const toggle = useCallback((ids: string[], id: string, single: boolean) =>
    setOptionIds((cur) => (single ? [...cur.filter((x) => !ids.includes(x)), id] : cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id])), []);
  const label = tillLineLabel({ entry, optionIds: [] });
  return (
    <form method="dialog" className="p-6" onSubmit={(e) => { e.preventDefault(); if (problems.length === 0) onAdd(newTillLine(entry, optionIds, note, qty)); }}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <DietBadge diet={entry.diet} />
          <h2 id="sheet-title" className="mt-2 text-[28px]">{shownName(entry)}</h2>
          {label.detail && <p className="text-[18px] font-semibold">{label.detail}</p>}
        </div>
        <button type="button" className="btn btn-plain btn-round flex-none" onClick={onClose} aria-label="Close"><CloseIcon /></button>
      </div>
      {entry.option_groups.map((g) => {
        const single = g.max_select === 1;
        const ids = g.options.map((o) => o.option_id);
        const chosen = optionIds.filter((x) => ids.includes(x)).length;
        return (
          <fieldset key={g.option_group_id} className="mt-5">
            <legend className="font-bold">{shownName(g)} {g.required && <span className="badge ml-2">Required</span>}</legend>
            <p className="text-[14px] text-muted">{g.description ?? (single ? "Choose one." : g.min_select > 0 ? `Choose ${g.min_select} to ${g.max_select}.` : `Choose up to ${g.max_select}.`)}</p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {g.options.map((o) => {
                const on = optionIds.includes(o.option_id);
                return (
                  <label key={o.option_id} className="choice min-h-14">
                    <input type={single ? "radio" : "checkbox"} name={g.option_group_id} checked={on} disabled={!single && !on && chosen >= g.max_select} onChange={() => toggle(ids, o.option_id, single)} />
                    <span className="flex-1">{shownName(o)}</span>
                    {o.price_delta_minor !== 0 && <span className="num text-[14px] font-semibold">+{money(o.price_delta_minor, o.currency)}</span>}
                  </label>
                );
              })}
            </div>
          </fieldset>
        );
      })}
      {noteField && (
        <div className="mt-5">
          <label htmlFor="till-note" className="font-bold">{noteField.label}</label>
          <p id="till-note-hint" className="text-[14px] text-muted">{noteField.hint} The kitchen sees it exactly as typed.</p>
          <textarea id="till-note" rows={2} maxLength={NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} aria-describedby="till-note-hint" className="mt-2" />
          <p className="num text-right text-[14px] text-muted">{note.length}/{NOTE_MAX}</p>
        </div>
      )}
      <div className="mt-5 flex flex-wrap items-center justify-between gap-4">
        <QtyStepper qty={qty} name={shownName(entry)} onChange={(q) => setQtyN(Math.max(1, q))} />
        <button type="submit" className="btn btn-primary min-h-16 flex-1 sm:flex-none" disabled={problems.length > 0}>Add to order</button>
      </div>
      <p className="mt-3 min-h-6 text-[14px]">{problems[0] ? <span className="font-semibold text-danger">{problems[0]}</span> : <span className="text-muted">The price is confirmed in the order&apos;s preview.</span>}</p>
    </form>
  );
}

function OrdersList({ items, hasMore, error, onMore, onRetry, counterId, channels, tz }: {
  items: OrderItem[] | null;
  hasMore: boolean;
  error: string | null;
  onMore: () => void;
  onRetry: () => void;
  counterId: string | null;
  channels: { id: string; name: string }[];
  tz: string;
}) {
  if (error && !items) return <div className="space-y-2"><ErrorNote>{error}</ErrorNote><button type="button" className="btn btn-plain" onClick={onRetry}>Try again</button></div>;
  if (!items) return <div className="grid gap-2">{Array.from({ length: 5 }, (_, i) => <div key={i} className="skeleton h-16" aria-hidden="true" />)}</div>;
  if (items.length === 0) return <p className="state-box">No orders yet today.</p>;
  return (
    <div className="card relative overflow-x-auto p-2">
      {error && <ErrorNote>{error}</ErrorNote>}
      <table className="snap-table text-[16px]">
        <thead><tr><th scope="col">Ticket</th><th scope="col">Time</th><th scope="col">Kind</th><th scope="col">From</th><th scope="col">Status</th><th scope="col" className="num">Total</th><th scope="col"><span className="sr-only">Open</span></th></tr></thead>
        <tbody>
          {items.map((o) => (
            <tr key={o.order_id}>
              <td className="num text-[20px] font-bold">#{o.ticket_no}</td>
              <td className="num">{formatTime(o.created_at, tz, SITE.locale)}</td>
              <td>{KIND_LABEL[o.kind]}{o.table_ref ? ` · Table ${o.table_ref}` : ""}</td>
              <td>{o.channel_id === counterId ? "Counter" : (channels.find((c) => c.id === o.channel_id)?.name ?? "Web")}</td>
              <td><StatusPill tone={ORDER_TONE[o.status]!}>{ORDER_STATUS[o.status]}</StatusPill></td>
              <td className="num">{money(o.total_minor, o.currency)}</td>
              <td><Link className="btn btn-plain" href={`/staff/counter/orders/${o.order_id}`}>Open</Link></td>
            </tr>
          ))}
        </tbody>
      </table>
      {hasMore && <button type="button" className="btn btn-plain mt-2 w-full" onClick={onMore}>Load more</button>}
      <p className="p-2 text-[14px] text-muted">Payments show on each order. Open an order to see what is left to pay.</p>
    </div>
  );
}
