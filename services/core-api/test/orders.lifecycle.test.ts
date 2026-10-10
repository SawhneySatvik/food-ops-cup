// T-022 gates — order lifecycle and money: status moves (conditional, min_role, #80 pairing), completion
// derivations, MB001 (a kitchen command cannot change money), push-back re-judging deals, tenders and cash
// rounding, voids, refunds within authority, shift close variance, receipts (IN tax invoice, Sec 9(5) record).
// Every expected value is hand-written. Seams: the REAL owners' functions (R3-M3) — catalogue pricing, inventory
// FEFO / consumption, customers loyalty (world policy: 1 point per 1000 of net, a point worth 10), finance postings
// and kitchen tickets.
import { OrderView, ReceiptView, ShiftView } from "@munim/contracts/orders";
import { localTime } from "@munim/core-domain/tz";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executeCommand, verifyAuditChain } from "../src/commit/index.ts";
import { svcTx } from "../src/commit/testkit.ts";
import { withContext } from "../src/lib/db.ts";
import { orderStatusHandler } from "../src/modules/orders/lifecycle.ts";
import { placeOrder } from "../src/modules/orders/place.ts";
import { type Env, placePayload, startEnv, uuidv7, type Who } from "./orders.kit.ts";

let env: Env;
beforeAll(async () => {
  env = await startEnv("IN");
});
afterAll(async () => env?.stop());

const ROLE: Record<Who, "owner" | "manager" | "staff"> = { owner: "owner", staff: "staff", mgr1: "manager", mgr2: "manager" };
const scope = (who: Who) => (who === "owner" ? ("*" as const) : who === "mgr2" ? [env.w.outlets[1]] : [env.w.outlets[0]]);
const ctxOf = (who: Who) => ({ tenant_id: env.w.tenant, outlet_ids: scope(who), role: ROLE[who], member_id: env.ids[who] });

/** Order status moves run under kitchen.ticket.advance.v1 — the one seeded command writing core.order +
 *  core.order_event (#41); no orders.* status command is seeded yet. */
async function advance(who: Who, order_id: string, from_status: string, to_status: string, reason_code: string | null = null) {
  try {
    await executeCommand({ tx: (fn) => withContext(env.pools.core, ctxOf(who), fn), tenantId: env.w.tenant, actor: { kind: "member", id: env.ids[who], role: ROLE[who] } },
      { command_id: uuidv7(), idempotency_key: `k-${uuidv7()}`, type: "kitchen.ticket.advance.v1", payload: { order_id, from_status, to_status, reason_code } },
      orderStatusHandler("kitchen.ticket.advance.v1"));
    return "ok";
  } catch (e: any) {
    return e.code ?? e.message;
  }
}

async function place(who: Who, lines: Parameters<typeof placePayload>[1], extra: Record<string, unknown> = {}) {
  const p = placePayload(env, lines, extra);
  const r = await env.cmd("/v1/orders", who, "orders.place.v1", p);
  expect(r.status).toBe(201);
  return p.order_id;
}
/** Orders the gates changed with raw SQL probes (MB001), excluded from the clause-1 audit scan by name. */
const rawFixtureWrites: string[] = [];
const n = async (sql: string, params: unknown[]) => Number((await env.one<{ n: string }>(sql, params)).n);

describe("status moves (rule 10)", () => {
  it("follow the transition table, conditional on the current status; each order_event is paired with an outbox event (#80)", async () => {
    const id = await place("staff", [{ item: env.menu.coffee }]);
    expect(await advance("staff", id, "placed", "ready")).toBe("illegal_transition");
    expect(await advance("staff", id, "accepted", "preparing")).toBe("illegal_transition");
    expect(await advance("staff", id, "placed", "accepted")).toBe("ok");
    expect(await advance("staff", id, "placed", "accepted")).toBe("illegal_transition");
    expect(await advance("staff", id, "accepted", "preparing")).toBe("ok");
    expect(await advance("staff", id, "preparing", "ready")).toBe("ok");
    expect(await advance("staff", id, "ready", "completed")).toBe("ok");
    const events = await env.rows<{ from_status: string | null; to_status: string }>(`SELECT from_status, to_status FROM core.order_event WHERE order_id = $1 ORDER BY seq`, [id]);
    expect(events.map((e) => `${e.from_status}>${e.to_status}`)).toEqual(["null>placed", "placed>accepted", "accepted>preparing", "preparing>ready", "ready>completed"]);
    const outbox = await env.rows<{ type: string }>(`SELECT type FROM core.outbox WHERE aggregateid = $1 AND type LIKE 'munim.orders.order.%' ORDER BY seq`, [id]);
    expect(outbox.map((o) => o.type)).toEqual(["munim.orders.order.placed.v1", ...Array(4).fill("munim.orders.order.status_changed.v1")]);
    expect(await advance("staff", id, "completed", "cancelled")).toBe("illegal_transition");
  });

  it("reject and cancel need a reason; an outlet-2 manager cannot move an outlet-1 order (404)", async () => {
    const id = await place("staff", [{ item: env.menu.coffee }]);
    expect(await advance("staff", id, "placed", "rejected")).toBe("invalid_payload");
    expect(await advance("mgr2", id, "placed", "accepted")).toBe("not_found");
    expect(await advance("staff", id, "placed", "rejected", "too_busy")).toBe("ok");
    expect((await env.one<{ reason: string }>(`SELECT reason FROM core.order_event WHERE order_id = $1 AND to_status = 'rejected'`, [id])).reason).toBe("too_busy");
  });
});

describe("MB001: a kitchen command cannot change money", () => {
  it("under kitchen.ticket.advance.v1 a total / snapshot change is refused with MB001; a status-only change under it and a money change under orders.reprice are admitted", async () => {
    const id = await place("staff", [{ item: env.menu.coffee }]);
    rawFixtureWrites.push(id); // raw SQL below is the gate's own probe, not the orders path: no audit entry
    const ctx = { ...ctxOf("staff"), command_type: "kitchen.ticket.advance.v1" };
    const err = async (sql: string) => {
      try {
        await env.db.withContext("munim_core", ctx, (c) => c.query(sql, [id]));
        return "ok";
      } catch (e: any) {
        return e.code;
      }
    };
    expect(await err(`UPDATE core."order" SET total_minor = 1, subtotal_minor = 1, tax_minor = 0 WHERE id = $1`)).toBe("MB001");
    expect(await err(`UPDATE core."order" SET pricing_snapshot = '{}' WHERE id = $1`)).toBe("MB001");
    expect(await err(`UPDATE core."order" SET status = 'accepted' WHERE id = $1`)).toBe("ok");
    const reprice = { ...ctx, posting_rule: "orders.reprice", source_ref: `core.order:${id}` };
    await env.db.withContext("munim_core", reprice, (c) => c.query(`UPDATE core."order" SET subtotal_minor = 3000, tax_minor = 150, total_minor = 3150 WHERE id = $1`, [id]));
    expect(Number((await env.one<{ t: string }>(`SELECT total_minor AS t FROM core."order" WHERE id = $1`, [id])).t)).toBe(3150);
  });
});

describe("derivations: stock at placement (FEFO as sold), loyalty earn and the sale posting at completion", () => {
  it("a customer order of 1 paneer tikka + 2 biscuits, 50 points redeemed: placement and completion write exactly the expected rows", async () => {
    // Hand-written: paneer 32000 (+1600 tax), 2 biscuits 5000 (+900) → total 39500; 50 points × 10 = 500 redeemed.
    const principal = { kind: "customer" as const, tenant_id: env.w.tenant, channel_id: env.menu.pickupChannel, customer_id: env.w.customer, profile: true, sub: "cust-sub" };
    const payload = placePayload(env, [{ item: env.menu.paneer }, { item: env.menu.biscuits, qty: 2000 }],
      { channel_id: env.menu.pickupChannel, device_id: null, kind: "pickup", loyalty_redeem_points: 50 });
    // The paneer price exists for the counter channel only; add the pickup price as the owner.
    await env.db.withContext("munim_core", { ...ctxOf("owner"), command_type: "catalogue.price.set.v1" }, (c) =>
      c.query(`INSERT INTO core.price (tenant_id, id, item_id, outlet_id, channel_kind, amount_minor, currency, tax_class, valid_from) VALUES ($1, $2, $3, $4, 'pickup', 32000, 'INR', 'restaurant_5', '2026-01-01')`,
        [env.w.tenant, uuidv7(), env.menu.paneer, env.w.outlets[0]]));
    const balance0 = Number((await env.one<{ b: string }>(`SELECT balance_after AS b FROM core.loyalty_entry WHERE customer_id = $1 ORDER BY seq DESC LIMIT 1`, [env.w.customer])).b);
    const placed = await placeOrder({ deps: { pools: env.pools, log: () => {} }, principal },
      { command_id: uuidv7(), idempotency_key: `k-${uuidv7()}`, type: "orders.place.v1", payload });
    expect(placed.guest_access_token).toBeNull();
    const id = payload.order_id;
    const view = OrderView.parse(await (await env.call("GET", `/v1/orders/${id}`, "staff")).json());
    expect([view.total_minor, view.loyalty_minor, view.remaining_minor]).toEqual([39500, 500, 39000]);

    const moves = () => env.rows<{ ingredient_id: string; batch_id: string | null; qty_milli: string; rule: string }>(
      `SELECT ingredient_id, batch_id, qty_milli, origin ->> 'rule_id' AS rule FROM core.stock_movement WHERE ref_id = $1 ORDER BY qty_milli`, [id]);
    const expectedMoves = [
      { ingredient_id: env.w.ingredient, batch_id: null, qty_milli: "-150000", rule: "inventory.consume_order" },
      { ingredient_id: env.menu.biscuitIngredient, batch_id: env.menu.biscuitBatch, qty_milli: "-2000", rule: "inventory.consume_sku" },
    ];
    expect(await moves()).toEqual(expectedMoves);
    const rv = await env.rows<{ line_no: number; rv: string | null }>(`SELECT line_no, recipe_version_id AS rv FROM core.order_line WHERE order_id = $1 ORDER BY line_no`, [id]);
    expect(rv.map((r) => r.rv !== null)).toEqual([true, false]);
    expect(await n(`SELECT count(*) AS n FROM core.journal_entry WHERE source_id = $1`, [id])).toBe(0);
    for (const [a, b] of [["placed", "accepted"], ["accepted", "preparing"], ["preparing", "ready"], ["ready", "completed"]]) expect(await advance("staff", id, a!, b!)).toBe("ok");

    expect(await moves()).toEqual(expectedMoves);
    const loyalty = await env.rows<{ kind: string; points: string; balance_after: string; rule: string | null }>(
      `SELECT kind, points, balance_after, origin ->> 'rule_id' AS rule FROM core.loyalty_entry WHERE order_id = $1 ORDER BY seq`, [id]);
    // Earn on net (subtotal − discount) 37000 / 1000 = 37 points.
    expect(loyalty).toEqual([
      { kind: "redeem", points: "-50", balance_after: String(balance0 - 50), rule: null },
      { kind: "earn", points: "37", balance_after: String(balance0 - 50 + 37), rule: "customers.loyalty_earn" },
    ]);
    // The sale entry (finance.post_order): sales 37000 and output tax 2500 credited, the entry balances. How the
    // receivable side splits with the 500 redeemed is finance's (R2-S1-4, f-2) and not pinned here.
    const postings = await env.rows<{ code: string; amount_minor: string }>(
      `SELECT a.code, sum(p.amount_minor)::text AS amount_minor FROM core.journal_entry e JOIN core.posting p ON p.tenant_id = e.tenant_id AND p.journal_entry_id = e.id
         JOIN core.account a ON a.tenant_id = p.tenant_id AND a.id = p.account_id
        WHERE e.source_id = $1 AND e.origin ->> 'rule_id' = 'finance.post_order' GROUP BY a.code ORDER BY a.code`, [id]);
    expect(postings.filter((p) => p.code === "4000" || p.code === "2100")).toEqual([{ code: "2100", amount_minor: "-2500" }, { code: "4000", amount_minor: "-37000" }]);
    expect(postings.reduce((a, p) => a + Number(p.amount_minor), 0)).toBe(0);
    // W2-R10: the refund of a completed order calls customers' reversal in its own transaction; the entry cites
    // that refund (its points are customers' rule, not pinned here).
    const tender = uuidv7();
    expect((await env.cmd(`/v1/orders/${id}/tenders`, "staff", "orders.tender.record.v1", { tender_id: tender, order_id: id, method: "card", tendered_minor: null, amount_minor: 39000, currency: "INR", ref: "synthetic" })).status).toBe(200);
    const refund = uuidv7();
    expect((await env.cmd(`/v1/orders/${id}/refunds`, "owner", "orders.refund.record.v1",
      { refund_id: refund, order_id: id, tender_id: tender, method: "card", amount_minor: 39000, currency: "INR", reason_code: "complaint", note: "synthetic" })).status).toBe(200);
    expect(await n(`SELECT count(*) AS n FROM core.loyalty_entry WHERE order_id = $1 AND kind = 'reverse' AND refund_id = $2 AND origin ->> 'rule_id' = 'customers.loyalty_reverse'`, [id, refund])).toBeGreaterThanOrEqual(1);
  });

  it("cancel reverses the redeemed points and frees the pickup slot (placed → cancelled)", async () => {
    const principal = { kind: "customer" as const, tenant_id: env.w.tenant, channel_id: env.menu.pickupChannel, customer_id: env.w.customer, profile: true, sub: "cust-sub" };
    const payload = placePayload(env, [{ item: env.menu.dosa }], { channel_id: env.menu.pickupChannel, device_id: null, kind: "pickup", pickup_window_id: env.menu.window, loyalty_redeem_points: 10 });
    const booked = async () => Number((await env.one<{ b: string }>(`SELECT booked AS b FROM core.pickup_window WHERE id = $1`, [env.menu.window])).b);
    const b0 = await booked();
    await placeOrder({ deps: { pools: env.pools, log: () => {} }, principal }, { command_id: uuidv7(), idempotency_key: `k-${uuidv7()}`, type: "orders.place.v1", payload });
    expect(await booked()).toBe(b0 + 1);
    expect(await advance("staff", payload.order_id, "placed", "cancelled", "customer_asked")).toBe("ok");
    expect(await booked()).toBe(b0);
    const e = await env.rows<{ kind: string; points: string }>(`SELECT kind, points FROM core.loyalty_entry WHERE order_id = $1 ORDER BY seq`, [payload.order_id]);
    expect(e).toEqual([{ kind: "redeem", points: "-10" }, { kind: "reverse", points: "10" }]);
  });
});

describe("W2 B5: cancel / reject give back stock (W2-R6) and free the coupon cap; loyalty as above", () => {
  // Fake pricing: orders' own cap check (recordCoupons → catalogue's couponUses, the count real pricing uses too)
  // judges CAP1 here.
  it("2 biscuits with CAP1 (cap 1): placed −2000 pc on BIS-1; a second CAP1 order refused; cancel returns +2000 under the reversal rule and orders' cap check frees CAP1", async () => {
    // Hand: 2 × 2500 = 5000; CAP1 5% = 250 → 4750; tax 9% + 9% of 4750 = 427.5 → 428 each = 856; total 5606.
    const onHand = async () => n(`SELECT coalesce(sum(qty_milli), 0) AS n FROM core.stock_movement WHERE batch_id = $1`, [env.menu.biscuitBatch]);
    const before = await onHand();
    const first = await place("staff", [{ item: env.menu.biscuits, qty: 2000 }], { coupon_codes: ["CAP1"] });
    expect(await n(`SELECT total_minor AS n FROM core."order" WHERE id = $1`, [first])).toBe(5606);
    expect(await onHand()).toBe(before - 2000);
    const second = await env.cmd("/v1/orders", "staff", "orders.place.v1", placePayload(env, [{ item: env.menu.coffee }], { coupon_codes: ["CAP1"] }));
    expect([second.status, (await second.json()).error.reason_code]).toEqual([409, "coupon_cap_reached"]);

    expect(await advance("staff", first, "placed", "cancelled", "customer_asked")).toBe("ok");
    expect(await onHand()).toBe(before);
    const back = await env.rows<{ kind: string; qty: string; rule: string }>(
      `SELECT kind, qty_milli::text AS qty, origin ->> 'rule_id' AS rule FROM core.stock_movement WHERE ref_id = $1 ORDER BY qty_milli`, [first]);
    expect(back).toEqual([{ kind: "sale_consumption", qty: "-2000", rule: "inventory.consume_sku" }, { kind: "sale_return", qty: "2000", rule: "inventory.reverse_order_consumption" }]);
    const ev = await env.rows<{ kind: string }>(`SELECT payload -> 'data' ->> 'kind' AS kind FROM core.outbox WHERE type = 'munim.inventory.movement.recorded.v1' AND payload -> 'data' ->> 'ref_id' = $1 ORDER BY seq`, [first]);
    expect(ev.map((e) => e.kind)).toContain("sale_return");

    const third = await env.cmd("/v1/orders", "staff", "orders.place.v1", placePayload(env, [{ item: env.menu.coffee }], { coupon_codes: ["CAP1"] }));
    expect(third.status).toBe(201);
    expect(await n(`SELECT count(*) AS n FROM core.coupon_use WHERE coupon_id = $1`, [env.menu.cap1])).toBe(2); // the cancelled order's use stays recorded
  });

  it("reject (placed → rejected) gives the stock back too; an order with no consumption writes no reversal", async () => {
    const id = await place("staff", [{ item: env.menu.biscuits }]);
    expect(await advance("staff", id, "placed", "rejected", "out_of_stock")).toBe("ok");
    expect(await n(`SELECT coalesce(sum(qty_milli), 0) AS n FROM core.stock_movement WHERE ref_id = $1`, [id])).toBe(0);
    const coffee = await place("staff", [{ item: env.menu.coffee }]); // a dish with no recipe rows: nothing consumed
    expect(await advance("staff", coffee, "placed", "rejected", "out_of_stock")).toBe("ok");
    expect(await n(`SELECT count(*) AS n FROM core.stock_movement WHERE ref_id = $1`, [coffee])).toBe(0);
  });
});

describe("push-back re-judges deals (rule 9)", () => {
  it("a deal open at the first promise and closed at the new one: the order is re-priced under orders.reprice", async () => {
    const at1 = new Date(Date.now() + 2 * 3600_000);
    const at2 = new Date(at1.getTime() + 3 * 3600_000);
    const tz = "Asia/Kolkata";
    await env.db.withContext("munim_core", { ...ctxOf("owner"), command_type: "catalogue.deal.upsert.v1" }, (c) =>
      c.query(`INSERT INTO core.deal (tenant_id, id, kind, name_key, rule, windows, valid_from) VALUES ($1, $2, 'percent_off', 'deal.thali_lunch', $3, $4, '2026-01-01')`,
        [env.w.tenant, env.menu.lunchDeal, { kind: "percent_off", bp: 2000, item_ids: [env.menu.thali] },
         JSON.stringify([{ days: [1, 2, 3, 4, 5, 6, 7], from: localTime(new Date(at1.getTime() - 1800_000), tz), to: localTime(new Date(at1.getTime() + 1800_000), tz) }])]));
    const id = await place("staff", [{ item: env.menu.thali }], { channel_id: env.menu.pickupChannel, device_id: null, kind: "pickup", promised_at: at1.toISOString() });
    // Hand-written: 20000 − 20% = 16000, tax 2 × 400 → 16800.
    expect(Number((await env.one<{ t: string }>(`SELECT total_minor AS t FROM core."order" WHERE id = $1`, [id])).t)).toBe(16800);
    const r = await env.cmd(`/v1/orders/${id}:push-back`, "staff", "orders.promise.push_back.v1",
      { order_id: id, from_promised_at: at1.toISOString(), to_promised_at: at2.toISOString(), reason_code: "kitchen_busy" });
    expect(r.status).toBe(200);
    // Deal closed at at2: 20000 + 2 × 500 → 21000.
    const o = await env.one<Record<string, string>>(`SELECT subtotal_minor, discount_minor, tax_minor, total_minor, promised_at FROM core."order" WHERE id = $1`, [id]);
    expect([o.subtotal_minor, o.discount_minor, o.tax_minor, o.total_minor].map(Number)).toEqual([20000, 0, 1000, 21000]);
    // Its line follows (0015 A8): 4000 deal discount and 800 tax at placement → 0 and 1000.
    expect(await env.rows(`SELECT unit_price_minor::int AS u, line_discount_minor::int AS d, tax_minor::int AS t FROM core.order_line WHERE order_id = $1`, [id]))
      .toEqual([{ u: 20000, d: 0, t: 1000 }]);
    expect(new Date(o.promised_at!).toISOString()).toBe(at2.toISOString());
    // R2-S1-2: the line's re-price is audited with before / after; R2-S1-1: the snapshot is merged, not replaced.
    const lineId = (await env.one<{ id: string }>(`SELECT id FROM core.order_line WHERE order_id = $1`, [id])).id;
    expect(await env.rows(`SELECT before, after FROM core.audit_log WHERE entity = 'core.order_line' AND entity_id = $1 AND action = 'orders.reprice'`, [lineId]))
      .toEqual([{ before: { unit_price_minor: 20000, line_discount_minor: 4000, tax_minor: 800 }, after: { unit_price_minor: 20000, line_discount_minor: 0, tax_minor: 1000 } }]);
    const snap = (await env.one<{ s: Record<string, any> }>(`SELECT pricing_snapshot AS s FROM core."order" WHERE id = $1`, [id])).s;
    expect(Object.keys(snap).sort()).toEqual(["coupons", "judged_at", "lines", "loyalty", "pack", "picks", "repriced"]);
    expect(snap.repriced.lines[0]).toMatchObject({ tax_class: "restaurant_5", deal_refs: [], line_discount_minor: 0 });
    // The receipt prints from the re-priced lines and equals the stored order (P9).
    const rc = ReceiptView.parse(await (await env.call("GET", `/v1/orders/${id}/receipt`, "staff")).json());
    expect([rc.total_minor, rc.tax_minor, rc.lines[0]!.discount_minor]).toEqual([21000, 1000, 0]);
    expect(await n(`SELECT count(*) AS n FROM core.order_event WHERE order_id = $1 AND kind = 'promised_at' AND reason = 'kitchen_busy'`, [id])).toBe(1);
    expect(await n(`SELECT count(*) AS n FROM core.outbox WHERE aggregateid = $1 AND type = 'munim.orders.order.promise_changed.v1'`, [id])).toBe(1);
    // A stale guard (the old promise) is refused.
    const stale = await env.cmd(`/v1/orders/${id}:push-back`, "staff", "orders.promise.push_back.v1",
      { order_id: id, from_promised_at: at1.toISOString(), to_promised_at: new Date(at2.getTime() + 600_000).toISOString(), reason_code: "kitchen_busy" });
    expect(stale.status).toBe(409);
  });
});

describe("tenders (R40 C1, ruling #59)", () => {
  it("cash rounds the due to the pack step (IN 100) and records rounding and change; card / UPI cannot exceed the due", async () => {
    const id = await place("staff", [{ item: env.menu.dosa, options: [env.menu.chutney] }]); // total 14176
    const t1 = uuidv7();
    const bad = await env.cmd(`/v1/orders/${id}/tenders`, "staff", "orders.tender.record.v1", { tender_id: uuidv7(), order_id: id, method: "card", tendered_minor: null, amount_minor: 14177, currency: "INR", ref: null });
    expect(bad.status).toBe(422);
    const ok = await env.cmd(`/v1/orders/${id}/tenders`, "staff", "orders.tender.record.v1", { tender_id: t1, order_id: id, method: "cash", tendered_minor: 20000, amount_minor: null, currency: "INR", ref: null });
    expect(ok.status).toBe(200);
    const t = await env.one<Record<string, string>>(`SELECT amount_minor, tendered_minor, change_minor, rounding_minor FROM core.tender WHERE id = $1`, [t1]);
    expect([t.amount_minor, t.tendered_minor, t.change_minor, t.rounding_minor].map(Number)).toEqual([14200, 20000, 5800, 24]);
    const view = await (await env.call("GET", `/v1/orders/${id}`, "staff")).json();
    expect([view.paid_minor, view.remaining_minor]).toEqual([14176, 0]);
    const more = await env.cmd(`/v1/orders/${id}/tenders`, "staff", "orders.tender.record.v1", { tender_id: uuidv7(), order_id: id, method: "upi", tendered_minor: null, amount_minor: 1, currency: "INR", ref: "UPI-1" });
    expect(more.status).toBe(409);
    expect(await n(`SELECT count(*) AS n FROM core.outbox WHERE aggregateid = $1 AND type = 'munim.orders.tender.recorded.v1'`, [t1])).toBe(1);
  });

  it("a part cash payment is not rounded; UPI pays the exact rest", async () => {
    const id = await place("staff", [{ item: env.menu.dosa }]); // total 12600
    await env.cmd(`/v1/orders/${id}/tenders`, "staff", "orders.tender.record.v1", { tender_id: uuidv7(), order_id: id, method: "cash", tendered_minor: 5000, amount_minor: null, currency: "INR", ref: null });
    expect((await (await env.call("GET", `/v1/orders/${id}`, "staff")).json()).remaining_minor).toBe(7600);
    expect((await env.cmd(`/v1/orders/${id}/tenders`, "staff", "orders.tender.record.v1", { tender_id: uuidv7(), order_id: id, method: "upi", tendered_minor: null, amount_minor: 7600, currency: "INR", ref: "UPI-2" })).status).toBe(200);
    expect((await (await env.call("GET", `/v1/orders/${id}`, "staff")).json()).remaining_minor).toBe(0);
  });
});

describe("voids and refunds with reason, within authority", () => {
  it("a void before tender writes the line's own total; after a tender it is refused", async () => {
    const id = await place("staff", [{ item: env.menu.dosa }, { item: env.menu.coffee }]);
    const line = (await env.one<{ id: string }>(`SELECT id FROM core.order_line WHERE order_id = $1 AND line_no = 2`, [id])).id;
    const staffTry = await env.cmd(`/v1/orders/${id}/voids`, "staff", "orders.void.record.v1", { void_id: uuidv7(), order_id: id, order_line_id: line, reason_code: "wrong_item", note: "rang up coffee" });
    expect(staffTry.status).toBe(403);
    const v = uuidv7();
    expect((await env.cmd(`/v1/orders/${id}/voids`, "mgr1", "orders.void.record.v1", { void_id: v, order_id: id, order_line_id: line, reason_code: "wrong_item", note: "rang up coffee" })).status).toBe(200);
    expect(Number((await env.one<{ a: string }>(`SELECT amount_minor AS a FROM core.void WHERE id = $1`, [v])).a)).toBe(4200);
    await env.cmd(`/v1/orders/${id}/tenders`, "staff", "orders.tender.record.v1", { tender_id: uuidv7(), order_id: id, method: "card", tendered_minor: null, amount_minor: 1000, currency: "INR", ref: null });
    expect((await env.cmd(`/v1/orders/${id}/voids`, "mgr1", "orders.void.record.v1", { void_id: uuidv7(), order_id: id, order_line_id: null, reason_code: "customer_left", note: "walked out" })).status).toBe(409);
  });

  it("W2-R3 refund caps from command_authority.role_caps (seeded staff 50000, manager 500000, owner uncapped): staff at the cap 200, above it 403; more than is left 422", async () => {
    const id = await place("staff", [{ item: env.menu.thali, qty: 3000 }]); // hand: 3 × 20000 = 60000 + 2 × 1500 tax = 63000
    const tender = uuidv7();
    await env.cmd(`/v1/orders/${id}/tenders`, "staff", "orders.tender.record.v1", { tender_id: tender, order_id: id, method: "card", tendered_minor: null, amount_minor: 63000, currency: "INR", ref: "APPR-1" });
    const refund = (who: Who, amount: number) => env.cmd(`/v1/orders/${id}/refunds`, who, "orders.refund.record.v1",
      { refund_id: uuidv7(), order_id: id, tender_id: tender, method: "card", amount_minor: amount, currency: "INR", reason_code: "quality", note: "cold" });
    const above = await refund("staff", 50001);
    expect([above.status, (await above.json()).error.reason_code]).toEqual([403, "authority_denied"]);
    expect((await refund("staff", 50000)).status).toBe(200);
    // 63000 − 50000 = 13000 left: a manager (cap 500000) asking 13001 is refused as more than was paid, 13000 is accepted.
    expect((await refund("mgr1", 13001)).status).toBe(422);
    expect((await refund("mgr1", 13000)).status).toBe(200);
    expect(await n(`SELECT count(*) AS n FROM core.refund WHERE order_id = $1`, [id])).toBe(2);
    expect(await n(`SELECT count(*) AS n FROM core.journal_entry j JOIN core.refund f ON f.tenant_id = j.tenant_id AND f.id = j.source_id
                     WHERE f.order_id = $1 AND j.origin ->> 'rule_id' = 'finance.post_refund'`, [id])).toBe(2);
  });
});

describe("shift open / close and cash variance", () => {
  it("expected cash = float + cash tender amounts − cash refunds of the drawer's orders; variance = counted − expected (hand value −400)", async () => {
    const device = uuidv7();
    await env.db.withContext("munim_core", { ...ctxOf("owner"), command_type: "tenancy.device.register.v1" }, (c) =>
      c.query(`INSERT INTO core.device (tenant_id, id, outlet_id, kind, invoice_series) VALUES ($1, $2, $3, 'pos', 'POS3')`, [env.w.tenant, device, env.w.outlets[0]]));
    const shift = uuidv7();
    expect((await env.cmd("/v1/shifts", "staff", "orders.shift.open.v1", { shift_id: shift, outlet_id: env.w.outlets[0], device_id: device, float_minor: 200000, currency: "INR" })).status).toBe(200);
    expect((await env.cmd("/v1/shifts", "staff", "orders.shift.open.v1", { shift_id: uuidv7(), outlet_id: env.w.outlets[0], device_id: device, float_minor: 0, currency: "INR" })).status).toBe(409);
    const a = await place("staff", [{ item: env.menu.coffee }], { device_id: device }); // 4200
    const b = await place("staff", [{ item: env.menu.dosa, options: [env.menu.chutney] }], { device_id: device }); // 14176 → cash 14200
    const c = await place("staff", [{ item: env.menu.dosa }], { device_id: device }); // 12600 card (not cash)
    const pay = (order: string, method: string, tendered: number | null, amount: number | null) =>
      env.cmd(`/v1/orders/${order}/tenders`, "staff", "orders.tender.record.v1", { tender_id: uuidv7(), order_id: order, method, tendered_minor: tendered, amount_minor: amount, currency: "INR", ref: null });
    expect((await pay(a, "cash", 5000, null)).status).toBe(200);
    expect((await pay(b, "cash", 20000, null)).status).toBe(200);
    expect((await pay(c, "card", null, 12600)).status).toBe(200);
    expect((await env.cmd(`/v1/orders/${a}/refunds`, "mgr1", "orders.refund.record.v1",
      { refund_id: uuidv7(), order_id: a, tender_id: null, method: "cash", amount_minor: 1000, currency: "INR", reason_code: "quality", note: "spilt" })).status).toBe(200);
    // 200000 + 4200 + 14200 − 1000 = 217400; counted 217000 → −400.
    expect((await env.cmd(`/v1/shifts/${shift}:close`, "staff", "orders.shift.close.v1", { shift_id: shift, counted_cash_minor: 217000 })).status).toBe(403);
    expect((await env.cmd(`/v1/shifts/${shift}:close`, "mgr1", "orders.shift.close.v1", { shift_id: shift, counted_cash_minor: 217000 })).status).toBe(200);
    const s = await env.one<Record<string, string>>(`SELECT status, expected_cash_minor, counted_cash_minor, variance_minor FROM core.shift WHERE id = $1`, [shift]);
    expect([s.status, Number(s.expected_cash_minor), Number(s.counted_cash_minor), Number(s.variance_minor)]).toEqual(["closed", 217400, 217000, -400]);
    // The read route serves the same row fields (worldgen verify reads the float and counted cash here).
    const read = ShiftView.parse(await (await env.call("GET", `/v1/shifts/${shift}`, "staff")).json());
    expect([read.status, read.float_minor, read.counted_cash_minor, read.expected_cash_minor, read.variance_minor]).toEqual(["closed", 200000, 217000, 217400, -400]);
    expect((await env.call("GET", `/v1/shifts/${shift}`, "mgr2")).status).toBe(404); // another outlet's manager
    expect((await env.cmd(`/v1/shifts/${shift}:close`, "mgr1", "orders.shift.close.v1", { shift_id: shift, counted_cash_minor: 217000 })).status).toBe(409);
  });
});

describe("receipts from core-domain buildReceipt", () => {
  it("IN tax invoice: device series + number, GSTIN and FSSAI, totals equal the stored order", async () => {
    const id = await place("staff", [{ item: env.menu.dosa, options: [env.menu.chutney] }, { item: env.menu.biscuits }]);
    const o = await env.one<{ invoice_no: string }>(`SELECT invoice_no FROM core."order" WHERE id = $1`, [id]);
    const r = ReceiptView.parse(await (await env.call("GET", `/v1/orders/${id}/receipt`, "staff")).json());
    // 14176 + 2950
    expect([r.kind, r.title, r.number, r.total_minor, r.tax_minor]).toEqual(["tax_invoice", "Tax Invoice", `POS1-${o.invoice_no}`, 17126, 1126]);
    expect(r.tax_ids.map((t: any) => t.code)).toEqual(["GSTIN", "FSSAI"]);
  });

  it("missing FSSAI → 409 tax_id_missing (the sale stands); restored → 200", async () => {
    const id = await place("staff", [{ item: env.menu.coffee }]);
    const set = (ids: object) => env.db.withContext("munim_core", { ...ctxOf("owner"), command_type: "tenancy.outlet.update.v1" }, (c) =>
      c.query(`UPDATE core.outlet SET tax_ids = $2 WHERE id = $1`, [env.w.outlets[0], ids]));
    await set({ GSTIN: "29ABCDE1234F1Z5" });
    const r = await env.call("GET", `/v1/orders/${id}/receipt`, "staff");
    expect([r.status, (await r.json()).error.reason_code]).toEqual([409, "tax_id_missing"]);
    await set({ GSTIN: "29ABCDE1234F1Z5", FSSAI: "12345678901234" });
    expect((await env.call("GET", `/v1/orders/${id}/receipt`, "staff")).status).toBe(200);
  });

  it("IN aggregator order under Sec 9(5): no invoice number even on a device; a record-only receipt named by the external ref", async () => {
    const swiggy = uuidv7();
    await env.db.withContext("munim_core", { ...ctxOf("owner"), command_type: "tenancy.channel.create.v1" }, (c) =>
      c.query(`INSERT INTO core.channel (tenant_id, id, name, kind) VALUES ($1, $2, 'Swiggy', 'aggregator:swiggy')`, [env.w.tenant, swiggy]));
    await env.db.withContext("munim_core", { ...ctxOf("owner"), command_type: "catalogue.price.set.v1" }, (c) =>
      c.query(`INSERT INTO core.price (tenant_id, id, item_id, outlet_id, channel_kind, amount_minor, currency, tax_class, valid_from) VALUES ($1, $2, $3, $4, 'aggregator:swiggy', 4000, 'INR', 'restaurant_5', '2026-01-01')`,
        [env.w.tenant, uuidv7(), env.menu.coffee, env.w.outlets[0]]));
    const id = await place("owner", [{ item: env.menu.coffee }], { channel_id: swiggy, external_ref: "SW-1001" });
    const o = await env.one<{ invoice_no: string | null; ticket_no: number }>(`SELECT invoice_no, ticket_no FROM core."order" WHERE id = $1`, [id]);
    expect(o.invoice_no).toBeNull();
    const r = await (await env.call("GET", `/v1/orders/${id}/receipt`, "owner")).json();
    expect([r.kind, r.operator, r.number, r.total_minor]).toEqual(["record", "Swiggy", "SW-1001", 4200]);
  });
});

describe("POS status routes: orders.order.accept.v1 / .reject.v1 / .advance.v1 (0015 A4), each limited to its own steps", () => {
  const status = async (id: string) => (await env.one<{ status: string }>(`SELECT status FROM core."order" WHERE id = $1`, [id])).status;
  const post = (who: Who, id: string, verb: string, type: string, payload: Record<string, unknown>) => env.cmd(`/v1/orders/${id}:${verb}`, who, type, payload);
  const refusal = async (r: Awaited<ReturnType<typeof post>>) => [r.status, (await r.json()).error?.code];

  it("accept: placed → accepted (200); the accept command cannot carry another step (422); a second accept is 409; another outlet's manager gets 404", async () => {
    const id = await place("staff", [{ item: env.menu.coffee }]);
    expect(await refusal(await post("staff", id, "accept", "orders.order.accept.v1", { order_id: id, from_status: "ready", to_status: "completed" }))).toEqual([422, "invalid_payload"]);
    expect(await refusal(await post("mgr2", id, "accept", "orders.order.accept.v1", { order_id: id }))).toEqual([404, "not_found"]);
    expect(await refusal(await post("staff", uuidv7(), "accept", "orders.order.accept.v1", { order_id: id }))).toEqual([422, "invalid_payload"]);
    expect(await status(id)).toBe("placed");
    expect((await post("staff", id, "accept", "orders.order.accept.v1", { order_id: id })).status).toBe(200);
    expect(await status(id)).toBe("accepted");
    expect(await refusal(await post("staff", id, "accept", "orders.order.accept.v1", { order_id: id }))).toEqual([409, "illegal_transition"]);
    // reject is placed → rejected only: an accepted order is not rejectable.
    expect(await refusal(await post("staff", id, "reject", "orders.order.reject.v1", { order_id: id, reason_code: "out_of_stock" }))).toEqual([409, "illegal_transition"]);
  });

  it("advance: accepted → preparing → ready → completed (each 200, each event paired); it cannot accept or reject (422); a stale from_status is 409", async () => {
    const id = await place("staff", [{ item: env.menu.coffee }]);
    const step = (from_status: string, to_status: string, reason_code: string | null = null) =>
      post("staff", id, "advance", "orders.order.advance.v1", { order_id: id, from_status, to_status, reason_code });
    expect(await refusal(await step("placed", "accepted"))).toEqual([422, "invalid_payload"]);
    expect(await refusal(await step("placed", "rejected", "out_of_stock"))).toEqual([422, "invalid_payload"]);
    expect((await post("staff", id, "accept", "orders.order.accept.v1", { order_id: id })).status).toBe(200);
    expect(await refusal(await step("preparing", "ready"))).toEqual([409, "illegal_transition"]);
    for (const [a, b] of [["accepted", "preparing"], ["preparing", "ready"], ["ready", "completed"]] as const) expect((await step(a, b)).status).toBe(200);
    expect(await status(id)).toBe("completed");
    // Every status event of this order has its outbox twin (#80): 4 moves (+ placement).
    const ev = await n(`SELECT count(*) AS n FROM core.order_event WHERE order_id = $1 AND kind = 'status'`, [id]);
    const ob = await n(`SELECT count(*) AS n FROM core.outbox WHERE aggregateid = $1 AND type = 'munim.orders.order.status_changed.v1'`, [id]);
    expect([ev, ob]).toEqual([5, 4]);
    expect(await n(`SELECT count(*) AS n FROM core.audit_log WHERE entity_id = $1 AND action IN ('orders.order.accept.v1', 'orders.order.advance.v1')`, [id])).toBe(4);
  });

  it("reject: placed → rejected with a reason (200); no reason → 422; cancel through advance needs a reason too", async () => {
    const id = await place("staff", [{ item: env.menu.coffee }]);
    expect(await refusal(await post("staff", id, "reject", "orders.order.reject.v1", { order_id: id }))).toEqual([422, "invalid_payload"]);
    expect((await post("staff", id, "reject", "orders.order.reject.v1", { order_id: id, reason_code: "out_of_stock" })).status).toBe(200);
    expect(await status(id)).toBe("rejected");
    const id2 = await place("staff", [{ item: env.menu.coffee }]);
    const cancel = (reason_code: string | null) => post("staff", id2, "advance", "orders.order.advance.v1", { order_id: id2, from_status: "placed", to_status: "cancelled", reason_code });
    const none = await cancel(null);
    expect([none.status, (await none.json()).error]).toEqual([422, expect.objectContaining({ code: "invalid_payload", reason_code: "reason_required" })]);
    expect((await cancel("customer_left")).status).toBe(200);
    expect(await status(id2)).toBe("cancelled");
  });
});

describe("W2 fix cycle 1 (f-1): money rules on the real seams, hand values", () => {
  const pay = (order: string, method: string, tendered: number | null, amount: number | null) =>
    env.cmd(`/v1/orders/${order}/tenders`, "staff", "orders.tender.record.v1", { tender_id: uuidv7(), order_id: order, method, tendered_minor: tendered, amount_minor: amount, currency: "INR", ref: null });
  const refundOf = (who: Who, order: string, amount: number) => env.cmd(`/v1/orders/${order}/refunds`, who, "orders.refund.record.v1",
    { refund_id: uuidv7(), order_id: order, tender_id: null, method: "cash", amount_minor: amount, currency: "INR", reason_code: "quality", note: "synthetic" });
  const pushBack = (id: string, from: string | null, hours: number) => env.cmd(`/v1/orders/${id}:push-back`, "staff", "orders.promise.push_back.v1",
    { order_id: id, from_promised_at: from, to_promised_at: new Date(Date.now() + hours * 3600_000).toISOString(), reason_code: "kitchen_busy" });
  const coupon = (code: string, extra: string, values: unknown[]) => env.db.withContext("munim_core", { ...ctxOf("owner"), command_type: "catalogue.coupon.set.v1" }, (c) =>
    c.query(`INSERT INTO core.coupon (tenant_id, id, code, kind, value_bp, currency, valid_from${extra ? `, ${extra}` : ""})
             VALUES ($1, $2, $3, 'percent', 500, 'INR', '2026-01-01'${values.map((_, i) => `, $${i + 4}`).join("")})`, [env.w.tenant, uuidv7(), code, ...values]));
  const errorOf = async (r: Awaited<ReturnType<Env["cmd"]>>) => [r.status, (await r.json()).error?.code ?? null];
  const refusalOf = async (r: Awaited<ReturnType<Env["cmd"]>>) => { const e = (await r.json()).error; return [r.status, e?.code ?? null, e?.reason_code ?? null]; };

  it("R2-S1-3: a paid order cannot be cancelled until its payment is refunded (409); refunded, the cancel stands (200)", async () => {
    const id = await place("staff", [{ item: env.menu.coffee }]); // 4200
    expect((await pay(id, "cash", 5000, null)).status).toBe(200); // cash 4200 (IN step 100: already whole)
    const cancel = () => env.cmd(`/v1/orders/${id}:advance`, "staff", "orders.order.advance.v1", { order_id: id, from_status: "placed", to_status: "cancelled", reason_code: "customer_left" });
    expect(await refusalOf(await cancel())).toEqual([409, "conflict", "refund_first"]);
    expect((await env.one<{ status: string }>(`SELECT status FROM core."order" WHERE id = $1`, [id])).status).toBe("placed");
    expect((await refundOf("mgr1", id, 4199)).status).toBe(200);
    expect(await refusalOf(await cancel())).toEqual([409, "conflict", "refund_first"]); // 1 still unrefunded
    expect((await refundOf("mgr1", id, 1)).status).toBe(200);
    expect((await cancel()).status).toBe(200);
  });

  it("clause 2 (R2-S1-1): the points' value shows only while the snapshot names this order's unreversed redeem entry with its points; a disagreement fails closed; cancelled, it is 0", async () => {
    const principal = { kind: "customer" as const, tenant_id: env.w.tenant, channel_id: env.menu.pickupChannel, customer_id: env.w.customer, profile: true, sub: "cust-sub" };
    const payload = placePayload(env, [{ item: env.menu.coffee }], { channel_id: env.menu.pickupChannel, device_id: null, kind: "pickup", loyalty_redeem_points: 10 });
    await placeOrder({ deps: { pools: env.pools, log: () => {} }, principal }, { command_id: uuidv7(), idempotency_key: `k-${uuidv7()}`, type: "orders.place.v1", payload });
    const id = payload.order_id;
    rawFixtureWrites.push(id); // the planted snapshot edits below are the gate's own probe
    const view = async () => env.call("GET", `/v1/orders/${id}`, "staff");
    // Hand: 4200; 10 points × 10 = 100 → remaining 4100.
    expect((await (await view()).json())).toMatchObject({ loyalty_minor: 100, remaining_minor: 4100 });
    const setPoints = (pts: number) => env.db.withContext("munim_core", { ...ctxOf("owner"), command_type: "kitchen.ticket.advance.v1", posting_rule: "orders.reprice", source_ref: `core.order:${id}` },
      (c) => c.query(`UPDATE core."order" SET pricing_snapshot = jsonb_set(pricing_snapshot, '{loyalty,points}', $2::jsonb) WHERE id = $1`, [id, JSON.stringify(pts)]));
    await setPoints(11); // the snapshot no longer agrees with the −10 redeem row
    expect((await view()).status).toBe(500);
    expect(await errorOf(await pay(id, "card", null, 1000))).toEqual([500, "internal"]);
    expect(await n(`SELECT count(*) AS n FROM core.tender WHERE order_id = $1`, [id])).toBe(0);
    await setPoints(10);
    expect((await (await view()).json()).loyalty_minor).toBe(100);
    expect(await advance("staff", id, "placed", "cancelled", "customer_left")).toBe("ok");
    expect((await (await view()).json())).toMatchObject({ status: "cancelled", loyalty_minor: 0, remaining_minor: 4200 });
  });

  it("R2-S3-1: 49 paise left after a card part-payment is below the cash step — a clean 409, not a 500; UPI takes it", async () => {
    const id = await place("staff", [{ item: env.menu.dosa }]); // 12600
    expect((await pay(id, "card", null, 12551)).status).toBe(200);
    expect(await refusalOf(await pay(id, "cash", 100, null))).toEqual([409, "conflict", "cash_below_rounding"]);
    expect(await n(`SELECT count(*) AS n FROM core.tender WHERE order_id = $1`, [id])).toBe(1);
    expect((await pay(id, "upi", null, 49)).status).toBe(200);
    expect((await (await env.call("GET", `/v1/orders/${id}`, "staff")).json()).remaining_minor).toBe(0);
  });

  it("R1-M3: a role's refund cap binds its refunds on the order in total — staff 30000 + 20000 = 50000 passes, one more paisa is 403", async () => {
    const id = await place("staff", [{ item: env.menu.thali, qty: 3000 }]); // 63000
    expect((await pay(id, "card", null, 63000)).status).toBe(200);
    expect((await refundOf("staff", id, 30000)).status).toBe(200);
    const over = await refundOf("staff", id, 20001);
    expect([over.status, (await over.json()).error.reason_code]).toEqual([403, "authority_denied"]);
    expect((await refundOf("staff", id, 20000)).status).toBe(200);
    expect((await refundOf("staff", id, 1)).status).toBe(403);
    // the manager's own cap (500000) counts only the manager's refunds: the 13000 left is theirs to refund.
    expect((await refundOf("mgr1", id, 13000)).status).toBe(200);
  });

  it("R2-S2-5: a line void then a whole-order void write off no more than the total; the whole void cancels the order and gives the stock back", async () => {
    const onHand = async () => n(`SELECT coalesce(sum(qty_milli), 0) AS n FROM core.stock_movement WHERE batch_id = $1`, [env.menu.biscuitBatch]);
    const before = await onHand();
    const id = await place("staff", [{ item: env.menu.biscuits }, { item: env.menu.coffee }]); // 2950 + 4200 = 7150
    expect(await onHand()).toBe(before - 1000);
    const line = (await env.one<{ id: string }>(`SELECT id FROM core.order_line WHERE order_id = $1 AND line_no = 2`, [id])).id;
    const voidOf = (order_line_id: string | null) => env.cmd(`/v1/orders/${id}/voids`, "mgr1", "orders.void.record.v1",
      { void_id: uuidv7(), order_id: id, order_line_id, reason_code: "wrong_item", note: "synthetic" });
    expect((await voidOf(line)).status).toBe(200); // 4200
    expect((await voidOf(null)).status).toBe(200); // what is left: 7150 − 4200 = 2950
    expect((await env.rows<{ a: number }>(`SELECT amount_minor::int AS a FROM core.void WHERE order_id = $1 ORDER BY order_line_id NULLS LAST`, [id])).map((v) => v.a)).toEqual([4200, 2950]);
    expect((await env.one<{ status: string }>(`SELECT status FROM core."order" WHERE id = $1`, [id])).status).toBe("cancelled");
    expect(await onHand()).toBe(before); // inventory.reverse_order_consumption admitted under the void command
    expect(await n(`SELECT count(*) AS n FROM core.outbox WHERE aggregateid = $1 AND type = 'munim.orders.order.status_changed.v1'`, [id])).toBe(1);
    expect((await voidOf(null)).status).toBe(409); // ended: nothing more to void
    // a whole void where the table has no step to cancelled (preparing) is refused and writes nothing
    const busy = await place("staff", [{ item: env.menu.coffee }]);
    for (const [a, b] of [["placed", "accepted"], ["accepted", "preparing"]]) expect(await advance("staff", busy, a!, b!)).toBe("ok");
    const late = await env.cmd(`/v1/orders/${busy}/voids`, "mgr1", "orders.void.record.v1", { void_id: uuidv7(), order_id: busy, order_line_id: null, reason_code: "wrong_item", note: "synthetic" });
    expect(await errorOf(late)).toEqual([409, "illegal_transition"]);
    expect(await n(`SELECT count(*) AS n FROM core.void WHERE order_id = $1`, [busy])).toBe(0);
  });

  it("R2-S2-10: an aggregator order (no tenders: the aggregator collected) refunds up to its total — 4201 refused 422, 4200 accepted, then nothing left; a counter order with no payment refunds nothing", async () => {
    const zomato = uuidv7();
    await env.db.withContext("munim_core", { ...ctxOf("owner"), command_type: "tenancy.channel.create.v1" }, (c) =>
      c.query(`INSERT INTO core.channel (tenant_id, id, name, kind) VALUES ($1, $2, 'Zomato', 'aggregator:zomato')`, [env.w.tenant, zomato]));
    await env.db.withContext("munim_core", { ...ctxOf("owner"), command_type: "catalogue.price.set.v1" }, (c) =>
      c.query(`INSERT INTO core.price (tenant_id, id, item_id, outlet_id, channel_kind, amount_minor, currency, tax_class, valid_from) VALUES ($1, $2, $3, $4, 'aggregator:zomato', 4000, 'INR', 'restaurant_5', '2026-01-01')`,
        [env.w.tenant, uuidv7(), env.menu.coffee, env.w.outlets[0]]));
    const id = await place("owner", [{ item: env.menu.coffee }], { channel_id: zomato, external_ref: "ZO-2001" }); // 4000 + 200 = 4200
    expect(await errorOf(await refundOf("owner", id, 4201))).toEqual([422, "invalid_payload"]);
    expect((await refundOf("owner", id, 4200)).status).toBe(200);
    expect(await errorOf(await refundOf("owner", id, 1))).toEqual([422, "invalid_payload"]);
    const counter = await place("staff", [{ item: env.menu.coffee }]);
    expect(await errorOf(await refundOf("owner", counter, 1))).toEqual([422, "invalid_payload"]);
  });

  it("R2-S2-6: no push-back once a payment is recorded (409, the promise stands)", async () => {
    const at = new Date(Date.now() + 2 * 3600_000).toISOString();
    const id = await place("staff", [{ item: env.menu.coffee }], { promised_at: at });
    expect((await pay(id, "card", null, 1000)).status).toBe(200);
    expect(await refusalOf(await pushBack(id, at, 3))).toEqual([409, "conflict", "order_tendered"]);
    expect(new Date((await env.one<{ p: Date }>(`SELECT promised_at AS p FROM core."order" WHERE id = $1`, [id])).p).toISOString()).toBe(at);
  });

  it("R2-S2-1 / S2-2 / S2-3: a push-back re-prices the order as placed — its own cap-1 coupon use, a customer-only coupon, the coupons' order", async () => {
    await coupon("ONLYONE", "global_cap", [1]);
    await coupon("MEMBER5", "requires_customer", [true]);
    // own cap-1 use: unchanged total, 200
    const at = new Date(Date.now() + 2 * 3600_000).toISOString();
    const capped = await place("staff", [{ item: env.menu.coffee }], { promised_at: at, coupon_codes: ["ONLYONE"] });
    expect((await pushBack(capped, at, 3)).status).toBe(200);
    // a customer's order with a customer-only coupon, pushed back by staff: 200 (the order's customer is priced)
    const principal = { kind: "customer" as const, tenant_id: env.w.tenant, channel_id: env.menu.pickupChannel, customer_id: env.w.customer, profile: true, sub: "cust-sub" };
    const payload = placePayload(env, [{ item: env.menu.coffee }], { channel_id: env.menu.pickupChannel, device_id: null, kind: "pickup", promised_at: at, coupon_codes: ["MEMBER5"] });
    await placeOrder({ deps: { pools: env.pools, log: () => {} }, principal }, { command_id: uuidv7(), idempotency_key: `k-${uuidv7()}`, type: "orders.place.v1", payload });
    expect((await pushBack(payload.order_id, at, 3)).status).toBe(200);
    // [SAVE10, FLAT50] on 2 dosa (24000): 10% = 2400 → 21600, then 5000 → 16600; tax 415 × 2 = 830 → 17430.
    // Applied FLAT50-first (alphabetical) it would be 19000 → 1900 off → 17100 + 856 = 17956.
    const ordered = await place("staff", [{ item: env.menu.dosa, qty: 2000 }], { promised_at: at, coupon_codes: ["SAVE10", "FLAT50"] });
    expect(await n(`SELECT total_minor AS n FROM core."order" WHERE id = $1`, [ordered])).toBe(17430);
    expect((await pushBack(ordered, at, 3)).status).toBe(200);
    expect(await n(`SELECT total_minor AS n FROM core."order" WHERE id = $1`, [ordered])).toBe(17430);
    // nothing moved: no re-price entry for any of the three
    expect(await n(`SELECT count(*) AS n FROM core.audit_log WHERE entity_id = ANY ($1::text[]) AND action = 'orders.reprice'`, [[capped, payload.order_id, ordered]])).toBe(0);
  });
});

describe("One Guarantee clause 1 over everything this suite wrote (runs last)", () => {
  it("every orders-path book row is a person's own command or a listed derivation; every status / promise change has its audit entry; the audit chain verifies", async () => {
    // [planted write goes here in the red-proof]
    const tables = ["core.\"order\"", "core.order_line", "core.order_event", "core.tender", "core.void", "core.refund", "core.shift", "core.coupon_use",
      "core.loyalty_entry", "core.stock_movement", "core.journal_entry", "core.posting"];
    const bad: string[] = [];
    let checked = 0;
    for (const t of tables) {
      const rows = await env.rows<{ id: string; origin: any; tbl: string }>(`SELECT id, origin, '${t.replaceAll('"', "")}' AS tbl FROM ${t} WHERE tenant_id = $1`, [env.w.tenant]);
      for (const r of rows) {
        checked++;
        const o = r.origin;
        if (o.kind === "command") {
          const known = await env.one<{ n: string }>(
            `SELECT count(*) AS n FROM core.command_authority ca WHERE ca.command_type = $1 AND $2 = ANY (ca.target_tables)
               AND (EXISTS (SELECT 1 FROM core.member m WHERE m.tenant_id = $3 AND m.id::text = $4) OR EXISTS (SELECT 1 FROM core.customer k WHERE k.tenant_id = $3 AND k.id::text = $4) OR $5 = 'operator')`,
            [o.command_type, r.tbl, env.w.tenant, o.principal_id, o.role]);
          if (Number(known.n) !== 1) bad.push(`${r.tbl}:${r.id} command ${o.command_type}`);
        } else if (o.kind === "derivation") {
          // One rule row per (rule, source, target): 0016 gives customers.loyalty_reverse a second source (core.refund).
          const known = await env.one<{ n: string }>(`SELECT count(*) AS n FROM core.derivation_rule WHERE rule_id = $1 AND target_table = $2 AND source_table = split_part($3, ':', 1)`,
            [o.rule_id, r.tbl, o.source_ref]);
          if (Number(known.n) !== 1) bad.push(`${r.tbl}:${r.id} derivation ${o.rule_id}`);
        } else if (o.kind !== "decision") bad.push(`${r.tbl}:${r.id} origin ${o.kind}`);
      }
    }
    expect(checked).toBeGreaterThan(100);
    expect(bad).toEqual([]);
    // UPDATEs keep the creation origin (gotcha 34): each order whose status or promise moved has an audit entry
    // carrying that status / promise, written by the command that moved it.
    const moved = await env.rows<{ id: string; status: string; promised_at: string | null; audited: boolean }>(
      `SELECT o.id, o.status, o.promised_at::text,
              EXISTS (SELECT 1 FROM core.audit_log a WHERE a.tenant_id = o.tenant_id AND a.entity = 'core.order' AND a.entity_id = o.id::text
                        AND (a.after ->> 'status' = o.status OR (a.after ? 'promised_at' AND (a.after ->> 'promised_at')::timestamptz = o.promised_at))
                        AND (a.actor ->> 'id') IS NOT NULL) AS audited
         FROM core."order" o WHERE o.tenant_id = $1 AND o.id <> ALL ($2::uuid[]) AND o.id <> ALL ($3::uuid[]) AND (o.status <> 'placed' OR EXISTS (
           SELECT 1 FROM core.order_event e WHERE e.order_id = o.id AND e.kind = 'promised_at'))`, [env.w.tenant, env.w.orders, rawFixtureWrites]);
    // by hand: completed (status test), rejected, completed (fixture), cancelled, pushed back, + B5: cancelled
    // biscuits, rejected biscuits, rejected coffee, + POS routes: accepted, completed, rejected, cancelled, + f-1:
    // cancelled after refund, cancelled by whole void, preparing (void refused), 3 pushed back (cap, member, order)
    expect(moved.length).toBe(18);
    expect(moved.filter((m) => !m.audited).map((m) => m.id)).toEqual([]);
    const v = await verifyAuditChain(svcTx(env.db), env.w.tenant);
    expect([v.ok, v.firstBadSeq]).toEqual([true, null]);
    expect(v.rows).toBeGreaterThan(30);
  });
});
