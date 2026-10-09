// Gate: tenant isolation (02-schema §8 row 1) and outlet scope (03-architecture T3).
// Expected set = every table in our schemas with a tenant_id column (pg_attribute), which must equal the
// hand-written manifest. Red-proofs: NO FORCE (catalog half), a USING (true) policy (0-of-B half) and a
// dropped policy (≥ 1-own half), each on its own database clone.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { TestDb } from "../src/harness.ts";
import { openDb, pgError } from "./db.ts";
import { catalogTenantTables, isolationCatalog, isolationRows, outletScopeRows } from "./gates.ts";
import { EXPECTED_COUNTS, OUTLET_TABLES, PACK_SCOPED_TABLES, TENANT_TABLES } from "./manifest.ts";
import { buildWorld, type World } from "./world.ts";

let db: TestDb;
let A: World;
let B: World;

beforeAll(async () => {
  db = await openDb();
  A = await buildWorld(db);
  B = await buildWorld(db, { country: "AU" });
});
afterAll(async () => db?.stop());

describe("isolation", () => {
  test("expected set from pg_attribute equals the manifest", async () => {
    const live = await catalogTenantTables(db);
    console.log(`isolation: ${live.length} tables with tenant_id (manifest ${TENANT_TABLES.length}, hand count ${EXPECTED_COUNTS.tenant})`);
    expect(live.length).toBeGreaterThan(0);
    expect(live).toEqual([...TENANT_TABLES].sort());
    expect(live.length).toBe(EXPECTED_COUNTS.tenant);
  });

  test("every tenant table: RLS enabled + forced + ≥ 1 policy", async () => {
    const r = await isolationCatalog(db);
    console.log(`isolation catalog: ${r.checked.length - r.failures.length}/${r.checked.length} ok`);
    expect(r.checked.length).toBe(EXPECTED_COUNTS.tenant);
    expect(r.failures).toEqual([]);
  });

  test("as tenant A: ≥ 1 own row and 0 of B's in every tenant table (and the reverse)", async () => {
    const ab = await isolationRows(db, TENANT_TABLES, A.tenant, B.tenant);
    const ba = await isolationRows(db, TENANT_TABLES, B.tenant, A.tenant);
    console.log(`isolation rows: A ${ab.checked - ab.failures.length}/${ab.checked}, B ${ba.checked - ba.failures.length}/${ba.checked}`);
    expect(ab.checked).toBe(EXPECTED_COUNTS.tenant);
    expect(ab.failures).toEqual([]);
    // B is AU: its pack prepares no payroll, so exactly the pack-scoped tables hold no own rows — and
    // nothing else is exempt (the 0-of-A half still covers them).
    expect(ba.failures).toEqual(PACK_SCOPED_TABLES.AU!.map((t) => `${t}: own rows = 0`));
  });

  test("no context → 0 rows, never an error — including after a SET LOCAL on the same connection", async () => {
    const c = await db.connect("munim_core");
    try {
      await c.query("BEGIN");
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [A.tenant]);
      expect((await c.query("SELECT count(*)::int n FROM core.price")).rows[0].n).toBeGreaterThan(0);
      await c.query("COMMIT");
      // The setting now reads '' (not NULL) on this connection; ''::uuid would raise without nullif.
      expect((await c.query("SELECT current_setting('app.tenant_id', true) v")).rows[0].v).toBe("");
      expect((await c.query("SELECT count(*)::int n FROM core.price")).rows[0].n).toBe(0);
      expect((await c.query(`SELECT count(*)::int n FROM core."order"`)).rows[0].n).toBe(0);
      expect((await c.query("SELECT count(*)::int n FROM core.draft")).rows[0].n).toBe(0);
    } finally {
      await c.end();
    }
  });

  test("writing a row for another tenant is refused by WITH CHECK", async () => {
    const e = await pgError(() =>
      db.withContext("munim_core", { tenant_id: A.tenant, outlet_ids: "*" }, (c) =>
        c.query(`INSERT INTO core.outbox (tenant_id, id, aggregatetype, aggregateid, type, payload)
                 VALUES ($1, gen_random_uuid(), 'x', 'x', 'munim.test.thing.happened.v1', '{}')`, [B.tenant])));
    expect(e?.code).toBe("42501");
    expect(e?.message).toMatch(/row-level security/);
  });
});

describe("outlet scope", () => {
  test("scoped to outlet 1: outlet 2's rows invisible, outlet 1's visible, in every outlet-scoped table", async () => {
    expect(OUTLET_TABLES.length).toBe(EXPECTED_COUNTS.outlet);
    const r = await outletScopeRows(db, OUTLET_TABLES, A.tenant, A.outlets[0], A.outlets[1]);
    console.log(`outlet scope: ${r.checked - r.failures.length}/${r.checked} tables ok`);
    expect(r.failures).toEqual([]);
  });

  test("draft: outlet_ids overlap; transfer: either end", async () => {
    await db.withContext("munim_core", { tenant_id: A.tenant, outlet_ids: [A.outlets[0]] }, async (c) => {
      const d = await c.query("SELECT id FROM core.draft ORDER BY id");
      expect(d.rows.map((x) => x.id)).toEqual([A.drafts[0]]);
      const t = await c.query("SELECT from_outlet_id, to_outlet_id FROM core.transfer");
      expect(t.rows).toEqual([{ from_outlet_id: A.outlets[0], to_outlet_id: A.outlets[1] }]);
    });
    await db.withContext("munim_core", { tenant_id: A.tenant, outlet_ids: [A.outlets[2]] }, async (c) => {
      expect((await c.query("SELECT count(*)::int n FROM core.draft")).rows[0].n).toBe(0);
      expect((await c.query("SELECT count(*)::int n FROM core.transfer")).rows[0].n).toBe(1);
    });
  });
});

describe("isolation red-proofs (each on a fresh clone)", () => {
  test("NO FORCE ROW LEVEL SECURITY on core.price → catalog gate red", async () => {
    const x = await db.clone();
    try {
      await x.admin("ALTER TABLE core.price NO FORCE ROW LEVEL SECURITY");
      const r = await isolationCatalog(x);
      console.log("RED-PROOF isolation/NO FORCE:", r.failures);
      expect(r.failures).toEqual(["core.price: rls=true force=false policies=1"]);
    } finally {
      await x.stop();
    }
  });

  test("a USING (true) policy on core.price → 0-of-B half red", async () => {
    const x = await db.clone();
    try {
      await x.admin("CREATE POLICY leak ON core.price USING (true)");
      const r = await isolationRows(x, TENANT_TABLES, A.tenant, B.tenant);
      console.log("RED-PROOF isolation/USING(true):", r.failures);
      expect(r.failures).toEqual(["core.price: saw 1 of tenant B's rows"]);
    } finally {
      await x.stop();
    }
  });

  test("dropping the policy on core.price → ≥1-own half red (deny-all, gotcha 22)", async () => {
    const x = await db.clone();
    try {
      await x.admin("DROP POLICY tenant_isolation ON core.price");
      const rows = await isolationRows(x, TENANT_TABLES, A.tenant, B.tenant);
      const cat = await isolationCatalog(x);
      console.log("RED-PROOF isolation/DROP POLICY:", rows.failures, cat.failures);
      expect(rows.failures).toEqual(["core.price: own rows = 0"]);
      expect(cat.failures).toEqual(["core.price: rls=true force=true policies=0"]);
    } finally {
      await x.stop();
    }
  });

  test("outlet predicate removed from core.stock_movement → outlet gate red", async () => {
    const x = await db.clone();
    try {
      await x.admin("CREATE POLICY wide ON core.stock_movement USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))");
      const r = await outletScopeRows(x, OUTLET_TABLES, A.tenant, A.outlets[0], A.outlets[1]);
      console.log("RED-PROOF outlet scope:", r.failures);
      expect(r.failures).toEqual(["core.stock_movement: saw 1 out-of-scope rows"]);
    } finally {
      await x.stop();
    }
  });
});
