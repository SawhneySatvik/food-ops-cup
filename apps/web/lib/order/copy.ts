// A refusal -> its literal copy (screens/storefront.md O2/O3, kit 10 §3). Amounts are the server's `params` formatted
// for display; nothing is computed here. Unknown codes fall back to the generic not-placed line, never raw server text.
import { STOREFRONT_REFUSAL_COPY } from "@munim/contracts/storefront";
import type { Formatter } from "@munim/ui";
import { t } from "../i18n/index.ts";
import type { Refusal, RefusalParams } from "./api.ts";

export type CopyContext = {
  fmt: Formatter;
  outletName: string;
  nextOpen: string | null;
  /** item_id (or the 1-based cart line) -> shown name, from the menu. */
  itemName: (itemId: string | undefined, lineNo: number | null | undefined) => string | null;
  /** deal_id -> shown name, from the menu's deals; null when it matches none (then "promotional", gap G-11). */
  dealName: (dealId: string | undefined) => string | null;
  /** The time the shopper picked, formatted, for deal_rejudged. */
  pickedTime: string | null;
};

const money = (fmt: Formatter, minor: number | undefined, currency: string | undefined) =>
  minor === undefined ? "" : fmt.money(minor, currency);

/** Codes core can send that the contracts' map does not carry (command / W2 codes the shopper can hit, and 429). */
const EXTRA = {
  item_unavailable: "order.refuse.item_unavailable",
  deal_changed: "order.refuse.deal_changed",
  preview_total_changed: "order.refuse.preview_total_changed",
  rate_limited: "order.refuse.rate_limited",
} as const;
const COPY: Readonly<Record<string, string>> = { ...STOREFRONT_REFUSAL_COPY, ...EXTRA };

/** The copy key comes from the contracts' STOREFRONT_REFUSAL_COPY, so a renamed or added code cannot drift from this file. */
export function refusalText(reason: string | null, code: string | null, p: RefusalParams, lineNo: number | null | undefined, c: CopyContext): string {
  const base = reason ? COPY[reason] : undefined;
  if (!base) return code === "unavailable" || code === "internal" ? t("order.checkout.trouble") : t("order.checkout.err");
  // Two copies carry a clause that needs a parameter core does not always have: without it the clause is dropped.
  const item = reason === "item_sold_out" ? c.itemName(p.item_id, lineNo) : null;
  const key = (reason === "outlet_paused" && !c.nextOpen) || (reason === "item_sold_out" && !item) ? `${base}_unknown` : base;
  return t(key, {
    outlet: c.outletName, next_open: c.nextOpen ?? "", item: item ?? "",
    deal: c.dealName(p.deal_id) ?? t("order.menu.deal_unnamed"), time: c.pickedTime ?? "",
    old: money(c.fmt, p.old_total_minor, p.currency), new: money(c.fmt, p.new_total_minor, p.currency),
    money: money(c.fmt, p.shortfall_minor, p.currency),
  });
}

export const refusalOf = (r: Refusal, c: CopyContext) => refusalText(r.reason, r.code, r.params, null, c);
