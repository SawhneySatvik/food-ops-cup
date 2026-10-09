// Gates: order transitions (the full 7×7 matrix against the hand list in the manifest) and the gapless
// per-device per-FY invoice series under 100 concurrent inserts (with deliberate rollbacks mixed in, so a
// sequence-based implementation — which leaves gaps — is distinguishable). Plus ticket numbers per outlet.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { TestDb } from "../src/harness.ts";
import { setContext } from "../src/harness.ts";
import { openDb } from "./db.ts";
import { attempt } from "./gates.ts";
import { LEGAL_ORDER_TRANSITIONS, ORDER_STATUSES } from "./manifest.ts";
import { buildWorld, ownerCtx, type World } from "./world.ts";

let db: TestDb;
let A: World;

beforeAll(async () => {
  db = await openDb();
  A = await buildWorld(db);
});
afterAll(async () => db?.stop());

const placeSql = `INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, device_id, kind, subtotal_minor, total_minor, currency, pricing_snapshot)
  SELECT $1, $2, $3, c.id, $4, 'takeaway', 10000, 10000, 'INR', '{}' FROM core.channel c WHERE c.tenant_id = $1 LIMIT 1
  RETURNING invoice_fy, invoice_no, ticket_no, business_date`;

async function transitionMatrix(x: TestDb): Promise<{ legal: string[]; checked: number }> {
  const legal: string[] = [];
  let checked = 0;
  for (const from of ORDER_STATUSES) {
    for (const to of ORDER_STATUSES) {
      if (from === to) continue;
      checked++;
      const id = randomUUID();
      // Insert directly in `from` (the transition trigger guards UPDATEs; the insert sets the start state).
      await x.withContext("munim_core", ownerCtx(A, { command_type: "orders.place.v1" }), (c) =>
        c.query(placeSql.replace("kind, subtotal_minor", "kind, status, subtotal_minor").replace("'takeaway', 10000", `'takeaway', '${from}', 10000`),
          [A.tenant, id, A.outlets[0], null]));
      const e = await attempt(x, "munim_core", ownerCtx(A, { command_type: "kitchen.ticket.advance.v1" }),
        `UPDATE core."order" SET status = $3 WHERE tenant_id = $1 AND id = $2 AND status = $4`, [A.tenant, id, to, from]);
      if (e === null) legal.push(`${from}>${to}`);
      else if (e.code !== "MB004") throw new Error(`${from}>${to}: unexpected ${e.code} ${e.message}`);
    }
  }
  return { legal, checked };
}

describe("order transitions", () => {
  test("of the 42 status pairs exactly the 7 legal ones are accepted; the rest raise MB004", async () => {
    const r = await transitionMatrix(db);
    console.log(`order transitions: ${r.checked} pairs checked, ${r.legal.length} accepted: ${r.legal.join(", ")}`);
    expect(r.checked).toBe(42);
    expect(r.legal.sort()).toEqual([...LEGAL_ORDER_TRANSITIONS].sort());
  });

  test("the transition table seeded by 0004 equals the hand list", async () => {
    const r = await db.admin("SELECT from_status || '>' || to_status AS t FROM core.order_status_transition ORDER BY 1");
    expect(r.rows.map((x) => x.t)).toEqual([...LEGAL_ORDER_TRANSITIONS].sort());
  });

  test("RED-PROOF: an extra row completed>placed in the table → matrix red", async () => {
    const x = await db.clone();
    try {
      await x.admin("INSERT INTO core.order_status_transition VALUES ('completed', 'placed', 'owner')");
      const r = await transitionMatrix(x);
      console.log("RED-PROOF transitions: accepted", r.legal.length, "pairs incl.", r.legal.filter((t) => !LEGAL_ORDER_TRANSITIONS.includes(t)));
      expect(r.legal.sort()).not.toEqual([...LEGAL_ORDER_TRANSITIONS].sort());
      expect(r.legal).toContain("completed>placed");
    } finally {
      await x.stop();
    }
  });
});

/** 100 committed + 5 rolled-back concurrent orders on one new POS device; returns the committed invoice numbers. */
async function invoiceRace(x: TestDb, device: string): Promise<{ numbers: number[]; fys: Set<number> }> {
  const pool = x.pool("munim_core", 110);
  const numbers: number[] = [];
  const fys = new Set<number>();
  try {
    const one = async (i: number) => {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await setContext(c, ownerCtx(A, { command_type: "orders.place.v1" }));
        const r = await c.query(placeSql, [A.tenant, randomUUID(), A.outlets[0], device]);
        if (i % 21 === 20) {
          await c.query("ROLLBACK"); // 5 of 105 give their number back
          return;
        }
        await c.query("COMMIT");
        numbers.push(Number(r.rows[0].invoice_no));
        fys.add(Number(r.rows[0].invoice_fy));
      } finally {
        c.release();
      }
    };
    await Promise.all([...Array(105).keys()].map(one));
  } finally {
    await pool.end();
  }
  return { numbers: numbers.sort((a, b) => a - b), fys };
}

async function newDevice(x: TestDb): Promise<string> {
  const id = randomUUID();
  await x.withContext("munim_core", ownerCtx(A, { command_type: "tenancy.device.register.v1" }), (c) =>
    c.query(`INSERT INTO core.device (tenant_id, id, outlet_id, kind, invoice_series) VALUES ($1, $2, $3, 'pos', 'RACE')`, [A.tenant, id, A.outlets[0]]));
  return id;
}

describe("invoice series", () => {
  const expected = Array.from({ length: 100 }, (_, i) => i + 1);

  test("100 concurrent committed orders (+5 rolled back) → invoice numbers exactly 1..100, one FY", async () => {
    const r = await invoiceRace(db, await newDevice(db));
    console.log(`invoice series: ${r.numbers.length} committed, min ${r.numbers[0]}, max ${r.numbers.at(-1)}, distinct ${new Set(r.numbers).size}, FY ${[...r.fys]}`);
    expect(r.numbers).toEqual(expected);
    expect(r.fys.size).toBe(1);
  });

  test("ticket numbers are per outlet per business date; an order with no device has no invoice number", async () => {
    const r = await db.withContext("munim_core", ownerCtx(A, { command_type: "orders.place.v1" }), async (c) => {
      const a = await c.query(placeSql, [A.tenant, randomUUID(), A.outlets[1], null]);
      const b = await c.query(placeSql, [A.tenant, randomUUID(), A.outlets[1], null]);
      return [a.rows[0], b.rows[0]];
    });
    expect(r[1].ticket_no).toBe(r[0].ticket_no + 1);
    expect(r[0].invoice_no).toBeNull();
  });

  test("RED-PROOF: a sequence-based invoice number leaves gaps → gate red", async () => {
    const x = await db.clone();
    try {
      await x.admin(`
        CREATE SEQUENCE core.redproof_ticket_seq START 100000;
        CREATE SEQUENCE core.redproof_invoice_seq;
        GRANT USAGE ON SEQUENCE core.redproof_ticket_seq, core.redproof_invoice_seq TO munim_core;
        CREATE OR REPLACE FUNCTION core.order_assign_numbers() RETURNS trigger LANGUAGE plpgsql AS $f$
        BEGIN
          NEW.business_date := current_date; NEW.ticket_no := nextval('core.redproof_ticket_seq');
          NEW.invoice_fy := 2026;
          NEW.invoice_no := CASE WHEN NEW.device_id IS NULL THEN NULL ELSE nextval('core.redproof_invoice_seq') END;
          RETURN NEW;
        END $f$;`);
      const r = await invoiceRace(x, await newDevice(x));
      const missing = expected.filter((n) => !r.numbers.includes(n));
      console.log(`RED-PROOF invoice series: max ${r.numbers.at(-1)}, ${missing.length} numbers in 1..100 missing`);
      expect(r.numbers).not.toEqual(expected);
    } finally {
      await x.stop();
    }
  });
});
