// 0029 gates (T-099, docs/kit/gaps.md G-01, G-04, G-14; migrator lane b-99). Expected values are typed by hand here; none is
// read from the migration under test. Every refusal is paired with an accept.
//   D1   display text and diet: catalogue.item.upsert.v1 (owner) writes display_name / description on item, variant, option
//        group and option and diet on the item (0 → 1 row each, reads back as written, a `<script>` string unchanged); NULL is
//        the default; the CHECKs refuse '' / 121 chars / 501 chars / diet 'meat' (23514) and admit 120 / 500 / each diet value
//   D2   core.outlet.phone: tenancy.outlet.update.v1 writes an E.164 number; '12345' and '+0123456789' → 23514
//   GUARD the new columns are book columns: no command → MB001; another command's type (orders.place.v1) → MB008;
//        a staff member's catalogue.item.upsert.v1 → MB001 (owner/manager only); a draft-free owner command → accepted
//   G    munim_core UPDATE lists exactly as typed below; munim_svc / munim_intel_ro cannot write them (42501); munim_intel_ro
//        cannot read them (42501); intel_ro.item_names exposes none of them
//   ISO  the five tables still isolate: tenant B reads 0 of tenant A's display text
//   X1   core.cares_network_listings returns outlet_tz = the listing outlet's tz; munim_crosstenant reads exactly
//        tenant_id, id, name, tz of core.outlet
// Red-proofs: db/tests/redproof-0029.sh (each gate red with a non-zero exit).
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

const owner = (extra: AppContext = {}): AppContext => ownerCtx(A, extra);
const upsert = () => owner({ command_type: "catalogue.item.upsert.v1" });
const SCRIPT = `<script>alert("x")</script> Paneer & "Tikka"`;

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

const count = async (sql: string, params: unknown[] = []) => (await db.admin<{ n: number }>(sql, params)).rows[0]!.n;

describe("D1 display text and diet (book columns, catalogue.item.upsert.v1)", () => {
  test("owner upsert writes all four tables: 0 → 1 row each with display text; reads back as written", async () => {
    const before = await count(`SELECT (SELECT count(*) FROM core.item WHERE tenant_id = $1 AND display_name IS NOT NULL)
                                     + (SELECT count(*) FROM core.variant WHERE tenant_id = $1 AND display_name IS NOT NULL)
                                     + (SELECT count(*) FROM core.option_group WHERE tenant_id = $1 AND display_name IS NOT NULL)
                                     + (SELECT count(*) FROM core.option WHERE tenant_id = $1 AND display_name IS NOT NULL) AS n`, [A.tenant]);
    expect(Number(before)).toBe(0);
    await db.withContext("munim_core", upsert(), async (c) => {
      await c.query(`UPDATE core.item SET display_name = $2, description = 'Charred cottage cheese, mint chutney', diet = 'veg' WHERE id = $1`, [A.item, SCRIPT]);
      await c.query(`UPDATE core.variant SET display_name = 'Full plate', description = 'Eight pieces' WHERE id = $1`, [variant]);
      await c.query(`UPDATE core.option_group SET display_name = 'Spice level', description = 'Pick one' WHERE id = $1`, [group]);
      await c.query(`UPDATE core.option SET display_name = 'Hot', description = 'Extra green chilli' WHERE id = $1`, [option]);
    });
    const r = (await db.admin(`SELECT i.display_name i, i.description d, i.diet, v.display_name v, g.display_name g, o.display_name o
      FROM core.item i, core.variant v, core.option_group g, core.option o WHERE i.id = $1 AND v.id = $2 AND g.id = $3 AND o.id = $4`,
      [A.item, variant, group, option])).rows[0];
    console.log("D1 read back:", JSON.stringify(r));
    expect(r).toEqual({ i: SCRIPT, d: "Charred cottage cheese, mint chutney", diet: "veg", v: "Full plate", g: "Spice level", o: "Hot" });
  });

  test("CHECKs: '' / 121 chars / 501 chars / diet 'meat' → 23514; 120 chars, 500 chars and each diet value accepted", async () => {
    const set = (col: string, v: string) => attempt(db, "munim_core", upsert(), `UPDATE core.item SET ${col} = $2 WHERE id = $1`, [A.item, v]);
    const refused = [await set("display_name", ""), await set("display_name", "x".repeat(121)), await set("description", ""),
      await set("description", "x".repeat(501)), await set("diet", "meat"), await set("diet", "VEG")];
    console.log("D1 CHECK refusals:", refused.map((e) => e?.code).join(","));
    expect(refused.map((e) => e?.code)).toEqual(Array(6).fill("23514"));
    const ok = [await set("display_name", "x".repeat(120)), await set("description", "y".repeat(500))];
    for (const d of ["veg", "non_veg", "egg", "vegan"]) ok.push(await set("diet", d));
    expect(ok).toEqual(Array(6).fill(null));
    for (const t of ["variant", "option_group", "option"]) {
      const id = { variant, option_group: group, option }[t];
      expect((await attempt(db, "munim_core", upsert(), `UPDATE core.${t} SET display_name = '' WHERE id = $1`, [id]))?.code).toBe("23514");
      expect(await attempt(db, "munim_core", upsert(), `UPDATE core.${t} SET display_name = $2 WHERE id = $1`, [id, "z".repeat(120)])).toBeNull();
    }
  });
});

describe("D2 core.outlet.phone", () => {
  test("E.164 accepted under tenancy.outlet.update.v1; '12345' and '+0123456789' → 23514", async () => {
    const set = (v: string) => attempt(db, "munim_core", owner({ command_type: "tenancy.outlet.update.v1" }),
      `UPDATE core.outlet SET phone = $2 WHERE id = $1`, [A.outlets[0], v]);
    expect((await set("12345"))?.code).toBe("23514");
    expect((await set("+0123456789"))?.code).toBe("23514");
    expect(await set("+919876543210")).toBeNull();
    expect((await db.admin(`SELECT phone FROM core.outlet WHERE id = $1`, [A.outlets[0]])).rows[0]!.phone).toBe("+919876543210");
  });
});

describe("GUARD the new columns sit behind the book guard", () => {
  test("no command → MB001; orders.place.v1 → MB008; staff upsert → MB001; owner upsert → accepted", async () => {
    const sql = `UPDATE core.item SET display_name = 'Guarded' WHERE id = $1`;
    const none = await attempt(db, "munim_core", { tenant_id: A.tenant, outlet_ids: "*", role: "owner", member_id: A.owner }, sql, [A.item]);
    const other = await attempt(db, "munim_core", owner({ command_type: "orders.place.v1" }), sql, [A.item]);
    const staff = await attempt(db, "munim_core", { tenant_id: A.tenant, outlet_ids: [A.outlets[0]], role: "staff", member_id: A.staff, command_type: "catalogue.item.upsert.v1" }, sql, [A.item]);
    const phone = await attempt(db, "munim_core", owner({ command_type: "catalogue.item.upsert.v1" }), `UPDATE core.outlet SET phone = '+61390000000' WHERE id = $1`, [A.outlets[0]]);
    console.log("GUARD:", [none, other, staff, phone].map((e) => e?.code).join(","));
    expect([none?.code, other?.code, staff?.code, phone?.code]).toEqual(["MB001", "MB008", "MB001", "MB008"]);
    expect(await attempt(db, "munim_core", upsert(), sql, [A.item])).toBeNull();
  });
});

describe("G privileges on the new columns", () => {
  test("munim_core UPDATE lists, exactly (hand-typed: 0003/0004/0005/0014 lists + 0029's columns + 0030's position)", async () => {
    const want: Record<string, string> = {
      "core.item": "active,barcode,brand_id,category,currency,description,diet,display_name,mrp_minor,name_key,stock_ingredient_id",
      "core.variant": "active,barcode,description,display_name,name_key,position",
      "core.option_group": "description,display_name,max_select,min_select,name_key,position,required",
      "core.option": "active,description,display_name,name_key,position,price_delta_minor",
      "core.outlet": "accepting_orders,address,business_day_cutoff,busy_extra_min,cancel_window_min,default_prep_min,name,phone,pickup_lead_min,"
        + "pickup_slot_min,reschedule_window_min,tax_ids,tz,upi_vpa",
    };
    for (const [t, cols] of Object.entries(want)) {
      const r = await db.admin<{ cols: string | null; tbl: boolean }>(`SELECT (SELECT string_agg(a.attname, ',' ORDER BY a.attname) FROM pg_attribute a, aclexplode(a.attacl) x
        WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND x.grantee = 'munim_core'::regrole AND x.privilege_type = 'UPDATE') cols,
        has_table_privilege('munim_core', $1, 'UPDATE') tbl`, [t]);
      expect([t, r.rows[0]!.cols, r.rows[0]!.tbl]).toEqual([t, cols, false]);
    }
  });

  test("munim_svc and munim_intel_ro cannot write them; munim_intel_ro cannot read them; intel_ro.item_names shows none", async () => {
    const svc = await attempt(db, "munim_svc", { tenant_id: A.tenant, outlet_ids: "*" }, `UPDATE core.item SET display_name = 'svc' WHERE id = $1`, [A.item]);
    const svcPhone = await attempt(db, "munim_svc", { tenant_id: A.tenant, outlet_ids: "*" }, `UPDATE core.outlet SET phone = '+61390000001' WHERE id = $1`, [A.outlets[0]]);
    const intelW = await attempt(db, "munim_intel_ro", { tenant_id: A.tenant }, `UPDATE core.option SET description = 'x' WHERE id = $1`, [option]);
    const intelR = await attempt(db, "munim_intel_ro", { tenant_id: A.tenant }, `SELECT display_name FROM core.item`);
    console.log("G:", [svc, svcPhone, intelW, intelR].map((e) => e?.code).join(","));
    expect([svc?.code, svcPhone?.code, intelW?.code, intelR?.code]).toEqual(["42501", "42501", "42501", "42501"]);
    // The attempts above can be refused before the column is reached (no USAGE on core), so the catalog is read too: no read
    // or write of any new column for munim_intel_ro, and no write for munim_svc (10 columns × 2 roles).
    const priv = await db.admin<{ c: string }>(`SELECT r || ':' || c AS c FROM unnest(ARRAY['munim_intel_ro', 'munim_svc']) r,
        unnest(ARRAY['core.item:display_name', 'core.item:description', 'core.item:diet', 'core.variant:display_name', 'core.variant:description',
                     'core.option_group:display_name', 'core.option_group:description', 'core.option:display_name', 'core.option:description', 'core.outlet:phone']) c
       WHERE has_column_privilege(r, split_part(c, ':', 1), split_part(c, ':', 2), 'INSERT') OR has_column_privilege(r, split_part(c, ':', 1), split_part(c, ':', 2), 'UPDATE')
          OR (r = 'munim_intel_ro' AND has_column_privilege(r, split_part(c, ':', 1), split_part(c, ':', 2), 'SELECT'))`);
    expect(priv.rows.map((x) => x.c)).toEqual([]);
    const cols = (await db.admin<{ c: string }>(`SELECT attname c FROM pg_attribute WHERE attrelid = 'intel_ro.item_names'::regclass AND attnum > 0 ORDER BY attnum`)).rows.map((x) => x.c);
    expect(cols).toEqual(["id", "kind", "name_key", "category"]);
  });
});

describe("ISO the five tables still isolate", () => {
  test("tenant B's context reads 0 rows with A's display text or phone; A's own context reads them", async () => {
    const read = (w: World) => db.withContext("munim_core", ownerCtx(w, { outlet_ids: "*" }), (c) => c.query<{ n: number }>(
      `SELECT ((SELECT count(*) FROM core.item WHERE display_name IS NOT NULL) + (SELECT count(*) FROM core.variant WHERE display_name IS NOT NULL)
             + (SELECT count(*) FROM core.option_group WHERE display_name IS NOT NULL) + (SELECT count(*) FROM core.option WHERE display_name IS NOT NULL)
             + (SELECT count(*) FROM core.outlet WHERE phone IS NOT NULL))::int n`));
    const [a, b] = [(await read(A)).rows[0]!.n, (await read(B)).rows[0]!.n];
    console.log(`ISO: A sees ${a}, B sees ${b}`);
    expect(a).toBe(5);
    expect(b).toBe(0);
  });
});

describe("X1 core.cares_network_listings outlet_tz (G-14)", () => {
  test("a live donation at outlet 1 is listed with outlet_tz = that outlet's tz", async () => {
    const recipient = (await db.admin<{ id: string }>(`SELECT recipient_id id FROM core.cares_listing WHERE tenant_id = $1 AND kind = 'donation' LIMIT 1`, [A.tenant])).rows[0]!.id;
    const id = u();
    await db.withContext("munim_core", owner({ command_type: "cares.listing.publish.v1" }), async (c) => {
      await c.query(`INSERT INTO core.cares_listing (tenant_id, id, outlet_id, kind, recipient_id, pickup_from, pickup_to, pickup_on, published_by)
                     SELECT $1, $2, $3, 'donation', $4, now() + interval '2 hours', now() + interval '4 hours',
                            (((now() + interval '2 hours') AT TIME ZONE ou.tz) - ou.business_day_cutoff)::date, $5
                       FROM core.outlet ou WHERE ou.tenant_id = $1 AND ou.id = $3`, [A.tenant, id, A.outlets[0], recipient, A.owner]);
      await c.query(`INSERT INTO core.cares_listing_line (tenant_id, id, listing_id, line_no, food_kind, ingredient_id, qty_milli, unit)
                     VALUES ($1, $2, $3, 1, 'raw', $4, 100000, 'g')`, [A.tenant, u(), id, A.ingredient]);
    });
    const r = await db.withContext("munim_core", {}, (c) => c.query<{ listing_id: string; outlet_tz: string }>(
      `SELECT listing_id, outlet_tz FROM core.cares_network_listings(NULL, $1, NULL, NULL, 50)`, [A.tenant]));
    console.log("X1:", JSON.stringify(r.rows));
    expect(r.rows).toEqual([{ listing_id: id, outlet_tz: "Asia/Kolkata" }]);
  });

  test("munim_crosstenant reads exactly tenant_id, id, name, tz of core.outlet (SELECT); the function stays EXECUTE munim_core only", async () => {
    const r = await db.admin<{ c: string }>(`SELECT a.attname || ':' || x.privilege_type c FROM pg_attribute a, aclexplode(a.attacl) x
      WHERE a.attrelid = 'core.outlet'::regclass AND x.grantee = 'munim_crosstenant'::regrole ORDER BY 1`);
    expect(r.rows.map((x) => x.c)).toEqual(["id:SELECT", "name:SELECT", "tenant_id:SELECT", "tz:SELECT"]);
    const f = (await db.admin(`SELECT pg_get_userbyid(proowner) o, prosecdef d, has_function_privilege('munim_svc', oid, 'EXECUTE') svc,
      has_function_privilege('munim_intel_ro', oid, 'EXECUTE') intel, has_function_privilege('munim_core', oid, 'EXECUTE') core
      FROM pg_proc WHERE oid = 'core.cares_network_listings(text, uuid, uuid, uuid, integer)'::regprocedure`)).rows[0];
    expect(f).toEqual({ o: "munim_crosstenant", d: true, svc: false, intel: false, core: true });
  });
});
