// T-028 gates — the customers module (member side) through the real app and the real seams.
//   loyalty: earn on complete / reverse on cancel (fixture, hand-computed); 50 concurrent redeems never drive the
//   balance below 0 and balance_after is consistent; a direct campaign insert is refused and only an approved
//   decision creates one; no code path sends a message (scanner + test); a customer context sees only its own rows.
// Hand-computed expectations (the world's business_policy defaults, W2-R4: 1 point per 1,000 minor of subtotal −
// discount, 1 point = 10 minor at redemption; the last gate adds a policy version and checks the new rates):
//   order N1: subtotal 32000, discount 0 → 32 points.   order N2: subtotal 45500, discount 4500 → 41000/1000 = 41.
// Synthetic data only.
import { createLogger } from "@munim/config";
import { CommandResult, snapRef } from "@munim/contracts";
import {
  BulkOrderListResponse, CampaignListResponse, CouponUseListResponse, CustomerListResponse, LoyaltyLedgerResponse, ReservationListResponse, ReviewListResponse,
} from "@munim/contracts/customers";
import { type AppContext, type TestDb } from "@munim/db";
import type { Hono } from "hono";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppEnv, createApp, TENANT_HEADER } from "../src/app.ts";
import type { Queryable } from "../src/runtoken/index.ts";
import { executeCommand, uuidv7 } from "../src/commit/index.ts";
import { campaignCreate } from "../src/modules/customers/records.ts";
import { loyaltyEarnFor, loyaltyRedeem, loyaltyReverseFor, readLoyalty } from "../src/modules/customers/index.ts";
import { runTemplate } from "../src/modules/approvals/snapshots.ts";
import { createLocalIdp } from "../src/auth/local-idp.ts";
import { openDb } from "./db.ts";
import { findSendPaths, SENT_ALLOWED_IN } from "./customers.nosend.ts";
import { buildTenant, type Tenant } from "./world.ts";

const idp = createLocalIdp();
let db: TestDb;
let pools: { core: pg.Pool; svc: pg.Pool };
let app: Hono<AppEnv>;
let t: Tenant;
const staffSub = `staff-${uuidv7()}`;
const advisorSub = `advisor-${uuidv7()}`;
const advisor = uuidv7();

type Res = Omit<Response, "json"> & { json(): Promise<any> };
const call = async (method: string, path: string, sub: string, body?: unknown): Promise<Res> =>
  (await app.request(path, {
    method,
    headers: { Authorization: `Bearer ${idp.sign({ sub })}`, [TENANT_HEADER]: t.tenant, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })) as Res;
const env = (type: string, payload: unknown, key = `k-${uuidv7()}`) => ({ command_id: uuidv7(), idempotency_key: key, type, payload });
type Who = "owner" | "manager" | "staff" | "advisor";
const sub = (w: Who) => ({ owner: t.ownerSub, manager: t.managerSub, staff: staffSub, advisor: advisorSub })[w];
const post = (w: Who, path: string, type: string, payload: unknown) => call("POST", path, sub(w), env(type, payload));
const get = (w: Who, path: string) => call("GET", path, sub(w));
const one = async <R extends pg.QueryResultRow>(sql: string, params: unknown[] = []) => (await db.admin(sql, params)).rows[0] as R;
const count = async (sql: string, params: unknown[] = []) => Number((await one<{ n: string }>(sql, params)).n);
const err = async (r: Res) => {
  const b = await r.json();
  return { status: r.status, code: b.error.code, reason: b.error.reason_code };
};

const own = (command_type: string): AppContext => ({ tenant_id: t.tenant, outlet_ids: "*", role: "owner", member_id: t.owner, command_type });
const asCustomer = (customer_id: string, command_type?: string): AppContext => ({
  tenant_id: t.tenant, outlet_ids: [], role: "customer", customer_id, ...(command_type ? { command_type } : {}),
});

/** A customer record entered by a member (is_guest false), or a guest (is_guest true) when `guest`. */
async function customer(name: string, o: { guest?: boolean; phone?: string | null; email?: string | null } = {}): Promise<string> {
  const id = uuidv7();
  await db.withContext("munim_core", own("customers.customer.upsert.v1"), (c) =>
    c.query(`INSERT INTO core.customer (tenant_id, id, name, phone, email, is_guest) VALUES ($1, $2, $3, $4, $5, $6)`,
      [t.tenant, id, name, o.phone ?? null, o.email ?? null, o.guest ?? false]));
  return id;
}
async function order(customerId: string | null, subtotal = 32000, discount = 0): Promise<string> {
  const id = uuidv7();
  const tax = 1600;
  await db.withContext("munim_core", own("orders.place.v1"), (c) =>
    c.query(`INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, kind, status, subtotal_minor, discount_minor, tax_minor, total_minor, currency,
                                       pricing_snapshot, customer_id)
             VALUES ($1, $2, $3, $4, 'pickup', 'placed', $5, $6, $7, $8, $9, '{}', $10)`,
      [t.tenant, id, t.outlets[0], t.channel, subtotal, discount, tax, subtotal - discount + tax, t.currency, customerId]));
  return id;
}
/** Moves an order along the legal chain, then runs `after` in the SAME transaction (the seam's documented contract). */
async function advance<T>(orderId: string, to: "completed" | "cancelled", after: (c: Queryable) => Promise<T>): Promise<T> {
  return db.withContext("munim_core", own("kitchen.ticket.advance.v1"), async (c) => {
    const chain = to === "completed" ? ["accepted", "preparing", "ready", "completed"] : ["cancelled"];
    for (const s of chain) await c.query(`UPDATE core."order" SET status = $2 WHERE id = $1`, [orderId, s]);
    return after(c);
  });
}
const adjust = (who: Who, customerId: string, points: number, note = "fixture seed") =>
  post(who, "/v1/loyalty:adjust", "customers.loyalty.adjust.v1", { customer_id: customerId, points, note });
const ledger = async (customerId: string) =>
  (await db.admin(`SELECT seq::int, kind, points::int, balance_after::int, order_id, reverses_id, origin->>'kind' AS origin_kind, origin->>'rule_id' AS rule
                     FROM core.loyalty_entry WHERE customer_id = $1 ORDER BY seq`, [customerId])).rows as
    Array<{ seq: number; kind: string; points: number; balance_after: number; order_id: string | null; reverses_id: string | null; origin_kind: string; rule: string | null }>;

beforeAll(async () => {
  db = await openDb();
  t = await buildTenant(db, "customers");
  await db.withContext("munim_core", own("tenancy.member.invite.v1"), async (c) => {
    await c.query(`UPDATE core.member SET idp_sub = $3 WHERE tenant_id = $1 AND id = $2`, [t.tenant, t.staff, staffSub]);
    await c.query(`INSERT INTO core.member (tenant_id, id, idp_sub, name, email) VALUES ($1, $2, $3, 'Advisor', 'advisor@example.test')`, [t.tenant, advisor, advisorSub]);
    await c.query(`INSERT INTO core.membership (tenant_id, member_id, role, outlet_ids) VALUES ($1, $2, 'advisor', '{}')`, [t.tenant, advisor]);
  });
  pools = { core: db.pool("munim_core", 24), svc: db.pool("munim_svc", 2) };
  const config = { nodeEnv: "test", redact: (s: string) => s };
  app = await createApp({ pools, idp, storefronts: async () => null, config, log: createLogger(config, () => {}) });
  // Test-only template (fixture DB clone): a consented-audience cell, the number a campaign draft cites.
  await db.admin(`INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES
    ('test.consented_audience', 1, $1, '{"type":"object"}', $2, 'manager')`, [
    `SELECT :audience::int AS consented`,
    JSON.stringify([{ name: "consented", type: "integer", numeric_source: "core.campaign.audience_count" }]),
  ]);
});
afterAll(async () => {
  await pools?.core.end();
  await pools?.svc.end();
  await db?.stop();
});

describe("loyalty: earn on complete, reverse on cancel (derived rows, hand-computed)", () => {
  it("redeem at checkout, cancel gives it back; a completed order earns floor(net/1000) once", async () => {
    const x = await customer("Synthetic Regular");
    expect((await adjust("owner", x, 100)).status).toBe(200);

    const n1 = await order(x, 32000);
    const redeemed = await db.withContext("munim_core", own("orders.place.v1"), (c) => loyaltyRedeem(c, n1, 40));
    expect(redeemed.points).toBe(-40);
    expect((await ledger(x)).map((e) => [e.kind, e.points, e.balance_after])).toEqual([["adjust", 100, 100], ["redeem", -40, 60]]);

    // Cancel → the redeem is reversed under the derivation rule, in the same transaction as the status change.
    const rev = await advance(n1, "cancelled", (c) => loyaltyReverseFor(c, n1));
    expect(rev.map((r) => r.points)).toEqual([40]);
    const after = await ledger(x);
    expect(after.map((e) => [e.kind, e.points, e.balance_after])).toEqual([["adjust", 100, 100], ["redeem", -40, 60], ["reverse", 40, 100]]);
    expect(after[2]).toMatchObject({ origin_kind: "derivation", rule: "customers.loyalty_reverse", reverses_id: expect.any(String) });
    // Idempotent: a second reverse writes nothing.
    expect(await db.withContext("munim_core", own("kitchen.ticket.advance.v1"), (c) => loyaltyReverseFor(c, n1))).toEqual([]);

    // Earn: 32000 net → 32 points; a second earn is a no-op.
    const n2 = await order(x, 32000);
    const earned = await advance(n2, "completed", (c) => loyaltyEarnFor(c, n2));
    expect(earned?.points).toBe(32);
    expect(await db.withContext("munim_core", own("kitchen.ticket.advance.v1"), (c) => loyaltyEarnFor(c, n2))).toBeNull();
    const l = await ledger(x);
    expect(l.at(-1)).toMatchObject({ kind: "earn", points: 32, balance_after: 132, origin_kind: "derivation", rule: "customers.loyalty_earn", order_id: n2 });
    expect(l.length).toBe(4);
    // Reversing a completed order is not a thing (only cancelled / rejected): nothing is written.
    expect(await db.withContext("munim_core", own("kitchen.ticket.advance.v1"), (c) => loyaltyReverseFor(c, n2))).toEqual([]);
    expect((await ledger(x)).length).toBe(4);
  });

  it("R2-S2-4 / W2-R10: a completed order's earn is taken back in full by the refund that makes it fully refunded; a partial refund keeps it", async () => {
    const z = await customer("Synthetic Refunded");
    const o = await order(z, 32000); // total 33,600 → earn 32
    expect((await advance(o, "completed", (c) => loyaltyEarnFor(c, o)))?.points).toBe(32);
    const money = (type: string, sql: string, params: unknown[]) => db.withContext("munim_core", own(type), (c) => c.query(sql, params));
    const tender = uuidv7();
    await money("orders.tender.record.v1", `INSERT INTO core.tender (tenant_id, id, outlet_id, order_id, method, amount_minor, rounding_minor, currency, recorded_by)
                                           VALUES ($1, $2, $3, $4, 'card', 33600, 0, $5, $6)`, [t.tenant, tender, t.outlets[0], o, t.currency, t.owner]);
    const refunds: string[] = [];
    const refund = async (amount: number) => {
      const id = uuidv7();
      refunds.push(id);
      await money("orders.refund.record.v1",
        `INSERT INTO core.refund (tenant_id, id, outlet_id, order_id, tender_id, method, amount_minor, currency, reason_code, note, actor)
         VALUES ($1, $2, $3, $4, $5, 'card', $6, $7, 'complaint', 'synthetic', $8)`, [t.tenant, id, t.outlets[0], o, tender, amount, t.currency, t.owner]);
    };
    const reverse = () => db.withContext("munim_core", own("orders.refund.record.v1"), (c) => loyaltyReverseFor(c, o));
    // Completed, nothing refunded: nothing to take back.
    expect(await reverse()).toEqual([]);
    // Half refunded: money is still paid, the points stay.
    await refund(16800);
    expect(await reverse()).toEqual([]);
    // The rest refunded: the order is fully refunded → the whole earn goes back, citing that refund (0016 refund_id).
    await refund(16800);
    expect((await reverse()).map((r) => r.points)).toEqual([-32]);
    const l = await db.admin<{ kind: string; points: number; balance_after: number; refund_id: string | null; src: string }>(
      `SELECT kind, points::int, balance_after::int, refund_id, origin ->> 'source_ref' AS src FROM core.loyalty_entry WHERE customer_id = $1 ORDER BY seq`, [z]);
    expect(l.rows.map((e) => [e.kind, e.points, e.balance_after, e.refund_id, e.src])).toEqual([
      ["earn", 32, 32, null, `core.order:${o}`], ["reverse", -32, 0, refunds[1], `core.refund:${refunds[1]}`]]);
    // Idempotent: the earn has its one reversal.
    expect(await reverse()).toEqual([]);
  });

  it("net amount: subtotal − discount; no customer / guest / not completed → no entry", async () => {
    const y = await customer("Synthetic Discount Buyer");
    const n = await order(y, 45500, 4500);
    expect((await advance(n, "completed", (c) => loyaltyEarnFor(c, n)))?.points).toBe(41);

    const g = await customer("Synthetic Guest", { guest: true });
    const gn = await order(g, 90000);
    expect(await advance(gn, "completed", (c) => loyaltyEarnFor(c, gn))).toBeNull();
    expect((await ledger(g)).length).toBe(0);
    const walkIn = await order(null, 90000);
    expect(await advance(walkIn, "completed", (c) => loyaltyEarnFor(c, walkIn))).toBeNull();
    const pending = await order(y, 90000);
    expect(await db.withContext("munim_core", own("kitchen.ticket.advance.v1"), (c) => loyaltyEarnFor(c, pending))).toBeNull();
    expect((await ledger(y)).length).toBe(1);
  });

  it("the derivation context cannot be abused: an earn row for an order that is not completed is refused by the guard", async () => {
    const z = await customer("Synthetic Abuser");
    const open = await order(z, 99000);
    await expect(db.withContext("munim_core", { ...own("kitchen.ticket.advance.v1"), posting_rule: "customers.loyalty_earn", source_ref: `core.order:${open}` }, (c) =>
      c.query(`INSERT INTO core.loyalty_entry (tenant_id, id, customer_id, seq, kind, points, balance_after, order_id, origin)
               VALUES ($1, $2, $3, 0, 'earn', 99, 0, $4, '{}')`, [t.tenant, uuidv7(), z, open]))).rejects.toMatchObject({ code: "MB008" });
    // The same row with no derivation, under a command that does not list loyalty_entry, is refused too.
    await expect(db.withContext("munim_core", { ...own("catalogue.price.set.v1") }, (c) =>
      c.query(`INSERT INTO core.loyalty_entry (tenant_id, id, customer_id, seq, kind, points, balance_after, order_id, origin)
               VALUES ($1, $2, $3, 0, 'adjust', 5, 0, $4, '{}')`, [t.tenant, uuidv7(), z, open]))).rejects.toMatchObject({ code: "MB008" });
    expect((await ledger(z)).length).toBe(0);
  });
});

describe("loyalty: concurrency (R40 C2)", () => {
  it("50 concurrent redeems of 10 against a balance of 100 → exactly 10 succeed, 40 refused, balance 0, ledger consistent", async () => {
    const w = await customer("Synthetic Racer");
    expect((await adjust("owner", w, 100)).status).toBe(200);
    const orders = await Promise.all(Array.from({ length: 50 }, () => order(w, 10000)));
    const results = await Promise.allSettled(orders.map((o) =>
      db.withContext("munim_core", own("orders.place.v1"), (c) => loyaltyRedeem(c, o, 10))));
    const ok = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect([ok.length, refused.length]).toEqual([10, 40]);
    expect(new Set(refused.map((r) => (r.reason as { code?: string }).code))).toEqual(new Set(["MB011"]));

    const rows = await ledger(w);
    expect(rows.length).toBe(11);
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    let bal = 0;
    for (const r of rows) {
      bal += r.points;
      expect(r.balance_after).toBe(bal); // each balance_after = previous + points
      expect(r.balance_after).toBeGreaterThanOrEqual(0);
    }
    expect(rows.at(-1)!.balance_after).toBe(0);
    const view = LoyaltyLedgerResponse.parse(await (await get("owner", `/v1/customers/${w}/loyalty`)).json());
    expect([view.balance, view.entries.length, view.entries[0]!.seq]).toEqual([0, 11, 11]);
  });

  it("a negative adjustment that would go below zero → 409 loyalty_refused, nothing written; within the balance → 200", async () => {
    const v = await customer("Synthetic Small Balance");
    expect((await adjust("owner", v, 5)).status).toBe(200);
    expect(await err(await adjust("owner", v, -6))).toEqual({ status: 409, code: "loyalty_refused", reason: null });
    expect((await ledger(v)).length).toBe(1);
    expect((await adjust("owner", v, -5)).status).toBe(200);
    expect((await ledger(v)).at(-1)!.balance_after).toBe(0);
    // Only owner / manager / judge may adjust.
    expect(await err(await adjust("staff", v, 3))).toEqual({ status: 403, code: "book_write_refused", reason: "authority_denied" });
  });
});

describe("campaigns: drafts only, never sent", () => {
  const draftFor = async (payload: Record<string, unknown>, basedOn: string[]) => {
    const id = uuidv7();
    await db.withContext("munim_svc", { tenant_id: t.tenant, outlet_ids: "*", role: "service" }, (c) =>
      c.query(`INSERT INTO core.draft (tenant_id, id, outlet_ids, source, command_type, command_payload, based_on) VALUES ($1, $2, '{}', 'intel:customers', 'customers.campaign.create.v1', $3, $4)`,
        [t.tenant, id, payload, JSON.stringify(basedOn)]));
    return id;
  };
  const mint = async (audience: number): Promise<string> => {
    const id = uuidv7();
    await db.withContext("munim_svc", { tenant_id: t.tenant, outlet_ids: "*", role: "service" }, async (c) => {
      const run = uuidv7();
      await c.query(`INSERT INTO intel.run (tenant_id, id, trigger, actor, outlet_scope, expires_at) VALUES ($1, $2, 'event', 'watcher:events', '{*}', now() + interval '1 hour')`, [t.tenant, run]);
      const { rows } = await runTemplate(c, "test.consented_audience", 1, { audience });
      await c.query(`INSERT INTO evidence.snapshot (tenant_id, id, template_id, template_version, params, run_id, outlet_scope, rows, row_count, sha256)
                     VALUES ($1, $2, 'test.consented_audience', 1, $3, $4, '{*}', $5, $6, repeat('0', 64))`, [t.tenant, id, { audience }, run, JSON.stringify(rows), rows.length]);
    });
    return id;
  };
  const payloadFor = (snap: string, campaign = uuidv7()) => {
    const ref = snapRef(snap, 0, "consented");
    return {
      campaign_id: campaign, name: "Come back", channel: "email", outlet_ids: [], segment_snapshot_id: snap, audience_count: ref,
      message_key: "campaign.come_back", placeholders: [{ key: "regulars", value: ref }], coupon_id: null, send_at: "2026-10-20T10:00:00+05:30",
      window_from: null, window_to: null,
    };
  };
  const approve = (draftId: string) => call("POST", `/v1/drafts/${draftId}:approve`, t.ownerSub,
    env("drafts.approve.v1", { draft_id: draftId, command_type: "customers.campaign.create.v1", edited_payload: null, reason: null }));

  it("a person's direct campaign insert is refused (MB001) even for an owner with authority for the command", async () => {
    const before = await count(`SELECT count(*) n FROM core.campaign`);
    const snap = await mint(12);
    const direct = { ...payloadFor(snap), audience_count: 12, placeholders: [{ key: "regulars", value: 12 }] };
    await expect(executeCommand(
      { tx: (fn) => db.withContext("munim_core", own("customers.campaign.create.v1"), fn), tenantId: t.tenant, actor: { kind: "member", id: t.owner, role: "owner" } },
      env("customers.campaign.create.v1", direct as Record<string, unknown>) as Parameters<typeof executeCommand>[1], campaignCreate)).rejects.toMatchObject({ code: "MB001" });
    expect(await count(`SELECT count(*) n FROM core.campaign`)).toBe(before);
    // There is no HTTP route to create or send one either.
    for (const p of ["/v1/campaigns", "/v1/campaigns:create", "/v1/campaigns:send", "/v1/campaigns/send"]) {
      expect((await post("owner", p, "customers.campaign.create.v1", direct)).status).toBe(404);
    }
    expect(await count(`SELECT count(*) n FROM core.campaign`)).toBe(before);
  });

  it("approving the draft creates one queued campaign under the decision; zero consented audience → refused no_marketing_consent", async () => {
    const snap = await mint(12);
    const p = payloadFor(snap);
    const d = await draftFor(p, [p.audience_count as string]);
    const ok = await approve(d);
    expect(ok.status).toBe(200);
    expect(CommandResult.parse(await ok.json())).toMatchObject({ type: "customers.campaign.create.v1", entity_id: p.campaign_id });
    const row = await one<{ status: string; audience_count: number; origin: { kind: string }; placeholders: Record<string, number> }>(
      `SELECT status, audience_count, origin, placeholders FROM core.campaign WHERE id = $1`, [p.campaign_id]);
    expect(row).toMatchObject({ status: "queued", audience_count: 12, origin: { kind: "decision" }, placeholders: { regulars: 12 } });

    const zeroSnap = await mint(0);
    const zp = payloadFor(zeroSnap);
    const zd = await draftFor(zp, [zp.audience_count as string]);
    const before = await count(`SELECT count(*) n FROM core.campaign`);
    expect(await err(await approve(zd))).toEqual({ status: 422, code: "invalid_payload", reason: "no_marketing_consent" });
    expect(await count(`SELECT count(*) n FROM core.campaign`)).toBe(before);
    expect((await one<{ status: string }>(`SELECT status FROM core.draft WHERE id = $1`, [zd])).status).toBe("proposed");

    const list = CampaignListResponse.parse(await (await get("owner", "/v1/campaigns")).json());
    expect(list.campaigns.find((c) => c.campaign_id === p.campaign_id)).toMatchObject({ status: "queued", never_auto_sent: true, audience_count: 12 });
    // cancel: queued → cancelled once; again → illegal_transition
    expect((await post("manager", "/v1/campaigns:cancel", "customers.campaign.cancel.v1", { campaign_id: p.campaign_id })).status).toBe(403); // tenant-scoped: an outlet manager is refused
    expect((await post("owner", "/v1/campaigns:cancel", "customers.campaign.cancel.v1", { campaign_id: p.campaign_id })).status).toBe(200);
    expect(await err(await post("owner", "/v1/campaigns:cancel", "customers.campaign.cancel.v1", { campaign_id: p.campaign_id }))).toEqual({ status: 409, code: "illegal_transition", reason: null });
    // Nothing in this module ever marks a campaign sent.
    expect(await count(`SELECT count(*) n FROM core.campaign WHERE status = 'sent'`)).toBe(0);
  });

  it("R67: recording a queued campaign as sent (simulated) — refused demo_only on a business that is not a demo; on a demo business the owner's command moves it once", async () => {
    const snap = await mint(7);
    const p = payloadFor(snap);
    expect((await approve(await draftFor(p, [p.audience_count as string]))).status).toBe(200);
    const sent = () => post("owner", "/v1/campaigns:record-sent", "customers.campaign.record_sent.v1", { campaign_id: p.campaign_id });
    const once = env("customers.campaign.record_sent.v1", { campaign_id: p.campaign_id });
    const statusOf = async () => (await one<{ status: string }>(`SELECT status FROM core.campaign WHERE id = $1`, [p.campaign_id])).status;
    expect(await err(await sent())).toEqual({ status: 403, code: "forbidden", reason: "demo_only" });
    expect(await statusOf()).toBe("queued");
    // is_demo is the operator's (provisioning); the fixture flips it as plumbing, then puts it back.
    const demo = (on: boolean) => db.admin(`SET session_replication_role = replica; UPDATE core.tenant SET is_demo = ${on} WHERE tenant_id = '${t.tenant}'; RESET session_replication_role`);
    await demo(true);
    try {
      expect((await post("manager", "/v1/campaigns:record-sent", "customers.campaign.record_sent.v1", { campaign_id: p.campaign_id })).status).toBe(403);
      const first = await call("POST", "/v1/campaigns:record-sent", t.ownerSub, once);
      const body = await first.text();
      const replay = await call("POST", "/v1/campaigns:record-sent", t.ownerSub, once);
      expect([first.status, replay.status, replay.headers.get("X-Munim-Replayed"), (await replay.text()) === body]).toEqual([200, 200, "true", true]);
      expect(await statusOf()).toBe("sent");
      expect(await err(await sent())).toEqual({ status: 409, code: "illegal_transition", reason: null });
      expect(await count(`SELECT count(*) n FROM core.audit_log WHERE entity = 'core.campaign' AND entity_id = $1 AND after ->> 'status' = 'sent'`, [p.campaign_id])).toBe(1);
      const audit = await one<{ after: { status: string; simulated: boolean } }>(
        `SELECT after FROM core.audit_log WHERE entity = 'core.campaign' AND entity_id = $1 AND after ->> 'status' = 'sent'`, [p.campaign_id]);
      expect(audit.after).toEqual({ status: "sent", simulated: true });
      const list = CampaignListResponse.parse(await (await get("owner", "/v1/campaigns")).json());
      expect(list.campaigns.find((c) => c.campaign_id === p.campaign_id)).toMatchObject({ status: "sent", never_auto_sent: true });
    } finally {
      await demo(false);
    }
  });
});

describe("no code path sends a message (R40 C6)", () => {
  const MODULE = new URL("../src/modules/customers/", import.meta.url).pathname;
  it("the scanner finds nothing in the customers module", () => {
    const hits = findSendPaths(MODULE);
    expect(hits).toEqual([]);
  });
  it("red-proof: the scanner flags each planted send path", () => {
    const planted = [
      `await fetch("https://api.example.test/send", { method: "POST" });`,
      `import nodemailer from "nodemailer";`,
      `import { request } from "node:https";`,
      `await c.query("UPDATE core.campaign SET status = 'sent'");`,
      `const status = "sent";`,
      `import { twilio } from "twilio";`,
      `import { Mail } from "@vendor/mail-sdk";`,
      `import x from "../../../../adapters/mail/index.ts";`,
      `import { createHttpPublisher } from "../../commit/publisher-http.ts";`,
      `sendEmail(to, body);`,
      `net.connect(587, "smtp.example.test");`,
    ];
    for (const line of planted) expect(findSendPaths(MODULE, { extra: { "planted.ts": line } }).length, line).toBeGreaterThanOrEqual(1);
  });
  it("R67: the sent status is allowed only in campaign-sent.ts, which is still scanned for every send path", () => {
    const sent = `await c.query("UPDATE core.campaign SET status = 'sent'");`;
    // the same line in any other file of the module is a hit; in the allowed file alone it is not …
    expect(findSendPaths(MODULE, { extra: { [`${MODULE}records-extra.ts`]: sent } })).toHaveLength(1);
    expect(findSendPaths(MODULE, { extra: { [`${MODULE}${SENT_ALLOWED_IN}`]: sent } })).toEqual([]);
    // … and a send path planted in the allowed file is still found.
    for (const line of [`await fetch("https://sms.example.test", { method: "POST" });`, `import { twilio } from "twilio";`, `sendSms(to, body);`]) {
      expect(findSendPaths(MODULE, { extra: { [`${MODULE}${SENT_ALLOWED_IN}`]: `${sent}\n${line}` } }).length, line).toBeGreaterThanOrEqual(1);
    }
  });
  it("the router exposes no send/create route for campaigns", async () => {
    const mod = await import("../src/modules/customers/index.ts");
    const paths = (mod.router.routes as Array<{ method: string; path: string }>).map((r) => `${r.method} ${r.path}`);
    // R67: record-sent records a demo campaign as sent (simulated); it sends nothing (the scanner above covers its file).
    expect([...new Set(paths.filter((p) => /campaign/.test(p)))].sort()).toEqual(["GET /v1/campaigns", "POST /v1/campaigns:cancel", "POST /v1/campaigns:record-sent"]);
  });
});

describe("a customer context sees only its own loyalty rows (R41)", () => {
  it("A reads A's ledger and nothing of B's; inserting for B is refused; the owner sees both", async () => {
    const a = await customer("Synthetic Customer A");
    const b = await customer("Synthetic Customer B");
    expect((await adjust("owner", a, 50)).status).toBe(200);
    expect((await adjust("owner", b, 70)).status).toBe(200);
    const aOrder = await order(a, 20000);

    const mine = await db.withContext("munim_core", asCustomer(a), (c) => readLoyalty(c, a));
    expect([mine.balance, mine.entries.length]).toEqual([50, 1]);
    const theirs = await db.withContext("munim_core", asCustomer(a), (c) => readLoyalty(c, b));
    expect([theirs.balance, theirs.entries.length]).toEqual([0, 0]);
    const all = await db.withContext("munim_core", asCustomer(a), async (c) =>
      (await c.query(`SELECT count(*)::int n FROM core.loyalty_entry WHERE customer_id = ANY($1)`, [[a, b]])).rows[0].n as number);
    expect(all).toBe(1);

    // The customer's own redeem on its own order is accepted (orders.place.v1 lists loyalty_entry for customers)…
    const red = await db.withContext("munim_core", asCustomer(a, "orders.place.v1"), (c) => loyaltyRedeem(c, aOrder, 20));
    expect(red.points).toBe(-20);
    expect((await readLoyalty(await asOwner(), a)).balance).toBe(30);
    // …a redeem written for B's balance is not.
    await expect(db.withContext("munim_core", asCustomer(a, "orders.place.v1"), (c) =>
      c.query(`INSERT INTO core.loyalty_entry (tenant_id, id, customer_id, seq, kind, points, balance_after, origin) VALUES ($1, $2, $3, 0, 'redeem', -5, 0, '{}')`,
        [t.tenant, uuidv7(), b]))).rejects.toBeTruthy();
    expect((await ledger(b)).length).toBe(1);

    const ownerSees = await db.withContext("munim_core", own("customers.customer.upsert.v1"), async (c) =>
      (await c.query(`SELECT count(*)::int n FROM core.loyalty_entry WHERE customer_id = ANY($1)`, [[a, b]])).rows[0].n as number);
    expect(ownerSees).toBe(3); // a: adjust + redeem, b: adjust
  });
  async function asOwner() {
    // A throwaway read client under the owner context (committed data only).
    return { query: (sql: string, params?: unknown[]) => db.admin(sql, params) } as unknown as pg.PoolClient;
  }
});

describe("customer records, role limits and the rest of the member surface", () => {
  it("search by name and by phone digits; staff see masked contacts; an advisor is refused; consent can only be withdrawn", async () => {
    const id = uuidv7();
    const up = await post("owner", "/v1/customers:upsert", "customers.customer.upsert.v1",
      { customer_id: id, name: "Zainab Searchable", phone: "+919876543210", email: "zainab@example.test", withdraw_consent: ["sms"] });
    expect(up.status).toBe(200);
    expect(CommandResult.parse(await up.json()).entity_id).toBe(id);
    expect(await one(`SELECT consent, is_guest FROM core.customer WHERE id = $1`, [id])).toEqual({ consent: { sms: false }, is_guest: false });

    const byName = CustomerListResponse.parse(await (await get("owner", "/v1/customers?q=searchable")).json());
    expect(byName.customers.map((c) => [c.customer_id, c.phone, c.email])).toEqual([[id, "+919876543210", "zainab@example.test"]]);
    const byPhone = CustomerListResponse.parse(await (await get("staff", "/v1/customers?q=3210")).json());
    expect(byPhone.customers.map((c) => [c.customer_id, c.phone, c.email])).toEqual([[id, "+91••••••3210", null]]);
    // R1-m2: staff match only what they are shown — the full number or the email finds nothing for staff, and the same
    // searches find the customer for the owner (paired).
    const found = async (who: "owner" | "staff", q: string) =>
      CustomerListResponse.parse(await (await get(who, `/v1/customers?q=${encodeURIComponent(q)}`)).json()).customers.map((c) => c.customer_id);
    expect([await found("staff", "98765 43210"), await found("staff", "zainab@example"), await found("staff", "876543")]).toEqual([[], [], []]);
    expect([await found("owner", "98765 43210"), await found("owner", "zainab@example"), await found("owner", "876543")]).toEqual([[id], [id], [id]]);
    expect(await err(await get("advisor", "/v1/customers"))).toEqual({ status: 403, code: "forbidden", reason: null });
    expect((await get("owner", "/v1/customers?q=%25")).status).toBe(200); // a LIKE wildcard is a literal
    expect(CustomerListResponse.parse(await (await get("owner", "/v1/customers?q=%25")).json()).customers).toEqual([]);

    // A consent flag cannot be granted through this command (strict payload) and withdrawing is monotonic.
    const grant = await post("owner", "/v1/customers:upsert", "customers.customer.upsert.v1",
      { customer_id: id, name: "Zainab Searchable", phone: null, email: null, withdraw_consent: [], consent: { email: true } });
    expect(await err(grant)).toEqual({ status: 422, code: "invalid_payload", reason: null });
    const edit = await post("manager", "/v1/customers:upsert", "customers.customer.upsert.v1",
      { customer_id: id, name: "Zainab S.", phone: null, email: null, withdraw_consent: ["email"] });
    expect(edit.status).toBe(200);
    expect(await one(`SELECT name, phone, consent FROM core.customer WHERE id = $1`, [id])).toEqual({ name: "Zainab S.", phone: null, consent: { sms: false, email: false } });
  });

  it("C3/R71: a customer's own grant {marketing, at} shows as email consent only (sms needs its own flag), and an explicit staff withdrawal wins", async () => {
    // [name, the stored consent, the view's flags] — typed by hand from R71 (a value that is not a boolean is not set).
    const cases = [
      ["R71 Granted", { marketing: true, at: "2026-10-16T09:00:00Z" }, { email: true, sms: false }],
      ["R71 Declined", { marketing: false, at: "2026-10-16T09:00:00Z" }, { email: false, sms: false }],
      ["R71 Sms Only", { sms: true }, { email: false, sms: true }],
      ["R71 Nothing", {}, { email: false, sms: false }],
      ["R71 Malformed", { marketing: "yes", sms: "true" }, { email: false, sms: false }],
    ] as const;
    const ids = cases.map(() => uuidv7());
    for (const [k, [name, consent]] of cases.entries())
      await db.withContext("munim_core", own("customers.customer.upsert.v1"), (c) =>
        c.query(`INSERT INTO core.customer (tenant_id, id, name, consent, is_guest, origin) VALUES ($1, $2, $3, $4, true, '{}')`, [t.tenant, ids[k], name, JSON.stringify(consent)]));
    const views = async () => {
      const list = CustomerListResponse.parse(await (await get("owner", `/v1/customers?q=${encodeURIComponent("R71")}`)).json()).customers;
      return ids.map((id) => list.find((c) => c.customer_id === id)?.consent);
    };
    expect(await views()).toEqual(cases.map(([, , flags]) => flags));
    // Staff withdraw email: that explicit flag wins over the customer's {marketing: true}.
    expect((await post("owner", "/v1/customers:upsert", "customers.customer.upsert.v1",
      { customer_id: ids[0], name: "R71 Granted", phone: null, email: null, withdraw_consent: ["email"] })).status).toBe(200);
    expect((await views())[0]).toEqual({ email: false, sms: false });
    // The one-record read (GET /v1/customers/{id}) agrees.
    const record = await get("owner", `/v1/customers/${ids[0]}`);
    expect([record.status, (await record.json()).consent]).toEqual([200, { email: false, sms: false }]);
  });

  it("R1-m3: staff cannot change a signed-in customer's name or phone; what staff cannot see (the full phone, the email) is kept", async () => {
    const signedIn = uuidv7();
    await db.withContext("munim_core", own("customers.customer.upsert.v1"), (c) =>
      c.query(`INSERT INTO core.customer (tenant_id, id, name, phone, email, idp_sub, is_guest, origin) VALUES ($1, $2, 'Signed In', '+919811112222', 'si@example.test', $3, false, '{}')`,
        [t.tenant, signedIn, `cust-${uuidv7()}`]));
    const up = (who: "owner" | "staff", id: string, o: Record<string, unknown>) => post(who, "/v1/customers:upsert", "customers.customer.upsert.v1",
      { customer_id: id, name: "Signed In", phone: null, email: null, withdraw_consent: [], ...o });
    const row = (id: string) => one(`SELECT name, phone, email FROM core.customer WHERE id = $1`, [id]);
    expect(await err(await up("staff", signedIn, { name: "Renamed by staff" }))).toEqual({ status: 403, code: "forbidden", reason: "authority_denied" });
    expect(await err(await up("staff", signedIn, { phone: "+919800000000" }))).toEqual({ status: 403, code: "forbidden", reason: "authority_denied" });
    // No phone and no email (staff see neither in full) with a consent withdrawal: accepted, contacts untouched.
    expect((await up("staff", signedIn, { withdraw_consent: ["sms"] })).status).toBe(200);
    expect(await row(signedIn)).toEqual({ name: "Signed In", phone: "+919811112222", email: "si@example.test" });
    // A merchant-entered (no account) customer: staff may correct the name; the phone and email they cannot see are kept.
    const walkIn = uuidv7();
    expect((await post("owner", "/v1/customers:upsert", "customers.customer.upsert.v1",
      { customer_id: walkIn, name: "Walk In", phone: "+919833334444", email: "wi@example.test", withdraw_consent: [] })).status).toBe(200);
    expect((await up("staff", walkIn, { name: "Walk-in Corrected" })).status).toBe(200);
    expect(await row(walkIn)).toEqual({ name: "Walk-in Corrected", phone: "+919833334444", email: "wi@example.test" });
    // The owner (full view) may still edit the signed-in profile's contacts.
    expect((await up("owner", signedIn, { name: "Signed In", phone: "+919811112223", email: "si2@example.test" })).status).toBe(200);
    expect(await row(signedIn)).toEqual({ name: "Signed In", phone: "+919811112223", email: "si2@example.test" });
  });

  it("reservations: a booking, a refused insert-as-seated, an outlet-1 manager cannot book outlet 2; reviews are append-only per source ref", async () => {
    const o1 = t.outlets[0], o2 = t.outlets[1];
    const rid = uuidv7();
    const base = { reservation_id: rid, outlet_id: o1, customer_id: null, name: "Synthetic Party", phone: "+919800000009", party_size: 6,
      starts_at: "2026-10-18T20:00:00+05:30", duration_min: 90, table_ref: "T7", status: "booked", note: null };
    expect((await post("manager", "/v1/reservations:upsert", "customers.reservation.upsert.v1", base)).status).toBe(200);
    expect(await err(await post("manager", "/v1/reservations:upsert", "customers.reservation.upsert.v1", { ...base, reservation_id: uuidv7(), status: "seated" })))
      .toEqual({ status: 422, code: "invalid_payload", reason: null });
    expect((await post("manager", "/v1/reservations:upsert", "customers.reservation.upsert.v1", { ...base, reservation_id: uuidv7(), outlet_id: o2 })).status).toBe(403);
    expect((await post("manager", "/v1/reservations:upsert", "customers.reservation.upsert.v1", { ...base, status: "seated" })).status).toBe(200);
    expect(await err(await post("manager", "/v1/reservations:upsert", "customers.reservation.upsert.v1", { ...base, status: "booked" }))).toMatchObject({ status: 409, code: "illegal_transition" });
    const list = ReservationListResponse.parse(await (await get("manager", `/v1/reservations?outlet_id=${o1}`)).json());
    expect(list.reservations.filter((r) => r.reservation_id === rid).map((r) => r.status)).toEqual(["seated"]);

    const review = { review_id: uuidv7(), outlet_id: o1, channel_id: null, source: "manual", external_ref: `rv-${uuidv7()}`, rating: 4, body: "Synthetic: good dosa.", reviewed_at: "2026-10-09T10:00:00+05:30" };
    expect((await post("owner", "/v1/reviews:record", "customers.review.record.v1", review)).status).toBe(200);
    expect(await err(await post("owner", "/v1/reviews:record", "customers.review.record.v1", { ...review, review_id: uuidv7() }))).toEqual({ status: 409, code: "conflict", reason: null });
    expect(await err(await post("staff", "/v1/reviews:record", "customers.review.record.v1", { ...review, review_id: uuidv7(), external_ref: "x1" }))).toMatchObject({ status: 403 });
    expect(await count(`SELECT count(*) n FROM core.review WHERE source = 'manual' AND external_ref = $1`, [review.external_ref])).toBe(1);
    const reviews = ReviewListResponse.parse(await (await get("manager", `/v1/reviews?outlet_id=${o1}`)).json());
    expect(reviews.reviews.filter((r) => r.review_id === review.review_id).map((r) => [r.rating, r.source])).toEqual([[4, "manual"]]);
  });

  it("bulk orders: an enquiry, a quote; a confirmed insert is refused; a staff member is refused", async () => {
    const id = uuidv7();
    const b = { bulk_order_id: id, outlet_id: t.outlets[0], customer_id: null, contact_name: "Synthetic Office", contact_phone: null, deliver_at: "2026-10-25T12:00:00+05:30",
      headcount: 40, status: "enquiry", quote_minor: null, advance_minor: null, currency: null, order_id: null, note: null };
    expect((await post("manager", "/v1/bulk-orders:upsert", "customers.bulk_order.upsert.v1", b)).status).toBe(200);
    expect((await post("manager", "/v1/bulk-orders:upsert", "customers.bulk_order.upsert.v1", { ...b, status: "quoted", quote_minor: 1800000, advance_minor: 300000, currency: t.currency })).status).toBe(200);
    expect(await err(await post("manager", "/v1/bulk-orders:upsert", "customers.bulk_order.upsert.v1", { ...b, bulk_order_id: uuidv7(), status: "confirmed", quote_minor: 1, advance_minor: 0, currency: t.currency })))
      .toEqual({ status: 422, code: "invalid_payload", reason: null });
    expect((await post("staff", "/v1/bulk-orders:upsert", "customers.bulk_order.upsert.v1", { ...b, bulk_order_id: uuidv7() })).status).toBe(403);
    expect(await one(`SELECT status, quote_minor::int q FROM core.bulk_order WHERE id = $1`, [id])).toEqual({ status: "quoted", q: 1800000 });
    const list = BulkOrderListResponse.parse(await (await get("manager", `/v1/bulk-orders?outlet_id=${t.outlets[0]}`)).json());
    expect(list.bulk_orders.filter((x) => x.bulk_order_id === id).map((x) => [x.status, x.quote_minor, x.headcount])).toEqual([["quoted", 1800000, 40]]);
  });

  it("coupon use history lists a customer's uses (row fields)", async () => {
    const cust = await customer("Synthetic Couponer");
    const o = await order(cust, 30000);
    const coupon = uuidv7();
    await db.withContext("munim_core", own("catalogue.coupon.set.v1"), (c) =>
      c.query(`INSERT INTO core.coupon (tenant_id, id, code, kind, value_minor, currency, valid_from) VALUES ($1, $2, 'WELCOME50', 'amount', 5000, $3, '2026-01-01')`, [t.tenant, coupon, t.currency]));
    await db.withContext("munim_core", own("orders.place.v1"), (c) =>
      c.query(`INSERT INTO core.coupon_use (tenant_id, id, coupon_id, order_id, customer_id, discount_minor, currency, applied_by) VALUES ($1, $2, $3, $4, $5, 5000, $6, $7)`,
        [t.tenant, uuidv7(), coupon, o, cust, t.currency, t.owner]));
    const r = await get("owner", `/v1/customers/${cust}/coupon-uses`);
    expect(r.status).toBe(200);
    expect(CouponUseListResponse.parse(await r.json()).coupon_uses.map((u) => [u.coupon_id, u.order_id, u.discount_minor, u.currency])).toEqual([[coupon, o, 5000, t.currency]]);
    expect((await get("owner", `/v1/customers/${uuidv7()}/coupon-uses`)).status).toBe(404);
  });
});

describe("loyalty policy per tenant (W2-R4: core.business_policy, not constants)", () => {
  it("a new policy version (earn 1 point per 500, a point worth 20) doubles the earn and the redemption value; an older order date keeps the old rates", async () => {
    const x = await customer("Synthetic Policy Regular");
    expect((await adjust("owner", x, 100)).status).toBe(200);
    // Before: the world's policy (defaults 1000 / 10): 32,000 net → 32 points; 40 points redeem for 400.
    const before = await order(x, 32000);
    expect((await advance(before, "completed", (c) => loyaltyEarnFor(c, before)))?.points).toBe(32);
    const r0Order = await order(x, 32000);
    const r0 = await db.withContext("munim_core", own("orders.place.v1"), (c) => loyaltyRedeem(c, r0Order, 40));
    expect(r0.value_minor).toBe(400);
    // A refusal paired with the accept: a policy row is a book row — staff cannot set one (tenancy.policy.set.v1 is owner).
    const policy = (ctx: AppContext) => db.withContext("munim_core", ctx, (c) =>
      c.query(`INSERT INTO core.business_policy (tenant_id, id, valid_from, loyalty_earn_per_minor, loyalty_point_value_minor) VALUES ($1, $2, '2026-10-05', 500, 20)`,
        [t.tenant, uuidv7()]));
    await expect(policy({ tenant_id: t.tenant, outlet_ids: [t.outlets[0]], role: "staff", member_id: t.staff, command_type: "tenancy.policy.set.v1" })).rejects.toMatchObject({ code: "MB001" });
    await policy(own("tenancy.policy.set.v1"));
    // After (orders dated today, 2026-10-05 ≤ today): 32,000 / 500 = 64 points; 40 points × 20 = 800.
    const after = await order(x, 32000);
    expect((await advance(after, "completed", (c) => loyaltyEarnFor(c, after)))?.points).toBe(64);
    const r1Order = await order(x, 32000);
    const r1 = await db.withContext("munim_core", own("orders.place.v1"), (c) => loyaltyRedeem(c, r1Order, 40));
    expect(r1.value_minor).toBe(800);
  });
});
