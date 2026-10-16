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
  /** The operator's monthly AI budget rows (R47 D2): `months` rows from the as-of month on, each `limitMinor`. Default one month, 500000. */
  aiBudget?: { limitMinor: number; months: number };
}

/** The pack values a seed run mirrors for the operator-provisioned path, where core's self-serve defaults do not apply (what the packs list; a
 *  mismatch is refused by core: a channel outside the pack's aggregators is `out_of_pack_scope`, a zone outside its timezones likewise). */
const COUNTRY = {
  IN: { tz: "Asia/Kolkata", aggregators: [["swiggy", "Swiggy"], ["zomato", "Zomato"]] },
  AU: { tz: "Australia/Melbourne", aggregators: [["ubereats", "Uber Eats"], ["doordash", "DoorDash"]] },
} as const;
/** The own channels core gives each kind of business (modules/tenancy/defaults.ts). */
const OWN_CHANNELS = {
  restaurant: [["counter", "Counter"], ["table_qr", "Table QR"], ["pickup", "Pickup"], ["own_site", "Own site"]],
  cloud_kitchen: [["pickup", "Pickup"], ["own_site", "Own site"]],
  shop: [["counter", "Counter"], ["pickup", "Pickup"], ["own_site", "Own site"]],
} as const;

/** ON1–ON3. Hard rule 5: every world is a demo tenant (`is_demo`, which drives the "Sample data" badge). Only the operator route can create one
 *  with the owner we need, so with an operator: the operator provisions the tenant with the owner member, the owner binds (their first sign-in),
 *  then creates every outlet, the brand, the channels and the devices, all as the owner (completeOnboarding ends the seed). Without an operator the world is
 *  onboarded self-serve (a real, not-demo tenant) and the CLI says so. */
export async function onboard(c: Ctx, spec: OnboardSpec): Promise<Business> {
  const { api } = c;
  const outlets: OutletInfo[] = [];
  const channels: Record<string, string> = {};
  let defaultTz: string;
  if (api.hasOperator) {
    const country = COUNTRY[spec.country];
    defaultTz = spec.outlet.tz ?? country.tz;
    const tenant = api.id("tenant");
    const ownerMember = api.id("member:owner");
    const idp = personaIdentity(c.world, "owner");
    await api.cmd("operator", "/platform/v1/tenants:provision", "tenancy.provision.v1", "provision", {
      tenant_id: tenant, name: spec.business, country_code: spec.country, is_demo: true, owner: { member_id: ownerMember, name: spec.ownerName, email: idp.email },
    }, { noTenant: true });
    api.tenantId = tenant;
    await api.cmd("owner", "/v1/members:bind", "tenancy.member.bind.v1", "bind:owner", { member_id: ownerMember });
    const all = [{ name: spec.outlet.name, address: spec.outlet.address, kind: spec.kind === "shop" ? "store" : spec.kind, taxIds: spec.outlet.taxIds }, ...(spec.more ?? [])];
    for (const [i, o] of all.entries()) {
      const id = api.id(`outlet:${i + 1}`);
      await api.cmd("owner", "/v1/outlets", "tenancy.outlet.create.v1", `outlet:${i + 1}`, { outlet_id: id, name: o.name, kind: o.kind, tz: defaultTz, address: o.address, tax_ids: o.taxIds });
      outlets.push({ id, name: o.name, tz: defaultTz, device: null });
    }
    await api.cmd("owner", "/v1/brands", "tenancy.brand.create.v1", "brand:1", { brand_id: api.id("brand:1"), name: spec.business, outlet_ids: outlets.map((o) => o.id) });
    const kinds: Array<[string, string]> = [...OWN_CHANNELS[spec.kind].map(([k, n]) => [k, n] as [string, string]),
      ...(spec.kind === "shop" ? [] : country.aggregators.map(([code, n]) => [`aggregator:${code}`, n] as [string, string]))];
    for (const [kind, name] of kinds) {
      const id = api.id(`channel:${kind}`);
      await api.cmd("owner", "/v1/channels", "tenancy.channel.create.v1", `channel:${kind}`, { channel_id: id, name, kind });
      channels[kind] = api.alias(id, `channel:${kind}`);
    }
    for (const [i, o] of outlets.entries()) {
      const id = api.id(`device:${i + 1}`);
      await api.cmd("owner", "/v1/devices", "tenancy.device.register.v1", `device:${i + 1}`, { device_id: id, outlet_id: o.id, kind: "pos", invoice_series: `POS${i + 1}` });
      o.device = api.alias(id, `device:${i + 1}`);
    }
    if (spec.kind !== "shop") {
      await api.cmd("owner", "/v1/devices", "tenancy.device.register.v1", "kds:1", { device_id: api.id("kds:1"), outlet_id: outlets[0]!.id, kind: "kds", invoice_series: null });
    }
    // Onboarding is completed by runWorld once the whole world is built (completeOnboarding): R64 X-2 freezes an onboarded demo
    // business's people, so the demo people are invited before it.
  } else {
    const tenant = api.id("tenant"); // sent for the envelope shape only
    const first = api.id("outlet:1");
    // R1-m6: the payload's tenant_id is ignored; core mints the tenant and returns it as entity_id. Logged under an alias.
    const minted = await api.cmd("owner", "/v1/onboarding", "tenancy.onboard.v1", "onboard", {
      tenant_id: tenant, owner_member_id: api.id("member:owner"), outlet_id: first, owner_name: spec.ownerName, business_name: spec.business,
      kind: spec.kind, country_code: spec.country,
      outlet: { name: spec.outlet.name, address: spec.outlet.address, ...(spec.outlet.tz ? { tz: spec.outlet.tz } : {}), tax_ids: spec.outlet.taxIds },
    }, { noTenant: true });
    api.tenantId = api.alias(String(minted.body.entity_id), "tenant");
    [defaultTz] = ((await api.get("owner", "/v1/outlets")).outlets as J[]).map((o) => o.tz as string) as [string];
    outlets.push({ id: first, name: spec.outlet.name, tz: defaultTz, device: null });
    for (const [i, o] of (spec.more ?? []).entries()) {
      const id = api.id(`outlet:${i + 2}`);
      await api.cmd("owner", "/v1/outlets", "tenancy.outlet.create.v1", `outlet:${i + 2}`, {
        outlet_id: id, name: o.name, kind: o.kind, tz: defaultTz, address: o.address, tax_ids: o.taxIds,
      });
      await api.cmd("owner", "/v1/devices", "tenancy.device.register.v1", `device:${i + 2}`, {
        device_id: api.id(`device:${i + 2}`), outlet_id: id, kind: "pos", invoice_series: `POS${i + 2}`,
      });
      outlets.push({ id, name: o.name, tz: defaultTz, device: api.id(`device:${i + 2}`) });
    }
    for (const ch of (await api.get("owner", "/v1/channels")).channels as J[]) {
      channels[ch.kind as string] = api.alias(ch.id as string, `channel:${ch.kind}`);
    }
    for (const d of (await api.get("owner", "/v1/devices")).devices as J[]) {
      if (d.kind === "pos" && d.outlet_id === first) {
        outlets[0]!.device = api.alias(d.id as string, "device:1");
      } else if (d.kind === "kds") api.alias(d.id as string, `kds:${(d.outlet_id as string).slice(0, 8)}`);
    }
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
    // The draft id is global (platform.config_draft), so it carries the tenant: without it a second business with the same seed
    // and world replays/collides with the first's draft. Logged under an alias because the tenant id is server-minted. A later
    // month's draft also carries its offset (the first keeps the id every world has always used).
    const budget = spec.aiBudget ?? { limitMinor: 500000, months: 1 };
    for (let i = 0; i < budget.months; i++) {
      const suffix = i === 0 ? "" : `:+${i}`;
      const draft = api.alias(api.id(`config_draft:llm_budget:${api.tenantId}${suffix}`), `draft:llm_budget${suffix}`);
      await api.post("operator", "/platform/v1/config-drafts", {
        draft_id: draft, target: `llm_budget:${api.tenantId}`, patch: { month: monthAfter(c.asOf, i), limit_minor: budget.limitMinor, currency },
      }, { noTenant: true });
      await operatorApprove(c, draft);
    }
  }
  return { country: spec.country, currency, outlets, channels };
}

/** Completes an operator-provisioned (demo) business's onboarding: the last command of a seed (run.ts). From here core refuses the
 *  commands that would break the demo for its visitors (member invite, role change, deactivation; storefront key revoke; AI cap). */
export async function completeOnboarding(c: Ctx): Promise<void> {
  if (!c.api.hasOperator) return; // self-serve onboarding is complete from its first command
  await c.api.cmd("owner", "/v1/tenant:update", "tenancy.tenant.update.v1", "onboarding:complete", { complete_onboarding: true });
}

/** The operator approves a draft it proposed (R27: its own command is its approval). Reseeding the same world into the same database
 *  proposes the same draft again (a replay) and core answers its approval 409 `already_decided`: that draft is done when core reads it
 *  back as applied, and anything else still fails the seed. */
export async function operatorApprove(c: Ctx, draft: string): Promise<void> {
  await c.api.post("operator", "/platform/v1/config-drafts/{id}:approve", {}, { params: { id: draft }, noTenant: true, expect: [200, 201, 409] });
  if (c.api.lenient) return;
  const d = await c.api.get("operator", "/platform/v1/config-drafts/{id}", { params: { id: draft } });
  if (d.status !== "applied") throw new Error(`operator draft ${draft} is ${String(d.status)}, not applied`);
}

/** The first day of the month `n` months after `date`'s (YYYY-MM-01). */
export function monthAfter(date: string, n: number): string {
  const m = Number(date.slice(5, 7)) - 1 + n;
  return `${Number(date.slice(0, 4)) + Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, "0")}-01`;
}

// ---- the live AI roles (R59; R47 D1, D2) ------------------------------------------------------------------------

/** R59: the roles a live demo calls — the router, the Manager's `reason`, the watchers' and brief's `narrate`, the extractor. */
export const LIVE_ROLES = ["router", "reason", "narrate", "extract"] as const;

/** R59, as the operator (one approved config draft per role, R24): each live role with no price is priced at 0 per 1M tokens in
 *  and out, in `currency`, on its current provider and model (the free-tier key bills nothing). A role that already carries a price
 *  keeps it — a real price is never overwritten — and is named in `kept`. Idempotent: a reseed into the same database finds the
 *  roles priced and proposes nothing. */
export async function aiRolePrices(c: Ctx, currency: string): Promise<{ priced: string[]; kept: string[] }> {
  const rows = ((await c.api.get("operator", "/platform/v1/model-roles")).items ?? []) as J[];
  const out = { priced: [] as string[], kept: [] as string[] };
  for (const role of LIVE_ROLES) {
    const row = rows.find((r) => r.role === role);
    if (row && row.input_price_per_mtok_minor !== null && row.input_price_per_mtok_minor !== undefined) {
      out.kept.push(`${role} (${String(row.input_price_per_mtok_minor)}/${String(row.output_price_per_mtok_minor)} ${String(row.price_currency)})`);
      continue;
    }
    if (!row && !c.api.lenient) throw new Error(`no platform.model_role row for ${role}`);
    // Platform-wide, so the draft id names the role (no tenant); a reseed never proposes it again (the role is priced by then).
    const draft = c.api.alias(c.api.id(`config_draft:model_role:${role}`), `draft:model_role:${role}`);
    await c.api.post("operator", "/platform/v1/config-drafts", {
      draft_id: draft, target: `model_role:${role}`,
      patch: { provider: row?.provider ?? "gemini", model_id: row?.model_id ?? "plan-model", input_price_per_mtok_minor: 0, output_price_per_mtok_minor: 0, price_currency: currency },
    }, { noTenant: true });
    await operatorApprove(c, draft);
    out.priced.push(role);
  }
  return out;
}

/** What a live AI run of this business needs and lacks (R47 D1, D2): every live role priced in `currency`, and an AI budget row in
 *  `currency` for each of `months` (YYYY-MM-01). Empty = ready. Read back from core, never from what this seed sent. */
export async function aiReadiness(c: Ctx, currency: string, months: string[]): Promise<string[]> {
  const roles = ((await c.api.get("operator", "/platform/v1/model-roles")).items ?? []) as J[];
  const budgets = ((await c.api.get("operator", "/platform/v1/budgets")).items ?? []) as J[];
  const missing: string[] = [];
  for (const role of LIVE_ROLES) {
    const r = roles.find((x) => x.role === role);
    if (!r || r.input_price_per_mtok_minor === null || r.input_price_per_mtok_minor === undefined || r.price_currency !== currency) {
      missing.push(`model_role ${role} has no ${currency} price`);
    }
  }
  for (const m of months) {
    if (!budgets.some((b) => b.tenant_id === c.api.tenantId && b.month === m && b.currency === currency)) missing.push(`no ${currency} AI budget row for ${m}`);
  }
  return missing;
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

export interface Item {
  id: string; key: string; name: string;
  /** Variant key → id, and `<group>:<option>` → option id (only items given variants or option groups). */
  variants?: Record<string, string>; options?: Record<string, string>;
}

/** Owner-entered display text (0029, T-099): synthetic, original names; sent only when given (absent = unchanged). */
export interface Display { name: string; description?: string; diet?: "veg" | "non_veg" | "egg" | "vegan" }

/** A size or other variant (priced on its own) and an option group (price deltas), with the owner's display text. */
export interface VariantSpec { key: string; name: string }
export interface GroupSpec { key: string; name: string; description: string | null; min: number; max: number; options: Array<{ key: string; name: string; deltaMinor: number }> }

export async function item(c: Ctx, key: string, o: { category: string; kind?: "dish" | "sku" | "combo"; stock?: Ingredient; barcode?: string; mrp?: { minor: number; currency: string }; brand?: string | null; display?: Display;
  variants?: VariantSpec[]; groups?: GroupSpec[] }): Promise<Item> {
  const id = c.api.id(`item:${key}`);
  const variants = Object.fromEntries((o.variants ?? []).map((v) => [v.key, c.api.id(`variant:${key}:${v.key}`)]));
  const options = Object.fromEntries((o.groups ?? []).flatMap((g) => g.options.map((x) => [`${g.key}:${x.key}`, c.api.id(`option:${key}:${g.key}:${x.key}`)])));
  await c.api.cmd("owner", "/v1/catalogue/items", "catalogue.item.upsert.v1", `item:${key}`, {
    item_id: id, name_key: key.replaceAll(/[^a-z0-9]+/g, "_"), category: o.category, brand_id: o.brand ?? null, barcode: o.barcode ?? null,
    mrp_minor: o.mrp?.minor ?? null, currency: o.mrp?.currency ?? null, active: true,
    variants: (o.variants ?? []).map((v) => ({ variant_id: variants[v.key], name_key: v.key, barcode: null, active: true, display_name: v.name, description: null })),
    option_groups: (o.groups ?? []).map((g) => ({
      option_group_id: c.api.id(`group:${key}:${g.key}`), name_key: g.key, min_select: g.min, max_select: g.max, required: g.min > 0, display_name: g.name, description: g.description,
      options: g.options.map((x) => ({ option_id: options[`${g.key}:${x.key}`], name_key: x.key, price_delta_minor: x.deltaMinor, currency: c.s.currency, active: true, ingredient_deltas: [], display_name: x.name, description: null })),
    })),
    kind: o.kind ?? "dish", stock_ingredient_id: o.stock?.id ?? null,
    ...(o.display ? { display_name: o.display.name, description: o.display.description ?? null, diet: o.display.diet ?? null } : {}),
  });
  return { id, key, name: key, ...(o.variants?.length ? { variants } : {}), ...(o.groups?.length ? { options } : {}) };
}

/** One price per outlet and channel kind, valid from the start of the timeline; `variant` (a key of the item's variants) prices that variant. */
export async function price(c: Ctx, it: Item, outletId: string, channelKind: string, amountMinor: number, taxClass: string, validFrom: string, o: { validTo?: string; tag?: string; variant?: string } = {}) {
  const key = `price:${it.key}${o.variant ? `:${o.variant}` : ""}:${outletId.slice(0, 8)}:${channelKind}:${o.tag ?? validFrom}`;
  await c.api.cmd("owner", "/v1/catalogue/prices", "catalogue.price.set.v1", key, {
    price_id: c.api.id(key), item_id: it.id, variant_id: o.variant ? it.variants![o.variant]! : null, outlet_id: outletId, channel_kind: channelKind, amount_minor: amountMinor,
    currency: (c.s.currency as string), tax_class: taxClass, valid_from: validFrom, valid_to: o.validTo ?? null,
  });
}

/** The waste allowance a recipe line gets when its world names none (basis points). */
export const RECIPE_WASTE_BP = 200;

export async function recipe(c: Ctx, it: Item, from: string, lines: Array<{ ing: Ingredient; qtyMilli: number; wasteBp?: number }>) {
  const key = `recipe:${it.key}:${from}`;
  await c.api.cmd("owner", "/v1/catalogue/recipes", "catalogue.recipe.version.create.v1", key, {
    recipe_version_id: c.api.id(key), item_id: it.id, variant_id: null, version: 1, valid_from: from, valid_to: null, yield_qty_milli: 1000,
    lines: lines.map((l) => ({ ingredient_id: l.ing.id, qty_milli: l.qtyMilli, unit: l.ing.unit, waste_pct_bp: l.wasteBp ?? RECIPE_WASTE_BP })),
  });
}

// ---- suppliers, purchasing -----------------------------------------------------------------------------------

/** Suppliers are always simulated (hard rule 5): the read model carries the "Simulated supplier" label. `o.cardUrl`: the simulated
 *  agent's card (a request for quotes reaches only suppliers that have one); `o.id` overrides the key's id. */
export async function supplier(c: Ctx, key: string, name: string, paymentDays = 15, prices: Array<{ key: string; ing: Ingredient; priceMinor: number; at: string }> = [],
  o: { cardUrl?: string; id?: string } = {}): Promise<string> {
  const id = o.id ?? c.api.id(`supplier:${key}`);
  await c.api.cmd("owner", "/v1/suppliers", "purchasing.supplier.upsert.v1", `supplier:${key}`, {
    supplier_id: id, name, kind: "simulated", a2a_card_url: o.cardUrl ?? null, terms: { payment_days: paymentDays, notes: "Synthetic, simulated supplier" },
    prices: prices.map((p) => ({
      price_id: c.api.id(`supplier:${key}:price:${p.key}`), ingredient_id: p.ing.id, unit: p.ing.unit, unit_price_minor: p.priceMinor, currency: c.s.currency, observed_at: p.at, source_ref: "Price list (synthetic)",
    })),
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

/** A month's budget for one spending category (finance.budget.set.v1, the owner's own command); `outletId` null = the whole business. */
export async function budget(c: Ctx, key: string, o: { month: string; category: string; amountMinor: number; outletId?: string | null }) {
  await c.api.cmd("owner", "/v1/finance/budgets", "finance.budget.set.v1", `budget:${key}`, {
    budget_id: c.api.id(`budget:${key}`), outlet_id: o.outletId ?? null, category: o.category, period_month: o.month, amount_minor: o.amountMinor,
    currency: c.s.currency,
  });
}

export async function expense(c: Ctx, key: string, outletId: string, category: string, date: string, amountMinor: number, taxMinor: number, payee: string) {
  await c.api.cmd("owner", "/v1/finance/expenses", "finance.expense.record.v1", `exp:${key}`, {
    expense_id: c.api.id(`exp:${key}`), outlet_id: outletId, category, incurred_on: date, amount_minor: amountMinor, tax_minor: taxMinor,
    currency: c.s.currency, payee, note: null, document_id: null,
  });
}

// ---- imports (a file → parsed run → the owner approves the draft; nothing reaches the books before that) ------------

export type ImportKindName = "payout_statement" | "bank_statement" | "pos_export" | "tally_export" | "market_signal" | "pos_bills" | "waste_log" | "shift_log";
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

/** `variant`: a key of the item's variants; `options`: `<group>:<option>` keys of its option groups. */
export interface OrderLine { item: Item; qtyMilli: number; barcode?: string; variant?: string; options?: string[] }

export async function placeOrder(c: Ctx, key: string, biz: Business, outlet: OutletInfo, channelKind: string, kind: "dine_in" | "takeaway" | "pickup" | "delivery", lines: OrderLine[],
  o: { externalRef?: string; coupons?: string[]; persona?: string; table?: string; expect?: number[]; brand?: string | null; refusedWith?: string } = {}) {
  const aggregator = channelKind.startsWith("aggregator:");
  return c.api.cmd(o.persona ?? "owner", "/v1/orders", "orders.place.v1", key, {
    order_id: c.api.id(key), outlet_id: outlet.id, channel_id: biz.channels[channelKind], brand_id: o.brand ?? null,
    device_id: channelKind === "counter" ? outlet.device : null, kind, table_ref: o.table ?? null, pickup_window_id: null, promised_at: null,
    external_ref: aggregator ? (o.externalRef ?? key) : null,
    lines: lines.map((l, i) => ({
      line_id: c.api.id(`${key}:l${i}`), item_id: l.item.id, variant_id: l.variant ? l.item.variants![l.variant]! : null, option_ids: (l.options ?? []).map((x) => l.item.options![x]!),
      qty_milli: l.qtyMilli, barcode: l.barcode ?? null, note: null,
    })),
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

/** UPI for what the order still owes (core's own remaining_minor, read back; in plan mode the read is a placeholder). */
export async function tenderUpiFull(c: Ctx, key: string, orderKey: string, persona = "owner") {
  const order = await c.api.get(persona, "/v1/orders/{id}", { params: { id: c.api.id(orderKey) } });
  await tenderUpi(c, key, orderKey, order.remaining_minor as number, persona);
}

export async function shiftOpen(c: Ctx, key: string, outlet: OutletInfo, floatMinor: number, persona = "owner") {
  await c.api.cmd(persona, "/v1/shifts", "orders.shift.open.v1", key, { shift_id: c.api.id(key), outlet_id: outlet.id, device_id: outlet.device, float_minor: floatMinor, currency: c.s.currency });
}

export async function shiftClose(c: Ctx, key: string, countedMinor: number, persona = "owner") {
  await c.api.cmd(persona, "/v1/shifts/{id}:close", "orders.shift.close.v1", `${key}:close`, { shift_id: c.api.id(key), counted_cash_minor: countedMinor }, { params: { id: c.api.id(key) } });
}

/** `to`: the last valid date (valid_to is the next midnight, UTC as `from` is). */
export async function coupon(c: Ctx, key: string, code: string, o: { bp: number; from: string; cap?: number | null; perCustomerCap?: number; requiresCustomer?: boolean; minSpendMinor?: number; outletIds?: string[]; to?: string }) {
  await c.api.cmd("owner", "/v1/catalogue/coupons", "catalogue.coupon.set.v1", `coupon:${key}`, {
    coupon_id: c.api.id(`coupon:${key}`), code, kind: "percent", value_bp: o.bp, value_minor: null, currency: c.s.currency, min_spend_minor: o.minSpendMinor ?? 0,
    global_cap: o.cap ?? null, per_customer_cap: o.perCustomerCap ?? null, requires_customer: o.requiresCustomer ?? false, outlet_ids: o.outletIds ?? [], valid_from: `${o.from}T00:00:00.000Z`,
    valid_to: o.to ? `${addDays(o.to, 1)}T00:00:00.000Z` : null, active: true,
  });
}

/** A percent-off deal on some items, in weekly outlet-local windows, at every outlet. */
export async function deal(c: Ctx, key: string, o: { bp: number; itemIds: string[]; windows: Array<{ days: number[]; from: string; to: string }>; from: string }) {
  await c.api.cmd("owner", "/v1/catalogue/deals", "catalogue.deal.upsert.v1", `deal:${key}`, {
    deal_id: c.api.id(`deal:${key}`), name_key: `deal.${key}`, rule: { kind: "percent_off", bp: o.bp, item_ids: o.itemIds }, windows: o.windows, outlet_ids: [],
    valid_from: o.from, valid_to: null, active: true,
  });
}

/** Sold out (false) or back on sale at one outlet. */
export async function availability(c: Ctx, it: Item, outletId: string, available: boolean) {
  await c.api.cmd("owner", "/v1/catalogue/availability", "catalogue.availability.set.v1", `avail:${it.key}:${outletId.slice(0, 8)}:${available}`, {
    outlet_id: outletId, item_id: it.id, variant_id: null, available,
  });
}

/** An item's expected prep time at a kitchen station (which station its tickets go to). */
export async function prepTime(c: Ctx, it: Item, outletId: string, station: string, prepSec: number, validFrom: string) {
  await c.api.cmd("owner", "/v1/kitchen/prep-times", "kitchen.prep_time.set.v1", `prep:${it.key}:${outletId.slice(0, 8)}:${validFrom}`, {
    outlet_id: outletId, item_id: it.id, station, prep_sec: prepSec, valid_from: validFrom,
  });
}

/** Pickup slots for one outlet-local business date. */
export async function pickupWindows(c: Ctx, key: string, outletId: string, date: string, from: string, to: string, slotMinutes: number, capacity: number) {
  await c.api.cmd("owner", "/v1/pickup-windows", "orders.pickup_window.generate.v1", `windows:${key}`, {
    outlet_id: outletId, business_date: date, from_local: from, to_local: to, slot_minutes: slotMinutes, capacity_orders: capacity,
  });
}

/** Outlet settings the owner changes after onboarding (phone, accepting-orders state …): `patch` is tenancy.outlet.update.v1's fields. */
export async function outletSettings(c: Ctx, key: string, outlet: OutletInfo, patch: J) {
  await c.api.cmd("owner", "/v1/outlets/{id}:update", "tenancy.outlet.update.v1", `settings:${key}`, { outlet_id: outlet.id, ...patch }, { params: { id: outlet.id } });
}

/** Moves an outlet's live kitchen tickets on, as `persona` at the KDS: `moves[i]` is the status path of the i-th ticket in ticket order (e.g.
 *  ["preparing", "ready"]). Ticket ids are server-minted (aliased in the request log); plan mode has no board, so nothing moves there. */
export async function advanceTickets(c: Ctx, key: string, outlet: OutletInfo, persona: string, moves: string[][]) {
  if (c.api.lenient) return;
  const board = await c.api.get(persona, "/v1/kitchen/board", { query: { outlet: outlet.id } });
  const tickets = ((board.tickets as J[]) ?? []).filter((t) => t.status === "queued").sort((x, y) => (x.ticket_no as number) - (y.ticket_no as number) || String(x.station).localeCompare(String(y.station)));
  for (const [i, path] of moves.entries()) {
    const t = tickets[i];
    if (!t) throw new Error(`advanceTickets ${key}: only ${tickets.length} queued ticket(s)`);
    const id = c.api.alias(t.ticket_id as string, `ticket:${key}:${i}`);
    let from = "queued";
    for (const to of path) {
      await c.api.cmd(persona, "/v1/kitchen/tickets/{id}:advance", "kitchen.ticket.advance.v1", `advance:${key}:${i}:${to}`, { ticket_id: id, from_status: from, to_status: to }, { params: { id } });
      from = to;
    }
  }
}

export async function device(c: Ctx, key: string, outletId: string, kind: "pos" | "kds", series: string | null = null) {
  await c.api.cmd("owner", "/v1/devices", "tenancy.device.register.v1", key, { device_id: c.api.id(key), outlet_id: outletId, kind, invoice_series: series });
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

export interface MenuSpec { key: string; category: string; priceMinor: number; taxClass: string; recipe: Array<[Ingredient, number]>; brand?: string; display?: Display }

/** Items, recipes, and a price for every outlet x channel kind, all valid from `from`. */
export async function menu(c: Ctx, biz: Business, specs: MenuSpec[], kinds: string[], from: string): Promise<Record<string, Item>> {
  const items: Record<string, Item> = {};
  for (const s of specs) {
    const it = await item(c, s.key, { category: s.category, brand: s.brand ?? null, ...(s.display ? { display: s.display } : {}) });
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
export async function storefrontKey(c: Ctx, biz: Business, origins = ["https://order.example.test"]): Promise<string | null> {
  try {
    const r = await c.api.post("owner", "/v1/storefront-keys", { key_id: c.api.id("sfkey:1"), channel_id: biz.channels["own_site"], allowed_origins: origins });
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

// ---- Munim Cares (ADR-015; R46/R48) -----------------------------------------------------------------------------

/** An operator-proposed, operator-approved platform config draft (R24). The draft id is global, so it carries the tenant (as the AI budget's does);
 *  it is logged under an alias because the tenant id is server-minted. */
export async function platformDraft(c: Ctx, key: string, target: string, patch: J): Promise<void> {
  const draft = c.api.alias(c.api.id(`config_draft:${key}:${c.api.tenantId}`), `draft:${key}`);
  await c.api.post("operator", "/platform/v1/config-drafts", { draft_id: draft, target, patch }, { noTenant: true });
  await operatorApprove(c, draft);
}

/** `id`: a fixed recipient id (default: from the seed); `from`/`to`: receiving hours (default 09:00-19:00). */
export interface CaresRecipient { key: string; name: string; kind: "ngo" | "food_bank"; cooked: boolean; raw: boolean; packaged: boolean; kg: number; portions: number; lat: number; lng: number;
  id?: string; from?: string; to?: string }

/** The operator side: one city, simulated recipients (every name says so), and this tenant's enablement. Each is an approved config draft. */
export async function caresOperator(c: Ctx, city: { code: string; country: string; name: string }, recipients: CaresRecipient[]): Promise<Record<string, string>> {
  await platformDraft(c, "cares_city", `cares_city:${city.code}`, { country_code: city.country, name: city.name, status: "active" });
  const ids: Record<string, string> = {};
  for (const r of recipients) {
    const id = (ids[r.key] = r.id ?? c.api.id(`cares:recipient:${r.key}`));
    await platformDraft(c, `cares_recipient:${r.key}`, `cares_recipient:${id}`, {
      city_code: city.code, name: r.name, kind: r.kind, accepts_cooked: r.cooked, accepts_raw: r.raw, accepts_packaged: r.packaged,
      capacity_kg_per_day: r.kg, capacity_portions_per_day: r.portions, receiving_from: r.from ?? "09:00", receiving_to: r.to ?? "19:00", lat_e6: r.lat, lng_e6: r.lng, status: "active",
    });
  }
  await platformDraft(c, "cares_enablement", `cares_enablement:${c.api.tenantId}`, { enabled: true });
  return ids;
}

/** The owner enrols outlets in Cares (their own command). */
export async function caresProfile(c: Ctx, publicName: string, b2b: boolean, outlets: Array<{ outlet: OutletInfo; city: string; lat: number; lng: number; from: string; to: string }>) {
  await c.api.cmd("owner", "/v1/cares/profile", "cares.profile.set.v1", "cares:profile", {
    status: "active", public_name: publicName, b2b_enabled: b2b,
    outlets: outlets.map((o) => ({ outlet_id: o.outlet.id, city_code: o.city, lat_e6: o.lat, lng_e6: o.lng, pickup_from: o.from, pickup_to: o.to, active: true })),
  });
}

export interface CaresLine { key: string; ing: Ingredient; batch: string; qtyMilli: number; expires: string; priceMinor?: number }

/** The owner publishes a raw-food listing (a donation to a simulated recipient, or a priced offer to other businesses). Returns the listing id and each line's id. */
export async function caresListing(c: Ctx, key: string, outlet: OutletInfo, o: { recipient?: string; pickupFrom: string; pickupTo: string; lines: CaresLine[] }) {
  const id = c.api.id(`cares:listing:${key}`);
  const offer = o.recipient === undefined;
  await c.api.cmd("owner", "/v1/cares/listings", "cares.listing.publish.v1", `cares:listing:${key}`, {
    listing_id: id, outlet_id: outlet.id, kind: offer ? "offer" : "donation", recipient_id: o.recipient ?? null, pickup_from: o.pickupFrom, pickup_to: o.pickupTo,
    lines: o.lines.map((l) => ({
      line_id: c.api.id(`cares:line:${key}:${l.key}`), food_kind: "raw", item_id: null, ingredient_id: l.ing.id, batch_id: c.api.id(`batch:${l.batch}`), qty_milli: l.qtyMilli,
      unit: l.ing.unit, expires_on: l.expires, unit_price_minor: l.priceMinor ?? null, currency: offer ? c.s.currency : null,
    })),
  });
  return { id, lineIds: o.lines.map((l) => c.api.id(`cares:line:${key}:${l.key}`)) };
}

/** The owner records the hand-over of every line of a donation, in full (core stamps the time). */
export async function caresHandover(c: Ctx, key: string, listingId: string, lines: Array<{ lineId: string; qtyMilli: number }>) {
  await c.api.cmd("owner", "/v1/cares/handovers", "cares.handover.record.v1", `cares:handover:${key}`, {
    handover_id: c.api.id(`cares:handover:${key}`), listing_id: listingId, allocation_id: null, lines: lines.map((l) => ({ listing_line_id: l.lineId, qty_milli: l.qtyMilli })),
  });
}

/** The operator mints the network impact total over [from, to] and publishes it by an approved draft (R24): nothing is public before that. */
export async function caresNetworkImpact(c: Ctx, from: string, to: string): Promise<string> {
  const s = await c.api.post("operator", "/platform/v1/network-snapshots", { template_id: "platform.cares_network_impact", params: { from, to, city_code: null } }, { noTenant: true });
  const id = c.api.alias(String(s.snapshot_id ?? c.api.id("cares:snapshot")), "cares_network_snapshot");
  await platformDraft(c, "cares_public_impact", `cares_public_impact:${id}`, {});
  return id;
}
