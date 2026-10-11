// Gates: audit chain (recomputed N/N in TypeScript, gapless per-tenant seq; tamper → red) and NOTIFY
// (delivered after commit with ids only; nothing for a rolled-back write).
import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { setContext, type TestDb } from "../src/harness.ts";
import { openDb } from "./db.ts";
import { buildWorld, ownerCtx, type World } from "./world.ts";

let db: TestDb;
let A: World;
let B: World;

beforeAll(async () => {
  db = await openDb();
  A = await buildWorld(db);
  B = await buildWorld(db);
});
afterAll(async () => db?.stop());

/** Independent verifier: hash = sha256(newline-joined fields) per db/README.md; linkage and gapless seq. */
async function verifyChain(x: TestDb, tenant: string): Promise<{ rows: number; failures: string[] }> {
  const r = await x.admin(`
    SELECT tenant_id::text AS tenant, seq::text AS seq, actor::text AS actor, action, entity, entity_id,
           coalesce(before::text, 'null') AS before, coalesce(after::text, 'null') AS after,
           coalesce(decision_id::text, 'null') AS decision,
           to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at, prev_hash, hash
      FROM core.audit_log a WHERE a.tenant_id = $1 ORDER BY a.seq`, [tenant]);
  const failures: string[] = [];
  let prev = "0".repeat(64);
  r.rows.forEach((row, i) => {
    if (row.seq !== String(i + 1)) failures.push(`seq ${row.seq} at position ${i + 1} (gap)`);
    if (row.prev_hash !== prev) failures.push(`seq ${row.seq}: prev_hash does not link`);
    const line = [row.prev_hash, row.tenant, row.seq, row.actor, row.action, row.entity, row.entity_id, row.before, row.after, row.decision, row.at].join("\n");
    const h = createHash("sha256").update(line, "utf8").digest("hex");
    if (h !== row.hash) failures.push(`seq ${row.seq}: hash mismatch`);
    prev = row.hash;
  });
  return { rows: r.rowCount ?? 0, failures };
}

describe("audit chain", () => {
  test("20 concurrent entries per tenant → seq 1..21 gapless, hashes recompute N/N, chains are per tenant", async () => {
    const pool = db.pool("munim_core", 40);
    try {
      const write = async (w: World, i: number) => {
        const c = await pool.connect();
        try {
          await c.query("BEGIN");
          await setContext(c, ownerCtx(w));
          await c.query(`INSERT INTO core.audit_log (tenant_id, actor, action, entity, entity_id, before, after)
                         VALUES ($1, $2, 'catalogue.price.set.v1', 'core.price', $3, $4, $5)`,
            [w.tenant, { kind: "member", id: w.owner }, randomUUID(), i % 2 ? null : { amount_minor: i }, { amount_minor: i + 1, note: "₹ \"quoted\"" }]);
          await c.query("COMMIT");
        } finally {
          c.release();
        }
      };
      await Promise.all([...Array(20).keys()].flatMap((i) => [write(A, i), write(B, i)]));
    } finally {
      await pool.end();
    }
    for (const w of [A, B]) {
      const r = await verifyChain(db, w.tenant);
      console.log(`audit chain: ${r.rows - r.failures.length}/${r.rows} entries verified for one tenant`);
      expect(r.rows).toBe(21); // 1 from the world + 20 here
      expect(r.failures).toEqual([]);
    }
  });

  test("RED-PROOF: tamper with one entry's `after` → exactly that entry fails", async () => {
    const x = await db.clone();
    try {
      await x.admin(`UPDATE core.audit_log SET after = '{"amount_minor": 1}' WHERE tenant_id = $1 AND seq = 5`, [A.tenant]);
      const r = await verifyChain(x, A.tenant);
      console.log("RED-PROOF audit chain:", r.failures);
      expect(r.failures).toEqual(["seq 5: hash mismatch"]);
    } finally {
      await x.stop();
    }
  });

  test("RED-PROOF: delete one entry → gap and broken link", async () => {
    const x = await db.clone();
    try {
      await x.admin(`DELETE FROM core.audit_log WHERE tenant_id = $1 AND seq = 7`, [A.tenant]);
      const r = await verifyChain(x, A.tenant);
      expect(r.failures).toContain("seq 8 at position 7 (gap)");
      expect(r.failures).toContain("seq 8: prev_hash does not link");
    } finally {
      await x.stop();
    }
  });

  test("caller-supplied seq/hash are overwritten", async () => {
    const r = await db.withContext("munim_core", ownerCtx(A), (c) =>
      c.query(`INSERT INTO core.audit_log (tenant_id, seq, actor, action, entity, entity_id, prev_hash, hash)
               VALUES ($1, 999, '{}', 'x', 'core.item', 'x', 'forged', 'forged') RETURNING seq, hash`, [A.tenant]));
    expect(r.rows[0].seq).toBe("22");
    expect(r.rows[0].hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

async function listen(x: TestDb, channel: string): Promise<{ c: pg.Client; got: string[] }> {
  const c = await x.connect("munim_core");
  const got: string[] = [];
  c.on("notification", (n) => {
    if (n.channel === channel) got.push(n.payload ?? "");
  });
  await c.query(`LISTEN ${channel}`);
  return { c, got };
}
const settle = () => new Promise((r) => setTimeout(r, 300));

describe("NOTIFY", () => {
  test("outbox insert → munim_outbox '<tenant>:<id>' after commit; a rolled-back insert notifies nobody", async () => {
    const { c, got } = await listen(db, "munim_outbox");
    try {
      const id = randomUUID();
      const ins = `INSERT INTO core.outbox (tenant_id, id, aggregatetype, aggregateid, type, payload)
                   VALUES ($1, $2, 'order', 'x', 'munim.orders.order.placed.v1', '{"secret": "never in the notification"}')`;
      await db.withContext("munim_core", ownerCtx(A), (t) => t.query(ins, [A.tenant, id]));
      const rolledBack = randomUUID();
      await expect(db.withContext("munim_core", ownerCtx(A), async (t) => {
        await t.query(ins, [A.tenant, rolledBack]);
        throw new Error("abort");
      })).rejects.toThrow("abort");
      await settle();
      console.log(`NOTIFY munim_outbox: received ${got.length} notification(s): ${got.join(" | ")}`);
      expect(got).toEqual([`${A.tenant}:${id}`]);
    } finally {
      await c.end();
    }
  });

  test("draft insert and status update → munim_inbox, ids only", async () => {
    const { c, got } = await listen(db, "munim_inbox");
    try {
      const id = randomUUID();
      await db.withContext("munim_svc", { tenant_id: A.tenant, outlet_ids: "*" }, (t) =>
        t.query(`INSERT INTO core.draft (tenant_id, id, outlet_ids, source, command_type, command_payload)
                 VALUES ($1, $2, '{}', 'intel:inventory_purchasing', 'inventory.reorder_level.set.v1', '{}')`, [A.tenant, id]));
      await db.withContext("munim_core", ownerCtx(A), (t) =>
        t.query(`UPDATE core.draft SET status = 'stale' WHERE tenant_id = $1 AND id = $2`, [A.tenant, id]));
      await settle();
      expect(got).toEqual([`${A.tenant}:${id}`, `${A.tenant}:${id}`]);
    } finally {
      await c.end();
    }
  });

  test("RED-PROOF: with the trigger dropped, the same insert delivers 0", async () => {
    const x = await db.clone();
    const { c, got } = await listen(x, "munim_outbox");
    try {
      await x.admin("DROP TRIGGER notify_outbox ON core.outbox");
      await x.withContext("munim_core", ownerCtx(A), (t) =>
        t.query(`INSERT INTO core.outbox (tenant_id, id, aggregatetype, aggregateid, type, payload)
                 VALUES ($1, gen_random_uuid(), 'order', 'x', 'munim.orders.order.placed.v1', '{}')`, [A.tenant]));
      await settle();
      console.log(`RED-PROOF NOTIFY: received ${got.length}`);
      expect(got).toEqual([]);
    } finally {
      await c.end();
      await x.stop();
    }
  });
});
