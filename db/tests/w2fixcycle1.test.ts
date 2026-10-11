// Gates for 0016 (W2 adversarial review, fix cycle 1, migrator row m-4; docs/plan/W2-FIX-LIST.md). Each refusal is
// paired with its accepted case. Expected values are typed by hand. Synthetic data only.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MIGRATIONS_DIR, migrate } from "../migrate.ts";
import { seedPacks } from "../seeds/packs.ts";
import { attachTestDb, type AppContext, type TestDb } from "../src/harness.ts";
import { openDb } from "./db.ts";
import { attempt } from "./gates.ts";
import { approveDraft, buildWorld, ownerCtx, uuidv7, type World } from "./world.ts";

let db: TestDb;
let A: World;

beforeAll(async () => {
  db = await openDb();
  A = await buildWorld(db);
});
afterAll(async () => db?.stop());

const own = (command_type: string, extra: AppContext = {}) => ownerCtx(A, { command_type, ...extra });
const rule = (posting_rule: string, source_ref: string): AppContext => ({ tenant_id: A.tenant, outlet_ids: "*", posting_rule, source_ref });
const one = async <T>(sql: string, params: unknown[] = []) => (await db.admin(sql, params)).rows[0] as T;
async function placeOrder(customer: string | null = A.customer, extra = ""): Promise<string> {
  const id = uuidv7();
  await db.withContext("munim_core", own("orders.place.v1"), (c) =>
    c.query(`INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, kind, subtotal_minor, total_minor, currency, pricing_snapshot, customer_id${extra ? ", guest_access_hash" : ""})
             VALUES ($1, $2, $3, $4, 'takeaway', 20000, 20000, 'INR', '{}', $5${extra ? ", decode($6, 'hex')" : ""})`,
      extra ? [A.tenant, id, A.outlets[0], A.channel, customer, extra] : [A.tenant, id, A.outlets[0], A.channel, customer]));
  return id;
}
const advance = (order: string, to: string, ctx: AppContext = own("orders.order.advance.v1")) =>
  attempt(db, "munim_core", ctx, `UPDATE core."order" SET status = $3 WHERE tenant_id = $1 AND id = $2`, [A.tenant, order, to]);
async function complete(order: string) {
  for (const to of ["accepted", "preparing", "ready", "completed"]) expect(await advance(order, to)).toBeNull();
}
async function refund(order: string, amount = 500): Promise<string> {
  const id = uuidv7();
  expect(await attempt(db, "munim_core", own("orders.refund.record.v1"),
    `INSERT INTO core.refund (tenant_id, id, outlet_id, order_id, method, amount_minor, currency, reason_code, note, actor)
     VALUES ($1, $2, $3, $4, 'cash', $5, 'INR', 'late', 'synthetic', $6)`, [A.tenant, id, A.outlets[0], order, amount, A.owner])).toBeNull();
  return id;
}
const loyalty = (ctx: AppContext, e: { kind: string; points: number; order: string; reverses?: string | null; refund?: string | null }) => {
  const id = uuidv7();
  return attempt(db, "munim_core", ctx,
    `INSERT INTO core.loyalty_entry (tenant_id, id, customer_id, seq, kind, points, balance_after, order_id, reverses_id, refund_id)
     VALUES ($1, $2, $3, 0, $4, $5, 0, $6, $7, $8)`, [A.tenant, id, A.customer, e.kind, e.points, e.order, e.reverses ?? null, e.refund ?? null])
    .then((err) => ({ id, err }));
};

describe("R3-M1 — order_event.seq (per order, assigned by the database)", () => {
  const event = (order: string, seq: number | null = 99) =>
    attempt(db, "munim_core", own("orders.order.advance.v1"),
      `INSERT INTO core.order_event (tenant_id, id, outlet_id, order_id, kind, to_status, actor, seq) VALUES ($1, gen_random_uuid(), $2, $3, 'status', 'accepted', '{"kind": "member"}', $4)`,
      [A.tenant, A.outlets[0], order, seq]);
  const seqs = async (order: string) =>
    (await db.admin(`SELECT seq::int FROM core.order_event WHERE tenant_id = $1 AND order_id = $2 ORDER BY seq`, [A.tenant, order])).rows.map((r) => r.seq);

  test("supplied seq 99 / NULL are overwritten: the world's order goes 1 → 2 → 3; a new order starts at 1", async () => {
    expect(await event(A.orders[0], 99)).toBeNull();
    expect(await event(A.orders[0], null)).toBeNull();
    const fresh = await placeOrder();
    expect(await event(fresh, 7)).toBeNull();
    const a = await seqs(A.orders[0]);
    const b = await seqs(fresh);
    console.log(`R3-M1 seq: world order ${JSON.stringify(a)}, new order ${JSON.stringify(b)}`);
    expect(a).toEqual([1, 2, 3]);
    expect(b).toEqual([1]);
  });

  test("20 concurrent writers on one order → seq 1..20, no gap, no duplicate", async () => {
    const order = await placeOrder();
    const results = await Promise.all(Array.from({ length: 20 }, () => event(order)));
    expect(results.filter((r) => r !== null)).toEqual([]);
    expect(await seqs(order)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  test("seq cannot be rewritten (no UPDATE grant → 42501); a duplicate (order, seq) is refused by the unique index (23505)", async () => {
    const upd = await attempt(db, "munim_core", own("orders.order.advance.v1"), `UPDATE core.order_event SET seq = 5 WHERE tenant_id = $1`, [A.tenant]);
    expect(upd?.code).toBe("42501");
    const x = await db.clone();
    try {
      await x.admin("ALTER TABLE core.order_event DISABLE TRIGGER order_event_seq");
      const dup = await attempt(x, "munim_core", own("orders.order.advance.v1"),
        `INSERT INTO core.order_event (tenant_id, id, outlet_id, order_id, kind, to_status, actor, seq) VALUES ($1, gen_random_uuid(), $2, $3, 'status', 'accepted', '{}', 1)`,
        [A.tenant, A.outlets[1], A.orders[1]]);
      expect(dup?.code).toBe("23505");
    } finally {
      await x.stop();
    }
  });
});

describe("R1-m5 — customers.loyalty_reverse: cancel path by order, refund path by refund, once per refund", () => {
  let done = ""; // completed, refunded twice, with an earn and a redeem
  let earn = "";
  let redeem = "";
  let r1 = "";
  let r2 = "";
  let open = ""; // placed (not completed), refunded
  let rOpen = "";

  beforeAll(async () => {
    done = await placeOrder();
    const red = await loyalty(own("orders.place.v1"), { kind: "redeem", points: -10, order: done });
    expect(red.err).toBeNull();
    redeem = red.id;
    await complete(done);
    const e = await loyalty(rule("customers.loyalty_earn", `core.order:${done}`), { kind: "earn", points: 20, order: done });
    expect(e.err).toBeNull();
    earn = e.id;
    r1 = await refund(done);
    r2 = await refund(done);
    open = await placeOrder();
    rOpen = await refund(open);
  });

  test("refund of a completed order, citing that refund → accepted; a refund of an order not completed → MB001 (source state)", async () => {
    const refused = await loyalty(rule("customers.loyalty_reverse", `core.refund:${rOpen}`), { kind: "reverse", points: -5, order: open, reverses: earn, refund: rOpen });
    const ok = await loyalty(rule("customers.loyalty_reverse", `core.refund:${r1}`), { kind: "reverse", points: -10, order: done, reverses: earn, refund: r1 });
    console.log(`R1-m5 refund path: open order → ${refused.err?.code}; completed → ${ok.err ? ok.err.code : "accepted"}`);
    expect(refused.err?.code).toBe("MB001");
    expect(ok.err).toBeNull();
    const row = await one<{ o: { kind: string; source_ref: string }; refund_id: string }>(`SELECT origin o, refund_id FROM core.loyalty_entry WHERE id = $1`, [ok.id]);
    expect([row.o.kind, row.o.source_ref, row.refund_id]).toEqual(["derivation", `core.refund:${r1}`, r1]);
  });

  test("once per refund: a second entry citing the same refund → 23505; the other refund reverses the redeem → accepted", async () => {
    const again = await loyalty(rule("customers.loyalty_reverse", `core.refund:${r1}`), { kind: "reverse", points: 10, order: done, reverses: redeem, refund: r1 });
    const other = await loyalty(rule("customers.loyalty_reverse", `core.refund:${r2}`), { kind: "reverse", points: 10, order: done, reverses: redeem, refund: r2 });
    console.log(`R1-m5 once per refund: same refund → ${again.err?.code}; other refund → ${other.err ? other.err.code : "accepted"}`);
    expect(again.err?.code).toBe("23505");
    expect(other.err).toBeNull();
  });

  test("binding: a refund source citing another refund, or none, → MB001; by order on a completed order → MB001; a refund_id outside the rule → MB001", async () => {
    const r3 = await refund(done);
    const other = await loyalty(rule("customers.loyalty_reverse", `core.refund:${r3}`), { kind: "reverse", points: -1, order: done, reverses: earn, refund: r2 });
    const none = await loyalty(rule("customers.loyalty_reverse", `core.refund:${r3}`), { kind: "reverse", points: -1, order: done, reverses: earn, refund: null });
    const byOrder = await loyalty(rule("customers.loyalty_reverse", `core.order:${done}`), { kind: "reverse", points: -1, order: done, reverses: earn });
    const adjust = await loyalty(own("customers.loyalty.adjust.v1"), { kind: "reverse", points: -1, order: done, reverses: earn, refund: r3 });
    console.log(`R1-m5 binding: other refund → ${other.err?.code}; no refund_id → ${none.err?.code}; by order → ${byOrder.err?.code}; own command with refund_id → ${adjust.err?.code}`);
    expect([other.err?.code, none.err?.code, byOrder.err?.code, adjust.err?.code]).toEqual(["MB001", "MB001", "MB001", "MB001"]);
  });

  test("cancel path: a cancelled order's redeem is given back by order → accepted; the same with a refund_id → MB001", async () => {
    const order = await placeOrder();
    const red = await loyalty(own("orders.place.v1"), { kind: "redeem", points: -5, order });
    expect(red.err).toBeNull();
    const rf = await refund(order);
    const early = await loyalty(rule("customers.loyalty_reverse", `core.order:${order}`), { kind: "reverse", points: 5, order, reverses: red.id });
    expect(early.err?.code).toBe("MB001"); // still placed
    expect(await advance(order, "cancelled", own("orders.void.record.v1"))).toBeNull();
    const withRefund = await loyalty(rule("customers.loyalty_reverse", `core.order:${order}`), { kind: "reverse", points: 5, order, reverses: red.id, refund: rf });
    const ok = await loyalty(rule("customers.loyalty_reverse", `core.order:${order}`), { kind: "reverse", points: 5, order, reverses: red.id });
    console.log(`R1-m5 cancel path: placed → MB001; cancelled with refund_id → ${withRefund.err?.code}; cancelled → ${ok.err ? ok.err.code : "accepted"}`);
    expect(withRefund.err?.code).toBe("MB001");
    expect(ok.err).toBeNull();
  });

  test("shape: more points than the entry, the same sign, or another order's entry → MB011", async () => {
    const order = await placeOrder();
    const red = await loyalty(own("orders.place.v1"), { kind: "redeem", points: -4, order });
    expect(red.err).toBeNull();
    expect(await advance(order, "cancelled", own("orders.void.record.v1"))).toBeNull();
    const ctx = rule("customers.loyalty_reverse", `core.order:${order}`);
    const more = await loyalty(ctx, { kind: "reverse", points: 5, order, reverses: red.id });
    const sign = await loyalty(ctx, { kind: "reverse", points: -4, order, reverses: red.id });
    const foreign = await loyalty(ctx, { kind: "reverse", points: 1, order, reverses: redeem });
    const ok = await loyalty(ctx, { kind: "reverse", points: 4, order, reverses: red.id });
    expect([more.err?.code, sign.err?.code, foreign.err?.code, ok.err]).toEqual(["MB011", "MB011", "MB011", null]);
  });
});

describe("R2-S1-4 — finance.post_loyalty_redemption", () => {
  const post = (order: string) => attempt(db, "munim_core", rule("finance.post_loyalty_redemption", `core.order:${order}`),
    `WITH je AS (INSERT INTO core.journal_entry (tenant_id, id, outlet_id, entry_date, source_type, source_id, posting_rule)
                 VALUES ($1, gen_random_uuid(), $2, '2026-10-14', 'core.order', $3, 'finance.post_loyalty_redemption') RETURNING id)
     INSERT INTO core.posting (tenant_id, id, journal_entry_id, account_id, amount_minor, currency)
     SELECT $1, gen_random_uuid(), (SELECT id FROM je), a.id, CASE a.code WHEN '4100' THEN 100 ELSE -100 END, 'INR'
       FROM core.account a WHERE a.tenant_id = $1 AND a.code IN ('4100', '1110')`, [A.tenant, A.outlets[0], order]);

  test("a completed order without a redemption → MB001; a placed one with → MB001; a completed one with → accepted (Dr 4100, Cr 1110)", async () => {
    const plain = await placeOrder();
    await complete(plain);
    const placed = await placeOrder();
    expect((await loyalty(own("orders.place.v1"), { kind: "redeem", points: -10, order: placed })).err).toBeNull();
    const paid = await placeOrder();
    expect((await loyalty(own("orders.place.v1"), { kind: "redeem", points: -10, order: paid })).err).toBeNull();
    await complete(paid);
    const noRedeem = await post(plain);
    const notDone = await post(placed);
    const ok = await post(paid);
    console.log(`R2-S1-4 redemption posting: no redeem → ${noRedeem?.code}; placed → ${notDone?.code}; completed → ${ok ? ok.code : "accepted"}`);
    expect(noRedeem?.code).toBe("MB001");
    expect(notDone?.code).toBe("MB001");
    expect(ok).toBeNull();
    expect((await post(paid))?.code).toBe("23505"); // once per (rule, source) (0008)
    const acct = await one<{ type: string; name: string }>(`SELECT type, name FROM core.account WHERE tenant_id = $1 AND code = '4100'`, [A.tenant]);
    expect(acct).toEqual({ type: "income", name: "Loyalty redemptions" });
  });
});

describe("R1-m5 — reconcile_settlement / reconcile_bank need a committed run", () => {
  test("a settlement and a bank line with no run → MB001; from the committed run → accepted", async () => {
    const run = (await one<{ id: string }>(`SELECT id FROM core.import_run WHERE tenant_id = $1 AND status = 'committed'`, [A.tenant])).id;
    const s0 = uuidv7(); const s1 = uuidv7(); const b0 = uuidv7(); const b1 = uuidv7();
    const lines = new Map([[s0, uuidv7()], [s1, uuidv7()]]);
    await approveDraft(db, A, "imports.run.commit.v1", async (q) => {
      for (const [s, r] of [[s0, null], [s1, run]] as const) {
        await q(`INSERT INTO core.settlement (tenant_id, id, channel_id, period_from, period_to, external_ref, net_minor, currency, import_run_id)
                 VALUES ($1, $2, $3, '2026-10-08', '2026-10-14', $4, 700, 'INR', $5)`, [A.tenant, s, A.channel, `P-${s}`, r]);
        // 0022: a settlement's break hangs on one of its own lines.
        await q(`INSERT INTO core.settlement_line (tenant_id, id, settlement_id, line_no, line_kind, ad_fee_minor, net_minor, currency)
                 VALUES ($1, $2, $3, 1, 'ad_fee', 700, -700, 'INR')`, [A.tenant, lines.get(s), s]);
      }
      for (const [b, r] of [[b0, null], [b1, run]] as const)
        await q(`INSERT INTO core.bank_line (tenant_id, id, outlet_id, account_ref, value_date, amount_minor, currency, method, external_ref, import_run_id)
                 VALUES ($1, $2, $3, 'BANK-1', '2026-10-09', 700, 'INR', 'neft', $4, $5)`, [A.tenant, b, A.outlets[0], `UTR-${b}`, r]);
    });
    const brk = (rl: string, src: string, col: string, id: string) => attempt(db, "munim_core", rule(rl, src),
      `INSERT INTO core.reconciliation_break (tenant_id, id, kind, channel_id, ${col}, amount_minor, currency) VALUES ($1, gen_random_uuid(), 'other', $2, $3, 1, 'INR')`,
      [A.tenant, A.channel, id]);
    const sNo = await brk("finance.reconcile_settlement", `core.settlement:${s0}`, "settlement_line_id", lines.get(s0)!);
    const sOk = await brk("finance.reconcile_settlement", `core.settlement:${s1}`, "settlement_line_id", lines.get(s1)!);
    const bNo = await brk("finance.reconcile_bank", `core.bank_line:${b0}`, "bank_line_id", b0);
    const bOk = await brk("finance.reconcile_bank", `core.bank_line:${b1}`, "bank_line_id", b1);
    console.log(`R1-m5 reconcile: settlement no run → ${sNo?.code}, run → ${sOk ? sOk.code : "accepted"}; bank no run → ${bNo?.code}, run → ${bOk ? bOk.code : "accepted"}`);
    expect([sNo?.code, sOk, bNo?.code, bOk]).toEqual(["MB001", null, "MB001", null]);
  });
});

describe("R1-m5 — the pricing freezes check orders.reprice's source state", () => {
  const lineSql = `UPDATE core.order_line SET unit_price_minor = unit_price_minor + 100 WHERE tenant_id = $1 AND order_id = $2`;
  const headSql = `UPDATE core."order" SET subtotal_minor = subtotal_minor + 100, total_minor = total_minor + 100 WHERE tenant_id = $1 AND id = $2`;
  // An own command that also names the pricing rule: before 0016 the text match alone let it through.
  const smuggle = (cmd: string, order: string) => own(cmd, { posting_rule: "orders.reprice", source_ref: `core.order:${order}` });

  test("completed order: line and header money under an own command naming orders.reprice → MB001; a placed order → accepted", async () => {
    const lineOrder = await placeOrder();
    await db.withContext("munim_core", own("orders.place.v1"), (c) =>
      c.query(`INSERT INTO core.order_line (tenant_id, id, outlet_id, order_id, line_no, item_id, qty_milli, unit_price_minor) VALUES ($1, gen_random_uuid(), $2, $3, 1, $4, 1000, 20000)`,
        [A.tenant, A.outlets[0], lineOrder, A.item]));
    const placedLine = await attempt(db, "munim_core", smuggle("orders.place.v1", lineOrder), lineSql, [A.tenant, lineOrder]);
    const placedHead = await attempt(db, "munim_core", smuggle("kitchen.ticket.advance.v1", lineOrder), headSql, [A.tenant, lineOrder]);
    await complete(lineOrder);
    const doneLine = await attempt(db, "munim_core", smuggle("orders.place.v1", lineOrder), lineSql, [A.tenant, lineOrder]);
    const doneHead = await attempt(db, "munim_core", smuggle("kitchen.ticket.advance.v1", lineOrder), headSql, [A.tenant, lineOrder]);
    console.log(`R1-m5 pricing: placed line → ${placedLine ? placedLine.code : "accepted"}, head → ${placedHead ? placedHead.code : "accepted"}; completed line → ${doneLine?.code}, head → ${doneHead?.code}`);
    expect([placedLine, placedHead, doneLine?.code, doneHead?.code]).toEqual([null, null, "MB001", "MB001"]);
  });
});

describe("R1-m5 — the guest token hash is cleared when the order changes customer", () => {
  test("a claim by token clears the hash (the token then sees 0 orders); a status change keeps it; munim_core cannot write it (42501)", async () => {
    const token = randomBytes(32);
    const hash = createHash("sha256").update(token).digest("hex");
    const order = await placeOrder(A.customer, hash);
    const me = uuidv7();
    await db.withContext("munim_core", own("customers.customer.upsert.v1"), (c) =>
      c.query(`INSERT INTO core.customer (tenant_id, id, name, is_guest, idp_sub) VALUES ($1, $2, 'Asha (synthetic)', false, $3)`, [A.tenant, me, `sub-${randomUUID()}`]));
    expect(await advance(order, "accepted")).toBeNull();
    const kept = await one<{ h: string | null }>(`SELECT encode(guest_access_hash, 'hex') h FROM core."order" WHERE id = $1`, [order]);
    expect(kept.h).toBe(hash);
    expect((await attempt(db, "munim_core", own("orders.order.advance.v1"), `UPDATE core."order" SET guest_access_hash = NULL WHERE tenant_id = $1 AND id = $2`, [A.tenant, order]))?.code).toBe("42501");
    const claim = await attempt(db, "munim_core",
      { tenant_id: A.tenant, outlet_ids: [], role: "customer", customer_id: me, command_type: "customers.account.link.v1", guest_access_hash: hash },
      `UPDATE core."order" SET customer_id = $2 WHERE tenant_id = $1 AND guest_access_hash = decode($3, 'hex')`, [A.tenant, me, hash]);
    expect(claim).toBeNull();
    const after = await one<{ h: string | null; c: string }>(`SELECT encode(guest_access_hash, 'hex') h, customer_id::text c FROM core."order" WHERE id = $1`, [order]);
    const seen = await db.withContext("munim_core", { tenant_id: A.tenant, outlet_ids: [], role: "guest", guest_access_hash: hash },
      async (c) => (await c.query(`SELECT count(*)::int n FROM core."order"`)).rows[0]!.n as number);
    console.log(`R1-m5 guest hash: after claim ${after.h}, owner ${after.c === me ? "me" : after.c}; the token sees ${seen} orders`);
    expect(after).toEqual({ h: null, c: me });
    expect(seen).toBe(0);
  });
});

describe("D2 — an invoice dispute may move its payable", () => {
  test("payable open → disputed: under purchasing.invoice.record.v1 → MB008; under purchasing.invoice.dispute.v1 → accepted", async () => {
    const sql = `UPDATE core.payable SET status = 'disputed' WHERE tenant_id = $1`;
    const wrong = await attempt(db, "munim_core", own("purchasing.invoice.record.v1"), sql, [A.tenant]);
    const ok = await attempt(db, "munim_core", own("purchasing.invoice.dispute.v1"), sql, [A.tenant]);
    console.log(`D2: record → ${wrong?.code}; dispute → ${ok ? ok.code : "accepted"}`);
    expect(wrong?.code).toBe("MB008");
    expect(ok).toBeNull();
    expect((await one<{ s: string }>(`SELECT status s FROM core.payable WHERE tenant_id = $1`, [A.tenant])).s).toBe("disputed");
  });
});

describe("R1-m4 / R1-M1 — merge moves coupon uses; erasure reaches merged guest profiles", () => {
  const EMAIL = "meera.synthetic@example.test";
  let me = "";
  let guest = "";
  let guestOrder = "";
  let guestCoupon = "";
  const cust = (id: string, command_type: string): AppContext => ({ tenant_id: A.tenant, outlet_ids: [], role: "customer", customer_id: id, command_type });
  const profile = async (opts: { guest: boolean; verified?: boolean }) => {
    const id = uuidv7();
    await db.withContext("munim_core", own("customers.customer.upsert.v1"), (c) =>
      c.query(`INSERT INTO core.customer (tenant_id, id, name, email, phone, is_guest, idp_sub, email_verified_at) VALUES ($1, $2, 'Meera (synthetic)', $3, '+919800000001', $4, $5, CASE WHEN $6 THEN now() END)`,
        [A.tenant, id, EMAIL, opts.guest, opts.guest ? null : `sub-${randomUUID()}`, opts.verified ?? false]));
    return id;
  };
  const eraseGuests = (ctx: AppContext, target: string, role: "munim_core" | "munim_svc" = "munim_core") =>
    db.withContext(role, ctx, async (c) => (await c.query(`SELECT entity, entity_id FROM core.customer_erase_merged_guests($1)`, [target])).rows)
      .catch((e: { code: string; message: string }) => ({ code: e.code, message: e.message }));

  beforeAll(async () => {
    guest = await profile({ guest: true });
    guestOrder = await placeOrder(guest, randomBytes(32).toString("hex"));
    const coupon = (await one<{ id: string }>(`SELECT id FROM core.coupon WHERE tenant_id = $1`, [A.tenant])).id;
    guestCoupon = uuidv7();
    await db.withContext("munim_core", own("orders.place.v1"), (c) =>
      c.query(`INSERT INTO core.coupon_use (tenant_id, id, coupon_id, order_id, customer_id, discount_minor, currency, applied_by) VALUES ($1, $2, $3, $4, $5, 0, 'INR', $6)`,
        [A.tenant, guestCoupon, coupon, guestOrder, guest, A.owner]));
    me = await profile({ guest: false, verified: true });
  });

  test("the merge returns and moves the guest's coupon use; the moved order's guest hash is cleared", async () => {
    const moved = await db.withContext("munim_core", cust(me, "customers.account.link.v1"), async (c) =>
      (await c.query(`SELECT entity, entity_id, from_customer_id FROM core.customer_claim_verified_email_guests()`)).rows);
    console.log(`R1-m4 merge: ${JSON.stringify(moved)}`);
    expect(moved).toEqual([
      { entity: "core.coupon_use", entity_id: guestCoupon, from_customer_id: guest },
      { entity: "core.customer", entity_id: guest, from_customer_id: guest },
      { entity: "core.order", entity_id: guestOrder, from_customer_id: guest },
    ]);
    const after = await one<{ cu: string; h: string | null; o: { kind: string; command_type: string } }>(`SELECT
      (SELECT customer_id::text FROM core.coupon_use WHERE id = $1) cu, (SELECT guest_access_hash::text FROM core."order" WHERE id = $2) h,
      (SELECT origin FROM core.coupon_use WHERE id = $1) o`, [guestCoupon, guestOrder]);
    // 0017 (O1): the coupon use keeps its creation origin (placement); the move is traced by its audit entry.
    expect([after.cu, after.h, after.o.kind, after.o.command_type]).toEqual([me, null, "command", "orders.place.v1"]);
  });

  test("erasing merged guests: before the profile is erased → MB001; another customer → MB001; outside the erasure command → MB001; munim_svc → 42501", async () => {
    expect(await eraseGuests(cust(me, "customers.erasure.request.v1"), me)).toMatchObject({ code: "MB001", message: expect.stringMatching(/first/) });
    expect(await eraseGuests(cust(A.customer, "customers.erasure.request.v1"), me)).toMatchObject({ code: "MB001" });
    expect(await eraseGuests(cust(me, "customers.profile.update.v1"), me)).toMatchObject({ code: "MB001" });
    expect(await eraseGuests({ tenant_id: A.tenant, outlet_ids: "*" }, me, "munim_svc")).toMatchObject({ code: "42501" });
  });

  test("after the customer's own erasure, the merged guest profile is erased too (personal columns blank) and returned", async () => {
    expect(await attempt(db, "munim_core", cust(me, "customers.erasure.request.v1"),
      `UPDATE core.customer SET erased_at = now() WHERE tenant_id = $1 AND id = $2`, [A.tenant, me])).toBeNull();
    const before = await db.withContext("munim_core", cust(me, "customers.erasure.request.v1"), async (c) =>
      (await c.query(`UPDATE core.customer SET name = NULL WHERE tenant_id = $1 AND id = $2`, [A.tenant, guest])).rowCount);
    expect(before).toBe(0); // the customer's own context cannot even see the guest profile (customer_scope)
    const erased = await eraseGuests(cust(me, "customers.erasure.request.v1"), me);
    const row = await one<{ name: string | null; email: string | null; phone: string | null; erased: boolean; merged: string; o: { kind: string } }>(
      `SELECT name, email, phone, erased_at IS NOT NULL erased, merged_into::text merged, origin o FROM core.customer WHERE id = $1`, [guest]);
    console.log(`R1-M1 erase merged guests: returned ${JSON.stringify(erased)}; guest row ${JSON.stringify(row)}`);
    expect(erased).toEqual([{ entity: "core.customer", entity_id: guest }]);
    // 0017 (O1): the guest profile keeps its creation origin through the merge and the erasure.
    expect(row).toEqual({ name: null, email: null, phone: null, erased: true, merged: me,
      o: expect.objectContaining({ kind: "command", command_type: "customers.customer.upsert.v1" }) });
    expect(await eraseGuests(cust(me, "customers.erasure.request.v1"), me)).toEqual([]); // nothing left
  });

  test("erasure of the customer's own reservation and bulk order: the '[erased]' literal and NULLs under customers.erasure.request.v1 → accepted; under profile.update → MB001", async () => {
    const who = await profile({ guest: false });
    await db.withContext("munim_core", own("customers.reservation.upsert.v1"), (c) =>
      c.query(`INSERT INTO core.reservation (tenant_id, id, outlet_id, customer_id, name, phone, party_size, starts_at, note) VALUES ($1, gen_random_uuid(), $2, $3, 'Meera', '+919800000001', 2, '2026-10-20T19:00:00Z', 'window seat')`,
        [A.tenant, A.outlets[0], who]));
    await db.withContext("munim_core", own("customers.bulk_order.upsert.v1"), (c) =>
      c.query(`INSERT INTO core.bulk_order (tenant_id, id, outlet_id, customer_id, contact_name, contact_phone, deliver_at, headcount, note) VALUES ($1, gen_random_uuid(), $2, $3, 'Meera', '+919800000001', '2026-10-25T12:00:00Z', 20, 'office lunch')`,
        [A.tenant, A.outlets[0], who]));
    const erase = (cmd: string) => db.withContext("munim_core", cust(who, cmd), async (c) => {
      await c.query(`UPDATE core.reservation SET name = '[erased]', phone = NULL, note = NULL WHERE tenant_id = $1 AND customer_id = $2`, [A.tenant, who]);
      await c.query(`UPDATE core.bulk_order SET contact_name = '[erased]', contact_phone = NULL, note = NULL WHERE tenant_id = $1 AND customer_id = $2`, [A.tenant, who]);
    }).then(() => null, (e: { code: string }) => e.code);
    const refused = await erase("customers.profile.update.v1");
    const ok = await erase("customers.erasure.request.v1");
    const rows = await one<{ r: unknown; b: unknown }>(`SELECT
      (SELECT row(name, phone, note)::text FROM core.reservation WHERE customer_id = $1) r,
      (SELECT row(contact_name, contact_phone, note)::text FROM core.bulk_order WHERE customer_id = $1) b`, [who]);
    console.log(`R1-M1 own rows: profile.update → ${refused}; erasure → ${ok ?? "accepted"}; ${JSON.stringify(rows)}`);
    expect(refused).toBe("MB001");
    expect(ok).toBeNull();
    expect(rows).toEqual({ r: "([erased],,)", b: "([erased],,)" });
  });

  test("the erase rule admits nothing outside the definer: an owner context naming it (source erased) → MB008", async () => {
    const other = uuidv7();
    await db.withContext("munim_core", own("customers.customer.upsert.v1"), (c) =>
      c.query(`INSERT INTO core.customer (tenant_id, id, name, is_guest) VALUES ($1, $2, 'Walk-in (synthetic)', true)`, [A.tenant, other]));
    const e = await attempt(db, "munim_core", own("kitchen.ticket.advance.v1", { posting_rule: "customers.erase_merged_guests", source_ref: `core.customer:${me}` }),
      `UPDATE core.customer SET name = 'Changed' WHERE tenant_id = $1 AND id = $2`, [A.tenant, other]);
    console.log(`R1-M1 erase rule outside the definer → ${e?.code}`);
    expect(e?.code).toBe("MB008"); // the derivation fails (not munim_crosstenant); kitchen.ticket.advance.v1 does not list core.customer
  });
});

describe("R2-S2-8 — unit cost per 1000 base units", () => {
  const move = (per1000: number | null, minor: number | null) => attempt(db, "munim_core", own("inventory.stock.receive.v1"),
    `INSERT INTO core.stock_movement (tenant_id, id, outlet_id, ingredient_id, qty_milli, unit, kind, unit_cost_per_1000_minor, unit_cost_minor, currency)
     VALUES ($1, $2, $3, $4, 2500000, 'g', 'receipt', $5, $6, 'INR')`, [A.tenant, randomUUID(), A.outlets[0], A.ingredient, per1000, minor]);
  test("per-1000 only → unit_cost_minor filled (41001 → 41); minor only → per-1000 = ×1000; both equal → accepted; both unequal → 23514", async () => {
    expect(await move(41001, null)).toBeNull();
    expect(await move(null, 9)).toBeNull();
    expect(await move(41001, 41)).toBeNull();
    expect((await move(41001, 40))?.code).toBe("23514");
    const rows = (await db.admin(`SELECT unit_cost_per_1000_minor::int p, unit_cost_minor::int m FROM core.stock_movement WHERE tenant_id = $1 AND qty_milli = 2500000 ORDER BY created_at, id`, [A.tenant])).rows;
    expect(rows).toEqual([{ p: 41001, m: 41 }, { p: 9000, m: 9 }, { p: 41001, m: 41 }]);
    // Valued exactly: 2.5 kg at ₹410.01/kg = 102502.5 paise → 102503 (half up); the old per-gram column says 102500.
    const v = await one<{ exact: string; old: string }>(`SELECT round(2500000::numeric * 41001 / 1000000)::text exact, (2500000::bigint * 41 / 1000)::text old`);
    expect(v).toEqual({ exact: "102503", old: "102500" });
  });
});

describe("Backfills on existing tenants (fresh database: 0001–0015, a world, then 0016)", () => {
  test("order_event.seq by (at, id); D1 default policy for the tenant without one; account 4100; unit cost per 1000; guards back on", async () => {
    const name = `munim_bf_${randomBytes(5).toString("hex")}`;
    await db.admin(`CREATE DATABASE ${name}`);
    const dir = mkdtempSync(join(tmpdir(), "munim-bf-"));
    let x: TestDb | undefined;
    try {
      cpSync(MIGRATIONS_DIR, dir, { recursive: true });
      for (const f of readdirSync(dir)) if (/^\d{4}_/.test(f) && Number(f.slice(0, 4)) >= 16) rmSync(join(dir, f));
      const c0 = new pg.Client({ host: "127.0.0.1", port: db.port, user: "postgres", password: db.password, database: name });
      await c0.connect();
      const migration = await migrate(c0, { dir, log: () => {} });
      const packs = await seedPacks(c0, { log: () => {} });
      await c0.end();
      expect(migration.applied.at(-1)).toBe("0015_w2_fix");
      x = await attachTestDb({ port: db.port, password: db.password, database: name }, { migration, packs });
      const T = await buildWorld(x);
      const U = await buildWorld(x, { country: "AU" });
      // T: no policy, no account 4100 (as on the hosted DB); an event dated before the world's on its first order.
      await x.admin(`DELETE FROM core.business_policy WHERE tenant_id = $1`, [T.tenant]);
      await x.admin(`DELETE FROM core.account WHERE tenant_id = $1 AND code = '4100'`, [T.tenant]);
      const early = uuidv7();
      await x.withContext("munim_core", ownerCtx(T, { command_type: "orders.order.advance.v1" }), (c) =>
        c.query(`INSERT INTO core.order_event (tenant_id, id, outlet_id, order_id, kind, to_status, actor, at) VALUES ($1, $2, $3, $4, 'status', 'placed', '{}', '2026-01-01T00:00:00Z')`,
          [T.tenant, early, T.outlets[0], T.orders[0]]));
      const policiesU = (await x.admin(`SELECT count(*)::int n FROM core.business_policy WHERE tenant_id = $1`, [U.tenant])).rows[0]!.n;

      const c1 = new pg.Client({ host: "127.0.0.1", port: db.port, user: "postgres", password: db.password, database: x.database });
      await c1.connect();
      try {
        const r = await migrate(c1, { log: () => {} });
        expect(r.applied[0]).toBe("0016_w2_fix_cycle_1");
      } finally {
        await c1.end();
      }

      const seq = (await x.admin(`SELECT id, seq::int FROM core.order_event WHERE tenant_id = $1 AND order_id = $2 ORDER BY seq`, [T.tenant, T.orders[0]])).rows;
      expect(seq.map((s) => s.seq)).toEqual([1, 2]);
      expect(seq[0]!.id).toBe(early);
      const pol = (await x.admin(`SELECT id, outlet_id, valid_from::text vf, loyalty_earn_per_minor::int e, loyalty_point_value_minor::int v, origin, created_by
                                    FROM core.business_policy WHERE tenant_id = $1`, [T.tenant])).rows;
      // Hand rule: the tenant was created today (Asia/Kolkata, its first outlet's zone); its orders' business date is
      // today, or yesterday before the 04:00 cutoff → valid from the earlier of the two.
      const created = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
      const firstOrder = (await x.admin(`SELECT min(business_date)::text d FROM core."order" WHERE tenant_id = $1`, [T.tenant])).rows[0]!.d as string;
      const today = firstOrder < created ? firstOrder : created;
      console.log(`backfill: T policies ${JSON.stringify(pol)}; U policies ${policiesU} before`);
      expect(pol).toHaveLength(1);
      expect(pol[0]).toMatchObject({ outlet_id: null, vf: today, e: 1000, v: 10, created_by: null, origin: { kind: "migration", migration: "0016_w2_fix_cycle_1" } });
      const audit = (await x.admin(`SELECT actor, action, entity FROM core.audit_log WHERE tenant_id = $1 AND entity_id IN ($2, (SELECT id::text FROM core.account WHERE tenant_id = $1 AND code = '4100'))
                                     ORDER BY entity`, [T.tenant, pol[0]!.id])).rows;
      expect(audit).toEqual([
        { actor: { kind: "migration", id: "0016_w2_fix_cycle_1" }, action: "db.migration.backfill", entity: "core.account" },
        { actor: { kind: "migration", id: "0016_w2_fix_cycle_1" }, action: "db.migration.backfill", entity: "core.business_policy" },
      ]);
      expect((await x.admin(`SELECT type, origin->>'kind' k FROM core.account WHERE tenant_id = $1 AND code = '4100'`, [T.tenant])).rows).toEqual([{ type: "income", k: "migration" }]);
      // U had its policy and its 4100 (world): untouched.
      expect((await x.admin(`SELECT count(*)::int n, count(*) FILTER (WHERE origin->>'kind' = 'migration')::int m FROM core.business_policy WHERE tenant_id = $1`, [U.tenant])).rows[0]!).toEqual({ n: policiesU, m: 0 });
      expect((await x.admin(`SELECT count(*)::int n FROM core.account WHERE tenant_id = $1 AND code = '4100' AND origin->>'kind' = 'migration'`, [U.tenant])).rows[0]!.n).toBe(0);
      const cost = (await x.admin(`SELECT unit_cost_minor::int m, unit_cost_per_1000_minor::int p FROM core.stock_movement WHERE tenant_id = $1 AND unit_cost_minor IS NOT NULL ORDER BY id LIMIT 1`, [T.tenant])).rows[0]!;
      expect(cost.p).toBe(cost.m * 1000);
      const unnumbered = (await x.admin(`SELECT count(*)::int n FROM core.order_event WHERE seq IS NULL`)).rows[0]!.n;
      expect(unnumbered).toBe(0);
      const guards = (await x.admin(`SELECT count(*)::int n FROM pg_trigger WHERE tgname = 'book_guard' AND tgenabled <> 'O'`)).rows[0]!.n;
      expect(guards).toBe(0);
      // The guard is really back: a context-free policy insert is refused.
      const e = await attempt(x, "munim_core", { tenant_id: T.tenant, outlet_ids: "*" },
        `INSERT INTO core.business_policy (tenant_id, id, valid_from, origin) VALUES ($1, gen_random_uuid(), '2026-10-10', '{}')`, [T.tenant]);
      expect(e?.code).toBe("MB001");
    } finally {
      await x?.stop();
      await db.admin(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
