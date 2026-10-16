// 0035 gates (R71: "Send me offers" — stored as consent.marketing — is consent for email only; SMS needs its own consent.sms; a
// channel's own flag always wins over marketing). Every expected count is typed by hand below from R71's text
// (docs/plan/00-decision-ledger.md), never read from the migration:
//   C1    customers.consented_audience v2 (the latest, which core-api mints), one segment snapshot naming one customer per case:
//         the case table's 1 or 0; a flag that is not a JSON boolean never raises and is never consent;
//   ERASE an erased customer is not counted: one erased through customers.erasure.request.v1 (the trigger blanks consent) and one
//         inserted erased with {marketing: true} still on the row (the erasure trigger is BEFORE UPDATE only), so the
//         erased_at clause is judged on its own;
//   RED   v1 on the same world counts none of the {marketing}-only customers, so C1 cannot pass on a world where marketing does
//         not matter;
//   SCOPE a minter holding one outlet: a segment minted over every outlet names nobody, one minted over its outlet counts (v1's
//         clause, kept in v2);
//   SHAPE v2 is the latest, with v1's params, columns and min_role.
// Red-proofs: db/tests/redproof-0035.sh (each gate red with a non-zero exit). Synthetic data only.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { AppContext, TestDb } from "../src/harness.ts";
import { openDb } from "./db.ts";
import { buildWorld, ownerCtx, uuidv7, type World } from "./world.ts";

let db: TestDb;
let w: World;
const ID = "customers.consented_audience";

/** R71, by hand: [case, the customer's consent, counted]. */
const CASES: [string, Record<string, unknown>, 0 | 1][] = [
  ["the storefront's grant {marketing: true, at}", { marketing: true, at: "2026-10-16T09:00:00Z" }, 1],
  ["{marketing: true}", { marketing: true }, 1],
  ["{marketing: true, email: false} (a withdrawn email stays withdrawn)", { marketing: true, email: false }, 0],
  ["{marketing: true, sms: false} (email from marketing)", { marketing: true, sms: false }, 1],
  ["{marketing: false}", { marketing: false }, 0],
  ["{marketing: false, email: true}", { marketing: false, email: true }, 1],
  ["{sms: true}", { sms: true }, 1],
  ["{email: true}", { email: true }, 1],
  ["{email: false, sms: true}", { email: false, sms: true }, 1],
  ["{}", {}, 0],
  // Not JSON booleans: never consent, never an error (a cast would read "yes", 1 and "true" as true and raise on "maybe").
  ["{marketing: \"maybe\"}", { marketing: "maybe" }, 0],
  ["{marketing: \"yes\"}", { marketing: "yes" }, 0],
  ["{marketing: 1}", { marketing: 1 }, 0],
  ["{marketing: null}", { marketing: null }, 0],
  ["{sms: \"true\"}", { sms: "true" }, 0],
  ["{email: {}}", { email: {} }, 0],
  // A channel flag that is not a boolean is not set, so email falls back to marketing (as core-api's consentFlags reads it).
  ["{email: \"yes\", marketing: true}", { email: "yes", marketing: true }, 1],
  ["{email: null, marketing: true}", { email: null, marketing: true }, 1],
];
/** The cases counted only through marketing (no email or sms value v1 could read as true): v1 counts none of them. Hand list. */
const MARKETING_ONLY = ["the storefront's grant {marketing: true, at}", "{marketing: true}", "{marketing: true, sms: false} (email from marketing)",
  "{email: null, marketing: true}"];

const own = (cmd: string): AppContext => ownerCtx(w, { command_type: cmd });
const segments: Record<string, string> = {};
let erasedByCommand: string;
let insertedErased: string;

/** A segment snapshot naming `customer`, minted by the owner over `scope`. */
async function segment(customer: string, scope: string[] = ["*"]): Promise<string> {
  const id = uuidv7();
  await db.withContext("munim_core", ownerCtx(w), (c) =>
    c.query(`INSERT INTO evidence.snapshot (tenant_id, id, template_id, template_version, minted_by_member_id, outlet_scope, rows, row_count, sha256)
             VALUES ($1, $2, 'customers.churn_segments', 1, $3, $4, $5, 1, repeat('0', 64))`,
      [w.tenant, id, w.owner, scope, JSON.stringify([{ customer_id: customer, segment: "at_risk" }])]));
  return id;
}

/** Version `v` of the template on one segment, as core-api runs it (the one named param bound as $1). */
async function run(v: number, seg: string, ctx: AppContext = ownerCtx(w)): Promise<{ audience: number; consented: number }> {
  const t = (await db.admin<{ sql: string }>("SELECT sql FROM evidence.snapshot_template WHERE id = $1 AND version = $2", [ID, v])).rows[0];
  if (!t) throw new Error(`no ${ID} v${v}`);
  const sql = t.sql.replaceAll(":segment_snapshot_id", "$1");
  const r = await db.withContext("munim_core", ctx, (c) => c.query<{ audience: string; consented: string }>(sql, [seg]));
  return { audience: Number(r.rows[0]!.audience), consented: Number(r.rows[0]!.consented) };
}

beforeAll(async () => {
  db = await openDb();
  w = await buildWorld(db);
  await db.withContext("munim_core", own("customers.customer.upsert.v1"), async (c) => {
    for (const [name, consent] of CASES) {
      const id = uuidv7();
      await c.query(`INSERT INTO core.customer (tenant_id, id, name, consent) VALUES ($1, $2, $3, $4)`, [w.tenant, id, `Case (synthetic)`, JSON.stringify(consent)]);
      segments[name] = id;
    }
    erasedByCommand = uuidv7();
    insertedErased = uuidv7();
    await c.query(`INSERT INTO core.customer (tenant_id, id, name, consent) VALUES ($1, $2, 'Erased (synthetic)', '{"marketing": true}')`, [w.tenant, erasedByCommand]);
    await c.query(`INSERT INTO core.customer (tenant_id, id, name, consent, erased_at) VALUES ($1, $2, NULL, '{"marketing": true}', now())`, [w.tenant, insertedErased]);
  });
  await db.withContext("munim_core", own("customers.erasure.request.v1"), (c) =>
    c.query(`UPDATE core.customer SET erased_at = now() WHERE id = $1`, [erasedByCommand]));
  for (const [name] of CASES) segments[name] = await segment(segments[name]!);
}, 300_000);
afterAll(async () => db?.stop());

describe("C1 who is counted (R71)", () => {
  test("every consent shape: counted exactly as R71 says, and no shape raises", async () => {
    const got: string[] = [];
    const want: string[] = [];
    for (const [name, , n] of CASES) {
      const r = await run(2, segments[name]!);
      got.push(`${name}: ${r.audience}/${r.consented}`);
      want.push(`${name}: 1/${n}`);
    }
    console.log(`C1: ${CASES.length} cases, ${CASES.filter(([, , n]) => n === 1).length} counted\n  ${got.join("\n  ")}`);
    expect(got).toEqual(want);
  });
});

describe("ERASE an erased customer", () => {
  test("is not counted — erased through the command, and inserted erased with {marketing: true} still on the row", async () => {
    const rows = (await db.admin<{ id: string; consent: unknown }>(`SELECT id, consent FROM core.customer WHERE id = ANY ($1) AND erased_at IS NOT NULL`,
      [[erasedByCommand, insertedErased]])).rows;
    const byCommand = await run(2, await segment(erasedByCommand));
    const inserted = await run(2, await segment(insertedErased));
    console.log(`ERASE: by command ${JSON.stringify(byCommand)}, inserted erased ${JSON.stringify(inserted)}; rows ${JSON.stringify(rows)}`);
    // Not vacuous: both rows are erased, and the inserted one still says marketing: true.
    expect(rows.length).toBe(2);
    expect(rows.find((r) => r.id === insertedErased)?.consent).toEqual({ marketing: true });
    expect([byCommand, inserted]).toEqual([{ audience: 1, consented: 0 }, { audience: 1, consented: 0 }]);
  });
});

describe("RED v1 on the same world", () => {
  test("v1 counts none of the {marketing}-only customers that v2 counts", async () => {
    const v1: string[] = [];
    for (const name of MARKETING_ONLY) v1.push(`${name}: ${(await run(1, segments[name]!)).consented}`);
    console.log(`RED: v1 on ${MARKETING_ONLY.length} marketing-only cases → ${v1.join("; ")}`);
    expect(MARKETING_ONLY.every((name) => CASES.some(([n, , k]) => n === name && k === 1))).toBe(true);
    expect(v1).toEqual(MARKETING_ONLY.map((name) => `${name}: 0`));
  });
});

describe("SCOPE a minter holding one outlet", () => {
  test("a segment over every outlet names nobody; one over its own outlet is counted", async () => {
    const one: AppContext = { ...ownerCtx(w), role: "manager", member_id: w.staff, outlet_ids: [w.outlets[0]] };
    const customer = (await db.admin<{ id: string }>(`SELECT (rows -> 0 ->> 'customer_id') id FROM evidence.snapshot WHERE id = $1`, [segments["{marketing: true}"]])).rows[0]!.id;
    const wide = await run(2, segments["{marketing: true}"]!, one);
    const mine = await run(2, await segment(customer, [w.outlets[0]]), one);
    console.log(`SCOPE: every-outlet segment ${JSON.stringify(wide)}, own-outlet segment ${JSON.stringify(mine)}`);
    expect([wide, mine]).toEqual([{ audience: 0, consented: 0 }, { audience: 1, consented: 1 }]);
  });
});

describe("SHAPE version 2", () => {
  test("is the latest, with v1's params, columns (audience, consented) and min_role (manager)", async () => {
    const r = (await db.admin<{ versions: number[]; same: boolean; cols: string[]; role: string }>(`
      SELECT ARRAY(SELECT version FROM evidence.snapshot_template WHERE id = $1 ORDER BY version) versions,
             (SELECT n.params_schema = o.params_schema AND n.columns = o.columns AND n.min_role = o.min_role
                FROM evidence.snapshot_template n, evidence.snapshot_template o WHERE n.id = $1 AND o.id = $1 AND n.version = 2 AND o.version = 1) same,
             ARRAY(SELECT c ->> 'name' FROM evidence.snapshot_template t, jsonb_array_elements(t.columns) c WHERE t.id = $1 AND t.version = 2) cols,
             (SELECT min_role FROM evidence.snapshot_template WHERE id = $1 AND version = 2) role`, [ID])).rows[0]!;
    expect(r).toEqual({ versions: [1, 2], same: true, cols: ["audience", "consented"], role: "manager" });
  });
});
