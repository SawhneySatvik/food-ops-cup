"use client";
// O1 · Menu (screens/storefront.md). Names, descriptions and diet marks are the owner's plain text (rendered as text, never
// HTML). Prices shown are the menu's own row fields; there is no running total here — "Total at checkout" until a preview
// exists (kit 10 §6).
import { Badge, Button, IconAlert, IconCheck, Sheet, StateEmpty, StateError, StateLoading, type Formatter } from "@munim/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { t } from "../i18n/index.ts";
import type { Menu, MenuItem } from "./api.ts";
import { CaresSection } from "./cares.tsx";
import { dayRuns, formatterFor } from "./format.ts";
import { labelOf, titleCase } from "./names.ts";
import { PayLine } from "./pay.tsx";
import { useMenu, useStore } from "./store.tsx";

const DEALS = "\u0000deals";
const DIET = { veg: "order.menu.diet.veg", non_veg: "order.menu.diet.non_veg", egg: "order.menu.diet.egg", vegan: "order.menu.diet.vegan" } as const;
const DAY = (d: number) => t(`order.menu.day.${d}` as "order.menu.day.1");

export function MenuView() {
  const store = useStore();
  const router = useRouter();
  const { state, reload } = useMenu(store.storeKey, store.outlet?.outlet_id ?? null, 60_000);
  const [tab, setTab] = useState<string | null>(null);
  const [sheetItem, setSheetItem] = useState<MenuItem | null>(null);
  const [toast, setToast] = useState(false);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(false), 1600);
    return () => clearTimeout(id);
  }, [toast]);

  if (store.outlets === null) return <main className="sf-main"><StateError detail={t("order.menu.err")} onRetry={() => router.refresh()} /></main>;
  if (store.outlets.length === 0 || !store.outlet) return <main className="sf-main"><StateEmpty message={t("order.menu.empty")} /></main>;
  const outlet = store.outlet;
  const menu = state.kind === "ok" || state.kind === "off" || state.kind === "err" ? state.menu : null;
  // No pack for the priced currency (or an unknown zone) means no honest formatting: S-err, not a default country.
  const currency = menu?.items[0]?.currency ?? null;
  const fmt = menu ? formatterFor(currency, menu.accepting.tz) : null;
  const count = store.cart.lines.reduce((n, l) => n + l.qtyMilli, 0) / 1000;

  return (
    <>
      <main className="sf-main" lang={fmt?.pack.locale}>
        <header className="sf-col">
          <h1>{outlet.name}</h1>
          {store.outlets.length > 1 && (
            <label className="sf-col">
              <span className="mu-visually-hidden">{t("order.menu.outlet")}</span>
              <select className="sf-select" value={outlet.outlet_id} onChange={(e) => store.selectOutlet(e.target.value)}>
                {store.outlets.map((o) => <option key={o.outlet_id} value={o.outlet_id}>{o.name}</option>)}
              </select>
              {count > 0 && <span className="mu-field-hint">{t("order.menu.switch_clears")}</span>}
            </label>
          )}
        </header>

        {state.kind === "load" && <StateLoading rows={5} />}
        {state.kind === "off" && !menu && <div className="mu-state" data-state="off" role="alert"><p>{t("order.menu.off")}</p><Button onClick={reload}>{t("common.action.retry")}</Button></div>}
        {state.kind === "err" && !menu && (state.refusal?.status === 404
          ? <StateEmpty message={t("order.menu.empty")} />
          : <StateError detail={state.refusal?.reason === "rate_limited" ? t("order.refuse.rate_limited") : t("order.menu.err")} onRetry={reload} />)}
        {menu && menu.items.length === 0 && <StateEmpty message={t("order.menu.empty")} />}
        {menu && menu.items.length > 0 && !fmt && <StateError detail={t("order.menu.err")} onRetry={reload} />}
        {menu && fmt && menu.items.length > 0 && <MenuBody menu={menu} fmt={fmt} offline={state.kind === "off"} tab={tab} setTab={setTab} onOpen={setSheetItem}
          onAdded={() => setToast(true)} />}
        {menu && fmt && currency && <CaresSection currency={currency} />}
      </main>

      {menu && fmt && sheetItem && <OptionsSheet item={sheetItem} fmt={fmt} onClose={() => setSheetItem(null)} onAdded={() => { setSheetItem(null); setToast(true); }} />}
      <div className="sf-cartbar">
        <span><strong>{t("order.cart.button", { count: String(count) })}</strong><br /><span className="mu-field-hint">{t("order.cart.total_at_checkout")}</span>
          {/* In the bar, not floating: it must never cover an item. */}
          <span role="status" aria-live="polite" className="sf-toast">{toast ? t("order.menu.added") : ""}</span></span>
        {count > 0
          ? <Link className="mu-btn" data-variant="primary" href={`/order/${store.storeKey}/checkout`}>{t("order.checkout.title")}</Link>
          : <Button variant="primary" disabled>{t("order.checkout.title")}</Button>}
      </div>
    </>
  );
}


function MenuBody({ menu, fmt, offline, tab, setTab, onOpen, onAdded }: {
  menu: Menu; fmt: Formatter; offline: boolean; tab: string | null; setTab: (t: string) => void; onOpen: (i: MenuItem) => void; onAdded: () => void;
}) {
  const store = useStore();
  const a = menu.accepting;
  const categories = useMemo(() => [...new Set(menu.items.map((i) => i.category))], [menu.items]);
  const tabs = [...(menu.deals.length ? [DEALS] : []), ...categories];
  const active = tab && tabs.includes(tab) ? tab : tabs[0] ?? null;
  const taking = a.state === "open" || a.state === "busy";
  const next = a.next_open ? fmt.dateTime(a.next_open) : null;

  return (
    <>
      <div className="sf-bar">
        <span className="sf-state" data-accepting={a.state}>
          {taking ? <IconCheck size={16} /> : <IconAlert size={16} />}
          {a.state === "open" && t("order.menu.state.open")}
          {a.state === "busy" && t("order.menu.state.busy", { minutes: String(a.busy_extra_min) })}
          {a.state === "paused" && (next ? t("order.menu.state.paused", { next_open: next }) : t("order.menu.state.paused_unknown"))}
          {a.state === "closed" && (next ? t("order.menu.state.closed", { next_open: next }) : t("order.menu.state.closed_unknown"))}
        </span>
        {taking && <span className="sf-state">{t("order.menu.ready_in", { minutes: String(a.default_prep_min + a.busy_extra_min) })}</span>}
      </div>
      {offline && <p className="sf-note" data-tone="warning" role="status">{t("order.menu.off")}</p>}
      <PayLine />

      <div role="tablist" aria-label={t("order.menu.categories")} className="sf-tabs">
        {tabs.map((c) => (
          <button key={c} type="button" role="tab" className="sf-tab" aria-selected={c === active} onClick={() => setTab(c)}>
            {c === DEALS ? t("order.menu.category.deals") : titleCase(c)}
          </button>
        ))}
      </div>

      {active === DEALS ? (
        <ul className="sf-list">
          {menu.deals.map((d) => (
            <li key={d.deal_id} className="sf-item">
              <div>
                <h3>{titleCase(d.name_key)}</h3>
                {d.windows.map((w, i) => (
                  <p key={i}>{t("order.menu.deal_window", { from: w.from, to: w.to })} · {dayRuns(w.days, DAY)}</p>
                ))}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="sf-list">
          {menu.items.filter((i) => i.category === active).map((item) => {
            const soldOut = !item.available || (item.variants.length > 0 && item.variants.every((v) => !v.available));
            const simple = item.variants.length === 0 && item.option_groups.length === 0;
            const name = labelOf(item);
            return (
              <li key={item.item_id} className="sf-item" data-sold-out={soldOut || undefined}>
                <div className="sf-col">
                  <h3>{name}</h3>
                  {item.description && <p>{item.description}</p>}
                  <div className="sf-meta">
                    {item.diet && <Badge tone={item.diet === "non_veg" ? "danger" : "success"}>{t(DIET[item.diet])}</Badge>}
                    {soldOut && <Badge tone="danger" icon={<IconAlert size={14} />}>{t("order.menu.sold_out")}</Badge>}
                    {!soldOut && item.price_minor !== null && (
                      <span className="sf-price" data-minor={item.price_minor}>
                        {fmt.money(item.price_minor, item.currency)} <span className="mu-field-hint">{menu.prices_include_tax ? t("order.menu.incl_tax") : t("order.menu.plus_tax")}</span>
                      </span>
                    )}
                  </div>
                </div>
                <Button variant="primary" disabled={soldOut || !taking} aria-label={t("order.menu.add_named", { item: name })}
                  onClick={() => { if (simple) { store.addLine(item.item_id, null, []); onAdded(); } else onOpen(item); }}>
                  {t("order.menu.add")}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function OptionsSheet({ item, fmt, onClose, onAdded }: { item: MenuItem; fmt: Formatter; onClose: () => void; onAdded: () => void }) {
  const store = useStore();
  const [variant, setVariant] = useState<string | null>(item.variants.find((v) => v.available)?.variant_id ?? null);
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const bad = item.option_groups.some((g) => {
    const n = (picked[g.option_group_id] ?? []).length;
    return n < Math.max(g.min_select, g.required ? 1 : 0) || n > g.max_select;
  });
  const toggle = (gid: string, oid: string, max: number) => setPicked((p) => {
    const cur = p[gid] ?? [];
    if (cur.includes(oid)) return { ...p, [gid]: cur.filter((x) => x !== oid) };
    return { ...p, [gid]: max === 1 ? [oid] : cur.length < max ? [...cur, oid] : cur };
  });
  return (
    <Sheet open onClose={onClose} title={labelOf(item)} side="bottom">
      <div className="sf-col">
        {item.description && <p>{item.description}</p>}
        {item.variants.length > 0 && (
          <fieldset className="sf-col"><legend>{t("order.options.choose_variant")}</legend>
            {item.variants.map((v) => (
              <label key={v.variant_id} className="sf-check">
                <input type="radio" name="variant" checked={variant === v.variant_id} disabled={!v.available} onChange={() => setVariant(v.variant_id)} />
                <span>{labelOf(v)} · {v.available ? fmt.money(v.price_minor, item.currency) : t("order.menu.sold_out")}</span>
              </label>
            ))}
          </fieldset>
        )}
        {item.option_groups.map((g) => (
          <fieldset key={g.option_group_id} className="sf-col">
            <legend>
              {labelOf(g)} {g.required && <Badge tone="warning">{t("order.options.required")}</Badge>}{" "}
              <span className="mu-field-hint">{g.max_select === 1 ? t("order.options.pick_one") : g.min_select > 0 ? t("order.options.pick_between", { min: String(g.min_select), max: String(g.max_select) }) : t("order.options.pick_up_to", { max: String(g.max_select) })}</span>
            </legend>
            {g.options.map((o) => (
              <label key={o.option_id} className="sf-check">
                <input type={g.max_select === 1 ? "radio" : "checkbox"} name={g.option_group_id} checked={(picked[g.option_group_id] ?? []).includes(o.option_id)}
                  onChange={() => toggle(g.option_group_id, o.option_id, g.max_select)} />
                <span>{labelOf(o)}{o.price_delta_minor !== 0 && ` · ${t("order.options.delta", { amount: fmt.money(o.price_delta_minor, item.currency) })}`}</span>
              </label>
            ))}
          </fieldset>
        ))}
        <Button variant="primary" size="lg" disabled={bad || (item.variants.length > 0 && !variant)}
          onClick={() => { store.addLine(item.item_id, variant, Object.values(picked).flat()); onAdded(); }}>
          {t("order.options.add")}
        </Button>
      </div>
    </Sheet>
  );
}
