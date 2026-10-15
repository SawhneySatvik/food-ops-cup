// T-026 month gates through the real app (member auth → withContext → RLS → book guard), IN tenant:
//   • the fixture month's P&L (finance.pnl, run as the template W3 installs) = the hand-computed answer key,
//     by outlet, brand and channel; GST check and GST summary = their keys;
//   • reconciliation: an ad fee the terms never allowed → one unapproved_deduction break; dispute route moves it
//     to disputed (replay → same bytes); disputing it again → 409 with no new dispute; a line naming an order or a
//     settlement line already in an open dispute → 409, a repeated line in one claim → 422, another order → 201, and
//     once its dispute is withdrawn the order may be claimed again (R-B S1-C: a weekly re-draft never claims twice); as an
//     approved draft the held line makes the draft stale (409 stale_draft), never a 409 that a retry meets again;
//   • channel terms: owner 201, overlap 409, staff 403; expense into a closed period 409 period_closed, open 201;
//   • journal adjust: no route (404); handler without a decision refused, 0 rows; approved draft → 1 entry under
//     the decision; an unbalanced edit → 422, 0 entries, draft still proposed;
//   • period close as an approved draft; Tally export: owner/advisor 200 with hand-checked rows, manager 403.
// Every expected number below is written by hand from the fixture (see the comments), never computed by
// the code under test. Synthetic data only.
import { createLogger } from "@munim/config";
import { CommandResult, snapRef } from "@munim/contracts";
import { ChannelTermsListResponse, TallyExport } from "@munim/contracts/finance";
import { type TestDb, uuidv7 } from "@munim/db";
import type { Hono } from "hono";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalIdp } from "../src/auth/local-idp.ts";
import { type AppEnv, createApp, TENANT_HEADER } from "../src/app.ts";
import { executeCommand } from "../src/commit/index.ts";
import { runTemplate } from "../src/modules/approvals/snapshots.ts";
import { FINANCE_TEMPLATES, journalAdjust, recordSettlement } from "../src/modules/finance/index.ts";
import { openDb } from "./db.ts";
import {
  approveInvoice, buildFinanceTenant, completedOrder, count, type Fx, grn, ingredient, inImportApproval, invoice, own, payroll, previewedRun, refund,
  supplier, tender, terms, type Who,
} from "./finance-fixture.ts";

const idp = createLocalIdp();
let db: TestDb;
let fx: Fx;
let pools: { core: pg.Pool; svc: pg.Pool };
let app: Hono<AppEnv>;
let M = ""; // the fixture month (YYYY-MM-01): orders take today's business date, so the month is today's
const ids = { o1: "", o2: "", o3: "", s1: "", breakId: "" };

type Res = Omit<Response, "json"> & { json(): Promise<any> };
const call = async (method: string, path: string, who: Who, body?: unknown): Promise<Res> =>
  (await app.request(path, {
    method,
    headers: { Authorization: `Bearer ${idp.sign({ sub: fx.subs[who] })}`, [TENANT_HEADER]: fx.tenant, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })) as Res;
const envelope = (type: string, payload: Record<string, unknown>, key = `fin-${uuidv7()}`) => ({ command_id: uuidv7(), idempotency_key: key, type, payload });

/** Runs the version this file's FINANCE_TEMPLATES declares (finance.gst_check is v2 since 0023). */
const versionOf = (id: string) => FINANCE_TEMPLATES.find((t) => t.id === id)!.version;
async function template(id: string, params: Record<string, unknown>) {
  return db.withContext("munim_core", own(fx, "drafts.approve.v1"), (c) => runTemplate(c, id, versionOf(id), params));
}
const byKey = <R extends Record<string, unknown>>(rows: R[], k: string) => Object.fromEntries(rows.map((r) => [String(r[k]), r]));

beforeAll(async () => {
  db = await openDb();
  fx = await buildFinanceTenant(db, "IN");
  // W3/M-C installs these templates; the gate runs THIS file's SQL in this clone (the migration's copy is replaced here, so
  // a drift between read.ts and the migration fails the answer keys below rather than hiding behind the migration's SQL).
  for (const t of FINANCE_TEMPLATES) {
    await db.admin(`INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES ($1, $2, $3, $4, $5, $6)
                    ON CONFLICT (id, version) DO UPDATE SET sql = EXCLUDED.sql`,
      [t.id, t.version, t.sql, JSON.stringify(t.params_schema), JSON.stringify(t.columns), t.min_role]);
  }
  pools = { core: db.pool("munim_core", 6), svc: db.pool("munim_svc", 2) };
  const config = { nodeEnv: "test", redact: (s: string) => s };
  app = await createApp({ pools, idp, storefronts: async () => null, config, log: createLogger(config, () => {}) });

  const [A, B] = fx.outlets;
  await terms(db, fx, { channel: fx.agg, commission_bp: 2200, ads_opted_in: false, from: "2026-01-01" });
  ids.o1 = await completedOrder(db, fx, { outlet: A, channel: fx.counter, brand: fx.brand, subtotal: 100000, tax: 5000 }); // total 105000
  M = (await db.admin<{ m: string }>(`SELECT to_char(business_date, 'YYYY-MM-01') m FROM core."order" WHERE id = $1`, [ids.o1])).rows[0]!.m;
  await tender(db, fx, { order: ids.o1, outlet: A, method: "cash", amount: 105000 });
  ids.o2 = await completedOrder(db, fx, { outlet: B, channel: fx.agg, brand: fx.brand, subtotal: 50000, tax: 2500 }); // operator pays the 2500
  ids.o3 = await completedOrder(db, fx, { outlet: A, channel: fx.counter, brand: null, subtotal: 20000, discount: 2000, tax: 900 }); // total 18900
  await tender(db, fx, { order: ids.o3, outlet: A, method: "upi", amount: 18900 });
  await refund(db, fx, { order: ids.o1, outlet: A, method: "cash", amount: 10500 }); // tax share 10500 × 5000 / 105000 = 500
  const sup = await supplier(db, fx);
  await grn(db, fx, { outlet: A, supplier: sup, ingredient: await ingredient(db, fx), lines: [[10000, 25000], [2500, 4000]] }); // 250000 + 10000
  await approveInvoice(db, fx, await invoice(db, fx, { supplier: sup, date: M, subtotal: 260000, tax: 13000 })); // IN: no input-tax account → tax to COGS
  const run = await previewedRun(db, fx);
  ids.s1 = uuidv7();
  const out = await inImportApproval(db, fx, run, (c) => recordSettlement(c, {
    settlement_id: ids.s1, channel_id: fx.agg, outlet_id: B, period_from: M, period_to: M, paid_on: M, external_ref: "AGG-PAYOUT-1", net_minor: 35450,
    currency: "INR", import_run_id: run, lines: [
      { line_id: uuidv7(), line_no: 1, line_kind: "order", external_order_ref: "AGG-1", matched_order_id: ids.o2, gross_minor: 52500, commission_minor: 11550,
        ad_fee_minor: 0, promo_share_minor: 0, tax_withheld_minor: 2500, net_minor: 38450 },
      { line_id: uuidv7(), line_no: 2, line_kind: "ad_fee", external_order_ref: null, matched_order_id: null, gross_minor: 0, commission_minor: 0,
        ad_fee_minor: 3000, promo_share_minor: 0, tax_withheld_minor: 0, net_minor: -3000 },
    ] }));
  ids.breakId = out.break_ids[0] ?? "";
  for (const [outlet, category, amount, tax] of [[A, "utilities", 450000, 0], [B, "repairs", 11800, 1800]] as const) {
    const r = await call("POST", "/v1/finance/expenses", "owner", envelope("finance.expense.record.v1", {
      expense_id: uuidv7(), outlet_id: outlet, category, incurred_on: M, amount_minor: amount, tax_minor: tax, currency: "INR", payee: "Synthetic payee", note: null, document_id: null,
    }));
    if (r.status !== 201) throw new Error(`expense fixture: ${r.status} ${JSON.stringify(await r.json())}`);
  }
  await payroll(db, fx, { outlet: A, month: M, lines: [{ base: 1500000, ot: 120000, tips: 20000, recovery: 50000 }] }); // wages 1640000
}, 240_000);

afterAll(async () => {
  await pools?.core.end();
  await pools?.svc.end();
  await db?.stop();
});

const [pnlCols] = [["revenue_minor", "cogs_minor", "channel_fees_minor", "labour_minor", "other_minor", "net_minor"]];
const row = (v: number[]) => Object.fromEntries(pnlCols.map((c, i) => [c, v[i]]));

describe("P&L of the fixture month = answer key (finance.pnl template)", () => {
  it("by outlet", async () => {
    const r = await template("finance.pnl", { period_month: M, group_by: "outlet" });
    const got = byKey(r.rows, "key");
    expect(Object.keys(got).sort()).toEqual([fx.outlets[0], fx.outlets[1], "unassigned"].sort());
    //                          revenue          cogs    fees   labour   other     net
    expect(got[fx.outlets[0]]).toMatchObject(row([108000, 260000, 0, 1640000, 450000, -2242000])); // 100000 + 18000 − 10000 refund
    expect(got[fx.outlets[1]]).toMatchObject(row([50000, 0, 14550, 0, 11800, 23650])); // fees 11550 + 3000; repairs incl. tax (no ITC)
    expect(got.unassigned).toMatchObject(row([0, 13000, 0, 0, 0, -13000])); // invoice tax, no input-tax account, no outlet
  });

  it("by channel and by brand (totals agree: −2231350)", async () => {
    const ch = byKey((await template("finance.pnl", { period_month: M, group_by: "channel" })).rows, "key");
    expect(ch[fx.counter]).toMatchObject(row([108000, 0, 0, 0, 0, 108000]));
    expect(ch[fx.agg]).toMatchObject(row([50000, 0, 14550, 0, 0, 35450]));
    expect(ch.unassigned).toMatchObject(row([0, 273000, 0, 1640000, 461800, -2374800]));
    const br = byKey((await template("finance.pnl", { period_month: M, group_by: "brand" })).rows, "key");
    expect(br[fx.brand]).toMatchObject(row([140000, 0, 0, 0, 0, 140000]));
    expect(br.unassigned).toMatchObject(row([18000, 273000, 14550, 1640000, 461800, -2371350]));
  });

  it("a month with no postings has no rows (paired empty case)", async () => {
    expect((await template("finance.pnl", { period_month: "2025-01-01", group_by: "outlet" })).rows).toEqual([]);
  });
});

describe("GST read models = answer key", () => {
  it("finance.gst_check: own-liability order tax 5000 + 900 = 5900 = posted; aggregator (operator pays) excluded", async () => {
    const r = await template("finance.gst_check", { period_month: M, outlet_id: null });
    expect(r.rows).toEqual([{ outlet_id: fx.outlets[0], order_tax_minor: 5900, posted_tax_minor: 5900, diff_minor: 0 }]);
  });

  it("finance.gst_check v2: outlet_id narrows both sides (A → its row; B, aggregator-only, → none); the installed v2 has this file's params and columns", async () => {
    expect((await template("finance.gst_check", { period_month: M, outlet_id: fx.outlets[0] })).rows)
      .toEqual([{ outlet_id: fx.outlets[0], order_tax_minor: 5900, posted_tax_minor: 5900, diff_minor: 0 }]);
    expect((await template("finance.gst_check", { period_month: M, outlet_id: fx.outlets[1] })).rows).toEqual([]);
    const t = FINANCE_TEMPLATES.find((x) => x.id === "finance.gst_check")!;
    const installed = (await db.admin(`SELECT params_schema, columns FROM evidence.snapshot_template WHERE id = $1 AND version = $2`, [t.id, t.version])).rows[0]!;
    expect([installed.params_schema, installed.columns]).toEqual([t.params_schema, t.columns]);
  });

  it("finance.gst_summary: output tax 5000 + 900 − 500 refunded = 5400; no input tax (IN chart)", async () => {
    const r = await template("finance.gst_summary", { period_month: M });
    expect(r.rows).toEqual([{ key: fx.outlets[0], output_tax_minor: 5400, input_tax_minor: 0, net_payable_minor: 5400 }]);
  });
});

describe("AU tenant: pack-driven branches through the database", () => {
  it("merchant-collected aggregator tax withheld is a credit against output tax; invoice tax goes to input tax (1300) — finance.gst_summary key", async () => {
    const au = await buildFinanceTenant(db, "AU");
    const [A] = au.outlets;
    const order = await completedOrder(db, au, { outlet: A, channel: au.agg, brand: null, subtotal: 10000, tax: 1000 }); // ubereats-shaped: merchant collects
    const month = (await db.admin<{ m: string }>(`SELECT to_char(business_date, 'YYYY-MM-01') m FROM core."order" WHERE id = $1`, [order])).rows[0]!.m;
    const sup = await supplier(db, au);
    await approveInvoice(db, au, await invoice(db, au, { supplier: sup, date: month, subtotal: 408000, tax: 20400 }));
    const run = await previewedRun(db, au);
    await inImportApproval(db, au, run, (c) => recordSettlement(c, {
      settlement_id: uuidv7(), channel_id: au.agg, outlet_id: A, period_from: month, period_to: month, paid_on: month, external_ref: "AU-PAYOUT-1", net_minor: 8470,
      currency: "AUD", import_run_id: run, lines: [{ line_id: uuidv7(), line_no: 1, line_kind: "order", external_order_ref: "UE-1", matched_order_id: order,
        gross_minor: 11000, commission_minor: 2420, ad_fee_minor: 0, promo_share_minor: 0, tax_withheld_minor: 110, net_minor: 8470 }] }));
    const r = await db.withContext("munim_core", own(au, "drafts.approve.v1"), (c) => runTemplate(c, "finance.gst_summary", 1, { period_month: month }));
    // A: output 1000 − 110 withheld = 890; tenant-wide invoice: input 20400.
    expect(byKey(r.rows, "key")).toEqual({
      [A]: { key: A, output_tax_minor: 890, input_tax_minor: 0, net_payable_minor: 890 },
      unassigned: { key: "unassigned", output_tax_minor: 0, input_tax_minor: 20400, net_payable_minor: -20400 },
    });
    const chk = await db.withContext("munim_core", own(au, "drafts.approve.v1"), (c) => runTemplate(c, "finance.gst_check", 2, { period_month: month, outlet_id: null }));
    expect(chk.rows).toEqual([{ outlet_id: A, order_tax_minor: 1000, posted_tax_minor: 1000, diff_minor: 0 }]);
  });
});

describe("reconciliation breaks and disputes", () => {
  it("the payout's ad fee with no consent → one unapproved_deduction break of 3000; the order line is not short", async () => {
    const b = await db.admin(`SELECT kind, amount_minor, status, channel_id FROM core.reconciliation_break WHERE tenant_id = $1`, [fx.tenant]);
    expect(b.rows).toEqual([{ kind: "unapproved_deduction", amount_minor: "3000", status: "open", channel_id: fx.agg }]);
  });

  it("dispute route records it (201), moves the break to disputed; replay → same bytes; disputing it again → 409, no new dispute", async () => {
    const payload = { dispute_id: uuidv7(), channel_id: fx.agg, basis: "unapproved_ad_fee", lines: [], total_claimed_minor: 3000, currency: "INR", break_ids: [ids.breakId] };
    const body = envelope("finance.dispute.draft.v1", payload);
    const r = await call("POST", "/v1/finance/disputes", "owner", body);
    expect(r.status).toBe(201);
    const first = await r.text();
    expect(CommandResult.parse(JSON.parse(first)).entity_id).toBe(payload.dispute_id);
    const replay = await call("POST", "/v1/finance/disputes", "owner", body);
    expect([replay.status, await replay.text(), replay.headers.get("X-Munim-Replayed")]).toEqual([201, first, "true"]);
    expect((await db.admin(`SELECT status, dispute_id FROM core.reconciliation_break WHERE id = $1`, [ids.breakId])).rows[0]).toEqual({ status: "disputed", dispute_id: payload.dispute_id });
    const again = await call("POST", "/v1/finance/disputes", "owner", envelope("finance.dispute.draft.v1", { ...payload, dispute_id: uuidv7() }));
    expect([again.status, (await again.json()).error.code]).toEqual([409, "conflict"]);
    expect(await count(db, `SELECT count(*) n FROM core.dispute WHERE tenant_id = $1`, [fx.tenant])).toBe(1);
  });

  it("R-B S1-C: an order or settlement line already in an open dispute → 409, 0 rows; a repeat inside one claim → 422; others → 201", async () => {
    const disputes = () => count(db, `SELECT count(*) n FROM core.dispute WHERE tenant_id = $1`, [fx.tenant]);
    const sl = (await db.admin<{ id: string }>(`SELECT id FROM core.settlement_line WHERE settlement_id = $1 AND line_no = 2`, [ids.s1])).rows[0]!.id;
    const claim = (lines: Array<{ order_id?: string; settlement_line_id?: string; claimed_minor: number }>) => {
      const dispute_id = uuidv7();
      return { dispute_id, body: envelope("finance.dispute.draft.v1", { dispute_id, channel_id: fx.agg, basis: "short_payout", break_ids: [], currency: "INR",
        lines: lines.map((l) => ({ order_id: l.order_id ?? null, settlement_line_id: l.settlement_line_id ?? null, claimed_minor: l.claimed_minor })),
        total_claimed_minor: lines.reduce((a, l) => a + l.claimed_minor, 0) }) };
    };
    const post = async (b: { body: unknown }) => { const r = await call("POST", "/v1/finance/disputes", "owner", b.body); return [r.status, r.status === 201 ? null : (await r.json()).error.code]; };
    const n0 = await disputes();
    const first = claim([{ order_id: ids.o2, claimed_minor: 1000 }]);
    expect(await post(first)).toEqual([201, null]);
    expect(await post(claim([{ order_id: ids.o2, claimed_minor: 1000 }]))).toEqual([409, "conflict"]);
    expect(await post(claim([{ order_id: ids.o3, claimed_minor: 500 }, { order_id: ids.o2, claimed_minor: 500 }]))).toEqual([409, "conflict"]);
    expect(await post(claim([{ settlement_line_id: sl, claimed_minor: 3000 }]))).toEqual([201, null]);
    expect(await post(claim([{ settlement_line_id: sl, claimed_minor: 3000 }]))).toEqual([409, "conflict"]);
    expect(await post(claim([{ order_id: ids.o3, claimed_minor: 500 }, { order_id: ids.o3, claimed_minor: 500 }]))).toEqual([422, "invalid_payload"]);
    expect(await disputes()).toBe(n0 + 2);
    // A withdrawn dispute no longer holds its order (open = recorded | sent).
    await db.admin(`SET session_replication_role = replica; UPDATE core.dispute SET status = 'withdrawn' WHERE id = '${first.dispute_id}'; SET session_replication_role = origin`);
    expect(await post(claim([{ order_id: ids.o2, claimed_minor: 1000 }]))).toEqual([201, null]);
    expect(await disputes()).toBe(n0 + 3);
  });

  it("R-B S1-C: two dispute drafts naming one order → the first approval 200, the second stale (409 stale_draft, draft stale), 0 rows", async () => {
    const disputes = () => count(db, `SELECT count(*) n FROM core.dispute WHERE tenant_id = $1`, [fx.tenant]);
    // The proposal cites amounts the owner then types (R26): the claim is the owner's, the order line is the draft's.
    const ref = snapRef(uuidv7(), 0, "claimed_minor");
    const body = (claimed: unknown) => ({ dispute_id: uuidv7(), channel_id: fx.agg, basis: "missing_payout", break_ids: [], currency: "INR",
      lines: [{ order_id: ids.o3, settlement_line_id: null, claimed_minor: claimed }], total_claimed_minor: claimed });
    const drafted = new Map<string, Record<string, unknown>>();
    const draft = async () => {
      const id = uuidv7();
      const payload = body(ref);
      drafted.set(id, payload);
      await db.withContext("munim_svc", { tenant_id: fx.tenant, outlet_ids: "*" }, (c) =>
        c.query(`INSERT INTO core.draft (tenant_id, id, outlet_ids, source, command_type, command_payload) VALUES ($1, $2, '{}', 'intel:finance', $3, $4)`,
          [fx.tenant, id, "finance.dispute.draft.v1", payload]));
      return id;
    };
    const typed = { value: 700, typed_by: fx.owner };
    const approve = (id: string) => call("POST", `/v1/drafts/${id}:approve`, "owner", { command_id: uuidv7(), idempotency_key: `approve-${uuidv7()}`,
      type: "drafts.approve.v1", payload: { draft_id: id, command_type: "finance.dispute.draft.v1", reason: "Owner typed the claim",
        edited_payload: { ...drafted.get(id)!, lines: [{ order_id: ids.o3, settlement_line_id: null, claimed_minor: typed }], total_claimed_minor: typed } } });
    const [a, b] = [await draft(), await draft()];
    const n0 = await disputes();
    const ra = await approve(a);
    expect([ra.status, ra.status === 200 ? null : await ra.json()]).toEqual([200, null]);
    const res = await approve(b);
    const st = (await db.admin<{ status: string }>(`SELECT status FROM core.draft WHERE id = $1`, [b])).rows[0]!.status;
    expect([res.status, (await res.json()).error.code, st]).toEqual([409, "stale_draft", "stale"]);
    expect(await disputes()).toBe(n0 + 1);
  });
});

describe("own commands: channel terms and expenses", () => {
  const termsBody = (from: string, to: string | null) => envelope("finance.channel_terms.set.v1", {
    channel_terms_id: uuidv7(), channel_id: fx.agg, commission_bp: 2000, ads_opted_in: true, ad_spend_cap_minor: 500000, promo_share_bp: 0,
    payout_cycle_days: 7, currency: "INR", valid_from: from, valid_to: to,
  });

  it("owner sets terms (201); an overlapping window → 409; staff → 403; nothing written by the refusals", async () => {
    expect((await call("POST", "/v1/finance/channel-terms", "owner", termsBody("2025-06-01", "2025-12-31"))).status).toBe(201);
    const before = await count(db, `SELECT count(*) n FROM core.channel_terms WHERE tenant_id = $1`, [fx.tenant]);
    const overlap = await call("POST", "/v1/finance/channel-terms", "owner", termsBody("2025-07-01", "2025-08-01"));
    expect([overlap.status, (await overlap.json()).error.code]).toEqual([409, "conflict"]);
    const staff = await call("POST", "/v1/finance/channel-terms", "staff", termsBody("2024-01-01", "2024-02-01"));
    expect([staff.status, (await staff.json()).error.code]).toEqual([403, "book_write_refused"]);
    expect(await count(db, `SELECT count(*) n FROM core.channel_terms WHERE tenant_id = $1`, [fx.tenant])).toBe(before);
  });

  it("new open-ended terms end the current open-ended ones at their start (no overlap)", async () => {
    const r = await call("POST", "/v1/finance/channel-terms", "owner", termsBody("2027-01-01", null));
    expect(r.status).toBe(201);
    const t = await db.admin(`SELECT valid_from::text vf, valid_to::text vt FROM core.channel_terms WHERE tenant_id = $1 AND valid_from >= '2026-01-01' ORDER BY valid_from`, [fx.tenant]);
    expect(t.rows).toEqual([{ vf: "2026-01-01", vt: "2027-01-01" }, { vf: "2027-01-01", vt: null }]);
  });

  it("GET /v1/finance/channel-terms: the rows' own fields, newest window first (owner, advisor); a manager → 403", async () => {
    const r = await call("GET", `/v1/finance/channel-terms?channel_id=${fx.agg}`, "advisor");
    expect(r.status).toBe(200);
    const terms = ChannelTermsListResponse.parse(await r.json()).channel_terms;
    expect(terms.map((x) => [x.valid_from, x.valid_to, x.commission_bp, x.ads_opted_in, x.ad_spend_cap_minor])).toEqual([
      ["2027-01-01", null, 2000, true, 500000], ["2026-01-01", "2027-01-01", 2200, false, null], ["2025-06-01", "2025-12-31", 2000, true, 500000],
    ]);
    expect((await call("GET", "/v1/finance/channel-terms", "owner")).status).toBe(200);
    expect((await call("GET", "/v1/finance/channel-terms", "manager")).status).toBe(403);
    expect((await call("GET", "/v1/finance/channel-terms?channel_id=nope", "owner")).status).toBe(400);
  });

  it("period close via the own route; then an expense dated in that month → 409 period_closed, 0 rows; the other outlet → 201", async () => {
    const close = await call("POST", "/v1/finance/period-closes", "owner", envelope("finance.period.close.v1", {
      period_close_id: uuidv7(), outlet_id: fx.outlets[0], period_month: "2026-02-01", net_minor: 0, currency: "INR",
      checklist: [{ item_code: "pnl_produced", evidence_ref: `snap:${uuidv7()}` }],
    }));
    expect(close.status).toBe(201);
    const exp = (outlet: string) => call("POST", "/v1/finance/expenses", "owner", envelope("finance.expense.record.v1", {
      expense_id: uuidv7(), outlet_id: outlet, category: "rent", incurred_on: "2026-02-10", amount_minor: 100000, tax_minor: 0, currency: "INR", payee: "Landlord", note: null, document_id: null,
    }));
    const refused = await exp(fx.outlets[0]);
    expect([refused.status, (await refused.json()).error]).toEqual([409, { code: "period_closed", message: expect.any(String), reason_code: "period_closed" }]);
    expect(await count(db, `SELECT count(*) n FROM core.expense WHERE tenant_id = $1 AND incurred_on = '2026-02-10'`, [fx.tenant])).toBe(0);
    expect((await exp(fx.outlets[1])).status).toBe(201);
  });
});

describe("malformed command envelopes (one code across modules)", () => {
  it("a wrong type or a bad payload → 422 invalid_payload; a body that is not JSON → 400", async () => {
    const good = { expense_id: uuidv7(), outlet_id: fx.outlets[0], category: "utilities", incurred_on: M, amount_minor: 100, tax_minor: 0, currency: "INR", payee: "Synthetic payee", note: null, document_id: null };
    const code = async (r: Res) => [r.status, (await r.json()).error.code];
    expect(await code(await call("POST", "/v1/finance/expenses", "owner", envelope("finance.wrong_type.v1", good)))).toEqual([422, "invalid_payload"]);
    expect(await code(await call("POST", "/v1/finance/expenses", "owner", envelope("finance.expense.record.v1", { ...good, amount_minor: "lots" })))).toEqual([422, "invalid_payload"]);
    const raw = await app.request("/v1/finance/expenses", { method: "POST", body: "{not json",
      headers: { Authorization: `Bearer ${idp.sign({ sub: fx.subs.owner })}`, [TENANT_HEADER]: fx.tenant, "Content-Type": "application/json" } });
    expect(await code(raw as Res)).toEqual([400, "bad_request"]);
    expect(await count(db, `SELECT count(*) n FROM core.expense WHERE id = $1`, [good.expense_id])).toBe(0);
  });
});

describe("journal adjust executes only via an approved draft", () => {
  let snap = "";
  async function mint(templateId: string, params: Record<string, unknown>): Promise<string> {
    const id = uuidv7();
    await db.withContext("munim_svc", { tenant_id: fx.tenant, outlet_ids: "*" }, async (c) => {
      const runId = uuidv7();
      await c.query(`INSERT INTO intel.run (tenant_id, id, trigger, actor, outlet_scope, expires_at) VALUES ($1, $2, 'event', 'watcher:events', '{*}', now() + interval '1 hour')`, [fx.tenant, runId]);
      const { rows } = await runTemplate(c, templateId, 1, params);
      await c.query(`INSERT INTO evidence.snapshot (tenant_id, id, template_id, template_version, params, run_id, outlet_scope, rows, row_count, sha256)
                     VALUES ($1, $2, $3, 1, $4, $5, '{*}', $6, $7, repeat('0', 64))`, [fx.tenant, id, templateId, params, runId, JSON.stringify(rows), rows.length]);
    });
    return id;
  }
  const adjustPayload = (amount: unknown, credit: unknown = amount) => ({
    journal_entry_id: uuidv7(), entry_date: "2026-01-15", outlet_id: null, reverses_id: null, currency: "INR", memo_key: "finance.memo.disputed_fee",
    postings: [{ account_id: fx.accounts["1100"], side: "debit", amount_minor: amount }, { account_id: fx.accounts["6010"], side: "credit", amount_minor: credit }],
  });
  async function draftOf(type: string, payload: Record<string, unknown>): Promise<string> {
    const id = uuidv7();
    await db.withContext("munim_svc", { tenant_id: fx.tenant, outlet_ids: "*" }, (c) =>
      c.query(`INSERT INTO core.draft (tenant_id, id, outlet_ids, source, command_type, command_payload) VALUES ($1, $2, '{}', 'intel:finance', $3, $4)`, [fx.tenant, id, type, payload]));
    return id;
  }
  const approve = (draftId: string, type: string, edited: Record<string, unknown> | null = null) => call("POST", `/v1/drafts/${draftId}:approve`, "owner", {
    command_id: uuidv7(), idempotency_key: `approve-${uuidv7()}`, type: "drafts.approve.v1",
    payload: { draft_id: draftId, command_type: type, edited_payload: edited, reason: edited ? "Owner corrected the amount" : null },
  });
  const entriesOn = () => count(db, `SELECT count(*) n FROM core.journal_entry WHERE tenant_id = $1 AND entry_date = '2026-01-15'`, [fx.tenant]);

  beforeAll(async () => {
    snap = await mint("finance.pnl", { period_month: M, group_by: "channel" });
  });

  it("there is no direct route (404)", async () => {
    const r = await call("POST", "/v1/finance/journal-adjustments", "owner", envelope("finance.journal.adjust.v1", adjustPayload(3000)));
    expect(r.status).toBe(404);
    expect(await entriesOn()).toBe(0);
  });

  it("the handler run as an owner's own command (no decision) is refused with 0 rows", async () => {
    const out = await executeCommand({
      tx: <T>(fn: (q: pg.PoolClient) => Promise<T>) => db.withContext("munim_core", { tenant_id: fx.tenant, outlet_ids: "*", role: "owner", member_id: fx.owner }, fn as never) as Promise<T>,
      tenantId: fx.tenant, actor: { kind: "member", id: fx.owner, role: "owner" },
    }, envelope("finance.journal.adjust.v1", adjustPayload(3000)), journalAdjust).then(() => "ok", (e: { code?: string }) => e.code);
    expect(out).toBe("forbidden");
    expect(await entriesOn()).toBe(0);
  });

  it("an unbalanced edit → 422, 0 entries, draft still proposed; approved as proposed → 1 entry under the decision", async () => {
    const rows = (await db.admin<{ rows: Array<Record<string, unknown>> }>(`SELECT rows FROM evidence.snapshot WHERE id = $1`, [snap])).rows[0]!.rows;
    const at = rows.findIndex((r) => r.key === fx.agg);
    const ref = snapRef(snap, at, "channel_fees_minor"); // 14550 (11550 commission + 3000 ad fee)
    const proposed = adjustPayload(ref);
    const d = await draftOf("finance.journal.adjust.v1", proposed);
    // The same draft with only the credit amount edited by the approver: debit 14550 ≠ credit 100.
    const edited = { ...proposed, postings: [proposed.postings[0], { ...proposed.postings[1], amount_minor: { value: 100, typed_by: fx.owner } }] };
    const bad = await approve(d, "finance.journal.adjust.v1", edited);
    expect([bad.status, (await bad.json()).error.code]).toEqual([422, "invalid_payload"]);
    expect(await entriesOn()).toBe(0);
    expect((await db.admin(`SELECT status FROM core.draft WHERE id = $1`, [d])).rows[0]!.status).toBe("proposed");

    const ok = await approve(d, "finance.journal.adjust.v1");
    expect(ok.status).toBe(200);
    expect(await entriesOn()).toBe(1);
    const e = (await db.admin<{ id: string; origin: { kind: string; decision_id: string }; decision_id: string }>(
      `SELECT id, origin, decision_id FROM core.journal_entry WHERE tenant_id = $1 AND entry_date = '2026-01-15'`, [fx.tenant])).rows[0]!;
    expect(e.origin.kind).toBe("decision");
    expect(e.decision_id).toBe(e.origin.decision_id);
    const p = await db.admin(`SELECT amount_minor FROM core.posting WHERE journal_entry_id = $1 ORDER BY amount_minor`, [e.id]);
    expect(p.rows.map((x) => x.amount_minor)).toEqual(["-14550", "14550"]);
  });

  it("period close as an approved draft writes the close under the decision (net from a cited P&L cell)", async () => {
    const pnl = await mint("finance.pnl", { period_month: M, group_by: "outlet" });
    const rows = (await db.admin<{ rows: Array<Record<string, unknown>> }>(`SELECT rows FROM evidence.snapshot WHERE id = $1`, [pnl])).rows[0]!.rows;
    const at = rows.findIndex((r) => r.key === fx.outlets[1]);
    const closeId = uuidv7();
    const d = await draftOf("finance.period.close.v1", {
      period_close_id: closeId, outlet_id: null, period_month: "2025-12-01", currency: "INR", net_minor: snapRef(pnl, at, "net_minor"),
      checklist: [{ item_code: "pnl_produced", evidence_ref: `snap:${pnl}` }],
    });
    expect((await approve(d, "finance.period.close.v1")).status).toBe(200);
    const pc = (await db.admin<{ net_minor: string; origin: { kind: string } }>(`SELECT net_minor, origin FROM core.period_close WHERE id = $1`, [closeId])).rows[0]!;
    expect([pc.net_minor, pc.origin.kind]).toEqual(["23650", "decision"]);
  });
});

describe("Tally export", () => {
  it("owner and advisor → 200 with one row per posting (hand-checked rows); manager → 403", async () => {
    // The whole fixture month, whatever today's date (orders take today's business date).
    const end = (await db.admin<{ e: string }>(`SELECT (date_trunc('month', $1::date) + interval '1 month - 1 day')::date::text e`, [M])).rows[0]!.e;
    const r = await call("GET", `/v1/finance/exports/tally?from=${M}&to=${end}`, "owner");
    expect(r.status).toBe(200);
    const body = TallyExport.parse(await r.json());
    expect(body.file_name).toBe(`munim-tally-${M}-to-${end}.csv`);
    const lines: string[] = body.content.trimEnd().split("\r\n");
    expect(lines[0]).toBe("Date,Voucher Type,Voucher No,Ledger Code,Ledger,Debit,Credit,Narration");
    const o1 = (await db.admin<{ id: string; d: string }>(`SELECT id, to_char(entry_date, 'DD-MM-YYYY') d FROM core.journal_entry WHERE source_id = $1`, [ids.o1])).rows[0]!;
    expect(lines.filter((l) => l.includes(o1.id))).toEqual([
      `${o1.d},Journal,${o1.id},1110,Counter sales clearing,1050.00,,finance.post_order`,
      `${o1.d},Journal,${o1.id},2100,Output GST payable,,50.00,finance.post_order`,
      `${o1.d},Journal,${o1.id},4000,Food and beverage sales,,1000.00,finance.post_order`,
    ]);
    const postings = await count(db, `SELECT count(*) n FROM core.posting p JOIN core.journal_entry je ON je.tenant_id = p.tenant_id AND je.id = p.journal_entry_id
                                       WHERE je.tenant_id = $1 AND je.entry_date BETWEEN $2::date AND $3::date`, [fx.tenant, M, end]);
    expect(lines.length - 1).toBe(postings);
    expect((await call("GET", `/v1/finance/exports/tally?from=${M}&to=${M}`, "advisor")).status).toBe(200);
    const mgr = await call("GET", `/v1/finance/exports/tally?from=${M}&to=${M}`, "manager");
    expect([mgr.status, (await mgr.json()).error.reason_code]).toEqual([403, "authority_denied"]);
    expect((await call("GET", `/v1/finance/exports/tally?from=${M}&to=2020-01-01`, "owner")).status).toBe(400);
  });
});
