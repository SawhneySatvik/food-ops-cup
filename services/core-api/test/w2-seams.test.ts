// W2 integration gates (B6, B3): the module handlers that own a source row's lifecycle reach the REAL
// finance.postFor on their default seam path (no setSeams / setPostFor / setOrderSeams installed here), and the
// composition roots wire what W2 added. Expected amounts are hand-written from the posting rules in
// packages/core-domain/finance/post.ts (IN pack, input tax on). Synthetic data only.
//   GRN 2 kg × 30,000/kg = 60,000             → Dr cogs 60,000 · Cr grni 60,000
//   invoice 60,000 + tax 3,000 = 63,000        → Dr grni 60,000 · Dr input_tax 3,000 · Cr payables 63,000
//   payroll 3,000,000 + OT 30,000 + tips 5,000 → Dr wages 3,035,000 · Cr bank 3,035,000
//   order 10,000 + tax 500 = 10,500 completed  → Dr receivable 10,500 · Cr sales 10,000 · Cr output_tax 500
// purchasing.grn.receive.v1 is the seeded row (0015 A4); no shim.
import { generateKeyPairSync } from "node:crypto";
import { createLogger, loadConfig } from "@munim/config";
import { uuidv7 } from "@munim/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalIdp } from "../src/auth/local-idp.ts";
import { composeWorker } from "../../core-worker/src/main.ts";
import { type CommandHandler, executeCommand } from "../src/commit/index.ts";
import { orderStatusHandler } from "../src/modules/orders/index.ts";
import { payrollDraftHandler } from "../src/modules/people/payroll.ts";
import { grnReceive, invoiceApprove, invoiceRecord, supplierUpsert } from "../src/modules/purchasing/handlers.ts";
import { staffUpsertHandler } from "../src/modules/people/commands.ts";
import { composeCoreApi } from "../src/server.ts";
import { buildFinanceTenant, type Fx } from "./finance-fixture.ts";
import { type Env, placePayload, startEnv } from "./orders.kit.ts";

let env: Env;
let fx: Fx;
const ingredient = uuidv7();
const supplier = uuidv7();

const member = () => ({ tenant_id: fx.tenant, outlet_ids: "*" as const, role: "owner" as const, member_id: fx.owner });
async function run(handler: CommandHandler, payload: Record<string, unknown>) {
  return executeCommand({ tx: (fn) => env.db.withContext("munim_core", member(), fn), tenantId: fx.tenant, actor: { kind: "member", id: fx.owner, role: "owner" } },
    { command_id: uuidv7(), idempotency_key: `seam-${uuidv7()}`, type: handler.type, payload }, handler);
}

/** The derived entry of one source row: how it was admitted, its rule, Σ debits and Σ all lines. */
async function entry(sourceId: string) {
  return env.rows<{ kind: string; rule: string; dr: number; net: number }>(
    `SELECT j.origin ->> 'kind' AS kind, j.origin ->> 'rule_id' AS rule,
            (sum(p.amount_minor) FILTER (WHERE p.amount_minor > 0))::int AS dr, sum(p.amount_minor)::int AS net
       FROM core.journal_entry j JOIN core.posting p ON p.tenant_id = j.tenant_id AND p.journal_entry_id = j.id
      WHERE j.source_id = $1 GROUP BY j.tenant_id, j.id`, [sourceId]);
}

beforeAll(async () => {
  env = await startEnv("IN");
  fx = await buildFinanceTenant(env.db, "IN");
  await env.db.withContext("munim_core", { ...member(), command_type: "inventory.ingredient.upsert.v1" }, (c) =>
    c.query(`INSERT INTO core.ingredient (tenant_id, id, name, base_unit) VALUES ($1, $2, 'Synthetic paneer', 'kg')`, [fx.tenant, ingredient]));
  await run(supplierUpsert, { supplier_id: supplier, name: "Synthetic Dairy", kind: "simulated", a2a_card_url: null, terms: { payment_days: 15, notes: null }, prices: [] });
});
afterAll(async () => env?.stop());

describe("B6: the real finance.postFor on each owner's default path", () => {
  it("GRN receive → receipt movement (inventory.receive_grn) and the GRN entry (finance.post_grn), Dr 60,000", async () => {
    const grn = uuidv7();
    await run(grnReceive, { grn_id: grn, outlet_id: fx.outlets[0], supplier_id: supplier, po_id: null, received_at: null, note: null,
      lines: [{ grn_line_id: uuidv7(), po_line_id: null, ingredient_id: ingredient, qty_milli: 2000, unit: "kg", unit_cost_minor: 30000, currency: "INR", batch: null }] });
    expect(await entry(grn)).toEqual([{ kind: "derivation", rule: "finance.post_grn", dr: 60000, net: 0 }]);
    const mv = await env.rows<{ rule: string; qty: string }>(`SELECT origin ->> 'rule_id' AS rule, qty_milli::text AS qty FROM core.stock_movement WHERE ref_id = $1`, [grn]);
    expect(mv).toEqual([{ rule: "inventory.receive_grn", qty: "2000" }]);
  });

  it("invoice approve → payable 63,000 and the invoice entry (finance.post_supplier_invoice), Dr 63,000; a recorded invoice has no entry", async () => {
    const inv = uuidv7();
    await run(invoiceRecord, { supplier_invoice_id: inv, supplier_id: supplier, invoice_no: "SYN-INV-1", invoice_date: "2026-10-01", po_id: null, currency: "INR",
      lines: [{ line_id: uuidv7(), po_line_id: null, ingredient_id: ingredient, description: null, qty_milli: 2000, unit: "kg", unit_price_minor: 30000, tax_minor: 3000 }] });
    expect(await entry(inv)).toEqual([]);
    await run(invoiceApprove, { supplier_invoice_id: inv });
    expect(await entry(inv)).toEqual([{ kind: "derivation", rule: "finance.post_supplier_invoice", dr: 63000, net: 0 }]);
    expect(await env.rows(`SELECT amount_minor::int AS a FROM core.payable WHERE source_id = $1`, [inv])).toEqual([{ a: 63000 }]);
  });

  it("payroll draft (created approved) → the payroll entry (finance.post_payroll), Dr 3,035,000", async () => {
    const staff = uuidv7();
    await run(staffUpsertHandler, { staff_id: staff, member_id: null, outlet_id: fx.outlets[0], name: "Synthetic cook", phone: null, role_key: "cook", pay_basis: "monthly",
      wage_rate_minor: null, monthly_salary_minor: 3000000, contract_min_per_month: 12000, ot_multiplier_bp: 15000, currency: "INR", joined_on: "2026-01-01", left_on: null, active: true });
    const draft = uuidv7();
    await run(payrollDraftHandler, { payroll_draft_id: draft, outlet_id: fx.outlets[0], period_month: "2026-09-01", currency: "INR",
      lines: [{ staff_id: staff, base_minor: 3000000, overtime_minor: 30000, advance_recovery_minor: 0, tips_minor: 5000, net_minor: 3035000 }] });
    expect(await entry(draft)).toEqual([{ kind: "derivation", rule: "finance.post_payroll", dr: 3035000, net: 0 }]);
  });

  it("order completion (orders.advanceOrder under the kitchen's command) → the sale entry (finance.post_order), Dr 10,500", async () => {
    const order = uuidv7();
    await env.db.withContext("munim_core", { ...member(), command_type: "orders.place.v1" }, (c) =>
      c.query(`INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, kind, status, subtotal_minor, tax_minor, total_minor, currency, pricing_snapshot)
               VALUES ($1, $2, $3, $4, 'takeaway', 'placed', 10000, 500, 10500, 'INR', '{}')`, [fx.tenant, order, fx.outlets[0], fx.counter]));
    for (const [a, b] of [["placed", "accepted"], ["accepted", "preparing"], ["preparing", "ready"], ["ready", "completed"]]) {
      await run(orderStatusHandler("kitchen.ticket.advance.v1"), { order_id: order, from_status: a, to_status: b, reason_code: null });
    }
    expect(await entry(order)).toEqual([{ kind: "derivation", rule: "finance.post_order", dr: 10500, net: 0 }]);
  });
});

describe("seams fail closed", () => {
  it("a missing orders seam refuses the sale with 503 unavailable and writes nothing (no stand-in)", async () => {
    // The process-wide resolution cache (orders/seams.ts): null = the owner's module or export was not found.
    const state = (globalThis as Record<symbol, { real: Map<string, unknown> }>)[Symbol.for("munim.orders.seams")]!;
    const real = state.real.get("priceLines");
    state.real.set("priceLines", null);
    try {
      const p = placePayload(env, [{ item: env.menu.coffee }]);
      const r = await env.cmd("/v1/orders", "staff", "orders.place.v1", p);
      expect([r.status, (await r.json()).error.code]).toEqual([503, "unavailable"]);
      expect(await env.rows(`SELECT 1 FROM core."order" WHERE id = $1`, [p.order_id])).toEqual([]);
    } finally {
      if (real === undefined) state.real.delete("priceLines");
      else state.real.set("priceLines", real);
    }
  });
});

describe("B3: composition and the AccountMissing refusal", () => {
  it("a chart without the role a posting rule needs → 409 chart_incomplete (never 500, never the role in the text); nothing is written", async () => {
    // A UPI tender posts to the `bank` role (account 1010, core-domain ROLES). The world carries the full chart
    // (0015 A12), so the gate deactivates 1010 for the refusal and re-activates it for the accept.
    const bank = (active: boolean) => env.db.withContext("munim_core",
      { tenant_id: env.w.tenant, outlet_ids: "*", role: "owner", member_id: env.w.owner, command_type: "finance.account.upsert.v1" },
      (c) => c.query(`UPDATE core.account SET active = $1 WHERE code = '1010'`, [active]));
    const p = placePayload(env, [{ item: env.menu.coffee }]);
    expect((await env.cmd("/v1/orders", "staff", "orders.place.v1", p)).status).toBe(201);
    await bank(false);
    const tender = uuidv7();
    const r = await env.cmd(`/v1/orders/${p.order_id}/tenders`, "staff", "orders.tender.record.v1",
      { tender_id: tender, order_id: p.order_id, method: "upi", tendered_minor: null, amount_minor: 4200, currency: "INR", ref: "UPI-SYN-1" });
    const body = await r.json();
    expect([r.status, body.error?.code, JSON.stringify(body).includes("bank")]).toEqual([409, "chart_incomplete", false]);
    expect(await env.rows(`SELECT 1 FROM core.tender WHERE id = $1`, [tender])).toEqual([]);
    // Accept: with the bank account active the same tender is recorded and posted.
    await bank(true);
    const ok = await env.cmd(`/v1/orders/${p.order_id}/tenders`, "staff", "orders.tender.record.v1",
      { tender_id: tender, order_id: p.order_id, method: "upi", tendered_minor: null, amount_minor: 4200, currency: "INR", ref: "UPI-SYN-1" });
    expect(ok.status).toBe(200);
    expect(await entry(tender)).toEqual([{ kind: "derivation", rule: "finance.post_tender", dr: 4200, net: 0 }]);
  });

  it("composeCoreApi wires the munim_platform pool when given its URL (and none without); composeWorker registers the import parse job", async () => {
    const url = (role: string) => `postgresql://${role}:${env.db.password}@127.0.0.1:${env.db.port}/${env.db.database}`;
    const k = generateKeyPairSync("ed25519");
    const keys = { privateKeyPem: k.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKeyPem: k.publicKey.export({ type: "spki", format: "pem" }).toString() };
    const config = loadConfig({ env: {} });
    const base = { coreUrl: url("munim_core"), svcUrl: url("munim_svc"), listenUrl: url("munim_core"), idp: createLocalIdp(), config, log: createLogger(config, () => {}),
      keys, intelUrl: "http://127.0.0.1:9", serviceSecret: "s".repeat(64) };
    const withPlatform = await composeCoreApi({ ...base, platformUrl: url("munim_platform") });
    const without = await composeCoreApi(base);
    try {
      expect((await withPlatform.deps.pools.platform!.query<{ u: string }>("SELECT current_user AS u")).rows).toEqual([{ u: "munim_platform" }]);
      expect(without.deps.pools.platform).toBeUndefined();
    } finally {
      await withPlatform.close();
      await without.close();
    }
    const w = composeWorker({ svcUrl: url("munim_svc"), keys, intelUrl: "http://127.0.0.1:9", serviceSecret: "s".repeat(64), log: () => {} });
    expect(w.worker.cron.jobNames).toEqual(["outbox-sweep", "fanout-watch", "fanout-brief", "nightly", "imports-parse", "investigations-auto-imports", "investigations-auto-daily"]);
    await w.close();
  });
});
