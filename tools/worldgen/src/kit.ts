// The commands a merchant's day is made of, each sent as a named person's own command through the SDK.
// Keys (`key` arguments) are the stable seed keys: the same key is the same id and the same idempotency key.
import { CommandRefused, personaIdentity } from "./api.ts";
import type { Ctx, J } from "./ctx.ts";
import { payoutFile, payoutFileMany, type Layout, type PayoutLine } from "./files.ts";
import { idemOf } from "./ids.ts";
import { addDays, at, mondayOf } from "./time.ts";

export interface OutletInfo { id: string; name: string; tz: string; device: string | null }
export interface Business {
  country: "IN" | "AU";
  currency: string;
  outlets: OutletInfo[];
  /** channel kind → id, e.g. "counter", "aggregator:swiggy". */
  channels: Record<string, string>;
}

export interface OnboardSpec {
  kind: "restaurant" | "cloud_kitchen" | "shop";
  country: "IN" | "AU";
  business: string;
  ownerName: string;
  outlet: { name: string; address: string; tz?: string; taxIds: Record<string, string> };
  more?: Array<{ name: string; address: string; kind: "restaurant" | "cloud_kitchen" | "store"; taxIds: Record<string, string> }>;
}

/** ON1–ON3 as the owner: one onboarding call, then the extra outlets, each with its POS device. */
export async function onboard(c: Ctx, spec: OnboardSpec): Promise<Business> {
  const { api } = c;
  const tenant = api.id("tenant"); // sent for the envelope shape only
  const first = api.id("outlet:1");
  // R1-m6: the payload's tenant_id is ignored; core mints the tenant and returns it as entity_id. Logged under an alias.
  const minted = await api.cmd("owner", "/v1/onboarding", "tenancy.onboard.v1", "onboard", {
    tenant_id: tenant, owner_member_id: api.id("member:owner"), outlet_id: first, owner_name: spec.ownerName, business_name: spec.business,
    kind: spec.kind, country_code: spec.country,
    outlet: { name: spec.outlet.name, address: spec.outlet.address, ...(spec.outlet.tz ? { tz: spec.outlet.tz } : {}), tax_ids: spec.outlet.taxIds },
  }, { noTenant: true });
  api.tenantId = api.alias(String(minted.body.entity_id), "tenant");
  const [defaultTz] = ((await api.get("owner", "/v1/outlets")).outlets as J[]).map((o) => o.tz as string);
  const outlets: OutletInfo[] = [{ id: first, name: spec.outlet.name, tz: defaultTz!, device: null }];
  for (const [i, o] of (spec.more ?? []).entries()) {
    const id = api.id(`outlet:${i + 2}`);
    await api.cmd("owner", "/v1/outlets", "tenancy.outlet.create.v1", `outlet:${i + 2}`, {
      outlet_id: id, name: o.name, kind: o.kind, tz: defaultTz, address: o.address, tax_ids: o.taxIds,
    });
    await api.cmd("owner", "/v1/devices", "tenancy.device.register.v1", `device:${i + 2}`, {
      device_id: api.id(`device:${i + 2}`), outlet_id: id, kind: "pos", invoice_series: `POS${i + 2}`,
    });
    outlets.push({ id, name: o.name, tz: defaultTz!, device: api.id(`device:${i + 2}`) });
  }
  const channels: Record<string, string> = {};
  for (const ch of (await api.get("owner", "/v1/channels")).channels as J[]) {
    channels[ch.kind as string] = api.alias(ch.id as string, `channel:${ch.kind}`);
  }
  for (const d of (await api.get("owner", "/v1/devices")).devices as J[]) {
    if (d.kind === "pos" && d.outlet_id === first) {
      outlets[0]!.device = api.alias(d.id as string, "device:1");
    } else if (d.kind === "kds") api.alias(d.id as string, `kds:${(d.outlet_id as string).slice(0, 8)}`);
  }
  // Synthetic outlets are open all day: the storefront refuses an order when the outlet's hours exclude the real now (409
  // outlet_paused), and a seed run must work at any wall-clock time. LocalTime caps at 23:59, so that one minute stays closed;
  // storefrontOrder waits it out.
  for (const [i, o] of outlets.entries()) {
    await api.cmd("owner", "/v1/outlets/{id}:update", "tenancy.outlet.update.v1", `hours:${i + 1}`, { outlet_id: o.id, hours: { opens: "00:00", closes: "23:59" } }, { params: { id: o.id } });
  }
  const t = (await api.get("owner", "/v1/tenant")) as J;
  const currency = t.base_currency as string;
  // R47 D9: the demo business's targets are the owner's own command, in force across the whole timeline (provisioning's empty default
  // policy starts long before it). Labour 30% of sales, margin 65%. R47 D3: the deal review's margin floor (15%) and minimum supplier
  // payment term (7 days) — demo values chosen by the orchestrator (R47 merge), not a founder decision; without them every review
  // rule that reads them is "cannot verify" and no PO draft can pass.
  await api.cmd("owner", "/v1/policy", "tenancy.policy.set.v1", "policy:targets", {
    outlet_id: null, valid_from: addDays(c.asOf, -(c.days + 62)), labour_target_bp: 3000, target_margin_bp: 6500, margin_floor_bp: 1500, min_payment_days: 7,
  });
  // R47 D2: no budget row means AI declines. The operator proposes this month's row and approves it, the way budgets are set (R24).
  // The month is the timeline's last (the real current month when as-of is today). Skipped, loudly in the CLI, when no operator is signed in.
  if (api.hasOperator) {
    const draft = api.id("config_draft:llm_budget");
    await api.post("operator", "/platform/v1/config-drafts", {
      draft_id: draft, target: `llm_budget:${api.tenantId}`, patch: { month: `${c.asOf.slice(0, 7)}-01`, limit_minor: 500000, currency },
    }, { noTenant: true });
    await api.post("operator", "/platform/v1/config-drafts/{id}:approve", {}, { params: { id: draft }, noTenant: true });
  }
  return { country: spec.country, currency, outlets, channels };
}

// ---- stock and catalogue -------------------------------------------------------------------------------------

export interface Ingredient { id: string; unit: string; name: string }

export async function ingredient(c: Ctx, key: string, name: string, unit: string, o: { shelfDays?: number; batch?: boolean } = {}): Promise<Ingredient> {
  const id = c.api.id(`ing:${key}`);
  await c.api.cmd("owner", "/v1/inventory/ingredients", "inventory.ingredient.upsert.v1", `ing:${key}`, {
    ingredient_id: id, name, base_unit: unit, shelf_life_days: o.shelfDays ?? null, tracked_by_batch: o.batch ?? false,
  });
  return { id, unit, name };
}

export interface Item { id: string; key: string; name: string }

export async function item(c: Ctx, key: string, o: { category: string; kind?: "dish" | "sku"; stock?: Ingredient; barcode?: string; mrp?: { minor: number; currency: string }; brand?: string | null }): Promise<Item> {
  const id = c.api.id(`item:${key}`);
  await c.api.cmd("owner", "/v1/catalogue/items", "catalogue.item.upsert.v1", `item:${key}`, {
    item_id: id, name_key: key.replaceAll(/[^a-z0-9]+/g, "_"), category: o.category, brand_id: o.brand ?? null, barcode: o.barcode ?? null,
    mrp_minor: o.mrp?.minor ?? null, currency: o.mrp?.currency ?? null, active: true, variants: [], option_groups: [],
    kind: o.kind ?? "dish", stock_ingredient_id: o.stock?.id ?? null,
  });
  return { id, key, name: key };
}

/** One price per outlet and channel kind, valid from the start of the timeline. */
export async function price(c: Ctx, it: Item, outletId: string, channelKind: string, amountMinor: number, taxClass: string, validFrom: string, o: { validTo?: string; tag?: string } = {}) {
  const key = `price:${it.key}:${outletId.slice(0, 8)}:${channelKind}:${o.tag ?? validFrom}`;
  await c.api.cmd("owner", "/v1/catalogue/prices", "catalogue.price.set.v1", key, {
    price_id: c.api.id(key), item_id: it.id, variant_id: null, outlet_id: outletId, channel_kind: channelKind, amount_minor: amountMinor,
    currency: (c.s.currency as string), tax_class: taxClass, valid_from: validFrom, valid_to: o.validTo ?? null,
  });
}

export async function recipe(c: Ctx, it: Item, from: string, lines: Array<{ ing: Ingredient; qtyMilli: number; wasteBp?: number }>) {
  const key = `recipe:${it.key}:${from}`;
  await c.api.cmd("owner", "/v1/catalogue/recipes", "catalogue.recipe.version.create.v1", key, {
    recipe_version_id: c.api.id(key), item_id: it.id, variant_id: null, version: 1, valid_from: from, valid_to: null, yield_qty_milli: 1000,
    lines: lines.map((l) => ({ ingredient_id: l.ing.id, qty_milli: l.qtyMilli, unit: l.ing.unit, waste_pct_bp: l.wasteBp ?? 200 })),
  });
}

// ---- suppliers, purchasing -----------------------------------------------------------------------------------

/** Suppliers are always simulated (hard rule 5): the read model carries the "Simulated supplier" label. */
export async function supplier(c: Ctx, key: string, name: string, paymentDays = 15): Promise<string> {
  const id = c.api.id(`supplier:${key}`);
  await c.api.cmd("owner", "/v1/suppliers", "purchasing.supplier.upsert.v1", `supplier:${key}`, {
    supplier_id: id, name, kind: "simulated", a2a_card_url: null, terms: { payment_days: paymentDays, notes: "Synthetic, simulated supplier" }, prices: [],
  });
  return id;
}

export interface PoLine { ing: Ingredient; qtyMilli: number; priceMinor: number }

/** A PO; returns its id and the server-numbered line ids (aliased in the request log). */
export async function purchaseOrder(c: Ctx, key: string, supplierId: string, outletId: string, expectedOn: string, lines: PoLine[]) {
  const id = c.api.id(`po:${key}`);
  await c.api.cmd("owner", "/v1/purchase-orders", "purchasing.po.create.v1", `po:${key}`, {
    po_id: id, supplier_id: supplierId, outlet_ids: [outletId], currency: c.s.currency, expected_on: expectedOn, negotiation_run_id: null,
    lines: lines.map((l) => ({ ingredient_id: l.ing.id, qty_milli: l.qtyMilli, unit: l.ing.unit, unit_price_minor: l.priceMinor })),
  });
  const po = await c.api.get("owner", "/v1/purchase-orders/{id}", { params: { id } });
  const poLines = po.lines as J[];
  return { id, lines: poLines.map((l, i) => c.api.alias(l.po_line_id as string, `poline:${key}:${i}`)) };
}

export interface GrnLine { ing: Ingredient; qtyMilli: number; costMinor: number | null; poLine: string | null; batch?: { code: string; expires: string | null; mrpMinor: number | null } }

export async function goodsReceived(c: Ctx, key: string, supplierId: string, outletId: string, poId: string | null, receivedAt: string, lines: GrnLine[]) {
  const id = c.api.id(`grn:${key}`);
  await c.api.cmd("owner", "/v1/goods-received", "purchasing.grn.receive.v1", `grn:${key}`, {
    grn_id: id, outlet_id: outletId, supplier_id: supplierId, po_id: poId, received_at: receivedAt, note: null,
    lines: lines.map((l, i) => ({
      grn_line_id: c.api.id(`grn:${key}:${i}`), po_line_id: l.poLine, ingredient_id: l.ing.id, qty_milli: l.qtyMilli, unit: l.ing.unit,
      unit_cost_minor: l.costMinor, currency: c.s.currency,
      batch: l.batch ? { batch_id: c.api.id(`batch:${l.batch.code}`), batch_code: l.batch.code, expires_on: l.batch.expires, mrp_minor: l.batch.mrpMinor } : null,
    })),
  });
  return id;
}

export interface InvLine { ing: Ingredient; qtyMilli: number; priceMinor: number; poLine: string | null; taxMinor?: number }

export async function invoice(c: Ctx, key: string, supplierId: string, invoiceNo: string, date: string, poId: string | null, lines: InvLine[], o: { approve?: boolean; expect?: number[]; refusedWith?: string } = {}) {
  const id = c.api.id(`inv:${key}`);
  const r = await c.api.cmd("owner", "/v1/supplier-invoices", "purchasing.invoice.record.v1", `inv:${key}`, {
    supplier_invoice_id: id, supplier_id: supplierId, invoice_no: invoiceNo, invoice_date: date, po_id: poId, currency: c.s.currency,
    lines: lines.map((l, i) => ({
      line_id: c.api.id(`inv:${key}:${i}`), po_line_id: l.poLine, ingredient_id: l.ing.id, description: null, qty_milli: l.qtyMilli,
      unit: l.ing.unit, unit_price_minor: l.priceMinor, tax_minor: l.taxMinor ?? 0,
    })),
  }, { ...(o.expect ? { expect: o.expect } : {}), ...(o.refusedWith ? { refusedWith: o.refusedWith } : {}) });
  if (o.approve !== false && !o.refusedWith && r.status < 300) {
    await c.api.cmd("owner", "/v1/supplier-invoices/{id}:approve", "purchasing.invoice.approve.v1", `invapprove:${key}`, { supplier_invoice_id: id }, { params: { id } });
  }
  return id;
}

// ---- inventory -----------------------------------------------------------------------------------------------

export async function openingStock(c: Ctx, key: string, outletId: string, atIso: string, lines: Array<{ ing: Ingredient; qtyMilli: number; costMinor: number; batch?: { code: string; expires: string | null; mrpMinor: number | null } }>) {
  await c.api.cmd("owner", "/v1/inventory/stock:receive", "inventory.stock.receive.v1", `stock:${key}`, {
    outlet_id: outletId, source: "opening", at: atIso,
    lines: lines.map((l, i) => ({
      movement_id: c.api.id(`stock:${key}:${i}`), ingredient_id: l.ing.id,
      batch_id: l.batch ? c.api.id(`batch:${l.batch.code}`) : null,
      batch: l.batch ? { batch_code: l.batch.code, expires_on: l.batch.expires, mrp_minor: l.batch.mrpMinor } : null,
      qty_milli: l.qtyMilli, unit: l.ing.unit, unit_cost: { amount_minor: l.costMinor, currency: c.s.currency },
    })),
  });
}

export async function waste(c: Ctx, key: string, outletId: string, ing: Ingredient, qtyMilli: number, reason: "temperature" | "overprep" | "expired" | "damaged" | "other", o: { batch?: string; persona?: string } = {}) {
  await c.api.cmd(o.persona ?? "owner", "/v1/inventory/waste", "inventory.waste.record.v1", `waste:${key}`, {
    waste_id: c.api.id(`waste:${key}`), outlet_id: outletId, ingredient_id: ing.id, batch_id: o.batch ? c.api.id(`batch:${o.batch}`) : null,
    qty_milli: qtyMilli, unit: ing.unit, reason, note: reason === "other" ? "synthetic" : null,
  });
}

export async function reorderLevel(c: Ctx, outletId: string, ing: Ingredient, minMilli: number, parMilli: number) {
  await c.api.cmd("owner", "/v1/inventory/reorder-levels", "inventory.reorder_level.set.v1", `reorder:${outletId.slice(0, 8)}:${ing.id.slice(0, 8)}`, {
    outlet_id: outletId, ingredient_id: ing.id, min_qty_milli: minMilli, par_qty_milli: parMilli,
  });
}

// ---- people --------------------------------------------------------------------------------------------------

export interface Staff { id: string; key: string; rateMinor: number; otBp: number }

export async function staff(c: Ctx, key: string, name: string, outletId: string, role: string, rateMinor: number, joinedOn: string, o: { otBp?: number } = {}): Promise<Staff> {
  const id = c.api.id(`staff:${key}`);
  const otBp = o.otBp ?? 15000;
  await c.api.cmd("owner", "/v1/people/staff:upsert", "people.staff.upsert.v1", `staff:${key}`, {
    staff_id: id, member_id: null, outlet_id: outletId, name, phone: null, role_key: role, pay_basis: "hourly", wage_rate_minor: rateMinor,
    monthly_salary_minor: null, contract_min_per_month: null, ot_multiplier_bp: otBp, currency: c.s.currency, joined_on: joinedOn, left_on: null, active: true,
  });
  return { id, key, rateMinor, otBp };
}

export async function roster(c: Ctx, key: string, outlet: OutletInfo, weekStart: string, shifts: Array<{ staff: Staff; date: string; start: string; end: string; role: string }>, atFn: (d: string, t: string) => string) {
  await c.api.cmd("owner", "/v1/people/rosters", "people.roster.create.v1", `roster:${key}`, {
    roster_id: c.api.id(`roster:${key}`), outlet_id: outlet.id, week_start: weekStart,
    shifts: shifts.map((s) => ({
      roster_shift_id: c.api.id(`rshift:${s.staff.key}:${s.date}`), staff_id: s.staff.id, starts_at: atFn(s.date, s.start), ends_at: atFn(s.date, s.end), role_key: s.role,
    })),
  });
}

export async function attend(c: Ctx, outlet: OutletInfo, s: Staff, date: string, inAt: string, outAt: string) {
  const id = c.api.id(`att:${s.key}:${date}`);
  const base = { attendance_id: id, outlet_id: outlet.id, staff_id: s.id, roster_shift_id: c.api.id(`rshift:${s.key}:${date}`), source: "manual" };
  await c.api.cmd("owner", "/v1/people/attendance", "people.attendance.record.v1", `attin:${s.key}:${date}`, { ...base, action: "clock_in", at: inAt });
  await c.api.cmd("owner", "/v1/people/attendance", "people.attendance.record.v1", `attout:${s.key}:${date}`, { ...base, action: "clock_out", at: outAt });
}

export async function advance(c: Ctx, key: string, s: Staff, kind: "given" | "recovered", amountMinor: number, onDate: string) {
  await c.api.cmd("owner", "/v1/people/advances", "people.advance.record.v1", `adv:${key}`, {
    advance_id: c.api.id(`adv:${key}`), staff_id: s.id, kind, amount_minor: amountMinor, currency: c.s.currency, on_date: onDate, note: null,
  });
}

// ---- compliance ----------------------------------------------------------------------------------------------

export async function asset(c: Ctx, key: string, outletId: string, kind: string, name: string, safeMinC: number | null, safeMaxC: number | null) {
  const id = c.api.id(`asset:${key}`);
  await c.api.cmd("owner", "/v1/compliance/assets", "compliance.asset.upsert.v1", `asset:${key}`, {
    asset_id: id, outlet_id: outletId, kind, name, make_model: null, serial_no: null,
    safe_min_milli_c: safeMinC === null ? null : safeMinC * 1000, safe_max_milli_c: safeMaxC === null ? null : safeMaxC * 1000, installed_on: null, active: true,
  });
  return id;
}

export async function tempLog(c: Ctx, key: string, outletId: string, assetId: string, milliC: number, readAt: string) {
  await c.api.cmd("owner", "/v1/compliance/temp-logs", "compliance.temp.record.v1", `temp:${key}`, {
    log_id: c.api.id(`temp:${key}`), outlet_id: outletId, asset_id: assetId, reading_milli_c: milliC, read_at: readAt, note: null,
  });
}

export async function licence(c: Ctx, key: string, outletId: string | null, kind: string, number: string, issuer: string, validFrom: string, validTo: string | null) {
  const id = c.api.id(`licence:${key}`);
  await c.api.cmd("owner", "/v1/compliance/licences", "compliance.licence.upsert.v1", `licence:${key}`, {
    licence_id: id, outlet_id: outletId, kind, number, issuer, valid_from: validFrom, valid_to: validTo, document_id: null, supersedes_licence_id: null,
  });
  return id;
}

// ---- finance -------------------------------------------------------------------------------------------------

export async function channelTerms(c: Ctx, key: string, channelId: string, o: { commissionBp: number; ads: boolean; capMinor: number | null; promoBp: number; cycleDays: number; from: string }) {
  await c.api.cmd("owner", "/v1/finance/channel-terms", "finance.channel_terms.set.v1", `terms:${key}`, {
    channel_terms_id: c.api.id(`terms:${key}`), channel_id: channelId, commission_bp: o.commissionBp, ads_opted_in: o.ads,
    ad_spend_cap_minor: o.ads ? o.capMinor : null, promo_share_bp: o.promoBp, payout_cycle_days: o.cycleDays, currency: c.s.currency, valid_from: o.from, valid_to: null,
  });
}

export async function expense(c: Ctx, key: string, outletId: string, category: string, date: string, amountMinor: number, taxMinor: number, payee: string) {
  await c.api.cmd("owner", "/v1/finance/expenses", "finance.expense.record.v1", `exp:${key}`, {
    expense_id: c.api.id(`exp:${key}`), outlet_id: outletId, category, incurred_on: date, amount_minor: amountMinor, tax_minor: taxMinor,
    currency: c.s.currency, payee, note: null, document_id: null,
  });
}

// ---- imports (a file → parsed run → the owner approves the draft; nothing reaches the books before that) ------------

export type ImportKindName = "payout_statement" | "bank_statement" | "pos_export" | "tally_export" | "market_signal" | "pos_bills" | "waste_log";
interface Queued { key: string; kind: ImportKindName; filename: string; text: string; reason: string | null; hold: boolean }
const queueOf = (c: Ctx): Queued[] => ((c.s.importQueue as Queued[] | undefined) ??= []);
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

/** Queues a file; `flushImports` uploads the queue in order, waits for the parses together (the worker parses on a timer — against
 *  `make up` that is once a minute, so one wait per batch, not one per file), then approves in the same order as the owner. */
export function importFile(c: Ctx, key: string, kind: ImportKindName, filename: string, text: string, reason: string | null = null, o: { hold?: boolean } = {}): void {
  queueOf(c).push({ key, kind, filename, text, reason, hold: o.hold ?? false });
}

export async function flushImports(c: Ctx): Promise<void> {
  const { api } = c;
  const queue = queueOf(c).splice(0);
  const pending: Array<{ q: Queued; runId: string; run: J }> = [];
  for (const q of queue) {
    const up = await api.post("owner", "/v1/imports/documents", {
      kind: q.kind, filename: q.filename, media_type: "text/csv", content_base64: Buffer.from(q.text, "utf8").toString("base64"),
    });
    const run0 = up.run as J | null;
    if (!run0) throw new Error(`import ${q.key}: header not recognised`);
    const runId = api.alias(run0.import_run_id as string, `run:${q.key}`);
    api.alias((up.document as J).document_id as string, `doc:${q.key}`);
    // The same bytes again (re-seeding a world): the existing run is already committed under its approver.
    if (up.duplicate === true && run0.status === "committed") continue;
    pending.push({ q, runId, run: run0 });
  }
  for (const p of pending) {
    for (let i = 0; i < 600 && p.run.status === "parsing"; i++) {
      await sleep(i < 20 ? 100 : 500);
      p.run = await api.get("owner", "/v1/imports/runs/{id}", { params: { id: p.runId } });
    }
    if (p.run.status !== "previewed") throw new Error(`import ${p.q.key}: run is ${String(p.run.status)}`);
    if ((p.run.rows_quarantined as number) !== 0) throw new Error(`import ${p.q.key}: ${String(p.run.rows_quarantined)} rows quarantined`);
  }
  for (const p of pending) {
    const draft = api.alias(p.run.draft_id as string, `draft:${p.q.key}`);
    // A held file stays previewed with its draft waiting: the owner has not approved it yet (a missing settlement, F7).
    if (p.q.hold) continue;
    await api.cmd("owner", "/v1/drafts/{id}:approve", "drafts.approve.v1", `approve:${p.q.key}`, {
      draft_id: draft, command_type: "imports.run.commit.v1", edited_payload: null, reason: p.q.reason,
    }, { params: { id: draft } });
  }
}

// ---- orders (server-stamped: they land on the day the seed runs — see the report's clock note) -------------------

export interface OrderLine { item: Item; qtyMilli: number; barcode?: string }

export async function placeOrder(c: Ctx, key: string, biz: Business, outlet: OutletInfo, channelKind: string, kind: "dine_in" | "takeaway" | "pickup" | "delivery", lines: OrderLine[],
  o: { externalRef?: string; coupons?: string[]; persona?: string; table?: string; expect?: number[]; brand?: string | null; refusedWith?: string } = {}) {
  const aggregator = channelKind.startsWith("aggregator:");
  return c.api.cmd(o.persona ?? "owner", "/v1/orders", "orders.place.v1", key, {
    order_id: c.api.id(key), outlet_id: outlet.id, channel_id: biz.channels[channelKind], brand_id: o.brand ?? null,
    device_id: channelKind === "counter" ? outlet.device : null, kind, table_ref: o.table ?? null, pickup_window_id: null, promised_at: null,
    external_ref: aggregator ? (o.externalRef ?? key) : null,
    lines: lines.map((l, i) => ({ line_id: c.api.id(`${key}:l${i}`), item_id: l.item.id, variant_id: null, option_ids: [], qty_milli: l.qtyMilli, barcode: l.barcode ?? null, note: null })),
    coupon_codes: o.coupons ?? [], loyalty_redeem_points: 0, preview_total_minor: null, client_totals: null,
  }, { ...(o.expect ? { expect: o.expect } : {}), ...(o.refusedWith ? { refusedWith: o.refusedWith } : {}) });
}

/** Cash: the member records what was handed over; core computes the applied amount. */
export async function tenderCash(c: Ctx, key: string, orderKey: string, tenderedMinor: number, persona = "owner") {
  await c.api.cmd(persona, "/v1/orders/{id}/tenders", "orders.tender.record.v1", key, {
    tender_id: c.api.id(key), order_id: c.api.id(orderKey), method: "cash", tendered_minor: tenderedMinor, amount_minor: null, currency: c.s.currency, ref: null,
  }, { params: { id: c.api.id(orderKey) } });
}

export async function tenderUpi(c: Ctx, key: string, orderKey: string, amountMinor: number, persona = "owner") {
  await c.api.cmd(persona, "/v1/orders/{id}/tenders", "orders.tender.record.v1", key, {
    tender_id: c.api.id(key), order_id: c.api.id(orderKey), method: "upi", tendered_minor: null, amount_minor: amountMinor, currency: c.s.currency, ref: `UPI-${key.slice(-6)}`,
  }, { params: { id: c.api.id(orderKey) } });
}

export async function shiftOpen(c: Ctx, key: string, outlet: OutletInfo, floatMinor: number, persona = "owner") {
  await c.api.cmd(persona, "/v1/shifts", "orders.shift.open.v1", key, { shift_id: c.api.id(key), outlet_id: outlet.id, device_id: outlet.device, float_minor: floatMinor, currency: c.s.currency });
}

export async function shiftClose(c: Ctx, key: string, countedMinor: number, persona = "owner") {
  await c.api.cmd(persona, "/v1/shifts/{id}:close", "orders.shift.close.v1", `${key}:close`, { shift_id: c.api.id(key), counted_cash_minor: countedMinor }, { params: { id: c.api.id(key) } });
}

export async function coupon(c: Ctx, key: string, code: string, o: { bp: number; from: string; cap?: number | null; perCustomerCap?: number; requiresCustomer?: boolean }) {
  await c.api.cmd("owner", "/v1/catalogue/coupons", "catalogue.coupon.set.v1", `coupon:${key}`, {
    coupon_id: c.api.id(`coupon:${key}`), code, kind: "percent", value_bp: o.bp, value_minor: null, currency: c.s.currency, min_spend_minor: 0,
    global_cap: o.cap ?? null, per_customer_cap: o.perCustomerCap ?? null, requires_customer: o.requiresCustomer ?? false, outlet_ids: [], valid_from: `${o.from}T00:00:00.000Z`, valid_to: null, active: true,
  });
}

// ---- people with logins -----------------------------------------------------------------------------------------

/** Invites a member as the owner. An invited member is active before signing in (a manager the compliance tasks can name). */
export async function invite(c: Ctx, persona: string, name: string, role: "manager" | "staff", outletIds: string[]) {
  const id = c.api.id(`member:${persona}`);
  await c.api.cmd("owner", "/v1/members:invite", "tenancy.member.invite.v1", `invite:${persona}`, {
    member_id: id, name, email: personaEmail(c, persona), role, outlet_ids: outletIds,
  });
  return id;
}

/** Invites a member who then signs in: the invitee's first sign-in (their own persona token, so the world's meta lists it) binds it. */
export async function person(c: Ctx, persona: string, name: string, role: "manager" | "staff", outletIds: string[]) {
  const id = await invite(c, persona, name, role, outletIds);
  await c.api.cmd(persona, "/v1/members:bind", "tenancy.member.bind.v1", `bind:${persona}`, { member_id: id });
  return id;
}

const personaEmail = (c: Ctx, persona: string) => personaIdentity(c.world, persona).email;

// ---- the menu ---------------------------------------------------------------------------------------------------

export interface MenuSpec { key: string; category: string; priceMinor: number; taxClass: string; recipe: Array<[Ingredient, number]>; brand?: string }

/** Items, recipes, and a price for every outlet x channel kind, all valid from `from`. */
export async function menu(c: Ctx, biz: Business, specs: MenuSpec[], kinds: string[], from: string): Promise<Record<string, Item>> {
  const items: Record<string, Item> = {};
  for (const s of specs) {
    const it = await item(c, s.key, { category: s.category, brand: s.brand ?? null });
    items[s.key] = it;
    // A dish with no recipe version is a plant (C5): sold, never costed.
    if (s.recipe.length > 0) await recipe(c, it, from, s.recipe.map(([ing, qtyMilli]) => ({ ing, qtyMilli })));
    for (const o of biz.outlets) for (const kind of kinds) await price(c, it, o.id, kind, s.priceMinor, s.taxClass, from);
  }
  return items;
}

export async function brand(c: Ctx, key: string, name: string, outletIds: string[]): Promise<string> {
  const id = c.api.id(`brand:${key}`);
  await c.api.cmd("owner", "/v1/brands", "tenancy.brand.create.v1", `brand:${key}`, { brand_id: id, name, outlet_ids: outletIds });
  return id;
}

export async function amc(c: Ctx, key: string, assetId: string, vendor: string, validFrom: string, validTo: string, costMinor: number) {
  await c.api.cmd("owner", "/v1/compliance/amcs", "compliance.amc.record.v1", `amc:${key}`, {
    amc_id: c.api.id(`amc:${key}`), asset_id: assetId, vendor, valid_from: validFrom, valid_to: validTo,
    cost: { amount_minor: costMinor, currency: c.s.currency }, document_id: null,
  });
}

export async function repair(c: Ctx, key: string, assetId: string, doneOn: string, costMinor: number, vendor: string) {
  await c.api.cmd("owner", "/v1/compliance/maintenance/record", "compliance.maintenance.record.v1", `repair:${key}`, {
    maintenance_id: c.api.id(`repair:${key}`), asset_id: assetId, kind: "breakdown", done_on: doneOn, cost_minor: costMinor, vendor, amc_id: null, note: "synthetic breakdown call-out",
  });
}

export async function checklist(c: Ctx, key: string, outletId: string, items: string[]) {
  await c.api.cmd("owner", "/v1/compliance/checklists", "compliance.checklist.upsert.v1", `checklist:${key}`, {
    checklist_id: c.api.id(`checklist:${key}`), outlet_id: outletId, name_key: key.replaceAll(/[^a-z0-9]+/g, "_"), kind: "closing", frequency: "daily", due_time: "23:00", items, active: true,
  });
}

export async function checklistRun(c: Ctx, key: string, outletId: string, checklistKey: string, date: string, items: string[]) {
  await c.api.cmd("owner", "/v1/compliance/checklist-runs", "compliance.checklist.complete.v1", `crun:${key}`, {
    run_id: c.api.id(`crun:${key}`), checklist_id: c.api.id(`checklist:${checklistKey}`), outlet_id: outletId, business_date: date,
    results: Object.fromEntries(items.map((i) => [i, true])),
  });
}

/** A blind count: the counted quantity per batch; core computes expected and the count_adjust movements. */
export async function countStock(c: Ctx, key: string, outletId: string, lines: Array<{ ing: Ingredient; batchCode: string | null; countedMilli: number }>) {
  await c.api.cmd("owner", "/v1/inventory/counts", "inventory.count.submit.v1", `count:${key}`, {
    count_id: c.api.id(`count:${key}`), outlet_id: outletId,
    lines: lines.map((l, i) => ({ line_id: c.api.id(`count:${key}:${i}`), ingredient_id: l.ing.id, batch_id: l.batchCode ? c.api.id(`batch:${l.batchCode}`) : null, counted_qty_milli: l.countedMilli, unit: l.ing.unit })),
  });
}

// ---- clean history (the full profile only) -----------------------------------------------------------------------------

export interface HistorySpec {
  /** Baseline statements, one file per weekly cycle, listing the history bills of that outlet and channel (the planted window's own
   *  statements are written by the world). `bills` is the history plan's aggregator bills for a cycle. */
  payouts: Array<{
    layout: Layout; prefix: string; outlet: OutletInfo; commissionBp: number; bills: (from: string, to: string) => Array<{ no: string; date: string; gross: number; tax: number }>;
    /** The operator collects the order's tax and withholds it from the payout (IN aggregators, Sec 9(5): packs/finance.md §2); false where the merchant collects (AU). */
    withholdsTax: boolean;
    /** Cycle numbers (1 = the newest) uploaded but left unapproved: a statement the owner has not approved yet (a missing settlement, F7). */
    hold?: readonly number[];
    /** Extra lines of one cycle (an ad fee inside the cap, F8). */
    extra?: (cycle: number, meta: { from: string; to: string }) => PayoutLine[];
  }>;
  temp?: { outlet: OutletInfo; assetId: string; assetKey: string; milliC: number; hhmm: string };
  /** `monthly`: rent on the 1st of every calendar month from the timeline's first day to 14 days back (the default is every 30 days). */
  rent?: { outlet: OutletInfo; amountMinor: number; monthly?: true };
}

/** Weeks before the 14-day planted window: normal payouts at the contracted rate, in-range temperature readings, rent.
 *  Nothing here is a problem; the window itself is where every planted problem sits. */
export async function history(c: Ctx, spec: HistorySpec): Promise<void> {
  const D = (n: number) => addDays(c.asOf, -n);
  const weeks = Math.floor((c.days - 14) / 7);
  // One statement file per aggregator holding every weekly cycle (each row names its own payout ref): the worker parses a few runs a
  // minute, so the number of files, not their size, is what a seed run waits for.
  for (const p of spec.payouts) {
    const cycles = Array.from({ length: weeks }, (_, i) => {
      const w = i + 1;
      const meta = { ref: `${p.prefix}-H${w}`, outlet: p.outlet.name, from: D(7 * w + 13), to: D(7 * w + 7), paidOn: D(7 * w + 5) };
      const lines: PayoutLine[] = p.bills(meta.from, meta.to).map((b) => ({
        kind: "order", orderRef: b.no, orderDate: b.date, gross: b.gross, commission: Math.round((b.gross * p.commissionBp) / 10000), ad: 0, promo: 0, tax: p.withholdsTax ? b.tax : 0,
      }));
      if (lines.length > 0) lines.push(...(p.extra?.(w, meta) ?? []));
      return { meta, lines, w };
    }).filter((x) => x.lines.length > 0);
    const held = new Set(p.hold ?? []);
    const normal = cycles.filter((x) => !held.has(x.w));
    if (normal.length) importFile(c, `${p.prefix}-history`, "payout_statement", `${p.prefix}-history.csv`, payoutFileMany(p.layout, normal));
    const waiting = cycles.filter((x) => held.has(x.w));
    if (waiting.length) importFile(c, `${p.prefix}-held`, "payout_statement", `${p.prefix}-held.csv`, payoutFileMany(p.layout, waiting), null, { hold: true });
  }
  if (spec.temp) {
    for (let n = c.liveDays; n >= 4; n--) await tempLog(c, `${spec.temp.assetKey}h:${n}`, spec.temp.outlet.id, spec.temp.assetId, spec.temp.milliC, at(D(n), spec.temp.hhmm, spec.temp.outlet.tz));
  }
  if (spec.rent) {
    if (spec.rent.monthly) {
      for (let d = addDays(D(c.days), 0); d <= D(14); d = addDays(d, 1)) {
        if (d.endsWith("-01")) await expense(c, `rent:m${d}`, spec.rent.outlet.id, "rent", d, spec.rent.amountMinor, 0, "Synthetic Landlord LLP");
      }
    } else for (let n = c.days; n >= 14; n -= 30) await expense(c, `rent:h${n}`, spec.rent.outlet.id, "rent", D(n), spec.rent.amountMinor, 0, "Synthetic Landlord LLP");
  }
}

/** A short payout (F3): one order line per planted aggregator bill numbered `prefix…` (dated history), at the bill's own total and tax, charged
 *  `excessMinor` over the contracted commission. Core matches each line to its order (external ref = bill number) and measures the short
 *  against the order total and tax (packs/finance.md §2), so the short is exactly the excess. `withholdsTax` as HistorySpec's. */
export function shortLines(bills: Array<{ no: string; date: string; gross: number; tax: number }>, prefix: string, count: number, contractedBp: number,
  excessMinor: number, withholdsTax: boolean): PayoutLine[] {
  const mine = bills.filter((b) => b.no.startsWith(prefix));
  if (mine.length !== count) throw new Error(`shortLines: ${mine.length} ${prefix} bills, expected ${count}`);
  return mine.map((b) => {
    if ((b.gross * contractedBp) % 10000 !== 0) throw new Error(`shortLines: ${b.no} contracted commission is not whole`);
    return { kind: "order", orderRef: b.no, orderDate: b.date, gross: b.gross, commission: (b.gross * contractedBp) / 10000 + excessMinor, ad: 0, promo: 0, tax: withholdsTax ? b.tax : 0 };
  });
}

// ---- storefront and customers --------------------------------------------------------------------------------------

/** The owner creates a storefront key for the own-site channel; the raw key is returned once and never logged. Seeding a world again finds the
 *  key already made (409) and has no raw key to use: null, and the storefront legs, already in the books, are skipped. */
export async function storefrontKey(c: Ctx, biz: Business): Promise<string | null> {
  try {
    const r = await c.api.post("owner", "/v1/storefront-keys", { key_id: c.api.id("sfkey:1"), channel_id: biz.channels["own_site"], allowed_origins: ["https://order.example.test"] });
    return (r.key as string | undefined) ?? "plan-key";
  } catch (e) {
    if (e instanceof CommandRefused && e.status === 409) return null;
    throw e;
  }
}

/** The storefront refuses while the outlet's calendar is closed at the real now. Hours are 00:00-23:59 (see onboard), so the only closed
 *  minute is 23:59 local: when the outlet says it opens within two minutes, wait for it (a read, never logged, so the request log is the
 *  same at any hour). A longer closure is left to the placement, which refuses with the server's own reason (outlet_paused). */
async function untilOpen(c: Ctx, sfKey: string, outlet: OutletInfo): Promise<void> {
  if (c.api.lenient) return;
  for (let i = 0; i < 150; i++) {
    const st = await c.api.storefrontGet(sfKey, "/v1/storefront/outlets/{outlet_id}/state", { params: { outlet_id: outlet.id } });
    const opensIn = st.next_open ? Date.parse(String(st.next_open)) - Date.parse(String(st.as_of)) : Number.POSITIVE_INFINITY;
    if (st.state !== "closed" || opensIn > 120_000) return;
    await new Promise((ok) => setTimeout(ok, 1000));
  }
}

/** A guest checks out on the public storefront (pay at the counter): guest record + order in one request. */
export async function storefrontOrder(c: Ctx, sfKey: string | null, key: string, biz: Business, outlet: OutletInfo, it: Item, guest: { name: string; phone: string }, coupons: string[] = []) {
  if (sfKey === null) return;
  await untilOpen(c, sfKey, outlet);
  await c.api.storefront(sfKey, "/v1/storefront/orders", {
    order: {
      command_id: c.api.id(`cmd:${key}`), idempotency_key: idemOf(c.seed, c.world, key), type: "orders.place.v1",
      payload: {
        order_id: c.api.id(key), outlet_id: outlet.id, channel_id: biz.channels["own_site"], brand_id: null, device_id: null, kind: "takeaway", table_ref: null,
        pickup_window_id: null, promised_at: null, external_ref: null,
        lines: [{ line_id: c.api.id(`${key}:l0`), item_id: it.id, variant_id: null, option_ids: [], qty_milli: 1000, barcode: null, note: null }],
        coupon_codes: coupons, loyalty_redeem_points: 0, preview_total_minor: null, client_totals: null,
      },
    },
    guest: {
      command_id: c.api.id(`cmd:${key}:guest`), idempotency_key: idemOf(c.seed, c.world, `${key}:guest`), type: "storefront.guest.create.v1",
      payload: { name: guest.name, phone: guest.phone, email: null, consent: { marketing: false, at: at(c.asOf, "00:00", outlet.tz) } },
    },
    contact: null,
  });
}

export async function customer(c: Ctx, key: string, name: string, phone: string, points: number) {
  await c.api.cmd("owner", "/v1/customers:upsert", "customers.customer.upsert.v1", `customer:${key}`, {
    customer_id: c.api.id(`customer:${key}`), name, phone, email: null, withdraw_consent: [],
  });
  if (points) {
    await c.api.cmd("owner", "/v1/loyalty:adjust", "customers.loyalty.adjust.v1", `loyalty:${key}`, { customer_id: c.api.id(`customer:${key}`), points, note: "synthetic welcome points" });
  }
}
