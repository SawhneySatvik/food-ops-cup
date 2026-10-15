// file: components/staff/till.tsx
"use client";
// The till's two shared pieces: an item tile (tap to add; sold out is a word, never just grey) and a cart rail line.
// The counter screen (10) owns the cart, the preview and the payment panel; numbers on the rail come only from
// the preview response.
import { formatMoney, shownName, titleCase } from "@/lib/munim/format";
import type { Schemas } from "@/lib/munim/types";
import { SITE } from "@/lib/site";
import { QtyStepper } from "../cart-bits";

type Entry = Schemas["V1CatalogueMenu"]["entries"][number];

/** "Hazelnut Praline Cake" and "1 kg (serves 8–10)": the owner's display text, else a label for the key. */
export const entryName = (e: Entry): string => shownName(e);
export const entryVariant = (e: Entry): string | null => e.variant_display_name ?? (e.variant_name_key ? titleCase(e.variant_name_key) : null);

export function Tile({ entry, onAdd }: { entry: Entry; onAdd: (e: Entry) => void }) {
  const soldOut = !entry.available;
  return (
    <button type="button" className="tile" aria-disabled={soldOut} onClick={() => !soldOut && onAdd(entry)}
      aria-label={`${entryName(entry)}${entryVariant(entry) ? `, ${entryVariant(entry)}` : ""}${soldOut ? ", sold out" : ""}`}>
      <span>
        {entryName(entry)}
        {entryVariant(entry) && <span className="block text-[15px] font-normal text-muted">{entryVariant(entry)}</span>}
      </span>
      <span className="tile-foot">
        {/* The price row's own amount, for the person choosing: never added up here. */}
        <span className="tile-price">{formatMoney(entry.price_minor, entry.currency, SITE.locale)}</span>
        {soldOut ? <span className="soldout-pill">Sold out</span> : entry.option_groups.some((g) => g.required) ? <span className="badge">Choose</span> : null}
      </span>
    </button>
  );
}

export function CartRailLine({ name, detail, note, qty, lineTotal, onQty, disabled }: {
  name: string;
  detail: string;
  note: string | null;
  qty: number;
  /** preview.lines[i].line_total_minor formatted, or null before the preview answers ("…"). */
  lineTotal: string | null;
  onQty: (q: number) => void;
  disabled: boolean;
}) {
  return (
    <div className="cart-line">
      <div>
        <p className="font-semibold">{name}</p>
        {detail && <p className="text-[14px] text-muted">{detail}</p>}
        {note && <p className="text-[14px]">Note: “{note}”</p>}
      </div>
      <p className="num text-right font-semibold">{lineTotal ?? "…"}</p>
      <QtyStepper qty={qty} name={name} onChange={onQty} disabled={disabled} />
    </div>
  );
}
