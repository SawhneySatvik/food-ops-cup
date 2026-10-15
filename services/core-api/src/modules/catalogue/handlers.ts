// Catalogue command handlers (02-schema §2.3). Each is bound to one seeded command type and writes only that
// command's target_tables (0007/0014): the book guard admits the write as the member's own command or as an
// approved draft (app.decision_id). The authority row is also checked here first so a refusal is a clean 403,
// and because `catalogue.availability.set.v1` writes an operational table the guard does not watch.
//
// Validity (prices, recipe versions): a new row whose start falls inside the open-ended row of the same key
// (there is at most one) closes that row at its start — the next price / version takes over, so a price draft
// starting tomorrow can execute. Any other overlap is refused by the exclusion constraint (23P01 → 409 on the
// member route; a draft becomes `failed` with sqlstate_23p01). Adjacent rows ([a, b) then [b, …)) are fine.
// Upserts are additive: children not named in the payload are left as they are (switch them off with
// `active: false`); identity fields the schema grants no UPDATE on (item kind, deal kind/start, coupon terms)
// must match the stored row, else 409.
// Display order (0030, T-115): a named variant's, option group's or option's position is its index in the payload's
// array (so resending the full list reorders it; a partial list moves the children it names to the front). A new
// item takes the tenant's next position, once, on INSERT (the order the owner added items); no field changes it.
import type { CommandEnvelope } from "@munim/contracts";
import {
  CatalogueAvailabilitySetV1, CatalogueCouponSetV1, CatalogueDealEndV1, CatalogueDealUpsertV1, CatalogueItemUpsertV1,
  CataloguePriceSetV1, CatalogueRecipeVersionCreateV1,
} from "@munim/contracts/catalogue";
import { evaluateAuthority } from "@munim/core-domain/authority";
import { validateRecipe } from "@munim/core-domain/inventory";
import { orderTax } from "@munim/core-domain/packs";
import { businessDate } from "@munim/core-domain/tz";
import { type AuditEntry, type CommandHandler, type HandlerOutput, uuidv7 } from "../../commit/index.ts";
import { ApiError } from "../../lib/errors.ts";
import type { Queryable } from "../../runtoken/index.ts";
import { tenantPack } from "./pricing.ts";

type Ctx = { role: string; member_id: string; outlets: string[]; decision: string | null; currency: string };

/** The transaction's own identity (set by withContext / approvals), checked against core.command_authority. */
async function authorize(c: Queryable, type: string, target_outlet: string | null = null): Promise<Ctx> {
  const s = (await c.query<{ role: string | null; member: string | null; outlets: string | null; decision: string | null; currency: string | null }>(
    `SELECT nullif(current_setting('app.role', true), '') AS role, nullif(current_setting('app.member_id', true), '') AS member,
            nullif(current_setting('app.outlet_ids', true), '') AS outlets, nullif(current_setting('app.decision_id', true), '') AS decision,
            (SELECT base_currency FROM core.tenant WHERE tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) AS currency`)).rows[0]!;
  const rows = (await c.query<{ command_type: string; allowed_roles: string[]; scope: string; max_amount_minor: string | null }>(
    `SELECT command_type, allowed_roles, scope, max_amount_minor FROM core.command_authority WHERE command_type = $1`, [type])).rows
    .map((r) => ({ ...r, max_amount_minor: r.max_amount_minor === null ? null : Number(r.max_amount_minor) }));
  const outlets = s.outlets ? s.outlets.replace(/^\{|\}$/g, "").split(",").filter(Boolean) : [];
  const verdict = evaluateAuthority({ command_type: type, role: s.role ?? "", outlet_scope: outlets, target_outlet_id: target_outlet }, rows);
  if (!verdict.allow || !s.member || !s.currency) throw new ApiError("forbidden", "authority_denied");
  return { role: s.role!, member_id: s.member, outlets, decision: s.decision, currency: s.currency };
}

const parse = <T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, cmd: CommandEnvelope): T => {
  const r = schema.safeParse(cmd.payload);
  if (!r.success) throw new ApiError("invalid_payload");
  return r.data;
};

const one = async <R>(c: Queryable, sql: string, params: unknown[]): Promise<R | undefined> => (await c.query(sql, params)).rows[0] as R | undefined;

type Shown = { display_name?: string | null | undefined; description?: string | null | undefined; diet?: string | null | undefined };
/** 0029 display text (G-01): the fields the payload names, as `, col = $n` for an UPDATE whose params are `args` (absent
 *  keeps the stored value; null clears it), and as INSERT columns + values (absent = NULL). */
function shown(o: Shown, args: unknown[]): { set: string; cols: string; vals: string } {
  const named = (["display_name", "description", "diet"] as const).filter((k) => o[k] !== undefined);
  const at = named.map((k) => (args.push(o[k]), `$${args.length}`));
  return { set: named.map((k, i) => `, ${k} = ${at[i]}`).join(""), cols: named.map((k) => `, ${k}`).join(""), vals: at.map((v) => `, ${v}`).join("") };
}

/** Checks a variant belongs to the item (and the item exists). */
async function itemAndVariant(c: Queryable, item_id: string, variant_id: string | null): Promise<{ kind: string; mrp_minor: number | null }> {
  const item = await one<{ kind: string; mrp_minor: string | null }>(c, `SELECT kind, mrp_minor FROM core.item WHERE id = $1`, [item_id]);
  if (!item) throw new ApiError("not_found");
  if (variant_id !== null && !(await one(c, `SELECT 1 FROM core.variant WHERE id = $1 AND item_id = $2`, [variant_id, item_id]))) throw new ApiError("not_found");
  return { kind: item.kind, mrp_minor: item.mrp_minor === null ? null : Number(item.mrp_minor) };
}

/** Unit check (W1 fix #50): every line's unit is its ingredient's base unit. */
async function unitsOk(c: Queryable, lines: ReadonlyArray<{ ingredient_id: string; unit: string }>) {
  if (lines.length === 0) return;
  const ingredients = (await c.query<{ ingredient_id: string; base_unit: string }>(
    `SELECT id AS ingredient_id, base_unit FROM core.ingredient WHERE id = ANY($1::uuid[])`, [lines.map((l) => l.ingredient_id)])).rows;
  const v = validateRecipe({ lines }, ingredients);
  if (!v.ok) throw new ApiError("bad_request", v.reason_code);
}

/** Closes the key's open-ended row that starts before `from` at `from` (the take-over); returns its audit entry. */
async function takeOver(c: Queryable, table: "price" | "recipe_version", keyWhere: string, params: unknown[], from: string): Promise<AuditEntry[]> {
  const fromParam = `$${params.length + 1}`;
  const r = await c.query<{ id: string }>(
    `UPDATE core.${table} SET valid_to = ${fromParam}::date WHERE ${keyWhere} AND valid_to IS NULL AND valid_from < ${fromParam}::date RETURNING id`, [...params, from]);
  return r.rows.map((x) => ({ entity: `core.${table}`, entityId: x.id, before: { valid_to: null }, after: { valid_to: from } }));
}

/** The outlet's business date now (draft prices start after it — catalogue pack: never back-dated). */
async function outletToday(c: Queryable, outlet_id: string): Promise<string> {
  const o = await one<{ tz: string; cutoff: string }>(c, `SELECT tz, business_day_cutoff::text AS cutoff FROM core.outlet WHERE id = $1`, [outlet_id]);
  if (!o) throw new ApiError("not_found");
  return businessDate(new Date(), o.tz, o.cutoff.slice(0, 5));
}

export const priceSet: CommandHandler = {
  type: "catalogue.price.set.v1",
  async run(c, cmd): Promise<HandlerOutput> {
    const p = parse(CataloguePriceSetV1, cmd);
    const ctx = await authorize(c, "catalogue.price.set.v1", p.outlet_id);
    if (p.currency !== ctx.currency) throw new ApiError("currency_mismatch");
    if (p.valid_to !== null && p.valid_to <= p.valid_from) throw new ApiError("bad_request");
    const item = await itemAndVariant(c, p.item_id, p.variant_id);
    const today = await outletToday(c, p.outlet_id);
    if (ctx.decision !== null && p.valid_from <= today) throw new ApiError("conflict");
    // The pack must know the tax class and channel, and (where it has the rule) the price may not exceed the MRP.
    const pack = await tenantPack(c);
    const check = orderTax(pack, { channel_kind: p.channel_kind, lines: [{ name: p.item_id, qty_milli: 1000, unit_price_minor: p.amount_minor, tax_class: p.tax_class, mrp_minor: item.mrp_minor }] });
    if (!check.ok) throw new ApiError(check.refusal.reason_code === "price_above_mrp" ? "conflict" : "bad_request", check.refusal.reason_code);

    const closed = await takeOver(c, "price", `item_id = $1 AND variant_id IS NOT DISTINCT FROM $2 AND outlet_id = $3 AND channel_kind = $4`,
      [p.item_id, p.variant_id, p.outlet_id, p.channel_kind], p.valid_from);
    await c.query(
      `INSERT INTO core.price (tenant_id, id, item_id, variant_id, outlet_id, channel_kind, amount_minor, currency, tax_class, valid_from, valid_to)
       VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [p.price_id, p.item_id, p.variant_id, p.outlet_id, p.channel_kind, p.amount_minor, p.currency, p.tax_class, p.valid_from, p.valid_to]);
    return { entityId: p.price_id, audit: [...closed, { entity: "core.price", entityId: p.price_id, after: p }] };
  },
};

export const recipeVersionCreate: CommandHandler = {
  type: "catalogue.recipe.version.create.v1",
  async run(c, cmd): Promise<HandlerOutput> {
    const p = parse(CatalogueRecipeVersionCreateV1, cmd);
    await authorize(c, "catalogue.recipe.version.create.v1");
    if (p.valid_to !== null && p.valid_to <= p.valid_from) throw new ApiError("bad_request");
    await itemAndVariant(c, p.item_id, p.variant_id);
    await unitsOk(c, p.lines);
    const last = await one<{ v: number | null }>(c, `SELECT max(version) AS v FROM core.recipe_version WHERE item_id = $1 AND variant_id IS NOT DISTINCT FROM $2`, [p.item_id, p.variant_id]);
    if (p.version !== (last?.v ?? 0) + 1) throw new ApiError("conflict");
    const closed = await takeOver(c, "recipe_version", `item_id = $1 AND variant_id IS NOT DISTINCT FROM $2`, [p.item_id, p.variant_id], p.valid_from);
    await c.query(
      `INSERT INTO core.recipe_version (tenant_id, id, item_id, variant_id, version, valid_from, valid_to, yield_qty_milli)
       VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, $7)`,
      [p.recipe_version_id, p.item_id, p.variant_id, p.version, p.valid_from, p.valid_to, p.yield_qty_milli]);
    for (const l of p.lines) {
      await c.query(
        `INSERT INTO core.recipe_line (tenant_id, id, recipe_version_id, ingredient_id, qty_milli, unit, waste_pct_bp)
         VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6)`,
        [uuidv7(), p.recipe_version_id, l.ingredient_id, l.qty_milli, l.unit, l.waste_pct_bp]);
    }
    return { entityId: p.recipe_version_id, audit: [...closed, { entity: "core.recipe_version", entityId: p.recipe_version_id, after: p }] };
  },
};

export const itemUpsert: CommandHandler = {
  type: "catalogue.item.upsert.v1",
  async run(c, cmd): Promise<HandlerOutput> {
    const p = parse(CatalogueItemUpsertV1, cmd);
    const ctx = await authorize(c, "catalogue.item.upsert.v1");
    const options = p.option_groups.flatMap((g) => g.options);
    if ((p.currency !== null && p.currency !== ctx.currency) || options.some((o) => o.currency !== ctx.currency)) throw new ApiError("currency_mismatch");
    if (p.stock_ingredient_id !== null && !(await one(c, `SELECT 1 FROM core.ingredient WHERE id = $1`, [p.stock_ingredient_id]))) throw new ApiError("bad_request");
    await unitsOk(c, options.flatMap((o) => o.ingredient_deltas));
    const audit: AuditEntry[] = [];
    const T = `current_setting('app.tenant_id')::uuid`;

    const { variants, option_groups, ...item } = p;
    const had = await one<{ kind: string }>(c, `SELECT kind FROM core.item WHERE id = $1`, [p.item_id]);
    if (had && had.kind !== p.kind) throw new ApiError("conflict");
    let position: number | null = null;
    const itemCols = [p.name_key, p.category, p.brand_id, p.barcode, p.stock_ingredient_id, p.active, p.mrp_minor, p.currency];
    if (had) {
      const args: unknown[] = [p.item_id, ...itemCols];
      const x = shown(p, args);
      await c.query(`UPDATE core.item SET name_key = $2, category = $3, brand_id = $4, barcode = $5, stock_ingredient_id = $6, active = $7, mrp_minor = $8, currency = $9${x.set} WHERE id = $1`, args);
    } else {
      const args: unknown[] = [p.item_id, ...itemCols, p.kind];
      const x = shown(p, args);
      position = (await c.query<{ position: number }>(
        `INSERT INTO core.item (tenant_id, id, name_key, category, brand_id, barcode, stock_ingredient_id, active, mrp_minor, currency, kind, position${x.cols})
         VALUES (${T}, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, (SELECT coalesce(max(position) + 1, 0) FROM core.item)${x.vals}) RETURNING position`, args)).rows[0]!.position;
    }
    audit.push({ entity: "core.item", entityId: p.item_id, after: position === null ? item : { ...item, position } });

    // A child that exists under another parent is a conflict, never a silent move.
    const child = async (table: string, id: string, parentCol: string, parent: string) => {
      const r = await one<{ parent: string }>(c, `SELECT ${parentCol}::text AS parent FROM core.${table} WHERE id = $1`, [id]);
      if (r && r.parent !== parent) throw new ApiError("conflict");
      return r !== undefined;
    };
    for (const [vi, v] of variants.entries()) {
      if (await child("variant", v.variant_id, "item_id", p.item_id)) {
        const args: unknown[] = [v.variant_id, v.name_key, v.barcode, v.active, vi];
        await c.query(`UPDATE core.variant SET name_key = $2, barcode = $3, active = $4, position = $5${shown(v, args).set} WHERE id = $1`, args);
      } else {
        const args: unknown[] = [v.variant_id, p.item_id, v.name_key, v.barcode, v.active, vi];
        const x = shown(v, args);
        await c.query(`INSERT INTO core.variant (tenant_id, id, item_id, name_key, barcode, active, position${x.cols}) VALUES (${T}, $1, $2, $3, $4, $5, $6${x.vals})`, args);
      }
      audit.push({ entity: "core.variant", entityId: v.variant_id, after: { ...v, position: vi } });
    }
    for (const [gi, g] of option_groups.entries()) {
      const groupCols = [g.name_key, g.min_select, g.max_select, g.required, gi];
      if (await child("option_group", g.option_group_id, "item_id", p.item_id)) {
        const args: unknown[] = [g.option_group_id, ...groupCols];
        await c.query(`UPDATE core.option_group SET name_key = $2, min_select = $3, max_select = $4, required = $5, position = $6${shown(g, args).set} WHERE id = $1`, args);
      } else {
        const args: unknown[] = [g.option_group_id, p.item_id, ...groupCols];
        const x = shown(g, args);
        await c.query(`INSERT INTO core.option_group (tenant_id, id, item_id, name_key, min_select, max_select, required, position${x.cols}) VALUES (${T}, $1, $2, $3, $4, $5, $6, $7${x.vals})`, args);
      }
      const { options: opts, ...group } = g;
      audit.push({ entity: "core.option_group", entityId: g.option_group_id, after: { ...group, position: gi } });
      for (const [oi, o] of opts.entries()) {
        if (await child("option", o.option_id, "option_group_id", g.option_group_id)) {
          const args: unknown[] = [o.option_id, o.name_key, o.price_delta_minor, o.active, oi];
          await c.query(`UPDATE core.option SET name_key = $2, price_delta_minor = $3, active = $4, position = $5${shown(o, args).set} WHERE id = $1`, args);
        } else {
          const args: unknown[] = [o.option_id, g.option_group_id, o.name_key, o.price_delta_minor, o.currency, o.active, oi];
          const x = shown(o, args);
          await c.query(`INSERT INTO core.option (tenant_id, id, option_group_id, name_key, price_delta_minor, currency, active, position${x.cols}) VALUES (${T}, $1, $2, $3, $4, $5, $6, $7${x.vals})`, args);
        }
        const { ingredient_deltas, ...option } = o;
        audit.push({ entity: "core.option", entityId: o.option_id, after: { ...option, position: oi } });
        for (const d of ingredient_deltas) {
          const prev = await one<{ option_id: string; ingredient_id: string }>(c, `SELECT option_id, ingredient_id FROM core.option_ingredient_delta WHERE id = $1`, [d.delta_id]);
          if (prev && (prev.option_id !== o.option_id || prev.ingredient_id !== d.ingredient_id)) throw new ApiError("conflict");
          if (prev) {
            await c.query(`UPDATE core.option_ingredient_delta SET qty_milli = $2, unit = $3, waste_pct_bp = $4 WHERE id = $1`, [d.delta_id, d.qty_milli, d.unit, d.waste_pct_bp]);
          } else {
            await c.query(`INSERT INTO core.option_ingredient_delta (tenant_id, id, option_id, ingredient_id, qty_milli, unit, waste_pct_bp) VALUES (${T}, $1, $2, $3, $4, $5, $6)`,
              [d.delta_id, o.option_id, d.ingredient_id, d.qty_milli, d.unit, d.waste_pct_bp]);
          }
          audit.push({ entity: "core.option_ingredient_delta", entityId: d.delta_id, after: d });
        }
      }
    }
    return { entityId: p.item_id, audit };
  },
};

export const dealUpsert: CommandHandler = {
  type: "catalogue.deal.upsert.v1",
  async run(c, cmd): Promise<HandlerOutput> {
    const p = parse(CatalogueDealUpsertV1, cmd);
    await authorize(c, "catalogue.deal.upsert.v1");
    if (p.valid_to !== null && p.valid_to <= p.valid_from) throw new ApiError("bad_request");
    const items = new Set(p.rule.item_ids);
    const found = await one<{ items: string; outlets: string }>(c,
      `SELECT (SELECT count(*) FROM core.item WHERE id = ANY($1::uuid[])) AS items, (SELECT count(*) FROM core.outlet WHERE id = ANY($2::uuid[])) AS outlets`,
      [[...items], p.outlet_ids]);
    if (Number(found!.items) !== items.size || Number(found!.outlets) !== new Set(p.outlet_ids).size) throw new ApiError("bad_request");
    const had = await one<{ kind: string; name_key: string; valid_from: string }>(c, `SELECT kind, name_key, valid_from::text FROM core.deal WHERE id = $1`, [p.deal_id]);
    if (had) {
      if (had.kind !== p.rule.kind || had.name_key !== p.name_key || had.valid_from !== p.valid_from) throw new ApiError("conflict");
      await c.query(`UPDATE core.deal SET rule = $2, windows = $3, outlet_ids = $4, valid_to = $5, active = $6 WHERE id = $1`,
        [p.deal_id, p.rule, JSON.stringify(p.windows), p.outlet_ids, p.valid_to, p.active]);
    } else {
      await c.query(`INSERT INTO core.deal (tenant_id, id, kind, name_key, rule, windows, outlet_ids, valid_from, valid_to, active)
                     VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [p.deal_id, p.rule.kind, p.name_key, p.rule, JSON.stringify(p.windows), p.outlet_ids, p.valid_from, p.valid_to, p.active]);
    }
    return { entityId: p.deal_id, audit: [{ entity: "core.deal", entityId: p.deal_id, after: p }] };
  },
};

export const dealEnd: CommandHandler = {
  type: "catalogue.deal.end.v1",
  async run(c, cmd): Promise<HandlerOutput> {
    const p = parse(CatalogueDealEndV1, cmd);
    await authorize(c, "catalogue.deal.end.v1");
    const d = await one<{ valid_from: string; valid_to: string | null; active: boolean }>(c, `SELECT valid_from::text, valid_to::text, active FROM core.deal WHERE id = $1`, [p.deal_id]);
    if (!d) throw new ApiError("not_found");
    if (d.valid_to !== null && p.valid_to >= d.valid_to) throw new ApiError("conflict"); // ending never extends a deal
    const before = { valid_to: d.valid_to, active: d.active };
    // A deal that has not started by the new end is switched off (valid_to must stay after valid_from).
    const after = p.valid_to <= d.valid_from ? { valid_to: d.valid_to, active: false } : { valid_to: p.valid_to, active: d.active };
    await c.query(`UPDATE core.deal SET valid_to = $2, active = $3 WHERE id = $1`, [p.deal_id, after.valid_to, after.active]);
    return { entityId: p.deal_id, audit: [{ entity: "core.deal", entityId: p.deal_id, before, after }] };
  },
};

export const couponSet: CommandHandler = {
  type: "catalogue.coupon.set.v1",
  async run(c, cmd): Promise<HandlerOutput> {
    const p = parse(CatalogueCouponSetV1, cmd);
    const ctx = await authorize(c, "catalogue.coupon.set.v1");
    if (p.currency !== ctx.currency) throw new ApiError("currency_mismatch");
    if (p.valid_to !== null && Date.parse(p.valid_to) <= Date.parse(p.valid_from)) throw new ApiError("bad_request");
    const had = await one<{ code: string; kind: string; value_bp: number | null; value_minor: string | null; min_spend_minor: string; requires_customer: boolean; outlet_ids: string[]; valid_from: Date }>(c,
      `SELECT code, kind, value_bp, value_minor, min_spend_minor, requires_customer, outlet_ids, valid_from FROM core.coupon WHERE id = $1`, [p.coupon_id]);
    if (had) {
      // Only caps, end and status are updatable (0004 grants); the terms a customer was offered stay as they were.
      const same = had.code === p.code && had.kind === p.kind && had.value_bp === p.value_bp && (had.value_minor === null ? null : Number(had.value_minor)) === p.value_minor
        && Number(had.min_spend_minor) === p.min_spend_minor && had.requires_customer === p.requires_customer
        && [...had.outlet_ids].sort().join() === [...p.outlet_ids].sort().join() && had.valid_from.getTime() === Date.parse(p.valid_from);
      if (!same) throw new ApiError("conflict");
      await c.query(`UPDATE core.coupon SET global_cap = $2, per_customer_cap = $3, valid_to = $4, active = $5 WHERE id = $1`,
        [p.coupon_id, p.global_cap, p.per_customer_cap, p.valid_to, p.active]);
    } else {
      await c.query(
        `INSERT INTO core.coupon (tenant_id, id, code, kind, value_bp, value_minor, currency, min_spend_minor, global_cap, per_customer_cap, requires_customer, outlet_ids, valid_from, valid_to, active)
         VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [p.coupon_id, p.code, p.kind, p.value_bp, p.value_minor, p.currency, p.min_spend_minor, p.global_cap, p.per_customer_cap, p.requires_customer, p.outlet_ids, p.valid_from, p.valid_to, p.active]);
    }
    return { entityId: p.coupon_id, audit: [{ entity: "core.coupon", entityId: p.coupon_id, after: p }] };
  },
};

export const availabilitySet: CommandHandler = {
  type: "catalogue.availability.set.v1",
  async run(c, cmd): Promise<HandlerOutput> {
    const p = parse(CatalogueAvailabilitySetV1, cmd);
    const ctx = await authorize(c, "catalogue.availability.set.v1", p.outlet_id);
    await itemAndVariant(c, p.item_id, p.variant_id);
    if (!(await one(c, `SELECT 1 FROM core.outlet WHERE id = $1`, [p.outlet_id]))) throw new ApiError("not_found");
    const r = (await c.query<{ id: string; before: boolean | null }>(
      `WITH prev AS (SELECT available FROM core.item_availability WHERE outlet_id = $2 AND item_id = $3 AND variant_id IS NOT DISTINCT FROM $4)
       INSERT INTO core.item_availability AS a (tenant_id, id, outlet_id, item_id, variant_id, available, updated_by)
       VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, outlet_id, item_id, (coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid)))
       DO UPDATE SET available = EXCLUDED.available, updated_by = EXCLUDED.updated_by
       RETURNING a.id, (SELECT available FROM prev) AS before`,
      [uuidv7(), p.outlet_id, p.item_id, p.variant_id, p.available, ctx.member_id])).rows[0]!;
    return { entityId: r.id, audit: [{ entity: "core.item_availability", entityId: r.id, before: r.before === null ? null : { available: r.before }, after: p }] };
  },
};

export const HANDLERS = [itemUpsert, recipeVersionCreate, priceSet, dealUpsert, dealEnd, couponSet, availabilitySet] as const;
/** Draftable types (contracts `defineDraftable`) whose execution handler this module registers with approvals. */
export const DRAFT_HANDLERS = [priceSet, recipeVersionCreate, dealEnd, couponSet] as const;
