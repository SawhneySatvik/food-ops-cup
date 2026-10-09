// Gate (M-B 0011, R40 C2): loyalty never goes below zero under 50 concurrent redeems, and every entry's
// balance_after = the previous entry's balance_after + points (seq gapless per customer). Paired: the
// affordable redeems are accepted, the rest refused with MB011. Plus R41 own-rows visibility and append-only.
// Red-proof: the same trigger without the per-customer row lock (and a pause between read and write)
// over-redeems.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { setContext, type TestDb } from "../src/harness.ts";
import { openDb } from "./db.ts";
import { attempt } from "./gates.ts";
import { buildWorld, ownerCtx, type World } from "./world.ts";

let db: TestDb;
let A: World;

beforeAll(async () => {
  db = await openDb();
  A = await buildWorld(db);
});
afterAll(async () => db?.stop());

const ctx = (w: World) => ownerCtx(w, { command_type: "customers.loyalty.adjust.v1" });

async function newCustomerWith(x: TestDb, points: number): Promise<string> {
  const id = randomUUID();
  await x.withContext("munim_core", ownerCtx(A, { command_type: "customers.customer.upsert.v1" }), (c) =>
    c.query(`INSERT INTO core.customer (tenant_id, id, name) VALUES ($1, $2, 'Regular')`, [A.tenant, id]));
  await x.withContext("munim_core", ctx(A), (c) =>
    c.query(`INSERT INTO core.loyalty_entry (tenant_id, id, customer_id, kind, points) VALUES ($1, gen_random_uuid(), $2, 'earn', $3)`, [A.tenant, id, points]));
  return id;
}

/** 50 concurrent redeems of 10 points each; returns accepted count and SQLSTATEs of refusals. */
async function race(x: TestDb, customer: string) {
  const pool = x.pool("munim_core", 60);
  const codes: string[] = [];
  let accepted = 0;
  try {
    await Promise.all([...Array(50).keys()].map(async () => {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await setContext(c, ctx(A));
        await c.query(`INSERT INTO core.loyalty_entry (tenant_id, id, customer_id, kind, points) VALUES ($1, gen_random_uuid(), $2, 'redeem', -10)`, [A.tenant, customer]);
        await c.query("COMMIT");
        accepted++;
      } catch (e) {
        await c.query("ROLLBACK").catch(() => {});
        codes.push((e as { code: string }).code);
      } finally {
        c.release();
      }
    }));
  } finally {
    await pool.end();
  }
  return { accepted, codes };
}

async function chain(x: TestDb, customer: string) {
  const r = await x.admin<{ seq: string; points: string; balance_after: string }>(
    "SELECT seq, points, balance_after FROM core.loyalty_entry WHERE customer_id = $1 ORDER BY seq", [customer]);
  const failures: string[] = [];
  let prev = 0;
  let sum = 0;
  r.rows.forEach((row, i) => {
    if (Number(row.seq) !== i + 1) failures.push(`seq ${row.seq} at position ${i + 1}`);
    if (Number(row.balance_after) !== prev + Number(row.points)) failures.push(`seq ${row.seq}: balance_after ${row.balance_after} ≠ ${prev} + ${row.points}`);
    prev = Number(row.balance_after);
    sum += Number(row.points);
  });
  return { entries: r.rowCount ?? 0, sum, last: prev, failures };
}

describe("loyalty ledger (R40 C2)", () => {
  test("50 concurrent redeems of 10 against 200 → exactly 20 accepted, 30 refused MB011, balance 0, chain consistent", async () => {
    const customer = await newCustomerWith(db, 200);
    const r = await race(db, customer);
    const c = await chain(db, customer);
    console.log(`loyalty race: ${r.accepted} accepted, ${r.codes.length} refused (${[...new Set(r.codes)].join(",")}); entries ${c.entries}, Σ points ${c.sum}, last balance_after ${c.last}, chain failures ${c.failures.length}`);
    expect(r.accepted).toBe(20);
    expect(r.codes).toEqual(Array(30).fill("MB011"));
    expect(c.entries).toBe(21);
    expect(c.sum).toBe(0);
    expect(c.last).toBe(0);
    expect(c.failures).toEqual([]);
  });

  test("caller-supplied seq / balance_after are overwritten", async () => {
    const customer = await newCustomerWith(db, 30);
    const r = await db.withContext("munim_core", ctx(A), (c) =>
      c.query(`INSERT INTO core.loyalty_entry (tenant_id, id, customer_id, seq, kind, points, balance_after)
               VALUES ($1, gen_random_uuid(), $2, 99, 'redeem', -10, 999999) RETURNING seq, balance_after`, [A.tenant, customer]));
    expect(r.rows[0]).toEqual({ seq: "2", balance_after: "20" });
  });

  test("a customer context sees only its own entries (R41); staff see the tenant's", async () => {
    const mine = await newCustomerWith(db, 10);
    const r = await db.withContext("munim_core", { tenant_id: A.tenant, outlet_ids: "*", role: "customer", customer_id: mine }, (c) =>
      c.query("SELECT DISTINCT customer_id FROM core.loyalty_entry"));
    expect(r.rows.map((x) => x.customer_id)).toEqual([mine]);
    const all = await db.withContext("munim_core", ownerCtx(A), (c) => c.query("SELECT count(DISTINCT customer_id)::int n FROM core.loyalty_entry"));
    expect(all.rows[0].n).toBeGreaterThanOrEqual(3);
  });

  test("append-only: UPDATE and DELETE → 42501; INSERT accepted (above)", async () => {
    for (const sql of ["UPDATE core.loyalty_entry SET points = points", "DELETE FROM core.loyalty_entry"]) {
      expect((await attempt(db, "munim_core", ctx(A), sql))?.code).toBe("42501");
    }
  });

  test("RED-PROOF: without the per-customer row lock the race over-redeems", async () => {
    const x = await db.clone();
    try {
      await x.admin(`ALTER TABLE core.loyalty_entry DROP CONSTRAINT loyalty_entry_seq_unique;
        CREATE OR REPLACE FUNCTION core.loyalty_balance() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $f$
        DECLARE prev_seq bigint; prev_bal bigint;
        BEGIN
          SELECT e.seq, e.balance_after INTO prev_seq, prev_bal FROM core.loyalty_entry e
           WHERE e.tenant_id = NEW.tenant_id AND e.customer_id = NEW.customer_id ORDER BY e.seq DESC LIMIT 1;
          PERFORM pg_sleep(0.2);
          NEW.seq := coalesce(prev_seq, 0) + 1;
          NEW.balance_after := coalesce(prev_bal, 0) + NEW.points;
          IF NEW.balance_after < 0 THEN RAISE EXCEPTION 'loyalty_refused' USING ERRCODE = 'MB011'; END IF;
          RETURN NEW;
        END $f$;`);
      const customer = await newCustomerWith(x, 200);
      const r = await race(x, customer);
      const c = await chain(x, customer);
      console.log(`RED-PROOF loyalty: ${r.accepted} accepted, Σ points ${c.sum}, chain failures ${c.failures.length}`);
      expect(r.accepted).toBeGreaterThan(20);
      expect(c.sum).toBeLessThan(0);
    } finally {
      await x.stop();
    }
  });
});
