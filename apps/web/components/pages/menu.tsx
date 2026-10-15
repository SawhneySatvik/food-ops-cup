"use client";
// "/o/[outletId]": the menu. Every price shown here is a field of the menu or of a preview response.
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { munim } from "@/lib/munim";
import type { MunimError } from "@/lib/munim/client";
import { addToCart, cartCount, newCartLine, NOTE_MAX, selectionProblems, type Cart } from "@/lib/munim/checkout";
import { canOrder, errorText, refusalText } from "@/lib/munim/copy";
import { formatDays, shownName } from "@/lib/munim/format";
import type { Schemas } from "@/lib/munim/types";
import { categoryLabel, dealLabel, NOTE_FIELDS, SITE, UUID7 } from "@/lib/site";
import { useCart, useCountdown, useOnline, usePreview } from "@/lib/hooks";
import { CategoryMotif } from "../art";
import { copyContext, findItem, lineLabel, money, QtyStepper, unitPriceText } from "../cart-bits";
import { BagIcon, CloseIcon, PlusIcon } from "../icons";
import { DietBadge, ErrorNote, MockPanel, NotValid, OfflineBanner, OutletContact, SiteHeader, StateBanner, Toast, useToast } from "../ui";
import { Ribbon } from "./home";

type Menu = Schemas["StorefrontMenuResponse"];
type Item = Menu["items"][number];
type Outlet = Schemas["StorefrontOutletsResponse"]["outlets"][number];

export function MenuPage() {
  const { outletId } = useParams<{ outletId: string }>();
  if (!UUID7.test(outletId)) return <><SiteHeader /><NotValid /></>;
  return <MenuView outletId={outletId} />;
}

function MenuView({ outletId }: { outletId: string }) {
  const router = useRouter();
  const online = useOnline();
  const { cart, setCart } = useCart(outletId);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [outlet, setOutlet] = useState<Outlet | null>(null);
  const [error, setError] = useState<MunimError | null>(null);
  const [retryAt, setRetryAt] = useState<number | null>(null);
  const [modalItem, setModalItem] = useState<Item | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [toast, showToast] = useToast();

  const load = useCallback(async () => {
    // Menu and outlet details arrive together, so the page lays out once (no shift when the address lands).
    const [r, o] = await Promise.all([munim.getMenu(outletId), munim.listOutlets()]);
    if (o.ok) setOutlet(o.data.outlets.find((x) => x.outlet_id === outletId) ?? null);
    if (!r.ok) {
      if (r.error.kind === "not_found") return router.replace("/not-valid");
      setError(r.error);
      if (r.error.kind === "rate_limited") setRetryAt(Date.now() + (r.error.retryAfterMs ?? 5000));
      return;
    }
    setError(null);
    setRetryAt(null);
    setMenu(r.data);
  }, [outletId, router]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set after the response
    void load();
    // Refresh when the tab regains focus and every 60 s while visible.
    const onFocus = () => document.visibilityState === "visible" && void load();
    const t = setInterval(onFocus, 60_000);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [load]);
  const seconds = useCountdown(retryAt, () => void load());

  const ordering = menu ? canOrder(menu.accepting) : false;
  const categories = useMemo(() => {
    if (!menu) return [];
    const present = [...new Set(menu.items.map((i) => i.category))];
    const order = SITE.categoryOrder as readonly string[];
    return [...order.filter((c) => present.includes(c)), ...present.filter((c) => !order.includes(c))];
  }, [menu]);

  const add = (item: Item) => {
    if (item.variants.length > 0 || item.option_groups.length > 0 || NOTE_FIELDS[item.name_key]) return setModalItem(item);
    setCart((c) => addToCart(c, newCartLine(item.item_id, null, [])));
    showToast("Added");
  };

  const count = cartCount(cart);
  const showOffline = !online || error?.kind === "network";

  return (
    <>
      <SiteHeader count={count} onCart={() => setDrawer(true)} />
      <StateBanner accepting={menu?.accepting ?? null} />
      <OfflineBanner show={showOffline} text="You're offline. Your cart is kept on this phone." />

      {menu && (
        <div className="wrap pt-6">
          <p className="display text-[clamp(30px,6vw,44px)]">{outlet?.name}</p>
          {outlet && <p className="mt-1 text-muted">{outlet.address}</p>}
          <Link href="/" className="mt-2 inline-flex min-h-12 items-center font-semibold">Change bakehouse</Link>
        </div>
      )}

      {!menu ? (
        <div className="wrap min-h-[100dvh] pt-6" aria-busy={!error}>
          {error && error.kind !== "network" ? (
            <div className="card p-6">
              <p className="font-semibold">{errorText(error, "menu")}</p>
              {error.kind === "rate_limited" && seconds > 0 ? (
                <p className="num mt-2 text-muted">Trying again in {seconds} s</p>
              ) : (
                <button type="button" className="btn btn-primary mt-4" onClick={() => void load()}>Try again</button>
              )}
            </div>
          ) : error ? (
            <button type="button" className="btn btn-primary" onClick={() => void load()}>Try again</button>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} className="card h-[188px] p-5"><div className="skeleton h-6 w-24 rounded-full" /><div className="skeleton mt-4 h-5 w-2/3" /><div className="skeleton mt-3 h-4 w-full" /><div className="skeleton mt-2 h-4 w-4/5" /></div>
              ))}
            </div>
          )}
        </div>
      ) : menu.items.length === 0 ? (
        <p className="wrap mt-6"><span className="card block p-6 font-semibold">This menu is being set up. Please check back soon.</span></p>
      ) : (
        <>
          {error?.kind === "rate_limited" && (
            <div className="wrap mt-4"><p className="card p-4 font-semibold">{errorText(error, "menu")} <span className="num font-normal text-muted">{seconds > 0 ? `Trying again in ${seconds} s` : ""}</span></p></div>
          )}
          <CategoryRail categories={categories} deals={menu.deals.length > 0} />
          <Ribbon items={[...categories.map(categoryLabel), ...menu.deals.map((d) => dealLabel(d.name_key)), "Pickup only", "Fresh every morning"]} />
          <div className="wrap">
            {categories.map((c) => (
              <section key={c} id={`category-${c}`} className="scroll-mt-36 pt-10" aria-labelledby={`h-${c}`}>
                <h2 id={`h-${c}`} className="section-title flex items-center gap-3"><CategoryMotif slug={c} />{categoryLabel(c)}</h2>
                <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {menu.items.filter((i) => i.category === c).map((i) => (
                    <ItemCard key={i.item_id} item={i} taxNote={!menu.prices_include_tax} ordering={ordering} onAdd={() => add(i)} />
                  ))}
                </ul>
              </section>
            ))}
            {menu.deals.length > 0 && (
              <section id="category-deals" className="scroll-mt-36 pt-10" aria-labelledby="h-deals">
                <h2 id="h-deals" className="section-title">Deals</h2>
                <ul className="mt-6 grid gap-4 sm:grid-cols-2">
                  {menu.deals.map((d) => (
                    <li key={d.deal_id} className="card bg-accent p-6">
                      <p className="display text-[26px]">{dealLabel(d.name_key)}</p>
                      {d.windows.map((w, i) => <p key={i} className="num mt-1 font-semibold">{formatDays(w.days, SITE.locale)} · {w.from}–{w.to}</p>)}
                      <p className="mt-2">Applied automatically at checkout when your pickup time is in this window.</p>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        </>
      )}

      <OutletContact outlet={outlet} />

      {/* Mobile cart bar: below 1024 px. The page pads its bottom by the same height so the footer stays readable. */}
      <div className="h-20 lg:hidden" aria-hidden="true" />
      <div className="fixed inset-x-0 bottom-0 z-30 p-2 lg:hidden">
        <button type="button" className="card flex min-h-[64px] w-full items-center justify-between px-5 font-semibold" onClick={() => setDrawer(true)}>
          <span className="inline-flex items-center gap-2"><BagIcon /> <span className="num">{count}</span> {count === 1 ? "item" : "items"}</span>
          <span className="text-primary">View cart</span>
        </button>
      </div>

      <ItemModal
        item={modalItem}
        ordering={ordering}
        onClose={() => setModalItem(null)}
        onAdd={(variantId, optionIds, qty, note) => {
          setCart((c) => addToCart(c, newCartLine(modalItem!.item_id, variantId, optionIds, qty, note)));
          setModalItem(null);
          showToast("Added");
        }}
      />
      <CartDrawer open={drawer} onClose={() => setDrawer(false)} cart={cart} setCart={setCart} menu={menu} outlet={outlet} ordering={ordering} />
      <Toast message={toast} />
      <MockPanel onChange={() => void load()} />
    </>
  );
}

/** Next keeps a left route mounted but hidden (React Activity); a modal dialog left open there would make the new
 *  page inert. Effect cleanups run when the route hides, so close the dialog then. */
function useCloseOnHide(ref: React.RefObject<HTMLDialogElement | null>) {
  useEffect(() => {
    const d = ref.current;
    return () => {
      if (d?.open) d.close();
    };
  }, [ref]);
}

function CategoryRail({ categories, deals }: { categories: string[]; deals: boolean }) {
  const all = useMemo(() => [...categories, ...(deals ? ["deals"] : [])], [categories, deals]);
  const [active, setActive] = useState(all[0]);
  const railRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const seen = new Map<string, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id.replace("category-", ""), e.isIntersecting);
        const first = all.find((c) => seen.get(c));
        if (first) setActive(first);
      },
      { rootMargin: "-140px 0px -55% 0px" },
    );
    for (const c of all) {
      const el = document.getElementById(`category-${c}`);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [all]);
  useEffect(() => {
    railRef.current?.querySelector(`[data-cat="${active}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);
  return (
    <nav ref={railRef} aria-label="Menu categories" className="sticky top-[65px] z-20 mt-4 border-b-[1.5px] border-line bg-bg">
      <div className="wrap rail">
        {all.map((c) => (
          <a key={c} data-cat={c} href={`#category-${c}`} className="chip" aria-current={active === c ? "true" : undefined}>
            {c === "deals" ? "Deals" : categoryLabel(c)}
          </a>
        ))}
      </div>
    </nav>
  );
}

function ItemCard({ item, taxNote, ordering, onAdd }: { item: Item; taxNote: boolean; ordering: boolean; onAdd: () => void }) {
  const name = shownName(item);
  const soldOut = !item.available;
  return (
    <li className="card relative flex flex-col p-5">
      <div className="flex items-start justify-between gap-3">
        <div className={soldOut ? "opacity-55" : ""}><CategoryMotif slug={item.category} size={40} /></div>
        {soldOut && <span className="soldout-pill">Sold out</span>}
      </div>
      <div className="mt-3 min-h-[28px]"><DietBadge diet={item.diet} /></div>
      <h3 className="mt-2 font-sans text-[18px] font-bold leading-snug tracking-normal">{name}</h3>
      {item.description && <p className="mt-1 line-clamp-2 text-muted">{item.description}</p>}
      <div className="mt-auto flex items-end justify-between gap-3 pt-4">
        <p className="num font-semibold">
          {item.price_minor !== null ? (
            <>{money(item.price_minor, item.currency)}{taxNote && <span className="ml-1 text-[14px] font-normal text-muted">+ GST</span>}</>
          ) : (
            "Choose size"
          )}
        </p>
        {soldOut ? (
          <button type="button" className="btn" disabled>Sold out</button>
        ) : (
          <button
            type="button"
            className="btn btn-primary btn-round"
            onClick={onAdd}
            disabled={!ordering}
            title={ordering ? undefined : "Not taking orders right now"}
            aria-label={`Add ${name}`}
          >
            <PlusIcon />
          </button>
        )}
      </div>
    </li>
  );
}

function ItemModal({ item, ordering, onClose, onAdd }: { item: Item | null; ordering: boolean; onClose: () => void; onAdd: (variantId: string | null, optionIds: string[], qty: number, note: string | null) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (item && !d.open) d.showModal();
    else if (!item && d.open) d.close();
  }, [item]);
  useCloseOnHide(ref);
  return (
    <dialog ref={ref} className="modal" onClose={onClose} aria-labelledby="item-modal-title">
      {/* Keyed by item: every opening starts from a fresh selection. */}
      {item && <ItemForm key={item.item_id} item={item} ordering={ordering} onClose={onClose} onAdd={onAdd} />}
    </dialog>
  );
}

function ItemForm({ item, ordering, onClose, onAdd }: { item: Item; ordering: boolean; onClose: () => void; onAdd: (variantId: string | null, optionIds: string[], qty: number, note: string | null) => void }) {
  const [variantId, setVariantId] = useState<string | null>(null);
  const [optionIds, setOptionIds] = useState<string[]>([]);
  const [qty, setQty] = useState(1);
  const [note, setNote] = useState("");
  const problems = selectionProblems(item, variantId, optionIds);
  const noteField = NOTE_FIELDS[item.name_key];
  const toggle = (groupOptions: string[], id: string, single: boolean) =>
    setOptionIds((cur) => (single ? [...cur.filter((x) => !groupOptions.includes(x)), id] : cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  return (
    <form method="dialog" className="p-6" onSubmit={(e) => { e.preventDefault(); if (problems.length === 0) onAdd(variantId, optionIds, qty, note); }}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <DietBadge diet={item.diet} />
          <h2 id="item-modal-title" className="mt-2 text-[30px]">{shownName(item)}</h2>
        </div>
        <button type="button" className="btn btn-plain btn-round flex-none" onClick={onClose} aria-label="Close"><CloseIcon /></button>
      </div>
      {item.description && <p className="mt-2 text-muted">{item.description}</p>}

      {item.variants.length > 0 && (
        <fieldset className="mt-6">
          <legend className="font-bold">Choose one <span className="badge ml-2">Required</span></legend>
          <div className="mt-3 grid gap-2">
            {item.variants.map((v) => (
              <label key={v.variant_id} className="choice">
                <input type="radio" name="variant" checked={variantId === v.variant_id} disabled={!v.available} onChange={() => setVariantId(v.variant_id)} />
                <span className="flex-1">{shownName(v)}{!v.available && " — Sold out"}</span>
                <span className="num font-semibold">{money(v.price_minor, item.currency)}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {item.option_groups.map((g) => {
        const single = g.max_select === 1;
        const ids = g.options.map((o) => o.option_id);
        const chosen = optionIds.filter((x) => ids.includes(x)).length;
        return (
          <fieldset key={g.option_group_id} className="mt-6">
            <legend className="font-bold">
              {shownName(g)} {g.required && <span className="badge ml-2">Required</span>}
            </legend>
            <p className="text-[14px] text-muted">{g.description ?? (single ? "Choose one." : g.min_select > 0 ? `Choose ${g.min_select} to ${g.max_select}.` : `Choose up to ${g.max_select}.`)}</p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {g.options.map((o) => {
                const on = optionIds.includes(o.option_id);
                return (
                  <label key={o.option_id} className="choice">
                    <input
                      type={single ? "radio" : "checkbox"}
                      name={g.option_group_id}
                      checked={on}
                      disabled={!single && !on && chosen >= g.max_select}
                      onChange={() => toggle(ids, o.option_id, single)}
                    />
                    <span className="flex-1">{shownName(o)}</span>
                    {o.price_delta_minor !== 0 && <span className="num text-[14px] font-semibold">+{money(o.price_delta_minor, item.currency)}</span>}
                  </label>
                );
              })}
            </div>
          </fieldset>
        );
      })}

      {noteField && (
        <div className="mt-6">
          <label htmlFor="line-note" className="font-bold">{noteField.label}</label>
          <p id="line-note-hint" className="text-[14px] text-muted">{noteField.hint}</p>
          <textarea id="line-note" rows={2} maxLength={NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} aria-describedby="line-note-hint" className="mt-2" />
        </div>
      )}

      <div className="mt-6 flex flex-wrap items-center justify-between gap-4">
        <QtyStepper qty={qty} name={shownName(item)} onChange={(q) => setQty(Math.max(1, q))} />
        <button type="submit" className="btn btn-primary flex-1 sm:flex-none" disabled={problems.length > 0 || !ordering}>Add to cart</button>
      </div>
      <div className="mt-3 min-h-6 text-[14px]">
        {!ordering ? <p className="text-muted">Not taking orders right now</p> : problems[0] ? <p className="font-semibold text-danger">{problems[0]}</p> : <p className="text-muted">Final price is confirmed at checkout.</p>}
      </div>
    </form>
  );
}

function CartDrawer({ open, onClose, cart, setCart, menu, outlet, ordering }: { open: boolean; onClose: () => void; cart: Cart; setCart: (f: (c: Cart) => Cart) => void; menu: Menu | null; outlet: Outlet | null; ordering: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  // The drawer always previews ASAP; the chosen slot and coupon belong to checkout.
  const asap = useMemo(() => ({ ...cart, slot: { pickupWindowId: null, promisedAt: null }, couponCodes: [] }), [cart]);
  const { preview, loading } = usePreview(asap, menu, open);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  useCloseOnHide(ref);

  const setQty = (key: string, q: number) => setCart((c) => ({ ...c, lines: q <= 0 ? c.lines.filter((l) => l.key !== key) : c.lines.map((l) => (l.key === key ? { ...l, qty: q } : l)) }));
  const ctx = copyContext(menu, cart, outlet?.name ?? "This bakehouse", menu?.accepting.next_open ?? null, menu?.accepting.tz ?? "UTC");
  const refusals = preview?.refusals ?? [];

  return (
    <dialog ref={ref} className="drawer" onClose={onClose} aria-labelledby="cart-title">
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between border-b-[1.5px] border-line p-5">
          <h2 id="cart-title" className="text-[28px]">Your cart</h2>
          <button type="button" className="btn btn-plain btn-round" onClick={onClose} aria-label="Close cart"><CloseIcon /></button>
        </div>
        {cart.lines.length === 0 ? (
          <div className="grid flex-1 place-items-center p-6 text-center">
            <div>
              <p className="font-semibold">Your cart is empty.</p>
              <button type="button" className="btn btn-primary mt-4" onClick={onClose}>Back to menu</button>
            </div>
          </div>
        ) : (
          <>
            <ul className="flex-1 space-y-4 overflow-auto p-5">
              {cart.lines.map((l, i) => {
                const { name, detail } = lineLabel(menu, l);
                const pl = preview && refusals.length === 0 ? preview.lines[i] : undefined;
                return (
                  <li key={l.key} className="border-b-[1.5px] border-bg-deep pb-4">
                    <div className="flex justify-between gap-3">
                      <div>
                        <p className="font-bold">{name}</p>
                        {detail && <p className="text-[14px] text-muted">{detail}</p>}
                        {l.note && <p className="text-[14px] italic text-muted">“{l.note}”</p>}
                      </div>
                      <p className="num whitespace-nowrap text-right font-semibold" aria-busy={loading}>
                        {pl ? money(pl.line_total_minor, preview!.currency) : <span className="text-[14px] font-normal text-muted">{unitPriceText(menu, l)}</span>}
                      </p>
                    </div>
                    <div className="mt-2"><QtyStepper qty={l.qty} name={name} onChange={(q) => setQty(l.key, q)} /></div>
                  </li>
                );
              })}
            </ul>
            <div className="space-y-3 border-t-[1.5px] border-line p-5">
              {refusals.length > 0 ? (
                <ul className="space-y-2">
                  {refusals.map((r, i) => (
                    <li key={i} className="space-y-2">
                      <ErrorNote>{refusalText(r.reason_code, r.params ?? {}, ctx)}</ErrorNote>
                      {(r.reason_code === "item_sold_out" || r.reason_code === "item_unavailable") && r.line_no !== null && cart.lines[r.line_no - 1] && (
                        <button type="button" className="btn btn-plain" onClick={() => setQty(cart.lines[r.line_no! - 1]!.key, 0)}>Remove</button>
                      )}
                    </li>
                  ))}
                </ul>
              ) : preview ? (
                <div className="flex items-end justify-between" aria-busy={loading}>
                  <div>
                    <span className="badge badge-accent">Preview</span>
                    <p className="mt-1 text-[14px] text-muted">incl. GST</p>
                  </div>
                  <p className="num text-[24px] font-bold">{money(preview.total_minor, preview.currency)}</p>
                </div>
              ) : (
                <p className="font-semibold">Total at checkout</p>
              )}
              {ordering ? (
                <Link href={`/o/${cart.outletId}/checkout`} className="btn btn-primary w-full" onClick={onClose}>Go to checkout</Link>
              ) : (
                <button type="button" className="btn w-full" disabled>Go to checkout</button>
              )}
            </div>
          </>
        )}
      </div>
    </dialog>
  );
}

export { findItem };
