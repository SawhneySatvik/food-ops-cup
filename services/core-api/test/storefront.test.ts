// Storefront API (T-032) through the real app: auth (storefront key → tenant + channel), RLS, executeCommand, the
// book guard. The cross-module seams (orders place/preview, catalogue menu, accounts ensureProfile) are LOCAL FAKES
// below — T-021/T-022/T-035 have not landed. What these gates prove is storefront's own behaviour: key-derived
// channel and customer, accepting state + calendar, window / sold-out pre-checks, guest checkout in one
// transaction with the one-time token, guest isolation, change windows, and that refusals from the seams keep
// their reason codes. Capacity-under-concurrency, coupon and deal judging are placeOrder/previewOrder behaviour
// and are NOT proven here beyond the fake's hand rules.
// Expected values are hand-computed: price 32000, tax 5% of net, lunch deal 10% off 12:00–15:00 outlet-local.
//   13:00 with deal: gross 32000 − deal 3200 = net 28800, tax 1440, total 30240
//   + WELCOME10 (10% of net 28800 = 2880): net 25920, tax 1296, total 27216
//   16:00 no deal: tax 1600, total 33600
// The commands storefront.order.cancel.v1 / .reschedule.v1 are NOT seeded yet (migrator request): the gate seeds
// them as a clearly-marked shim row each, with customer_target_tables core.order + core.order_event.
import { createHash } from "node:crypto";
import { createLogger } from "@munim/config";
import { businessDate, localTime } from "@munim/core-domain/tz";
import { buildWorld, ownerCtx, type TestDb, uuidv7 } from "@munim/db";
import type { Hono } from "hono";
import type pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createLocalIdp } from "../../../adapters/dev/idp-local/index.ts";
import { type AppEnv, asSystem, contextOf, createApp, GUEST_TOKEN_HEADER, STOREFRONT_KEY_HEADER, storefrontResolver, withContext } from "../src/app.ts";
import { ApiError } from "../src/lib/errors.ts";
import { executeCommand, type CommandContext } from "../src/commit/index.ts";
import { configureStorefront, resetStorefront, type SaleEntry, type Seams } from "../src/modules/storefront/index.ts";
import { openDb } from "./db.ts";
import { buildTenant, type Tenant } from "./world.ts";

const TZ = "Asia/Kolkata";
const MON_1300 = new Date("2026-10-12T07:30:00Z"); // Monday 13:00 IST
const P_1300 = "2026-10-12T07:30:00.000Z"; // promised 13:00 IST (deal window 12:00–15:00)
const P_1600 = "2026-10-12T10:30:00.000Z"; // promised 16:00 IST (no deal)
const P_HOLIDAY = "2026-10-20T07:30:00.000Z"; // Tuesday 20th 13:00 IST — override row closes the outlet

const idp = createLocalIdp();
let db: TestDb;
let pools: { core: pg.Pool; svc: pg.Pool };
let app: Hono<AppEnv>;
let W: Tenant;
let other: Tenant;
let KEY: string; // pickup channel key
let CH: string; // pickup channel id
let OUT: string; // outlet 1
let ITEM2: string; // sold-out item
let win: { w1300: string; full: string; w1600: string; w1630: string };
let clockNow = MON_1300;
const seen = { placeChannels: [] as string[], reversed: [] as string[], profiles: [] as string[] };

const cmdCtx = (type: string) => ownerCtx(W, { command_type: type });

// ─────────────────────────── local fakes of the cross-module seams ───────────────────────────
interface PricedLine { item_id: string; unit: number; gross: number; deal: number; coupon: number; net: number; tax: number; priceId: string; dealIds: string[]; couponIds: string[] }
async function priceCart(ctx: CommandContext, req: { outlet_id: string; channel_id: string; promised_at: string | null; coupon_codes: string[]; lines: Array<{ item_id: string; option_ids: string[]; qty_milli: number }> }) {
  return ctx.tx(async (c) => {
    const at = req.promised_at ? new Date(req.promised_at) : clockNow;
    const kind = (await c.query<{ kind: string }>(`SELECT kind FROM core.channel WHERE id = $1`, [req.channel_id])).rows[0]!.kind;
    const date = businessDate(at, TZ);
    const hhmm = localTime(at, TZ);
    const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
    const deals = (await c.query<{ id: string; rule: { bp: number }; windows: Array<{ days: number[]; from: string; to: string }> }>(
      `SELECT id, rule, windows FROM core.deal WHERE active AND jsonb_array_length(windows) > 0`)).rows
      .filter((d) => d.windows.some((w) => w.days.includes(dow) && hhmm >= w.from && hhmm < w.to));
    const coupons = req.coupon_codes.length ? (await c.query<{ id: string; code: string; value_bp: number; min_spend_minor: string; global_cap: number | null; valid_to: Date | null }>(
      `SELECT id, code, value_bp, min_spend_minor, global_cap, valid_to FROM core.coupon WHERE code = ANY ($1)`, [req.coupon_codes])).rows : [];
    const refusals: Array<{ line_no: number | null; reason_code: string }> = [];
    const priced: PricedLine[] = [];
    for (const l of req.lines) {
      const p = (await c.query<{ id: string; amount_minor: string }>(
        `SELECT id, amount_minor FROM core.price WHERE item_id = $1 AND outlet_id = $2 AND channel_kind = $3 AND valid_from <= $4::date`, [l.item_id, req.outlet_id, kind, date])).rows[0];
      if (!p) throw new ApiError("not_found");
      const unit = Number(p.amount_minor);
      const gross = Math.round((unit * l.qty_milli) / 1000);
      const deal = deals.reduce((s, d) => s + Math.round((gross * d.rule.bp) / 10000), 0);
      priced.push({ item_id: l.item_id, unit, gross, deal, coupon: 0, net: gross - deal, tax: 0, priceId: p.id, dealIds: deals.map((d) => d.id), couponIds: [] });
    }
    const afterDeal = priced.reduce((s, l) => s + l.net, 0);
    for (const code of req.coupon_codes) {
      const cp = coupons.find((x) => x.code === code);
      if (!cp || (cp.valid_to !== null && cp.valid_to.getTime() < at.getTime())) { refusals.push({ line_no: null, reason_code: "coupon_invalid" }); continue; }
      // a customer sees only their own coupon_use rows, so a global cap is counted as core (asSystem)
      const used = await asSystem(c, async () => Number((await c.query(`SELECT count(*) AS n FROM core.coupon_use WHERE coupon_id = $1`, [cp.id])).rows[0]!.n));
      if (cp.global_cap !== null && used >= cp.global_cap) { refusals.push({ line_no: null, reason_code: "coupon_cap_reached" }); continue; }
      if (afterDeal < Number(cp.min_spend_minor)) { refusals.push({ line_no: null, reason_code: "coupon_min_spend" }); continue; }
      const first = priced[0]!;
      const off = Math.round((first.net * cp.value_bp) / 10000);
      first.coupon += off; first.net -= off; first.couponIds.push(cp.id);
    }
    for (const l of priced) l.tax = Math.round(l.net * 0.05);
    return { priced, refusals, kind, date };
  });
}
const cite = (table: string, id: string) => `⟨cite:row:core.${table}:${id}⟩`;

const fakeSeams: Seams = {
  async itemsForSale(tx, outlet, kind): Promise<SaleEntry[]> {
    const r = await tx.query<{ id: string; name_key: string; category: string; kind: "dish"; amount_minor: string; currency: string; available: boolean }>(
      `SELECT i.id, i.name_key, i.category, i.kind, p.amount_minor, p.currency,
              coalesce((SELECT a.available FROM core.item_availability a WHERE a.item_id = i.id AND a.outlet_id = $1 AND a.variant_id IS NULL), true) AS available
         FROM core.item i JOIN core.price p ON p.item_id = i.id AND p.outlet_id = $1 AND p.channel_kind = $2 AND p.variant_id IS NULL
        WHERE i.active AND i.kind <> 'sku' ORDER BY i.name_key`, [outlet, kind]);
    return r.rows.map((x) => ({ item_id: x.id, variant_id: null, name_key: x.name_key, variant_name_key: null, category: x.category, kind: x.kind, available: x.available, price_minor: Number(x.amount_minor), currency: x.currency, option_groups: [] }));
  },
  async previewOrder(ctx, req) {
    const { priced, refusals } = await priceCart(ctx, req);
    const subtotal = priced.reduce((s, l) => s + l.gross, 0);
    const discount = priced.reduce((s, l) => s + l.deal + l.coupon, 0);
    const tax = priced.reduce((s, l) => s + l.tax, 0);
    return {
      label: "preview" as const, priced_at: (req.promised_at ?? clockNow.toISOString()), currency: "INR", tax_rule: { pack_code: "IN", pack_version: 1 },
      lines: priced.map((l, i) => ({
        line_no: i + 1, item_id: l.item_id, variant_id: null, qty_milli: req.lines[i]!.qty_milli, unit_price_minor: l.unit, options_minor: 0,
        line_discount_minor: l.deal + l.coupon, tax_class: "restaurant_5", tax_minor: l.tax, line_total_minor: l.net + l.tax,
        price_ref: cite("price", l.priceId), option_refs: [], deal_refs: l.dealIds.map((d) => cite("deal", d)), coupon_refs: l.couponIds.map((d) => cite("coupon", d)),
      })),
      subtotal_minor: subtotal, discount_minor: discount, tax_minor: tax, total_minor: subtotal - discount + tax,
      refusals: refusals as never,
    };
  },
  async placeOrder(ctx, command, opts) {
    const p = command.payload as { order_id: string; outlet_id: string; channel_id: string; kind: string; table_ref: string | null; pickup_window_id: string | null; promised_at: string | null;
      coupon_codes: string[]; preview_total_minor: number | null; client_totals: unknown; lines: Array<{ line_id: string; item_id: string; variant_id: string | null; option_ids: string[]; qty_milli: number }> };
    seen.placeChannels.push(p.channel_id);
    const pr = await priceCart(ctx, { ...p, promised_at: p.promised_at });
    if (pr.refusals[0]) throw new ApiError("conflict", pr.refusals[0].reason_code as never);
    const total = pr.priced.reduce((s, l) => s + l.net + l.tax, 0);
    if (p.preview_total_minor !== null && p.preview_total_minor !== total) throw new ApiError("conflict", "preview_total_changed");
    return executeCommand(ctx, command, {
      type: "orders.place.v1",
      async run(c) {
        const at = p.promised_at ? new Date(p.promised_at) : clockNow;
        const bd = businessDate(at, TZ);
        const t = (await c.query<{ last_no: number }>(
          `INSERT INTO core.ticket_counter (tenant_id, outlet_id, business_date, last_no) VALUES (current_setting('app.tenant_id')::uuid, $1, $2, 1)
           ON CONFLICT (tenant_id, outlet_id, business_date) DO UPDATE SET last_no = core.ticket_counter.last_no + 1 RETURNING last_no`, [p.outlet_id, bd])).rows[0]!;
        const subtotal = pr.priced.reduce((s, l) => s + l.gross, 0);
        const discount = pr.priced.reduce((s, l) => s + l.deal + l.coupon, 0);
        const tax = pr.priced.reduce((s, l) => s + l.tax, 0);
        await c.query(
          `INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, pickup_window_id, kind, table_ref, promised_at, status, business_date, ticket_no, customer_id,
                                      subtotal_minor, discount_minor, tax_minor, total_minor, currency, pricing_snapshot, client_totals, guest_access_hash, created_at)
           VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, $7, 'placed', $8, $9, current_setting('app.customer_id')::uuid, $10, $11, $12, $13, 'INR', '{}', $14, $15, $16)`,
          [p.order_id, p.outlet_id, p.channel_id, p.pickup_window_id, p.kind, p.table_ref, p.promised_at, bd, t.last_no, subtotal, discount, tax, subtotal - discount + tax,
           JSON.stringify(p.client_totals), opts.guest_access_hash, clockNow.toISOString()]);
        for (const [i, l] of pr.priced.entries()) {
          await c.query(
            `INSERT INTO core.order_line (tenant_id, id, outlet_id, order_id, line_no, item_id, variant_id, options, qty_milli, unit_price_minor, line_discount_minor, tax_minor)
             VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, NULL, '[]', $6, $7, $8, $9)`,
            [p.lines[i]!.line_id, p.outlet_id, p.order_id, i + 1, l.item_id, p.lines[i]!.qty_milli, l.unit, l.deal + l.coupon, l.tax]);
          for (const cid of l.couponIds) {
            await c.query(
              `INSERT INTO core.coupon_use (tenant_id, id, coupon_id, order_id, customer_id, discount_minor, currency, applied_by)
               VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, current_setting('app.customer_id')::uuid, $4, 'INR', current_setting('app.customer_id')::uuid)`,
              [uuidv7(), cid, p.order_id, l.coupon]);
          }
        }
        await c.query(
          `INSERT INTO core.order_event (tenant_id, id, outlet_id, order_id, kind, to_status, actor) VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, 'status', 'placed', $4)`,
          [uuidv7(), p.outlet_id, p.order_id, { kind: "customer" }]);
        if (p.pickup_window_id) await c.query(`UPDATE core.pickup_window SET booked = booked + 1 WHERE id = $1 AND booked < capacity_orders`, [p.pickup_window_id]);
        return { entityId: p.order_id, audit: [{ entity: "core.order", entityId: p.order_id, after: { status: "placed" } }] };
      },
    });
  },
  async ensureProfile(c, seed) {
    const p = c.var.principal as { kind: "customer"; tenant_id: string; customer_id: string; sub: string };
    seen.profiles.push(p.sub);
    const out = await withContext(pools.core, contextOf(p as never), (db) =>
      executeCommand({ tx: (fn) => fn(db), tenantId: p.tenant_id, actor: { kind: "customer", id: p.customer_id, role: "customer" } },
        { command_id: uuidv7(), idempotency_key: `link-${uuidv7()}`, type: "customers.account.link.v1", payload: seed }, {
          type: "customers.account.link.v1",
          async run(q) {
            const r = await q.query<{ id: string }>(
              `INSERT INTO core.customer (tenant_id, id, name, phone, idp_sub, is_guest) VALUES (current_setting('app.tenant_id')::uuid, current_setting('app.customer_id')::uuid, $1, $2, $3, false) RETURNING id`, [seed.name, seed.phone, p.sub]);
            return { entityId: r.rows[0]!.id, audit: [{ entity: "core.customer", entityId: r.rows[0]!.id, after: { is_guest: false } }] };
          },
        }));
    return (JSON.parse(out.body) as { entity_id: string }).entity_id;
  },
  async loyaltyReverseFor(_tx, order_id) {
    seen.reversed.push(order_id);
  },
};

// ─────────────────────────────────────── fixture ───────────────────────────────────────
beforeAll(async () => {
  db = await openDb();
  W = await buildTenant(db, "S");
  other = await buildTenant(db, "O");
  OUT = W.outlets[0];
  CH = uuidv7();
  ITEM2 = uuidv7();
  KEY = `sfk_P_${uuidv7().replaceAll("-", "")}${uuidv7().replaceAll("-", "")}`;
  win = { w1300: uuidv7(), full: uuidv7(), w1600: uuidv7(), w1630: uuidv7() };

  await db.withContext("munim_core", cmdCtx("tenancy.channel.create.v1"), (c) =>
    c.query(`INSERT INTO core.channel (tenant_id, id, name, kind) VALUES ($1, $2, 'Pickup', 'pickup')`, [W.tenant, CH]));
  await db.withContext("munim_core", ownerCtx(W), (c) =>
    c.query(`INSERT INTO core.storefront_key (tenant_id, id, channel_id, key_hash) VALUES ($1, $2, $3, $4)`, [W.tenant, uuidv7(), CH, createHash("sha256").update(KEY).digest("hex")]));
  await db.withContext("munim_core", cmdCtx("catalogue.item.upsert.v1"), async (c) => {
    await c.query(`INSERT INTO core.item (tenant_id, id, kind, name_key, category) VALUES ($1, $2, 'dish', 'menu.lassi', 'drinks')`, [W.tenant, ITEM2]);
  });
  await db.withContext("munim_core", cmdCtx("catalogue.price.set.v1"), async (c) => {
    await c.query(`INSERT INTO core.price (tenant_id, id, item_id, outlet_id, channel_kind, amount_minor, currency, tax_class, valid_from) VALUES ($1, $2, $3, $4, 'pickup', 32000, 'INR', 'restaurant_5', '2026-10-01')`, [W.tenant, uuidv7(), W.item, OUT]);
    await c.query(`INSERT INTO core.price (tenant_id, id, item_id, outlet_id, channel_kind, amount_minor, currency, tax_class, valid_from) VALUES ($1, $2, $3, $4, 'pickup', 8000, 'INR', 'restaurant_5', '2026-10-01')`, [W.tenant, uuidv7(), ITEM2, OUT]);
  });
  await db.withContext("munim_core", cmdCtx("catalogue.deal.upsert.v1"), (c) =>
    c.query(`INSERT INTO core.deal (tenant_id, id, kind, name_key, rule, windows, valid_from) VALUES ($1, $2, 'percent_off', 'deal.lunch_window', '{"bp": 1000}', $3, '2026-10-01')`,
      [W.tenant, uuidv7(), JSON.stringify([{ days: [0, 1, 2, 3, 4, 5, 6], from: "12:00", to: "15:00" }])]));
  await db.withContext("munim_core", cmdCtx("catalogue.coupon.set.v1"), async (c) => {
    const ins = (code: string, extra: string, args: unknown[]) =>
      c.query(`INSERT INTO core.coupon (tenant_id, id, code, kind, value_bp, currency, ${extra.split("|")[0]}) VALUES ($1, $2, $3, 'percent', 1000, 'INR', ${extra.split("|")[1]})`, [W.tenant, uuidv7(), code, ...args]);
    await ins("TENSPEND", "min_spend_minor, valid_from|100000, '2026-10-01'", []);
    await ins("CAPPED1", "global_cap, valid_from|1, '2026-10-01'", []);
    await ins("EXPIRED1", "valid_from, valid_to|'2026-09-01', '2026-10-05'", []);
  });
  // CAPPED1 has already been used once (the cap is 1): a coupon_use on the world's first order.
  await db.withContext("munim_core", cmdCtx("orders.place.v1"), (c) =>
    c.query(`INSERT INTO core.coupon_use (tenant_id, id, coupon_id, order_id, customer_id, discount_minor, currency, applied_by)
             SELECT $1, $2, id, $3, $4, 0, 'INR', $5 FROM core.coupon WHERE code = 'CAPPED1'`, [W.tenant, uuidv7(), W.orders[0], W.customer, W.owner]));
  await db.withContext("munim_core", cmdCtx("tenancy.outlet.create.v1"), async (c) => {
    for (const d of [0, 2, 3, 4, 5, 6])
      await c.query(`INSERT INTO core.outlet_calendar (tenant_id, id, outlet_id, kind, weekday, opens_at, closes_at) VALUES ($1, $2, $3, 'weekly', $4, '09:00', '22:00')`, [W.tenant, uuidv7(), OUT, d]);
    await c.query(`INSERT INTO core.outlet_calendar (tenant_id, id, outlet_id, kind, on_date, closed) VALUES ($1, $2, $3, 'override', '2026-10-20', true)`, [W.tenant, uuidv7(), OUT]);
  });
  await db.withContext("munim_core", ownerCtx(W), async (c) => {
    const ins = (id: string, from: string, to: string, cap: number, booked: number) =>
      c.query(`INSERT INTO core.pickup_window (tenant_id, id, outlet_id, starts_at, ends_at, capacity_orders, booked) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [W.tenant, id, OUT, from, to, cap, booked]);
    await ins(win.w1300, "2026-10-12T07:30:00Z", "2026-10-12T08:00:00Z", 100, 0); // 13:00–13:30 IST
    await ins(win.full, "2026-10-12T08:00:00Z", "2026-10-12T08:30:00Z", 1, 1); // 13:30–14:00 IST, full
    await ins(win.w1600, "2026-10-12T10:30:00Z", "2026-10-12T11:00:00Z", 100, 0); // 16:00–16:30
    await ins(win.w1630, "2026-10-12T11:00:00Z", "2026-10-12T11:30:00Z", 100, 0); // 16:30–17:00
  });
  // Migrator request, shimmed for the gate only (see header).
  await db.admin(
    `INSERT INTO core.command_authority (command_type, allowed_roles, scope, target_tables, customer_target_tables) VALUES
       ('storefront.order.cancel.v1', ARRAY['customer'], 'own_order', ARRAY['core.order', 'core.order_event'], ARRAY['core.order', 'core.order_event']),
       ('storefront.order.reschedule.v1', ARRAY['customer'], 'own_order', ARRAY['core.order', 'core.order_event'], ARRAY['core.order', 'core.order_event'])`);

  pools = { core: db.pool("munim_core", 6), svc: db.pool("munim_svc", 2) };
  const config = { nodeEnv: "test", redact: (s: string) => s };
  app = await createApp({ pools, idp, storefronts: storefrontResolver(pools.core), config, log: createLogger(config, () => {}) });
});
afterAll(async () => {
  resetStorefront();
  await pools.core.end();
  await pools.svc.end();
  await db.stop();
});
beforeEach(() => {
  clockNow = MON_1300;
  configureStorefront({ clock: () => clockNow, seams: fakeSeams });
  seen.placeChannels.length = 0;
});

// ─────────────────────────────────────── helpers ───────────────────────────────────────
const H = (extra: Record<string, string> = {}, key = KEY) => ({ "Content-Type": "application/json", [STOREFRONT_KEY_HEADER]: key, ...extra });
const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, key = KEY) =>
  app.request(path, { method, headers: H(headers, key), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const bearer = (sub: string) => ({ Authorization: `Bearer ${idp.sign({ sub })}` });
const GUEST = { name: "Test Guest", phone: "+919800000001", email: null, consent: { marketing: false, at: "2026-10-12T07:00:00.000Z" } };

function placeBody(over: Record<string, unknown> = {}, opts: { guest?: boolean; item?: string; key?: string } = {}) {
  const orderId = uuidv7();
  const key = opts.key ?? `place-${orderId}`;
  return {
    order_id: orderId,
    body: {
      order: {
        command_id: uuidv7(), idempotency_key: key, type: "orders.place.v1",
        payload: {
          order_id: orderId, outlet_id: OUT, channel_id: W.channel, brand_id: null, device_id: null, kind: "pickup", table_ref: null,
          pickup_window_id: win.w1300, promised_at: P_1300, external_ref: null,
          lines: [{ line_id: uuidv7(), item_id: opts.item ?? W.item, variant_id: null, option_ids: [], qty_milli: 1000, barcode: null, note: null }],
          coupon_codes: [], loyalty_redeem_points: 0, preview_total_minor: null, client_totals: null,
          ...over,
        },
      },
      contact: opts.guest === false ? { name: "Signed In", phone: null } : null,
      guest: opts.guest === false ? null : { command_id: uuidv7(), idempotency_key: `guest-${orderId}`, type: "storefront.guest.create.v1", payload: GUEST },
    },
  };
}
const place = async (over: Record<string, unknown> = {}, opts: Parameters<typeof placeBody>[1] = {}, headers: Record<string, string> = {}) => {
  const b = placeBody(over, opts);
  const res = await call("POST", "/v1/storefront/orders", b.body, headers);
  return { res, id: b.order_id, body: (await res.clone().json()) as Record<string, any> };
};
const orderRow = async (id: string) => (await db.admin(`SELECT * FROM core."order" WHERE id = $1`, [id])).rows[0]!;
const reason = (b: Record<string, any>) => b.error?.reason_code;

// ─────────────────────────────────────── gates ───────────────────────────────────────
describe("keys and public reads", () => {
  it("a bad key, and a key on a counter channel, are 404 — never 403", async () => {
    expect((await call("GET", "/v1/storefront/outlets", undefined, {}, "sfk_not_a_real_key_0000000000000000")).status).toBe(404);
    expect((await call("GET", `/v1/storefront/outlets/${OUT}/menu`, undefined, {}, W.storefrontKey)).status).toBe(404); // bound to the counter channel
  });

  it("menu: priced for the key's channel kind, availability per outlet, the deal, the accepting state, pay at the counter", async () => {
    await db.withContext("munim_core", cmdCtx("catalogue.availability.set.v1"), (c) =>
      c.query(`INSERT INTO core.item_availability (tenant_id, id, outlet_id, item_id, available, updated_by) VALUES ($1, $2, $3, $4, false, $5)`, [W.tenant, uuidv7(), OUT, ITEM2, W.owner]));
    const res = await call("GET", `/v1/storefront/outlets/${OUT}/menu`);
    expect(res.status).toBe(200);
    const m = (await res.json()) as any;
    expect(m.channel_kind).toBe("pickup");
    expect(m.pay_at_counter).toBe(true);
    expect(m.items.map((i: any) => [i.name_key, i.price_minor, i.available])).toEqual([["menu.lassi", 8000, false], ["menu.paneer_tikka", 32000, true]]);
    expect(m.deals.map((d: any) => d.name_key).sort()).toEqual(["deal.lunch", "deal.lunch_window"]);
    expect(m.accepting).toMatchObject({ state: "open", busy_extra_min: 0, default_prep_min: 15, next_open: null });
    await db.admin(`DELETE FROM core.item_availability WHERE item_id = $1`, [ITEM2]);
  });

  it("accepting state: busy shows +N, paused has no resume time, after hours is closed with the next opening (calendar)", async () => {
    const setOutlet = (state: string, extra: number) => db.withContext("munim_core", cmdCtx("tenancy.outlet.create.v1"), (c) =>
      c.query(`UPDATE core.outlet SET accepting_orders = $2, busy_extra_min = $3 WHERE id = $1`, [OUT, state, extra]));
    const st = async () => ((await (await call("GET", `/v1/storefront/outlets/${OUT}/state`)).json()) as any);
    await setOutlet("busy", 10);
    expect(await st()).toMatchObject({ state: "busy", busy_extra_min: 10 });
    await setOutlet("paused", 0);
    expect(await st()).toMatchObject({ state: "paused", next_open: null });
    await setOutlet("open", 0);
    expect((await st()).state).toBe("open");
    clockNow = new Date("2026-10-12T17:30:00Z"); // Mon 23:00 IST
    expect(await st()).toMatchObject({ state: "closed", next_open: "2026-10-13T03:30:00.000Z" });
  });

  it("pickup windows: the full window is hidden, windows with spare capacity are listed with their row fields", async () => {
    const r = (await (await call("GET", `/v1/storefront/outlets/${OUT}/pickup-windows`)).json()) as any;
    const ids = r.windows.map((w: any) => w.pickup_window_id);
    expect(ids).toContain(win.w1300);
    expect(ids).not.toContain(win.full);
    expect(r.windows.find((w: any) => w.pickup_window_id === win.w1300)).toMatchObject({ capacity_orders: 100 });
  });
});

describe("guest checkout", () => {
  it("happy path: one request creates the guest and the order; the key's channel wins; client totals are ignored; Pay at the counter", async () => {
    const { res, id, body } = await place({
      channel_id: W.channel, // a payload channel (the counter channel) must be ignored
      client_totals: { subtotal: { amount_minor: 1, currency: "INR" }, total: { amount_minor: 1, currency: "INR" } }, // tampered
    });
    expect(res.status).toBe(201);
    expect(body).toMatchObject({ order_id: id, status: "placed", total_minor: 30240, currency: "INR", pay_at_counter: true });
    expect(body.ticket_no).toBeGreaterThanOrEqual(1);
    expect(typeof body.guest_access_token).toBe("string");
    const row = await orderRow(id);
    expect(body.ticket_no).toBe(row.ticket_no); // the response is the row's own field
    expect(row.channel_id).toBe(CH); // the key's channel
    expect(seen.placeChannels).toEqual([CH]); // and placeOrder was handed the key's channel
    expect(Number(row.total_minor)).toBe(30240); // not the tampered 1
    expect(row.client_totals).toMatchObject({ total: { amount_minor: 1 } }); // recorded only, for tamper detection
    expect(row.guest_access_hash.equals(createHash("sha256").update(body.guest_access_token).digest())).toBe(true);
    const cust = (await db.admin(`SELECT is_guest, name, phone FROM core.customer WHERE id = $1`, [row.customer_id])).rows[0]!;
    expect(cust).toEqual({ is_guest: true, name: "Test Guest", phone: "+919800000001" });
    const log = await db.admin(`SELECT command_type FROM core.command_log WHERE tenant_id = $1 AND command_id = ANY ($2) ORDER BY command_type`, [W.tenant, [(res as unknown as never) && id]]);
    void log;
    const window = (await db.admin(`SELECT booked FROM core.pickup_window WHERE id = $1`, [win.w1300])).rows[0]!;
    expect(window.booked).toBeGreaterThanOrEqual(1);
  });

  it("an unknown extra field such as a client price is refused, not silently trusted", async () => {
    const b = placeBody();
    (b.body.order.payload.lines[0] as Record<string, unknown>).unit_price_minor = 1;
    expect((await call("POST", "/v1/storefront/orders", b.body)).status).toBe(400);
    expect(await db.admin(`SELECT 1 FROM core."order" WHERE id = $1`, [b.order_id]).then((r) => r.rowCount)).toBe(0);
  });

  it("a refused placement leaves no guest customer behind (one transaction)", async () => {
    const b = placeBody({ pickup_window_id: win.full });
    const before = Number((await db.admin(`SELECT count(*) AS n FROM core.customer WHERE tenant_id = $1`, [W.tenant])).rows[0]!.n);
    expect((await call("POST", "/v1/storefront/orders", b.body)).status).toBe(409);
    expect(Number((await db.admin(`SELECT count(*) AS n FROM core.customer WHERE tenant_id = $1`, [W.tenant])).rows[0]!.n)).toBe(before);
  });

  it("a retry of the same request replays: same order, 201 + X-Munim-Replayed, no second token, no second order", async () => {
    const b = placeBody();
    const first = await call("POST", "/v1/storefront/orders", b.body);
    const again = await call("POST", "/v1/storefront/orders", b.body);
    expect(first.status).toBe(201);
    expect(again.status).toBe(201);
    expect(again.headers.get("X-Munim-Replayed")).toBe("true");
    expect(((await again.json()) as any).guest_access_token).toBeNull();
    expect(Number((await db.admin(`SELECT count(*) AS n FROM core."order" WHERE id = $1`, [b.order_id])).rows[0]!.n)).toBe(1);
  });

  it("signed-in and guest blocks must match the caller: a guest block with a token, or no guest block anonymously, is 400", async () => {
    expect((await call("POST", "/v1/storefront/orders", placeBody({}, { guest: false }).body)).status).toBe(400);
    expect((await call("POST", "/v1/storefront/orders", placeBody().body, bearer("sub-x"))).status).toBe(400);
  });
});

describe("refusals: each code, paired with an accept", () => {
  it("window_full → 409 window_full; a window with room is accepted", async () => {
    const full = await place({ pickup_window_id: win.full, promised_at: "2026-10-12T08:00:00.000Z" });
    expect(full.res.status).toBe(409);
    expect(reason(full.body)).toBe("window_full");
    expect((await place({ pickup_window_id: win.w1300 })).res.status).toBe(201);
  });

  it("outlet_paused (live toggle) → outlet_paused; calendar closed (after hours, and a dated holiday) → outlet_paused; open → accepted", async () => {
    const set = (s: string) => db.withContext("munim_core", cmdCtx("tenancy.outlet.create.v1"), (c) => c.query(`UPDATE core.outlet SET accepting_orders = $2 WHERE id = $1`, [OUT, s]));
    await set("paused");
    expect(reason((await place()).body)).toBe("outlet_paused");
    await set("open");
    clockNow = new Date("2026-10-12T17:30:00Z"); // Mon 23:00 IST, now closed
    expect(reason((await place({ pickup_window_id: null })).body)).toBe("outlet_paused");
    clockNow = MON_1300;
    expect(reason((await place({ pickup_window_id: null, promised_at: P_HOLIDAY })).body)).toBe("outlet_paused"); // 20 Oct override: closed
    expect((await place()).res.status).toBe(201);
  });

  it("item_sold_out → item_sold_out; an available item is accepted", async () => {
    await db.withContext("munim_core", cmdCtx("catalogue.availability.set.v1"), (c) =>
      c.query(`INSERT INTO core.item_availability (tenant_id, id, outlet_id, item_id, available, updated_by) VALUES ($1, $2, $3, $4, false, $5)`, [W.tenant, uuidv7(), OUT, ITEM2, W.owner]));
    expect(reason((await place({}, { item: ITEM2 })).body)).toBe("item_sold_out");
    expect((await place()).res.status).toBe(201);
    await db.admin(`DELETE FROM core.item_availability WHERE item_id = $1`, [ITEM2]);
  });

  it("coupons presented reach the pricing: expired/unknown → coupon_invalid, spent cap → coupon_cap_reached, below minimum → coupon_min_spend; WELCOME10 accepted (27216)", async () => {
    expect(reason((await place({ coupon_codes: ["EXPIRED1"] })).body)).toBe("coupon_invalid");
    expect(reason((await place({ coupon_codes: ["NOSUCH1"] })).body)).toBe("coupon_invalid");
    expect(reason((await place({ coupon_codes: ["CAPPED1"] })).body)).toBe("coupon_cap_reached");
    expect(reason((await place({ coupon_codes: ["TENSPEND"] })).body)).toBe("coupon_min_spend");
    const ok = await place({ coupon_codes: ["WELCOME10"] });
    expect(ok.res.status).toBe(201);
    expect(ok.body.total_minor).toBe(27216);
    expect(Number((await db.admin(`SELECT count(*) AS n FROM core.coupon_use WHERE order_id = $1`, [ok.id])).rows[0]!.n)).toBe(1);
  });

  it("preview: same price, labelled preview, writes nothing, and carries the storefront's own refusals", async () => {
    const before = Number((await db.admin(`SELECT count(*) AS n FROM core."order" WHERE tenant_id = $1`, [W.tenant])).rows[0]!.n);
    const req = { outlet_id: OUT, channel_id: W.channel, brand_id: null, kind: "pickup", pickup_window_id: win.full, promised_at: P_1300, coupon_codes: [], loyalty_redeem_points: 0,
      lines: [{ item_id: W.item, variant_id: null, option_ids: [], qty_milli: 1000, barcode: null }] };
    const r = (await (await call("POST", "/v1/storefront/orders:preview", req)).json()) as any;
    expect(r).toMatchObject({ label: "preview", total_minor: 30240, tax_minor: 1440, discount_minor: 3200 });
    expect(r.refusals).toEqual([{ line_no: null, reason_code: "window_full" }]);
    expect(Number((await db.admin(`SELECT count(*) AS n FROM core."order" WHERE tenant_id = $1`, [W.tenant])).rows[0]!.n)).toBe(before);
  });
});

describe("guest isolation and the tracker read", () => {
  it("a guest reads only their own order; another guest's order, no token, a made-up token and another tenant's order are all 404", async () => {
    const a = await place();
    const b = await place();
    const own = await call("GET", `/v1/storefront/orders/${a.id}`, undefined, { [GUEST_TOKEN_HEADER]: a.body.guest_access_token });
    expect(own.status).toBe(200);
    const view = (await own.json()) as any;
    expect(view).toMatchObject({ order_id: a.id, status: "placed", total_minor: 30240, pay_at_counter: true, cancel_window_min: 5, reschedule_window_min: 30 });
    expect(view.lines).toHaveLength(1);
    expect(view.events[0]).toMatchObject({ kind: "status", to_status: "placed" });
    expect(JSON.stringify(view)).not.toMatch(/guest_access|customer_id|phone/);
    expect((await call("GET", `/v1/storefront/orders/${b.id}`, undefined, { [GUEST_TOKEN_HEADER]: a.body.guest_access_token })).status).toBe(404);
    expect((await call("GET", `/v1/storefront/orders/${a.id}`)).status).toBe(404);
    expect((await call("GET", `/v1/storefront/orders/${a.id}`, undefined, { [GUEST_TOKEN_HEADER]: "x".repeat(43) })).status).toBe(404);
    expect((await call("GET", `/v1/storefront/orders/${a.id}`, undefined, { [GUEST_TOKEN_HEADER]: a.body.guest_access_token }, other.storefrontKey)).status).toBe(404);
  });

  it("a guest cannot cancel or reschedule (a guest context writes nothing): 403, the order is untouched", async () => {
    const a = await place();
    const cancel = { command_id: uuidv7(), idempotency_key: `cx-${a.id}`, type: "storefront.order.cancel.v1", payload: { order_id: a.id, reason: null } };
    expect((await call("POST", `/v1/storefront/orders/${a.id}:cancel`, cancel, { [GUEST_TOKEN_HEADER]: a.body.guest_access_token })).status).toBe(403);
    expect((await orderRow(a.id)).status).toBe("placed");
  });
});

describe("signed-in checkout, cancel, reschedule", () => {
  const SUB = "shopper-sub-1";
  let mine: string;

  it("first sign-in checkout creates the profile through ensureProfile; no guest token; the order is theirs alone", async () => {
    const r = await place({}, { guest: false }, bearer(SUB));
    expect(r.res.status).toBe(201);
    expect(r.body.guest_access_token).toBeNull();
    expect(seen.profiles).toContain(SUB);
    mine = r.id;
    const row = await orderRow(mine);
    const cust = (await db.admin(`SELECT idp_sub, is_guest FROM core.customer WHERE id = $1`, [row.customer_id])).rows[0]!;
    expect(cust).toEqual({ idp_sub: SUB, is_guest: false });
    expect((await call("GET", `/v1/storefront/orders/${mine}`, undefined, bearer(SUB))).status).toBe(200);
    // someone else signed in cannot see it, nor can an anonymous caller
    expect((await call("GET", `/v1/storefront/orders/${mine}`, undefined, bearer("shopper-sub-2"))).status).toBe(404);
    expect((await call("GET", `/v1/storefront/orders/${mine}`)).status).toBe(404);
  });

  const cancelCmd = (id: string) => ({ command_id: uuidv7(), idempotency_key: `cancel-${id}-${uuidv7()}`, type: "storefront.order.cancel.v1", payload: { order_id: id, reason: null } });

  it("cancel: after the 5-minute window → change_window_closed and nothing changes; inside it → cancelled, window released, loyalty reversal called, event written", async () => {
    const r = await place({ pickup_window_id: win.w1600, promised_at: P_1600 }, { guest: false }, bearer(SUB));
    const id = r.id;
    const bookedBefore = (await db.admin(`SELECT booked FROM core.pickup_window WHERE id = $1`, [win.w1600])).rows[0]!.booked;
    clockNow = new Date(MON_1300.getTime() + 6 * 60_000);
    const late = await call("POST", `/v1/storefront/orders/${id}:cancel`, cancelCmd(id), bearer(SUB));
    expect(late.status).toBe(409);
    expect(reason((await late.json()) as any)).toBe("change_window_closed");
    expect((await orderRow(id)).status).toBe("placed");
    clockNow = new Date(MON_1300.getTime() + 4 * 60_000);
    const ok = await call("POST", `/v1/storefront/orders/${id}:cancel`, cancelCmd(id), bearer(SUB));
    expect(ok.status).toBe(200);
    expect((await orderRow(id)).status).toBe("cancelled");
    expect((await db.admin(`SELECT booked FROM core.pickup_window WHERE id = $1`, [win.w1600])).rows[0]!.booked).toBe(bookedBefore - 1);
    expect(seen.reversed).toEqual([id]);
    const ev = await db.admin(`SELECT from_status, to_status, actor FROM core.order_event WHERE order_id = $1 AND to_status = 'cancelled'`, [id]);
    expect(ev.rows).toHaveLength(1);
    // another customer cannot cancel it
    expect((await call("POST", `/v1/storefront/orders/${id}:cancel`, cancelCmd(id), bearer("shopper-sub-2"))).status).toBe(404);
  });

  it("reschedule re-prices a time-boxed deal: 13:00 (deal) → 16:00 costs 33600; a stale total is refused deal_rejudged; the confirmed total commits", async () => {
    const r = await place({ pickup_window_id: win.w1300, promised_at: P_1300 }, { guest: false }, bearer(SUB));
    const id = r.id;
    expect(r.body.total_minor).toBe(30240);
    clockNow = new Date(MON_1300.getTime() + 2 * 60_000);
    const pv = (await (await call("POST", `/v1/storefront/orders/${id}:reschedule-preview`, { pickup_window_id: win.w1600, promised_at: P_1600 }, bearer(SUB))).json()) as any;
    expect(pv.current_total_minor).toBe(30240);
    expect(pv.preview).toMatchObject({ total_minor: 33600, discount_minor: 0, tax_minor: 1600, refusals: [] });
    expect((await orderRow(id)).total_minor).toBe("30240"); // preview wrote nothing
    const body = (total: number) => ({ command_id: uuidv7(), idempotency_key: `rs-${id}-${uuidv7()}`, type: "storefront.order.reschedule.v1",
      payload: { order_id: id, pickup_window_id: win.w1600, promised_at: P_1600, preview_total_minor: total } });
    const stale = await call("POST", `/v1/storefront/orders/${id}:reschedule`, body(30240), bearer(SUB));
    expect(stale.status).toBe(409);
    expect(reason((await stale.json()) as any)).toBe("deal_rejudged");
    expect((await orderRow(id)).total_minor).toBe("30240");
    const ok = await call("POST", `/v1/storefront/orders/${id}:reschedule`, body(33600), bearer(SUB));
    expect(ok.status).toBe(200);
    const row = await orderRow(id);
    expect([row.subtotal_minor, row.discount_minor, row.tax_minor, row.total_minor]).toEqual(["32000", "0", "1600", "33600"]);
    expect(new Date(row.promised_at).toISOString()).toBe(P_1600);
    expect(row.pickup_window_id).toBe(win.w1600);
    const ev = (await db.admin(`SELECT to_promised_at, reason FROM core.order_event WHERE order_id = $1 AND kind = 'promised_at'`, [id])).rows;
    expect(ev).toHaveLength(1);
    expect(ev[0]!.reason).toBe("customer_rescheduled");
    // after the 30-minute reschedule window the same change is refused
    clockNow = new Date(MON_1300.getTime() + 31 * 60_000);
    const late = await call("POST", `/v1/storefront/orders/${id}:reschedule`, body(33600), bearer(SUB));
    expect(reason((await late.json()) as any)).toBe("change_window_closed");
  });
});
