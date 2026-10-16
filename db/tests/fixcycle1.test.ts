// Gates for W1 fix cycle 1 (0014; docs/plan/W1-FIX-LIST.md). Each item: refusal paired with an accepted case,
// and a red-proof on a clone. Item numbers in the describe titles.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { AppContext, TestDb } from "../src/harness.ts";
import { openDb } from "./db.ts";
import { attempt } from "./gates.ts";
import { CUSTOMER_OPEN, CUSTOMER_OWN, CUSTOMER_PUBLIC, CUSTOMER_PUBLISHED, CUSTOMER_VIA_ORDER, CUSTOMER_CODE, TENANT_TABLES } from "./manifest.ts";
import { buildWorld, ownerCtx, uuidv7, type World } from "./world.ts";

let db: TestDb;
let A: World;
let manager = "";

beforeAll(async () => {
  db = await openDb();
  A = await buildWorld(db);
  // A manager whose membership covers outlet 1 only.
  manager = uuidv7();
  await db.withContext("munim_core", ownerCtx(A, { command_type: "tenancy.member.invite.v1" }), async (c) => {
    await c.query(`INSERT INTO core.member (tenant_id, id, name, email) VALUES ($1, $2, 'Manager One', 'm1@example.test')`, [A.tenant, manager]);
    await c.query(`INSERT INTO core.membership (tenant_id, member_id, role, outlet_ids) VALUES ($1, $2, 'manager', $3)`, [A.tenant, manager, [A.outlets[0]]]);
  });
});
afterAll(async () => db?.stop());

const mgr = (command_type: string, extra: AppContext = {}): AppContext =>
  ({ tenant_id: A.tenant, outlet_ids: [A.outlets[0]], role: "manager", member_id: manager, command_type, ...extra });
// Shoppers get app.outlet_ids = '{}' (0014 ruling): RLS and the guard govern them by ownership, not outlet.
const cust = (customer: string, command_type: string, extra: AppContext = {}): AppContext =>
  ({ tenant_id: A.tenant, outlet_ids: [], role: "customer", customer_id: customer, command_type, ...extra });
const sha = (s: string) => createHash("sha256").update(s).digest();
const vpa = (outlet: string, v: string, ctx: AppContext, x = db) =>
  attempt(x, "munim_core", ctx, "UPDATE core.outlet SET upi_vpa = $3 WHERE tenant_id = $1 AND id = $2", [A.tenant, outlet, v]);

describe("#28 F1 — guard outlet scope for every book table, both branches", () => {
  test("manager scoped to outlet 1: outlet 2's upi_vpa → MB001; outlet 1's → accepted (core.outlet: own id)", async () => {
    const other = await vpa(A.outlets[1], "two@okbank", mgr("tenancy.outlet.update.v1"));
    const own = await vpa(A.outlets[0], "one@okbank", mgr("tenancy.outlet.update.v1"));
    console.log(`F1 outlet row: other outlet → ${other?.code} (${other?.message}); own → ${own ? own.code : "accepted"}`);
    expect(other?.code).toBe("MB001");
    expect(own).toBeNull();
  });

  test("line table: a po_line on a PO for outlet 2 → MB001; on a PO for outlet 1 → accepted (parent outlet set)", async () => {
    const po = async (outlet: string) => {
      const id = uuidv7();
      await db.withContext("munim_core", ownerCtx(A, { command_type: "purchasing.po.create.v1" }), (c) =>
        c.query(`INSERT INTO core.purchase_order (tenant_id, id, supplier_id, outlet_ids, currency, total_minor) VALUES ($1, $2, $3, $4, 'INR', 0)`, [A.tenant, id, A.supplier, [outlet]]));
      return id;
    };
    const line = (p: string) => attempt(db, "munim_core", mgr("purchasing.po.create.v1"),
      `INSERT INTO core.po_line (tenant_id, id, po_id, line_no, ingredient_id, qty_milli, unit, unit_price_minor) VALUES ($1, gen_random_uuid(), $2, 1, $3, 1000, 'kg', 100)`,
      [A.tenant, p, A.ingredient]);
    const other = await line(await po(A.outlets[1]));
    const own = await line(await po(A.outlets[0]));
    console.log(`F1 line table: other outlet's PO → ${other?.code}; own → ${own ? own.code : "accepted"}`);
    expect(other?.code).toBe("MB001");
    expect(own).toBeNull();
  });

  test("transfer needs both ends; a tenant-wide row (outlet NULL) needs '{*}'", async () => {
    const tr = (ctx: AppContext) => attempt(db, "munim_core", ctx,
      `INSERT INTO core.transfer (tenant_id, id, from_outlet_id, to_outlet_id, sent_by) VALUES ($1, gen_random_uuid(), $2, $3, $4)`,
      [A.tenant, A.outlets[0], A.outlets[1], A.owner]);
    expect((await tr(mgr("inventory.transfer.create.v1")))?.code).toBe("MB001");
    expect(await tr(ownerCtx(A, { command_type: "inventory.transfer.create.v1" }))).toBeNull();
    const exp = (outlet: string | null) => attempt(db, "munim_core", mgr("finance.expense.record.v1"),
      `INSERT INTO core.expense (tenant_id, id, outlet_id, category, incurred_on, amount_minor, currency, payee) VALUES ($1, gen_random_uuid(), $2, 'other', '2026-10-09', 100, 'INR', 'X')`,
      [A.tenant, outlet]);
    expect((await exp(null))?.code).toBe("MB001");
    expect(await exp(A.outlets[0])).toBeNull();
  });

  test("decision branch: the manager approving a price draft for outlet 2 → MB001; for outlet 1 → accepted", async () => {
    const run = async (outlet: string) => {
      const draft = uuidv7();
      await db.withContext("munim_svc", { tenant_id: A.tenant, outlet_ids: "*" }, (c) =>
        c.query(`INSERT INTO core.draft (tenant_id, id, outlet_ids, source, command_type, command_payload) VALUES ($1, $2, $3, 'member', 'catalogue.price.set.v1', '{}')`,
          [A.tenant, draft, [A.outlets[0]]]));
      return db.withContext("munim_core", { tenant_id: A.tenant, outlet_ids: [A.outlets[0]], role: "manager", member_id: manager }, async (c) => {
        await c.query(`UPDATE core.draft SET status = 'executing', exec_txid = txid_current() WHERE tenant_id = $1 AND id = $2`, [A.tenant, draft]);
        const d = uuidv7();
        await c.query(`INSERT INTO core.decision (tenant_id, id, draft_id, verdict, final_payload, decided_by) VALUES ($1, $2, $3, 'approved', '{}', $4)`, [A.tenant, d, draft, manager]);
        await c.query("SELECT set_config('app.decision_id', $1, true)", [d]);
        await c.query(`INSERT INTO core.price (tenant_id, id, item_id, outlet_id, channel_kind, amount_minor, currency, tax_class, valid_from, valid_to)
                       VALUES ($1, gen_random_uuid(), $2, $3, 'own_site', 100, 'INR', 'restaurant_5', '2042-01-01', '2042-01-02')`, [A.tenant, A.item, outlet]);
      }).then(() => null, (e: { code: string }) => e);
    };
    const other = await run(A.outlets[1]);
    const own = await run(A.outlets[0]);
    console.log(`F1 decision branch: outlet 2 → ${other?.code}; outlet 1 → ${own ? own.code : "accepted"}`);
    expect(other?.code).toBe("MB001");
    expect(own).toBeNull();
  });

  test("RED-PROOF: book_row_in_scope always true → the manager updates outlet 2's upi_vpa", async () => {
    const x = await db.clone();
    try {
      await x.admin(`CREATE OR REPLACE FUNCTION core.book_row_in_scope(target text, tenant uuid, r jsonb, scope text, role text, outlet_ids text)
                     RETURNS boolean LANGUAGE sql STABLE AS 'SELECT true'`);
      const e = await vpa(A.outlets[1], "two@okbank", mgr("tenancy.outlet.update.v1"), x);
      console.log("RED-PROOF F1:", e);
      expect(e).toBeNull();
    } finally {
      await x.stop();
    }
  });
});

describe("#29 F2 / #48 — customer writes: own rows only, customer-safe tables only, no wildcard", () => {
  const placeAs = (customer: string, ctx: AppContext, x = db, extra = "") => attempt(x, "munim_core", ctx,
    `INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, kind, subtotal_minor, total_minor, currency, pricing_snapshot, customer_id${extra ? ", guest_access_hash" : ""})
     VALUES ($1, $2, $3, $4, 'pickup', 100, 100, 'INR', '{}', $5${extra ? ", $6" : ""})`,
    extra ? [A.tenant, uuidv7(), A.outlets[0], A.channel, customer, Buffer.from(extra, "hex")] : [A.tenant, uuidv7(), A.outlets[0], A.channel, customer]);
  const newCustomer = async () => {
    const id = uuidv7();
    await db.withContext("munim_core", cust(id, "storefront.guest.create.v1"), (c) =>
      c.query(`INSERT INTO core.customer (tenant_id, id, name) VALUES ($1, $2, 'Shopper')`, [A.tenant, id]));
    return id;
  };

  test("a customer places its own order (accepted); for someone else → MB001; under '{*}' → MB001", async () => {
    const me = await newCustomer();
    expect(await placeAs(me, cust(me, "orders.place.v1"))).toBeNull();
    expect((await placeAs(A.customer, cust(me, "orders.place.v1")))?.code).toBe("MB001");
    expect((await placeAs(me, cust(me, "orders.place.v1", { outlet_ids: "*" })))?.code).toBe("MB001");
  });

  test("a customer tender (on its own or another's order) → MB001; the cashier's → accepted", async () => {
    const tender = (ctx: AppContext) => attempt(db, "munim_core", ctx,
      `INSERT INTO core.tender (tenant_id, id, outlet_id, order_id, method, amount_minor, currency, recorded_by) VALUES ($1, gen_random_uuid(), $2, $3, 'upi', 100, 'INR', $4)`,
      [A.tenant, A.outlets[0], A.orders[0], A.owner]);
    const byCustomer = await tender(cust(A.customer, "orders.place.v1"));
    const byOther = await tender(cust(await newCustomer(), "orders.place.v1"));
    console.log(`F2 tender: own customer → ${byCustomer?.code} (${byCustomer?.message}); other customer → ${byOther?.code}`);
    expect(byCustomer?.code).toBe("MB001");
    expect(byOther?.code).toBe("MB001");
    expect(await tender(ownerCtx(A, { command_type: "orders.tender.record.v1" }))).toBeNull();
  });

  test("nulling an order's customer_id: own order → MB001; another's order is not even visible (0 rows)", async () => {
    const own = await attempt(db, "munim_core", cust(A.customer, "customers.account.link.v1"),
      `UPDATE core."order" SET customer_id = NULL WHERE tenant_id = $1 AND id = $2`, [A.tenant, A.orders[0]]);
    expect(own?.code).toBe("MB001");
    const other = await db.withContext("munim_core", cust(await newCustomer(), "customers.account.link.v1"), (c) =>
      c.query(`UPDATE core."order" SET customer_id = NULL WHERE tenant_id = $1 AND id = $2`, [A.tenant, A.orders[0]]));
    expect(other.rowCount).toBe(0);
  });

  test("#48 guest order claimed by token: with the token's hash → accepted (customer_id = me); without → 0 rows", async () => {
    const guest = await newCustomer();
    const token = randomUUID();
    expect(await placeAs(guest, cust(guest, "orders.place.v1"), db, sha(token).toString("hex"))).toBeNull();
    const me = await newCustomer();
    const claim = (hash?: string) => db.withContext("munim_core", cust(me, "customers.account.link.v1", hash ? { guest_access_hash: hash } : {}), (c) =>
      c.query(`UPDATE core."order" SET customer_id = $2 WHERE tenant_id = $1 AND guest_access_hash IS NOT NULL AND customer_id = $3`, [A.tenant, me, guest]));
    expect((await claim()).rowCount).toBe(0);
    expect((await claim(sha("wrong").toString("hex"))).rowCount).toBe(0);
    const r = await claim(sha(token).toString("hex"));
    console.log(`#48 guest claim with token: ${r.rowCount} order claimed`);
    expect(r.rowCount).toBe(1);
  });

  test("RED-PROOF: with the order's customer_scope dropped the guard alone still refuses another's order; with ownership forced true it is accepted", async () => {
    const x = await db.clone();
    try {
      await x.admin(`DROP POLICY customer_scope ON core."order"`);
      const other = randomUUID();
      const stillRefused = await attempt(x, "munim_core", cust(other, "customers.account.link.v1"),
        `UPDATE core."order" SET customer_id = NULL WHERE tenant_id = $1 AND id = $2`, [A.tenant, A.orders[0]]);
      expect(stillRefused?.code).toBe("MB001");
      await x.admin(`CREATE OR REPLACE FUNCTION core.book_row_customer_owned(target text, tenant uuid, r jsonb, principal uuid, guest bytea, strict boolean)
                     RETURNS boolean LANGUAGE sql STABLE AS 'SELECT true'`);
      const e = await attempt(x, "munim_core", cust(other, "customers.account.link.v1"),
        `UPDATE core."order" SET customer_id = NULL WHERE tenant_id = $1 AND id = $2`, [A.tenant, A.orders[0]]);
      console.log("RED-PROOF F2: guard alone →", stillRefused?.code, "; ownership forced →", e);
      expect(e).toBeNull();
    } finally {
      await x.stop();
    }
  });
});

describe("#30 F3 — order money frozen after placement; origin not re-stamped", () => {
  test("kitchen.ticket.advance.v1 setting total_minor → MB001; a status change → accepted with origin unchanged", async () => {
    const before = (await db.admin(`SELECT origin FROM core."order" WHERE id = $1`, [A.orders[1]])).rows[0]!.origin;
    const money = await attempt(db, "munim_core", ownerCtx(A, { command_type: "kitchen.ticket.advance.v1" }),
      `UPDATE core."order" SET subtotal_minor = 1, total_minor = 1601 WHERE tenant_id = $1 AND id = $2`, [A.tenant, A.orders[1]]);
    const status = await attempt(db, "munim_core", ownerCtx(A, { command_type: "kitchen.ticket.advance.v1" }),
      `UPDATE core."order" SET status = 'accepted' WHERE tenant_id = $1 AND id = $2`, [A.tenant, A.orders[1]]);
    const after = (await db.admin(`SELECT origin FROM core."order" WHERE id = $1`, [A.orders[1]])).rows[0]!.origin;
    console.log(`F3: money via kitchen command → ${money?.code}; status → ${status ? status.code : "accepted"}; origin kept: ${JSON.stringify(after) === JSON.stringify(before)}`);
    expect(money?.code).toBe("MB001");
    expect(status).toBeNull();
    expect(after).toEqual(before);
    expect(before).toMatchObject({ kind: "command", command_type: "orders.place.v1" });
  });

  // 0017 (O1): origin is creation provenance, never re-stamped — the re-price keeps the placement origin.
  test("orders.reprice on an accepted order → accepted, origin kept; on a completed order → MB001 (source state)", async () => {
    const reprice = (order: string) => db.withContext("munim_core",
      { tenant_id: A.tenant, outlet_ids: "*", posting_rule: "orders.reprice", source_ref: `core.order:${order}` }, (c) =>
        c.query(`UPDATE core."order" SET discount_minor = 1600, total_minor = 32000 WHERE tenant_id = $1 AND id = $2 RETURNING origin`, [A.tenant, order]))
      .then((r) => r.rows[0]!.origin, (e: { code: string }) => e);
    const before = (await db.admin(`SELECT origin FROM core."order" WHERE id = $1`, [A.orders[1]])).rows[0]!.origin;
    expect(before).toMatchObject({ kind: "command", command_type: "orders.place.v1" });
    expect(await reprice(A.orders[1])).toEqual(before);
    for (const to of ["preparing", "ready", "completed"]) {
      await db.withContext("munim_core", ownerCtx(A, { command_type: "kitchen.ticket.advance.v1" }), (c) =>
        c.query(`UPDATE core."order" SET status = $3 WHERE tenant_id = $1 AND id = $2`, [A.tenant, A.orders[1], to]));
    }
    expect(await reprice(A.orders[1])).toMatchObject({ code: "MB001" });
  });

  test("RED-PROOF: drop pricing_frozen → the kitchen command rewrites the total", async () => {
    const x = await db.clone();
    try {
      await x.admin(`DROP TRIGGER pricing_frozen ON core."order"`);
      const e = await attempt(x, "munim_core", ownerCtx(A, { command_type: "kitchen.ticket.advance.v1" }),
        `UPDATE core."order" SET subtotal_minor = 1, total_minor = 1601 WHERE tenant_id = $1 AND id = $2`, [A.tenant, A.orders[0]]);
      console.log("RED-PROOF F3:", e);
      expect(e).toBeNull();
    } finally {
      await x.stop();
    }
  });
});

/** Rows of every tenant table visible to the world's customer (outlet 1 storefront context). */
async function customerProbe(x: TestDb): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  await x.withContext("munim_core", cust(A.customer, "customers.data.export.v1", { coupon_codes: "{WELCOME10}" }), async (c) => {
    for (const t of TENANT_TABLES) out[t] = (await c.query(`SELECT count(*)::int n FROM ${t.split(".").map((p) => `"${p}"`).join(".")}`)).rows[0].n;
  });
  return out;
}

describe("#31 F4 — customer RLS", () => {
  test("a customer sees own rows, the public catalogue and presented codes; 0 rows everywhere else", async () => {
    const seen = await customerProbe(db);
    // 0034: the world publishes its storefront page, so the shopper reads that one version (CUSTOMER_PUBLISHED).
    const reachable = [...CUSTOMER_OWN, ...CUSTOMER_VIA_ORDER, ...CUSTOMER_PUBLIC, ...CUSTOMER_CODE, ...CUSTOMER_OPEN, ...CUSTOMER_PUBLISHED];
    const leaked = Object.entries(seen).filter(([t, n]) => !reachable.includes(t) && n > 0);
    console.log(`F4 probe: ${Object.values(seen).filter((n) => n === 0).length}/${TENANT_TABLES.length} tables show 0 rows; journal ${seen["core.journal_entry"]}, member ${seen["core.member"]}, audit ${seen["core.audit_log"]}, outbox ${seen["core.outbox"]}, draft ${seen["core.draft"]}, finding ${seen["intel.finding"]}, snapshot ${seen["evidence.snapshot"]}; own orders ${seen["core.order"]}, coupons ${seen["core.coupon"]}`);
    expect(leaked).toEqual([]);
    for (const t of ["core.journal_entry", "core.member", "core.audit_log", "core.outbox", "core.draft", "intel.finding", "evidence.snapshot"]) expect(seen[t]).toBe(0);
    expect(seen["core.customer"]).toBe(1);
    expect(seen["core.order"]).toBe(2); // both of the world customer's orders (outlets 1 and 2): no outlet scope for shoppers
    expect(seen["core.coupon"]).toBe(1);
    expect(seen["core.price"]).toBeGreaterThan(0);
    expect([seen["core.storefront_page_publish"], seen["core.storefront_page_version"]]).toEqual([1, 1]);
    const own = await db.withContext("munim_core", cust(A.customer, "customers.data.export.v1"), (c) =>
      c.query(`SELECT DISTINCT customer_id FROM core."order" UNION SELECT DISTINCT customer_id FROM core.loyalty_entry`));
    expect(own.rows.map((r) => r.customer_id)).toEqual([A.customer]);
  });

  test("without a presented code a customer sees no coupon", async () => {
    const r = await db.withContext("munim_core", cust(A.customer, "customers.data.export.v1"), (c) => c.query("SELECT count(*)::int n FROM core.coupon"));
    expect(r.rows[0].n).toBe(0);
  });

  test("RED-PROOF: drop customer_scope on core.journal_entry → the customer sees the journal", async () => {
    const x = await db.clone();
    try {
      await x.admin("DROP POLICY customer_scope ON core.journal_entry");
      const seen = await customerProbe(x);
      console.log("RED-PROOF F4: journal rows visible to a customer:", seen["core.journal_entry"]);
      expect(seen["core.journal_entry"]).toBeGreaterThan(0);
    } finally {
      await x.stop();
    }
  });
});

describe("#37 — intel runs and traces by outlet scope", () => {
  let scoped = "";
  beforeAll(async () => {
    scoped = uuidv7();
    await db.withContext("munim_svc", { tenant_id: A.tenant, outlet_ids: "*" }, async (c) => {
      await c.query(`INSERT INTO intel.run (tenant_id, id, trigger, actor, outlet_scope, expires_at) VALUES ($1, $2, 'ask', 'brief', $3, now() + interval '15 minutes')`, [A.tenant, scoped, [A.outlets[0]]]);
      await c.query(`INSERT INTO intel.trace_event (tenant_id, run_id, seq, id, kind, actor, payload, at) VALUES ($1, $2, 1, gen_random_uuid(), 'route', 'router', '{}', now())`, [A.tenant, scoped]);
    });
  });
  const see = (x: TestDb, ctx: AppContext) => x.withContext("munim_core", ctx, async (c) => ({
    runs: (await c.query("SELECT id FROM intel.run ORDER BY id")).rows.map((r) => r.id as string),
    traces: (await c.query("SELECT DISTINCT run_id FROM intel.trace_event")).rows.map((r) => r.run_id as string),
  }));

  test("outlet-1 staff: the outlet-1 run and its trace only, not the '{*}' run; a '{*}' manager: not the '{*}' run; owner: both", async () => {
    const staff = await see(db, { tenant_id: A.tenant, outlet_ids: [A.outlets[0]], role: "staff", member_id: A.staff });
    const wideManager = await see(db, { tenant_id: A.tenant, outlet_ids: "*", role: "manager", member_id: manager });
    const owner = await see(db, { tenant_id: A.tenant, outlet_ids: "*", role: "owner", member_id: A.owner });
    console.log(`#37: staff runs ${staff.runs.length} (traces ${staff.traces.length}); '{*}' manager runs ${wideManager.runs.includes(A.run) ? "incl." : "excl."} the '{*}' run; owner runs ${owner.runs.length}`);
    expect(staff.runs).toEqual([scoped]);
    expect(staff.traces).toEqual([scoped]);
    expect(wideManager.runs).not.toContain(A.run);
    expect(owner.runs).toContain(A.run);
    expect(owner.runs).toContain(scoped);
  });

  test("RED-PROOF: the 0003 tenant-only policy on intel.run and trace_event → staff sees the '{*}' run's trace", async () => {
    const x = await db.clone();
    try {
      await x.admin(`ALTER POLICY tenant_run_scope ON intel.run USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))`);
      const staff = await see(x, { tenant_id: A.tenant, outlet_ids: [A.outlets[0]], role: "staff", member_id: A.staff });
      console.log("RED-PROOF #37: staff sees runs", staff.runs.length, "traces", staff.traces.length);
      expect(staff.traces).toContain(A.run);
    } finally {
      await x.stop();
    }
  });
});

describe("#21 — derivation source state (supplier invoice must be approved)", () => {
  const post = (x: TestDb, invoice: string) => attempt(x, "munim_core",
    { tenant_id: A.tenant, outlet_ids: "*", posting_rule: "purchasing.payable_from_invoice", source_ref: `core.supplier_invoice:${invoice}` },
    `INSERT INTO core.payable (tenant_id, id, supplier_id, source_type, source_id, due_on, amount_minor, currency)
     VALUES ($1, gen_random_uuid(), $2, 'core.supplier_invoice', $3, '2026-11-01', 100, 'INR')`, [A.tenant, A.supplier, invoice]);

  test("a recorded invoice → MB001; after purchasing.invoice.approve.v1 → accepted", async () => {
    const inv = uuidv7();
    await db.withContext("munim_core", ownerCtx(A, { command_type: "purchasing.invoice.record.v1" }), (c) =>
      c.query(`INSERT INTO core.supplier_invoice (tenant_id, id, supplier_id, invoice_no, invoice_date, subtotal_minor, total_minor, currency)
               VALUES ($1, $2, $3, $4, '2026-10-09', 100, 100, 'INR')`, [A.tenant, inv, A.supplier, `INV-${inv.slice(0, 8)}`]));
    const recorded = await post(db, inv);
    await db.withContext("munim_core", ownerCtx(A, { command_type: "purchasing.invoice.approve.v1" }), (c) =>
      c.query(`UPDATE core.supplier_invoice SET status = 'approved' WHERE tenant_id = $1 AND id = $2`, [A.tenant, inv]));
    const approved = await post(db, inv);
    console.log(`#21: payable from a recorded invoice → ${recorded?.code}; approved → ${approved ? approved.code : "accepted"}`);
    expect(recorded?.code).toBe("MB001");
    expect(approved).toBeNull();
  });
});

describe("#22 — operational money tables tied to their path", () => {
  test("reconciliation_break and viability_case are books: a context-free write → MB001; under their command → accepted", async () => {
    const brk = (ctx: AppContext) => attempt(db, "munim_core", ctx,
      `INSERT INTO core.reconciliation_break (tenant_id, id, kind, amount_minor, currency) VALUES ($1, gen_random_uuid(), 'other', 1, 'INR')`, [A.tenant]);
    expect((await brk({ tenant_id: A.tenant, outlet_ids: "*" }))?.code).toBe("MB001");
    expect(await brk(ownerCtx(A, { command_type: "finance.break.update.v1" }))).toBeNull();
    const vc = (ctx: AppContext) => attempt(db, "munim_core", ctx,
      `INSERT INTO core.viability_case (tenant_id, id, name, outlet_kind, currency) VALUES ($1, gen_random_uuid(), 'Site', 'store', 'INR')`, [A.tenant]);
    expect((await vc({ tenant_id: A.tenant, outlet_ids: "*" }))?.code).toBe("MB001");
    expect(await vc(ownerCtx(A, { command_type: "market.viability_case.upsert.v1" }))).toBeNull();
  });

  test("market_signal outside an approved import → MB006 (inside one: the world's row)", async () => {
    const e = await attempt(db, "munim_core", ownerCtx(A),
      `INSERT INTO core.market_signal (tenant_id, id, on_date, kind, label, source, import_run_id)
       SELECT $1, gen_random_uuid(), '2026-11-01', 'weather', 'weather.rain', 'x', id FROM core.import_run WHERE tenant_id = $1 LIMIT 1`, [A.tenant]);
    expect(e?.code).toBe("MB006");
    expect((await db.admin("SELECT count(*)::int n FROM core.market_signal WHERE tenant_id = $1", [A.tenant])).rows[0]!.n).toBe(1);
  });

  // The world's run is committed since 0015 (its settlement posts only from a committed run): preview a fresh one.
  const previewedRun = async (x: TestDb) => {
    const id = uuidv7();
    await x.withContext("munim_svc", { tenant_id: A.tenant, outlet_ids: "*" }, async (c) => {
      await c.query(`INSERT INTO core.import_run (tenant_id, id, document_id, kind, parser)
        SELECT $1, $2, document_id, 'bank_statement', 'bank_csv_v1' FROM core.import_run WHERE tenant_id = $1 LIMIT 1`, [A.tenant, id]);
      await c.query(`UPDATE core.import_run SET status = 'previewed', rows_ok = 0, rows_quarantined = 0, control_total_minor = 0, currency = 'INR' WHERE id = $1`, [id]);
    });
    return id;
  };

  test("a previewed run: changing its control total → MB004; staging another row → MB004; a parsing run accepts rows", async () => {
    const svc = { tenant_id: A.tenant, outlet_ids: "*" as const };
    const previewed = await previewedRun(db);
    const ctl = await attempt(db, "munim_svc", svc, `UPDATE core.import_run SET control_total_minor = 1 WHERE tenant_id = $1 AND id = $2`, [A.tenant, previewed]);
    const stage = (run: string) => attempt(db, "munim_svc", svc,
      `INSERT INTO core.import_staging (tenant_id, id, import_run_id, row_no, target_table, data) VALUES ($1, gen_random_uuid(), $2, 99, 'core.bank_line', '{}')`, [A.tenant, run]);
    const late = await stage(previewed);
    const parsing = uuidv7();
    await db.withContext("munim_svc", svc, (c) => c.query(`INSERT INTO core.import_run (tenant_id, id, document_id, kind, parser)
      SELECT $1, $2, document_id, 'bank_statement', 'bank_csv_v1' FROM core.import_run WHERE tenant_id = $1 LIMIT 1`, [A.tenant, parsing]));
    console.log(`#22 imports: control total after preview → ${ctl?.code}; late staging → ${late?.code}`);
    expect(ctl?.code).toBe("MB004");
    expect(late?.code).toBe("MB004");
    expect(await stage(parsing)).toBeNull();
  });

  test("RED-PROOF: drop while_parsing → a row is staged into the previewed run", async () => {
    const x = await db.clone();
    try {
      await x.admin("DROP TRIGGER while_parsing ON core.import_staging");
      const previewed = await previewedRun(x);
      const e = await attempt(x, "munim_svc", { tenant_id: A.tenant, outlet_ids: "*" },
        `INSERT INTO core.import_staging (tenant_id, id, import_run_id, row_no, target_table, data) VALUES ($1, gen_random_uuid(), $2, 98, 'core.bank_line', '{}')`, [A.tenant, previewed]);
      console.log("RED-PROOF #22 staging:", e);
      expect(e).toBeNull();
    } finally {
      await x.stop();
    }
  });
});

describe("#23 — book status transitions", () => {
  const campaign = (x: TestDb, to: string) => attempt(x, "munim_core", ownerCtx(A, { command_type: "customers.campaign.cancel.v1" }),
    `UPDATE core.campaign SET status = $2 WHERE tenant_id = $1`, [A.tenant, to]);

  test("campaign queued → cancelled accepted; cancelled → queued → MB004", async () => {
    expect(await campaign(db, "cancelled")).toBeNull();
    const back = await campaign(db, "queued");
    console.log(`#23: campaign cancelled → queued → ${back?.code}`);
    expect(back?.code).toBe("MB004");
  });

  test("the transition table holds the 71 hand-listed pairs over 21 tables (+ 0028's 10 Cares pairs over 4)", async () => {
    const r = await db.admin("SELECT count(*)::int n, count(DISTINCT table_name)::int t FROM core.book_status_transition");
    expect(r.rows[0]).toEqual({ n: 71 + 10, t: 21 + 4 });
  });

  test("RED-PROOF: drop status_transition on core.campaign → cancelled → queued accepted", async () => {
    const x = await db.clone();
    try {
      await x.admin("DROP TRIGGER status_transition ON core.campaign");
      expect(await campaign(x, "cancelled")).toBeNull();
      const e = await campaign(x, "queued");
      console.log("RED-PROOF #23:", e);
      expect(e).toBeNull();
      const cat = await x.admin("SELECT munim_meta.assert_catalog('gate')").then(() => null, (err: Error) => err.message);
      expect(cat).toMatch(/book status columns without a transition trigger: campaign/);
    } finally {
      await x.stop();
    }
  });
});

describe("#49 — expired-sale override issued before placement, consumed at placement", () => {
  test("issue against a cart line (no line yet) → accepted; placement consumes it; a second use → MB005; a mismatched line → 23514", async () => {
    const cart = uuidv7();
    const order = uuidv7();
    const override = uuidv7();
    await db.withContext("munim_core", mgr("inventory.expired_sale.override.v1"), (c) =>
      c.query(`INSERT INTO core.expired_sale_override (tenant_id, id, outlet_id, cart_line_id, batch_id, qty_milli, reason_code, note, decided_by)
               VALUES ($1, $2, $3, $4, $5, 1000, 'staff_meal', 'same day', $6)`, [A.tenant, override, A.outlets[0], cart, A.batches[0], manager]));
    const consume = (line: string) => attempt(db, "munim_core", ownerCtx(A, { command_type: "orders.place.v1" }),
      `UPDATE core.expired_sale_override SET used_at = now(), order_line_id = $3 WHERE tenant_id = $1 AND id = $2`, [A.tenant, override, line]);
    await db.withContext("munim_core", ownerCtx(A, { command_type: "orders.place.v1" }), async (c) => {
      await c.query(`INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, kind, subtotal_minor, total_minor, currency, pricing_snapshot)
                     VALUES ($1, $2, $3, $4, 'takeaway', 100, 100, 'INR', '{}')`, [A.tenant, order, A.outlets[0], A.channel]);
      await c.query(`INSERT INTO core.order_line (tenant_id, id, outlet_id, order_id, line_no, item_id, qty_milli, unit_price_minor)
                     VALUES ($1, $2, $3, $4, 1, $5, 1000, 100)`, [A.tenant, cart, A.outlets[0], order, A.item]);
    });
    expect((await consume(uuidv7()))?.code).toBe("23514");
    expect(await consume(cart)).toBeNull();
    const again = await consume(cart);
    console.log(`#49: issued before placement, consumed once; second use → ${again?.code}`);
    expect(again?.code).toBe("MB005");
  });
});

describe("#54 #55 #59 #60 #62 #17", () => {
  test("#54: the missing command types are seeded with bindings", async () => {
    const r = await db.admin(`SELECT command_type, target_tables FROM core.command_authority WHERE command_type = ANY ($1) ORDER BY 1`,
      [["orders.promise.push_back.v1", "catalogue.availability.set.v1", "demo.session.start.v1", "kitchen.prep_time.set.v1", "catalogue.deal.end.v1", "orders.void.record.v1", "orders.refund.record.v1"]]);
    expect(r.rows.map((x) => x.command_type)).toEqual(["catalogue.availability.set.v1", "catalogue.deal.end.v1", "demo.session.start.v1",
      "kitchen.prep_time.set.v1", "orders.promise.push_back.v1", "orders.refund.record.v1", "orders.void.record.v1"]);
    const link = await db.admin(`SELECT target_tables, customer_target_tables FROM core.command_authority WHERE command_type = 'customers.account.link.v1'`);
    expect(link.rows[0]!.customer_target_tables).toContain("core.order");
  });

  test("#55: core.derivation_rule equals db/derivation-rules.json", async () => {
    const doc = JSON.parse(readFileSync(new URL("../derivation-rules.json", import.meta.url), "utf8")) as
      { rules: { rule_id: string; source_table: string; target_tables: string[]; source_state: string }[] };
    const want = doc.rules.flatMap((r) => r.target_tables.map((t) => [r.rule_id, r.source_table, t, r.source_state].join(" | "))).sort();
    const got = (await db.admin("SELECT rule_id, source_table, target_table, source_state FROM core.derivation_rule"))
      .rows.map((r) => [r.rule_id, r.source_table, r.target_table, r.source_state].join(" | ")).sort();
    console.log(`#55 rule parity: ${got.length} DB rows, ${want.length} in derivation-rules.json`);
    expect(got).toEqual(want);
  });

  test("#59: rounding on a card tender → 23514; on cash → accepted", async () => {
    const t = (method: string) => attempt(db, "munim_core", ownerCtx(A, { command_type: "orders.tender.record.v1" }),
      `INSERT INTO core.tender (tenant_id, id, outlet_id, order_id, method, amount_minor, rounding_minor, currency, recorded_by) VALUES ($1, gen_random_uuid(), $2, $3, $4, 33600, 40, 'INR', $5)`,
      [A.tenant, A.outlets[0], A.orders[0], method, A.owner]);
    expect((await t("card"))?.code).toBe("23514");
    expect(await t("cash")).toBeNull();
  });

  test("#60: business_date = local date of (now − cutoff); a cutoff later than now puts a new order on the previous date with ticket 1", async () => {
    const tz = "Asia/Kolkata";
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date()).map((p) => [p.type, p.value]));
    const today = `${parts.year}-${parts.month}-${parts.day}`;
    const minutes = Number(parts.hour) * 60 + Number(parts.minute);
    const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const place = async (cutoff: string) => {
      await db.withContext("munim_core", ownerCtx(A, { command_type: "tenancy.outlet.update.v1" }), (c) =>
        c.query("UPDATE core.outlet SET business_day_cutoff = $3 WHERE tenant_id = $1 AND id = $2", [A.tenant, A.outlets[2], cutoff]));
      return db.withContext("munim_core", ownerCtx(A, { command_type: "orders.place.v1" }), (c) =>
        c.query(`INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, kind, subtotal_minor, total_minor, currency, pricing_snapshot)
                 VALUES ($1, gen_random_uuid(), $2, $3, 'takeaway', 100, 100, 'INR', '{}') RETURNING business_date::text AS d, ticket_no`, [A.tenant, A.outlets[2], A.channel]))
        .then((r) => r.rows[0]);
    };
    if (minutes > 1438) return; // within 2 minutes of local midnight no cutoff can lie after now; skip rather than flake
    const later = `${String(Math.floor((minutes + 1) / 60)).padStart(2, "0")}:${String((minutes + 1) % 60).padStart(2, "0")}`;
    const before = await place(later);
    const at = await place("00:00");
    console.log(`#60: cutoff ${later} → ${before.d} ticket ${before.ticket_no}; cutoff 00:00 → ${at.d} (local today ${today})`);
    expect(before).toEqual({ d: yesterday, ticket_no: 1 });
    expect(at.d).toBe(today);
  });

  test("#62: home_tz set by tenancy.tenant.update.v1 → accepted; not a zone → 23514; staff → MB001", async () => {
    const set = (tz: string, ctx: AppContext) => attempt(db, "munim_core", ctx, "UPDATE core.tenant SET home_tz = $2 WHERE tenant_id = $1", [A.tenant, tz]);
    expect(await set("Asia/Kolkata", ownerCtx(A, { command_type: "tenancy.tenant.update.v1" }))).toBeNull();
    expect((await set("not a zone", ownerCtx(A, { command_type: "tenancy.tenant.update.v1" })))?.code).toBe("23514");
    expect((await set("Asia/Kolkata", { tenant_id: A.tenant, outlet_ids: "*", role: "staff", member_id: A.staff, command_type: "tenancy.tenant.update.v1" }))?.code).toBe("MB001");
  });

  test("#17: draft.failure_reason only on a failed draft (23514 otherwise)", async () => {
    const e = await attempt(db, "munim_core", ownerCtx(A), `UPDATE core.draft SET failure_reason = 'execution_failed' WHERE tenant_id = $1 AND status = 'proposed'`, [A.tenant]);
    expect(e?.code).toBe("23514");
  });
});

describe("assert_catalog (0014 additions)", () => {
  test("RED-PROOF: a book table without a book_scope row → raises", async () => {
    const x = await db.clone();
    try {
      await x.admin("DELETE FROM core.book_scope WHERE table_name = 'core.price'");
      const msg = await x.admin("SELECT munim_meta.assert_catalog('gate')").then(() => null, (e: Error) => e.message);
      console.log("RED-PROOF book_scope coverage:", msg);
      expect(msg).toMatch(/book_scope does not match the book tables: core\.price/);
    } finally {
      await x.stop();
    }
  });
});

describe("ruling — shoppers: guests by token hash, customers by ownership, neither by outlet scope", () => {
  const guestCtx = (hash: string): AppContext => ({ tenant_id: A.tenant, outlet_ids: [], role: "guest", guest_access_hash: hash });
  const probe = async (x: TestDb, ctx: AppContext) => {
    const out: Record<string, number> = {};
    await x.withContext("munim_core", ctx, async (c) => {
      for (const t of TENANT_TABLES) out[t] = (await c.query(`SELECT count(*)::int n FROM ${t.split(".").map((p) => `"${p}"`).join(".")}`)).rows[0].n;
    });
    return out;
  };
  // One customer with two orders (outlets 1 and 2); only the first carries a guest token hash; each has a line.
  let shopper = "";
  let tokenHash = "";
  let guestOrder = "";
  let otherOrder = "";
  beforeAll(async () => {
    shopper = uuidv7();
    tokenHash = createHash("sha256").update(randomUUID()).digest("hex");
    guestOrder = uuidv7();
    otherOrder = uuidv7();
    await db.withContext("munim_core", cust(shopper, "storefront.guest.create.v1"), (c) =>
      c.query(`INSERT INTO core.customer (tenant_id, id, name) VALUES ($1, $2, 'Guest shopper')`, [A.tenant, shopper]));
    for (const [order, outlet, hash] of [[guestOrder, A.outlets[0], tokenHash], [otherOrder, A.outlets[1], null]] as const) {
      await db.withContext("munim_core", cust(shopper, "orders.place.v1"), async (c) => {
        await c.query(`INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, kind, subtotal_minor, total_minor, currency, pricing_snapshot, customer_id, guest_access_hash)
                       VALUES ($1, $2, $3, $4, 'pickup', 100, 100, 'INR', '{}', $5, $6)`, [A.tenant, order, outlet, A.channel, shopper, hash ? Buffer.from(hash, "hex") : null]);
        await c.query(`INSERT INTO core.order_line (tenant_id, id, outlet_id, order_id, line_no, item_id, qty_milli, unit_price_minor) VALUES ($1, gen_random_uuid(), $2, $3, 1, $4, 1000, 100)`,
          [A.tenant, outlet, order, A.item]);
      });
    }
  });

  test("a guest sees exactly the order whose hash it holds (+ its line) — 0 of the same customer's other orders, 0 customer rows", async () => {
    const seen = await probe(db, guestCtx(tokenHash));
    const nonzero = Object.fromEntries(Object.entries(seen).filter(([, n]) => n > 0));
    console.log("guest context: tables with rows →", nonzero);
    expect(nonzero).toEqual({ "core.order": 1, "core.order_line": 1 });
    const ids = await db.withContext("munim_core", guestCtx(tokenHash), (c) => c.query(`SELECT id FROM core."order"`));
    expect(ids.rows.map((r) => r.id)).toEqual([guestOrder]);
    expect(Object.values(await probe(db, guestCtx(createHash("sha256").update("wrong").digest("hex")))).every((n) => n === 0)).toBe(true);
  });

  test("a customer with outlet_ids '{}' sees exactly its own orders (both outlets) and 0 others", async () => {
    const r = await db.withContext("munim_core", cust(shopper, "customers.data.export.v1"), (c) => c.query(`SELECT id FROM core."order" ORDER BY id`));
    console.log(`shopper customer ('{}' scope): ${r.rowCount} orders visible`);
    expect(r.rows.map((x) => x.id).sort()).toEqual([guestOrder, otherOrder].sort());
  });

  test("a guest writes nothing", async () => {
    const e = await attempt(db, "munim_core", { ...guestCtx(tokenHash), command_type: "orders.place.v1" },
      `INSERT INTO core.order_event (tenant_id, id, outlet_id, order_id, kind, to_status, actor) VALUES ($1, gen_random_uuid(), $2, $3, 'status', 'cancelled', '{}')`,
      [A.tenant, A.outlets[0], guestOrder]);
    expect(e?.code).toMatch(/^(MB001|42501)$/);
  });

  test("RED-PROOF: drop guest_scope on core.\"order\" and core.customer → the guest sees other orders and the customer row", async () => {
    const x = await db.clone();
    try {
      await x.admin(`DROP POLICY guest_scope ON core."order"; DROP POLICY guest_scope ON core.customer`);
      const seen = await probe(x, guestCtx(tokenHash));
      console.log("RED-PROOF guest scope: orders", seen["core.order"], "customers", seen["core.customer"]);
      expect(seen["core.order"]).toBeGreaterThan(1);
      expect(seen["core.customer"]).toBeGreaterThan(0);
    } finally {
      await x.stop();
    }
  });

  test("RED-PROOF: drop customer_scope on core.\"order\" → the customer sees others' orders", async () => {
    const x = await db.clone();
    try {
      await x.admin(`DROP POLICY customer_scope ON core."order"`);
      const r = await x.withContext("munim_core", cust(shopper, "customers.data.export.v1"), (c) => c.query(`SELECT count(*)::int n FROM core."order"`));
      console.log("RED-PROOF customer scope: orders visible", r.rows[0].n);
      expect(r.rows[0].n).toBeGreaterThan(2);
    } finally {
      await x.stop();
    }
  });
});

describe("rider — outbox dead rows are never claimed", () => {
  test("a dead row is skipped by outbox_claim; a live one is claimed; svc may set dead_at / publish_attempts only", async () => {
    const x = await db.clone();
    try {
      const svc = { tenant_id: A.tenant, outlet_ids: "*" as const };
      await x.withContext("munim_svc", svc, (c) => c.query(`UPDATE core.outbox SET dead_at = now(), publish_attempts = 5 WHERE tenant_id = $1`, [A.tenant]));
      const live = uuidv7();
      await x.withContext("munim_core", svc, (c) => c.query(`INSERT INTO core.outbox (tenant_id, id, aggregatetype, aggregateid, type, payload)
        VALUES ($1, $2, 'x', 'x', 'munim.test.thing.happened.v1', '{}')`, [A.tenant, live]));
      const c = await x.connect("munim_svc");
      try {
        const claimed = (await c.query("SELECT tenant_id, id FROM core.outbox_claim(1000, interval '0 seconds')")).rows.filter((r) => r.tenant_id === A.tenant).map((r) => r.id);
        console.log(`outbox dead rows: claimed ${claimed.length} of tenant A's rows (the live one only)`);
        expect(claimed).toEqual([live]);
      } finally {
        await c.end();
      }
      expect((await attempt(x, "munim_svc", svc, "UPDATE core.outbox SET payload = '{}' WHERE tenant_id = $1", [A.tenant]))?.code).toBe("42501");
      // RED-PROOF on the same clone: the 0003 claim (no dead_at predicate) claims the dead rows.
      await x.admin(`UPDATE core.outbox SET claimed_until = NULL WHERE tenant_id = '${A.tenant}'`);
      const src = (await x.admin("SELECT prosrc FROM pg_proc WHERE oid = 'core.outbox_claim(integer, interval, interval)'::regprocedure")).rows[0]!.prosrc as string;
      await x.admin(`CREATE OR REPLACE FUNCTION core.outbox_claim(batch_size integer, min_age interval DEFAULT '30 seconds', lease interval DEFAULT '2 minutes')
        RETURNS SETOF core.outbox LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $f$${src.replace("AND c.dead_at IS NULL", "")}$f$`);
      const c2 = await x.connect("munim_svc");
      try {
        const n = (await c2.query("SELECT count(*)::int n FROM core.outbox_claim(1000, interval '0 seconds') WHERE tenant_id = $1", [A.tenant])).rows[0].n;
        console.log("RED-PROOF outbox dead rows: claimed", n);
        expect(n).toBeGreaterThan(1);
      } finally {
        await c2.end();
      }
    } finally {
      await x.stop();
    }
  });
});

describe("ruling — IN aggregator orders (Sec 9(5)) take no invoice number; the series stays gapless", () => {
  const aggregatorChannel = async (w: World, code: string) => {
    const id = uuidv7();
    await db.withContext("munim_core", ownerCtx(w, { command_type: "tenancy.channel.create.v1" }), (c) =>
      c.query(`INSERT INTO core.channel (tenant_id, id, name, kind) VALUES ($1, $2, $3, $4)`, [w.tenant, id, code, `aggregator:${code}`]));
    return id;
  };
  const place = (w: World, channel: string) => db.withContext("munim_core", ownerCtx(w, { command_type: "orders.place.v1" }), (c) =>
    c.query(`INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, device_id, kind, subtotal_minor, total_minor, currency, pricing_snapshot)
             VALUES ($1, gen_random_uuid(), $2, $3, $4, 'delivery', 100, 100, $5, '{}') RETURNING invoice_no::int AS n`,
      [w.tenant, w.outlets[0], channel, w.devices[0], w.currency])).then((r) => r.rows[0].n as number | null);

  test("IN: counter n → swiggy order NULL → counter n+1; AU: an ubereats order is numbered", async () => {
    const swiggy = await aggregatorChannel(A, "swiggy");
    const first = await place(A, A.channel);
    const agg = await place(A, swiggy);
    const next = await place(A, A.channel);
    const B = await buildWorld(db, { country: "AU" });
    const au = await place(B, await aggregatorChannel(B, "ubereats"));
    console.log(`invoice series: counter ${first} → swiggy ${agg} → counter ${next}; AU ubereats ${au}`);
    expect(agg).toBeNull();
    expect(next).toBe(first! + 1);
    expect(au).not.toBeNull();
  });
});
