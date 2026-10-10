// Gates for 0017 (W2 fix cycle 2, migrator row m-5). Each refusal is paired with its accepted case; expected values
// are typed by hand. Red-proofs: db/tests/redproof-0017.sh plants a 0019 per item (0018 is applied since h-1) and requires this file to exit
// non-zero naming the item's tests. Synthetic data only.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { AppContext, TestDb } from "../src/harness.ts";
import { openDb } from "./db.ts";
import { attempt } from "./gates.ts";
import { buildWorld, ownerCtx, uuidv7, type World } from "./world.ts";

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
const origin = async (table: string, id: string) =>
  (await one<{ o: Record<string, string> }>(`SELECT origin o FROM ${table} WHERE tenant_id = $1 AND id = $2`, [A.tenant, id])).o;

/** An order placed under orders.place.v1 with one line and (optionally) a coupon use; the guest hash when given. */
async function placeOrder(customer: string | null, opts: { hash?: string; coupon?: boolean } = {}) {
  const id = uuidv7();
  const line = uuidv7();
  const cu = uuidv7();
  const coupon = (await one<{ id: string }>(`SELECT id FROM core.coupon WHERE tenant_id = $1 ORDER BY id LIMIT 1`, [A.tenant])).id;
  await db.withContext("munim_core", own("orders.place.v1"), async (c) => {
    await c.query(`INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, kind, subtotal_minor, discount_minor, total_minor, currency, pricing_snapshot, customer_id, guest_access_hash)
                   VALUES ($1, $2, $3, $4, 'takeaway', 20000, 1000, 19000, 'INR', '{}', $5, decode($6, 'hex'))`,
      [A.tenant, id, A.outlets[0], A.channel, customer, opts.hash ?? null]);
    await c.query(`INSERT INTO core.order_line (tenant_id, id, outlet_id, order_id, line_no, item_id, qty_milli, unit_price_minor) VALUES ($1, $2, $3, $4, 1, $5, 1000, 20000)`,
      [A.tenant, line, A.outlets[0], id, A.item]);
    if (opts.coupon) {
      await c.query(`INSERT INTO core.coupon_use (tenant_id, id, coupon_id, order_id, customer_id, discount_minor, currency, applied_by) VALUES ($1, $2, $3, $4, $5, 1000, 'INR', $6)`,
        [A.tenant, cu, coupon, id, customer, A.owner]);
    }
  });
  return { id, line, cu };
}
const advance = (order: string, to: string) =>
  attempt(db, "munim_core", own("orders.order.advance.v1"), `UPDATE core."order" SET status = $3 WHERE tenant_id = $1 AND id = $2`, [A.tenant, order, to]);
const reprice = (order: string, sql: string, params: unknown[]) => attempt(db, "munim_core", rule("orders.reprice", `core.order:${order}`), sql, params);

async function profile(opts: { guest: boolean; verified?: boolean; email?: string }) {
  const id = uuidv7();
  await db.withContext("munim_core", own("customers.customer.upsert.v1"), (c) =>
    c.query(`INSERT INTO core.customer (tenant_id, id, name, email, phone, is_guest, idp_sub, email_verified_at) VALUES ($1, $2, 'Asha (synthetic)', $3, '+919800000002', $4, $5, CASE WHEN $6 THEN now() END)`,
      [A.tenant, id, opts.email ?? `asha.${randomUUID()}@example.test`, opts.guest, opts.guest ? null : `sub-${randomUUID()}`, opts.verified ?? false]));
  return id;
}
const cust = (id: string, command_type: string, extra: AppContext = {}): AppContext =>
  ({ tenant_id: A.tenant, outlet_ids: [], role: "customer", customer_id: id, command_type, ...extra });
type Row = { entity: string; entity_id: string; from_customer_id: string | null };
const claimToken = (ctx: AppContext, role: "munim_core" | "munim_svc" = "munim_core") =>
  db.withContext(role, ctx, async (c) => (await c.query<Row>(`SELECT entity, entity_id, from_customer_id FROM core.customer_claim_guest_token()`)).rows)
    .catch((e: { code: string; message: string }) => ({ code: e.code, message: e.message }));
const token = () => randomBytes(32).toString("hex");

describe("O1 — origin is creation provenance: never re-stamped by an UPDATE (any branch)", () => {
  test("O1 reprice: orders.reprice re-prices the order and its line → accepted; both keep the placement origin", async () => {
    const o = await placeOrder(A.customer);
    const before = [await origin("core.\"order\"", o.id), await origin("core.order_line", o.line)];
    expect(before.map((b) => [b.kind, b.command_type])).toEqual([["command", "orders.place.v1"], ["command", "orders.place.v1"]]);
    expect(await reprice(o.id, `UPDATE core."order" SET discount_minor = 2000, total_minor = 18000 WHERE tenant_id = $1 AND id = $2`, [A.tenant, o.id])).toBeNull();
    expect(await reprice(o.id, `UPDATE core.order_line SET line_discount_minor = 1000 WHERE tenant_id = $1 AND id = $2`, [A.tenant, o.line])).toBeNull();
    const after = [await origin("core.\"order\"", o.id), await origin("core.order_line", o.line)];
    const money = await one<{ t: string; d: string }>(`SELECT o.total_minor::text t, l.line_discount_minor::text d FROM core."order" o JOIN core.order_line l ON l.tenant_id = o.tenant_id AND l.order_id = o.id WHERE o.id = $1`, [o.id]);
    console.log(`O1 reprice: total ${money.t}, line discount ${money.d}; origins ${JSON.stringify(after)}`);
    expect(money).toEqual({ t: "18000", d: "1000" });
    expect(after).toEqual(before);
  });

  test("O1 insert: an INSERT under a derivation still stamps {kind: derivation, rule_id, source_ref}", async () => {
    const o = await placeOrder(A.customer);
    const r = await db.withContext("munim_core", rule("inventory.consume_order", `core.order:${o.id}`), (c) =>
      c.query(`INSERT INTO core.stock_movement (tenant_id, id, outlet_id, ingredient_id, qty_milli, unit, kind, ref_type, ref_id)
               VALUES ($1, gen_random_uuid(), $2, $3, -150000, 'g', 'sale_consumption', 'core.order', $4) RETURNING origin`, [A.tenant, A.outlets[0], A.ingredient, o.id]));
    expect(r.rows[0].origin).toEqual({ kind: "derivation", rule_id: "inventory.consume_order", source_ref: `core.order:${o.id}` });
  });

  test("O1 merge+erase: the verified-email merge and the merged-guest erasure keep the order's, coupon use's and guest profile's origins", async () => {
    const email = `ravi.${randomUUID()}@example.test`;
    const guest = await profile({ guest: true, email });
    const o = await placeOrder(guest, { coupon: true });
    const me = await profile({ guest: false, verified: true, email });
    const before = [await origin("core.\"order\"", o.id), await origin("core.coupon_use", o.cu), await origin("core.customer", guest)];
    const moved = await db.withContext("munim_core", cust(me, "customers.account.link.v1"), async (c) =>
      (await c.query(`SELECT entity, entity_id FROM core.customer_claim_verified_email_guests()`)).rows);
    expect(moved.map((m) => m.entity)).toEqual(["core.coupon_use", "core.customer", "core.order"]);
    expect([await origin("core.\"order\"", o.id), await origin("core.coupon_use", o.cu), await origin("core.customer", guest)]).toEqual(before);
    expect(await attempt(db, "munim_core", cust(me, "customers.erasure.request.v1"), `UPDATE core.customer SET erased_at = now() WHERE tenant_id = $1 AND id = $2`, [A.tenant, me])).toBeNull();
    const erased = await db.withContext("munim_core", cust(me, "customers.erasure.request.v1"), async (c) =>
      (await c.query(`SELECT entity_id FROM core.customer_erase_merged_guests($1)`, [me])).rows);
    expect(erased).toEqual([{ entity_id: guest }]);
    const g = await origin("core.customer", guest);
    console.log(`O1 merge+erase: guest origin ${JSON.stringify(g)}`);
    expect(g).toEqual(before[2]);
    expect(g).toMatchObject({ kind: "command", command_type: "customers.customer.upsert.v1" });
  });
});

describe("P1 — re-approving a disputed invoice re-opens its payable (and nothing else under approve)", () => {
  const invoice = uuidv7();
  const payable = uuidv7();
  const inv = (status: string, cmd: string) =>
    attempt(db, "munim_core", own(cmd), `UPDATE core.supplier_invoice SET status = $3 WHERE tenant_id = $1 AND id = $2`, [A.tenant, invoice, status]);
  const pay = (set: string, cmd = "purchasing.invoice.approve.v1") =>
    attempt(db, "munim_core", own(cmd), `UPDATE core.payable SET ${set} WHERE tenant_id = $1 AND id = $2`, [A.tenant, payable]);
  const status = async () => (await one<{ s: string }>(`SELECT status s FROM core.payable WHERE id = $1`, [payable])).s;

  beforeAll(async () => {
    await db.withContext("munim_core", own("purchasing.invoice.record.v1"), (c) =>
      c.query(`INSERT INTO core.supplier_invoice (tenant_id, id, supplier_id, invoice_no, invoice_date, subtotal_minor, total_minor, currency)
               VALUES ($1, $2, $3, $4, '2026-10-06', 250000, 250000, 'INR')`, [A.tenant, invoice, A.supplier, `INV-P1-${randomUUID().slice(0, 8)}`]));
    expect(await inv("approved", "purchasing.invoice.approve.v1")).toBeNull();
    // As the approve handler does: the payable is derived inside the approve command (purchasing.payable_from_invoice).
    expect(await attempt(db, "munim_core", own("purchasing.invoice.approve.v1", { posting_rule: "purchasing.payable_from_invoice", source_ref: `core.supplier_invoice:${invoice}` }),
      `INSERT INTO core.payable (tenant_id, id, supplier_id, source_type, source_id, due_on, amount_minor, currency) VALUES ($1, $2, $3, 'core.supplier_invoice', $4, '2026-10-21', 250000, 'INR')`,
      [A.tenant, payable, A.supplier, invoice])).toBeNull();
    expect(await inv("disputed", "purchasing.invoice.dispute.v1")).toBeNull();
    expect(await pay("status = 'disputed'", "purchasing.invoice.dispute.v1")).toBeNull();
  });

  test("P1 refusals: under approve, disputed → open while the invoice is still disputed → MB001; an own-command payable insert → MB001", async () => {
    const early = await pay("status = 'open'");
    const insert = await attempt(db, "munim_core", own("purchasing.invoice.approve.v1"),
      `INSERT INTO core.payable (tenant_id, id, supplier_id, source_type, source_id, due_on, amount_minor, currency) VALUES ($1, gen_random_uuid(), $2, 'core.supplier_invoice', $3, '2026-10-21', 1000, 'INR')`,
      [A.tenant, A.supplier, invoice]);
    console.log(`P1: re-open before the invoice is approved → ${early?.code}; approve inserting a payable itself → ${insert?.code}`);
    expect(early?.code).toBe("MB001");
    expect(insert?.code).toBe("MB001");
    expect(await status()).toBe("disputed");
  });

  test("P1 accepted: invoice disputed → approved, then its payable disputed → open under approve; disputed → paid and a paid_on change alongside → MB001", async () => {
    const before = await origin("core.payable", payable);
    expect(await inv("approved", "purchasing.invoice.approve.v1")).toBeNull();
    const paid = await pay("status = 'paid', paid_on = '2026-10-10'");
    const extra = await pay("status = 'open', paid_on = '2026-10-10'");
    const ok = await pay("status = 'open'");
    console.log(`P1: disputed → paid → ${paid?.code}; open + paid_on → ${extra?.code}; disputed → open → ${ok ? ok.code : "accepted"}`);
    expect(paid?.code).toBe("MB001");
    expect(extra?.code).toBe("MB001");
    expect(ok).toBeNull();
    expect(await status()).toBe("open");
    expect(await origin("core.payable", payable)).toEqual(before);
    expect(before).toMatchObject({ kind: "derivation", rule_id: "purchasing.payable_from_invoice" });
  });

  test("P1 refusals after re-open: open → void under approve → MB001; the same under finance.payable.update.v1 → accepted (other commands untouched)", async () => {
    const voided = await pay("status = 'void'");
    expect(voided?.code).toBe("MB001");
    expect(await status()).toBe("open");
    expect(await pay("status = 'void'", "finance.payable.update.v1")).toBeNull();
    expect(await status()).toBe("void");
  });
});

describe("C1 — the guest-token claim merges an emptied guest profile, so erasure reaches it (R41)", () => {
  test("C1 claim+erase: claim moves the order and its coupon use, merges the guest; erasing the caller then leaves no PII on the guest", async () => {
    const guest = await profile({ guest: true });
    const h = token();
    const o = await placeOrder(guest, { hash: h, coupon: true });
    const me = await profile({ guest: false }); // not email-verified: only the token proves the claim
    const before = [await origin("core.\"order\"", o.id), await origin("core.coupon_use", o.cu), await origin("core.customer", guest)];
    const rows = await claimToken(cust(me, "customers.account.link.v1", { guest_access_hash: h }));
    console.log(`C1 claim: ${JSON.stringify(rows)}`);
    expect(rows).toEqual([
      { entity: "core.coupon_use", entity_id: o.cu, from_customer_id: guest },
      { entity: "core.customer", entity_id: guest, from_customer_id: guest },
      { entity: "core.order", entity_id: o.id, from_customer_id: guest },
    ]);
    const after = await one<{ oc: string; h: string | null; cc: string; m: string }>(`SELECT
      (SELECT customer_id::text FROM core."order" WHERE id = $1) oc, (SELECT guest_access_hash::text FROM core."order" WHERE id = $1) h,
      (SELECT customer_id::text FROM core.coupon_use WHERE id = $2) cc, (SELECT merged_into::text FROM core.customer WHERE id = $3) m`, [o.id, o.cu, guest]);
    expect(after).toEqual({ oc: me, h: null, cc: me, m: me });
    expect([await origin("core.\"order\"", o.id), await origin("core.coupon_use", o.cu), await origin("core.customer", guest)]).toEqual(before);
    // The same token again: the hash is gone → nothing.
    expect(await claimToken(cust(me, "customers.account.link.v1", { guest_access_hash: h }))).toEqual([]);

    expect(await attempt(db, "munim_core", cust(me, "customers.erasure.request.v1"), `UPDATE core.customer SET erased_at = now() WHERE tenant_id = $1 AND id = $2`, [A.tenant, me])).toBeNull();
    const erased = await db.withContext("munim_core", cust(me, "customers.erasure.request.v1"), async (c) =>
      (await c.query(`SELECT entity, entity_id FROM core.customer_erase_merged_guests($1)`, [me])).rows);
    const g = await one<{ name: string | null; phone: string | null; email: string | null; idp: string | null; erased: boolean }>(
      `SELECT name, phone, email, idp_sub idp, erased_at IS NOT NULL erased FROM core.customer WHERE id = $1`, [guest]);
    console.log(`C1 erase: returned ${JSON.stringify(erased)}; guest ${JSON.stringify(g)}`);
    expect(erased).toEqual([{ entity: "core.customer", entity_id: guest }]);
    expect(g).toEqual({ name: null, phone: null, email: null, idp: null, erased: true });
  });

  test("C1 partial: a guest profile with another order left keeps it and is not merged; a guest checkout with no profile moves with from_customer_id NULL", async () => {
    const guest = await profile({ guest: true });
    const h = token();
    const o = await placeOrder(guest, { hash: h });
    const other = await placeOrder(guest);
    const me = await profile({ guest: false });
    expect(await claimToken(cust(me, "customers.account.link.v1", { guest_access_hash: h }))).toEqual([{ entity: "core.order", entity_id: o.id, from_customer_id: guest }]);
    const g = await one<{ m: string | null; left: string }>(`SELECT (SELECT merged_into::text FROM core.customer WHERE id = $1) m,
      (SELECT customer_id::text FROM core."order" WHERE id = $2) "left"`, [guest, other.id]);
    expect(g).toEqual({ m: null, left: guest });
    const h2 = token();
    const anon = await placeOrder(null, { hash: h2 });
    expect(await claimToken(cust(me, "customers.account.link.v1", { guest_access_hash: h2 }))).toEqual([{ entity: "core.order", entity_id: anon.id, from_customer_id: null }]);
  });

  test("C1 refusals: no hash / another command / staff context → MB001; munim_svc → 42501; a signed-in profile's order, an unknown token, a guest caller → nothing", async () => {
    const me = await profile({ guest: false });
    expect(await claimToken(cust(me, "customers.account.link.v1"))).toMatchObject({ code: "MB001" });
    expect(await claimToken(cust(me, "customers.profile.update.v1", { guest_access_hash: token() }))).toMatchObject({ code: "MB001" });
    expect(await claimToken(own("customers.account.link.v1", { guest_access_hash: token() }))).toMatchObject({ code: "MB001" });
    expect(await claimToken({ tenant_id: A.tenant, outlet_ids: "*" }, "munim_svc")).toMatchObject({ code: "42501" });
    const signedIn = await profile({ guest: false });
    const h = token();
    const theirs = await placeOrder(signedIn, { hash: h });
    expect(await claimToken(cust(me, "customers.account.link.v1", { guest_access_hash: h }))).toEqual([]);
    expect((await one<{ c: string }>(`SELECT customer_id::text c FROM core."order" WHERE id = $1`, [theirs.id])).c).toBe(signedIn);
    expect(await claimToken(cust(me, "customers.account.link.v1", { guest_access_hash: token() }))).toEqual([]);
    const guestCaller = await profile({ guest: true });
    const h3 = token();
    const g3 = await placeOrder(null, { hash: h3 });
    expect(await claimToken(cust(guestCaller, "customers.account.link.v1", { guest_access_hash: h3 }))).toEqual([]);
    expect((await one<{ c: string | null }>(`SELECT customer_id::text c FROM core."order" WHERE id = $1`, [g3.id])).c).toBeNull();
  });

  test("C1 rule outside the definer: an owner context naming customers.claim_guest_token cannot merge a profile (MB008)", async () => {
    const me = await profile({ guest: false });
    const guest = await profile({ guest: true });
    const e = await attempt(db, "munim_core", own("kitchen.ticket.advance.v1", { posting_rule: "customers.claim_guest_token", source_ref: `core.customer:${me}` }),
      `UPDATE core.customer SET name = 'Changed' WHERE tenant_id = $1 AND id = $2`, [A.tenant, guest]);
    expect(e?.code).toBe("MB008");
  });
});

describe("R2-S3-7 — coupon_use.discount_minor follows a re-price of its own order only", () => {
  test("R2-S3-7: same order under orders.reprice → accepted (origin kept); another order's coupon use under that source → MB001; no rule → MB001; customer_id → 42501; completed order → MB001", async () => {
    const x = await placeOrder(A.customer, { coupon: true });
    const y = await placeOrder(A.customer, { coupon: true });
    const before = await origin("core.coupon_use", x.cu);
    const set = (cu: string, v: number): [string, unknown[]] => [`UPDATE core.coupon_use SET discount_minor = $3 WHERE tenant_id = $1 AND id = $2`, [A.tenant, cu, v]];
    const same = await reprice(x.id, ...set(x.cu, 1500));
    const otherOrder = await reprice(x.id, ...set(y.cu, 1500));
    const noRule = await attempt(db, "munim_core", own("orders.place.v1"), ...set(x.cu, 1600));
    const column = await reprice(x.id, `UPDATE core.coupon_use SET customer_id = NULL WHERE tenant_id = $1 AND id = $2`, [A.tenant, x.cu]);
    for (const to of ["accepted", "preparing", "ready", "completed"]) expect(await advance(x.id, to)).toBeNull();
    const completed = await reprice(x.id, ...set(x.cu, 1700));
    const d = (await db.admin(`SELECT id, discount_minor::int d FROM core.coupon_use WHERE id = ANY ($1) ORDER BY id`, [[x.cu, y.cu]])).rows;
    console.log(`R2-S3-7: same → ${same ? same.code : "accepted"}; other order → ${otherOrder?.code}; no rule → ${noRule?.code}; customer_id → ${column?.code}; completed → ${completed?.code}`);
    expect(same).toBeNull();
    expect(otherOrder?.code).toBe("MB001");
    expect(noRule?.code).toBe("MB001");
    expect(column?.code).toBe("42501");
    expect(completed?.code).toBe("MB001");
    expect(Object.fromEntries(d.map((r) => [r.id, r.d]))).toEqual({ [x.cu]: 1500, [y.cu]: 1000 });
    expect(await origin("core.coupon_use", x.cu)).toEqual(before);
  });

  test("R2-S3-7 storefront: inside the customer's own storefront.order.reschedule.v1 under orders.reprice the coupon use updates (1 row, new value)", async () => {
    const x = await placeOrder(A.customer, { coupon: true });
    const n = await db.withContext("munim_core", cust(A.customer, "storefront.order.reschedule.v1", { posting_rule: "orders.reprice", source_ref: `core.order:${x.id}` }),
      async (c) => (await c.query(`UPDATE core.coupon_use SET discount_minor = 1200 WHERE tenant_id = $1 AND id = $2`, [A.tenant, x.cu])).rowCount);
    const d = (await one<{ d: number }>(`SELECT discount_minor::int d FROM core.coupon_use WHERE id = $1`, [x.cu])).d;
    console.log(`R2-S3-7 storefront: ${n} row(s), discount now ${d}`);
    expect([n, d]).toEqual([1, 1200]);
  });
});
