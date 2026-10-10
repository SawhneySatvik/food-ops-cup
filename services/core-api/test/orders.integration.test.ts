// T-022 × landed seams (evidence for T-034, not a hand-value gate): the same placement → completion path with NO
// fakes — catalogue priceLines, inventory picks / consumption, customers loyalty, finance postFor and kitchen
// tickets as their lanes wrote them. Asserts which derived rows exist and under which rule, plus the pairing (#80).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeCommand } from "../src/commit/index.ts";
import { contextOf } from "../src/auth/resolve.ts";
import { withContext } from "../src/lib/db.ts";
import { orderStatusHandler } from "../src/modules/orders/lifecycle.ts";
import { placeOrder } from "../src/modules/orders/place.ts";
import { pickSaleBatches } from "../src/modules/inventory/index.ts";
import { PACKS } from "@munim/contracts/packs";
import { seedChart } from "../src/modules/finance/index.ts";
import { type Env, placePayload, startEnv, uuidv7 } from "./orders.kit.ts";

let env: Env;
beforeAll(async () => {
  env = await startEnv("IN");
  // The world seeds only cash + sales; finance posts against the pack's full chart (seeded at provisioning).
  await env.db.withContext("munim_core", { tenant_id: env.w.tenant, outlet_ids: "*", role: "owner", member_id: env.w.owner, command_type: "finance.account.upsert.v1" },
    (c) => seedChart(c, PACKS.IN));
});
afterAll(async () => env?.stop());

describe("orders over the landed seams (no fakes)", () => {
  it("customer pickup order with a redemption → completed: consumption, earn, the sale entry and kitchen tickets all derived", async () => {
    await env.db.withContext("munim_core", { tenant_id: env.w.tenant, outlet_ids: "*", role: "owner", member_id: env.w.owner, command_type: "catalogue.price.set.v1" }, (c) =>
      c.query(`INSERT INTO core.price (tenant_id, id, item_id, outlet_id, channel_kind, amount_minor, currency, tax_class, valid_from) VALUES ($1, $2, $3, $4, 'pickup', 32000, 'INR', 'restaurant_5', '2026-01-01')`,
        [env.w.tenant, uuidv7(), env.menu.paneer, env.w.outlets[0]]));
    const principal = { kind: "customer" as const, tenant_id: env.w.tenant, channel_id: env.menu.pickupChannel, customer_id: env.w.customer, profile: true, sub: "cust-sub" };
    const payload = placePayload(env, [{ item: env.menu.paneer }, { item: env.menu.biscuits, qty: 2000 }],
      { channel_id: env.menu.pickupChannel, device_id: null, kind: "pickup", loyalty_redeem_points: 20 });
    await placeOrder({ deps: { pools: env.pools, log: () => {} }, principal }, { command_id: uuidv7(), idempotency_key: `k-${uuidv7()}`, type: "orders.place.v1", payload });
    const id = payload.order_id;
    const o = await env.one<{ total_minor: string; snap: any }>(`SELECT total_minor, pricing_snapshot AS snap FROM core."order" WHERE id = $1`, [id]);
    expect(Number(o.total_minor)).toBe(39500);
    expect(o.snap.loyalty.points).toBe(20);
    for (const [a, b] of [["placed", "accepted"], ["accepted", "preparing"], ["preparing", "ready"], ["ready", "completed"]]) {
      await executeCommand({ tx: (fn) => withContext(env.pools.core, { tenant_id: env.w.tenant, outlet_ids: [env.w.outlets[0]], role: "staff", member_id: env.w.staff }, fn),
        tenantId: env.w.tenant, actor: { kind: "member", id: env.w.staff, role: "staff" } },
        { command_id: uuidv7(), idempotency_key: `k-${uuidv7()}`, type: "kitchen.ticket.advance.v1", payload: { order_id: id, from_status: a, to_status: b, reason_code: null } },
        orderStatusHandler("kitchen.ticket.advance.v1"));
    }
    const rules = async (sql: string) => (await env.rows<{ r: string }>(sql, [id])).map((x) => x.r).sort();
    expect(await rules(`SELECT DISTINCT origin ->> 'rule_id' AS r FROM core.stock_movement WHERE ref_id = $1`)).toEqual(["inventory.consume_order", "inventory.consume_sku"]);
    expect(await rules(`SELECT kind || ':' || coalesce(origin ->> 'rule_id', origin ->> 'kind') AS r FROM core.loyalty_entry WHERE order_id = $1`))
      .toEqual(["earn:customers.loyalty_earn", "redeem:command"]);
    expect(await rules(`SELECT DISTINCT origin ->> 'rule_id' AS r FROM core.journal_entry WHERE source_id = $1`)).toEqual(["finance.post_loyalty_redemption", "finance.post_order"]);
    expect(Number((await env.one<{ n: string }>(`SELECT count(*) AS n FROM core.kitchen_ticket WHERE order_id = $1`, [id])).n)).toBeGreaterThanOrEqual(1);
    const ev = await env.one<{ n: string }>(`SELECT count(*) AS n FROM core.order_event WHERE order_id = $1`, [id]);
    const ob = await env.one<{ n: string }>(`SELECT count(*) AS n FROM core.outbox WHERE aggregateid = $1 AND type LIKE 'munim.orders.order.%'`, [id]);
    expect(Number(ob.n)).toBe(Number(ev.n));
  });

  it("W2 B5 on the real seams: the customer's own cancel (storefront.order.cancel.v1) gives back the 20 redeemed points and the 2 biscuits", async () => {
    const principal = { kind: "customer" as const, tenant_id: env.w.tenant, channel_id: env.menu.pickupChannel, customer_id: env.w.customer, profile: true, sub: "cust-sub" };
    const payload = placePayload(env, [{ item: env.menu.biscuits, qty: 2000 }], { channel_id: env.menu.pickupChannel, device_id: null, kind: "pickup", loyalty_redeem_points: 20 });
    await placeOrder({ deps: { pools: env.pools, log: () => {} }, principal }, { command_id: uuidv7(), idempotency_key: `k-${uuidv7()}`, type: "orders.place.v1", payload });
    const id = payload.order_id;
    await executeCommand({ tx: (fn) => withContext(env.pools.core, contextOf(principal), fn), tenantId: env.w.tenant, actor: { kind: "customer", id: env.w.customer, role: "customer" } },
      { command_id: uuidv7(), idempotency_key: `k-${uuidv7()}`, type: "storefront.order.cancel.v1", payload: { order_id: id, from_status: "placed", to_status: "cancelled", reason_code: "customer_cancelled" } },
      orderStatusHandler("storefront.order.cancel.v1"));
    // Hand: redeemed −20 at placement, +20 back under the reversal rule.
    const pts = await env.rows<{ kind: string; points: number; rule: string | null }>(
      `SELECT kind, points::int AS points, origin ->> 'rule_id' AS rule FROM core.loyalty_entry WHERE order_id = $1 ORDER BY seq`, [id]);
    expect(pts).toEqual([{ kind: "redeem", points: -20, rule: null }, { kind: "reverse", points: 20, rule: "customers.loyalty_reverse" }]);
    // Hand: 2 biscuits (2000 pc) consumed, the same 2000 returned on the same batch.
    const moves = await env.rows<{ kind: string; qty: number; rule: string }>(
      `SELECT kind, qty_milli::int AS qty, origin ->> 'rule_id' AS rule FROM core.stock_movement WHERE ref_id = $1 ORDER BY qty_milli`, [id]);
    expect(moves).toEqual([{ kind: "sale_consumption", qty: -2000, rule: "inventory.consume_sku" }, { kind: "sale_return", qty: 2000, rule: "inventory.reverse_order_consumption" }]);
  });

  it("C7 with the pack flag on (test clone only): expired-only stock is refused without an override; a manager's override bound to the cart line is consumed once at placement and cited by the movement", async () => {
    await env.db.admin(`UPDATE platform.country_pack SET doc = jsonb_set(doc, '{expired_sale_override}', 'true') WHERE code = 'IN'`);
    const batch = (await env.one<{ id: string }>(`SELECT id FROM core.batch WHERE batch_code = 'JUI-OLD'`)).id;
    const without = placePayload(env, [{ item: env.menu.juice }]);
    const r0 = await env.cmd("/v1/orders", "mgr1", "orders.place.v1", without);
    expect([r0.status, (await r0.json()).error.reason_code]).toEqual([409, "expired_batch"]);
    const p = placePayload(env, [{ item: env.menu.juice }]);
    const override = uuidv7();
    await env.db.withContext("munim_core", { tenant_id: env.w.tenant, outlet_ids: [env.w.outlets[0]], role: "manager", member_id: env.ids.mgr1, command_type: "inventory.expired_sale.override.v1" }, (c) =>
      c.query(`INSERT INTO core.expired_sale_override (tenant_id, id, outlet_id, cart_line_id, batch_id, qty_milli, reason_code, note, decided_by)
               VALUES ($1, $2, $3, $4, $5, 1000, 'staff_meal', 'checked, sealed', $6)`, [env.w.tenant, override, env.w.outlets[0], p.lines[0]!.line_id, batch, env.ids.mgr1]));
    // Re-presenting a cart line to inventory's FEFO pick (the seam placement uses): before the sale the override
    // covers it (control); after it, the consumed override no longer does (R3-m4).
    const present = () => env.db.withContext("munim_core", { tenant_id: env.w.tenant, outlet_ids: [env.w.outlets[0]], role: "manager", member_id: env.ids.mgr1 }, (c) =>
      pickSaleBatches(c, env.w.outlets[0]!, [{ line_no: 1, line_id: p.lines[0]!.line_id, item_id: env.menu.juice, qty_milli: 1000 }]));
    const covered = await present();
    expect([covered.picks.map((k) => [k.expired, k.override_id]), covered.refusals]).toEqual([[[true, override]], []]);
    const r1 = await env.cmd("/v1/orders", "mgr1", "orders.place.v1", p);
    expect(r1.status).toBe(201);
    const o = await env.one<{ used: boolean; line: string }>(`SELECT used_at IS NOT NULL AS used, order_line_id AS line FROM core.expired_sale_override WHERE id = $1`, [override]);
    expect(o).toEqual({ used: true, line: p.lines[0]!.line_id });
    // R1-M2: the override's use is audited in the placement's own command.
    expect(await env.rows(`SELECT action, after FROM core.audit_log WHERE entity = 'core.expired_sale_override' AND entity_id = $1`, [override]))
      .toEqual([{ action: "orders.place.v1", after: { used: true, order_id: p.order_id } }]);
    const m = await env.rows<{ o: string; b: string }>(`SELECT expired_sale_override_id AS o, batch_id AS b FROM core.stock_movement WHERE ref_id = $1`, [p.order_id]);
    expect(m).toEqual([{ o: override, b: batch }]);
    // Single use: the consumed override, re-presented on its own cart line, covers nothing any more.
    const again = await present();
    expect([again.picks, again.refusals.map((r) => r.reason_code)]).toEqual([[], ["expired_batch"]]);
  });
});
