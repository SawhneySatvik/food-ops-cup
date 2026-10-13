"use client";
// Helpers shared by the cart drawer and checkout: line labels from the menu, the copy context, the qty stepper.
import { MAX_QTY, type Cart, type CartLine } from "@/lib/munim/checkout";
import type { CopyContext } from "@/lib/munim/copy";
import { formatMoney, formatWhen, shownName } from "@/lib/munim/format";
import type { Schemas } from "@/lib/munim/types";
import { dealLabel, SITE } from "@/lib/site";
import { CloseIcon, MinusIcon, PlusIcon } from "./icons";

type Menu = Schemas["StorefrontMenuResponse"];
type Item = Menu["items"][number];

export const money = (minor: number, currency: string) => formatMoney(minor, currency, SITE.locale);

export const findItem = (menu: Menu | null, id: string): Item | null => menu?.items.find((i) => i.item_id === id) ?? null;

/** "Hazelnut Praline Cake" and "1 kg · Eggless" for a cart line (names only, from the menu). */
export function lineLabel(menu: Menu | null, line: Pick<CartLine, "itemId" | "variantId" | "optionIds">): { name: string; detail: string } {
  const item = findItem(menu, line.itemId);
  if (!item) return { name: "Item", detail: "" };
  const parts: string[] = [];
  const v = item.variants.find((x) => x.variant_id === line.variantId);
  if (v) parts.push(shownName(v));
  for (const g of item.option_groups) for (const o of g.options) if (line.optionIds.includes(o.option_id)) parts.push(shownName(o));
  return { name: shownName(item), detail: parts.join(" · ") };
}

/** Before a preview exists: the menu's own unit price for the line ("each"), never a computed sum. */
export function unitPriceText(menu: Menu | null, line: CartLine): string | null {
  const item = findItem(menu, line.itemId);
  if (!item) return null;
  const v = item.variants.find((x) => x.variant_id === line.variantId);
  const p = v ? v.price_minor : item.price_minor;
  return p === null ? null : `${money(p, item.currency)} each`;
}

export function copyContext(menu: Menu | null, cart: Cart, outletName: string, nextOpenIso: string | null, tz: string): CopyContext {
  return {
    itemName: (id) => { const i = findItem(menu, id); return i ? shownName(i) : null; },
    lineName: (n) => { const l = cart.lines[n - 1]; return l ? lineLabel(menu, l).name : null; },
    dealName: (id) => { const d = menu?.deals.find((x) => x.deal_id === id); return d ? dealLabel(d.name_key) : null; },
    outletName,
    nextOpen: nextOpenIso ? formatWhen(nextOpenIso, tz, SITE.locale) : null,
    money,
  };
}

export function QtyStepper({ qty, name, onChange, disabled }: { qty: number; name: string; onChange: (q: number) => void; disabled?: boolean }) {
  return (
    <div className="inline-flex items-center gap-1" role="group" aria-label={`Quantity of ${name}`}>
      <button type="button" className="btn btn-plain btn-round" disabled={disabled} onClick={() => onChange(qty - 1)} aria-label={qty <= 1 ? `Remove ${name}` : `One fewer ${name}`}>
        {qty <= 1 ? <CloseIcon size={20} /> : <MinusIcon size={20} />}
      </button>
      <span className="num w-8 text-center font-semibold" aria-live="polite">{qty}</span>
      <button type="button" className="btn btn-plain btn-round" disabled={disabled || qty >= MAX_QTY} onClick={() => onChange(qty + 1)} aria-label={`One more ${name}`}>
        <PlusIcon size={20} />
      </button>
    </div>
  );
}
