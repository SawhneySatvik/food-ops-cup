// Gate: tenant isolation (02-schema §8 row 1) and outlet scope (03-architecture T3; 0019 R1-m9: tenant A carries the
// M-C1a fixture, so every outlet-scoped table has rows in outlets 1 and 2).
// Expected set = every table in our schemas with a tenant_id column (pg_attribute), which must equal the
// hand-written manifest. Red-proofs: NO FORCE (catalog half), a USING (true) policy (0-of-B half) and a
// dropped policy (≥ 1-own half), each on its own database clone.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { TestDb } from "../src/harness.ts";
import { openDb, pgError } from "./db.ts";
import { catalogTenantTables, isolationCatalog, isolationRows, outletScopeRows } from "./gates.ts";
import { EXPECTED_COUNTS, OUTLET_NULLABLE, OUTLET_TABLES, PACK_SCOPED_TABLES, PARENT_SCOPED, TENANT_TABLES } from "./manifest.ts";
import { addOutletData } from "./mc1a-fixture.ts";
import { buildWorld, type World } from "./world.ts";

let db: TestDb;
let A: World;
let B: World;

beforeAll(async () => {
  db = await openDb();
  A = await buildWorld(db);
  await addOutletData(db, A);
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
      // core.item: tenant-scoped (core.price is outlet-scoped since 0019 and this context sets no outlets).
      expect((await c.query("SELECT count(*)::int n FROM core.item")).rows[0].n).toBeGreaterThan(0);
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

  test("scoped to outlet 1: tenant-wide rows (outlet_id NULL) stay visible in every nullable outlet-scoped table", async () => {
    const r = await tenantWideRows(db, A);
    console.log(`outlet scope, tenant-wide rows: ${r.checked - r.failures.length}/${r.checked} tables ok`);
    expect(r.checked).toBe(OUTLET_NULLABLE.length);
    expect(r.failures).toEqual([]);
  });

  test("0019 O2: a child row is visible exactly when its parent is (outlet 1 scope: ≥ 1 own, 0 of outlet 2)", async () => {
    const r = await parentScopeRows(db, A);
    console.log(`outlet scope via parent: ${r.checked - r.failures.length}/${r.checked} tables ok`);
    expect(r.checked).toBe(Object.keys(PARENT_SCOPED).length);
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

/** Tenant-wide rows: as outlet 1, every outlet_id-NULL row of a nullable outlet-scoped table is visible (count = admin's). */
async function tenantWideRows(x: TestDb, w: World): Promise<{ checked: number; failures: string[] }> {
  const failures: string[] = [];
  let withRows = 0;
  for (const t of OUTLET_NULLABLE) {
    const all = (await x.admin<{ n: number }>(`SELECT count(*)::int n FROM ${t} WHERE tenant_id = $1 AND outlet_id IS NULL`, [w.tenant])).rows[0]!.n;
    const seen = (await x.withContext("munim_core", { tenant_id: w.tenant, outlet_ids: [w.outlets[0]] }, (c) =>
      c.query<{ n: number }>(`SELECT count(*)::int n FROM ${t} WHERE outlet_id IS NULL`))).rows[0]!.n;
    if (all > 0) withRows++;
    if (seen !== all) failures.push(`${t}: saw ${seen} of ${all} tenant-wide rows`);
  }
  // A gate over empty tables proves nothing: the world + fixture hold tenant-wide rows in 11 of the 15 (not licence,
  // task, conversation, market_signal — counted by hand from buildWorld and tests/mc1a-fixture.ts).
  if (withRows < 11) failures.push(`only ${withRows} tables hold tenant-wide rows`);
  return { checked: OUTLET_NULLABLE.length, failures };
}

/** Children through their parent: as outlet 1, ≥ 1 row under an outlet-1 parent and 0 under an outlet-2 parent. */
async function parentScopeRows(x: TestDb, w: World): Promise<{ checked: number; failures: string[] }> {
  const failures: string[] = [];
  for (const [t, { parent, fk }] of Object.entries(PARENT_SCOPED)) {
    const ids = async (outlet: string) => (await x.admin<{ id: string }>(
      `SELECT c.id FROM ${t} c JOIN ${parent} p ON p.tenant_id = c.tenant_id AND p.id = c.${fk} WHERE c.tenant_id = $1 AND p.outlet_id = $2`,
      [w.tenant, outlet])).rows.map((r) => r.id);
    const [mine, theirs] = [await ids(w.outlets[0]), await ids(w.outlets[1])];
    if (mine.length < 1 || theirs.length < 1) {
      failures.push(`${t}: fixture has ${mine.length} outlet-1 and ${theirs.length} outlet-2 rows (need ≥ 1 each)`);
      continue;
    }
    const seen = new Set((await x.withContext("munim_core", { tenant_id: w.tenant, outlet_ids: [w.outlets[0]] }, (c) =>
      c.query<{ id: string }>(`SELECT id FROM ${t} WHERE id = ANY ($1::uuid[])`, [[...mine, ...theirs]]))).rows.map((y) => y.id));
    if (!mine.every((i) => seen.has(i))) failures.push(`${t}: in-scope rows hidden`);
    const leaked = theirs.filter((i) => seen.has(i)).length;
    if (leaked) failures.push(`${t}: saw ${leaked} out-of-scope rows`);
  }
  return { checked: Object.keys(PARENT_SCOPED).length, failures };
}

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
      await x.admin("DROP POLICY tenant_outlet_isolation ON core.price"); // its only permissive policy since 0019
      const rows = await isolationRows(x, TENANT_TABLES, A.tenant, B.tenant);
      const cat = await isolationCatalog(x);
      console.log("RED-PROOF isolation/DROP POLICY:", rows.failures, cat.failures);
      expect(rows.failures).toEqual(["core.price: own rows = 0"]);
      expect(cat.failures).toEqual(["core.price: rls=true force=true policies=0"]);
    } finally {
      await x.stop();
    }
  });

  test("0019: a tenant-only policy beside the outlet policy on core.journal_entry and core.price → outlet gate red", async () => {
    const x = await db.clone();
    try {
      for (const t of ["journal_entry", "price"]) {
        await x.admin(`CREATE POLICY wide ON core.${t} USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))`);
      }
      const r = await outletScopeRows(x, OUTLET_TABLES, A.tenant, A.outlets[0], A.outlets[1]);
      console.log("RED-PROOF 0019 outlet scope:", r.failures);
      expect(r.failures.map((f) => f.split(":")[0]).sort()).toEqual(["core.journal_entry", "core.price"]);
    } finally {
      await x.stop();
    }
  });

  test("0019: the outlet-NULL clause removed from core.settlement → tenant-wide gate red", async () => {
    const x = await db.clone();
    try {
      await x.admin(`ALTER POLICY tenant_outlet_isolation ON core.settlement USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid)
        AND ((SELECT current_setting('app.outlet_ids', true)) = '{*}'
             OR outlet_id = ANY ((SELECT nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}'))::uuid[])))`);
      const r = await tenantWideRows(x, A);
      console.log("RED-PROOF 0019 tenant-wide rows:", r.failures);
      expect(r.failures).toEqual(["core.settlement: saw 0 of 1 tenant-wide rows"]);
    } finally {
      await x.stop();
    }
  });

  test("0019: a tenant-only policy beside the parent policy on core.settlement_line → parent gate red", async () => {
    const x = await db.clone();
    try {
      await x.admin("CREATE POLICY wide ON core.settlement_line USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))");
      const r = await parentScopeRows(x, A);
      console.log("RED-PROOF 0019 via parent:", r.failures);
      expect(r.failures.length).toBe(1);
      expect(r.failures[0]).toMatch(/^core\.settlement_line: saw [1-9][0-9]* out-of-scope rows$/);
    } finally {
      await x.stop();
    }
  });

  test("outlet predicate removed from core.stock_movement → outlet gate red", async () => {
    const x = await db.clone();
    try {
      await x.admin("CREATE POLICY wide ON core.stock_movement USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))");
      const r = await outletScopeRows(x, OUTLET_TABLES, A.tenant, A.outlets[0], A.outlets[1]);
      const theirs = (await x.admin<{ n: number }>("SELECT count(*)::int n FROM core.stock_movement WHERE tenant_id = $1 AND outlet_id = $2",
        [A.tenant, A.outlets[1]])).rows[0]!.n;
      console.log("RED-PROOF outlet scope:", r.failures);
      expect(theirs).toBeGreaterThan(0);
      expect(r.failures).toEqual([`core.stock_movement: saw ${theirs} out-of-scope rows`]);
    } finally {
      await x.stop();
    }
  });
});
