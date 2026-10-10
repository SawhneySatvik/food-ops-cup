// Gates for 0018 (history imports, migrator lane h-1; ledger R44 b, c). Each refusal is paired with its accepted case;
// expected values are typed by hand. Red-proofs: db/tests/redproof-0018.sh plants a 0019 per item and requires this file
// to exit non-zero naming the item's tests. Synthetic data only.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { AppContext, TestDb } from "../src/harness.ts";
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

const one = async <T>(sql: string, params: unknown[] = []) => (await db.admin(sql, params)).rows[0] as T;
const svc: AppContext = { tenant_id: "", outlet_ids: "*", role: "service" };

/** An approved imports.run.commit.v1 draft executing in this transaction; `fn` gets a query function. Errors come back. */
const inImport = (fn: (q: (sql: string, params?: unknown[]) => Promise<unknown>) => Promise<void>) =>
  approveDraft(db, A, "imports.run.commit.v1", async (q) => fn(q)).then(() => null, (e: { code?: string; message: string }) => ({ code: e.code, message: e.message }));

describe("K1 — history kinds on document, import_format and import_run", () => {
  test("K1 accepted: a pos_bills and a waste_log document and run are created (parser pos_bills_v2 / waste_log_v1)", async () => {
    const made: string[] = [];
    for (const [kind, parser] of [["pos_bills", "pos_bills_v2"], ["waste_log", "waste_log_v1"]] as const) {
      const doc = uuidv7();
      const run = uuidv7();
      await db.withContext("munim_core", ownerCtx(A), async (c) => {
        await c.query(`INSERT INTO core.document (tenant_id, id, kind, media_type, byte_size, sha256, storage_ref) VALUES ($1, $2, $3, 'text/csv', 10, $4, 'k')`,
          [A.tenant, doc, kind, doc.replaceAll("-", "").padEnd(64, "0")]);
        await c.query(`INSERT INTO core.import_run (tenant_id, id, document_id, kind, parser) VALUES ($1, $2, $3, $4, $5)`, [A.tenant, run, doc, kind, parser]);
      });
      made.push((await one<{ k: string }>(`SELECT kind || '/' || parser AS k FROM core.import_run WHERE id = $1`, [run])).k);
    }
    expect(made).toEqual(["pos_bills/pos_bills_v2", "waste_log/waste_log_v1"]);
  });

  test("K1 refused: any other kind is still refused by the CHECK (23514) on document, format and run", async () => {
    const doc = await attempt(db, "munim_core", ownerCtx(A), `INSERT INTO core.document (tenant_id, id, kind, media_type, byte_size, sha256, storage_ref)
      VALUES ($1, $2, 'pos_billz', 'text/csv', 10, repeat('a', 64), 'k')`, [A.tenant, uuidv7()]);
    const defs = (await db.admin<{ d: string }>(`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
      WHERE conname IN ('document_kind_check', 'import_format_kind_check', 'import_run_kind_check') ORDER BY conname`)).rows.map((r) => r.d);
    expect(doc?.code).toBe("23514");
    expect(defs.every((d) => d.includes("'pos_bills'::text") && d.includes("'waste_log'::text") && !d.includes("pos_billz"))).toBe(true);
    expect(defs).toHaveLength(3);
  });
});

describe("K2 — what an approved import may write", () => {
  test("K2 accepted: under the approved draft an order, its line, a refund, a void and a waste entry are written with the decision as origin", async () => {
    const ids = { order: uuidv7(), line: uuidv7(), refund: uuidv7(), void: uuidv7(), waste: uuidv7() };
    let decision = "";
    const err = await approveDraft(db, A, "imports.run.commit.v1", async (q, d) => {
      decision = d;
      await q(`INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, kind, status, business_date, subtotal_minor, total_minor, currency, pricing_snapshot, external_ref)
               VALUES ($1, $2, $3, $4, 'takeaway', 'completed', '2026-10-02', 32000, 32000, 'INR', '{"synthetic": true}', $5)`,
        [A.tenant, ids.order, A.outlets[0], A.channel, `K2-${ids.order}`]);
      await q(`INSERT INTO core.order_line (tenant_id, id, outlet_id, order_id, line_no, item_id, qty_milli, unit_price_minor) VALUES ($1, $2, $3, $4, 1, $5, 1000, 32000)`,
        [A.tenant, ids.line, A.outlets[0], ids.order, A.item]);
      await q(`INSERT INTO core.refund (tenant_id, id, outlet_id, order_id, method, amount_minor, currency, reason_code, note, actor) VALUES ($1, $2, $3, $4, 'cash', 1000, 'INR', 'goodwill', 'synthetic', $5)`,
        [A.tenant, ids.refund, A.outlets[0], ids.order, A.owner]);
      await q(`INSERT INTO core.void (tenant_id, id, outlet_id, order_id, order_line_id, reason_code, note, amount_minor, currency, actor) VALUES ($1, $2, $3, $4, $5, 'remake', 'synthetic', 32000, 'INR', $6)`,
        [A.tenant, ids.void, A.outlets[0], ids.order, ids.line, A.owner]);
      await q(`INSERT INTO core.waste_log (tenant_id, id, outlet_id, ingredient_id, qty_milli, unit, reason, recorded_by) VALUES ($1, $2, $3, $4, 1000, 'g', 'damaged', $5)`,
        [A.tenant, ids.waste, A.outlets[0], A.ingredient, A.owner]);
    }).then(() => null, (e: { code?: string; message: string }) => e);
    expect(err).toBeNull();
    const origins = await db.admin<{ t: string; kind: string; d: string }>(
      `SELECT 'order' t, origin->>'kind' kind, origin->>'decision_id' d FROM core."order" WHERE id = $1
       UNION ALL SELECT 'order_line', origin->>'kind', origin->>'decision_id' FROM core.order_line WHERE id = $2
       UNION ALL SELECT 'refund', origin->>'kind', origin->>'decision_id' FROM core.refund WHERE id = $3
       UNION ALL SELECT 'void', origin->>'kind', origin->>'decision_id' FROM core.void WHERE id = $4
       UNION ALL SELECT 'waste_log', origin->>'kind', origin->>'decision_id' FROM core.waste_log WHERE id = $5 ORDER BY 1`,
      [ids.order, ids.line, ids.refund, ids.void, ids.waste]);
    expect(origins.rows).toEqual(["order", "order_line", "refund", "void", "waste_log"].map((t) => ({ t, kind: "decision", d: decision })));
    // The imported order kept its own business date and took no invoice number (0015).
    expect(await one(`SELECT business_date::text AS bd, invoice_no FROM core."order" WHERE id = $1`, [ids.order])).toEqual({ bd: "2026-10-02", invoice_no: null });
  });

  test("K2 refused: under the same decision a stock movement or a journal entry with no rule → MB008 (derived rows are never the decision's)", async () => {
    const mv = await inImport((q) => q(`INSERT INTO core.stock_movement (tenant_id, id, outlet_id, ingredient_id, qty_milli, unit, kind) VALUES ($1, $2, $3, $4, -1000, 'g', 'waste')`,
      [A.tenant, uuidv7(), A.outlets[0], A.ingredient]).then(() => undefined));
    const je = await inImport((q) => q(`INSERT INTO core.journal_entry (tenant_id, id, outlet_id, entry_date) VALUES ($1, $2, $3, '2026-10-02')`,
      [A.tenant, uuidv7(), A.outlets[0]]).then(() => undefined));
    expect([mv?.code, je?.code]).toEqual(["MB008", "MB008"]);
  });
});

describe("K3 — core.write_derived(groups jsonb)", () => {
  /** A waste entry under an approved import, then `groups(waste id)` through write_derived in the same transaction. */
  async function withWaste(groups: (waste: string) => unknown, after?: (q: (sql: string, params?: unknown[]) => Promise<any>) => Promise<void>) {
    const waste = uuidv7();
    const err = await inImport(async (q) => {
      await q(`INSERT INTO core.waste_log (tenant_id, id, outlet_id, ingredient_id, qty_milli, unit, reason, recorded_by) VALUES ($1, $2, $3, $4, 2500, 'g', 'overprep', $5)`,
        [A.tenant, waste, A.outlets[0], A.ingredient, A.owner]);
      await q(`SELECT core.write_derived($1::jsonb)`, [JSON.stringify(groups(waste))]);
      if (after) await after(q);
    });
    return { waste, err };
  }
  const mv = (over: Record<string, unknown> = {}) => ({ id: uuidv7(), outlet_id: A.outlets[0], ingredient_id: A.ingredient, batch_id: null, qty_milli: -2500, unit: "g",
    kind: "waste", unit_cost_per_1000_minor: null, currency: null, expired_sale_override_id: null, at: "2026-10-02T06:30:00Z", ...over });

  test("K3 accepted: a waste movement under inventory.record_waste is a derivation of its entry; ref, rule and source come from the group; settings restored", async () => {
    const m = mv({ ref_id: uuidv7(), ref_type: "core.order" });
    let settings: unknown;
    const { waste, err } = await withWaste((w) => [{ rule: "inventory.record_waste", source_ref: `core.waste_log:${w}`, stock_movement: [m] }], async (q) => {
      settings = ((await q(`SELECT current_setting('app.posting_rule', true) AS r, current_setting('app.source_ref', true) AS s`)) as { rows: unknown[] }).rows[0];
    });
    expect(err).toBeNull();
    expect(await one(`SELECT ref_type, ref_id::text, qty_milli::int AS qty, kind, origin, created_by = $2 AS by_approver, at = '2026-10-02T06:30:00Z' AS at
                        FROM core.stock_movement WHERE id = $1`, [m.id, A.owner])).toEqual({
      ref_type: "core.waste_log", ref_id: waste, qty: -2500, kind: "waste", by_approver: true, at: true,
      origin: { kind: "derivation", rule_id: "inventory.record_waste", source_ref: `core.waste_log:${waste}` },
    });
    expect(settings).toEqual({ r: "", s: "" });
  });

  test("K3 accepted: a journal entry's rule and source are the group's (the row cannot name another source)", async () => {
    const order = uuidv7();
    const entry = uuidv7();
    const err = await inImport(async (q) => {
      await q(`INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, kind, status, business_date, subtotal_minor, total_minor, currency, pricing_snapshot, external_ref)
               VALUES ($1, $2, $3, $4, 'takeaway', 'completed', '2026-10-03', 5000, 5000, 'INR', '{}', $5)`, [A.tenant, order, A.outlets[0], A.channel, `K3-${order}`]);
      await q(`SELECT core.write_derived($1::jsonb)`, [JSON.stringify([{ rule: "finance.post_order", source_ref: `core.order:${order}`,
        journal_entry: [{ id: entry, outlet_id: A.outlets[0], brand_id: null, channel_id: A.channel, entry_date: "2026-10-03", posting_rule: "finance.post_expense", source_id: uuidv7() }],
        posting: [{ id: uuidv7(), journal_entry_id: entry, account_id: A.accounts.cash, amount_minor: 5000, currency: "INR" },
                  { id: uuidv7(), journal_entry_id: entry, account_id: A.accounts.sales, amount_minor: -5000, currency: "INR" }] }])]);
    });
    expect(err).toBeNull();
    expect(await one(`SELECT posting_rule, source_type, source_id::text, origin ->> 'kind' AS kind, (SELECT count(*)::int FROM core.posting WHERE journal_entry_id = $1) AS postings
                        FROM core.journal_entry WHERE id = $1`, [entry])).toEqual({ posting_rule: "finance.post_order", source_type: "core.order", source_id: order, kind: "derivation", postings: 2 });
  });

  test("K3 refused: a posting of another group's entry or an unknown key → 22023 before any write; munim_svc cannot call it (42501)", async () => {
    const other = await withWaste((w) => [{ rule: "inventory.record_waste", source_ref: `core.waste_log:${w}`,
      posting: [{ id: uuidv7(), journal_entry_id: uuidv7(), account_id: A.accounts.cash, amount_minor: 1, currency: "INR" }] }]);
    const key = await withWaste((w) => [{ rule: "inventory.record_waste", source_ref: `core.waste_log:${w}`, stock_movement: [mv()], payable: [] }]);
    const svcCall = await attempt(db, "munim_svc", { ...svc, tenant_id: A.tenant }, `SELECT core.write_derived('[]'::jsonb)`);
    expect([other.err?.code, key.err?.code, svcCall?.code]).toEqual(["22023", "22023", "42501"]);
  });

  test("K3 refused: the guard judges every row it writes — a source outside the rule's state (MB008 under the import, MB001 alone)", async () => {
    // finance.post_order needs a completed order; the world's first order is not one.
    const placed = (await one<{ id: string }>(`SELECT id FROM core."order" WHERE tenant_id = $1 AND status <> 'completed' ORDER BY id LIMIT 1`, [A.tenant])).id;
    const entry = (src: string) => {
      const id = uuidv7();
      return [{ rule: "finance.post_order", source_ref: src, journal_entry: [{ id, outlet_id: A.outlets[0], brand_id: null, channel_id: A.channel, entry_date: "2026-10-03" }],
        posting: [{ id: uuidv7(), journal_entry_id: id, account_id: A.accounts.cash, amount_minor: 100, currency: "INR" },
                  { id: uuidv7(), journal_entry_id: id, account_id: A.accounts.sales, amount_minor: -100, currency: "INR" }] }];
    };
    // Under the approved import: not a derivation (state), and the import does not list journal entries → MB008.
    const underImport = await inImport((q) => q(`SELECT core.write_derived($1::jsonb)`, [JSON.stringify(entry(`core.order:${placed}`))]).then(() => undefined));
    // The owner's own context, no command: nothing admits it → MB001.
    const bare: AppContext = { tenant_id: A.tenant, outlet_ids: "*", role: "owner", member_id: A.owner };
    const alone = await attempt(db, "munim_core", bare, `SELECT core.write_derived($1::jsonb)`, [JSON.stringify(entry(`core.order:${placed}`))]);
    const missing = await attempt(db, "munim_core", bare, `SELECT core.write_derived($1::jsonb)`,
      [JSON.stringify([{ rule: "inventory.record_waste", source_ref: `core.waste_log:${uuidv7()}`, stock_movement: [mv()] }])]);
    console.log(`K3 guard: under import ${underImport?.code}; alone ${alone?.code} (${alone?.message}); missing source ${missing?.code}`);
    expect([underImport?.code, alone?.code, missing?.code]).toEqual(["MB008", "MB001", "MB001"]);
  });
});
