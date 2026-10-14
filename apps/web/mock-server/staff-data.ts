// file: mock-server/staff-data.ts
// The staff side of the synthetic bakery: members, outlets as the member API shows them, the counter menu, a business
// day of orders and kitchen tickets, the AI inbox (findings and drafts), the snapshots behind every number, two Ask
// threads, Cares and simulated suppliers. All invented. Every object here has the exact shape of a Munim response and
// is checked against the contract (03 §7). Times are built from `now`, so the board always has fresh tickets.
import { createHash } from "node:crypto";
import type { Schemas } from "@/lib/munim/types";
import { DEMO_PEOPLE, DEMO_TENANT_ID } from "@/lib/munim/session";
import { CHANNEL_ID, CURRENCY, DEALS, ITEMS, OUTLETS, PREP_MIN, TAX_CLASS, TZ, TZ_OFFSET_MIN, groupId, id7, itemId, optionId, variantId } from "./data";
import { price } from "./pricing";

type S = Schemas;
export type Order = S["V1Order"];
export type Snapshot = S["Snapshot"];
export type Draft = S["V1Draft"];
export type Finding = S["V1Finding"];

export const HAZRATGANJ = OUTLETS[0]!.outlet_id;
export const GOMTI_NAGAR = OUTLETS[1]!.outlet_id;

// ---------------------------------------------------------------- who
export const MEMBERS = DEMO_PEOPLE.map((p) => ({
  token: p.token,
  me: {
    member_id: id7(`member:${p.key}`),
    tenant_id: DEMO_TENANT_ID,
    name: p.name,
    role: p.role,
    outlet_ids: p.role === "owner" ? ("*" as const) : [HAZRATGANJ],
  } satisfies S["V1Me"],
}));
export const OWNER_ID = MEMBERS[0]!.me.member_id;

export const TENANT: S["V1Tenant"] = {
  tenant_id: DEMO_TENANT_ID, name: "Cobnut Bakehouse (synthetic)", country_code: "IN", base_currency: CURRENCY, fy_start_month: 4,
  status: "active", is_demo: true, onboarded_at: "2026-09-01T04:30:00Z", home_tz: TZ,
};

export const MEMBER_OUTLETS: S["V1Outlets"] = {
  outlets: OUTLETS.map((o) => ({
    id: o.outlet_id, name: o.name, kind: "restaurant" as const, tz: TZ, address: o.address,
    tax_ids: Object.fromEntries(o.tax_ids.map((t) => [t.code, t.value])),
    accepting_orders: o.state, busy_extra_min: o.busy_extra_min, default_prep_min: PREP_MIN, cancel_window_min: 1, reschedule_window_min: 1,
    pickup_slot_min: 15, pickup_lead_min: 0, upi_vpa: null, business_day_cutoff: "04:00:00", phone: o.phone,
  })),
};

export const COUNTER_CHANNEL_ID = id7("channel:counter");
export const CHANNELS: S["V1Channels"] = {
  channels: [
    { id: COUNTER_CHANNEL_ID, name: "Counter", kind: "counter", active: true },
    { id: CHANNEL_ID, name: "Website (pickup)", kind: "own_site", active: true },
  ],
};
export const posDevice = (outletId: string) => id7(`device:pos:${outletId}`);
export const DEVICES: S["V1Devices"] = {
  devices: OUTLETS.flatMap((o, i) => [
    { id: posDevice(o.outlet_id), outlet_id: o.outlet_id, kind: "pos" as const, invoice_series: i === 0 ? "HZG" : "GMT", last_seen_at: null },
    { id: id7(`device:kds:${o.outlet_id}`), outlet_id: o.outlet_id, kind: "kds" as const, invoice_series: null, last_seen_at: null },
  ]),
};

// ---------------------------------------------------------------- the day
/** The outlet's calendar date at `at` (India has no daylight saving: a fixed offset is exact). */
export const businessDate = (at: Date) => new Date(at.getTime() + TZ_OFFSET_MIN * 60_000).toISOString().slice(0, 10);
const addDays = (isoDate: string, n: number) => new Date(Date.parse(`${isoDate}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const mins = (now: Date, m: number) => new Date(now.getTime() + m * 60_000).toISOString();

/** Kitchen station of an item: drinks at the bar, everything else in the kitchen. */
export const stationOf = (slug: string) => (ITEMS.find((i) => i.slug === slug)?.category === "drinks" ? "bar" : "kitchen");

// ---------------------------------------------------------------- the counter menu
export function menuFor(outletId: string, channelKind: string, now: Date): S["V1CatalogueMenu"] {
  const outlet = OUTLETS.find((o) => o.outlet_id === outletId)!;
  const entries: S["V1CatalogueMenu"]["entries"] = [];
  for (const i of ITEMS) {
    const variants = i.variants.length > 0 ? i.variants : [null];
    for (const v of variants) {
      entries.push({
        item_id: itemId(i.slug), variant_id: v ? variantId(i.slug, v.slug) : null, kind: i.kind, name_key: `item.${i.slug}`,
        variant_name_key: v ? `variant.${v.slug}` : null, category: i.category, brand_id: null, display_name: i.name, description: i.description,
        diet: i.diet, variant_display_name: v ? v.name : null, variant_description: null, barcode: null,
        price_id: id7(`price:${i.slug}:${v?.slug ?? "-"}:${outletId}:${channelKind}`), price_minor: (v ? v.price : i.price)!, currency: CURRENCY,
        tax_class: TAX_CLASS, mrp_minor: null, available: !(i.soldOut || outlet.soldOut.includes(i.slug)),
        option_groups: i.groups.map((g) => ({
          option_group_id: groupId(i.slug, g.slug), name_key: `group.${g.slug}`, min_select: g.min, max_select: g.max, required: g.min > 0,
          display_name: g.name, description: g.description,
          options: g.options.map((o) => ({ option_id: optionId(i.slug, g.slug, o.slug), name_key: `option.${o.slug}`, price_delta_minor: o.delta, currency: CURRENCY, display_name: o.name, description: null })),
        })),
        deals: DEALS.filter((d) => d.items.includes(i.slug)).map((d) => ({ deal_id: d.deal_id, name_key: d.name_key, kind: d.kind, windows: d.windows })),
      });
    }
  }
  return { outlet_id: outletId, channel_kind: channelKind, business_date: businessDate(now), entries };
}

export const INGREDIENTS: S["V1InventoryIngredients"] = {
  items: [
    { ingredient_id: id7("ing:butter"), name: "Butter (synthetic)", base_unit: "g", shelf_life_days: 20, tracked_by_batch: true, active: true },
    { ingredient_id: id7("ing:hazelnuts"), name: "Roasted hazelnuts (synthetic)", base_unit: "g", shelf_life_days: 90, tracked_by_batch: true, active: true },
    { ingredient_id: id7("ing:flour"), name: "Bread flour (synthetic)", base_unit: "g", shelf_life_days: 180, tracked_by_batch: false, active: true },
    { ingredient_id: id7("ing:cream"), name: "Fresh cream (synthetic)", base_unit: "ml", shelf_life_days: 5, tracked_by_batch: true, active: true },
    { ingredient_id: id7("ing:sourdough"), name: "Sliced sourdough loaf (synthetic)", base_unit: "piece", shelf_life_days: 3, tracked_by_batch: true, active: true },
  ],
  next_cursor: null,
};
export const ING = (slug: string) => id7(`ing:${slug}`);

// ---------------------------------------------------------------- orders and tickets
export interface LineInput {
  slug: string;
  variant?: string;
  options?: [group: string, option: string][];
  qty?: number;
  note?: string | null;
}
export interface OrderInput {
  outletId: string;
  ticketNo: number;
  channelId?: string;
  kind?: "takeaway" | "dine_in" | "pickup";
  status: Order["status"];
  createdMin: number; // minutes from now (negative = earlier today)
  promisedMin?: number | null;
  paid?: "card" | "cash" | "upi" | null;
  lines: LineInput[];
}
export interface TicketRow {
  ticket_id: string;
  order_id: string;
  outlet_id: string;
  station: string;
  status: "queued" | "preparing" | "ready" | "done";
  created_at: string;
  accepted_at: string | null;
  ready_at: string | null;
  due_at: string | null;
  line_nos: number[];
}
export interface Placed {
  order: Order;
  /** line_id -> note (the order read model has no notes; the kitchen ticket does). */
  notes: Record<string, string | null>;
  tickets: TicketRow[];
}

const TICKET_OF: Record<Order["status"], TicketRow["status"]> = { placed: "queued", accepted: "queued", preparing: "preparing", ready: "ready", completed: "done", rejected: "done", cancelled: "done" };

/** A line as the API takes it (orders.place.v1 lines[]). */
export interface ApiLine {
  line_id: string;
  item_id: string;
  variant_id: string | null;
  option_ids: string[];
  qty_milli: number;
  note: string | null;
}
export interface OrderSpec {
  orderId: string;
  outletId: string;
  ticketNo: number;
  channelId: string;
  deviceId: string | null;
  invoiceNo: number | null;
  kind: Order["kind"];
  tableRef: string | null;
  status: Order["status"];
  createdAt: string;
  promisedAt: string | null;
  lines: ApiLine[];
}

/** Kitchen station of an item id. */
const stationOfId = (itemIdValue: string) => stationOf(ITEMS.find((i) => itemId(i.slug) === itemIdValue)?.slug ?? "");

/** Prices the lines with the mock's pricing (the only place money is added up) and builds the order, its notes and
 *  one kitchen ticket per station. Used for the seeded day, the till's orders and "Simulate a web order". Throws
 *  BadRequest (pricing.ts) for a variant or option the item does not have. */
export function buildOrder(spec: OrderSpec, now: Date): { placed: Placed; refusal: string | null; totalMinor: number } {
  const outlet = OUTLETS.find((o) => o.outlet_id === spec.outletId)!;
  const req = spec.lines.map((l) => ({ item_id: l.item_id, variant_id: l.variant_id, option_ids: l.option_ids, qty_milli: l.qty_milli, barcode: null }));
  const { preview } = price({ outlet_id: spec.outletId, channel_id: CHANNEL_ID, brand_id: null, kind: "pickup", pickup_window_id: null, promised_at: null, coupon_codes: [], loyalty_redeem_points: 0, lines: req }, outlet, "open", now);
  const lines = preview.lines.map((l, i) => ({
    line_id: spec.lines[i]!.line_id, line_no: l.line_no, item_id: l.item_id, variant_id: l.variant_id, option_ids: spec.lines[i]!.option_ids, qty_milli: l.qty_milli,
    unit_price_minor: l.unit_price_minor + l.options_minor, line_discount_minor: l.line_discount_minor, tax_minor: l.tax_minor,
  }));
  const order: Order = {
    order_id: spec.orderId, outlet_id: spec.outletId, channel_id: spec.channelId, device_id: spec.deviceId,
    kind: spec.kind, table_ref: spec.tableRef, status: spec.status, business_date: businessDate(new Date(spec.createdAt)), ticket_no: spec.ticketNo,
    invoice_fy: spec.invoiceNo ? 2026 : null, invoice_no: spec.invoiceNo, promised_at: spec.promisedAt, pickup_window_id: null,
    subtotal_minor: preview.subtotal_minor, discount_minor: preview.discount_minor, tax_minor: preview.tax_minor, total_minor: preview.total_minor,
    loyalty_minor: 0, paid_minor: 0, remaining_minor: preview.total_minor, currency: CURRENCY, lines, tenders: [], created_at: spec.createdAt,
  };
  const notes = Object.fromEntries(spec.lines.map((l) => [l.line_id, l.note]));
  const status = TICKET_OF[spec.status];
  const created = Date.parse(spec.createdAt);
  const due = spec.promisedAt ?? new Date(created + PREP_MIN * 60_000).toISOString();
  const tickets = [...new Set(spec.lines.map((l) => stationOfId(l.item_id)))].map((station) => ({
    ticket_id: id7(`ticket:${spec.orderId}:${station}`), order_id: spec.orderId, outlet_id: spec.outletId, station, status, created_at: spec.createdAt,
    accepted_at: status === "queued" ? null : new Date(created + 120_000).toISOString(), ready_at: status === "ready" || status === "done" ? new Date(created + 720_000).toISOString() : null,
    due_at: due, line_nos: lines.filter((_, i) => stationOfId(spec.lines[i]!.item_id) === station).map((l) => l.line_no),
  }));
  return { placed: { order, notes, tickets }, refusal: preview.refusals[0]?.reason_code ?? null, totalMinor: preview.total_minor };
}

/** A seed line by slugs: the API line it stands for. */
export function apiLine(l: LineInput, lineId: string): ApiLine {
  return {
    line_id: lineId, item_id: itemId(l.slug), variant_id: l.variant ? variantId(l.slug, l.variant) : null,
    option_ids: (l.options ?? []).map(([g, o]) => optionId(l.slug, g, o)), qty_milli: (l.qty ?? 1) * 1000, note: l.note ?? null,
  };
}

/** Today at both outlets: three picked-up orders, one ready, two being made (one of them late), two new (one due
 *  in two minutes), a cake for tonight with a piped message, and a scheduled pickup for later. */
export const SEED_ORDERS: OrderInput[] = [
  { outletId: HAZRATGANJ, ticketNo: 1, status: "completed", createdMin: -190, paid: "card", lines: [{ slug: "hazelnut_croissant", qty: 2 }, { slug: "hazelnut_hot_chocolate", variant: "regular" }] },
  { outletId: HAZRATGANJ, ticketNo: 2, status: "completed", createdMin: -150, paid: "cash", lines: [{ slug: "pain_au_chocolat" }, { slug: "cold_coffee", options: [["milk", "oat"]] }] },
  { outletId: HAZRATGANJ, ticketNo: 3, status: "ready", createdMin: -25, paid: "upi", lines: [{ slug: "brown_butter_cookie", qty: 3 }] },
  { outletId: HAZRATGANJ, ticketNo: 4, status: "preparing", createdMin: -24, promisedMin: -4, lines: [{ slug: "gianduja_mousse", qty: 2 }] },
  {
    outletId: HAZRATGANJ, ticketNo: 5, kind: "pickup", status: "preparing", createdMin: -40, promisedMin: 35,
    lines: [{ slug: "praline_celebration_cake", variant: "one_kg", options: [["sponge", "eggless"]], note: "Happy 60th, Nani! — with love, Zoya" }],
  },
  { outletId: HAZRATGANJ, ticketNo: 6, status: "placed", createdMin: -10, promisedMin: 2, lines: [{ slug: "cardamom_knot", qty: 2 }, { slug: "cold_coffee", options: [["milk", "dairy"]] }] },
  { outletId: HAZRATGANJ, ticketNo: 7, kind: "pickup", status: "placed", createdMin: -5, promisedMin: 180, lines: [{ slug: "truffle_tin" }] },
  { outletId: GOMTI_NAGAR, ticketNo: 1, status: "completed", createdMin: -120, paid: "card", lines: [{ slug: "oat_jaggery_cookie", qty: 4 }] },
  {
    outletId: GOMTI_NAGAR, ticketNo: 2, kind: "pickup", status: "preparing", createdMin: -15, promisedMin: 20,
    lines: [{ slug: "build_a_box", variant: "box_9", options: [["flavours", "hazelnut_praline"], ["flavours", "salted_caramel"], ["flavours", "kesar_badam"], ["gift_wrap", "ribbon_card"]], note: "For Mr Rastogi — thank you for everything" }],
  },
  { outletId: GOMTI_NAGAR, ticketNo: 3, status: "placed", createdMin: -3, promisedMin: 12, lines: [{ slug: "hazelnut_hot_chocolate", variant: "large", qty: 2 }] },
];

export function seedOrders(now: Date): Placed[] {
  return SEED_ORDERS.map((o, n) => {
    const orderId = id7(`order:seed:${n}`);
    const { placed } = buildOrder({
      orderId, outletId: o.outletId, ticketNo: o.ticketNo, channelId: o.channelId ?? COUNTER_CHANNEL_ID, deviceId: posDevice(o.outletId), invoiceNo: 40 + n,
      kind: o.kind ?? "takeaway", tableRef: null, status: o.status, createdAt: mins(now, o.createdMin),
      promisedAt: o.promisedMin === undefined || o.promisedMin === null ? null : mins(now, o.promisedMin), lines: o.lines.map((l, i) => apiLine(l, id7(`line:seed:${n}:${i}`))),
    }, now);
    if (o.paid) {
      const order = placed.order;
      const t = o.paid === "cash"
        ? { method: "cash" as const, amount_minor: order.total_minor, tendered_minor: order.total_minor, change_minor: 0, rounding_minor: 0, ref: null }
        : { method: o.paid, amount_minor: order.total_minor, tendered_minor: null, change_minor: null, rounding_minor: null, ref: "SLIP-SYN" };
      order.tenders.push({ tender_id: id7(`tender:${orderId}`), order_id: orderId, currency: CURRENCY, recorded_by: MEMBERS[1]!.me.member_id, at: mins(now, o.createdMin + 1), ...t });
      order.paid_minor = order.total_minor;
      order.remaining_minor = 0;
    }
    return placed;
  });
}

/** The list row of an order (GET /v1/orders items). */
export const orderListItem = (o: Order): S["V1OrdersList"]["items"][number] => ({
  order_id: o.order_id, outlet_id: o.outlet_id, channel_id: o.channel_id, device_id: o.device_id, kind: o.kind, table_ref: o.table_ref, status: o.status,
  business_date: o.business_date, ticket_no: o.ticket_no, subtotal_minor: o.subtotal_minor, discount_minor: o.discount_minor, tax_minor: o.tax_minor,
  total_minor: o.total_minor, currency: o.currency, promised_at: o.promised_at, created_at: o.created_at,
});

/** The board as core builds it: live tickets (not done; order not completed, rejected or cancelled), amber from
 *  due − 3 min, red at or after due (queued and preparing only), lane "later" while promised − prep is ahead. */
export function boardOf(outletId: string, station: string | null, orders: Map<string, Placed>, now: Date): S["V1KdsBoard"] {
  const tickets: S["V1KdsBoard"]["tickets"] = [];
  const stations = new Set<string>(["kitchen", "bar"]);
  for (const p of orders.values()) {
    if (p.order.outlet_id !== outletId || ["completed", "rejected", "cancelled"].includes(p.order.status)) continue;
    for (const t of p.tickets) {
      if (t.status === "done" || (station && t.station !== station)) continue;
      const due = t.due_at ? Date.parse(t.due_at) : null;
      const coloured = t.status === "queued" || t.status === "preparing";
      const colour = !coloured || due === null ? "normal" : now.getTime() >= due ? "red" : now.getTime() >= due - 180_000 ? "amber" : "normal";
      const surface = p.order.promised_at ? new Date(Date.parse(p.order.promised_at) - PREP_MIN * 60_000) : null;
      tickets.push({
        ticket_id: t.ticket_id, order_id: t.order_id, ticket_no: p.order.ticket_no, business_date: p.order.business_date, station: t.station,
        status: t.status, kind: p.order.kind, table_ref: p.order.table_ref, channel_kind: p.order.channel_id === COUNTER_CHANNEL_ID ? "counter" : "own_site",
        started_at: t.accepted_at ?? t.created_at, accepted_at: t.accepted_at, ready_at: t.ready_at, due_at: t.due_at, promised_at: p.order.promised_at,
        lane: surface && surface.getTime() > now.getTime() ? "later" : "now", surface_at: surface ? surface.toISOString() : null, colour,
        lines: p.order.lines.filter((l) => t.line_nos.includes(l.line_no)).map((l) => {
          const item = ITEMS.find((i) => itemId(i.slug) === l.item_id)!;
          const options = item.groups.flatMap((g) => g.options.filter((o) => l.option_ids.includes(optionId(item.slug, g.slug, o.slug))).map((o) => ({ option_id: optionId(item.slug, g.slug, o.slug), name_key: `option.${o.slug}` })));
          return { line_no: l.line_no, item_id: l.item_id, name_key: `item.${item.slug}`, qty_milli: l.qty_milli, options, note: p.notes[l.line_id] ?? null };
        }),
      });
    }
  }
  const rank = { red: 0, amber: 1, normal: 2 } as const;
  tickets.sort((a, b) => rank[a.colour] - rank[b.colour] || (a.due_at ?? "").localeCompare(b.due_at ?? "") || a.ticket_no - b.ticket_no);
  return { outlet_id: outletId, as_of: now.toISOString(), stations: [...stations], tickets };
}

// ---------------------------------------------------------------- snapshots (the only source of AI numbers)
export const RUN = { waste: id7("run:waste"), kitchen: id7("run:kitchen"), negotiation: id7("run:negotiation"), ask: id7("run:ask"), cares: id7("run:cares") };
const sha = (rows: unknown) => createHash("sha256").update(JSON.stringify(rows)).digest("hex");
const col = (name: string, type: "integer" | "text" | "uuid" | "date" | "boolean" | "timestamptz" = "integer") => ({ name, type });

export function snapshotOf(id: string, template_id: string, params: Snapshot["params"], columns: ReturnType<typeof col>[], rows: Snapshot["rows"], who: { run?: string; member?: string }, scope: Snapshot["outlet_scope"], at: string): Snapshot {
  return {
    snapshot_id: id, template_id, params, run_id: who.run ?? null, minted_by_member_id: who.member ?? null, minted_by_operator_id: null,
    outlet_scope: scope, columns, rows, row_count: rows.length, sha256: sha(rows), created_at: at,
  };
}

/** Columns of the real templates the mock serves (same names and order as core's). */
export const TEMPLATE_COLUMNS: Record<string, ReturnType<typeof col>[]> = {
  "inventory.waste_week": [col("ingredient_id", "uuid"), col("waste_minor"), col("median_minor"), col("excess_minor")],
  "kitchen.ticket_times": [col("station", "text"), col("item_id", "uuid"), col("slot_start", "text"), col("tickets"), col("p50_sec"), col("p80_sec"), col("late_tickets"), col("configured_prep_sec")],
  "kitchen.prep_need": [col("ingredient_id", "uuid"), col("forecast_qty_milli"), col("on_hand_qty_milli"), col("par_qty_milli"), col("prep_qty_milli")],
  "kitchen.ticket_coverage": [col("tickets"), col("timed_tickets"), col("coverage_bp")],
  "people.labour_pct": [col("iso_week", "text"), col("labour_minor"), col("net_sales_minor"), col("labour_bp"), col("target_bp"), col("excess_labour_minor")],
  "cares.impact": [col("kind", "text"), col("handovers"), col("portions_milli"), col("weight_g"), col("volume_ml"), col("units_milli"), col("value_at_cost_minor")],
  "inventory.below_reorder": [col("outlet_id", "uuid"), col("ingredient_id", "uuid"), col("ingredient_name", "text"), col("on_hand_milli"), col("min_qty_milli"), col("par_qty_milli")],
  "purchasing.quote_compare": [col("quote_id", "uuid"), col("supplier_id", "uuid"), col("round"), col("unit_price_minor"), col("qty_milli"), col("min_order_qty_milli"), col("payment_days")],
  // 14 §10 additions (Cares): batches close to their use-by date, and simulated recipients ranked for some food.
  "inventory.expiry_risk": [col("outlet_id", "uuid"), col("batch_id", "uuid"), col("ingredient_id", "uuid"), col("ingredient_name", "text"), col("unit", "text"), col("expiry_on", "date"), col("is_sku", "boolean"), col("on_hand_qty_milli"), col("at_risk_qty_milli"), col("at_risk_minor")],
  "cares.recipient_match": [col("recipient_id", "uuid"), col("name", "text"), col("kind", "text"), col("simulated", "boolean"), col("distance_m"), col("overlap_min"), col("pickup_on", "date"), col("pickup_from", "timestamptz"), col("pickup_to", "timestamptz"), col("capacity_fit", "boolean")],
};
/** Who may mint each template (core's min_role: staff < manager < advisor < owner/judge). */
export const TEMPLATE_MIN_ROLE: Record<string, "staff" | "manager" | "advisor" | "owner"> = Object.fromEntries(Object.keys(TEMPLATE_COLUMNS).map((t) => [t, "manager"]));

export const SUPPLIER = { dairy: id7("supplier:dairy"), nuts: id7("supplier:nuts") };
export const QUOTE = { nutsR1: id7("quote:nuts:1"), nutsR2: id7("quote:nuts:2"), dairyR1: id7("quote:dairy:1") };

/** The run-minted snapshots behind the seeded findings, drafts and Ask answer. */
export function seedSnapshots(now: Date): Snapshot[] {
  const today = businessDate(now);
  const weekStart = addDays(today, -6);
  const at = mins(now, -60);
  const H = [HAZRATGANJ];
  return [
    snapshotOf(id7("snap:waste"), "inventory.waste_week", { outlet_id: HAZRATGANJ, week_start: weekStart }, TEMPLATE_COLUMNS["inventory.waste_week"]!, [
      { ingredient_id: ING("butter"), waste_minor: 486000, median_minor: 152000, excess_minor: 334000 },
      { ingredient_id: ING("cream"), waste_minor: 61000, median_minor: 58000, excess_minor: 3000 },
    ], { run: RUN.waste }, H, at),
    snapshotOf(id7("snap:times"), "kitchen.ticket_times", { outlet_id: HAZRATGANJ, from: weekStart, to: today }, TEMPLATE_COLUMNS["kitchen.ticket_times"]!, [
      { station: "kitchen", item_id: itemId("praline_celebration_cake"), slot_start: "16:00", tickets: 14, p50_sec: 1680, p80_sec: 2460, late_tickets: 5, configured_prep_sec: 1800 },
      { station: "kitchen", item_id: itemId("hazelnut_croissant"), slot_start: "08:00", tickets: 96, p50_sec: 240, p80_sec: 330, late_tickets: 2, configured_prep_sec: 300 },
    ], { run: RUN.kitchen }, H, at),
    snapshotOf(id7("snap:prep"), "kitchen.prep_need", { outlet_id: HAZRATGANJ, business_date: addDays(today, 1) }, TEMPLATE_COLUMNS["kitchen.prep_need"]!, [
      { ingredient_id: ING("butter"), forecast_qty_milli: 7_400_000, on_hand_qty_milli: 2_100_000, par_qty_milli: 6_000_000, prep_qty_milli: 5_300_000 },
      { ingredient_id: ING("hazelnuts"), forecast_qty_milli: 3_900_000, on_hand_qty_milli: 3_200_000, par_qty_milli: 4_000_000, prep_qty_milli: 700_000 },
    ], { run: RUN.kitchen }, H, at),
    snapshotOf(id7("snap:quotes"), "purchasing.quote_compare", { negotiation_run_id: RUN.negotiation }, TEMPLATE_COLUMNS["purchasing.quote_compare"]!, [
      { quote_id: QUOTE.nutsR1, supplier_id: SUPPLIER.nuts, round: 1, unit_price_minor: 152000, qty_milli: 9000, min_order_qty_milli: 5000, payment_days: 7 },
      { quote_id: QUOTE.nutsR2, supplier_id: SUPPLIER.nuts, round: 2, unit_price_minor: 141000, qty_milli: 9000, min_order_qty_milli: 5000, payment_days: 15 },
      { quote_id: QUOTE.dairyR1, supplier_id: SUPPLIER.dairy, round: 1, unit_price_minor: 158000, qty_milli: 9000, min_order_qty_milli: 10000, payment_days: 0 },
    ], { run: RUN.negotiation }, ["*"], at),
    snapshotOf(id7("snap:below"), "inventory.below_reorder", {}, TEMPLATE_COLUMNS["inventory.below_reorder"]!, [
      { outlet_id: HAZRATGANJ, ingredient_id: ING("hazelnuts"), ingredient_name: "Roasted hazelnuts (synthetic)", on_hand_milli: 3_200_000, min_qty_milli: 5_000_000, par_qty_milli: 12_000_000 },
    ], { run: RUN.negotiation }, ["*"], at),
    ...caresSnapshots(now),
  ];
}

// ---------------------------------------------------------------- Cares snapshots (14 §10 additions)
export const BATCH = { sourdough: id7("batch:sourdough:hzg"), cream: id7("batch:cream:hzg") };

/** Hazratganj's batches that may pass their use-by date before they are used (the expiry watcher's horizon). */
export function expiryRows(outletId: string | null, now: Date): Snapshot["rows"] {
  if (outletId !== null && outletId !== HAZRATGANJ) return [];
  const today = businessDate(now);
  return [
    { outlet_id: HAZRATGANJ, batch_id: BATCH.sourdough, ingredient_id: ING("sourdough"), ingredient_name: "Sliced sourdough loaf (synthetic)", unit: "piece", expiry_on: addDays(today, 1), is_sku: true, on_hand_qty_milli: 20_000, at_risk_qty_milli: 12_000, at_risk_minor: 66_000 },
    { outlet_id: HAZRATGANJ, batch_id: BATCH.cream, ingredient_id: ING("cream"), ingredient_name: "Fresh cream (synthetic)", unit: "ml", expiry_on: addDays(today, 2), is_sku: false, on_hand_qty_milli: 4_000_000, at_risk_qty_milli: 1_500_000, at_risk_minor: 31_500 },
  ];
}

/** Minutes since local midnight of an "HH:MM" string. */
const hm = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** cares.recipient_match as the template ranks it: simulated recipients in the outlet's city that accept the food
 *  kind, each with the outlet's next pickup window (today's, or tomorrow's once today's has started), ranked by how
 *  long their receiving hours overlap the pickup hours, then by distance. The row order is the rank. */
export function matchRowsFor(params: Snapshot["params"], now: Date): Snapshot["rows"] {
  const outlet = CARES_PROFILE.outlets.find((o) => o.outlet_id === params.outlet_id);
  if (!outlet) return [];
  const local = (date: string, t: string) => new Date(Date.parse(`${date}T${t}:00Z`) - TZ_OFFSET_MIN * 60_000).toISOString();
  const today = businessDate(now);
  const day = Date.parse(local(today, outlet.pickup_from)) > now.getTime() ? today : addDays(today, 1);
  const from = hm(outlet.pickup_from), to = hm(outlet.pickup_to);
  const qty = typeof params.qty_milli === "number" ? params.qty_milli : 0;
  const rows = RECIPIENTS.items
    .filter((r) => r.simulated && ((params.needs_cooked === true && r.accepts_cooked) || (params.needs_raw === true && r.accepts_raw) || (params.needs_packaged === true && r.accepts_packaged)))
    .map((r) => {
      const overlap = Math.max(0, Math.min(to, hm(r.receiving_to)) - Math.max(from, hm(r.receiving_from)));
      // Rough planar distance in metres from the e6 coordinates (about 0.111 m per micro-degree): enough for a mock.
      const distance = Math.round(Math.hypot(r.lat_e6 - outlet.lat_e6, r.lng_e6 - outlet.lng_e6) * 0.111);
      const fits = params.unit === "portion" ? qty / 1000 <= r.capacity_portions_per_day : true;
      return { recipient_id: r.recipient_id, name: r.name, kind: r.kind, simulated: true, distance_m: distance, overlap_min: overlap, pickup_on: day, pickup_from: local(day, outlet.pickup_from), pickup_to: local(day, outlet.pickup_to), capacity_fit: fits };
    })
    .filter((r) => r.overlap_min > 0);
  rows.sort((a, b) => b.overlap_min - a.overlap_min || a.distance_m - b.distance_m);
  return rows;
}

/** The expiry watcher's snapshots behind the Cares finding and proposal. */
export function caresSnapshots(now: Date): Snapshot[] {
  const today = businessDate(now);
  const at = mins(now, -45);
  const sourdough = expiryRows(HAZRATGANJ, now)[0]!;
  const params = { outlet_id: HAZRATGANJ, needs_cooked: false, needs_raw: false, needs_packaged: true, qty_milli: sourdough.at_risk_qty_milli as number, unit: "piece", expires_on: sourdough.expiry_on as string };
  return [
    snapshotOf(id7("snap:expiry"), "inventory.expiry_risk", { outlet_id: HAZRATGANJ, days: 7, as_of: today }, TEMPLATE_COLUMNS["inventory.expiry_risk"]!, expiryRows(HAZRATGANJ, now), { run: RUN.cares }, [HAZRATGANJ], at),
    snapshotOf(id7("snap:match"), "cares.recipient_match", params, TEMPLATE_COLUMNS["cares.recipient_match"]!, matchRowsFor(params, now), { run: RUN.cares }, [HAZRATGANJ], at),
  ];
}

/** Rows for a template a member mints on the mock (owner home's stat cards), from the mock's own books. */
export function mintRows(template: string, params: Snapshot["params"], orders: Map<string, Placed>, listings: S["V1CaresListing"][], now: Date): Snapshot["rows"] | null {
  const outlet = typeof params.outlet_id === "string" ? params.outlet_id : null;
  switch (template) {
    case "kitchen.ticket_coverage": {
      const from = String(params.from), to = String(params.to);
      const ts = [...orders.values()].filter((p) => (!outlet || p.order.outlet_id === outlet) && p.order.business_date >= from && p.order.business_date <= to).flatMap((p) => p.tickets);
      const timed = ts.filter((t) => t.accepted_at && t.ready_at).length;
      return [{ tickets: ts.length, timed_tickets: timed, coverage_bp: ts.length ? Math.floor((timed * 10000) / ts.length) : null }];
    }
    case "people.labour_pct":
      return [{ iso_week: "2026-W42", labour_minor: 4_180_000, net_sales_minor: outlet === GOMTI_NAGAR ? 7_930_000 : outlet ? 12_450_000 : 20_380_000, labour_bp: 2051, target_bp: 2200, excess_labour_minor: 0 }];
    case "inventory.waste_week":
      return seedSnapshots(now)[0]!.rows;
    case "inventory.below_reorder":
      return seedSnapshots(now)[4]!.rows;
    case "purchasing.quote_compare":
      return params.negotiation_run_id === RUN.negotiation ? seedSnapshots(now)[3]!.rows : [];
    case "inventory.expiry_risk":
      return expiryRows(outlet, now);
    case "cares.recipient_match":
      return matchRowsFor(params, now);
    case "cares.impact": {
      const recorded = listings.filter((l) => (!outlet || l.outlet_id === outlet) && l.handovers.some((h) => h.status === "recorded"));
      const row = (kind: string, ls: typeof recorded) => {
        const hs = ls.flatMap((l) => l.handovers.filter((h) => h.status === "recorded").map((h) => ({ l, h })));
        const qty = (unit: (u: string) => boolean) => hs.reduce((s, { l, h }) => s + h.lines.reduce((t, x) => t + (unit(l.lines.find((y) => y.line_id === x.listing_line_id)!.unit) ? x.qty_milli : 0), 0), 0);
        return { kind, handovers: hs.length, portions_milli: qty((u) => u === "portion"), weight_g: 0, volume_ml: 0, units_milli: qty((u) => u !== "portion"), value_at_cost_minor: hs.length * 61_500 };
      };
      return [row("total", recorded), row("donation", recorded.filter((l) => l.kind === "donation")), row("offer", recorded.filter((l) => l.kind === "offer"))];
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------- the AI inbox
export const snap = (key: string, row: number, column: string) => `⟨snap:${id7(`snap:${key}`)}·${row}·${column}⟩`;
const bare = (key: string) => `snap:${id7(`snap:${key}`)}`;
export const quoteRef = (quoteId: string) => `⟨cite:row:intel.supplier_quote:${quoteId}⟩`;

/** Findings: what the specialists noticed. Text never holds a digit; every number is a ref. */
export function seedFindings(now: Date): Finding[] {
  const at = mins(now, -55);
  const value = (key: string, row: number, c: string) => ({ ref: snap(key, row, c), value: seedSnapshots(now).find((s) => s.snapshot_id === id7(`snap:${key}`))!.rows[row]![c]! });
  return [
    {
      finding_id: id7("finding:butter"), run_id: RUN.waste, pack: "inventory_purchasing", type: "inventory.waste_spike", severity: "medium", status: "open",
      confidence_bp: 8200, dedupe_key: `inventory.waste_spike:${HAZRATGANJ}:butter`,
      envelope: {
        finding_id: id7("finding:butter"), impact_ref: snap("waste", 0, "excess_minor"), abstained: false, reason_code: null,
        segments: [
          { text: `Butter written off at Cobnut Hazratganj this week came to ${snap("waste", 0, "waste_minor")}, against a usual week of ${snap("waste", 0, "median_minor")}.`, refs: [bare("waste")] },
          { text: `That is ${snap("waste", 0, "excess_minor")} more than usual.`, refs: [bare("waste")] },
        ],
      },
      resolved_refs: [value("waste", 0, "waste_minor"), value("waste", 0, "median_minor"), value("waste", 0, "excess_minor")],
      created_at: at, updated_at: at,
    },
    {
      finding_id: id7("finding:cake"), run_id: RUN.kitchen, pack: "kitchen", type: "kitchen.ticket_drift", severity: "low", status: "open",
      confidence_bp: 7400, dedupe_key: `kitchen.ticket_drift:${HAZRATGANJ}:cake`,
      envelope: {
        finding_id: id7("finding:cake"), impact_ref: snap("times", 0, "late_tickets"), abstained: false, reason_code: null,
        segments: [
          { text: `Hazelnut Praline Cake tickets ran late ${snap("times", 0, "late_tickets")} times this week. The slowest fifth took longer than ${snap("times", 0, "p80_sec")}; the set prep time is ${snap("times", 0, "configured_prep_sec")}.`, refs: [bare("times")] },
        ],
      },
      resolved_refs: [value("times", 0, "late_tickets"), value("times", 0, "p80_sec"), value("times", 0, "configured_prep_sec")],
      created_at: at, updated_at: at,
    },
    expiryFinding(now),
  ];
}

/** 14 §10: the expiry watcher's finding (sourdough loaves that will pass their date before they sell). */
export function expiryFinding(now: Date): Finding {
  const at = mins(now, -45);
  const value = (row: number, c: string) => ({ ref: snap("expiry", row, c), value: caresSnapshots(now)[0]!.rows[row]![c]! });
  return {
    finding_id: id7("finding:expiry"), run_id: RUN.cares, pack: "inventory_purchasing", type: "inventory.expiry_risk", severity: "medium", status: "open",
    confidence_bp: 8800, dedupe_key: `inventory.expiry_risk:${HAZRATGANJ}:${BATCH.sourdough}`,
    envelope: {
      finding_id: id7("finding:expiry"), impact_ref: snap("expiry", 0, "at_risk_minor"), abstained: false, reason_code: null,
      segments: [
        { text: `Sliced sourdough loaves at Cobnut Hazratganj may pass their use-by date before they sell: ${snap("expiry", 0, "at_risk_qty_milli")} of them, worth ${snap("expiry", 0, "at_risk_minor")} at cost.`, refs: [bare("expiry")] },
      ],
    },
    resolved_refs: [value(0, "at_risk_qty_milli"), value(0, "at_risk_minor")],
    created_at: at, updated_at: at,
  };
}

export interface SeedDraft {
  draft: Draft;
  /** Refs that do not resolve for the viewer (GET /v1/drafts/{id} unverified_refs). */
  unverified: string[];
}

/** Drafts: what the specialists propose. Each changes nothing until a named person approves it. */
export function seedDrafts(now: Date): SeedDraft[] {
  const today = businessDate(now);
  const at = mins(now, -50);
  const cell = (key: string, row: number, c: string) => seedSnapshots(now).find((s) => s.snapshot_id === id7(`snap:${key}`))!.rows[row]![c]!;
  const based = (key: string, row: number, c: string, template: string) => ({ ref: snap(key, row, c), template_id: template, params: seedSnapshots(now).find((s) => s.snapshot_id === id7(`snap:${key}`))!.params, expected: cell(key, row, c) });
  const common = (id: string, run: string, finding: string | null, outlets: string[]) => ({
    draft_id: id, outlet_ids: outlets, source: "", finding_id: finding, run_id: run, status: "proposed" as const, created_at: at, updated_at: at,
  });
  return [
    {
      unverified: [],
      draft: {
        ...common(id7("draft:prep_time"), RUN.kitchen, id7("finding:cake"), [HAZRATGANJ]), source: "intel:kitchen",
        command_type: "kitchen.prep_time.set.v1",
        payload: { outlet_id: HAZRATGANJ, item_id: itemId("praline_celebration_cake"), station: "kitchen", prep_sec: snap("times", 0, "p80_sec"), valid_from: addDays(today, 1) },
        resolved_refs: [{ path: "/prep_sec", ref: snap("times", 0, "p80_sec"), value: cell("times", 0, "p80_sec") }],
        evidence: [bare("times")], based_on: [based("times", 0, "p80_sec", "kitchen.ticket_times")],
      },
    },
    {
      unverified: [],
      draft: {
        ...common(id7("draft:prep_list"), RUN.kitchen, null, [HAZRATGANJ]), source: "intel:kitchen",
        command_type: "kitchen.prep_list.create.v1",
        payload: {
          prep_list_id: id7("prep_list:tomorrow"), outlet_id: HAZRATGANJ, business_date: addDays(today, 1),
          lines: [
            { ingredient_id: ING("butter"), qty_milli: snap("prep", 0, "prep_qty_milli"), unit: "g" },
            { ingredient_id: ING("hazelnuts"), qty_milli: snap("prep", 1, "prep_qty_milli"), unit: "g" },
          ],
        },
        resolved_refs: [
          { path: "/lines/0/qty_milli", ref: snap("prep", 0, "prep_qty_milli"), value: cell("prep", 0, "prep_qty_milli") },
          { path: "/lines/1/qty_milli", ref: snap("prep", 1, "prep_qty_milli"), value: cell("prep", 1, "prep_qty_milli") },
        ],
        evidence: [bare("prep")], based_on: [based("prep", 0, "prep_qty_milli", "kitchen.prep_need"), based("prep", 1, "prep_qty_milli", "kitchen.prep_need")],
      },
    },
    {
      // The simulated supplier's quoted price is a quote row, which core does not resolve for the approver: it is
      // always in unverified_refs, so "Approve" stays hidden and the owner types the price ("Approve with my edits").
      unverified: [quoteRef(QUOTE.nutsR2)],
      draft: {
        ...common(id7("draft:po_nuts"), RUN.negotiation, null, [HAZRATGANJ]), source: "intel:inventory_purchasing",
        command_type: "purchasing.po.create.v1",
        payload: {
          po_id: id7("po:draft:nuts"), supplier_id: SUPPLIER.nuts, outlet_ids: [HAZRATGANJ], currency: CURRENCY, expected_on: addDays(today, 2), negotiation_run_id: RUN.negotiation,
          lines: [{ ingredient_id: ING("hazelnuts"), qty_milli: snap("quotes", 1, "qty_milli"), unit: "kg", unit_price_minor: quoteRef(QUOTE.nutsR2) }],
        },
        resolved_refs: [{ path: "/lines/0/qty_milli", ref: snap("quotes", 1, "qty_milli"), value: cell("quotes", 1, "qty_milli") }],
        evidence: [bare("quotes"), bare("below")], based_on: [based("quotes", 1, "qty_milli", "purchasing.quote_compare")],
      },
    },
    caresDraft(now),
  ];
}

/** 14 §10: the expiry watcher's donation proposal. The code picked the recipient (row 0 of the ranking) and copied its
 *  pickup window; the quantity is a ref to the at-risk cell. Packaged stock only: a cooked line never arrives as a draft. */
function caresDraft(now: Date): SeedDraft {
  const [expiry, match] = caresSnapshots(now);
  const best = match!.rows[0]!;
  const at = mins(now, -40);
  const based = (s: Snapshot, key: string, row: number, c: string) => ({ ref: snap(key, row, c), template_id: s.template_id, params: s.params, expected: s.rows[row]![c]! });
  return {
    unverified: [],
    draft: {
      draft_id: id7("draft:cares"), outlet_ids: [HAZRATGANJ], source: "intel:inventory_purchasing", finding_id: id7("finding:expiry"), run_id: RUN.cares, status: "proposed",
      created_at: at, updated_at: at, command_type: "cares.listing.publish.v1",
      payload: {
        listing_id: id7("listing:proposed"), outlet_id: HAZRATGANJ, kind: "donation", recipient_id: String(best.recipient_id), pickup_from: String(best.pickup_from), pickup_to: String(best.pickup_to),
        lines: [{ line_id: id7("listing_line:proposed:1"), food_kind: "packaged", item_id: null, ingredient_id: ING("sourdough"), batch_id: BATCH.sourdough, qty_milli: snap("expiry", 0, "at_risk_qty_milli"), unit: "piece", expires_on: String(expiry!.rows[0]!.expiry_on), unit_price_minor: null, currency: null }],
      },
      resolved_refs: [{ path: "/lines/0/qty_milli", ref: snap("expiry", 0, "at_risk_qty_milli"), value: expiry!.rows[0]!.at_risk_qty_milli! }],
      evidence: [bare("expiry"), bare("match")],
      based_on: [based(match!, "match", 0, "name"), based(expiry!, "expiry", 0, "at_risk_qty_milli")],
    },
  };
}

// ---------------------------------------------------------------- Ask Munim
export type SpecialistId = NonNullable<S["V1Thread"]["specialist"]>;
const SPECIALIST_ALIASES: [SpecialistId, string[]][] = [
  ["catalogue", ["catalogue", "menu", "pricing", "menu_pricing"]], ["kitchen", ["kitchen", "chef"]],
  ["inventory_purchasing", ["inventory", "purchasing", "stock", "inventory_purchasing"]], ["finance", ["finance", "accounts", "accounting"]],
  ["people", ["people", "staff", "hr"]], ["customers", ["customers", "growth", "customers_growth"]],
  ["compliance", ["compliance", "assets", "compliance_assets"]], ["market", ["market", "strategy", "market_strategy"]],
];
export const SPECIALISTS: S["V1SpecialistsResponse"] = {
  items: [["manager", ["manager"]] as [string, string[]], ...SPECIALIST_ALIASES].map(([id, aliases]) => ({
    id, kind: id === "manager" ? ("manager" as const) : ("specialist" as const), name_key: `specialist.${id}.name`,
    desk_key: id === "manager" ? "desk.reception" : `desk.${id === "inventory_purchasing" ? "purchasing" : id}`,
    aliases, detectors: [], templates: [], draftables: [], workflow_draftables: [],
  })),
};
/** core's rule: only a leading @token counts, matched case-insensitively against the eight specialists' aliases. */
export function addressedTo(question: string): SpecialistId | null {
  const m = /^@([A-Za-z_]+)(?=[\s,:;]|$)/.exec(question.trim());
  if (!m) return null;
  const a = m[1]!.toLowerCase();
  return SPECIALIST_ALIASES.find(([, as]) => as.includes(a))?.[0] ?? null;
}

type Answer = S["V1AskResponse"]["answer"];
/** The mock's answers: a cited one about cake tickets or waste, else an honest abstention. */
export function answerFor(question: string, addressed: SpecialistId | null, answerId: string, now: Date): Answer {
  const q = question.toLowerCase();
  const signature = (sp: SpecialistId | null): Answer["signature"] =>
    sp ? { key: "answer.signature.via_manager", specialist: sp, name_key: `specialist.${sp}.name` } : { key: "answer.signature.manager", specialist: "manager", name_key: "specialist.manager.name" };
  const v = (key: string, row: number, c: string) => ({ ref: snap(key, row, c), value: seedSnapshots(now).find((s) => s.snapshot_id === id7(`snap:${key}`))!.rows[row]![c]! });
  if (/cake|ticket|kitchen|late/.test(q)) {
    return {
      answer_id: answerId, signature: signature(addressed ?? "kitchen"),
      envelope: { answer_id: answerId, abstained: false, reason_code: null, follow_up: null, segments: [
        { text: `Cobnut Hazratganj made ${snap("times", 0, "tickets")} Hazelnut Praline Cake tickets this week; half were ready within ${snap("times", 0, "p50_sec")}.`, refs: [bare("times")] },
        { text: `${snap("times", 0, "late_tickets")} of them were late. The set prep time is ${snap("times", 0, "configured_prep_sec")}, and the slowest fifth took longer than ${snap("times", 0, "p80_sec")}.`, refs: [bare("times")] },
      ] },
      resolved_refs: [v("times", 0, "tickets"), v("times", 0, "p50_sec"), v("times", 0, "late_tickets"), v("times", 0, "configured_prep_sec"), v("times", 0, "p80_sec")],
    };
  }
  if (/waste|butter|thrown|written off/.test(q)) {
    return {
      answer_id: answerId, signature: signature(addressed ?? "inventory_purchasing"),
      envelope: { answer_id: answerId, abstained: false, reason_code: null, follow_up: null, segments: [
        { text: `Butter written off at Cobnut Hazratganj this week came to ${snap("waste", 0, "waste_minor")}; a usual week is ${snap("waste", 0, "median_minor")}.`, refs: [bare("waste")] },
      ] },
      resolved_refs: [v("waste", 0, "waste_minor"), v("waste", 0, "median_minor")],
    };
  }
  return {
    answer_id: answerId, signature: signature(addressed),
    envelope: { answer_id: answerId, abstained: true, reason_code: "insufficient_history", follow_up: null, segments: [] },
    resolved_refs: [],
  };
}

export function seedThreads(now: Date): S["V1Thread"][] {
  const at = mins(now, -90);
  const thread = (key: string, question: string, specialist: SpecialistId | null) => {
    const answer = answerFor(question, addressedTo(question), id7(`answer:${key}`), now);
    return {
      thread_id: id7(`thread:${key}`), specialist, created_by: OWNER_ID, outlet_scope: ["*"] as ["*"], created_at: at, updated_at: at,
      summary: answer.envelope.abstained ? [] : [{ turn_no: 1, answer_id: answer.answer_id, segment: 0, refs: answer.envelope.segments[0]!.refs }],
      turns: [{ turn_id: id7(`turn:${key}:1`), turn_no: 1, member_id: OWNER_ID, addressed_to: addressedTo(question), tainted: false, question, answer, created_at: at }],
    };
  };
  return [thread("cake", "@Kitchen how are the cake tickets doing this week?", "kitchen"), thread("diwali", "What will we sell on Diwali night?", null)];
}

// ---------------------------------------------------------------- Munim Cares (simulated recipients)
const CARES_LABELS = { labels: { data: "Measured on synthetic data" as const, recipients: "to simulated recipients" as const }, note_key: "cares.note.check_local_rules" as const };
export const CARES_PROFILE: S["V1CaresProfile"] = {
  available: true, enabled: true, profile: { status: "active", public_name: "Cobnut Bakehouse (synthetic)", b2b_enabled: false },
  outlets: [
    { outlet_id: HAZRATGANJ, city_code: "lucknow", lat_e6: 26_850_000, lng_e6: 80_946_000, pickup_from: "21:00", pickup_to: "22:30", active: true },
    { outlet_id: GOMTI_NAGAR, city_code: "lucknow", lat_e6: 26_852_000, lng_e6: 81_000_000, pickup_from: "21:00", pickup_to: "22:30", active: true },
  ],
  ...CARES_LABELS,
};
export const RECIPIENT = { shelter: id7("recipient:shelter"), kitchen: id7("recipient:kitchen") };
export const RECIPIENTS: S["V1CaresRecipients"] = {
  items: [
    { recipient_id: RECIPIENT.shelter, city_code: "lucknow", name: "Riverside Night Shelter (simulated)", kind: "ngo", simulated: true, accepts_cooked: true, accepts_raw: false, accepts_packaged: true, capacity_kg_per_day: 40, capacity_portions_per_day: 120, receiving_from: "20:30", receiving_to: "23:00", lat_e6: 26_848_000, lng_e6: 80_950_000 },
    { recipient_id: RECIPIENT.kitchen, city_code: "lucknow", name: "Old Town Community Kitchen (simulated)", kind: "food_bank", simulated: true, accepts_cooked: false, accepts_raw: true, accepts_packaged: true, capacity_kg_per_day: 150, capacity_portions_per_day: 0, receiving_from: "09:00", receiving_to: "22:00", lat_e6: 26_870_000, lng_e6: 80_910_000 },
  ],
  ...CARES_LABELS,
};

/** Tonight's open donation at Hazratganj, and yesterday's, handed over (it counts in cares.impact). */
export function seedListings(now: Date): S["V1CaresListing"][] {
  const today = businessDate(now);
  const yesterday = addDays(today, -1);
  const local = (date: string, hhmm: string) => new Date(Date.parse(`${date}T${hhmm}:00Z`) - TZ_OFFSET_MIN * 60_000).toISOString();
  const line = (key: string, no: number, kind: "cooked" | "packaged", qty: number, unit: string, item: string | null, ing: string | null) => ({
    line_id: id7(`listing_line:${key}:${no}`), line_no: no, food_kind: kind, item_id: item, ingredient_id: ing, batch_id: null, qty_milli: qty, unit, expires_on: kind === "packaged" ? addDays(today, 1) : null, unit_price_minor: null, currency: null,
  });
  const tonight = [line("tonight", 1, "packaged", 8000, "piece", null, ING("sourdough"))];
  const last = [line("yesterday", 1, "cooked", 18000, "portion", itemId("cardamom_knot"), null), line("yesterday", 2, "packaged", 6000, "piece", null, ING("sourdough"))];
  return [
    { listing_id: id7("listing:tonight"), outlet_id: HAZRATGANJ, kind: "donation", status: "published", recipient_id: RECIPIENT.kitchen, pickup_from: local(today, "21:00"), pickup_to: local(today, "22:30"), pickup_on: today, published_by: OWNER_ID, published_at: mins(now, -30), lines: tonight, handovers: [], ...CARES_LABELS },
    {
      listing_id: id7("listing:yesterday"), outlet_id: HAZRATGANJ, kind: "donation", status: "closed", recipient_id: RECIPIENT.shelter, pickup_from: local(yesterday, "21:00"), pickup_to: local(yesterday, "22:30"), pickup_on: yesterday, published_by: OWNER_ID, published_at: local(yesterday, "19:40"), lines: last,
      handovers: [{ handover_id: id7("handover:yesterday"), allocation_id: null, status: "recorded", handed_at: local(yesterday, "21:20"), recorded_by: MEMBERS[1]!.me.member_id, voided_by: null, void_reason_code: null, lines: last.map((l) => ({ listing_line_id: l.line_id, qty_milli: l.qty_milli })) }],
      ...CARES_LABELS,
    },
  ];
}

// ---------------------------------------------------------------- simulated suppliers
export function seedSuppliers(now: Date): S["V1Supplier"][] {
  const at = mins(now, -60 * 24 * 3);
  return [
    { supplier_id: SUPPLIER.dairy, name: "Riverbank Dairy (simulated)", kind: "simulated", label: "Simulated supplier", a2a_card_url: null, payment_days: 0, notes: null, active: true,
      prices: [{ price_id: id7("sp:dairy:butter"), ingredient_id: ING("butter"), unit: "kg", unit_price_minor: 56000, currency: CURRENCY, observed_at: at, source_ref: "Price list (synthetic)" }] },
    { supplier_id: SUPPLIER.nuts, name: "Lalbagh Nut & Spice (simulated)", kind: "simulated", label: "Simulated supplier", a2a_card_url: null, payment_days: 7, notes: null, active: true,
      prices: [{ price_id: id7("sp:nuts:hazel"), ingredient_id: ING("hazelnuts"), unit: "kg", unit_price_minor: 148000, currency: CURRENCY, observed_at: at, source_ref: "Price list (synthetic)" }] },
  ];
}
/** Last week's butter order, already received. */
export function seedPurchaseOrders(now: Date): S["V1PurchaseOrder"][] {
  const [dairy] = seedSuppliers(now);
  return [{
    po_id: id7("po:butter"), supplier: { supplier_id: dairy!.supplier_id, name: dairy!.name, kind: "simulated", label: "Simulated supplier" }, outlet_ids: [HAZRATGANJ],
    status: "received", currency: CURRENCY, total_minor: 560000, expected_on: addDays(businessDate(now), -5), negotiation_run_id: null, created_at: mins(now, -60 * 24 * 7),
    lines: [{ po_line_id: id7("po_line:butter:1"), line_no: 1, ingredient_id: ING("butter"), qty_milli: 10000, unit: "kg", unit_price_minor: 56000 }],
  }];
}
/** Last week's butter delivery, recorded against its purchase order (15 §10). */
export function seedGoodsReceived(now: Date): S["V1GoodsReceived"][] {
  const po = seedPurchaseOrders(now)[0]!;
  return [{
    grn_id: id7("grn:butter"), outlet_id: HAZRATGANJ, supplier: po.supplier, po_id: po.po_id, received_at: mins(now, -60 * 24 * 5), received_by: MEMBERS[0]!.me.member_id, note: "Two cartons, cold on arrival (synthetic)",
    lines: [{ grn_line_id: id7("grn_line:butter:1"), po_line_id: po.lines[0]!.po_line_id, ingredient_id: ING("butter"), batch_id: id7("batch:butter:grn"), qty_milli: 10000, unit: "kg", unit_cost_minor: 56000, currency: CURRENCY }],
  }];
}

export function reorderLevels(outletId: string, now: Date): S["V1InventoryReorderLevels"] {
  return {
    reorder_levels: outletId === HAZRATGANJ
      ? [
          { reorder_level_id: id7("rl:hzg:hazel"), outlet_id: HAZRATGANJ, ingredient_id: ING("hazelnuts"), min_qty_milli: 5_000_000, par_qty_milli: 12_000_000, updated_at: mins(now, -60 * 24 * 30) },
          { reorder_level_id: id7("rl:hzg:butter"), outlet_id: HAZRATGANJ, ingredient_id: ING("butter"), min_qty_milli: 4_000_000, par_qty_milli: 10_000_000, updated_at: mins(now, -60 * 24 * 30) },
        ]
      : [],
  };
}
