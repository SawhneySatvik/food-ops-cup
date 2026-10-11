// Gates: country fixed after onboarding + currency assertion (R30); duplicate supplier invoice; snapshot
// minter (R40 C4) and template numeric sources (02-schema §3, R40 C5); rider constraints (tender change,
// single-use expired-sale override, non-overlapping validity); country-pack seed. Each refusal paired with
// an accepted case; red-proofs on clones.
import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { TestDb } from "../src/harness.ts";
import { PACKS_DIR, seedPacks } from "../seeds/packs.ts";
import { openDb } from "./db.ts";
import { attempt } from "./gates.ts";
import { INTEL_NUMERIC_ALLOW, TEMPLATES } from "./manifest.ts";
import { buildWorld, ownerCtx, type World } from "./world.ts";

let db: TestDb;
let A: World;

beforeAll(async () => {
  db = await openDb();
  A = await buildWorld(db);
});
afterAll(async () => db?.stop());

// Country is chosen inside provisioning (tenancy.provision.v1, operator) and fixed at onboarding (R30).
const country = (w: World) => ({ tenant_id: w.tenant, outlet_ids: "*" as const, role: "operator", operator_id: w.operator, command_type: "tenancy.provision.v1" });
const setTenant = (x: TestDb, w: World, set: string) =>
  attempt(x, "munim_core", country(w), `UPDATE core.tenant SET ${set} WHERE tenant_id = $1`, [w.tenant]);
let priceDay = 0;
const priceIn = (x: TestDb, w: World, currency: string) =>
  attempt(x, "munim_core", ownerCtx(w, { command_type: "catalogue.price.set.v1" }),
    `INSERT INTO core.price (tenant_id, id, item_id, outlet_id, channel_kind, amount_minor, currency, tax_class, valid_from, valid_to)
     VALUES ($1, gen_random_uuid(), $2, $3, 'pickup', 100, $4, 'restaurant_5', $5::date, $5::date + 1)`,
    [w.tenant, w.item, w.outlets[1], currency, new Date(Date.UTC(2031, 0, 1 + priceDay++)).toISOString().slice(0, 10)]);

describe("country fixed at onboarding (R30)", () => {
  test("before onboarded_at: country change accepted; after: country, currency, FY and un-onboarding refused (MB002)", async () => {
    const w = await buildWorld(db);
    expect(await setTenant(db, w, "country_code = 'AU', base_currency = 'AUD', fy_start_month = 7")).toBeNull();
    expect(await setTenant(db, w, "country_code = 'IN', base_currency = 'INR', fy_start_month = 4")).toBeNull();
    expect(await setTenant(db, w, "onboarded_at = now()")).toBeNull();
    const refused = {
      country: await setTenant(db, w, "country_code = 'AU'"),
      currency: await setTenant(db, w, "base_currency = 'AUD'"),
      fy: await setTenant(db, w, "fy_start_month = 1"),
      unonboard: await setTenant(db, w, "onboarded_at = NULL"),
      both: await setTenant(db, w, "onboarded_at = NULL, country_code = 'AU'"),
    };
    console.log("country lock:", Object.entries(refused).map(([k, e]) => `${k}=${e?.code}`).join(" "));
    for (const e of Object.values(refused)) expect(e?.code).toBe("MB002");
    expect(await setTenant(db, w, "name = 'Renamed'")).toBeNull(); // other fields stay editable
  });

  test("currency-bearing rows: a price in AUD for an INR tenant → MB003; in INR → accepted", async () => {
    expect((await priceIn(db, A, "AUD"))?.code).toBe("MB003");
    expect(await priceIn(db, A, "INR")).toBeNull();
  });

  const unguardedCurrency = async (x: TestDb) => {
    const r = await x.admin(`
      SELECT c.relname || '.' || a.attname AS col,
             EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'currency_check'
                       AND (t.tgfoid = 'core.assert_tenant_currency()'::regprocedure
                            -- operational rows munim_svc writes (no FOR SHARE lock on core.tenant, 0009)
                            OR (t.tgfoid = 'core.assert_tenant_currency_svc()'::regprocedure
                                AND obj_description(c.oid, 'pg_class') = 'munim:operational'))
                       AND position(convert_to(a.attname, 'UTF8') IN t.tgargs) > 0) AS guarded
        FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace s ON s.oid = c.relnamespace
       WHERE s.nspname = 'core' AND c.relkind = 'r' AND a.attname = 'currency' AND NOT a.attisdropped ORDER BY 1`);
    return { total: r.rowCount ?? 0, unguarded: r.rows.filter((row) => !row.guarded).map((row) => row.col as string) };
  };

  test("every currency column in core carries the assertion trigger naming it", async () => {
    const r = await unguardedCurrency(db);
    console.log(`currency columns: ${r.total - r.unguarded.length}/${r.total} guarded`);
    expect(r.total).toBeGreaterThan(10);
    expect(r.unguarded).toEqual([]);
  });

  test("RED-PROOF: drop currency_check on core.tender → 1 unguarded column", async () => {
    const x = await db.clone();
    try {
      await x.admin("DROP TRIGGER currency_check ON core.tender");
      const r = await unguardedCurrency(x);
      console.log("RED-PROOF currency coverage:", r.unguarded);
      expect(r.unguarded).toEqual(["tender.currency"]);
    } finally {
      await x.stop();
    }
  });

  test("RED-PROOF: drop country_lock and currency_check on price → both changes go through", async () => {
    const x = await db.clone();
    try {
      await x.admin("DROP TRIGGER country_lock ON core.tenant; DROP TRIGGER currency_check ON core.price");
      expect(await setTenant(x, A, "onboarded_at = now()")).toBeNull(); // the guard admits no superuser shortcut
      const lock = await setTenant(x, A, "country_code = 'AU'");
      const cur = await priceIn(x, A, "AUD");
      console.log("RED-PROOF country/currency:", { lock, cur });
      expect(lock).toBeNull();
      expect(cur).toBeNull();
    } finally {
      await x.stop();
    }
  });
});

describe("duplicate supplier invoice", () => {
  const inv = (x: TestDb, no: string) =>
    attempt(x, "munim_core", ownerCtx(A, { command_type: "purchasing.invoice.record.v1" }), `INSERT INTO core.supplier_invoice (tenant_id, id, supplier_id, invoice_no, invoice_date, subtotal_minor, total_minor, currency)
      VALUES ($1, gen_random_uuid(), $2, $3, '2026-10-06', 100, 100, 'INR')`, [A.tenant, A.supplier, no]);

  test("same (supplier, invoice_no) as the world's INV-1 → 23505; a new number → accepted", async () => {
    const dup = await inv(db, "INV-1");
    expect(dup?.code).toBe("23505");
    expect(dup?.message).toMatch(/supplier_invoice_no_unique/);
    expect(await inv(db, "INV-2")).toBeNull();
  });

  test("RED-PROOF: drop the unique constraint → the duplicate is accepted", async () => {
    const x = await db.clone();
    try {
      await x.admin("ALTER TABLE core.supplier_invoice DROP CONSTRAINT supplier_invoice_no_unique");
      const r = await inv(x, "INV-1");
      console.log("RED-PROOF duplicate invoice:", r);
      expect(r).toBeNull();
    } finally {
      await x.stop();
    }
  });
});

describe("snapshots", () => {
  const snap = (role: "munim_core" | "munim_svc", cols: string, vals: string, params: unknown[]) =>
    attempt(db, role, { tenant_id: A.tenant, outlet_ids: "*" },
      `INSERT INTO evidence.snapshot (tenant_id, id, template_id, template_version, outlet_scope, rows, row_count, sha256${cols})
       VALUES ($1, gen_random_uuid(), 'inventory.below_reorder', 1, '{*}', '[]', 0, repeat('0', 64)${vals})`, [A.tenant, ...params]);

  test("exactly one minter (R40 C4): member-minted by munim_core accepted; none or two → 23514", async () => {
    expect(await snap("munim_core", ", minted_by_member_id", ", $2", [A.owner])).toBeNull();
    expect(await snap("munim_svc", ", run_id", ", $2", [A.run])).toBeNull();
    const none = await snap("munim_core", "", "", []);
    const two = await snap("munim_core", ", run_id, minted_by_member_id", ", $2, $3", [A.run, A.owner]);
    expect(none?.code).toBe("23514");
    expect(none?.message).toMatch(/snapshot_one_minter/);
    expect(two?.code).toBe("23514");
  });

  test("RED-PROOF: drop snapshot_one_minter → a minterless snapshot is accepted", async () => {
    const x = await db.clone();
    try {
      await x.admin("ALTER TABLE evidence.snapshot DROP CONSTRAINT snapshot_one_minter");
      const e = await attempt(x, "munim_core", { tenant_id: A.tenant, outlet_ids: "*" },
        `INSERT INTO evidence.snapshot (tenant_id, id, template_id, template_version, outlet_scope, rows, row_count, sha256)
         VALUES ($1, gen_random_uuid(), 'inventory.below_reorder', 1, '{*}', '[]', 0, repeat('0', 64))`, [A.tenant]);
      console.log("RED-PROOF one minter:", e);
      expect(e).toBeNull();
    } finally {
      await x.stop();
    }
  });

  test("operator-minted snapshot accepted (FK to platform.operator)", async () => {
    const op = randomUUID();
    await db.withContext("munim_platform", {}, (c) => c.query(`INSERT INTO platform.operator (id, idp_sub, email) VALUES ($1, $2, 'op@example.test')`, [op, `sub-${op}`]));
    expect(await snap("munim_core", ", minted_by_operator_id", ", $2", [op])).toBeNull();
  });

  /** Every numeric column of every template names allowed source columns (R40 C5: column-level). numeric_source is one
   *  string or a list of them (0019, ADR-014 §14 C6): every element is checked, and an empty list names nothing. */
  async function templateSourceFailures(x: TestDb): Promise<{ templates: string[]; failures: string[]; elements: number }> {
    const cols = new Set((await x.admin(`
      SELECT s.nspname || '.' || c.relname || '.' || a.attname AS col FROM pg_attribute a
        JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace s ON s.oid = c.relnamespace
       WHERE s.nspname = 'core' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped`)).rows.map((r) => r.col));
    const tables = new Set([...cols].map((c) => c.split(".").slice(0, 2).join(".")));
    const t = await x.admin("SELECT CASE version WHEN 1 THEN id ELSE id || '@' || version END AS id, columns FROM evidence.snapshot_template ORDER BY id, version");
    const failures: string[] = [];
    let elements = 0;
    for (const row of t.rows) {
      for (const col of row.columns as { name: string; type: string; numeric_source?: string | string[] }[]) {
        if (col.type !== "integer" && col.type !== "numeric") continue;
        const list = Array.isArray(col.numeric_source) ? col.numeric_source : [col.numeric_source ?? ""];
        if (list.length === 0) failures.push(`${row.id}.${col.name}: numeric_source is an empty list`);
        for (const src of list) {
          elements++;
          const ok = cols.has(src) || (src.startsWith("count:") && tables.has(src.slice(6))) || INTEL_NUMERIC_ALLOW.includes(src);
          if (!ok) failures.push(`${row.id}.${col.name}: numeric_source '${src}' not allowed`);
        }
      }
    }
    return { templates: t.rows.map((r) => r.id as string).sort(), failures, elements };
  }

  test("template numeric sources: every numeric column names an allowed source column", async () => {
    const r = await templateSourceFailures(db);
    console.log(`templates: ${r.templates.length} checked (${r.templates.join(", ")}), ${r.elements} source elements, ${r.failures.length} bad numeric sources`);
    expect(r.templates).toEqual(TEMPLATES);
    // 0019's list-form columns carry more than one element each: a scan that read only strings would see far fewer.
    expect(r.elements).toBeGreaterThan(150);
    expect(r.failures).toEqual([]);
  });

  test("RED-PROOF (0019 list form): an intel column planted as one element of a list → red", async () => {
    const x = await db.clone();
    try {
      await x.admin(`UPDATE evidence.snapshot_template SET columns = jsonb_set(columns, '{2,numeric_source}',
                       '["core.order_line.qty_milli", "intel.finding.confidence_bp"]') WHERE id = 'catalogue.dish_margin' AND version = 1`);
      const r = await templateSourceFailures(x);
      console.log("RED-PROOF template sources (list element):", r.failures);
      expect(r.failures).toEqual(["catalogue.dish_margin.units_sold: numeric_source 'intel.finding.confidence_bp' not allowed"]);
    } finally {
      await x.stop();
    }
  });

  test("inventory.below_reorder runs as munim_svc under RLS and returns its declared columns and the hand values", async () => {
    const t = await db.admin<{ sql: string; columns: { name: string }[] }>(
      "SELECT sql, columns FROM evidence.snapshot_template WHERE id = 'inventory.below_reorder'");
    const tpl = t.rows[0]!;
    const r: pg.QueryResult = await db.withContext("munim_svc", { tenant_id: A.tenant, outlet_ids: "*" }, (c) => c.query(tpl.sql));
    expect(r.fields.map((f) => f.name)).toEqual(tpl.columns.map((c) => c.name));
    // world: 5,000,000 g received per outlet vs min 9,000,000 → both outlets below reorder
    expect(r.rows.map((x) => [x.outlet_id, x.on_hand_milli]).sort()).toEqual(
      [[A.outlets[0], "5000000"], [A.outlets[1], "5000000"]].sort());
  });

  test("every INTEL_NUMERIC_ALLOW entry names a column (or a count table) that exists; none is finding.confidence_bp", async () => {
    const r = await db.admin<{ ref: string; ok: boolean }>(`
      SELECT ref, CASE WHEN ref LIKE 'count:%' THEN to_regclass(substr(ref, 7)) IS NOT NULL
                       ELSE EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = to_regclass(split_part(ref, '.', 1) || '.' || split_part(ref, '.', 2))
                                      AND a.attname = split_part(ref, '.', 3) AND NOT a.attisdropped) END AS ok
        FROM unnest($1::text[]) ref`, [INTEL_NUMERIC_ALLOW]);
    console.log(`intel numeric allow-list: ${r.rows.filter((x) => x.ok).length}/${r.rowCount} entries exist`);
    expect(r.rows.filter((x) => !x.ok)).toEqual([]);
    expect(INTEL_NUMERIC_ALLOW.some((x) => x.startsWith("intel.finding.") || x.startsWith("intel.answer.") || x.startsWith("intel.outcome."))).toBe(false);
  });

  test("column-level (R40 C5): a template on count:intel.answer and forecast intervals → accepted; on finding.confidence_bp → red", async () => {
    const x = await db.clone();
    try {
      await x.admin(`INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES
        ('intel.allowed_numbers', 1, 'SELECT 1', '{}', '[{"name": "answers", "type": "integer", "numeric_source": "count:intel.answer"},
                                                         {"name": "lo", "type": "integer", "numeric_source": "intel.forecast_point.lo_qty_milli"}]', 'owner'),
        ('intel.confidence_as_number', 1, 'SELECT 1', '{}', '[{"name": "c", "type": "integer", "numeric_source": "intel.finding.confidence_bp"}]', 'owner')`);
      const r = await templateSourceFailures(x);
      console.log("RED-PROOF template sources (confidence_bp):", r.failures);
      expect(r.failures).toEqual(["intel.confidence_as_number.c: numeric_source 'intel.finding.confidence_bp' not allowed"]);
    } finally {
      await x.stop();
    }
  });

  test("RED-PROOF: a template reading intel.claim.object numerically → red", async () => {
    const x = await db.clone();
    try {
      await x.admin(`INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role)
        VALUES ('intel.claims_as_numbers', 1, 'SELECT 1', '{}', '[{"name": "n", "type": "numeric", "numeric_source": "intel.claim.object"}]', 'owner')`);
      const r = await templateSourceFailures(x);
      console.log("RED-PROOF template sources:", r.failures);
      expect(r.failures).toEqual(["intel.claims_as_numbers.n: numeric_source 'intel.claim.object' not allowed"]);
    } finally {
      await x.stop();
    }
  });
});

describe("rider constraints", () => {
  test("tender: change = tendered − amount (R40 C1); wrong change → 23514", async () => {
    const t = (change: number) => attempt(db, "munim_core", ownerCtx(A, { command_type: "orders.place.v1" }),
      `INSERT INTO core.tender (tenant_id, id, outlet_id, order_id, method, amount_minor, tendered_minor, change_minor, currency, recorded_by)
       VALUES ($1, gen_random_uuid(), $2, $3, 'cash', 33600, 40000, $4, 'INR', $5)`, [A.tenant, A.outlets[0], A.orders[0], change, A.owner]);
    expect((await t(5000))?.code).toBe("23514");
    expect(await t(6400)).toBeNull();
  });

  test("expired-sale override (R40 C7): single use; decided_by must be the signed-in member", async () => {
    const use = () => attempt(db, "munim_core", ownerCtx(A, { command_type: "inventory.expired_sale.override.v1" }),
      `UPDATE core.expired_sale_override SET used_at = now(), order_line_id = cart_line_id WHERE tenant_id = $1 AND outlet_id = $2`, [A.tenant, A.outlets[0]]);
    expect(await use()).toBeNull();
    expect((await use())?.code).toBe("MB005");
    const forged = await attempt(db, "munim_core", ownerCtx(A, { command_type: "inventory.expired_sale.override.v1" }),
      `INSERT INTO core.expired_sale_override (tenant_id, id, outlet_id, cart_line_id, batch_id, qty_milli, reason_code, note, decided_by)
       VALUES ($1, gen_random_uuid(), $2, $3, $4, 1, 'x', 'y', $5)`, [A.tenant, A.outlets[1], A.orderLines[1], A.batches[1], A.staff]);
    expect(forged?.code).toBe("MB005");
    const staffCmd = await attempt(db, "munim_core", { tenant_id: A.tenant, outlet_ids: "*", role: "staff", member_id: A.staff, command_type: "inventory.expired_sale.override.v1" },
      `INSERT INTO core.expired_sale_override (tenant_id, id, outlet_id, cart_line_id, batch_id, qty_milli, reason_code, note, decided_by)
       VALUES ($1, gen_random_uuid(), $2, $3, $4, 1, 'x', 'y', $5)`, [A.tenant, A.outlets[1], A.orderLines[1], A.batches[1], A.staff]);
    expect(staffCmd?.code).toBe("MB001"); // staff is not listed for the override command
  });

  test("recipe validity: overlapping window → 23P01; adjacent window → accepted", async () => {
    const rv = (from: string, to: string | null) => attempt(db, "munim_core", ownerCtx(A, { command_type: "catalogue.recipe.version.create.v1" }),
      `INSERT INTO core.recipe_version (tenant_id, id, item_id, version, valid_from, valid_to, yield_qty_milli)
       VALUES ($1, gen_random_uuid(), $2, (SELECT max(version) + 1 FROM core.recipe_version WHERE tenant_id = $1), $3, $4, 1000)`,
      [A.tenant, A.item, from, to]);
    expect((await rv("2026-11-01", null))?.code).toBe("23P01"); // world's v1 is open-ended from 2026-10-01
    await db.withContext("munim_core", ownerCtx(A, { command_type: "catalogue.recipe.version.create.v1" }), (c) =>
      c.query(`UPDATE core.recipe_version SET valid_to = '2026-11-01' WHERE tenant_id = $1 AND version = 1`, [A.tenant]));
    expect(await rv("2026-11-01", null)).toBeNull();
  });
});

describe("customer accounts (R41)", () => {
  // A shopper context has no outlet scope ('{}'), never the '{*}' wildcard (F2, 0014 ruling).
  const cust = (w: World, id: string, cmd: string) => ({ tenant_id: w.tenant, outlet_ids: [] as string[], role: "customer", customer_id: id, command_type: cmd });
  const newCustomer = async (w: World) => {
    const id = randomUUID();
    await db.withContext("munim_core", cust(w, id, "storefront.guest.create.v1"), (c) =>
      c.query(`INSERT INTO core.customer (tenant_id, id, name, email, idp_sub) VALUES ($1, $2, 'Asha', 'asha@example.test', $3)`, [w.tenant, id, `sub-${id}`]));
    return id;
  };

  test("a customer context sees only its own profile; staff see all of the tenant's", async () => {
    const me = await newCustomer(A);
    const mine = await db.withContext("munim_core", cust(A, me, "customers.data.export.v1"), (c) => c.query("SELECT id FROM core.customer"));
    expect(mine.rows.map((r) => r.id)).toEqual([me]);
    const staff = await db.withContext("munim_core", ownerCtx(A), (c) => c.query("SELECT count(*)::int n FROM core.customer"));
    expect(staff.rows[0]!.n).toBeGreaterThanOrEqual(2);
    // writing someone else's profile from a customer context: the guard refuses it as not the customer's own
    // (F2, MB001) before the policy's WITH CHECK would (42501)
    const e = await attempt(db, "munim_core", cust(A, me, "customers.profile.update.v1"),
      `INSERT INTO core.customer (tenant_id, id, name) VALUES ($1, gen_random_uuid(), 'Other')`, [A.tenant]);
    expect(e?.code).toBe("MB001");
  });

  test("idp_sub is unique per tenant", async () => {
    const me = await newCustomer(A);
    const e = await attempt(db, "munim_core", cust(A, randomUUID(), "storefront.guest.create.v1"),
      `INSERT INTO core.customer (tenant_id, id, name, idp_sub) SELECT $1, nullif(current_setting('app.customer_id'), '')::uuid, 'Dup', $2`, [A.tenant, `sub-${me}`]);
    expect(e?.code).toBe("23505");
  });

  test("erasure: own command anonymises and is final; staff refused; no erasure command refused; owner accepted", async () => {
    const me = await newCustomer(A);
    const erase = `UPDATE core.customer SET erased_at = now() WHERE tenant_id = $1 AND id = $2`;
    expect((await attempt(db, "munim_core", cust(A, me, "customers.profile.update.v1"), erase, [A.tenant, me]))?.code).toBe("MB007");
    expect((await attempt(db, "munim_core", { tenant_id: A.tenant, outlet_ids: "*", role: "staff", member_id: A.staff, command_type: "customers.erasure.request.v1" }, erase, [A.tenant, me]))?.code).toBe("MB001");
    expect(await attempt(db, "munim_core", cust(A, me, "customers.erasure.request.v1"), erase, [A.tenant, me])).toBeNull();
    const row = await db.admin("SELECT name, phone, email, idp_sub, erased_at IS NOT NULL AS erased FROM core.customer WHERE id = $1", [me]);
    expect(row.rows[0]).toEqual({ name: null, phone: null, email: null, idp_sub: null, erased: true });
    expect((await attempt(db, "munim_core", cust(A, me, "customers.profile.update.v1"),
      `UPDATE core.customer SET name = 'Back' WHERE tenant_id = $1 AND id = $2`, [A.tenant, me]))?.code).toBe("MB007");
    const other = await newCustomer(A);
    expect(await attempt(db, "munim_core", ownerCtx(A, { command_type: "customers.erasure.request.v1" }), erase, [A.tenant, other])).toBeNull();
    // the world's order still points at its (unerased) customer; orders are never deleted
    expect((await db.admin(`SELECT count(*)::int n FROM core."order" WHERE customer_id = $1`, [A.customer])).rows[0]!.n).toBe(2);
  });

  test("RED-PROOF: without the erasure trigger, an erasure leaves personal data in place", async () => {
    const x = await db.clone();
    try {
      await x.admin("DROP TRIGGER customer_erasure ON core.customer; ALTER TABLE core.customer DROP CONSTRAINT customer_check1");
      const me = randomUUID();
      await x.withContext("munim_core", cust(A, me, "storefront.guest.create.v1"), (c) =>
        c.query(`INSERT INTO core.customer (tenant_id, id, name, email) VALUES ($1, $2, 'Asha', 'a@example.test')`, [A.tenant, me]));
      await x.withContext("munim_core", cust(A, me, "customers.profile.update.v1"), (c) =>
        c.query(`UPDATE core.customer SET erased_at = now() WHERE tenant_id = $1 AND id = $2`, [A.tenant, me]));
      const row = await x.admin("SELECT name FROM core.customer WHERE id = $1", [me]);
      console.log("RED-PROOF erasure:", row.rows[0]);
      expect(row.rows[0]!.name).toBe("Asha");
    } finally {
      await x.stop();
    }
  });
});

describe("country-pack seed", () => {
  test("rows = pack files on disk; re-seeding is a no-op; a changed document is refused", async () => {
    const files = readdirSync(PACKS_DIR).filter((f) => /^[A-Z]{2}\.json$/.test(f));
    console.log(`packs: ${files.length} files on disk (${files.join(", ")}); seeded ${db.packs?.inserted.join(", ")}`);
    expect(files.length).toBeGreaterThanOrEqual(2);
    expect(db.packs?.inserted.length).toBe(files.length);
    const r = await db.admin("SELECT code FROM platform.country_pack ORDER BY code");
    expect(r.rows.map((x) => `${x.code}.json`)).toEqual(files.sort());
    const c = await db.connect("admin");
    try {
      const again = await seedPacks(c, { log: () => {} });
      expect(again.inserted).toEqual([]);
      expect(again.unchanged.length).toBe(files.length);
      await c.query("UPDATE platform.country_pack SET doc = jsonb_set(doc, '{name}', '\"Changed\"') WHERE code = 'IN'");
      await expect(seedPacks(c, { log: () => {} })).rejects.toThrow(/already exists with a different document/);
    } finally {
      await c.end();
    }
  });
});
