// Gate (0007, rider from T-005): command → table binding. A permitted command writing a book table its
// target_tables do not list → MB008 command_table_mismatch; a listed table → accepted. Same for an approved
// draft's command type (decision branch). A decision that does not list the table still lets an allow-listed
// derivation admit it (an approved import's derived postings). munim_meta.assert_catalog() — the catalog
// post-conditions every migration from 0007 ends with — is green here and red when an orphan book table or an
// uncovered FK is planted. Red-proofs: empty one command's list; restore the 0003 guard without the binding.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { MIGRATIONS_DIR } from "../migrate.ts";
import type { AppContext, TestDb } from "../src/harness.ts";
import { openDb } from "./db.ts";
import { attempt } from "./gates.ts";
import { approveDraft, buildWorld, ownerCtx, type World } from "./world.ts";

let db: TestDb;
let A: World;

beforeAll(async () => {
  db = await openDb();
  A = await buildWorld(db);
});
afterAll(async () => db?.stop());

const channelSql = `INSERT INTO core.channel (tenant_id, id, name, kind) VALUES ($1, gen_random_uuid(), 'Bound', 'pickup') RETURNING origin`;
const asOwner = (command_type: string): AppContext => ownerCtx(A, { command_type });

describe("own-command branch", () => {
  test("inventory.stock.receive.v1 writing core.channel → MB008; tenancy.channel.create.v1 → accepted", async () => {
    const wrong = await attempt(db, "munim_core", asOwner("inventory.stock.receive.v1"), channelSql, [A.tenant]);
    const right = await attempt(db, "munim_core", asOwner("tenancy.channel.create.v1"), channelSql, [A.tenant]);
    console.log(`binding (own command): unlisted → ${wrong?.code} (${wrong?.message}); listed → ${right ? right.code : "accepted"}`);
    expect(wrong?.code).toBe("MB008");
    expect(wrong?.message).toMatch(/inventory\.stock\.receive\.v1 does not list core\.channel/);
    expect(right).toBeNull();
  });

  test("staff with a staff command (inventory.waste.record.v1) writing core.price → MB008", async () => {
    const e = await attempt(db, "munim_core", { tenant_id: A.tenant, outlet_ids: [A.outlets[0]], role: "staff", member_id: A.staff, command_type: "inventory.waste.record.v1" },
      `INSERT INTO core.price (tenant_id, id, item_id, outlet_id, channel_kind, amount_minor, currency, tax_class, valid_from, valid_to)
       VALUES ($1, gen_random_uuid(), $2, $3, 'pickup', 1, 'INR', 'restaurant_5', '2040-01-01', '2040-01-02')`, [A.tenant, A.item, A.outlets[0]]);
    expect(e?.code).toBe("MB008");
  });

  test("an unauthorised role is still MB001 (the binding does not change who may run a command)", async () => {
    const e = await attempt(db, "munim_core", { tenant_id: A.tenant, outlet_ids: "*", role: "staff", member_id: A.staff, command_type: "tenancy.channel.create.v1" }, channelSql, [A.tenant]);
    expect(e?.code).toBe("MB001");
  });
});

describe("decision branch", () => {
  test("an approved inventory.reorder_level.set.v1 draft writing core.price → MB008; writing core.reorder_level → accepted", async () => {
    const price = await approveDraft(db, A, "inventory.reorder_level.set.v1", async (q) => {
      await q(`INSERT INTO core.price (tenant_id, id, item_id, outlet_id, channel_kind, amount_minor, currency, tax_class, valid_from, valid_to)
               VALUES ($1, gen_random_uuid(), $2, $3, 'pickup', 1, 'INR', 'restaurant_5', '2041-01-01', '2041-01-02')`, [A.tenant, A.item, A.outlets[0]]);
    }).then(() => null, (e: { code: string }) => e);
    const level = await approveDraft(db, A, "inventory.reorder_level.set.v1", async (q) => {
      await q(`UPDATE core.reorder_level SET min_qty_milli = 1000, par_qty_milli = 2000 WHERE tenant_id = $1 AND outlet_id = $2`, [A.tenant, A.outlets[0]]);
    }).then(() => null, (e: { code: string }) => e);
    console.log(`binding (decision): unlisted → ${price?.code}; listed → ${level ? level.code : "accepted"}`);
    expect(price?.code).toBe("MB008");
    expect(level).toBeNull();
  });

  test("an approved import's derived posting: the decision does not list the journal, the derivation admits it", async () => {
    let origin: unknown;
    await approveDraft(db, A, "imports.run.commit.v1", async (q) => {
      const s = randomUUID();
      // From the world's committed import run (0015 A2: a settlement posts only from a committed run).
      await q(`INSERT INTO core.settlement (tenant_id, id, channel_id, period_from, period_to, external_ref, net_minor, currency, import_run_id)
               VALUES ($1, $2, $3, '2026-10-08', '2026-10-14', $4, 1000, 'INR',
                       (SELECT r.id FROM core.import_run r WHERE r.tenant_id = $1 AND r.status = 'committed'))`, [A.tenant, s, A.channel, `P-${s}`]);
      await q("SELECT set_config('app.posting_rule', 'finance.post_settlement', true), set_config('app.source_ref', $1, true)", [`core.settlement:${s}`]);
      const r = await q(`WITH je AS (INSERT INTO core.journal_entry (tenant_id, id, entry_date, source_type, source_id, posting_rule)
                                     VALUES ($1, gen_random_uuid(), '2026-10-14', 'core.settlement', $2, 'finance.post_settlement') RETURNING id, origin)
                         INSERT INTO core.posting (tenant_id, id, journal_entry_id, account_id, amount_minor, currency)
                         SELECT $1, gen_random_uuid(), (SELECT id FROM je), $3::uuid, 1000, 'INR' UNION ALL
                         SELECT $1, gen_random_uuid(), (SELECT id FROM je), $4::uuid, -1000, 'INR' RETURNING origin`,
        [A.tenant, s, A.accounts.cash, A.accounts.sales]);
      origin = r.rows[0].origin;
    });
    expect(origin).toMatchObject({ kind: "derivation", rule_id: "finance.post_settlement" });
  });
});

describe("binding red-proofs", () => {
  test("RED-PROOF: emptying orders.place.v1's target_tables → placing an order is refused (accepted half red)", async () => {
    const x = await db.clone();
    try {
      await x.admin("UPDATE core.command_authority SET target_tables = '{}', customer_target_tables = '{}' WHERE command_type = 'orders.place.v1'");
      const e = await attempt(x, "munim_core", asOwner("orders.place.v1"),
        `INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, kind, subtotal_minor, total_minor, currency, pricing_snapshot)
         VALUES ($1, gen_random_uuid(), $2, $3, 'takeaway', 100, 100, 'INR', '{}')`, [A.tenant, A.outlets[0], A.channel]);
      console.log("RED-PROOF binding (emptied list):", e?.code);
      expect(e?.code).toBe("MB008");
    } finally {
      await x.stop();
    }
  });

  test("RED-PROOF: the 0003 guard (no binding) re-installed → the unlisted channel write is accepted", async () => {
    const x = await db.clone();
    try {
      const sql = readFileSync(`${MIGRATIONS_DIR}0003_core_foundation.sql`, "utf8");
      const fn = sql.slice(sql.indexOf("CREATE FUNCTION core.guard_book_write()"), sql.indexOf("REVOKE ALL ON FUNCTION core.guard_book_write()"));
      await x.admin(fn.replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION"));
      const e = await attempt(x, "munim_core", asOwner("inventory.stock.receive.v1"), channelSql, [A.tenant]);
      console.log("RED-PROOF binding (0003 guard):", e);
      expect(e).toBeNull();
    } finally {
      await x.stop();
    }
  });
});

describe("munim_meta.assert_catalog (post-condition run by every migration from 0007)", () => {
  const run = (x: TestDb) => x.admin("SELECT munim_meta.assert_catalog('gate')").then(() => null, (e: Error) => e.message);

  test("green on the migrated database", async () => {
    expect(await run(db)).toBeNull();
  });

  test("RED-PROOF: a planted book table no command or derivation writes → raises", async () => {
    const x = await db.clone();
    try {
      await x.admin(`CREATE TABLE core.planted_book (tenant_id uuid NOT NULL, id uuid NOT NULL, origin jsonb NOT NULL, PRIMARY KEY (tenant_id, id));
        ALTER TABLE core.planted_book ENABLE ROW LEVEL SECURITY; ALTER TABLE core.planted_book FORCE ROW LEVEL SECURITY;
        CREATE POLICY p ON core.planted_book USING (true);
        CREATE TRIGGER book_guard BEFORE INSERT OR UPDATE ON core.planted_book FOR EACH ROW EXECUTE FUNCTION core.guard_book_write();
        COMMENT ON TABLE core.planted_book IS 'munim:book'; REVOKE ALL ON core.planted_book FROM PUBLIC;`);
      const msg = await run(x);
      console.log("RED-PROOF assert_catalog (orphan):", msg);
      expect(msg).toMatch(/book tables no command or derivation can write: planted_book/);
    } finally {
      await x.stop();
    }
  });

  test("RED-PROOF: dropping an FK's covering index → raises", async () => {
    const x = await db.clone();
    try {
      await x.admin("DROP INDEX core.posting_account_id_fk_idx");
      const msg = await run(x);
      console.log("RED-PROOF assert_catalog (FK index):", msg);
      expect(msg).toMatch(/FKs without a covering index: core\.posting\(posting_tenant_id_account_id_fkey\)/);
    } finally {
      await x.stop();
    }
  });
});
