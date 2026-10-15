// T-005 end-to-end gates on embedded Postgres: commands → outbox → (after commit) this adapter → a
// recording /events endpoint. The expected id set comes from core.outbox itself, not from the publisher.
import { startTestDb, type TestDb } from "@munim/db";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { executeCommand, replayHeaders, uuidv7, type CommandHandler, type ExecuteResult, type PublishDeps } from "../src/commit/index.ts";
import { ownerContext, provisionTenant, svcTx, testKeys, type Tenant } from "../src/commit/testkit.ts";
import { verifyRunToken } from "../src/runtoken/index.ts";
import { createHttpPublisher } from "../src/commit/publisher-http.ts";
import { deadUrl, exactlyOnce, startRecorder } from "./publisher-recorder.ts";

const SECRET = "test-secret-not-a-real-one";
let db: TestDb;
const keys = testKeys();

beforeAll(async () => {
  db = await startTestDb();
}, 120_000);
afterAll(async () => db?.stop());

const channel: CommandHandler = { type: "tenancy.channel.create.v1", run: async (c, cmd) => {
  const id = uuidv7();
  await c.query(`INSERT INTO core.channel (tenant_id, id, name, kind) VALUES (current_setting('app.tenant_id')::uuid, $1, $2, 'counter')`,
    [id, String(cmd.payload.name)]);
  return {
    entityId: id,
    audit: [{ entity: "core.channel", entityId: id, after: { name: cmd.payload.name } }],
    // A registered contract event type (its data is parsed against the type's schema at write time).
    events: [{ type: "munim.orders.order.placed.v1", subject: id, aggregateType: "order",
      data: { order_id: id, outlet_id: uuidv7(), channel_id: uuidv7(), status: "placed", placed_at: new Date().toISOString() } }],
  };
} };

async function runCommands(t: Tenant, n: number, publish: PublishDeps, deferred: string[] = []) {
  const results: ExecuteResult[] = [];
  for (let i = 0; i < n; i++) {
    const r = await executeCommand(ownerContext(db, t, { publish, onPublishDeferred: (ids) => deferred.push(...ids) }),
      { command_id: uuidv7(), idempotency_key: `e2e-${uuidv7()}`, type: "tenancy.channel.create.v1", payload: { name: `Channel ${i}` } }, channel);
    results.push(r);
  }
  return results;
}

async function outbox(t: Tenant) {
  const r = await db.admin<{ id: string; published: boolean }>(
    `SELECT id::text, published_at IS NOT NULL AS published FROM core.outbox WHERE tenant_id = $1 ORDER BY created_at, id`, [t.tenant]);
  return { ids: r.rows.map((x) => x.id), unpublished: r.rows.filter((x) => !x.published).length };
}

describe("outbox → publisher-http → recording endpoint", () => {
  test("20 commands → 20 outbox rows, each delivered exactly once with the secret and a valid run token; 0 unpublished", async () => {
    const t = await provisionTenant(db);
    const rec = await startRecorder();
    try {
      await runCommands(t, 20, { publisher: createHttpPublisher({ url: rec.url, serviceSecret: SECRET }), svc: svcTx(db), keys });
      const ob = await outbox(t);
      const violations = exactlyOnce(ob.ids, rec.received);
      console.log(`delivery: ${ob.ids.length} outbox rows, ${rec.received.size} distinct ids received over ${rec.requests.length} POSTs, `
        + `violations ${violations.length}, unpublished ${ob.unpublished}`);
      expect(ob.ids).toHaveLength(20);
      expect(violations).toEqual([]);
      expect(ob.unpublished).toBe(0);
      expect(rec.requests.every((r) => r.secret === SECRET && r.path === "/events")).toBe(true);
      const deps = { ...keys, svc: svcTx(db) };
      const verdicts = await Promise.all(rec.requests.flatMap((r) => r.events).map((e) => verifyRunToken(deps, String(e.munimrun))));
      expect(verdicts.filter((v) => v.ok && v.claims.tenant_id === t.tenant)).toHaveLength(20);
    } finally {
      await rec.close();
    }
  });

  test("RED-PROOF: an endpoint that records and then answers 503 once → the retry re-delivers → exactly-once reports it", async () => {
    const t = await provisionTenant(db);
    const rec = await startRecorder({ failFirst: 1 });
    try {
      await runCommands(t, 3, { publisher: createHttpPublisher({ url: rec.url, serviceSecret: SECRET }), svc: svcTx(db), keys });
      const ob = await outbox(t);
      const violations = exactlyOnce(ob.ids, rec.received);
      console.log(`RED-PROOF delivery: violations ${JSON.stringify(violations)}`);
      expect(violations).toEqual([`${ob.ids[0]}: delivered 2x`]);
    } finally {
      await rec.close();
    }
  });

  test("endpoint down → every request still succeeds, rows stay unpublished (5 of 5); control above: 0 unpublished", async () => {
    const t = await provisionTenant(db);
    const deferred: string[] = [];
    const results = await runCommands(t, 5, { publisher: createHttpPublisher({ url: await deadUrl(), serviceSecret: SECRET }), svc: svcTx(db), keys }, deferred);
    const ob = await outbox(t);
    console.log(`endpoint down: ${results.length} requests answered, ${ob.unpublished} of ${ob.ids.length} outbox rows unpublished, ${deferred.length} ids left for the sweeper`);
    // Each answered as a first execution (no replay header), with a contract-valid body.
    expect(results.every((r) => !r.replayed && Object.keys(replayHeaders(r)).length === 0)).toBe(true);
    expect(results.every((r) => Object.keys(JSON.parse(r.body)).sort().join() === "command_id,committed_at,entity_id,type")).toBe(true);
    expect(results).toHaveLength(5);
    expect(ob.unpublished).toBe(5);
    expect([...deferred].sort()).toEqual([...ob.ids].sort());
  });
});
