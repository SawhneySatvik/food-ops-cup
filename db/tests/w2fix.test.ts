// Gates for the W2 fix list, Batch A (0015; docs/plan/W2-FIX-LIST.md). Each refusal is paired with its accepted
// case; red-proofs on clones. Expected values are typed by hand. Synthetic data only.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { AppContext, TestDb } from "../src/harness.ts";
import { openDb } from "./db.ts";
import { attempt, outletScopeRows } from "./gates.ts";
import { approveDraft, buildWorld, ownerCtx, uuidv7, type World } from "./world.ts";

let db: TestDb;
let A: World;
let B: World;
let m1 = ""; // manager scoped to outlet 1
let m2 = ""; // manager scoped to outlet 2

beforeAll(async () => {
  db = await openDb();
  A = await buildWorld(db);
  B = await buildWorld(db, { country: "AU" });
  m1 = uuidv7();
  m2 = uuidv7();
  await db.withContext("munim_core", ownerCtx(A, { command_type: "tenancy.member.invite.v1" }), async (c) => {
    for (const [m, o] of [[m1, A.outlets[0]], [m2, A.outlets[1]]] as const) {
      await c.query(`INSERT INTO core.member (tenant_id, id, name, email) VALUES ($1, $2, 'Manager', $3)`, [A.tenant, m, `${m}@example.test`]);
      await c.query(`INSERT INTO core.membership (tenant_id, member_id, role, outlet_ids) VALUES ($1, $2, 'manager', $3)`, [A.tenant, m, [o]]);
    }
  });
});
afterAll(async () => db?.stop());

const own = (command_type: string, extra: AppContext = {}) => ownerCtx(A, { command_type, ...extra });
const mgr = (member: string, outlet: string, command_type: string): AppContext =>
  ({ tenant_id: A.tenant, outlet_ids: [outlet], role: "manager", member_id: member, command_type });
const rule = (posting_rule: string, source_ref: string, x: World = A): AppContext =>
  ({ tenant_id: x.tenant, outlet_ids: "*", posting_rule, source_ref });
const one = async <T>(sql: string, params: unknown[], x = db) => (await x.admin(sql, params)).rows[0] as T;
/** Runs `sql` inside an approved draft of `type`; the error or null. */
const approved = (type: string, sql: string, params: unknown[], x = db, w = A) =>
  approveDraft(x, w, type, async (q) => { await q(sql, params); })
    .then(() => null, (e: { code?: string; message: string }) => ({ code: e.code ?? "?", message: e.message }));
/** A balanced two-posting entry (cash +amount, sales −amount); header fields as given. */
const entrySql = `WITH je AS (INSERT INTO core.journal_entry (tenant_id, id, outlet_id, entry_date, source_type, source_id, posting_rule, reverses_id)
                              VALUES ($1, $2, NULL, '2026-10-14', $3, $4, $5, $6) RETURNING id)
  INSERT INTO core.posting (tenant_id, id, journal_entry_id, account_id, amount_minor, currency)
  SELECT $1, gen_random_uuid(), (SELECT id FROM je), $7::uuid, $10::bigint, $9 UNION ALL SELECT $1, gen_random_uuid(), (SELECT id FROM je), $8::uuid, -$10::bigint, $9`;
const entryParams = (w: World, id: string, srcType: string | null, srcId: string | null, postingRule: string | null, reverses: string | null, amount = 700) =>
  [w.tenant, id, srcType, srcId, postingRule, reverses, w.accounts.cash, w.accounts.sales, w.currency, amount];
const expenseSql = `INSERT INTO core.expense (tenant_id, id, outlet_id, category, incurred_on, amount_minor, currency, payee, external_ref)
                    VALUES ($1, gen_random_uuid(), $2, 'utilities', '2026-10-09', 1000, 'INR', 'Power Co (synthetic)', $3)`;
async function placeOrder(outlet: string, customer: string | null = null, w = A): Promise<string> {
  const id = uuidv7();
  await db.withContext("munim_core", ownerCtx(w, { command_type: "orders.place.v1" }), (c) =>
    c.query(`INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, kind, subtotal_minor, total_minor, currency, pricing_snapshot, customer_id)
             VALUES ($1, $2, $3, $4, 'takeaway', 20000, 20000, $5, '{}', $6)`, [w.tenant, id, outlet, w.channel, w.currency, customer]));
  return id;
}
const advance = (order: string, to: string, ctx: AppContext = own("orders.order.advance.v1")) =>
  attempt(db, "munim_core", ctx, `UPDATE core."order" SET status = $3 WHERE tenant_id = $1 AND id = $2`, [A.tenant, order, to]);
async function complete(order: string) {
  for (const to of ["accepted", "preparing", "ready", "completed"]) expect(await advance(order, to)).toBeNull();
}

describe("A1 — draft-only commands are refused as own commands (MB001), accepted as approved drafts", () => {
  test("the draft-only set is exactly the four (hand list)", async () => {
    const r = await db.admin(`SELECT command_type FROM core.command_authority WHERE draft_only ORDER BY 1`);
    expect(r.rows.map((x) => x.command_type)).toEqual(
      ["customers.campaign.create.v1", "finance.journal.adjust.v1", "imports.format.approve.v1", "imports.run.commit.v1"]);
  });

  test("imports.run.commit.v1: an owner's own INSERT and own UPDATE → MB001; the same INSERT in its approved draft → accepted", async () => {
    const ins = await attempt(db, "munim_core", own("imports.run.commit.v1"), expenseSql, [A.tenant, A.outlets[0], `V-${randomUUID()}`]);
    const invoice = (await one<{ id: string }>(`SELECT id FROM core.supplier_invoice WHERE tenant_id = $1`, [A.tenant])).id;
    // Before 0015 an owner (or a manager) could approve a supplier invoice through this command's binding.
    const upd = await attempt(db, "munim_core", own("imports.run.commit.v1"),
      `UPDATE core.supplier_invoice SET status = 'approved' WHERE tenant_id = $1 AND id = $2`, [A.tenant, invoice]);
    const ok = await approved("imports.run.commit.v1", expenseSql, [A.tenant, A.outlets[0], `V-${randomUUID()}`]);
    console.log(`A1 imports.run.commit.v1: own insert → ${ins?.code} (${ins?.message}); own update → ${upd?.code}; approved → ${ok ? ok.code : "accepted"}`);
    expect(ins?.code).toBe("MB001");
    expect(ins?.message).toMatch(/draft-only/);
    expect(upd?.code).toBe("MB001");
    expect(ok).toBeNull();
    expect((await one<{ status: string }>(`SELECT status FROM core.supplier_invoice WHERE id = $1`, [invoice])).status).toBe("recorded");
  });

  test("finance.journal.adjust.v1: own entry → MB001; approved → accepted", async () => {
    const mine = await attempt(db, "munim_core", own("finance.journal.adjust.v1"), entrySql, entryParams(A, uuidv7(), null, null, null, null));
    const ok = await approved("finance.journal.adjust.v1", entrySql, entryParams(A, uuidv7(), null, null, null, null));
    console.log(`A1 finance.journal.adjust.v1: own → ${mine?.code}; approved → ${ok ? ok.code : "accepted"}`);
    expect(mine?.code).toBe("MB001");
    expect(mine?.message).toMatch(/draft-only/);
    expect(ok).toBeNull();
  });

  test("customers.campaign.create.v1: own → MB001; approved → accepted", async () => {
    const coupon = (await one<{ id: string }>(`SELECT id FROM core.coupon WHERE tenant_id = $1`, [A.tenant])).id;
    const sql = `INSERT INTO core.campaign (tenant_id, id, name, channel, segment_snapshot_id, audience_count, message_key, send_at, coupon_id)
                 VALUES ($1, gen_random_uuid(), 'Back again', 'email', $2, 0, 'campaign.come_back', '2026-10-20T10:00:00Z', $3)`;
    const mine = await attempt(db, "munim_core", own("customers.campaign.create.v1"), sql, [A.tenant, A.snapshot, coupon]);
    const ok = await approved("customers.campaign.create.v1", sql, [A.tenant, A.snapshot, coupon]);
    console.log(`A1 customers.campaign.create.v1: own → ${mine?.code}; approved → ${ok ? ok.code : "accepted"}`);
    expect(mine?.code).toBe("MB001");
    expect(ok).toBeNull();
  });

  test("imports.format.approve.v1 (writes no book table): own → MB006 (0009 trigger); approved → accepted", async () => {
    const sql = `INSERT INTO core.import_format (tenant_id, id, kind, name, header_signature, mapping, decision_id)
       VALUES ($1, gen_random_uuid(), 'bank_statement', 'Synthetic', $2, '[{"source": "a", "target": "b"}]', $3)`;
    const params = (decision: string): unknown[] => [A.tenant, randomUUID().replaceAll("-", "").padEnd(64, "e"), decision];
    const anyDecision = (await one<{ id: string }>(`SELECT id FROM core.decision WHERE tenant_id = $1 LIMIT 1`, [A.tenant])).id;
    const mine = await attempt(db, "munim_core", own("imports.format.approve.v1"), sql, params(anyDecision));
    const ok = await approveDraft(db, A, "imports.format.approve.v1", async (q, d) => { await q(sql, params(d)); }).then(() => null, (e: { code: string }) => e);
    expect(mine?.code).toBe("MB006");
    expect(ok).toBeNull();
  });

  test("RED-PROOF: draft_only cleared on imports.run.commit.v1 → the own INSERT is accepted", async () => {
    const x = await db.clone();
    try {
      await x.admin(`UPDATE core.command_authority SET draft_only = false WHERE command_type = 'imports.run.commit.v1'`);
      const e = await attempt(x, "munim_core", own("imports.run.commit.v1"), expenseSql, [A.tenant, A.outlets[0], `V-${randomUUID()}`]);
      console.log("RED-PROOF A1:", e);
      expect(e).toBeNull();
    } finally {
      await x.stop();
    }
  });
});

describe("A2 — finance.post_settlement needs a committed import run", () => {
  const settle = async (run: string | null) => {
    const s = uuidv7();
    expect(await approved("imports.run.commit.v1", `INSERT INTO core.settlement (tenant_id, id, channel_id, period_from, period_to, external_ref, net_minor, currency, import_run_id)
      VALUES ($1, $2, $3, '2026-10-08', '2026-10-14', $4, 700, 'INR', $5)`, [A.tenant, s, A.channel, `P-${s}`, run])).toBeNull();
    return s;
  };
  const post = (s: string, x = db) => attempt(x, "munim_core", rule("finance.post_settlement", `core.settlement:${s}`), entrySql,
    entryParams(A, uuidv7(), "core.settlement", s, "finance.post_settlement", null));

  test("a settlement with no import run → MB001; one from the committed run → accepted", async () => {
    const run = (await one<{ id: string }>(`SELECT id FROM core.import_run WHERE tenant_id = $1 AND status = 'committed'`, [A.tenant])).id;
    const orphan = await post(await settle(null));
    const ok = await post(await settle(run));
    console.log(`A2: NULL-run settlement → ${orphan?.code} (${orphan?.message}); committed run → ${ok ? ok.code : "accepted"}`);
    expect(orphan?.code).toBe("MB001");
    expect(orphan?.message).toMatch(/source state/);
    expect(ok).toBeNull();
  });

  test("RED-PROOF: the 0014 source_state (NULL run allowed) → the orphan settlement posts", async () => {
    const s = await settle(null);
    const x = await db.clone();
    try {
      await x.admin(`UPDATE core.derivation_rule SET source_state = '(s.import_run_id IS NULL OR EXISTS (SELECT 1 FROM core.import_run r WHERE r.tenant_id = s.tenant_id AND r.id = s.import_run_id AND r.status = ''committed''))' WHERE rule_id = 'finance.post_settlement'`);
      const e = await post(s, x);
      console.log("RED-PROOF A2:", e);
      expect(e).toBeNull();
    } finally {
      await x.stop();
    }
  });
});

describe("A3 — outlet RLS on licence, checklist, asset, goal, task, amc, maintenance", () => {
  const T5 = ["core.licence", "core.checklist", "core.asset", "core.goal", "core.task"];
  const seen = (x: TestDb, outlets: string[], table: string) =>
    x.withContext("munim_core", { tenant_id: A.tenant, outlet_ids: outlets }, async (c) =>
      (await c.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n as number);

  test("scoped to outlet 1: outlet 2's rows invisible, outlet 1's visible (5 outlet_id tables)", async () => {
    const r = await outletScopeRows(db, T5, A.tenant, A.outlets[0], A.outlets[1]);
    console.log(`A3 outlet scope: ${r.checked - r.failures.length}/${r.checked} tables ok`);
    expect(r.checked).toBe(5);
    expect(r.failures).toEqual([]);
  });

  test("tenant-wide rows (outlet_id NULL) are visible to an outlet-scoped member", async () => {
    const wide = await db.withContext("munim_core", { tenant_id: A.tenant, outlet_ids: [A.outlets[0]] }, async (c) => ({
      checklist: (await c.query(`SELECT count(*)::int n FROM core.checklist WHERE outlet_id IS NULL`)).rows[0].n,
      goal: (await c.query(`SELECT count(*)::int n FROM core.goal WHERE outlet_id IS NULL`)).rows[0].n,
    }));
    expect(wide).toEqual({ checklist: 1, goal: 1 });
  });

  test("amc and maintenance follow their asset: all → 2 each; outlet 1 → 1 each; outlet 3 (no asset) → 0", async () => {
    const counts = async (o: "*" | string[]) => ({
      amc: await db.withContext("munim_core", { tenant_id: A.tenant, outlet_ids: o }, async (c) => (await c.query(`SELECT count(*)::int n FROM core.amc`)).rows[0].n),
      maintenance: await db.withContext("munim_core", { tenant_id: A.tenant, outlet_ids: o }, async (c) => (await c.query(`SELECT count(*)::int n FROM core.maintenance`)).rows[0].n),
    });
    const all = await counts("*");
    const o1 = await counts([A.outlets[0]]);
    const o3 = await counts([A.outlets[2]]);
    console.log(`A3 via asset: all ${JSON.stringify(all)}, outlet 1 ${JSON.stringify(o1)}, outlet 3 ${JSON.stringify(o3)}`);
    expect(all).toEqual({ amc: 2, maintenance: 2 });
    expect(o1).toEqual({ amc: 1, maintenance: 1 });
    expect(o3).toEqual({ amc: 0, maintenance: 0 });
  });

  test("RED-PROOF: a USING (true) policy on core.licence → the outlet gate is red; on core.amc → outlet 3 sees 2", async () => {
    const x = await db.clone();
    try {
      await x.admin("CREATE POLICY leak ON core.licence USING (true)");
      await x.admin("CREATE POLICY leak ON core.amc USING (true)");
      const r = await outletScopeRows(x, T5, A.tenant, A.outlets[0], A.outlets[1]);
      const amc = await seen(x, [A.outlets[2]], "core.amc");
      console.log("RED-PROOF A3:", r.failures, `amc at outlet 3 = ${amc}`);
      expect(r.failures).toEqual(["core.licence: saw 1 out-of-scope rows"]);
      expect(amc).toBeGreaterThan(0);
    } finally {
      await x.stop();
    }
  });
});

describe("A4 — seeded commands", () => {
  test("the eleven rows read back as written", async () => {
    const r = await db.admin(`SELECT command_type, allowed_roles, scope, target_tables, customer_target_tables, draft_only
                                FROM core.command_authority WHERE command_type = ANY ($1) ORDER BY 1`,
      [["tenancy.onboard.v1", "tenancy.member.bind.v1", "tenancy.member.role.set.v1", "tenancy.member.deactivate.v1", "purchasing.grn.receive.v1",
        "storefront.order.cancel.v1", "storefront.order.reschedule.v1", "orders.order.advance.v1", "orders.order.accept.v1", "orders.order.reject.v1",
        "people.payroll_draft.status.v1"]]);
    const row = (command_type: string, allowed_roles: string[], scope: string, target_tables: string[], customer_target_tables: string[] = []) =>
      ({ command_type, allowed_roles, scope, target_tables, customer_target_tables, draft_only: false });
    const floor = ["owner", "manager", "staff", "judge"];
    expect(r.rows).toEqual([
      row("orders.order.accept.v1", floor, "outlet", ["core.order", "core.order_event"]),
      row("orders.order.advance.v1", floor, "outlet", ["core.order", "core.order_event"]),
      row("orders.order.reject.v1", floor, "outlet", ["core.order", "core.order_event"]),
      row("people.payroll_draft.status.v1", ["owner"], "outlet", ["core.payroll_draft"]),
      row("purchasing.grn.receive.v1", floor, "outlet", ["core.goods_received", "core.grn_line", "core.batch", "core.purchase_order"]),
      row("storefront.order.cancel.v1", ["customer"], "own_order", ["core.order", "core.order_event"], ["core.order", "core.order_event"]),
      row("storefront.order.reschedule.v1", ["customer"], "own_order", ["core.order", "core.order_event"], ["core.order", "core.order_event"]),
      row("tenancy.member.bind.v1", ["owner", "manager", "staff", "advisor", "judge"], "outlet", ["core.member"]),
      row("tenancy.member.deactivate.v1", ["owner"], "tenant", ["core.member", "core.membership"]),
      row("tenancy.member.role.set.v1", ["owner"], "tenant", ["core.membership"]),
      row("tenancy.onboard.v1", ["owner"], "tenant", ["core.tenant", "core.member", "core.membership", "core.outlet", "core.outlet_calendar",
        "core.brand", "core.channel", "core.business_policy", "core.account"]),
    ]);
  });

  test("storefront.order.cancel.v1: the customer cancels its own order; another customer's order is not its own (MB001)", async () => {
    const other = uuidv7();
    await db.withContext("munim_core", own("customers.customer.upsert.v1"), (c) =>
      c.query(`INSERT INTO core.customer (tenant_id, id, name) VALUES ($1, $2, 'Other (synthetic)')`, [A.tenant, other]));
    const mine = await placeOrder(A.outlets[0], A.customer);
    const ctx = (customer: string): AppContext => ({ tenant_id: A.tenant, outlet_ids: [], role: "customer", customer_id: customer, command_type: "storefront.order.cancel.v1" });
    // The other customer re-points the order at itself: OLD is not its own.
    const steal = await attempt(db, "munim_core", { ...ctx(other) },
      `UPDATE core."order" SET customer_id = $3 WHERE tenant_id = $1 AND id = $2`, [A.tenant, mine, other]);
    const ok = await attempt(db, "munim_core", ctx(A.customer), `UPDATE core."order" SET status = 'cancelled' WHERE tenant_id = $1 AND id = $2`, [A.tenant, mine]);
    expect(steal).toBeNull(); // RLS: the other customer sees no such row — 0 rows, nothing changed
    expect((await one<{ customer_id: string }>(`SELECT customer_id FROM core."order" WHERE id = $1`, [mine])).customer_id).toBe(A.customer);
    expect(ok).toBeNull();
    expect((await one<{ status: string }>(`SELECT status FROM core."order" WHERE id = $1`, [mine])).status).toBe("cancelled");
  });

  test("orders.order.advance.v1: outlet-2 manager on an outlet-2 order → accepted; on an outlet-1 order → 0 rows (RLS); staff on outlet 1 → accepted", async () => {
    const o1 = await placeOrder(A.outlets[0]);
    const o2 = await placeOrder(A.outlets[1]);
    const wrong = await db.withContext("munim_core", mgr(m2, A.outlets[1], "orders.order.advance.v1"), (c) =>
      c.query(`UPDATE core."order" SET status = 'accepted' WHERE tenant_id = $1 AND id = $2`, [A.tenant, o1]));
    expect(wrong.rowCount).toBe(0);
    expect(await advance(o2, "accepted", mgr(m2, A.outlets[1], "orders.order.advance.v1"))).toBeNull();
    expect(await advance(o1, "accepted", { tenant_id: A.tenant, outlet_ids: [A.outlets[0]], role: "staff", member_id: A.staff, command_type: "orders.order.advance.v1" })).toBeNull();
  });

  test("tenancy.member.role.set.v1: a manager → MB001; the owner → accepted", async () => {
    const sql = `UPDATE core.membership SET role = 'staff' WHERE tenant_id = $1 AND member_id = $2`;
    const refused = await attempt(db, "munim_core", { ...mgr(m1, A.outlets[0], "tenancy.member.role.set.v1"), outlet_ids: "*" }, sql, [A.tenant, m2]);
    const ok = await attempt(db, "munim_core", own("tenancy.member.role.set.v1"), `UPDATE core.membership SET role = 'manager' WHERE tenant_id = $1 AND member_id = $2`, [A.tenant, m2]);
    expect(refused?.code).toBe("MB001");
    expect(ok).toBeNull();
  });

  test("purchasing.grn.receive.v1: staff at outlet 1 records a GRN there → accepted; at outlet 2 → MB001", async () => {
    const po = (await one<{ id: string }>(`SELECT id FROM core.purchase_order WHERE tenant_id = $1`, [A.tenant])).id;
    const staff: AppContext = { tenant_id: A.tenant, outlet_ids: [A.outlets[0]], role: "staff", member_id: A.staff, command_type: "purchasing.grn.receive.v1" };
    const grn = (o: string) => attempt(db, "munim_core", staff,
      `INSERT INTO core.goods_received (tenant_id, id, outlet_id, supplier_id, po_id, received_by) VALUES ($1, gen_random_uuid(), $2, $3, $4, $5)`, [A.tenant, o, A.supplier, po, A.staff]);
    const other = await grn(A.outlets[1]);
    expect(other?.code).toMatch(/^(MB001|42501)$/); // outside the staff member's outlets: the guard (or RLS WITH CHECK) refuses
    expect(await grn(A.outlets[0])).toBeNull();
  });
});

describe("A5 — refund caps per role", () => {
  test("orders.refund.record.v1 allows staff; caps staff 50000, manager 500000, owner/judge uncapped", async () => {
    const r = await one<{ allowed_roles: string[]; role_caps: unknown; max_amount_minor: string | null }>(
      `SELECT allowed_roles, role_caps, max_amount_minor FROM core.command_authority WHERE command_type = 'orders.refund.record.v1'`, []);
    expect(r).toEqual({ allowed_roles: ["owner", "manager", "staff", "judge"], role_caps: { staff: 50000, manager: 500000 }, max_amount_minor: null });
  });

  test("shape: a negative cap or an unknown role → 23514; a cap for a role the command does not allow fails assert_catalog", async () => {
    const x = await db.clone();
    try {
      for (const bad of ['{"staff": -1}', '{"chef": 1}', '{"staff": 1.5}', '[]']) {
        const e = await x.admin(`UPDATE core.command_authority SET role_caps = $1 WHERE command_type = 'orders.refund.record.v1'`, [bad]).then(() => null, (z: { code: string }) => z.code);
        expect(e, bad).toBe("23514");
      }
      await x.admin(`UPDATE core.command_authority SET role_caps = '{"advisor": 1}' WHERE command_type = 'orders.refund.record.v1'`);
      const e = await x.admin(`SELECT munim_meta.assert_catalog('red')`).then(() => null, (z: { message: string }) => z.message);
      expect(e).toMatch(/role_caps for roles the command does not allow: orders.refund.record.v1/);
    } finally {
      await x.stop();
    }
  });
});

describe("A6 — derivations", () => {
  test("W2-R6: stock goes back for a cancelled order (inventory.reverse_order_consumption); a placed order → MB001", async () => {
    const order = await placeOrder(A.outlets[0]);
    // 0022: a reversal gives back what the order consumed, so the order consumes first.
    expect(await attempt(db, "munim_core", rule("inventory.consume_order", `core.order:${order}`),
      `INSERT INTO core.stock_movement (tenant_id, id, outlet_id, ingredient_id, qty_milli, unit, kind, ref_type, ref_id)
       VALUES ($1, gen_random_uuid(), $2, $3, -150000, 'g', 'sale_consumption', 'core.order', $4)`, [A.tenant, A.outlets[0], A.ingredient, order])).toBeNull();
    const back = () => attempt(db, "munim_core", rule("inventory.reverse_order_consumption", `core.order:${order}`),
      `INSERT INTO core.stock_movement (tenant_id, id, outlet_id, ingredient_id, qty_milli, unit, kind, ref_type, ref_id)
       VALUES ($1, gen_random_uuid(), $2, $3, 150000, 'g', 'sale_return', 'core.order', $4)`, [A.tenant, A.outlets[0], A.ingredient, order]);
    expect((await back())?.code).toBe("MB001");
    // A8: a void moves the order's status.
    expect(await advance(order, "cancelled", own("orders.void.record.v1"))).toBeNull();
    expect(await back()).toBeNull();
  });

  // 0016 (R1-m5) moved the refund path to a core.refund source (tests/w2fixcycle1.test.ts); by order, a completed
  // order is refused whether or not it was refunded.
  test("loyalty reversal by order: a completed order, refunded or not → MB001 (0016: the refund path reads the refund)", async () => {
    const earn = async (order: string) => {
      const id = uuidv7();
      expect(await attempt(db, "munim_core", rule("customers.loyalty_earn", `core.order:${order}`),
        `INSERT INTO core.loyalty_entry (tenant_id, id, customer_id, kind, points, order_id) VALUES ($1, $2, $3, 'earn', 20, $4)`, [A.tenant, id, A.customer, order])).toBeNull();
      return id;
    };
    const reverse = (order: string, of: string) => attempt(db, "munim_core", rule("customers.loyalty_reverse", `core.order:${order}`),
      `INSERT INTO core.loyalty_entry (tenant_id, id, customer_id, kind, points, order_id, reverses_id) VALUES ($1, gen_random_uuid(), $2, 'reverse', -20, $3, $4)`,
      [A.tenant, A.customer, order, of]);
    await complete(A.orders[0]); // the world refunded 1000 on it
    const plain = await placeOrder(A.outlets[0], A.customer);
    await complete(plain);
    const refusedEarn = await earn(plain);
    const refundedEarn = await earn(A.orders[0]);
    const refused = await reverse(plain, refusedEarn);
    const byOrder = await reverse(A.orders[0], refundedEarn);
    console.log(`A6 loyalty reverse by order: no refund → ${refused?.code}; refunded → ${byOrder?.code}`);
    expect(refused?.code).toBe("MB001");
    expect(byOrder?.code).toBe("MB001");
    // A9: one earn per order.
    const twice = await attempt(db, "munim_core", rule("customers.loyalty_earn", `core.order:${plain}`),
      `INSERT INTO core.loyalty_entry (tenant_id, id, customer_id, kind, points, order_id) VALUES ($1, gen_random_uuid(), $2, 'earn', 20, $3)`, [A.tenant, A.customer, plain]);
    expect(twice?.code).toBe("23505");
  });

  test("supplier invoice: post when approved; reverse only once disputed; re-approval re-posts as the reversal of the reversal (a plain re-post → 23505)", async () => {
    const inv = (await one<{ id: string }>(`SELECT id FROM core.supplier_invoice WHERE tenant_id = $1`, [A.tenant])).id;
    const src = `core.supplier_invoice:${inv}`;
    // A reversal negates; the reversal of a reversal is the original again.
    const write = (ruleId: string, id: string, reverses: string | null) =>
      attempt(db, "munim_core", rule(ruleId, src), entrySql,
        entryParams(A, id, "core.supplier_invoice", inv, ruleId, reverses, ruleId === "finance.reverse_supplier_invoice" ? -700 : 700));
    const status = (to: string, cmd: string) => attempt(db, "munim_core", own(cmd), `UPDATE core.supplier_invoice SET status = $3 WHERE tenant_id = $1 AND id = $2`, [A.tenant, inv, to]);
    expect(await status("approved", "purchasing.invoice.approve.v1")).toBeNull();
    const e1 = uuidv7(); const e2 = uuidv7(); const e3 = uuidv7();
    expect(await write("finance.post_supplier_invoice", e1, null)).toBeNull();
    expect((await write("finance.reverse_supplier_invoice", e2, e1))?.code).toBe("MB001"); // still approved
    expect(await status("disputed", "purchasing.invoice.dispute.v1")).toBeNull(); // A8
    expect(await write("finance.reverse_supplier_invoice", e2, e1)).toBeNull();
    expect(await status("approved", "purchasing.invoice.approve.v1")).toBeNull();
    expect((await write("finance.post_supplier_invoice", uuidv7(), null))?.code).toBe("23505");
    expect(await write("finance.post_supplier_invoice", e3, e2)).toBeNull();
    const net = await one<{ n: string }>(`SELECT sum(p.amount_minor)::text n FROM core.posting p WHERE p.journal_entry_id = ANY ($1) AND p.account_id = $2`, [[e1, e2, e3], A.accounts.cash]);
    expect(net.n).toBe("700"); // posted, reversed, posted again
  });

  test("payroll: reversal refused while approved; a manager cannot void (owner-only status command); the owner voids; reversal accepted", async () => {
    const pd = (await one<{ id: string }>(`SELECT id FROM core.payroll_draft WHERE tenant_id = $1`, [A.tenant])).id;
    const src = `core.payroll_draft:${pd}`;
    const e1 = uuidv7();
    expect(await attempt(db, "munim_core", rule("finance.post_payroll", src), entrySql, entryParams(A, e1, "core.payroll_draft", pd, "finance.post_payroll", null))).toBeNull();
    const rev = () => attempt(db, "munim_core", rule("finance.reverse_payroll", src), entrySql, entryParams(A, uuidv7(), "core.payroll_draft", pd, "finance.reverse_payroll", e1));
    expect((await rev())?.code).toBe("MB001");
    const voidIt = (ctx: AppContext) => attempt(db, "munim_core", ctx, `UPDATE core.payroll_draft SET status = 'void' WHERE tenant_id = $1 AND id = $2`, [A.tenant, pd]);
    expect((await voidIt(mgr(m1, A.outlets[0], "people.payroll_draft.status.v1")))?.code).toBe("MB001");
    expect(await voidIt(own("people.payroll_draft.status.v1"))).toBeNull();
    expect(await rev()).toBeNull();
  });

  test("finance.post_advance: an advance posts", async () => {
    const adv = (await one<{ id: string }>(`SELECT id FROM core.advance WHERE tenant_id = $1`, [A.tenant])).id;
    expect(await attempt(db, "munim_core", rule("finance.post_advance", `core.advance:${adv}`), entrySql,
      entryParams(A, uuidv7(), "core.advance", adv, "finance.post_advance", null))).toBeNull();
    expect((await attempt(db, "munim_core", rule("finance.post_advance", `core.advance:${randomUUID()}`), entrySql,
      entryParams(A, uuidv7(), "core.advance", randomUUID(), "finance.post_advance", null)))?.code).toBe("MB001");
  });

  test("transfer: the source-only manager cannot receive (MB001); the destination manager can; then transfer_in creates the batch", async () => {
    const tr = (await one<{ id: string }>(`SELECT id FROM core.transfer WHERE tenant_id = $1 AND from_outlet_id = $2`, [A.tenant, A.outlets[0]])).id;
    const batch = () => attempt(db, "munim_core", rule("inventory.transfer_in", `core.transfer:${tr}`),
      `INSERT INTO core.batch (tenant_id, id, outlet_id, ingredient_id, batch_code, expires_on) VALUES ($1, gen_random_uuid(), $2, $3, 'B-T1', '2026-10-01')`,
      [A.tenant, A.outlets[1], A.ingredient]);
    const receive = (m: string, o: string) => attempt(db, "munim_core", mgr(m, o, "inventory.transfer.receive.v1"),
      `UPDATE core.transfer SET status = 'received', received_by = $3, received_at = now() WHERE tenant_id = $1 AND id = $2`, [A.tenant, tr, m]);
    expect((await batch())?.code).toBe("MB001"); // still sent
    const source = await receive(m1, A.outlets[0]);
    console.log(`A6 transfer receive: source-only manager → ${source?.code}`);
    expect(source?.code).toBe("MB001");
    expect(await receive(m2, A.outlets[1])).toBeNull();
    expect(await batch()).toBeNull();
  });
});

describe("A7 — imports", () => {
  test("an approved POS-export import writes a completed order (no device, the bill's date, no invoice number) and its tender", async () => {
    const order = uuidv7();
    const e = await approveDraft(db, A, "imports.run.commit.v1", async (q) => {
      await q(`INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, kind, status, business_date, subtotal_minor, total_minor, currency, pricing_snapshot, external_ref)
               VALUES ($1, $2, $3, $4, 'takeaway', 'completed', '2026-09-15', 45000, 45000, 'INR', '{}', 'POS-BILL-1')`, [A.tenant, order, A.outlets[1], A.channel]);
      await q(`INSERT INTO core.tender (tenant_id, id, outlet_id, order_id, method, amount_minor, currency, recorded_by) VALUES ($1, gen_random_uuid(), $2, $3, 'card', 45000, 'INR', $4)`,
        [A.tenant, A.outlets[1], order, A.owner]);
    }).then(() => null, (x: { code: string; message: string }) => x);
    expect(e).toBeNull();
    const r = await one<{ business_date: string; invoice_no: number | null; ticket_no: number; kind: string }>(
      `SELECT business_date::text, invoice_no, ticket_no, origin ->> 'kind' AS kind FROM core."order" WHERE id = $1`, [order]);
    expect(r).toEqual({ business_date: "2026-09-15", invoice_no: null, ticket_no: 1, kind: "decision" });
    const mine = await attempt(db, "munim_core", own("imports.run.commit.v1"),
      `INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, kind, status, subtotal_minor, total_minor, currency, pricing_snapshot)
       VALUES ($1, gen_random_uuid(), $2, $3, 'takeaway', 'completed', 1, 1, 'INR', '{}')`, [A.tenant, A.outlets[1], A.channel]);
    expect(mine?.code).toBe("MB001");
  });

  test("import_run.failure_reason only with status failed (munim_svc sets it); expense external_ref unique per tenant", async () => {
    const doc = (await one<{ id: string }>(`SELECT id FROM core.document WHERE tenant_id = $1`, [A.tenant])).id;
    const run = uuidv7();
    const svc = { tenant_id: A.tenant, outlet_ids: "*" as const };
    await db.withContext("munim_svc", svc, (c) =>
      c.query(`INSERT INTO core.import_run (tenant_id, id, document_id, kind, parser) VALUES ($1, $2, $3, 'bank_statement', 'synthetic_v1')`, [A.tenant, run, doc]));
    expect((await attempt(db, "munim_svc", svc, `UPDATE core.import_run SET failure_reason = 'date_unreadable' WHERE id = $1`, [run]))?.code).toBe("23514");
    expect(await attempt(db, "munim_svc", svc, `UPDATE core.import_run SET status = 'failed', failure_reason = 'date_unreadable' WHERE id = $1`, [run])).toBeNull();
    expect((await attempt(db, "munim_core", own("drafts.approve.v1"), `UPDATE core.import_run SET failure_reason = 'x' WHERE id = $1`, [run]))?.code).toBe("42501");
    const ref = `TALLY-${randomUUID()}`;
    expect(await approved("imports.run.commit.v1", expenseSql, [A.tenant, A.outlets[0], ref])).toBeNull();
    expect((await approved("imports.run.commit.v1", expenseSql, [A.tenant, A.outlets[0], ref]))?.code).toBe("23505");
  });
});

describe("A8 — order lines, erasure, coupons", () => {
  test("order_line money: outside orders.reprice → MB001; under orders.reprice for its (placed) order → accepted", async () => {
    const sql = `UPDATE core.order_line SET unit_price_minor = 30000, tax_minor = 1500 WHERE tenant_id = $1 AND id = $2`;
    const refused = await attempt(db, "munim_core", own("orders.place.v1"), sql, [A.tenant, A.orderLines[1]]);
    const otherOrder = await attempt(db, "munim_core", rule("orders.reprice", `core.order:${A.orders[0]}`), sql, [A.tenant, A.orderLines[1]]);
    const ok = await attempt(db, "munim_core", rule("orders.reprice", `core.order:${A.orders[1]}`), sql, [A.tenant, A.orderLines[1]]);
    console.log(`A8 order_line money: own command → ${refused?.code}; another order's reprice → ${otherOrder?.code}; its reprice → ${ok ? ok.code : "accepted"}`);
    expect(refused?.code).toBe("MB001");
    expect(otherOrder?.code).toBe("MB001");
    expect(ok).toBeNull();
  });

  test("erasure reaches the customer's own reservation note; profile.update cannot (MB001)", async () => {
    const ctx = (cmd: string): AppContext => ({ tenant_id: A.tenant, outlet_ids: [], role: "customer", customer_id: A.customer, command_type: cmd });
    const sql = `UPDATE core.reservation SET note = NULL, phone = NULL WHERE tenant_id = $1 AND customer_id = $2`;
    expect((await attempt(db, "munim_core", ctx("customers.profile.update.v1"), sql, [A.tenant, A.customer]))?.code).toBe("MB001");
    expect(await attempt(db, "munim_core", ctx("customers.erasure.request.v1"), sql, [A.tenant, A.customer])).toBeNull();
    expect(await attempt(db, "munim_core", ctx("customers.erasure.request.v1"),
      `UPDATE core.order_line SET note = NULL WHERE tenant_id = $1 AND order_id = $2`, [A.tenant, A.orders[0]])).toBeNull();
  });

  test("coupon: min spend, customer requirement and outlets are editable under catalogue.coupon.set.v1", async () => {
    expect(await attempt(db, "munim_core", own("catalogue.coupon.set.v1"),
      `UPDATE core.coupon SET min_spend_minor = 50000, requires_customer = true, outlet_ids = $2 WHERE tenant_id = $1`, [A.tenant, [A.outlets[0]]])).toBeNull();
  });
});

describe("A9 — columns and uniqueness", () => {
  test("one reconciliation break per (settlement line, kind); merged_into ≠ id; shift_id, done_at, active, loyalty policy defaults", async () => {
    const line = (await one<{ id: string }>(`SELECT settlement_line_id AS id FROM core.reconciliation_break WHERE tenant_id = $1`, [A.tenant])).id;
    const dispute = (await one<{ id: string }>(`SELECT id FROM core.dispute WHERE tenant_id = $1`, [A.tenant])).id;
    const dup = await attempt(db, "munim_core", own("finance.dispute.draft.v1"),
      `INSERT INTO core.reconciliation_break (tenant_id, id, kind, settlement_line_id, amount_minor, currency, status, dispute_id) VALUES ($1, gen_random_uuid(), 'short_payout', $2, 1, 'INR', 'disputed', $3)`,
      [A.tenant, line, dispute]);
    expect(dup?.code).toBe("23505");
    // merged_into: nobody but the A10 function may set it (guard), and never to the row itself (CHECK, seen with the guard off on a clone).
    expect((await attempt(db, "munim_core", own("customers.customer.upsert.v1"), `UPDATE core.customer SET merged_into = $2 WHERE tenant_id = $1 AND id <> $2`,
      [A.tenant, A.customer]))?.code).toBe("42501");
    const x = await db.clone();
    try {
      await x.admin("ALTER TABLE core.customer DISABLE TRIGGER book_guard");
      expect(await x.admin(`UPDATE core.customer SET merged_into = id WHERE tenant_id = $1`, [A.tenant]).then(() => null, (z: { code: string }) => z.code)).toBe("23514");
    } finally {
      await x.stop();
    }
    const policy = await one<{ e: string; v: string }>(`SELECT loyalty_earn_per_minor::text e, loyalty_point_value_minor::text v FROM core.business_policy WHERE tenant_id = $1`, [A.tenant]);
    expect(policy).toEqual({ e: "1000", v: "10" });
    const shift = (await one<{ id: string }>(`SELECT id FROM core.shift WHERE tenant_id = $1 AND outlet_id = $2`, [A.tenant, A.outlets[0]])).id;
    expect(await attempt(db, "munim_core", own("orders.tender.record.v1"),
      `INSERT INTO core.tender (tenant_id, id, outlet_id, order_id, method, amount_minor, currency, recorded_by, shift_id) VALUES ($1, gen_random_uuid(), $2, $3, 'upi', 100, 'INR', $4, $5)`,
      [A.tenant, A.outlets[0], A.orders[0], A.owner, shift])).toBeNull();
    expect(await attempt(db, "munim_core", own("kitchen.prep_list.create.v1"), `UPDATE core.prep_list_line SET done_at = now() WHERE tenant_id = $1`, [A.tenant])).toBeNull();
    expect(await attempt(db, "munim_core", own("catalogue.item.upsert.v1"), `UPDATE core.option_ingredient_delta SET active = false WHERE tenant_id = $1`, [A.tenant])).toBeNull();
  });
});

describe("A10 — core.customer_claim_verified_email_guests() (R41)", () => {
  const EMAIL = "ravi.synthetic@example.test";
  let guest = "";
  let guestOrders: string[] = [];
  const guestReservation = uuidv7();
  const guestBulk = uuidv7();
  let bGuest = "";
  const linkCtx = (customer: string): AppContext =>
    ({ tenant_id: A.tenant, outlet_ids: [], role: "customer", customer_id: customer, command_type: "customers.account.link.v1" });
  // No ORDER BY here: the function's own order (entity, entity_id) is part of what is asserted.
  const claim = (ctx: AppContext, role: "munim_core" | "munim_svc" = "munim_core") =>
    db.withContext(role, ctx, async (c) => (await c.query(`SELECT entity, entity_id, from_customer_id FROM core.customer_claim_verified_email_guests()`)).rows)
      .catch((e: { code: string; message: string }) => ({ code: e.code, message: e.message }));
  const profile = async (w: World, opts: { guest: boolean; sub?: string; verified?: boolean; email: string }) => {
    const id = uuidv7();
    await db.withContext("munim_core", ownerCtx(w, { command_type: "customers.customer.upsert.v1" }), (c) =>
      c.query(`INSERT INTO core.customer (tenant_id, id, name, email, is_guest, idp_sub, email_verified_at) VALUES ($1, $2, 'Ravi (synthetic)', $3, $4, $5, CASE WHEN $6 THEN now() END)`,
        [w.tenant, id, opts.email, opts.guest, opts.sub ?? null, opts.verified ?? false]));
    return id;
  };

  beforeAll(async () => {
    guest = await profile(A, { guest: true, email: "Ravi.Synthetic@example.test" });
    guestOrders = [await placeOrder(A.outlets[0], guest), await placeOrder(A.outlets[1], guest)].sort();
    await db.withContext("munim_core", own("customers.reservation.upsert.v1"), (c) =>
      c.query(`INSERT INTO core.reservation (tenant_id, id, outlet_id, customer_id, name, party_size, starts_at) VALUES ($1, $2, $3, $4, 'Ravi', 2, '2026-10-20T19:00:00Z')`,
        [A.tenant, guestReservation, A.outlets[0], guest]));
    await db.withContext("munim_core", own("customers.bulk_order.upsert.v1"), (c) =>
      c.query(`INSERT INTO core.bulk_order (tenant_id, id, outlet_id, customer_id, contact_name, deliver_at, headcount) VALUES ($1, $2, $3, $4, 'Ravi', '2026-10-25T12:00:00Z', 20)`,
        [A.tenant, guestBulk, A.outlets[0], guest]));
    await db.withContext("munim_core", own("customers.loyalty.adjust.v1"), (c) =>
      c.query(`INSERT INTO core.loyalty_entry (tenant_id, id, customer_id, kind, points) VALUES ($1, gen_random_uuid(), $2, 'adjust', 10)`, [A.tenant, guest]));
    // Tenant B has a guest with the same email: never touched from A.
    bGuest = await profile(B, { guest: true, email: EMAIL });
    await placeOrder(B.outlets[0], bGuest, B);
  });

  test("an unverified caller moves nothing; a verified caller gets one row per changed book row (2 orders, reservation, bulk order, the merged guest) in (entity, id) order", async () => {
    const unverified = await profile(A, { guest: false, sub: `sub-${randomUUID()}`, email: EMAIL });
    expect(await claim(linkCtx(unverified))).toEqual([]);
    const me = await profile(A, { guest: false, sub: `sub-${randomUUID()}`, verified: true, email: EMAIL });
    const moved = await claim(linkCtx(me));
    console.log(`A10 merge: returned ${JSON.stringify(moved)}`);
    // Hand-written: the fixture's rows, entities in byte order (bulk_order < customer < order < reservation).
    expect(moved).toEqual([
      { entity: "core.bulk_order", entity_id: guestBulk, from_customer_id: guest },
      { entity: "core.customer", entity_id: guest, from_customer_id: guest },
      { entity: "core.order", entity_id: guestOrders[0], from_customer_id: guest },
      { entity: "core.order", entity_id: guestOrders[1], from_customer_id: guest },
      { entity: "core.reservation", entity_id: guestReservation, from_customer_id: guest },
    ]);
    const after = await one<{ mine: number; left: number; resv: number; bulk: number; merged: string; loyalty: number; b: number }>(`SELECT
      (SELECT count(*)::int FROM core."order" WHERE tenant_id = $1 AND customer_id = $2) mine,
      (SELECT count(*)::int FROM core."order" WHERE tenant_id = $1 AND customer_id = $3) "left",
      (SELECT count(*)::int FROM core.reservation WHERE tenant_id = $1 AND customer_id = $2) resv,
      (SELECT count(*)::int FROM core.bulk_order WHERE tenant_id = $1 AND customer_id = $2) bulk,
      (SELECT merged_into::text FROM core.customer WHERE tenant_id = $1 AND id = $3) merged,
      (SELECT count(*)::int FROM core.loyalty_entry WHERE tenant_id = $1 AND customer_id = $3) loyalty,
      (SELECT count(*)::int FROM core."order" WHERE tenant_id = $4 AND customer_id = $5) b`,
      [A.tenant, me, guest, B.tenant, bGuest]);
    expect(after).toEqual({ mine: 2, left: 0, resv: 1, bulk: 1, merged: me, loyalty: 1, b: 1 });
    // 0017 (O1): the move keeps the order's creation origin (placement); the merge is traced by its audit entries.
    const origin = await one<{ o: { kind: string; command_type: string } }>(`SELECT origin o FROM core."order" WHERE id = $1`, [guestOrders[0]]);
    expect(origin.o).toMatchObject({ kind: "command", command_type: "orders.place.v1" });
    expect(await claim(linkCtx(me))).toEqual([]); // merged guests are not taken twice
  });

  test("refused outside the customer's own link command (MB001) and for munim_svc (42501)", async () => {
    expect(await claim(own("customers.account.link.v1"))).toMatchObject({ code: "MB001" });
    expect(await claim({ ...linkCtx(A.customer), command_type: "customers.profile.update.v1" })).toMatchObject({ code: "MB001" });
    expect(await claim({ tenant_id: A.tenant, outlet_ids: "*" }, "munim_svc")).toMatchObject({ code: "42501" });
  });

  test("the merge rule gives nothing outside the function: an owner context naming it → MB001", async () => {
    const me = await profile(A, { guest: false, sub: `sub-${randomUUID()}`, verified: true, email: "someone.synthetic@example.test" });
    const order = await placeOrder(A.outlets[0], A.customer);
    const e = await attempt(db, "munim_core", { ...own("customers.customer.upsert.v1"), posting_rule: "customers.merge_verified_email", source_ref: `core.customer:${me}`, customer_id: me },
      `UPDATE core."order" SET customer_id = $3 WHERE tenant_id = $1 AND id = $2`, [A.tenant, order, me]);
    console.log(`A10 rule outside the definer → ${e?.code}`);
    expect(e?.code).toBe("MB008"); // the derivation fails (not munim_crosstenant); customers.customer.upsert.v1 does not list core.order
    expect((await one<{ c: string }>(`SELECT customer_id::text c FROM core."order" WHERE id = $1`, [order])).c).toBe(A.customer);
  });

  test("RED-PROOF: the rule without its current_user clause → the owner context moves the order", async () => {
    const me = await profile(A, { guest: false, sub: `sub-${randomUUID()}`, verified: true, email: "other.synthetic@example.test" });
    const order = await placeOrder(A.outlets[0], A.customer);
    const x = await db.clone();
    try {
      await x.admin(`UPDATE core.derivation_rule SET source_state = replace(source_state, ' AND current_user = ''munim_crosstenant''', '') WHERE rule_id = 'customers.merge_verified_email'`);
      const e = await attempt(x, "munim_core", { ...own("customers.customer.upsert.v1"), posting_rule: "customers.merge_verified_email", source_ref: `core.customer:${me}`, customer_id: me },
        `UPDATE core."order" SET customer_id = $3 WHERE tenant_id = $1 AND id = $2`, [A.tenant, order, me]);
      console.log("RED-PROOF A10:", e);
      expect(e).toBeNull();
    } finally {
      await x.stop();
    }
  });
});

describe("A11 — model roles and the operator spend template", () => {
  test("six roles on ADR-010 ids, none 2.5", async () => {
    const r = await db.admin(`SELECT role, provider, model_id FROM platform.model_role ORDER BY role`);
    expect(r.rows).toEqual([
      { role: "embed", provider: "gemini", model_id: "gemini-embedding-001" },
      { role: "extract", provider: "gemini", model_id: "gemini-3.5-flash-lite" },
      { role: "narrate", provider: "gemini", model_id: "gemini-3.5-flash-lite" },
      { role: "reason", provider: "gemini", model_id: "gemini-3.8-flash" },
      { role: "router", provider: "gemini", model_id: "gemini-3.5-flash-lite" },
      { role: "vision", provider: "gemini", model_id: "gemini-3.8-flash" },
    ]);
  });

  test("platform.spend_by_tenant runs under the named tenant's context and returns that tenant's spend only", async () => {
    const t = await one<{ sql: string; min_role: string }>(`SELECT sql, min_role FROM evidence.snapshot_template WHERE id = 'platform.spend_by_tenant'`, []);
    expect(t.min_role).toBe("operator");
    const rows = await db.withContext("munim_core", { tenant_id: A.tenant, outlet_ids: "*", role: "operator", operator_id: A.operator }, async (c) =>
      (await c.query(t.sql.replace(":tenant_id::uuid", "$1::uuid"), [A.tenant])).rows);
    expect(rows).toEqual([{ month: rows[0]?.month, role: "router", provider: "gemini", model_id: "gemini-3-flash", currency: "INR", amount_minor: "15" }]);
  });
});
