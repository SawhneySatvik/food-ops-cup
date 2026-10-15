// Menu reads (W2 seam `itemsForSale`) for POS and storefront, and the shop barcode lookup. Every number is a
// row's own field (R26): price ← core.price.amount_minor, option delta ← core.option.price_delta_minor, MRP ←
// core.item.mrp_minor. No cart totals — carts are priced by `priceLines`.
// A sellable entry is an active item with no active variants (variant null), or each active variant of it; it is
// listed only when a price row is in force for the outlet and channel kind on the outlet's business date now (a
// variant without its own row uses the item's row). Display order (0030): items by category, then position, then name
// key; variants, option groups and options by position, then name key (position 0 everywhere = name order).
import type { DealWindow } from "@munim/contracts/catalogue";
import { ApiError } from "../../lib/errors.ts";
import type { Queryable } from "../../runtoken/index.ts";
import { loadDeals, outletClock, sellableAs } from "./pricing.ts";

export type MenuEntry = {
  item_id: string;
  variant_id: string | null;
  kind: string;
  name_key: string;
  variant_name_key: string | null;
  category: string;
  brand_id: string | null;
  /** 0029 owner-entered display text (plain text; null = show name_key). */
  display_name: string | null;
  description: string | null;
  diet: "veg" | "non_veg" | "egg" | "vegan" | null;
  variant_display_name: string | null;
  variant_description: string | null;
  barcode: string | null;
  price_id: string;
  price_minor: number;
  currency: string;
  tax_class: string;
  mrp_minor: number | null;
  available: boolean;
  option_groups: Array<{ option_group_id: string; name_key: string; min_select: number; max_select: number; required: boolean;
    display_name: string | null; description: string | null;
    options: Array<{ option_id: string; name_key: string; price_delta_minor: number; currency: string; display_name: string | null; description: string | null }> }>;
  deals: Array<{ deal_id: string; name_key: string; kind: string; windows: DealWindow[] }>;
};

type EntryRow = Omit<MenuEntry, "price_minor" | "mrp_minor" | "option_groups" | "deals"> & { price_minor: string; mrp_minor: string | null;
  item_position: number; variant_position: number | null };

export async function itemsForSale(tx: Queryable, outlet_id: string, channel_kind: string, opts: { at?: Date; item_id?: string } = {}) {
  const { business_date } = await outletClock(tx, outlet_id, opts.at ?? new Date());
  const rows = (await tx.query<EntryRow>(
    `WITH sellable AS (
       SELECT i.id AS item_id, v.id AS variant_id, i.kind, i.name_key, v.name_key AS variant_name_key, i.category, i.brand_id,
              i.display_name, i.description, i.diet, v.display_name AS variant_display_name, v.description AS variant_description,
              CASE WHEN v.id IS NULL THEN i.barcode ELSE v.barcode END AS barcode, i.mrp_minor, i.position AS item_position, v.position AS variant_position
         FROM core.item i
         LEFT JOIN core.variant v ON v.tenant_id = i.tenant_id AND v.item_id = i.id AND v.active
        WHERE i.active AND ($4::uuid IS NULL OR i.id = $4) AND ${sellableAs("i", "v.id")})
     SELECT s.*, p.id AS price_id, p.amount_minor AS price_minor, p.currency, p.tax_class,
            NOT EXISTS (SELECT 1 FROM core.item_availability a WHERE a.outlet_id = $1 AND a.item_id = s.item_id
                          AND (a.variant_id IS NULL OR a.variant_id = s.variant_id) AND NOT a.available) AS available
       FROM sellable s
       JOIN LATERAL (SELECT id, amount_minor, currency, tax_class FROM core.price p
                      WHERE p.item_id = s.item_id AND p.outlet_id = $1 AND p.channel_kind = $2
                        AND (p.variant_id = s.variant_id OR p.variant_id IS NULL)
                        AND p.valid_from <= $3::date AND (p.valid_to IS NULL OR $3::date < p.valid_to)
                      ORDER BY p.variant_id NULLS LAST LIMIT 1) p ON true
      ORDER BY s.category, s.item_position, s.name_key, s.variant_position NULLS FIRST, s.variant_name_key NULLS FIRST`,
    [outlet_id, channel_kind, business_date, opts.item_id ?? null])).rows;

  const itemIds = [...new Set(rows.map((r) => r.item_id))];
  const optionRows = (await tx.query<{ item_id: string; option_group_id: string; group_name_key: string; min_select: number; max_select: number; required: boolean;
    group_display_name: string | null; group_description: string | null;
    option_id: string; name_key: string; price_delta_minor: string; currency: string; display_name: string | null; description: string | null }>(
    `SELECT g.item_id, g.id AS option_group_id, g.name_key AS group_name_key, g.min_select, g.max_select, g.required,
            g.display_name AS group_display_name, g.description AS group_description,
            o.id AS option_id, o.name_key, o.price_delta_minor, o.currency, o.display_name, o.description
       FROM core.option_group g JOIN core.option o ON o.tenant_id = g.tenant_id AND o.option_group_id = g.id AND o.active
      WHERE g.item_id = ANY($1::uuid[]) ORDER BY g.position, g.name_key, g.id, o.position, o.name_key, o.id`, [itemIds])).rows;
  const deals = (await loadDeals(tx)).filter((d) =>
    d.valid_from <= business_date && (d.valid_to === null || business_date < d.valid_to) && (d.outlet_ids.length === 0 || d.outlet_ids.includes(outlet_id)));

  const entries: MenuEntry[] = rows.map(({ item_position: _ip, variant_position: _vp, ...r }) => {
    const groups = new Map<string, MenuEntry["option_groups"][number]>();
    for (const o of optionRows.filter((x) => x.item_id === r.item_id)) {
      const g = groups.get(o.option_group_id) ?? { option_group_id: o.option_group_id, name_key: o.group_name_key, min_select: o.min_select, max_select: o.max_select, required: o.required,
        display_name: o.group_display_name, description: o.group_description, options: [] };
      g.options.push({ option_id: o.option_id, name_key: o.name_key, price_delta_minor: Number(o.price_delta_minor), currency: o.currency, display_name: o.display_name, description: o.description });
      groups.set(o.option_group_id, g);
    }
    return {
      ...r,
      price_minor: Number(r.price_minor),
      mrp_minor: r.mrp_minor === null ? null : Number(r.mrp_minor),
      option_groups: [...groups.values()],
      deals: deals.filter((d) => d.rule.item_ids.length === 0 || d.rule.item_ids.includes(r.item_id))
        .map((d) => ({ deal_id: d.id, name_key: d.name_key, kind: d.kind, windows: d.windows })),
    };
  });
  return { outlet_id, channel_kind, business_date, entries };
}

/** The item or variant carrying `barcode` (a variant's code wins), with its menu entry when it is on sale here. */
export async function lookupBarcode(tx: Queryable, barcode: string, outlet_id: string, channel_kind: string) {
  const hit = (await tx.query<{ item_id: string; variant_id: string | null }>(
    `SELECT item_id, variant_id FROM (SELECT item_id, id AS variant_id, 0 AS pref FROM core.variant WHERE barcode = $1
       UNION ALL SELECT id, NULL, 1 FROM core.item WHERE barcode = $1) x ORDER BY pref LIMIT 1`, [barcode])).rows[0];
  if (!hit) throw new ApiError("not_found");
  const menu = await itemsForSale(tx, outlet_id, channel_kind, { item_id: hit.item_id });
  const entry = menu.entries.find((e) => e.variant_id === hit.variant_id) ?? null;
  return { barcode, item_id: hit.item_id, variant_id: hit.variant_id, on_sale: entry !== null, entry };
}
