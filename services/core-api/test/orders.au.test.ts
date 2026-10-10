// T-022 gates on an AU tenant (the project's gate table: IN and AU golden receipts and tax totals; ruling #59 AU 5¢
// cash rounding). AU pack: gst_10 one component of 10%, prices INCLUSIVE, tax = round(gross × 1000 / 11000).
// Expected values are hand-written. Seams: the REAL owners' functions (R3-M3).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Env, placePayload, startEnv, uuidv7 } from "./orders.kit.ts";

let env: Env;
beforeAll(async () => {
  env = await startEnv("AU");
});
afterAll(async () => env?.stop());

const place = async (lines: Parameters<typeof placePayload>[1]) => {
  const p = placePayload(env, lines);
  const r = await env.cmd("/v1/orders", "staff", "orders.place.v1", p);
  expect(r.status).toBe(201);
  return p.order_id;
};

describe("AU: inclusive GST, tax invoice, 5c cash rounding", () => {
  it("1 coffee at A$40.00 incl. GST: tax 364 (363.6 → 364), subtotal 3636, total 4000; receipt is an AU tax invoice with the ABN", async () => {
    const id = await place([{ item: env.menu.coffee }]);
    const o = await env.one<Record<string, string>>(`SELECT subtotal_minor, discount_minor, tax_minor, total_minor, invoice_no, currency FROM core."order" WHERE id = $1`, [id]);
    expect([o.subtotal_minor, o.discount_minor, o.tax_minor, o.total_minor].map(Number)).toEqual([3636, 0, 364, 4000]);
    expect(o.currency).toBe("AUD");
    const r = await (await env.call("GET", `/v1/orders/${id}/receipt`, "staff")).json();
    expect([r.kind, r.title, r.number, r.total_minor, r.tax_minor, r.net_minor]).toEqual(["tax_invoice", "Tax invoice", `POS1-${o.invoice_no}`, 4000, 364, 3636]);
    expect(r.tax_ids).toEqual([{ code: "ABN", label: "ABN", value: "51824753556" }]);
    expect(r.components).toEqual([{ code: "GST", rate_bp: 1000, amount_minor: 364 }]);
  });

  it("cash rounds the due to 5c: 0.333 coffee = 1332 → amount 1330, rounding −2, change 670; remaining 0", async () => {
    const id = await place([{ item: env.menu.coffee, qty: 333 }]);
    expect(Number((await env.one<{ t: string }>(`SELECT total_minor AS t FROM core."order" WHERE id = $1`, [id])).t)).toBe(1332);
    const tender = uuidv7();
    expect((await env.cmd(`/v1/orders/${id}/tenders`, "staff", "orders.tender.record.v1",
      { tender_id: tender, order_id: id, method: "cash", tendered_minor: 2000, amount_minor: null, currency: "AUD", ref: null })).status).toBe(200);
    const t = await env.one<Record<string, string>>(`SELECT amount_minor, change_minor, rounding_minor FROM core.tender WHERE id = $1`, [tender]);
    expect([t.amount_minor, t.change_minor, t.rounding_minor].map(Number)).toEqual([1330, 670, -2]);
    const view = await (await env.call("GET", `/v1/orders/${id}`, "staff")).json();
    expect([view.paid_minor, view.remaining_minor, view.tenders[0].rounding_minor]).toEqual([1332, 0, -2]);
  });
});

describe("pickup windows", () => {
  it("11:00–12:00 local in 15-minute slots → 4 windows (Melbourne); generating again creates none; staff may not generate (403)", async () => {
    const payload = { outlet_id: env.w.outlets[0], business_date: "2026-10-20", from_local: "11:00", to_local: "12:00", slot_minutes: 15, capacity_orders: 8 };
    const count = async () => Number((await env.one<{ n: string }>(
      `SELECT count(*) AS n FROM core.pickup_window WHERE outlet_id = $1 AND starts_at >= '2026-10-20T00:00:00Z' AND starts_at < '2026-10-21T00:00:00Z'`, [env.w.outlets[0]])).n);
    expect((await env.cmd("/v1/pickup-windows", "staff", "orders.pickup_window.generate.v1", payload)).status).toBe(403);
    expect((await env.cmd("/v1/pickup-windows", "mgr1", "orders.pickup_window.generate.v1", payload)).status).toBe(200);
    expect(await count()).toBe(4);
    // 11:00 AEDT (+11:00) = 00:00Z.
    const first = await env.one<{ s: Date }>(`SELECT min(starts_at) AS s FROM core.pickup_window WHERE outlet_id = $1 AND starts_at >= '2026-10-20T00:00:00Z' AND starts_at < '2026-10-21T00:00:00Z'`, [env.w.outlets[0]]);
    expect(new Date(first.s).toISOString()).toBe("2026-10-20T00:00:00.000Z");
    expect((await env.cmd("/v1/pickup-windows", "mgr1", "orders.pickup_window.generate.v1", payload)).status).toBe(200);
    expect(await count()).toBe(4);
  });
});
