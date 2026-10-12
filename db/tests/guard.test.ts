// Gate: the book guard (03-architecture §1.3, ADR-013, 02-schema §8 "Book guard").
// No admitting context → MB001 on every book table (count from tags = manifest). Each branch is paired:
// own command allowed/refused (role, principal, scope), decision executing in this txid accepted / replayed
// from an earlier txid refused / rejected verdict refused, derivation listed accepted / unlisted, wrong
// target, missing source refused. Red-proof: drop the trigger on one table.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { AppContext, TestDb } from "../src/harness.ts";
import { openDb } from "./db.ts";
import { attempt, catalogTags, ident } from "./gates.ts";
import { EXPECTED_COUNTS } from "./manifest.ts";
import { buildWorld, ownerCtx, type World } from "./world.ts";

let db: TestDb;
let A: World;

beforeAll(async () => {
  db = await openDb();
  A = await buildWorld(db);
});
afterAll(async () => db?.stop());

/** INSERT a bare (tenant_id, …) row into every book table with no admitting context; count MB001s. */
async function noContextSweep(x: TestDb, tenant: string): Promise<{ tables: number; refused: number; failures: string[] }> {
  const tags = await catalogTags(x);
  const book = [...tags].filter(([, t]) => t === "munim:book").map(([n]) => n);
  const failures: string[] = [];
  let refused = 0;
  for (const t of book) {
    const e = await attempt(x, "munim_core", { tenant_id: tenant, outlet_ids: "*" }, `INSERT INTO ${ident(t)} (tenant_id) VALUES ($1)`, [tenant]);
    if (e?.code === "MB001") refused++;
    else failures.push(`${t}: ${e ? `${e.code} ${e.message}` : "accepted"}`);
  }
  return { tables: book.length, refused, failures };
}

// Each test price gets its own one-day window (consecutive windows are adjacent, never overlapping).
const priceSql = `INSERT INTO core.price (tenant_id, id, item_id, outlet_id, channel_kind, amount_minor, currency, tax_class, valid_from, valid_to)
                  VALUES ($1, $2, $3, $4, 'table_qr', 30000, 'INR', 'restaurant_5', $5::date, $5::date + 1) RETURNING origin`;
let day = 0;
const nextDay = () => new Date(Date.UTC(2030, 0, 1 + day++)).toISOString().slice(0, 10);
const priceParams = (outlet: string) => [A.tenant, randomUUID(), A.item, outlet, nextDay()];

describe("no admitting context", () => {
  test(`every book table refuses a write with MB001 (expected ${EXPECTED_COUNTS.book})`, async () => {
    const r = await noContextSweep(db, A.tenant);
    console.log(`book guard: ${r.refused}/${r.tables} book tables refused a context-free write with MB001`);
    expect(r.tables).toBe(EXPECTED_COUNTS.book);
    expect(r.failures).toEqual([]);
    expect(r.refused).toBe(EXPECTED_COUNTS.book);
  });

  test("an UPDATE with no context is refused too; the same UPDATE as the owner's command is accepted", async () => {
    const sql = `UPDATE core.deal SET active = false WHERE tenant_id = $1`;
    expect((await attempt(db, "munim_core", { tenant_id: A.tenant, outlet_ids: "*" }, sql, [A.tenant]))?.code).toBe("MB001");
    expect(await attempt(db, "munim_core", ownerCtx(A, { command_type: "catalogue.deal.upsert.v1" }), sql, [A.tenant])).toBeNull();
  });

  test("the superuser gets no bypass either", async () => {
    const e = await attempt(db, "admin", { tenant_id: A.tenant }, `INSERT INTO core.deal (tenant_id) VALUES ($1)`, [A.tenant]);
    expect(e?.code).toBe("MB001");
  });
});

describe("branch 1 — a person's own command", () => {
  test("owner + listed command → accepted, origin stamped with the command and principal", async () => {
    const r = await db.withContext("munim_core", ownerCtx(A, { command_type: "catalogue.price.set.v1" }), (c) => c.query(priceSql, priceParams(A.outlets[0])));
    expect(r.rows[0].origin).toEqual({ kind: "command", command_type: "catalogue.price.set.v1", role: "owner", principal_id: A.owner });
  });

  // Built at test time (A exists only after beforeAll).
  const refusals: [string, () => AppContext][] = [
    ["staff is not listed for catalogue.price.set.v1", () => ({ role: "staff", member_id: A.staff, command_type: "catalogue.price.set.v1" })],
    ["no principal id", () => ({ role: "owner", command_type: "catalogue.price.set.v1" })],
    ["unknown command type", () => ({ role: "owner", member_id: A.owner, command_type: "catalogue.price.nuke.v1" })],
    ["role without command type", () => ({ role: "owner", member_id: A.owner })],
    ["customer principal set under a member role", () => ({ role: "owner", customer_id: A.owner, command_type: "catalogue.price.set.v1" })],
  ];
  for (const [name, extra] of refusals) {
    test(`refused: ${name}`, async () => {
      const ctx: AppContext = { tenant_id: A.tenant, outlet_ids: "*", ...extra() };
      const e = await attempt(db, "munim_core", ctx, priceSql, priceParams(A.outlets[0]));
      expect(e?.code).toBe("MB001");
    });
  }

  test("outlet scope: price for outlet 1 under scope {outlet 1} accepted; for outlet 2 refused", async () => {
    const ctx = ownerCtx(A, { command_type: "catalogue.price.set.v1", outlet_ids: [A.outlets[0]] });
    expect(await attempt(db, "munim_core", ctx, priceSql, priceParams(A.outlets[0]))).toBeNull();
    expect((await attempt(db, "munim_core", ctx, priceSql, priceParams(A.outlets[1])))?.code).toBe("MB001");
  });

  test("tenant scope: a tenant-scoped command needs {*}", async () => {
    const sql = `INSERT INTO core.ingredient (tenant_id, id, name, base_unit) VALUES ($1, gen_random_uuid(), 'Salt', 'g')`;
    expect(await attempt(db, "munim_core", ownerCtx(A, { command_type: "inventory.ingredient.upsert.v1" }), sql, [A.tenant])).toBeNull();
    const scoped = ownerCtx(A, { command_type: "inventory.ingredient.upsert.v1", outlet_ids: [A.outlets[0]] });
    expect((await attempt(db, "munim_core", scoped, sql, [A.tenant]))?.code).toBe("MB001");
  });
});

/** Approve-and-execute in ONE transaction (03-architecture §1.6), as the approver with only app.decision_id. */
async function approveAndExecute(x: TestDb, draft: string, verdict: "approved" | "rejected", leaveExecuting = false) {
  const decision = randomUUID();
  // The approver is named (role + member id) but sets no command_type, so only the decision branch can admit.
  const origin = await x.withContext("munim_core", { tenant_id: A.tenant, outlet_ids: "*", role: "owner", member_id: A.owner }, async (c) => {
    await c.query(`UPDATE core.draft SET status = 'executing', exec_txid = txid_current() WHERE tenant_id = $1 AND id = $2 AND status = 'proposed'`, [A.tenant, draft]);
    await c.query(`INSERT INTO core.decision (tenant_id, id, draft_id, verdict, final_payload, decided_by) VALUES ($1, $2, $3, $4, $5, $6)`,
      [A.tenant, decision, draft, verdict, verdict === "rejected" ? null : {}, A.owner]);
    await c.query("SELECT set_config('app.decision_id', $1, true)", [decision]);
    const r = await c.query(priceSql, priceParams(A.outlets[0]));
    if (!leaveExecuting) await c.query(`UPDATE core.draft SET status = 'executed' WHERE tenant_id = $1 AND id = $2`, [A.tenant, draft]);
    return r.rows[0].origin;
  });
  return { decision, origin };
}

async function newDraft(x: TestDb): Promise<string> {
  const id = randomUUID();
  await x.withContext("munim_svc", { tenant_id: A.tenant, outlet_ids: "*" }, (c) =>
    c.query(`INSERT INTO core.draft (tenant_id, id, outlet_ids, source, run_id, command_type, command_payload)
             VALUES ($1, $2, $3, 'intel:catalogue', $4, 'catalogue.price.set.v1', '{}')`, [A.tenant, id, [A.outlets[0]], A.run]));
  return id;
}

describe("branch 2 — an approved decision executing in this transaction", () => {
  test("accepted inside the approving transaction; origin = decision", async () => {
    const { decision, origin } = await approveAndExecute(db, await newDraft(db), "approved");
    expect(origin).toEqual({ kind: "decision", decision_id: decision });
  });

  test("replaying the decision id from a later transaction → MB001 (even if the draft was left executing)", async () => {
    const { decision } = await approveAndExecute(db, await newDraft(db), "approved", true);
    const e = await attempt(db, "munim_core", { tenant_id: A.tenant, outlet_ids: "*", decision_id: decision }, priceSql, priceParams(A.outlets[0]));
    expect(e?.code).toBe("MB001");
  });

  test("a rejected verdict admits nothing", async () => {
    await expect(approveAndExecute(db, await newDraft(db), "rejected")).rejects.toMatchObject({ code: "MB001" });
  });

  test("a decision must be the signed-in member's, with authority for the draft's command type (MB006)", async () => {
    const dec = (draft: string, role: string, member: string, decidedBy: string) =>
      attempt(db, "munim_core", { tenant_id: A.tenant, outlet_ids: "*", role, member_id: member },
        `INSERT INTO core.decision (tenant_id, id, draft_id, verdict, reason, decided_by) VALUES ($1, gen_random_uuid(), $2, 'rejected', 'r', $3)`,
        [A.tenant, draft, decidedBy]);
    expect((await dec(await newDraft(db), "owner", A.owner, A.staff))?.code).toBe("MB006"); // someone else's name
    expect((await dec(await newDraft(db), "staff", A.staff, A.staff))?.code).toBe("MB006"); // staff not listed for price.set
    expect(await dec(await newDraft(db), "owner", A.owner, A.owner)).toBeNull();
  });

  test("exec_txid cannot be forged to another txid", async () => {
    const draft = await newDraft(db);
    const e = await attempt(db, "munim_core", { tenant_id: A.tenant, outlet_ids: "*" },
      `UPDATE core.draft SET status = 'executing', exec_txid = txid_current() + 1 WHERE tenant_id = $1 AND id = $2`, [A.tenant, draft]);
    expect(e?.code).toBe("MB004");
  });
});

describe("branch 3 — allow-listed derivation of an existing book row", () => {
  const moveSql = `INSERT INTO core.stock_movement (tenant_id, id, outlet_id, ingredient_id, qty_milli, unit, kind, ref_type, ref_id)
                   VALUES ($1, gen_random_uuid(), $2, $3, -150000, 'g', 'sale_consumption', 'core.order', $4) RETURNING origin`;
  const ctx = (rule: string, source: string): AppContext => ({ tenant_id: A.tenant, outlet_ids: "*", posting_rule: rule, source_ref: source });

  test("inventory.consume_order from an existing order → accepted, origin = derivation", async () => {
    const r = await db.withContext("munim_core", ctx("inventory.consume_order", `core.order:${A.orders[0]}`), (c) =>
      c.query(moveSql, [A.tenant, A.outlets[0], A.ingredient, A.orders[0]]));
    expect(r.rows[0].origin).toEqual({ kind: "derivation", rule_id: "inventory.consume_order", source_ref: `core.order:${A.orders[0]}` });
  });

  const refusals: [string, () => [string, string]][] = [
    ["unlisted rule, existing source", () => ["inventory.made_up", `core.order:${A.orders[0]}`]],
    ["listed rule, source row does not exist", () => ["inventory.consume_order", `core.order:${randomUUID()}`]],
    ["listed rule, wrong source table", () => ["inventory.consume_order", `core.item:${A.item}`]],
    ["source_ref text is never used as a table name", () => ["inventory.consume_order", `core.order"; SELECT 1; --:${A.orders[0]}`]],
  ];
  for (const [name, args] of refusals) {
    test(`refused: ${name}`, async () => {
      const [rule, source] = args();
      const e = await attempt(db, "munim_core", ctx(rule, source), moveSql, [A.tenant, A.outlets[0], A.ingredient, A.orders[0]]);
      expect(e?.code).toBe("MB001");
    });
  }

  test("listed rule but a different target table (waste_log) → MB001", async () => {
    const e = await attempt(db, "munim_core", ctx("inventory.consume_order", `core.order:${A.orders[0]}`),
      `INSERT INTO core.waste_log (tenant_id, id, outlet_id, ingredient_id, qty_milli, unit, reason, recorded_by)
       VALUES ($1, gen_random_uuid(), $2, $3, 1, 'g', 'overprep', $4)`, [A.tenant, A.outlets[0], A.ingredient, A.owner]);
    expect(e?.code).toBe("MB001");
  });

  test("every derivation rule names existing book tables", async () => {
    const tag = (col: string) => `(SELECT obj_description(c.oid, 'pg_class') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                                    WHERE n.nspname = split_part(${col}, '.', 1) AND c.relname = split_part(${col}, '.', 2))`;
    const r = await db.admin(`SELECT rule_id, source_table, target_table, ${tag("source_table")} AS s, ${tag("target_table")} AS t
                                FROM core.derivation_rule`);
    // Hand-written from 0005 (consume), 0008 (posting, payable, stock derivations) and 0011 (loyalty).
    const rules: [string, string, string][] = [
      ["customers.loyalty_earn", "core.order", "core.loyalty_entry"],
      ["customers.loyalty_reverse", "core.order", "core.loyalty_entry"],
      ["finance.post_grn", "core.goods_received", "core.journal_entry"],
      ["finance.post_grn", "core.goods_received", "core.posting"],
      ["finance.post_order", "core.order", "core.journal_entry"],
      ["finance.post_order", "core.order", "core.posting"],
      ["finance.post_settlement", "core.settlement", "core.journal_entry"],
      ["finance.post_settlement", "core.settlement", "core.posting"],
      ["finance.post_supplier_invoice", "core.supplier_invoice", "core.journal_entry"],
      ["finance.post_supplier_invoice", "core.supplier_invoice", "core.posting"],
      ["finance.post_tender", "core.tender", "core.journal_entry"],
      ["finance.post_tender", "core.tender", "core.posting"],
      ["inventory.consume_order", "core.order", "core.stock_movement"],
      ["inventory.consume_sku", "core.order", "core.stock_movement"],
      ["inventory.receive_grn", "core.goods_received", "core.stock_movement"],
      ["inventory.record_waste", "core.waste_log", "core.stock_movement"],
      ["inventory.sale_return", "core.sale_return", "core.stock_movement"],
      ["inventory.supplier_return", "core.supplier_return", "core.stock_movement"],
      ["inventory.transfer_in", "core.transfer", "core.stock_movement"],
      ["inventory.transfer_out", "core.transfer", "core.stock_movement"],
      ["purchasing.payable_from_invoice", "core.supplier_invoice", "core.payable"],
      // 0014: posting rules for refunds, expenses, payroll (#24); pricing (F3); reconciliation (#22)
      ["finance.post_expense", "core.expense", "core.journal_entry"],
      ["finance.post_expense", "core.expense", "core.posting"],
      ["finance.post_payroll", "core.payroll_draft", "core.journal_entry"],
      ["finance.post_payroll", "core.payroll_draft", "core.posting"],
      ["finance.post_refund", "core.refund", "core.journal_entry"],
      ["finance.post_refund", "core.refund", "core.posting"],
      ["finance.reconcile_bank", "core.bank_line", "core.reconciliation_break"],
      ["finance.reconcile_order", "core.order", "core.reconciliation_break"],
      ["finance.reconcile_settlement", "core.settlement", "core.reconciliation_break"],
      ["orders.reprice", "core.order", "core.order"],
      // 0015: W2-R6 stock reversal; transfer_in batch; reversal and advance posting rules; line repricing; R41 merge
      ["inventory.reverse_order_consumption", "core.order", "core.stock_movement"],
      ["inventory.transfer_in", "core.transfer", "core.batch"],
      ["finance.reverse_supplier_invoice", "core.supplier_invoice", "core.journal_entry"],
      ["finance.reverse_supplier_invoice", "core.supplier_invoice", "core.posting"],
      ["finance.reverse_payroll", "core.payroll_draft", "core.journal_entry"],
      ["finance.reverse_payroll", "core.payroll_draft", "core.posting"],
      ["finance.post_advance", "core.advance", "core.journal_entry"],
      ["finance.post_advance", "core.advance", "core.posting"],
      ["orders.reprice", "core.order", "core.order_line"],
      ["customers.merge_verified_email", "core.customer", "core.order"],
      ["customers.merge_verified_email", "core.customer", "core.reservation"],
      ["customers.merge_verified_email", "core.customer", "core.bulk_order"],
      ["customers.merge_verified_email", "core.customer", "core.customer"],
      // 0016: loyalty reversal by refund; redemption posting; merge moves coupon uses; erasure of merged guests
      ["customers.loyalty_reverse", "core.refund", "core.loyalty_entry"],
      ["finance.post_loyalty_redemption", "core.order", "core.journal_entry"],
      ["finance.post_loyalty_redemption", "core.order", "core.posting"],
      ["customers.merge_verified_email", "core.customer", "core.coupon_use"],
      ["customers.erase_merged_guests", "core.customer", "core.customer"],
      // 0017: coupon discount follows a re-price (R2-S3-7); the guest-token claim (C1)
      ["orders.reprice", "core.order", "core.coupon_use"],
      ["customers.claim_guest_token", "core.customer", "core.order"],
      ["customers.claim_guest_token", "core.customer", "core.coupon_use"],
      ["customers.claim_guest_token", "core.customer", "core.customer"],
      // 0021 (T-093): a submitted stock count's adjustment movements
      ["inventory.count_adjust", "core.stock_count", "core.stock_movement"],
      // 0028 (ADR-015 §1.4): Munim Cares hand-overs, their voids, and a received B2B claim
      ["inventory.cares_handover", "core.cares_handover", "core.stock_movement"],
      ["inventory.cares_handover_void", "core.cares_handover", "core.stock_movement"],
      ["inventory.cares_claim_receive", "core.cares_claim", "core.stock_movement"],
      ["inventory.cares_claim_receive", "core.cares_claim", "core.batch"],
    ];
    const got = r.rows.map((x) => [x.rule_id, x.source_table, x.target_table, x.s, x.t]).sort((a, b) => a.join().localeCompare(b.join()));
    expect(got).toEqual(rules.map(([a, b, c]) => [a, b, c, "munim:book", "munim:book"]).sort((a, b) => a.join().localeCompare(b.join())));
  });
});

describe("book guard red-proof", () => {
  test("DROP TRIGGER book_guard ON core.deal → the context-free write succeeds → gate red", async () => {
    const x = await db.clone();
    try {
      await x.admin("DROP TRIGGER book_guard ON core.deal");
      const r = await noContextSweep(x, A.tenant);
      console.log(`RED-PROOF book guard: ${r.refused}/${r.tables} refused; failures:`, r.failures);
      expect(r.refused).toBe(EXPECTED_COUNTS.book - 1);
      expect(r.failures.length).toBe(1);
      expect(r.failures[0]).toMatch(/^core\.deal: 23502/);
    } finally {
      await x.stop();
    }
  });
});
