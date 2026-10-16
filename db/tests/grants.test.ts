// Gates: migration count; role attributes; intel cannot write (N/N from the manifest); service has no book
// grants; tags; definer owners; append-only. Each with its red-proof on a fresh clone.
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { migrate, MIGRATIONS_DIR } from "../migrate.ts";
import type { TestDb } from "../src/harness.ts";
import { openDb } from "./db.ts";
import {
  attempt,
  catalogTags,
  crosstenantObjects,
  functionsExecutableBy,
  ident,
  intelWriteRefusals,
  serviceBookGrants,
} from "./gates.ts";
import {
  ALL_TABLES,
  BOOK_TABLES,
  CORE_TABLES,
  CROSSTENANT_OBJECTS,
  EXPECTED_COUNTS,
  MIGRATIONS,
  SKIPPED_HERE,
  SVC_INSERT_TABLES,
  TABLES,
} from "./manifest.ts";
import { buildWorld, ownerCtx, type World } from "./world.ts";

let db: TestDb;
let A: World;

beforeAll(async () => {
  db = await openDb();
  A = await buildWorld(db);
});
afterAll(async () => db?.stop());

async function svcInsertTables(x: TestDb): Promise<string[]> {
  const r = await x.admin<{ t: string }>(`
    SELECT s.nspname || '.' || c.relname AS t FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
     WHERE s.nspname IN ('core', 'evidence', 'intel', 'platform') AND c.relkind = 'r'
       AND (has_table_privilege('munim_svc', c.oid, 'INSERT') OR has_any_column_privilege('munim_svc', c.oid, 'INSERT'))
     ORDER BY 1`);
  return r.rows.map((x) => x.t);
}

async function withClone(fn: (x: TestDb) => Promise<void>) {
  const x = await db.clone();
  try {
    await fn(x);
  } finally {
    await x.stop();
  }
}

const appliedNames = async (x: TestDb) =>
  (await x.admin("SELECT name FROM munim_meta.schema_migrations ORDER BY version")).rows.map((r) => r.name as string);

describe("migrations", () => {
  test("migration count = 34 applied, names and order match the manifest, 0013_embeddings skipped loudly", async () => {
    const names = await appliedNames(db);
    console.log(`migrations: ${names.length} applied — ${names.join(", ")}; skipped ${JSON.stringify(db.migration.skipped)}`);
    expect(names).toEqual([...MIGRATIONS]);
    expect(names.length).toBe(34);
    expect(db.migration.skipped).toEqual(SKIPPED_HERE);
  });

  test("RED-PROOF: a planted 0036 applied to a clone → count/names no longer match the manifest", async () => {
    await withClone(async (x) => {
      const dir = mkdtempSync(join(tmpdir(), "munim-count-"));
      try {
        cpSync(MIGRATIONS_DIR, dir, { recursive: true });
        writeFileSync(join(dir, "0036_planted.sql"), "CREATE TABLE intel.planted (id int);\n");
        const c = await x.connect("admin");
        try {
          await migrate(c, { dir, log: () => {} });
        } finally {
          await c.end();
        }
        const names = await appliedNames(x);
        console.log(`RED-PROOF migration count: ${names.length} applied, last ${names.at(-1)}`);
        expect(names).not.toEqual([...MIGRATIONS]);
        expect(names.length).toBe(35);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  test("every table in our schemas is in the manifest and vice versa", async () => {
    const r = await db.admin<{ t: string }>(`
      SELECT s.nspname || '.' || c.relname AS t FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
       WHERE s.nspname IN ('core', 'evidence', 'intel', 'platform', 'intel_ro', 'munim_meta') AND c.relkind = 'r' ORDER BY 1`);
    expect(r.rows.map((x) => x.t)).toEqual([...ALL_TABLES].sort());
    expect(ALL_TABLES.length).toBe(EXPECTED_COUNTS.all);
  });

  test("role attributes: only munim_crosstenant bypasses RLS; runtime roles log in; nobody is superuser", async () => {
    const r = await db.admin(`SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname LIKE 'munim\\_%' ORDER BY 1`);
    expect(r.rows).toEqual([
      { rolname: "munim_core", rolsuper: false, rolbypassrls: false, rolcanlogin: true },
      { rolname: "munim_crosstenant", rolsuper: false, rolbypassrls: true, rolcanlogin: false },
      { rolname: "munim_intel_ro", rolsuper: false, rolbypassrls: false, rolcanlogin: true },
      { rolname: "munim_migrator", rolsuper: false, rolbypassrls: false, rolcanlogin: false },
      { rolname: "munim_platform", rolsuper: false, rolbypassrls: false, rolcanlogin: true },
      { rolname: "munim_svc", rolsuper: false, rolbypassrls: false, rolcanlogin: true },
      { rolname: "munim_view_owner", rolsuper: false, rolbypassrls: false, rolcanlogin: false },
    ]);
  });

  test("no runtime role owns a table (owners bypass RLS without FORCE — gotcha 3)", async () => {
    const r = await db.admin(`
      SELECT count(*)::int n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
       WHERE s.nspname IN ('core', 'evidence', 'intel', 'platform', 'munim_meta') AND c.relkind IN ('r', 'v')
         AND c.relowner NOT IN ('munim_migrator'::regrole, 'munim_crosstenant'::regrole)`);
    expect(r.rows[0]!.n).toBe(0);
  });
});

describe("intel cannot write", () => {
  test(`INSERT/UPDATE/DELETE/TRUNCATE as munim_intel_ro → 42501 on N/N tables (N = ${EXPECTED_COUNTS.all})`, async () => {
    const r = await intelWriteRefusals(db, ALL_TABLES);
    console.log(`intel cannot write: ${r.attempts - r.failures.length}/${r.attempts} attempts refused over ${ALL_TABLES.length} tables`);
    expect(r.attempts).toBe(EXPECTED_COUNTS.all * 4);
    expect(r.failures).toEqual([]);
  });

  test("functions in our schemas executable by munim_intel_ro = 0", async () => {
    const f = await functionsExecutableBy(db, "munim_intel_ro");
    console.log(`intel executable functions: ${f.length}`);
    expect(f).toEqual([]);
    // positive control: the sweeper function IS executable by munim_svc
    expect(await functionsExecutableBy(db, "munim_svc")).toEqual([
      "core.active_tenants()",
      "core.outbox_claim(integer,interval,interval)",
    ]);
  });

  test("RED-PROOF: GRANT USAGE + INSERT on platform.plan to munim_intel_ro → gate red", async () => {
    await withClone(async (x) => {
      await x.admin("GRANT USAGE ON SCHEMA platform TO munim_intel_ro; GRANT INSERT ON platform.plan TO munim_intel_ro");
      const r = await intelWriteRefusals(x, ALL_TABLES);
      console.log("RED-PROOF intel write:", r.failures);
      expect(r.failures.length).toBe(1);
      expect(r.failures[0]).toMatch(/^platform\.plan INSERT: 23502/);
    });
  });

  test("RED-PROOF: GRANT EXECUTE on core.touch_updated_at() → executable count 1", async () => {
    await withClone(async (x) => {
      await x.admin("GRANT EXECUTE ON FUNCTION core.touch_updated_at() TO munim_intel_ro");
      const f = await functionsExecutableBy(x, "munim_intel_ro");
      console.log("RED-PROOF intel functions:", f);
      expect(f).toEqual(["core.touch_updated_at()"]);
    });
  });
});

describe("service has no book grants", () => {
  test(`munim_svc INSERT/UPDATE on book tables = 0 of ${EXPECTED_COUNTS.book}; true on each listed operational table`, async () => {
    const tags = await catalogTags(db);
    const bookFromTags = [...tags].filter(([, t]) => t === "munim:book").map(([n]) => n);
    expect(bookFromTags.length).toBe(EXPECTED_COUNTS.book);
    const bad = await serviceBookGrants(db, bookFromTags);
    console.log(`service book grants: ${bookFromTags.length - bad.length}/${bookFromTags.length} book tables with none`);
    expect(bad).toEqual([]);
    // Exactly the hand-listed operational tables, both directions (catalog vs manifest).
    expect(await svcInsertTables(db)).toEqual([...SVC_INSERT_TABLES].sort());
  });

  test("RED-PROOF: GRANT INSERT on the operational core.reconciliation_break to munim_svc → set differs", async () => {
    await withClone(async (x) => {
      await x.admin("GRANT INSERT ON core.reconciliation_break TO munim_svc");
      const got = await svcInsertTables(x);
      console.log("RED-PROOF svc insert set: extra", got.filter((t) => !SVC_INSERT_TABLES.includes(t)));
      expect(got).toEqual([...SVC_INSERT_TABLES, "core.reconciliation_break"].sort());
    });
  });

  test("a service write to a book table fails with 42501 before any trigger", async () => {
    const e = await attempt(db, "munim_svc", { tenant_id: A.tenant, outlet_ids: "*" },
      `INSERT INTO core.price (tenant_id, id, item_id, outlet_id, channel_kind, amount_minor, currency, tax_class, valid_from)
       VALUES ($1, gen_random_uuid(), $2, $3, 'counter', 1, 'INR', 'restaurant_5', '2030-01-01')`, [A.tenant, A.item, A.outlets[0]]);
    expect(e?.code).toBe("42501");
    expect(e?.message).toBe("permission denied for table price");
  });

  test("RED-PROOF: GRANT INSERT on core.price to munim_svc → gate red", async () => {
    await withClone(async (x) => {
      await x.admin("GRANT INSERT ON core.price TO munim_svc");
      const bad = await serviceBookGrants(x, BOOK_TABLES);
      console.log("RED-PROOF service grants:", bad);
      expect(bad).toEqual(['"core"."price": svc has INSERT/UPDATE']);
    });
  });

  test("RED-PROOF: a column-level UPDATE grant is caught too", async () => {
    await withClone(async (x) => {
      await x.admin("GRANT UPDATE (valid_to) ON core.price TO munim_svc");
      const bad = await serviceBookGrants(x, BOOK_TABLES);
      expect(bad).toEqual(['"core"."price": svc has INSERT/UPDATE']);
    });
  });
});

describe("tags", () => {
  test("tagged tables = all tables in core, and each tag equals the manifest", async () => {
    const tags = await catalogTags(db);
    expect([...tags.keys()]).toEqual([...CORE_TABLES].sort());
    const wrong = [...tags].filter(([n, t]) => t !== `munim:${TABLES[n]!.tag}`);
    console.log(`tags: ${tags.size - wrong.length}/${tags.size} core tables tagged as the manifest says`);
    expect(wrong).toEqual([]);
    expect(tags.size).toBe(EXPECTED_COUNTS.core);
  });

  test("RED-PROOF: untag core.deal → red", async () => {
    await withClone(async (x) => {
      await x.admin("COMMENT ON TABLE core.deal IS NULL");
      const wrong = [...(await catalogTags(x))].filter(([n, t]) => t !== `munim:${TABLES[n]!.tag}`);
      console.log("RED-PROOF tags:", wrong);
      expect(wrong).toEqual([["core.deal", null]]);
    });
  });
});

describe("definer owners", () => {
  test("SECURITY DEFINER functions + munim_crosstenant-owned objects = exactly the three", async () => {
    const o = await crosstenantObjects(db);
    console.log(`definer owners: ${o.length} — ${o.join(", ")}`);
    expect(o).toEqual(CROSSTENANT_OBJECTS);
    const owners = await db.admin(`
      SELECT p.proname, pg_get_userbyid(p.proowner) AS owner, p.prosecdef FROM pg_proc p
       WHERE p.oid IN ('core.outbox_claim(integer,interval,interval)'::regprocedure, 'core.active_tenants()'::regprocedure) ORDER BY 1`);
    expect(owners.rows).toEqual([
      { proname: "active_tenants", owner: "munim_crosstenant", prosecdef: true },
      { proname: "outbox_claim", owner: "munim_crosstenant", prosecdef: true },
    ]);
  });

  test("the definer functions work for munim_svc across tenants (accepted case)", async () => {
    const B = await buildWorld(db);
    const c = await db.connect("munim_svc");
    try {
      const t = await c.query("SELECT core.active_tenants() AS t");
      const ids = t.rows.map((x) => x.t);
      expect(ids).toContain(A.tenant);
      expect(ids).toContain(B.tenant);
      const claimed = await c.query("SELECT tenant_id FROM core.outbox_claim(1000, interval '0 seconds')");
      expect(new Set(claimed.rows.map((x) => x.tenant_id))).toEqual(new Set(ids));
      // leased: a second claim within the lease returns nothing
      expect((await c.query("SELECT count(*)::int n FROM core.outbox_claim(1000, interval '0 seconds')")).rows[0].n).toBe(0);
      const reg = await db.withContext("munim_platform", {}, (p) => p.query("SELECT count(*)::int n FROM platform.tenant_registry"));
      expect(reg.rows[0].n).toBeGreaterThanOrEqual(2);
    } finally {
      await c.end();
    }
  });

  test("RED-PROOF: one more SECURITY DEFINER function → red", async () => {
    await withClone(async (x) => {
      await x.admin(`CREATE FUNCTION core.sneaky() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'`);
      const o = await crosstenantObjects(x);
      console.log("RED-PROOF definer owners:", o);
      expect(o).toEqual([...CROSSTENANT_OBJECTS, "core.sneaky"].sort());
    });
  });
});

describe("append-only", () => {
  const cases = [
    { t: "core.stock_movement", set: "qty_milli = qty_milli" },
    { t: "core.audit_log", set: "action = action" },
    { t: "core.order_event", set: "reason = reason" },
    { t: "core.tender", set: "amount_minor = amount_minor" },
  ];

  test("UPDATE and DELETE as munim_core → 42501 on movement, audit, order_event, tender", async () => {
    const failures: string[] = [];
    for (const { t, set } of cases) {
      for (const sql of [`UPDATE ${ident(t)} SET ${set}`, `DELETE FROM ${ident(t)}`]) {
        const e = await attempt(db, "munim_core", ownerCtx(A), sql);
        if (e?.code !== "42501" || !/^permission denied for table/.test(e.message)) failures.push(`${sql}: ${e?.code ?? "ok"}`);
      }
    }
    console.log(`append-only: ${cases.length * 2 - failures.length}/${cases.length * 2} refused`);
    expect(failures).toEqual([]);
  });

  test("INSERT is accepted (audit entry as the owner's command)", async () => {
    const e = await attempt(db, "munim_core", ownerCtx(A),
      `INSERT INTO core.audit_log (tenant_id, actor, action, entity, entity_id) VALUES ($1, '{}', 'x', 'core.item', 'x')`, [A.tenant]);
    expect(e).toBeNull();
  });

  test("no DELETE or TRUNCATE privilege for any munim role on any table in our schemas", async () => {
    const r = await db.admin(`
      SELECT count(*)::int n FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace,
             unnest(ARRAY['munim_core','munim_svc','munim_platform','munim_intel_ro','munim_crosstenant','munim_view_owner']) r
       WHERE s.nspname IN ('core','evidence','intel','platform','munim_meta') AND c.relkind = 'r'
         AND has_table_privilege(r, c.oid, 'DELETE,TRUNCATE')`);
    expect(r.rows[0]!.n).toBe(0);
  });

  test("RED-PROOF: GRANT DELETE on core.stock_movement to munim_core → delete succeeds → red", async () => {
    await withClone(async (x) => {
      await x.admin("GRANT DELETE ON core.stock_movement TO munim_core");
      const e = await attempt(x, "munim_core", ownerCtx(A), "DELETE FROM core.stock_movement");
      console.log("RED-PROOF append-only: DELETE returned", e);
      expect(e).toBeNull();
    });
  });
});
