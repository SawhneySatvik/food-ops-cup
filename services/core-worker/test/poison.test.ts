// Poison rows (W1 fix cycle): a stored row that fails its contract throws on every sweep. Through the real
// composed Publisher (main.ts rowPublisher → core-api createRowPublisher): it is retried POISON_ATTEMPTS times,
// then dead-lettered, and never stalls the rows behind it; a delivery failure (intel down) is not poison.
import { generateKeyPairSync } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestDb } from "@munim/db";
import { loadRunTokenKeys } from "../../core-api/src/runtoken/index.ts";
import { svcTxOf } from "../../core-api/src/server.ts";
import { rowPublisher } from "../src/main.ts";
import { PoisonRowError } from "../src/ports.ts";
import { POISON_ATTEMPTS, PoisonRows, sweepOutbox } from "../src/sweeper.ts";
import { connString, makeTenant, memLog, openDb, uuid7 } from "./db.ts";

let db: TestDb;
let tenant: string;
let pool: pg.Pool;
const pem = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const keys = loadRunTokenKeys({ privateKeyPem: pem.privateKey, publicKeyPem: pem.publicKey });

/** A stored munim.orders.order.placed.v1 envelope exactly as the command path writes it (no munimrun). */
const orderPlaced = (id: string) => {
  const order = uuid7();
  return {
    specversion: "1.0", id, time: new Date().toISOString(), datacontenttype: "application/json", tenantid: tenant,
    source: `/tenants/${tenant}/orders`, type: "munim.orders.order.placed.v1", subject: order,
    data: { order_id: order, outlet_id: uuid7(), channel_id: uuid7(), status: "placed", placed_at: new Date().toISOString() },
  };
};

async function insertRows(payloads: Array<(id: string) => unknown>): Promise<string[]> {
  const ids = payloads.map(() => uuid7());
  await db.withContext("munim_svc", { tenant_id: tenant, role: "service" }, async (c) => {
    for (const [i, p] of payloads.entries()) {
      await c.query(
        `INSERT INTO core.outbox (tenant_id, id, aggregatetype, aggregateid, type, payload, created_at)
         VALUES ($1, $2::uuid, 'order', $2::text, 'munim.orders.order.placed.v1', $3, now() - interval '1 minute' + make_interval(secs => $4 * 0.001))`,
        [tenant, ids[i], JSON.stringify(p(ids[i]!)), i]);
    }
  });
  return ids;
}

beforeAll(async () => {
  db = await openDb();
  tenant = await makeTenant(db);
  pool = new pg.Pool({ connectionString: connString(db, "munim_svc"), max: 4 });
});
afterAll(async () => {
  await pool.end();
  await db.stop();
});
beforeEach(async () => {
  await db.admin("TRUNCATE core.outbox");
});

describe("poison rows", () => {
  it("one poison row among 10 → 9 published at once, poison dead-lettered after 5 attempts, never stalls", async () => {
    // The poison row is the oldest, so it is claimed first on every sweep.
    const poisonRow = (id: string) => ({ ...orderPlaced(id), type: "munim.orders.order.vanished.v1" });
    const [poisonId, ...good] = await insertRows([poisonRow, ...Array.from({ length: 9 }, () => orderPlaced)]);
    const delivered: string[] = [];
    const publisher = rowPublisher(svcTxOf(pool), keys, { publish: async (events) => void delivered.push(...events.map((e) => e.id)) });
    const poison = new PoisonRows();
    const log = memLog();
    const first = await sweepOutbox(pool, publisher, log, { leaseSeconds: 0, poison });
    console.log(`sweep 1: ${JSON.stringify(first)}, delivered=${delivered.length}`);
    expect(first).toEqual({ locked: true, published: 9, publishFailed: false });
    expect(new Set(delivered)).toEqual(new Set(good));
    // Later sweeps keep retrying only the poison row, up to POISON_ATTEMPTS, then skip it.
    for (let i = 0; i < 8; i++) await sweepOutbox(pool, publisher, log, { leaseSeconds: 0, poison });
    const later = await insertRows([orderPlaced]);
    const after = await sweepOutbox(pool, publisher, log, { leaseSeconds: 0, poison });
    const attempts = log.lines.filter((l) => l.fields.outbox_id === poisonId && /poison_row|dead_lettered/.test(l.event));
    const dead = log.lines.filter((l) => l.event === "outbox-sweep.dead_lettered");
    console.log(`poison attempts logged=${attempts.length}, dead-lettered=${dead.length} (${JSON.stringify(dead[0]?.fields)}), ` +
      `row inserted after dead-letter published=${after.published}`);
    expect(attempts).toHaveLength(POISON_ATTEMPTS);
    expect(dead).toHaveLength(1);
    expect(dead[0]!.fields).toEqual({ tenant_id: tenant, outbox_id: poisonId, attempts: POISON_ATTEMPTS, reason: "contract_invalid" });
    expect(after).toEqual({ locked: true, published: 1, publishFailed: false });
    expect(delivered).toContain(later[0]);
    expect(delivered).not.toContain(poisonId);
    // Ids and a reason code only: no payload text in the log.
    expect(log.text()).not.toContain("vanished");
  });

  it("intel down is not poison: the sweep stops, nothing is counted against the row", async () => {
    const ids = await insertRows([orderPlaced, orderPlaced]);
    const publisher = rowPublisher(svcTxOf(pool), keys, { publish: async () => { throw new Error("publisher-http: 1 event(s) not delivered (HTTP 503)"); } });
    const poison = new PoisonRows();
    const log = memLog();
    for (let i = 0; i < POISON_ATTEMPTS + 2; i++) {
      expect(await sweepOutbox(pool, publisher, log, { leaseSeconds: 0, poison })).toEqual({ locked: true, published: 0, publishFailed: true });
    }
    expect(poison.isDead(ids[0]!)).toBe(false);
    expect(log.lines.filter((l) => l.event === "outbox-sweep.publish_failed")).toHaveLength(POISON_ATTEMPTS + 2);
    expect(log.lines.filter((l) => /poison_row|dead_lettered/.test(l.event))).toHaveLength(0);
  });

  it("the composed publisher classifies a contract failure as PoisonRowError and delivers nothing for it", async () => {
    const [id] = await insertRows([(i) => ({ ...orderPlaced(i), data: { amount_minor: 100 } })]);
    const sent: string[] = [];
    const publisher = rowPublisher(svcTxOf(pool), keys, { publish: async (events) => void sent.push(...events.map((e) => e.id)) });
    const { rows } = await db.admin("SELECT tenant_id::text, id::text, payload FROM core.outbox WHERE id = $1", [id]);
    await expect(publisher.publish(rows[0] as never)).rejects.toBeInstanceOf(PoisonRowError);
    expect(sent).toEqual([]);
  });
});
