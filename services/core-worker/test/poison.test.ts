// Poison rows (W1 fix cycle; T-117): a stored row that fails its contract throws on every sweep. Through the real
// composed Publisher (main.ts rowPublisher → core-api createRowPublisher): it is retried POISON_ATTEMPTS times,
// then dead-lettered, and never stalls the rows behind it; a delivery failure (intel down) is not poison. The count
// lives on the row (core.outbox.publish_attempts / dead_at), so it adds up across separate worker processes.
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestDb } from "@munim/db";
import { loadRunTokenKeys } from "../../core-api/src/runtoken/index.ts";
import { svcTxOf } from "../../core-api/src/server.ts";
import { rowPublisher } from "../src/main.ts";
import { PoisonRowError } from "../src/ports.ts";
import { POISON_ATTEMPTS, sweepOutbox } from "../src/sweeper.ts";
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

const bookkeeping = async (id: string) => (await db.admin<{ attempts: number; dead: boolean; published: boolean }>(
  `SELECT publish_attempts AS attempts, dead_at IS NOT NULL AS dead, published_at IS NOT NULL AS published FROM core.outbox WHERE id = $1`, [id])).rows[0];

describe("poison rows", () => {
  it("one poison row among 10 → 9 published at once, poison dead-lettered after 5 attempts, never stalls", async () => {
    // The poison row is the oldest, so it is claimed first on every sweep.
    const poisonRow = (id: string) => ({ ...orderPlaced(id), type: "munim.orders.order.vanished.v1" });
    const [poisonId, ...good] = await insertRows([poisonRow, ...Array.from({ length: 9 }, () => orderPlaced)]);
    const delivered: string[] = [];
    const publisher = rowPublisher(svcTxOf(pool), keys, { publish: async (events) => void delivered.push(...events.map((e) => e.id)) });
    const log = memLog();
    const first = await sweepOutbox(pool, publisher, log, { leaseSeconds: 0 });
    console.log(`sweep 1: ${JSON.stringify(first)}, delivered=${delivered.length}`);
    expect(first).toEqual({ locked: true, published: 9, publishFailed: false });
    expect(new Set(delivered)).toEqual(new Set(good));
    // Later sweeps keep retrying only the poison row, up to POISON_ATTEMPTS, then skip it.
    for (let i = 0; i < 8; i++) await sweepOutbox(pool, publisher, log, { leaseSeconds: 0 });
    const later = await insertRows([orderPlaced]);
    const after = await sweepOutbox(pool, publisher, log, { leaseSeconds: 0 });
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
    expect(await bookkeeping(poisonId!)).toEqual({ attempts: POISON_ATTEMPTS, dead: true, published: false });
    // Ids and a reason code only: no payload text in the log.
    expect(log.text()).not.toContain("vanished");
  });

  it("the count lives on the row: 3 sweeps in one process and 2 in another dead-letter it; a third process never tries it", async () => {
    const [poisonId] = await insertRows([(id) => ({ ...orderPlaced(id), type: "munim.orders.order.vanished.v1" })]);
    const child = (sweeps: number) => new Promise<{ code: number | null; lines: Array<Record<string, unknown>> }>((resolve) => {
      const p = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/poison-child.ts", import.meta.url)), connString(db, "munim_svc"), String(sweeps)],
        { stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      p.stdout.on("data", (d: Buffer) => (out += d.toString()));
      p.on("exit", (code) => resolve({ code, lines: out.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) }));
    });
    const a = await child(3);
    const afterA = await bookkeeping(poisonId!);
    const b = await child(2);
    const afterB = await bookkeeping(poisonId!);
    const c = await child(2);
    console.log(`poison across processes: A exit ${a.code} ${JSON.stringify(a.lines.map((l) => [l.event, l.attempts]))} → ${JSON.stringify(afterA)}; `
      + `B exit ${b.code} ${JSON.stringify(b.lines.map((l) => [l.event, l.attempts]))} → ${JSON.stringify(afterB)}; C attempts ${c.lines.length}`);
    expect([a.code, b.code, c.code]).toEqual([0, 0, 0]);
    expect(a.lines.map((l) => l.attempts)).toEqual([1, 2, 3]);
    expect(afterA).toEqual({ attempts: 3, dead: false, published: false });
    expect(b.lines.map((l) => [l.event, l.attempts])).toEqual([["outbox-sweep.poison_row", 4], ["outbox-sweep.dead_lettered", POISON_ATTEMPTS]]);
    expect(afterB).toEqual({ attempts: POISON_ATTEMPTS, dead: true, published: false });
    expect(c.lines).toEqual([]);
  });

  it("intel down is not poison: the sweep stops, nothing is counted against the row", async () => {
    const ids = await insertRows([orderPlaced, orderPlaced]);
    const publisher = rowPublisher(svcTxOf(pool), keys, { publish: async () => { throw new Error("publisher-http: 1 event(s) not delivered (HTTP 503)"); } });
    const log = memLog();
    for (let i = 0; i < POISON_ATTEMPTS + 2; i++) {
      expect(await sweepOutbox(pool, publisher, log, { leaseSeconds: 0 })).toEqual({ locked: true, published: 0, publishFailed: true });
    }
    expect(await bookkeeping(ids[0]!)).toEqual({ attempts: 0, dead: false, published: false });
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
