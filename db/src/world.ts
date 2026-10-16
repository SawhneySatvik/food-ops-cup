// The canonical test world (exported from @munim/db for every lane's DB fixtures): one row (or more) in
// EVERY tenant table, three outlets, and the outlet-scoped tables populated in outlets 1 and 2 (outlet 3 holds only a transfer end). Every write goes
// through a runtime role and the book guard — each book write under the command type whose target_tables
// list that table (0007), drafts approved in their own transaction — no superuser shortcuts, so building
// the world is itself the "accepted" half of the guard and binding gates. Synthetic data only.
// Pack-scoped rows: payroll exists only for an IN tenant (AU pack: payroll_scope = 'roster_only').
// Draft-only commands (0015 A1: imports.run.commit.v1, finance.journal.adjust.v1, imports.format.approve.v1,
// customers.campaign.create.v1) write only inside approveDraft.
import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import type { AppContext, TestDb } from "./harness.ts";

export interface World {
  tenant: string;
  country: "IN" | "AU";
  currency: string;
  operator: string;
  owner: string;
  staff: string;
  outlets: [string, string, string];
  devices: [string, string];
  orders: [string, string];
  orderLines: [string, string];
  batches: [string, string];
  ingredient: string;
  item: string;
  drafts: [string, string];
  run: string;
  snapshot: string;
  supplier: string;
  customer: string;
  accounts: { cash: string; sales: string };
  channel: string;
  person: string;
  message: string;
  messageBody: string;
  chunk: string;
  finding: string;
  /** 0020: the owner's finance thread (1 unanswered turn) and a finished ('done') Auto investigation with a live
   *  standing grant and 1 member step; ai_policy owner = auto; ai_budget_cap = 500000 (= the world's operator limit). */
  thread: string;
  investigation: string;
  grant: string;
}

/** UUIDv7 (02-schema §0; contracts UUID7_PATTERN pins version 7): 48-bit ms timestamp, version, variant, random. */
export function uuidv7(): string {
  const b = randomBytes(16);
  let ms = Date.now();
  for (let i = 5; i >= 0; i--) {
    b[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
const u = uuidv7;
type Q = (sql: string, params?: unknown[]) => Promise<pg.QueryResult>;
type Account = { code: string; name: string; type: string };
/** Munim's structural accounts (core-domain finance STRUCTURAL_ACCOUNTS), added where the pack lacks the code. */
const STRUCTURAL_ACCOUNTS: readonly Account[] = [
  { code: "1110", name: "Counter sales clearing", type: "asset" },
  { code: "1250", name: "Staff advances", type: "asset" },
  { code: "2050", name: "Goods received not invoiced", type: "liability" },
  // 0016 (R2-S1-4): finance.post_loyalty_redemption's debit side; 0016 backfills it for existing tenants.
  { code: "4100", name: "Loyalty redemptions", type: "income" },
  { code: "4900", name: "Cash rounding", type: "income" },
  { code: "6900", name: "Other operating expenses", type: "expense" },
];

export function ownerCtx(w: Pick<World, "tenant" | "owner">, extra: AppContext = {}): AppContext {
  return {
    tenant_id: w.tenant,
    outlet_ids: "*",
    role: "owner",
    member_id: w.owner,
    command_type: "catalogue.item.upsert.v1",
    ...extra,
  };
}

/** Approves one draft as the owner and runs `fn` inside the approving transaction (03-architecture §1.6). */
export async function approveDraft(db: TestDb, w: World, commandType: string, fn: (q: Q, decision: string) => Promise<void>, payload: object = {}) {
  const draft = u();
  await db.withContext("munim_svc", { tenant_id: w.tenant, outlet_ids: "*" }, (c) =>
    c.query(`INSERT INTO core.draft (tenant_id, id, source, run_id, command_type, command_payload) VALUES ($1, $2, 'member', $3, $4, $5)`,
      [w.tenant, draft, w.run, commandType, payload]));
  const decision = u();
  await db.withContext("munim_core", { tenant_id: w.tenant, outlet_ids: "*", role: "owner", member_id: w.owner }, async (c) => {
    await c.query(`UPDATE core.draft SET status = 'executing', exec_txid = txid_current() WHERE tenant_id = $1 AND id = $2 AND status = 'proposed'`, [w.tenant, draft]);
    await c.query(`INSERT INTO core.decision (tenant_id, id, draft_id, verdict, final_payload, decided_by) VALUES ($1, $2, $3, 'approved', '{}', $4)`,
      [w.tenant, decision, draft, w.owner]);
    await c.query("SELECT set_config('app.decision_id', $1, true)", [decision]);
    await fn((sql, params) => c.query(sql, params), decision);
    await c.query(`UPDATE core.draft SET status = 'executed' WHERE tenant_id = $1 AND id = $2`, [w.tenant, draft]);
  });
  return { draft, decision };
}

export async function buildWorld(db: TestDb, opts: { country?: "IN" | "AU" } = {}): Promise<World> {
  const country = opts.country ?? "IN";
  const currency = country === "IN" ? "INR" : "AUD";
  const tz = country === "IN" ? "Asia/Kolkata" : "Australia/Melbourne";
  const messageBody = "Paneer from Simulated Dairy arrived at 7 am, two crates short.";
  const w: World = {
    tenant: u(), country, currency, operator: u(), owner: u(), staff: u(),
    outlets: [u(), u(), u()], devices: [u(), u()], orders: [u(), u()], orderLines: [u(), u()],
    batches: [u(), u()], ingredient: u(), item: u(), drafts: [u(), u()], run: u(), snapshot: u(), supplier: u(), customer: u(),
    accounts: { cash: u(), sales: u() }, channel: u(), person: u(), message: u(), messageBody, chunk: u(), finding: u(),
    thread: u(), investigation: u(), grant: u(),
  };
  const T = w.tenant;

  // 1. The operator provisions the tenant and its owner (tenancy.provision.v1, R27).
  await db.withContext("munim_core", {
    tenant_id: T, outlet_ids: "*", role: "operator", operator_id: w.operator, command_type: "tenancy.provision.v1",
  }, async (c) => {
    await c.query(
      `INSERT INTO core.tenant (tenant_id, name, country_code, base_currency, fy_start_month)
       VALUES ($1, 'Synthetic Tenant', $2, $3, $4)`, [T, country, currency, country === "IN" ? 4 : 7]);
    await c.query(`INSERT INTO core.member (tenant_id, id, name, email) VALUES ($1, $2, 'Owner', 'owner@example.test')`, [T, w.owner]);
    await c.query(`INSERT INTO core.membership (tenant_id, member_id, role) VALUES ($1, $2, 'owner')`, [T, w.owner]);
  });

  // 2. The owner sets everything up as their own commands, each under the command bound to its tables.
  const idx: Record<string, string> = {};
  await db.withContext("munim_core", ownerCtx(w), async (c) => {
    const q: Q = (sql, params) => c.query(sql, params);
    const cmd = (type: string) => c.query("SELECT set_config('app.command_type', $1, true)", [type]);
    await cmd("tenancy.outlet.create.v1");
    for (const [i, o] of w.outlets.entries()) {
      await q(`INSERT INTO core.outlet (tenant_id, id, name, kind, tz, address, upi_vpa) VALUES ($1, $2, $3, 'restaurant', $4, 'Synthetic street', $5)`,
        [T, o, `Outlet ${i + 1}`, tz, i === 0 ? "outlet1@okbank" : null]);
    }
    idx.brand = u(); idx.channel = w.channel; idx.customer = w.customer; idx.variant = u(); idx.group = u(); idx.option = u();
    idx.recipe = u(); idx.coupon = u(); idx.po = u(); idx.poLine = u(); idx.invoice = u(); idx.invoiceLine = u(); idx.count = u();
    idx.sku = u();
    await cmd("tenancy.brand.create.v1");
    await q(`INSERT INTO core.brand (tenant_id, id, name, outlet_ids) VALUES ($1, $2, 'Brand', $3)`, [T, idx.brand, w.outlets]);
    await cmd("tenancy.channel.create.v1");
    await q(`INSERT INTO core.channel (tenant_id, id, name, kind) VALUES ($1, $2, 'Counter', 'counter')`, [T, idx.channel]);
    await cmd("tenancy.policy.set.v1");
    await q(`INSERT INTO core.business_policy (tenant_id, id, target_margin_bp, margin_floor_bp, valid_from) VALUES ($1, $2, 6500, 5000, '2026-10-01')`, [T, u()]);
    await cmd("tenancy.member.invite.v1");
    await q(`INSERT INTO core.member (tenant_id, id, name, email) VALUES ($1, $2, 'Staff', 'staff@example.test')`, [T, w.staff]);
    await q(`INSERT INTO core.membership (tenant_id, member_id, role, outlet_ids) VALUES ($1, $2, 'staff', $3)`, [T, w.staff, [w.outlets[0]]]);
    await cmd("customers.customer.upsert.v1");
    await q(`INSERT INTO core.customer (tenant_id, id, name, phone) VALUES ($1, $2, 'Guest', '+919800000000')`, [T, idx.customer]);
    await cmd("inventory.ingredient.upsert.v1");
    await q(`INSERT INTO core.ingredient (tenant_id, id, name, base_unit, tracked_by_batch) VALUES ($1, $2, 'Paneer', 'g', true)`, [T, w.ingredient]);
    await cmd("catalogue.item.upsert.v1");
    await q(`INSERT INTO core.item (tenant_id, id, kind, name_key, category, brand_id) VALUES ($1, $2, 'dish', 'menu.paneer_tikka', 'mains', $3)`, [T, w.item, idx.brand]);
    await q(`INSERT INTO core.item (tenant_id, id, kind, name_key, category, barcode, stock_ingredient_id, mrp_minor, currency)
             VALUES ($1, $2, 'sku', 'shop.paneer_200g', 'dairy', '8901234567890', $3, 9000, $4)`, [T, idx.sku, w.ingredient, currency]);
    await q(`INSERT INTO core.variant (tenant_id, id, item_id, name_key) VALUES ($1, $2, $3, 'menu.paneer_tikka.full')`, [T, idx.variant, w.item]);
    await q(`INSERT INTO core.option_group (tenant_id, id, item_id, name_key, max_select) VALUES ($1, $2, $3, 'menu.spice', 1)`, [T, idx.group, w.item]);
    await q(`INSERT INTO core.option (tenant_id, id, option_group_id, name_key, price_delta_minor, currency) VALUES ($1, $2, $3, 'menu.spice.hot', 1000, $4)`, [T, idx.option, idx.group, currency]);
    await q(`INSERT INTO core.option_ingredient_delta (tenant_id, id, option_id, ingredient_id, qty_milli, unit) VALUES ($1, $2, $3, $4, 20000, 'g')`, [T, u(), idx.option, w.ingredient]);
    await cmd("catalogue.recipe.version.create.v1");
    await q(`INSERT INTO core.recipe_version (tenant_id, id, item_id, version, valid_from, yield_qty_milli) VALUES ($1, $2, $3, 1, '2026-10-01', 1000)`, [T, idx.recipe, w.item]);
    await q(`INSERT INTO core.recipe_line (tenant_id, id, recipe_version_id, ingredient_id, qty_milli, unit) VALUES ($1, $2, $3, $4, 150000, 'g')`, [T, u(), idx.recipe, w.ingredient]);
    await cmd("catalogue.price.set.v1");
    await q(`INSERT INTO core.price (tenant_id, id, item_id, outlet_id, channel_kind, amount_minor, currency, tax_class, valid_from)
             VALUES ($1, $2, $3, $4, 'counter', 32000, $5, $6, '2026-10-01')`,
      [T, u(), w.item, w.outlets[0], currency, country === "IN" ? "restaurant_5" : "gst_10"]);
    await cmd("catalogue.deal.upsert.v1");
    await q(`INSERT INTO core.deal (tenant_id, id, kind, name_key, rule, valid_from) VALUES ($1, $2, 'percent_off', 'deal.lunch', $3, '2026-10-01')`,
      [T, u(), { kind: "percent_off", bp: 1000, item_ids: [w.item] }]);
    await cmd("catalogue.coupon.set.v1");
    await q(`INSERT INTO core.coupon (tenant_id, id, code, kind, value_bp, currency, valid_from) VALUES ($1, $2, 'WELCOME10', 'percent', 1000, $3, '2026-10-01')`, [T, idx.coupon, currency]);
    await cmd("purchasing.supplier.upsert.v1");
    await q(`INSERT INTO core.supplier (tenant_id, id, name, kind, a2a_card_url) VALUES ($1, $2, 'Simulated Dairy', 'simulated', 'http://localhost:9000/card')`, [T, w.supplier]);
    await q(`INSERT INTO core.supplier_price (tenant_id, id, supplier_id, ingredient_id, unit, unit_price_minor, currency, observed_at, source_ref)
             VALUES ($1, $2, $3, $4, 'kg', 40000, $5, now(), 'fixture')`, [T, u(), w.supplier, w.ingredient, currency]);
    await cmd("purchasing.po.create.v1");
    await q(`INSERT INTO core.purchase_order (tenant_id, id, supplier_id, outlet_ids, currency, total_minor) VALUES ($1, $2, $3, $4, $5, 400000)`,
      [T, idx.po, w.supplier, [w.outlets[0]], currency]);
    await q(`INSERT INTO core.po_line (tenant_id, id, po_id, line_no, ingredient_id, qty_milli, unit, unit_price_minor) VALUES ($1, $2, $3, 1, $4, 10000, 'kg', 40000)`,
      [T, idx.poLine, idx.po, w.ingredient]);
    await cmd("purchasing.invoice.record.v1");
    await q(`INSERT INTO core.supplier_invoice (tenant_id, id, supplier_id, invoice_no, invoice_date, po_id, subtotal_minor, total_minor, currency)
             VALUES ($1, $2, $3, 'INV-1', '2026-10-05', $4, 400000, 400000, $5)`, [T, idx.invoice, w.supplier, idx.po, currency]);
    await q(`INSERT INTO core.supplier_invoice_line (tenant_id, id, supplier_invoice_id, line_no, po_line_id, ingredient_id, qty_milli, unit, unit_price_minor, line_total_minor)
             VALUES ($1, $2, $3, 1, $4, $5, 10000, 'kg', 40000, 400000)`, [T, idx.invoiceLine, idx.invoice, idx.poLine, w.ingredient]);
    await q(`INSERT INTO core.command_log (tenant_id, idempotency_key, command_id, command_type, actor, request_hash, result)
             VALUES ($1, $2, $3, 'catalogue.item.upsert.v1', $4, repeat('a', 64), '{}')`, [T, `key-${u()}`, u(), { kind: "member", id: w.owner }]);
    await q(`INSERT INTO core.outbox (tenant_id, id, aggregatetype, aggregateid, type, payload) VALUES ($1, $2, 'item', $3, 'munim.catalogue.item.upserted.v1', '{}')`, [T, u(), w.item]);
    await q(`INSERT INTO core.audit_log (tenant_id, actor, action, entity, entity_id, after) VALUES ($1, $2, 'catalogue.item.upsert.v1', 'core.item', $3, '{"active": true}')`,
      [T, { kind: "member", id: w.owner }, w.item]);
    await q(`INSERT INTO core.storefront_key (tenant_id, id, channel_id, key_hash, allowed_origins) VALUES ($1, $2, $3, $4, '{https://shop.example.test}')`,
      [T, u(), idx.channel, randomUUID().replaceAll("-", "").padEnd(64, "0")]);

    // Outlet-scoped rows in outlets 1 and 2.
    for (const k of [0, 1] as const) {
      const o = w.outlets[k];
      const dev = w.devices[k];
      const ord = w.orders[k];
      const line = w.orderLines[k];
      const batch = w.batches[k];
      const grn = u(); const grnLine = u(); const ret = u(); const prep = u(); const shift = u(); const tender = u(); const count = u();
      await cmd("tenancy.outlet.create.v1");
      await q(`INSERT INTO core.outlet_calendar (tenant_id, id, outlet_id, kind, weekday, opens_at, closes_at) VALUES ($1, $2, $3, 'weekly', 1, '09:00', '22:00')`, [T, u(), o]);
      await q(`INSERT INTO core.device (tenant_id, id, outlet_id, kind, invoice_series) VALUES ($1, $2, $3, 'pos', $4)`, [T, dev, o, `POS${k + 1}`]);
      await q(`INSERT INTO core.item_availability (tenant_id, id, outlet_id, item_id, available, updated_by) VALUES ($1, $2, $3, $4, true, $5)`, [T, u(), o, w.item, w.owner]);
      await q(`INSERT INTO core.pickup_window (tenant_id, id, outlet_id, starts_at, ends_at, capacity_orders) VALUES ($1, $2, $3, now() + interval '1 hour', now() + interval '75 minutes', 10)`, [T, u(), o]);
      await q(`INSERT INTO core.prep_time (tenant_id, id, outlet_id, item_id, station, prep_sec, valid_from) VALUES ($1, $2, $3, $4, 'tandoor', 600, '2026-10-01')`, [T, u(), o, w.item]);
      await cmd("kitchen.prep_list.create.v1");
      await q(`INSERT INTO core.prep_list (tenant_id, id, outlet_id, business_date) VALUES ($1, $2, $3, '2026-10-10')`, [T, prep, o]);
      await q(`INSERT INTO core.prep_list_line (tenant_id, id, prep_list_id, ingredient_id, qty_milli, unit) VALUES ($1, $2, $3, $4, 2000000, 'g')`, [T, u(), prep, w.ingredient]);
      await cmd("orders.place.v1");
      await q(`INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, device_id, kind, status, subtotal_minor, tax_minor, total_minor, currency, pricing_snapshot, customer_id)
               VALUES ($1, $2, $3, $4, $5, 'dine_in', 'placed', 32000, 1600, 33600, $6, '{}', $7)`, [T, ord, o, idx.channel, dev, currency, idx.customer]);
      await q(`INSERT INTO core.order_line (tenant_id, id, outlet_id, order_id, line_no, item_id, qty_milli, unit_price_minor, tax_minor, recipe_version_id)
               VALUES ($1, $2, $3, $4, 1, $5, 1000, 32000, 1600, $6)`, [T, line, o, ord, w.item, idx.recipe]);
      await q(`INSERT INTO core.order_event (tenant_id, id, outlet_id, order_id, kind, to_status, actor) VALUES ($1, $2, $3, $4, 'status', 'placed', $5)`,
        [T, u(), o, ord, { kind: "member", id: w.owner }]);
      await q(`INSERT INTO core.coupon_use (tenant_id, id, coupon_id, order_id, customer_id, discount_minor, currency, applied_by) VALUES ($1, $2, $3, $4, $5, 0, $6, $7)`,
        [T, u(), idx.coupon, ord, idx.customer, currency, w.owner]);
      await cmd("orders.tender.record.v1");
      await q(`INSERT INTO core.tender (tenant_id, id, outlet_id, order_id, method, amount_minor, tendered_minor, change_minor, currency, recorded_by)
               VALUES ($1, $2, $3, $4, 'cash', 33600, 40000, 6400, $5, $6)`, [T, tender, o, ord, currency, w.owner]);
      await cmd("orders.void.record.v1");
      await q(`INSERT INTO core.void (tenant_id, id, outlet_id, order_id, order_line_id, reason_code, note, amount_minor, currency, actor)
               VALUES ($1, $2, $3, $4, $5, 'remake', 'dropped plate', 0, $6, $7)`, [T, u(), o, ord, line, currency, w.owner]);
      await cmd("orders.refund.record.v1");
      await q(`INSERT INTO core.refund (tenant_id, id, outlet_id, order_id, tender_id, method, amount_minor, currency, reason_code, note, actor)
               VALUES ($1, $2, $3, $4, $5, 'cash', 1000, $6, 'late', 'waited long', $7)`, [T, u(), o, ord, tender, currency, w.owner]);
      await cmd("orders.shift.open.v1");
      await q(`INSERT INTO core.shift (tenant_id, id, outlet_id, device_id, opened_by, float_minor, currency) VALUES ($1, $2, $3, $4, $5, 500000, $6)`, [T, shift, o, dev, w.owner, currency]);
      await q(`INSERT INTO core.kitchen_ticket (tenant_id, id, outlet_id, order_id, station) VALUES ($1, $2, $3, $4, 'tandoor')`, [T, u(), o, ord]);
      await cmd("orders.sale_return.record.v1");
      await q(`INSERT INTO core.sale_return (tenant_id, id, outlet_id, order_id, order_line_id, qty_milli, restock, reason_code, note, actor)
               VALUES ($1, $2, $3, $4, $5, 1000, false, 'wrong_item', 'customer returned', $6)`, [T, u(), o, ord, line, w.owner]);
      await cmd("inventory.stock.receive.v1");
      await q(`INSERT INTO core.batch (tenant_id, id, outlet_id, ingredient_id, batch_code, expires_on, supplier_id) VALUES ($1, $2, $3, $4, $5, '2026-10-01', $6)`,
        [T, batch, o, w.ingredient, `B-${k + 1}`, w.supplier]);
      await q(`INSERT INTO core.goods_received (tenant_id, id, outlet_id, supplier_id, po_id, received_by) VALUES ($1, $2, $3, $4, $5, $6)`, [T, grn, o, w.supplier, idx.po, w.owner]);
      await q(`INSERT INTO core.grn_line (tenant_id, id, goods_received_id, po_line_id, ingredient_id, batch_id, qty_milli, unit, unit_cost_minor, currency)
               VALUES ($1, $2, $3, $4, $5, $6, 5000, 'kg', 40000, $7)`, [T, grnLine, grn, idx.poLine, w.ingredient, batch, currency]);
      await q(`INSERT INTO core.stock_movement (tenant_id, id, outlet_id, ingredient_id, batch_id, qty_milli, unit, kind, ref_type, ref_id, unit_cost_minor, currency)
               VALUES ($1, $2, $3, $4, $5, 5000000, 'g', 'receipt', 'core.goods_received', $6, 40, $7)`, [T, u(), o, w.ingredient, batch, grn, currency]);
      await cmd("inventory.expired_sale.override.v1");
      await q(`INSERT INTO core.expired_sale_override (tenant_id, id, outlet_id, cart_line_id, batch_id, qty_milli, reason_code, note, decided_by)
               VALUES ($1, $2, $3, $4, $5, 150000, 'staff_meal', 'used same day', $6)`, [T, u(), o, line, batch, w.owner]);
      await cmd("purchasing.supplier_return.create.v1");
      await q(`INSERT INTO core.supplier_return (tenant_id, id, outlet_id, supplier_id, goods_received_id, reason_code, note, returned_by)
               VALUES ($1, $2, $3, $4, $5, 'damaged', 'torn pack', $6)`, [T, ret, o, w.supplier, grn, w.owner]);
      await q(`INSERT INTO core.supplier_return_line (tenant_id, id, supplier_return_id, ingredient_id, batch_id, qty_milli, unit, unit_cost_minor, currency)
               VALUES ($1, $2, $3, $4, $5, 500, 'kg', 40000, $6)`, [T, u(), ret, w.ingredient, batch, currency]);
      await cmd("inventory.count.submit.v1");
      await q(`INSERT INTO core.stock_count (tenant_id, id, outlet_id, counted_by) VALUES ($1, $2, $3, $4)`, [T, count, o, w.owner]);
      await q(`INSERT INTO core.stock_count_line (tenant_id, id, stock_count_id, ingredient_id, expected_qty_milli, counted_qty_milli, unit) VALUES ($1, $2, $3, $4, 5000000, 4900000, 'g')`,
        [T, u(), count, w.ingredient]);
      await cmd("inventory.reorder_level.set.v1");
      await q(`INSERT INTO core.reorder_level (tenant_id, id, outlet_id, ingredient_id, min_qty_milli, par_qty_milli) VALUES ($1, $2, $3, $4, 9000000, 12000000)`, [T, u(), o, w.ingredient]);
      await cmd("inventory.waste.record.v1");
      await q(`INSERT INTO core.waste_log (tenant_id, id, outlet_id, ingredient_id, batch_id, qty_milli, unit, reason, recorded_by) VALUES ($1, $2, $3, $4, $5, 100000, 'g', 'overprep', $6)`,
        [T, u(), o, w.ingredient, batch, w.owner]);
    }
    const tr1 = u(); const tr2 = u();
    await cmd("inventory.transfer.create.v1");
    await q(`INSERT INTO core.transfer (tenant_id, id, from_outlet_id, to_outlet_id, sent_by) VALUES ($1, $2, $3, $4, $5)`, [T, tr1, w.outlets[0], w.outlets[1], w.owner]);
    await q(`INSERT INTO core.transfer (tenant_id, id, from_outlet_id, to_outlet_id, sent_by) VALUES ($1, $2, $3, $4, $5)`, [T, tr2, w.outlets[1], w.outlets[2], w.owner]);
    await q(`INSERT INTO core.transfer_line (tenant_id, id, transfer_id, ingredient_id, qty_milli, unit) VALUES ($1, $2, $3, $4, 1000, 'g')`, [T, u(), tr1, w.ingredient]);

    // Finance (0008).
    // The full chart a provisioned tenant has: the pack's chart_of_accounts plus Munim's structural accounts for
    // the codes the pack lacks — the rows finance's seedChart writes (core-api finance/chart.ts; db does not
    // import core-domain, so the structural list is copied above by hand).
    await cmd("finance.account.upsert.v1");
    const chart = (await q(`SELECT a ->> 'code' AS code, a ->> 'name' AS name, a ->> 'type' AS type
                              FROM platform.country_pack p, jsonb_array_elements(p.doc -> 'chart_of_accounts') a
                             WHERE p.code = $1 AND p.status = 'active'
                               AND p.version = (SELECT max(x.version) FROM platform.country_pack x WHERE x.code = p.code AND x.status = 'active')`,
      [country])).rows as Account[];
    for (const s of STRUCTURAL_ACCOUNTS) if (!chart.some((a) => a.code === s.code)) chart.push(s);
    for (const a of chart) {
      const id = a.code === "1000" ? w.accounts.cash : a.code === "4000" ? w.accounts.sales : u();
      await q(`INSERT INTO core.account (tenant_id, id, code, name, type) VALUES ($1, $2, $3, $4, $5)`, [T, id, a.code, a.name, a.type]);
    }
    await cmd("finance.channel_terms.set.v1");
    await q(`INSERT INTO core.channel_terms (tenant_id, id, channel_id, commission_bp, ads_opted_in, promo_share_bp, payout_cycle_days, currency, valid_from)
             VALUES ($1, $2, $3, 2200, false, 0, 7, $4, '2026-10-01')`, [T, u(), idx.channel, currency]);
    // A closed month long before every fixture date (March 2025 at outlet 1), so October 2026 rows post.
    await cmd("finance.period.close.v1");
    await q(`INSERT INTO core.period_close (tenant_id, id, outlet_id, period_month, checklist, net_minor, currency, closed_by) VALUES ($1, $2, $3, '2025-03-01', '[]', 0, $4, $5)`,
      [T, u(), w.outlets[0], currency, w.owner]);
    await cmd("finance.budget.set.v1");
    await q(`INSERT INTO core.budget (tenant_id, id, outlet_id, category, period_month, amount_minor, currency) VALUES ($1, $2, $3, 'purchases', '2026-10-01', 5000000, $4)`,
      [T, u(), w.outlets[0], currency]);
    await cmd("finance.expense.record.v1");
    await q(`INSERT INTO core.expense (tenant_id, id, outlet_id, category, incurred_on, amount_minor, currency, payee) VALUES ($1, $2, $3, 'utilities', '2026-10-03', 450000, $4, 'Power Co')`,
      [T, u(), w.outlets[0], currency]);
    await cmd("finance.payable.update.v1");
    await q(`INSERT INTO core.payable (tenant_id, id, supplier_id, source_type, source_id, due_on, amount_minor, currency) VALUES ($1, $2, $3, 'core.supplier_invoice', $4, '2026-10-20', 400000, $5)`,
      [T, u(), w.supplier, idx.invoice, currency]);
    await cmd("finance.tax_return.prepare.v1");
    await q(`INSERT INTO core.tax_return_draft (tenant_id, id, return_code, period_from, period_to, output_tax_minor, input_tax_minor, net_payable_minor, currency)
             VALUES ($1, $2, $3, '2026-09-01', '2026-09-30', 3200, 0, 3200, $4)`, [T, u(), country === "IN" ? "gst.gstr3b" : "ato.bas", currency]);

    // Documents and conversations (0009, operational).
    idx.document = u();
    await q(`INSERT INTO core.document (tenant_id, id, kind, media_type, filename, byte_size, sha256, storage_ref, uploaded_by)
             VALUES ($1, $2, 'payout_statement', 'text/csv', 'payout.csv', 1024, $3, 'docs/payout.csv', $4)`,
      [T, idx.document, randomUUID().replaceAll("-", "").padEnd(64, "a"), w.owner]);
    const conv = u();
    await q(`INSERT INTO core.conversation (tenant_id, id, outlet_id, kind, title) VALUES ($1, $2, $3, 'handover', 'Morning handover')`, [T, conv, w.outlets[0]]);
    await q(`INSERT INTO core.message (tenant_id, id, conversation_id, author_member_id, body) VALUES ($1, $2, $3, $4, $5)`, [T, w.message, conv, w.owner, messageBody]);

    // People (0010). Payroll only where the pack prepares it (IN).
    await cmd("people.staff.upsert.v1");
    await q(`INSERT INTO core.staff (tenant_id, id, member_id, outlet_id, name, role_key, pay_basis, wage_rate_minor, ot_multiplier_bp, currency, joined_on)
             VALUES ($1, $2, $3, $4, 'Cook One', 'cook', 'hourly', 15000, 15000, $5, '2026-01-01')`, [T, w.person, w.staff, w.outlets[0], currency]);
    for (const k of [0, 1] as const) {
      const roster = u(); const shift = u();
      await cmd("people.roster.create.v1");
      await q(`INSERT INTO core.roster (tenant_id, id, outlet_id, week_start) VALUES ($1, $2, $3, '2026-10-05')`, [T, roster, w.outlets[k]]);
      await q(`INSERT INTO core.roster_shift (tenant_id, id, roster_id, outlet_id, staff_id, starts_at, ends_at, role_key)
               VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $6::timestamptz + interval '8 hours', 'cook')`,
        [T, shift, roster, w.outlets[k], w.person, k === 0 ? "2026-10-06T09:00:00Z" : "2026-10-07T09:00:00Z"]);
      await cmd("people.attendance.record.v1");
      await q(`INSERT INTO core.attendance (tenant_id, id, outlet_id, staff_id, roster_shift_id, clock_in_at, clock_out_at, source, recorded_by)
               VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $6::timestamptz + interval '9 hours', 'manual', $7)`,
        [T, u(), w.outlets[k], w.person, shift, k === 0 ? "2026-10-06T09:00:00Z" : "2026-10-07T09:00:00Z", w.owner]);
    }
    if (country === "IN") {
      const pd = u();
      await cmd("people.payroll_draft.create.v1");
      await q(`INSERT INTO core.payroll_draft (tenant_id, id, outlet_id, period_month, currency) VALUES ($1, $2, $3, '2026-09-01', $4)`, [T, pd, w.outlets[0], currency]);
      await q(`INSERT INTO core.payroll_draft_line (tenant_id, id, payroll_draft_id, staff_id, base_minor, overtime_minor, tips_minor, advance_recovery_minor, net_minor, currency)
               VALUES ($1, $2, $3, $4, 2400000, 112500, 0, 0, 2512500, $5)`, [T, u(), pd, w.person, currency]);
    }
    await cmd("people.advance.record.v1");
    await q(`INSERT INTO core.advance (tenant_id, id, staff_id, kind, amount_minor, currency, on_date, recorded_by) VALUES ($1, $2, $3, 'given', 1500000, $4, '2026-10-01', $5)`,
      [T, u(), w.person, currency, w.owner]);
    const pool = u();
    await cmd("people.tip_pool.record.v1");
    await q(`INSERT INTO core.tip_pool (tenant_id, id, outlet_id, period_from, period_to, basis, total_minor, currency) VALUES ($1, $2, $3, '2026-10-01', '2026-10-07', 'equal', 20000, $4)`,
      [T, pool, w.outlets[0], currency]);
    await q(`INSERT INTO core.tip_pool_share (tenant_id, id, tip_pool_id, staff_id, amount_minor, currency) VALUES ($1, $2, $3, $4, 20000, $5)`, [T, u(), pool, w.person, currency]);
    await cmd("people.training.record.v1");
    await q(`INSERT INTO core.training_record (tenant_id, id, staff_id, course_key, completed_on) VALUES ($1, $2, $3, 'training.food_safety', '2026-09-15')`, [T, u(), w.person]);
    await cmd("people.candidate.upsert.v1");
    await q(`INSERT INTO core.hiring_candidate (tenant_id, id, outlet_id, name, role_key) VALUES ($1, $2, $3, 'Applicant', 'server')`, [T, u(), w.outlets[1]]);

    // Customers & growth (0011). The campaign comes later, through an approved draft.
    await cmd("customers.loyalty.adjust.v1");
    await q(`INSERT INTO core.loyalty_entry (tenant_id, id, customer_id, kind, points) VALUES ($1, $2, $3, 'earn', 100)`, [T, u(), idx.customer]);
    await cmd("customers.reservation.upsert.v1");
    await q(`INSERT INTO core.reservation (tenant_id, id, outlet_id, customer_id, name, party_size, starts_at) VALUES ($1, $2, $3, $4, 'Guest', 4, '2026-10-12T19:00:00Z')`,
      [T, u(), w.outlets[0], idx.customer]);
    await cmd("customers.review.record.v1");
    await q(`INSERT INTO core.review (tenant_id, id, outlet_id, source, external_ref, rating, body, reviewed_at) VALUES ($1, $2, $3, 'google', 'R-1', 4, 'Good tikka', '2026-10-06T12:00:00Z')`,
      [T, u(), w.outlets[0]]);
    await cmd("customers.bulk_order.upsert.v1");
    await q(`INSERT INTO core.bulk_order (tenant_id, id, outlet_id, customer_id, contact_name, deliver_at, headcount) VALUES ($1, $2, $3, $4, 'Office', '2026-10-20T12:00:00Z', 40)`,
      [T, u(), w.outlets[0], idx.customer]);

    // Compliance, goals (0012).
    // Outlet-scoped compliance and goal rows in outlets 1 and 2 (0015 A3), plus tenant-wide (outlet NULL) ones.
    const checklist = u();
    await cmd("compliance.checklist.upsert.v1");
    await q(`INSERT INTO core.checklist (tenant_id, id, name_key, kind, frequency, due_time, items) VALUES ($1, $2, 'ops.checklist.opening', 'opening', 'daily', '10:00', '["ops.item.lights"]')`,
      [T, checklist]);
    for (const k of [0, 1] as const) {
      const asset = u();
      const amc = u();
      await cmd("compliance.licence.upsert.v1");
      await q(`INSERT INTO core.licence (tenant_id, id, outlet_id, kind, number, valid_from, valid_to) VALUES ($1, $2, $3, $4, $5, '2026-01-01', '2026-12-31')`,
        [T, u(), w.outlets[k], country === "IN" ? "fssai" : "food_business_registration", `LIC-${k + 1}`]);
      await cmd("compliance.checklist.upsert.v1");
      await q(`INSERT INTO core.checklist (tenant_id, id, outlet_id, name_key, kind, frequency, due_time, items)
               VALUES ($1, $2, $3, 'ops.checklist.closing', 'closing', 'daily', '23:00', '["ops.item.gas"]')`, [T, u(), w.outlets[k]]);
      await cmd("compliance.checklist.complete.v1");
      await q(`INSERT INTO core.checklist_run (tenant_id, id, checklist_id, outlet_id, business_date, results, completed_by) VALUES ($1, $2, $3, $4, '2026-10-09', '{"ops.item.lights": true}', $5)`,
        [T, u(), checklist, w.outlets[k], w.owner]);
      await cmd("compliance.asset.upsert.v1");
      await q(`INSERT INTO core.asset (tenant_id, id, outlet_id, kind, name, safe_min_milli_c, safe_max_milli_c) VALUES ($1, $2, $3, 'chiller', 'Chiller', 0, 5000)`, [T, asset, w.outlets[k]]);
      await cmd("compliance.temp.record.v1");
      await q(`INSERT INTO core.temp_log (tenant_id, id, outlet_id, asset_id, reading_milli_c, read_at, recorded_by) VALUES ($1, $2, $3, $4, 3500, '2026-10-09T08:00:00Z', $5)`,
        [T, u(), w.outlets[k], asset, w.owner]);
      await cmd("compliance.amc.record.v1");
      await q(`INSERT INTO core.amc (tenant_id, id, asset_id, vendor, valid_from, valid_to, cost_minor, currency) VALUES ($1, $2, $3, 'Cool Care', '2026-01-01', '2026-12-31', 1200000, $4)`,
        [T, amc, asset, currency]);
      await cmd("compliance.maintenance.schedule.v1");
      await q(`INSERT INTO core.maintenance (tenant_id, id, asset_id, kind, due_on, estimated_cost_minor, currency, amc_id) VALUES ($1, $2, $3, 'preventive', '2026-10-30', 250000, $4, $5)`,
        [T, u(), asset, currency, amc]);
      await cmd("goals.goal.create.v1");
      await q(`INSERT INTO core.goal (tenant_id, id, outlet_id, metric, target_value, currency, period_from, due_on) VALUES ($1, $2, $3, 'net_sales', 50000000, $4, '2026-10-01', '2026-10-31')`,
        [T, u(), w.outlets[k], currency]);
      await cmd("goals.task.create.v1");
      await q(`INSERT INTO core.task (tenant_id, id, outlet_id, title_key, assignee_member_id, due_on) VALUES ($1, $2, $3, 'goals.task.renew_licence', $4, '2026-10-15')`,
        [T, u(), w.outlets[k], w.staff]);
    }
    await cmd("goals.goal.create.v1");
    await q(`INSERT INTO core.goal (tenant_id, id, outlet_id, metric, target_value, currency, period_from, due_on) VALUES ($1, $2, NULL, 'net_sales', 90000000, $3, '2026-10-01', '2026-10-31')`,
      [T, u(), currency]);
    await cmd("market.viability_case.upsert.v1");
    await q(`INSERT INTO core.viability_case (tenant_id, id, name, outlet_kind, comparable_outlet_id, rent_minor, capex_minor, avg_ticket_minor, expected_daily_orders, currency)
             VALUES ($1, $2, 'Second site', 'restaurant', $3, 15000000, 300000000, 45000, 120, $4)`, [T, u(), w.outlets[0], currency]);
    // 0020 (M-C23): the AI policy books (the owner's own commands), a thread, and an Auto investigation under a grant.
    // Skipped on a database migrated to an earlier file (the 0016 backfill test builds its world on 0001–0015).
    if (!(await q("SELECT to_regclass('core.investigation') IS NOT NULL AS ok")).rows[0].ok) return;
    await cmd("ai_policy.ceiling.set.v1");
    await q(`INSERT INTO core.ai_policy (tenant_id, id, role, mode_ceiling) VALUES ($1, $2, 'owner', 'auto')`, [T, u()]);
    // Cap = the operator limit set in step 5 (500000), so the effective cap (the lower of the two) is what it was without a cap.
    await cmd("ai_policy.cap.set.v1");
    await q(`INSERT INTO core.ai_budget_cap (tenant_id, id, monthly_cap_minor, currency) VALUES ($1, $2, 500000, $3)`, [T, u(), currency]);
    await q(`INSERT INTO core.ai_thread (tenant_id, id, specialist, created_by, outlet_scope) VALUES ($1, $2, 'finance', $3, '{*}')`, [T, w.thread, w.owner]);
    await q(`INSERT INTO core.ai_thread_turn (tenant_id, thread_id, turn_no, id, member_id, addressed_to) VALUES ($1, $2, NULL, $3, $4, 'finance')`,
      [T, w.thread, u(), w.owner]);
    await q(`INSERT INTO core.investigation (tenant_id, id, playbook_id, params, outlet_scope, created_by, mode, checklist, plan_approved_by)
             VALUES ($1, $2, 'margin_fall', '{"period_month": "2026-09-01", "compare_month": "2026-08-01"}', '{*}', $3, 'auto',
                     '[{"item_id": "h0", "status": "pending", "frozen": false, "snapshot_ids": []}]', $3)`, [T, w.investigation, w.owner]);
    await q(`INSERT INTO core.investigation_grant (tenant_id, id, investigation_id, member_id, outlet_scope) VALUES ($1, $2, $3, $4, '{*}')`,
      [T, w.grant, w.investigation, w.owner]);
    await q(`INSERT INTO core.investigation_step (tenant_id, investigation_id, step_no, member_id, triggered_by) VALUES ($1, $2, 1, $3, 'member')`,
      [T, w.investigation, w.owner]);
    // Finished, so lanes counting open (Auto) investigations start from 0; its rows stay for the isolation gate.
    await q(`UPDATE core.investigation SET status = 'done', steps_done = 1 WHERE tenant_id = $1 AND id = $2`, [T, w.investigation]);
  });

  // 3. The service role writes the operational rows intel's internal routes produce.
  idx.importRun = u();
  await db.withContext("munim_svc", { tenant_id: T, outlet_ids: "*" }, async (c) => {
    const q: Q = (sql, params) => c.query(sql, params);
    await q(`INSERT INTO intel.run (tenant_id, id, trigger, actor, outlet_scope, expires_at) VALUES ($1, $2, 'watch_sweep', 'watcher:inventory', '{*}', now() + interval '2 hours')`, [T, w.run]);
    await q(`INSERT INTO evidence.snapshot (tenant_id, id, template_id, template_version, run_id, outlet_scope, rows, row_count, sha256)
             VALUES ($1, $2, 'inventory.below_reorder', 1, $3, '{*}', '[]', 0, repeat('0', 64))`, [T, w.snapshot, w.run]);
    // F8 (0022): the Inventory & Purchasing specialist's drafts; a payload the proposal schema accepts (numbers as refs),
    // since a specialist desk lists them.
    for (const [k, d] of w.drafts.entries()) {
      const ref = (col: string) => `\u27e8snap:${w.snapshot}\u00b70\u00b7${col}\u27e9`;
      await q(`INSERT INTO core.draft (tenant_id, id, outlet_ids, source, run_id, command_type, command_payload)
               VALUES ($1, $2, $3, 'intel:inventory_purchasing', $4, 'inventory.reorder_level.set.v1', $5)`,
        [T, d, [w.outlets[k]], w.run, { outlet_id: w.outlets[k], ingredient_id: w.ingredient, min_qty_milli: ref("min_qty_milli"), par_qty_milli: ref("par_qty_milli") }]);
    }
    // Imports (0009): a parsed run with one staged and one quarantined row.
    await q(`INSERT INTO core.import_run (tenant_id, id, document_id, kind, parser) VALUES ($1, $2, $3, 'payout_statement', 'swiggy_orders_v1')`,
      [T, idx.importRun, idx.document]);
    await q(`INSERT INTO core.import_staging (tenant_id, id, import_run_id, row_no, target_table, data, amount_minor, external_ref)
             VALUES ($1, $2, $3, 1, 'core.settlement_line', '{"external_order_ref": "SW-1"}', 26208, 'SW-1')`, [T, u(), idx.importRun]);
    await q(`INSERT INTO core.import_quarantine (tenant_id, id, import_run_id, row_no, raw, reason_code) VALUES ($1, $2, $3, 2, 'garbled,row', 'date_unreadable')`,
      [T, u(), idx.importRun]);
    await q(`UPDATE core.import_run SET status = 'previewed', rows_ok = 1, rows_quarantined = 1, control_total_minor = 26208, currency = $3
             WHERE tenant_id = $1 AND id = $2`, [T, idx.importRun, currency]);
    // Intel (0012).
    const entity = u(); const entity2 = u(); const page = u();
    await q(`INSERT INTO intel.entity (tenant_id, id, kind, core_ref, name) VALUES ($1, $2, 'supplier', $3, 'Simulated Dairy'), ($1, $4, 'ingredient', $5, 'Paneer')`,
      [T, entity, `core.supplier:${w.supplier}`, entity2, `core.ingredient:${w.ingredient}`]);
    await q(`INSERT INTO intel.alias (tenant_id, id, entity_id, alias, normalized, source) VALUES ($1, $2, $3, 'Sim Dairy', 'sim dairy', 'claim')`, [T, u(), entity]);
    await q(`INSERT INTO intel.chunk (tenant_id, id, message_id, seq, text, run_id) VALUES ($1, $2, $3, 0, $4, $5)`, [T, w.chunk, w.message, messageBody, w.run]);
    const claim = u();
    await q(`INSERT INTO intel.claim (tenant_id, id, run_id, chunk_id, span_start, span_end, quote, subject_entity_id, predicate, object)
             VALUES ($1, $2, $3, $4, 0, 6, 'Paneer', $5, 'delivered_short', 'two crates')`, [T, claim, w.run, w.chunk, entity2]);
    await q(`INSERT INTO intel.edge (tenant_id, id, kind, src_entity_id, dst_entity_id, claim_id) VALUES ($1, $2, 'supplies', $3, $4, $5)`, [T, u(), entity, entity2, claim]);
    await q(`INSERT INTO intel.wiki_page (tenant_id, id, entity_id, kind, slug, title, current_version) VALUES ($1, $2, $3, 'supplier', 'simulated-dairy', 'Simulated Dairy', 1)`,
      [T, page, entity]);
    await q(`INSERT INTO intel.wiki_version (tenant_id, id, page_id, version, body, run_id) VALUES ($1, $2, $3, 1, '[]', $4)`, [T, u(), page, w.run]);
    const fr = u();
    await q(`INSERT INTO intel.forecast_run (tenant_id, id, run_id, method, trained_through, horizon_days, holdout_days) VALUES ($1, $2, $3, 'seasonal_naive', '2026-10-09', 7, 28)`,
      [T, fr, w.run]);
    for (const k of [0, 1] as const) {
      await q(`INSERT INTO intel.forecast_point (tenant_id, id, forecast_run_id, outlet_id, item_id, business_on, method, qty_milli, lo_qty_milli, hi_qty_milli, inputs_snapshot_id)
               VALUES ($1, $2, $3, $4, $5, '2026-10-10', 'seasonal_naive', 12000, 9000, 15000, $6)`, [T, u(), fr, w.outlets[k], w.item, w.snapshot]);
    }
    await q(`INSERT INTO intel.finding (tenant_id, id, run_id, outlet_ids, pack, type, severity, impact_snapshot_id, impact_row, impact_column, confidence_bp, envelope, dedupe_key)
             VALUES ($1, $2, $3, $4, 'inventory_purchasing', 'inventory.shortfall', 'high', $5, 0, 'on_hand_milli', 8000, $7, $6)`,
      [T, w.finding, w.run, [w.outlets[0]], w.snapshot, `inventory.shortfall:${w.outlets[0]}`,
       // An abstained envelope the findings contract accepts (a specialist desk lists the finding since 0022's F8 relabel).
       { finding_id: w.finding, segments: [], impact_ref: null, abstained: true, reason_code: "count_missing" }]);
    await q(`INSERT INTO intel.answer (tenant_id, id, run_id, question, asked_by, envelope, abstained, reason_code) VALUES ($1, $2, $3, 'Why was this week bad?', $4, '{"segments": []}', true, 'settlements_missing')`,
      [T, u(), w.run, w.owner]);
    const ev = u();
    await q(`INSERT INTO intel.trace_event (tenant_id, run_id, seq, id, kind, actor, payload, at) VALUES ($1, $2, 1, $3, 'route', 'router', '{"to": "inventory"}', now())`, [T, w.run, ev]);
    await q(`INSERT INTO intel.supplier_quote (tenant_id, id, run_id, supplier_id, ingredient_id, round, qty_milli, unit, unit_price_minor, currency, payment_days, trace_event_id)
             VALUES ($1, $2, $3, $4, $5, 1, 10000, 'kg', 39000, $6, 15, $7)`, [T, u(), w.run, w.supplier, w.ingredient, currency, ev]);
    await q(`INSERT INTO intel.intel_spend (tenant_id, id, run_id, role, provider, model_id, input_tokens, output_tokens, amount_minor, currency, at)
             VALUES ($1, $2, $3, 'router', 'gemini', 'gemini-3-flash', 1200, 80, 15, $4, '2026-10-09T10:00:00Z')`, [T, u(), w.run, currency]);
    await q(`INSERT INTO intel.outcome (tenant_id, id, finding_id, draft_id, check_kind) VALUES ($1, $2, $3, $4, 'inventory.stockout_avoided')`, [T, u(), w.finding, w.drafts[0]]);
    await q(`INSERT INTO intel.event_claim (tenant_id, event_id, run_id) VALUES ($1, $2, $3)`, [T, u(), w.run]);
    await q(`INSERT INTO intel.watch_state (tenant_id, pack, last_run_at, last_run_id) VALUES ($1, 'inventory', now(), $2)`, [T, w.run]);
  });

  // 4. The owner rejects the second draft (a decision row), approves an import-format draft, a campaign
  //    draft and an import run that carries a market signal (all exist only through approval).
  await db.withContext("munim_core", ownerCtx(w, { command_type: "drafts.reject.v1" }), async (c) => {
    await c.query(`UPDATE core.draft SET status = 'rejected' WHERE tenant_id = $1 AND id = $2`, [T, w.drafts[1]]);
    await c.query(`INSERT INTO core.decision (tenant_id, id, draft_id, verdict, reason, decided_by) VALUES ($1, $2, $3, 'rejected', 'not now', $4)`,
      [T, u(), w.drafts[1], w.owner]);
  });
  // The import run commits under its approved draft (R28): a market signal, a settlement from that run, a bank line.
  idx.settlement = u(); idx.settlementLine = u(); idx.bankLine = u();
  await approveDraft(db, w, "imports.run.commit.v1", async (q, decision) => {
    await q(`UPDATE core.import_run SET status = 'committed', decision_id = $3 WHERE tenant_id = $1 AND id = $2`, [T, idx.importRun, decision]);
    await q(`INSERT INTO core.market_signal (tenant_id, id, outlet_id, on_date, kind, label, source, import_run_id) VALUES ($1, $2, $3, '2026-10-20', 'festival', 'festival.diwali', 'calendar.csv', $4)`,
      [T, u(), w.outlets[0], idx.importRun]);
    await q(`INSERT INTO core.settlement (tenant_id, id, channel_id, period_from, period_to, external_ref, net_minor, currency, import_run_id)
             VALUES ($1, $2, $3, '2026-10-01', '2026-10-07', 'PAYOUT-1', 26208, $4, $5)`, [T, idx.settlement, idx.channel, currency, idx.importRun]);
    await q(`INSERT INTO core.settlement_line (tenant_id, id, settlement_id, line_no, line_kind, matched_order_id, gross_minor, commission_minor, tax_withheld_minor, net_minor, currency)
             VALUES ($1, $2, $3, 1, 'order', $4, 33600, 7392, 0, 26208, $5)`, [T, idx.settlementLine, idx.settlement, w.orders[0], currency]);
    await q(`INSERT INTO core.bank_line (tenant_id, id, outlet_id, account_ref, value_date, amount_minor, currency, method, payee_vpa, external_ref, import_run_id)
             VALUES ($1, $2, $3, 'BANK-1', '2026-10-08', 26208, $4, 'upi', 'outlet1@okbank', 'UTR-1', $5)`, [T, idx.bankLine, w.outlets[0], currency, idx.importRun]);
  });
  await approveDraft(db, w, "finance.journal.adjust.v1", async (q) => {
    idx.entry = u();
    await q(`INSERT INTO core.journal_entry (tenant_id, id, outlet_id, entry_date, memo_key) VALUES ($1, $2, $3, '2026-10-05', 'finance.memo.opening')`, [T, idx.entry, w.outlets[0]]);
    await q(`INSERT INTO core.posting (tenant_id, id, journal_entry_id, account_id, amount_minor, currency) VALUES ($1, $2, $3, $4, 10000, $6), ($1, $7, $3, $5, -10000, $6)`,
      [T, u(), idx.entry, w.accounts.cash, w.accounts.sales, currency, u()]);
  });
  // The owner disputes the short payout (own commands).
  await db.withContext("munim_core", ownerCtx(w, { command_type: "finance.dispute.draft.v1" }), async (c) => {
    idx.dispute = u();
    await c.query(`INSERT INTO core.dispute (tenant_id, id, counterparty, channel_id, basis, total_claimed_minor, currency) VALUES ($1, $2, 'channel', $3, 'short_payout', 500, $4)`,
      [T, idx.dispute, idx.channel, currency]);
    await c.query(`INSERT INTO core.dispute_line (tenant_id, id, dispute_id, line_no, settlement_line_id, claimed_minor, currency) VALUES ($1, $2, $3, 1, $4, 500, $5)`,
      [T, u(), idx.dispute, idx.settlementLine, currency]);
    await c.query(`INSERT INTO core.reconciliation_break (tenant_id, id, kind, channel_id, settlement_line_id, amount_minor, currency, status, dispute_id)
                   VALUES ($1, $2, 'short_payout', $3, $4, 500, $5, 'disputed', $6)`, [T, u(), idx.channel, idx.settlementLine, currency, idx.dispute]);
    await c.query("SELECT set_config('app.command_type', 'finance.receivable.update.v1', true)");
    await c.query(`INSERT INTO core.receivable (tenant_id, id, channel_id, dispute_id, amount_minor, currency) VALUES ($1, $2, $3, $4, 500, $5)`,
      [T, u(), idx.channel, idx.dispute, currency]);
  });
  await approveDraft(db, w, "imports.format.approve.v1", (q, decision) =>
    q(`INSERT INTO core.import_format (tenant_id, id, kind, name, header_signature, mapping, decision_id)
       VALUES ($1, $2, 'payout_statement', 'My bank CSV', repeat('b', 64), '[{"source": "Order ID", "target": "external_order_ref"}, {"source": "Amount", "target": "gross_minor", "unit": "major"}]', $3)`,
      [T, u(), decision]).then(() => {}));
  await approveDraft(db, w, "customers.campaign.create.v1", (q) =>
    q(`INSERT INTO core.campaign (tenant_id, id, name, channel, segment_snapshot_id, audience_count, message_key, send_at, coupon_id)
       VALUES ($1, $2, 'Come back', 'email', $3, 0, 'campaign.come_back', '2026-10-15T10:00:00Z', $4)`, [T, u(), w.snapshot, idx.coupon]).then(() => {}));

  // 5. The operator sets a model budget.
  await db.withContext("munim_platform", {}, async (c) => {
    await c.query(`INSERT INTO platform.llm_budget (tenant_id, month, limit_minor, currency) VALUES ($1, '2026-10-01', 500000, $2)`, [T, currency]);
  });
  await addCares(db, w);
  await addStorefrontPage(db, w);
  return w;
}

/** 0034 (T-128): the owner saves the storefront page as version 1 and publishes it (each under its own command), so both
 *  new tenant tables hold a row and a shopper reads one live page. Skipped on a database migrated to an earlier file. */
async function addStorefrontPage(db: TestDb, w: World): Promise<void> {
  if (!(await db.admin("SELECT to_regclass('core.storefront_page_version') IS NOT NULL AS ok")).rows[0]!.ok) return;
  const page = u();
  const doc = { theme: { primary: "#7b3f1d", secondary: "#9e2f4e", accent: "#f6d9c8", radius: "round", layout: "hero-banner" },
    sections: [{ kind: "hero", visible: true, badge: "Synthetic", tagline: "Fresh every morning." }, { kind: "outlets", visible: true, title: "Our outlets" },
      { kind: "ribbon", visible: false }, { kind: "cards", visible: true, cards: [{ title: "Order ahead", body: "Pick up at the counter." }, { title: "Gift boxes", body: "Pick a box." }] }] };
  await db.withContext("munim_core", ownerCtx(w, { command_type: "storefront.page.save.v1" }), (c) =>
    c.query(`INSERT INTO core.storefront_page_version (tenant_id, id, version, doc, created_by, origin) VALUES ($1, $2, 1, $3, $4, '{}')`,
      [w.tenant, page, JSON.stringify(doc), w.owner]));
  await db.withContext("munim_core", ownerCtx(w, { command_type: "storefront.page.publish.v1" }), (c) =>
    c.query(`INSERT INTO core.storefront_page_publish (tenant_id, id, page_id, published_by, origin) VALUES ($1, $2, $3, $4, '{}')`,
      [w.tenant, u(), page, w.owner]));
}

/** 0028 (Munim Cares): rows in the ten new tenant tables only — no stock movement, task or batch — so lanes counting the
 *  older tables see the world they saw. The world's operator (`w.operator`) becomes a platform.operator row
 *  (world-operator@example.test) because the enablement row must cite a config draft approved in its own transaction
 *  (0028 draft_applied; an applied draft names its deciding operator). A simulated recipient is listed; the owner opts
 *  outlets 1 and 2 in and, at each, publishes a past donation (handed over in part) and a past offer (accepted for a buyer
 *  claim, so allocated), and claims another business's offer. Pickups are in the past, so nothing is live on the network
 *  page. Skipped on a database migrated to an earlier file. */
async function addCares(db: TestDb, w: World): Promise<void> {
  const T = w.tenant;
  if (!(await db.admin("SELECT to_regclass('core.cares_listing') IS NOT NULL AS ok")).rows[0]!.ok) return;
  const city = w.country === "IN" ? { code: "mumbai", name: "Mumbai", lat: 19076000, lng: 72877700 } : { code: "melbourne", name: "Melbourne", lat: -37813600, lng: 144963100 };
  const recipient = u();
  await db.withContext("munim_platform", {}, async (c) => {
    const draft = u();
    await c.query(`INSERT INTO platform.cares_city (code, country_code, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [city.code, w.country, city.name]);
    await c.query(`INSERT INTO platform.cares_recipient (id, city_code, name, kind, simulated, accepts_cooked, accepts_raw, accepts_packaged,
                     capacity_kg_per_day, capacity_portions_per_day, receiving_from, receiving_to, lat_e6, lng_e6)
                   VALUES ($1, $2, 'Lotus Lane Food Bank (simulated)', 'food_bank', true, true, true, true, 200, 300, '16:00', '21:00', $3, $4)`,
      [recipient, city.code, city.lat + 4000, city.lng + 4000]);
    // As platform/drafts.ts approve: the target row first, then the draft flips to applied in the same transaction.
    await c.query(`INSERT INTO platform.operator (id, idp_sub, email) VALUES ($1, $2, 'world-operator@example.test')`, [w.operator, `world-operator-${w.operator}`]);
    await c.query(`INSERT INTO platform.config_draft (id, target, patch, proposed_by) VALUES ($1, $2, '{"enabled": true}', $3)`,
      [draft, `cares_enablement:${T}`, `operator:${w.operator}`]);
    await c.query(`INSERT INTO platform.cares_enablement (tenant_id, enabled, config_draft_id) VALUES ($1, true, $2)`, [T, draft]);
    await c.query(`UPDATE platform.config_draft SET status = 'applied', decided_by = $2, decided_at = now() WHERE id = $1`, [draft, w.operator]);
  });
  await db.withContext("munim_core", ownerCtx(w), async (c) => {
    const q: Q = (sql, params) => c.query(sql, params);
    const cmd = (type: string) => c.query("SELECT set_config('app.command_type', $1, true)", [type]);
    await cmd("cares.profile.set.v1");
    await q(`INSERT INTO core.cares_profile (tenant_id, id, public_name, b2b_enabled) VALUES ($1, $2, 'Synthetic Kitchen', true)`, [T, u()]);
    for (const [k, o] of [w.outlets[0], w.outlets[1]].entries()) {
      await q(`INSERT INTO core.cares_outlet (tenant_id, outlet_id, city_code, lat_e6, lng_e6, pickup_from, pickup_to) VALUES ($1, $2, $3, $4, $5, '17:00', '20:00')`,
        [T, o, city.code, city.lat + k * 1000, city.lng]);
    }
    for (const k of [0, 1] as const) {
      const o = w.outlets[k];
      const [donation, offer, dLine, oLine, handover, allocation, claim] = [u(), u(), u(), u(), u(), u(), u()];
      const listing = `INSERT INTO core.cares_listing (tenant_id, id, outlet_id, kind, recipient_id, pickup_from, pickup_to, pickup_on, published_by)
                       SELECT $1, $2, $3, $4, $5, $6::timestamptz, $6::timestamptz + interval '2 hours',
                              (($6::timestamptz AT TIME ZONE ou.tz) - ou.business_day_cutoff)::date, $7
                         FROM core.outlet ou WHERE ou.tenant_id = $1 AND ou.id = $3`;
      await cmd("cares.listing.publish.v1");
      await q(listing, [T, donation, o, "donation", recipient, "2026-10-10T12:30:00Z", w.owner]);
      await q(`INSERT INTO core.cares_listing_line (tenant_id, id, listing_id, line_no, food_kind, ingredient_id, batch_id, qty_milli, unit, expires_on)
               VALUES ($1, $2, $3, 1, 'raw', $4, $5, 500000, 'g', '2026-10-12')`, [T, dLine, donation, w.ingredient, w.batches[k]]);
      await q(listing, [T, offer, o, "offer", null, "2026-10-10T12:30:00Z", w.owner]);
      await q(`INSERT INTO core.cares_listing_line (tenant_id, id, listing_id, line_no, food_kind, ingredient_id, qty_milli, unit, expires_on, unit_price_minor, currency)
               VALUES ($1, $2, $3, 1, 'raw', $4, 1000000, 'g', '2026-10-12', 30, $5)`, [T, oLine, offer, w.ingredient, w.currency]);
      await cmd("cares.handover.record.v1");
      await q(`INSERT INTO core.cares_handover (tenant_id, id, listing_id, outlet_id, handed_at, recorded_by) VALUES ($1, $2, $3, $4, '2026-10-10T13:00:00Z', $5)`,
        [T, handover, donation, o, w.owner]);
      await q(`INSERT INTO core.cares_handover_line (tenant_id, id, handover_id, listing_line_id, qty_milli) VALUES ($1, $2, $3, $4, 200000)`, [T, u(), handover, dLine]);
      // Another (synthetic) business's claim on this offer, accepted; this business's claim on another's offer.
      await cmd("cares.claim.decide.v1");
      await q(`INSERT INTO core.cares_allocation (tenant_id, id, listing_id, outlet_id, claim_tenant_id, claim_id, buyer_public_name, verdict, total_minor, currency, decided_by)
               VALUES ($1, $2, $3, $4, $5, $6, 'Synthetic Buyer', 'accepted', 30000, $7, $8)`, [T, allocation, offer, o, u(), u(), w.currency, w.owner]);
      await q(`UPDATE core.cares_listing SET status = 'allocated' WHERE tenant_id = $1 AND id = $2`, [T, offer]);
      await cmd("cares.claim.create.v1");
      await q(`INSERT INTO core.cares_claim (tenant_id, id, outlet_id, offer_tenant_id, offer_listing_id, total_minor, currency, created_by) VALUES ($1, $2, $3, $4, $5, 15000, $6, $7)`,
        [T, claim, o, u(), u(), w.currency, w.owner]);
      await q(`INSERT INTO core.cares_claim_line (tenant_id, id, claim_id, offer_line_id, ingredient_id, qty_milli, unit, unit_price_minor, expires_on)
               VALUES ($1, $2, $3, $4, $5, 500000, 'g', 30, '2026-10-12')`, [T, u(), claim, u(), w.ingredient]);
    }
  });
}
