// 0030 gates (T-115: menu display order; lane B1 report §6 items 2–3; migrator lane D). Expected values are typed by hand here;
// none is read from the migration under test. Every refusal is paired with an accept.
//   P1    `position` on core.item / variant / option_group / option: every existing row reads 0 (the default); under
//         catalogue.item.upsert.v1 (owner) a new variant / option group / option / item is inserted with a position and the
//         three child tables' positions are updated (read back as written); -1 → 23514 on each table; core.item.position
//         is set only on INSERT: an UPDATE of it is refused (42501)
//   GUARD the column is a book column: no command → MB001; another command's type (orders.place.v1) → MB008; a staff
//         member's catalogue.item.upsert.v1 → MB001; the owner's upsert → accepted
//   G     munim_core UPDATE lists exactly as typed below; munim_svc / munim_intel_ro cannot write position (42501);
//         munim_intel_ro cannot read it; intel_ro.item_names does not expose it
//   ISO   the four tables still isolate: tenant B reads 0 of tenant A's non-zero positions
// Red-proofs: db/tests/redproof-0030.sh (each gate red with a non-zero exit).
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { AppContext, TestDb } from "../src/harness.ts";
import { openDb } from "./db.ts";
import { attempt } from "./gates.ts";
import { buildWorld, ownerCtx, uuidv7 as u, type World } from "./world.ts";

let db: TestDb;
let A: World;
let B: World;
let variant: string;
let group: string;
let option: string;

const upsert = (): AppContext => ownerCtx(A, { command_type: "catalogue.item.upsert.v1" });
const FOUR = ["core.item", "core.variant", "core.option_group", "core.option"];

beforeAll(async () => {
  db = await openDb();
  A = await buildWorld(db);
  B = await buildWorld(db);
  const ids = (await db.admin<{ variant: string; grp: string; option: string }>(
    `SELECT v.id variant, g.id grp, o.id option FROM core.variant v JOIN core.option_group g ON g.tenant_id = v.tenant_id AND g.item_id = v.item_id
       JOIN core.option o ON o.tenant_id = g.tenant_id AND o.option_group_id = g.id WHERE v.tenant_id = $1 AND v.item_id = $2`, [A.tenant, A.item])).rows[0]!;
  variant = ids.variant;
  group = ids.grp;
  option = ids.option;
});
afterAll(async () => db?.stop());

const positions = async (tenant: string) => (await db.admin<{ t: string; n: number; nonzero: number }>(
  `SELECT t, n::int, nonzero::int FROM (
     SELECT 'item' t, count(*) n, count(*) FILTER (WHERE position <> 0) nonzero FROM core.item WHERE tenant_id = $1
     UNION ALL SELECT 'variant', count(*), count(*) FILTER (WHERE position <> 0) FROM core.variant WHERE tenant_id = $1
     UNION ALL SELECT 'option_group', count(*), count(*) FILTER (WHERE position <> 0) FROM core.option_group WHERE tenant_id = $1
     UNION ALL SELECT 'option', count(*), count(*) FILTER (WHERE position <> 0) FROM core.option WHERE tenant_id = $1) x ORDER BY t`, [tenant])).rows;

describe("P1 position (book column, catalogue.item.upsert.v1)", () => {
  test("existing rows read 0; the owner's upsert inserts and updates positions, read back as written", async () => {
    const before = await positions(A.tenant);
    console.log("P1 before:", JSON.stringify(before));
    expect(before.every((r) => r.n > 0 && r.nonzero === 0)).toBe(true);
    const [item2, v2, g2, o2] = [u(), u(), u(), u()];
    await db.withContext("munim_core", upsert(), async (c) => {
      await c.query(`INSERT INTO core.item (tenant_id, id, kind, name_key, category, position) VALUES ($1, $2, 'dish', 'menu.order_probe', 'mains', 7)`, [A.tenant, item2]);
      await c.query(`INSERT INTO core.variant (tenant_id, id, item_id, name_key, position) VALUES ($1, $2, $3, 'menu.order_probe.large', 1)`, [A.tenant, v2, item2]);
      await c.query(`INSERT INTO core.option_group (tenant_id, id, item_id, name_key, max_select, position) VALUES ($1, $2, $3, 'menu.probe_group', 1, 2)`, [A.tenant, g2, item2]);
      await c.query(`INSERT INTO core.option (tenant_id, id, option_group_id, name_key, price_delta_minor, currency, position) VALUES ($1, $2, $3, 'menu.probe_opt', 0, 'INR', 3)`,
        [A.tenant, o2, g2]);
      await c.query(`UPDATE core.variant SET position = 4 WHERE id = $1`, [variant]);
      await c.query(`UPDATE core.option_group SET position = 5 WHERE id = $1`, [group]);
      await c.query(`UPDATE core.option SET position = 6 WHERE id = $1`, [option]);
    });
    const r = (await db.admin(`SELECT (SELECT position FROM core.item WHERE id = $1) i, (SELECT position FROM core.variant WHERE id = $2) v2,
        (SELECT position FROM core.option_group WHERE id = $3) g2, (SELECT position FROM core.option WHERE id = $4) o2,
        (SELECT position FROM core.variant WHERE id = $5) v, (SELECT position FROM core.option_group WHERE id = $6) g, (SELECT position FROM core.option WHERE id = $7) o`,
      [item2, v2, g2, o2, variant, group, option])).rows[0];
    console.log("P1 read back:", JSON.stringify(r));
    expect(r).toEqual({ i: 7, v2: 1, g2: 2, o2: 3, v: 4, g: 5, o: 6 });
  });

  test("CHECKs: -1 → 23514 on each table, 0 accepted; core.item.position UPDATE → 42501 (set on INSERT only)", async () => {
    const ids: Record<string, string> = { "core.variant": variant, "core.option_group": group, "core.option": option };
    const refused: Array<string | undefined> = [];
    for (const [t, id] of Object.entries(ids)) {
      refused.push((await attempt(db, "munim_core", upsert(), `UPDATE ${t} SET position = -1 WHERE id = $1`, [id]))?.code);
      expect(await attempt(db, "munim_core", upsert(), `UPDATE ${t} SET position = 0 WHERE id = $1`, [id])).toBeNull();
    }
    refused.push((await attempt(db, "munim_core", upsert(),
      `INSERT INTO core.item (tenant_id, id, kind, name_key, category, position) VALUES ($1, $2, 'dish', 'menu.order_neg', 'mains', -1)`, [A.tenant, u()]))?.code);
    const itemUpdate = await attempt(db, "munim_core", upsert(), `UPDATE core.item SET position = 3 WHERE id = $1`, [A.item]);
    console.log("P1 CHECK refusals:", refused.join(","), "item UPDATE:", itemUpdate?.code);
    expect(refused).toEqual(["23514", "23514", "23514", "23514"]);
    expect(itemUpdate?.code).toBe("42501");
  });
});

describe("GUARD position sits behind the book guard", () => {
  test("no command → MB001; orders.place.v1 → MB008; staff upsert → MB001; owner upsert → accepted", async () => {
    const sql = `UPDATE core.variant SET position = 9 WHERE id = $1`;
    const none = await attempt(db, "munim_core", { tenant_id: A.tenant, outlet_ids: "*", role: "owner", member_id: A.owner }, sql, [variant]);
    const other = await attempt(db, "munim_core", ownerCtx(A, { command_type: "orders.place.v1" }), sql, [variant]);
    const staff = await attempt(db, "munim_core", { tenant_id: A.tenant, outlet_ids: [A.outlets[0]], role: "staff", member_id: A.staff, command_type: "catalogue.item.upsert.v1" }, sql, [variant]);
    console.log("GUARD:", [none, other, staff].map((e) => e?.code).join(","));
    expect([none?.code, other?.code, staff?.code]).toEqual(["MB001", "MB008", "MB001"]);
    expect(await attempt(db, "munim_core", upsert(), sql, [variant])).toBeNull();
  });
});

describe("G privileges on position", () => {
  test("munim_core UPDATE lists, exactly (hand-typed: the 0029 lists + position on the three child tables; core.item unchanged)", async () => {
    const want: Record<string, string> = {
      "core.item": "active,barcode,brand_id,category,currency,description,diet,display_name,mrp_minor,name_key,stock_ingredient_id",
      "core.variant": "active,barcode,description,display_name,name_key,position",
      "core.option_group": "description,display_name,max_select,min_select,name_key,position,required",
      "core.option": "active,description,display_name,name_key,position,price_delta_minor",
    };
    for (const [t, cols] of Object.entries(want)) {
      const r = await db.admin<{ cols: string | null; tbl: boolean; ins: boolean }>(`SELECT (SELECT string_agg(a.attname, ',' ORDER BY a.attname) FROM pg_attribute a, aclexplode(a.attacl) x
        WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND x.grantee = 'munim_core'::regrole AND x.privilege_type = 'UPDATE') cols,
        has_table_privilege('munim_core', $1, 'UPDATE') tbl, has_table_privilege('munim_core', $1, 'INSERT') ins`, [t]);
      expect([t, r.rows[0]!.cols, r.rows[0]!.tbl, r.rows[0]!.ins]).toEqual([t, cols, false, true]);
    }
  });

  test("munim_svc and munim_intel_ro cannot write position; munim_intel_ro cannot read it; intel_ro.item_names does not show it", async () => {
    const svc = await attempt(db, "munim_svc", { tenant_id: A.tenant, outlet_ids: "*" }, `UPDATE core.variant SET position = 2 WHERE id = $1`, [variant]);
    const intelW = await attempt(db, "munim_intel_ro", { tenant_id: A.tenant }, `UPDATE core.option SET position = 2 WHERE id = $1`, [option]);
    const intelR = await attempt(db, "munim_intel_ro", { tenant_id: A.tenant }, `SELECT position FROM core.item`);
    console.log("G:", [svc, intelW, intelR].map((e) => e?.code).join(","));
    expect([svc?.code, intelW?.code, intelR?.code]).toEqual(["42501", "42501", "42501"]);
    // The attempts above can be refused before the column is reached, so the catalog is read too (4 tables × 2 roles).
    const priv = await db.admin<{ c: string }>(`SELECT r || ':' || t AS c FROM unnest(ARRAY['munim_intel_ro', 'munim_svc']) r, unnest($1::text[]) t
       WHERE has_column_privilege(r, t, 'position', 'INSERT') OR has_column_privilege(r, t, 'position', 'UPDATE')
          OR (r = 'munim_intel_ro' AND has_column_privilege(r, t, 'position', 'SELECT'))`, [FOUR]);
    expect(priv.rows.map((x) => x.c)).toEqual([]);
    const cols = (await db.admin<{ c: string }>(`SELECT attname c FROM pg_attribute WHERE attrelid = 'intel_ro.item_names'::regclass AND attnum > 0 ORDER BY attnum`)).rows.map((x) => x.c);
    expect(cols).toEqual(["id", "kind", "name_key", "category"]);
  });
});

describe("ISO the four tables still isolate", () => {
  test("tenant B's context reads 0 of A's non-zero positions; A's own context reads them", async () => {
    await db.withContext("munim_core", upsert(), (c) => c.query(`UPDATE core.option SET position = 8 WHERE id = $1`, [option]));
    const read = (w: World) => db.withContext("munim_core", ownerCtx(w, { outlet_ids: "*" }), (c) => c.query<{ n: number }>(
      `SELECT ((SELECT count(*) FROM core.item WHERE position <> 0) + (SELECT count(*) FROM core.variant WHERE position <> 0)
             + (SELECT count(*) FROM core.option_group WHERE position <> 0) + (SELECT count(*) FROM core.option WHERE position <> 0))::int n`));
    const [a, b] = [(await read(A)).rows[0]!.n, (await read(B)).rows[0]!.n];
    console.log(`ISO: A sees ${a}, B sees ${b}`);
    expect(a).toBeGreaterThan(0);
    expect(b).toBe(0);
  });
});
