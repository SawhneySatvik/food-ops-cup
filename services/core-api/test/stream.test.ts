// T-006 gates for GET /v1/stream (ADR-005) on embedded Postgres, over real HTTP (two app instances, each
// with its own LISTEN connection, served on ephemeral ports):
//   G1 a client on instance #2 receives 10/10 events committed through instance #1, each in < 2 s
//   G2 drop the client, commit 5, reconnect with Last-Event-ID → exactly those 5, then live
//   late commit: a transaction that started earlier but takes its outbox.seq later is delivered in seq order
//   G3 topic authorisation (kds, order incl. customers and guests, inbox, trace scope per W1 fix #37); 400/401
//   G4 tenant B receives 0 of tenant A's events; a forged NOTIFY delivers nothing; red proof with RLS opened
//   shoppers: a customer's / guest's cursor counts only their own order's events (W1 fix #33, #47)
//   G5 the SDK reader resumes across a killed LISTEN connection and max-age closes; guest mode stops on 401
// Every describe block builds its own tenant(s) with @munim/db's buildWorld (W1 fix #14, #69): the outbox seq
// lock is per tenant, so a test that hangs holding it cannot stall another block. Test pools carry
// lock_timeout / statement_timeout / idle_in_transaction_session_timeout, and every stream and raw client is
// closed by onTestFinished, so a hung test fails alone.
// Events are written straight into core.outbox (and core.order_event) under a member's own context, not
// through the commit helper, so these gates do not depend on T-005's code.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { createLogger } from "@munim/config";
import { buildWorld, type TestDb } from "@munim/db";
import type { Hono } from "hono";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { StreamEvent } from "@munim/contracts/storefront";
import { createMunimClient } from "../../../packages/sdk/src/gen/client.ts";
import { openStream, type StreamEvent as SdkStreamEvent } from "../../../packages/sdk/src/stream.ts";
import { type AppEnv, contextOf, createApp, type Deps, requireMember, STOREFRONT_KEY_HEADER, TENANT_HEADER, withContext } from "../src/app.ts";
import { GUEST_TOKEN_HEADER, type Storefront } from "../src/auth/resolve.ts";
import { createLocalIdp } from "../src/auth/local-idp.ts";
import { readContext } from "../src/stream/feed.ts";
import { closeStream, configureStream, type StreamOptions } from "../src/stream/index.ts";
import { openDb } from "./db.ts";

const idp = createLocalIdp();
const lines: string[] = [];
const storefronts = new Map<string, Storefront>();
let db: TestDb;
const servers: Array<{ close(): void }> = [];
const instances: Array<{ deps: Deps; pools: Deps["pools"] }> = [];
const TIMEOUTS = "-c lock_timeout=5000 -c statement_timeout=15000 -c idle_in_transaction_session_timeout=10000";
const login = (user: string) => ({ host: "127.0.0.1", port: db.port, database: db.database, user, password: db.password, options: TIMEOUTS });
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest();

// ---- fixture: buildWorld + the identities and orders streams need -------------------------------------

interface Tenant {
  tenant: string;
  owner: string;
  outlets: [string, string, string];
  /** buildWorld's '{*}' run. */
  run: string;
  key: string;
  ownerSub: string;
  /** buildWorld's staff member, scoped to outlets[0]. */
  staffSub: string;
  /** Manager scoped to outlets[0]. */
  managerSub: string;
  /** Judge (all outlets). */
  judgeSub: string;
  /** Customer X (signed in) and Y. */
  customerSub: string;
  otherSub: string;
  customerId: string;
  channel: string;
  orderMine: string; // outlet 1, customer X
  orderOther: string; // outlet 1, customer Y
  orderO2: string; // outlet 2, no customer
  guestOrder: string; // outlet 1, guest token
  guestToken: string;
}

async function world(label: string): Promise<Tenant> {
  const w = await buildWorld(db);
  const u = randomUUID;
  const t: Tenant = {
    tenant: w.tenant, owner: w.owner, outlets: w.outlets, run: w.run, key: `sf-${label}-${u()}`,
    ownerSub: `owner-${label}-${u()}`, staffSub: `staff-${label}-${u()}`, managerSub: `manager-${label}-${u()}`, judgeSub: `judge-${label}-${u()}`,
    customerSub: `cust-${label}-${u()}`, otherSub: `other-${label}-${u()}`,
    orderMine: u(), orderOther: u(), orderO2: u(), guestOrder: u(), guestToken: randomBytes(24).toString("base64url"),
    customerId: "", channel: "",
  };
  storefronts.set(t.key, { tenant_id: w.tenant, channel_id: w.channel });
  const owner = (command_type: string) => ({ tenant_id: w.tenant, outlet_ids: "*" as const, role: "owner" as const, member_id: w.owner, command_type });
  const [x, y] = [u(), u()];
  t.customerId = x;
  t.channel = w.channel;
  await db.withContext("munim_core", owner("tenancy.member.invite.v1"), async (c) => {
    await c.query(`UPDATE core.member SET idp_sub = $3 WHERE tenant_id = $1 AND id = $2`, [w.tenant, w.owner, t.ownerSub]);
    await c.query(`UPDATE core.member SET idp_sub = $3 WHERE tenant_id = $1 AND id = $2`, [w.tenant, w.staff, t.staffSub]);
    const m = u();
    await c.query(`INSERT INTO core.member (tenant_id, id, idp_sub, name, email) VALUES ($1, $2, $3, 'Manager', 'manager@example.test')`, [w.tenant, m, t.managerSub]);
    await c.query(`INSERT INTO core.membership (tenant_id, member_id, role, outlet_ids) VALUES ($1, $2, 'manager', $3)`, [w.tenant, m, [w.outlets[0]]]);
    const j = u();
    await c.query(`INSERT INTO core.member (tenant_id, id, idp_sub, name, email) VALUES ($1, $2, $3, 'Judge', 'judge@example.test')`, [w.tenant, j, t.judgeSub]);
    await c.query(`INSERT INTO core.membership (tenant_id, member_id, role) VALUES ($1, $2, 'judge')`, [w.tenant, j]);
  });
  await db.withContext("munim_core", owner("customers.customer.upsert.v1"), async (c) => {
    for (const [id, sub] of [[x, t.customerSub], [y, t.otherSub]]) {
      await c.query(`INSERT INTO core.customer (tenant_id, id, name, idp_sub, is_guest) VALUES ($1, $2, 'Synthetic Customer', $3, false)`, [w.tenant, id, sub]);
    }
  });
  await db.withContext("munim_core", owner("orders.place.v1"), async (c) => {
    for (const [id, outlet, cust, hash] of [
      [t.orderMine, w.outlets[0], x, null], [t.orderOther, w.outlets[0], y, null],
      [t.orderO2, w.outlets[1], null, null], [t.guestOrder, w.outlets[0], null, sha256(t.guestToken)],
    ] as const) {
      await c.query(`INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, kind, subtotal_minor, total_minor, currency, pricing_snapshot, customer_id, guest_access_hash)
                     VALUES ($1, $2, $3, $4, 'takeaway', 10000, 10000, $5, '{}', $6, $7)`, [w.tenant, id, outlet, w.channel, w.currency, cust, hash]);
    }
  });
  return t;
}

/** A kitchen status change: order row + order_event + the outbox event that wakes streams, in one transaction. */
async function advance(t: Tenant, order: string, from: string, to: string): Promise<string> {
  const id = randomUUID();
  await db.withContext("munim_core", { tenant_id: t.tenant, outlet_ids: "*", role: "owner", member_id: t.owner, command_type: "kitchen.ticket.advance.v1" }, async (c) => {
    const o = (await c.query<{ outlet_id: string }>(`UPDATE core."order" SET status = $3 WHERE tenant_id = $1 AND id = $2 RETURNING outlet_id`, [t.tenant, order, to])).rows[0]!;
    await c.query(`INSERT INTO core.order_event (tenant_id, id, outlet_id, order_id, kind, from_status, to_status, actor, reason)
                   VALUES ($1, $2, $3, $4, 'status', $5, $6, $7, 'staff note')`, [t.tenant, id, o.outlet_id, order, from, to, { kind: "member", id: t.owner }]);
    const ev = randomUUID();
    await c.query(`INSERT INTO core.outbox (tenant_id, id, aggregatetype, aggregateid, type, payload) VALUES ($1, $2, 'order', $3, 'munim.kitchen.ticket.advanced.v1', $4)`,
      [t.tenant, ev, order, { data: { order_id: order, outlet_id: o.outlet_id, status: to } }]);
  });
  return id;
}

// ---- instances ----------------------------------------------------------------------------------------

interface Instance {
  base: string;
  app: Hono<AppEnv>;
}

async function instance(name: string, opts: StreamOptions = {}, corsOrigins: string[] = []): Promise<Instance> {
  const pools = { core: new pg.Pool({ ...login("munim_core"), max: 8 }), svc: new pg.Pool({ ...login("munim_svc"), max: 2 }) };
  const config = { nodeEnv: "test", redact: (s: string) => s };
  const deps: Deps = {
    pools, idp, storefronts: async (k) => storefronts.get(k) ?? null, config,
    log: createLogger(config, (l) => lines.push(`${name}: ${l}`)),
  };
  configureStream(deps, {
    connect: () => new pg.Client({ ...login("munim_core"), application_name: `munim_stream_listen_${name}` }),
    ...opts,
  });
  const app = await createApp(deps, { corsOrigins });
  // "Committed via instance #1": an outbox row written under the calling member's own context.
  app.post("/v1/_test/emit", requireMember, async (c) => {
    const p = c.var.principal as Extract<typeof c.var.principal, { kind: "member" }>;
    const b = await c.req.json<{ outlet_id: string; order_id?: string }>();
    const id = randomUUID();
    const order = b.order_id ?? randomUUID();
    const type = "munim.orders.order.placed.v1";
    await withContext(c.var.deps.pools.core, contextOf(p), (q) =>
      q.query(`INSERT INTO core.outbox (tenant_id, id, aggregatetype, aggregateid, type, payload) VALUES ($1, $2, 'order', $3, $4, $5)`, [
        p.tenant_id, id, order, type,
        { specversion: "1.0", id, type, subject: order, data: { order_id: order, outlet_id: b.outlet_id, status: "placed" } },
      ]));
    return c.json({ id }, 201);
  });
  const port = await new Promise<number>((resolve) => {
    servers.push(serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => resolve(info.port)));
  });
  instances.push({ deps, pools });
  return { base: `http://127.0.0.1:${port}`, app };
}

const member = (t: Tenant, sub: string) => ({ Authorization: `Bearer ${idp.sign({ sub })}`, [TENANT_HEADER]: t.tenant });
const customer = (t: Tenant, sub: string) => ({ [STOREFRONT_KEY_HEADER]: t.key, Authorization: `Bearer ${idp.sign({ sub })}` });
const guest = (t: Tenant, token = t.guestToken) => ({ [STOREFRONT_KEY_HEADER]: t.key, [GUEST_TOKEN_HEADER]: token });

async function emit(inst: Instance, t: Tenant, body: { outlet_id: string; order_id?: string }): Promise<string> {
  const res = await fetch(`${inst.base}/v1/_test/emit`, {
    method: "POST",
    headers: { ...member(t, t.ownerSub), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(pred: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await sleep(5);
  }
}

/** A raw session as `user`, ended when the test finishes (pass or fail). */
async function session(user: string): Promise<pg.Client> {
  const c = new pg.Client(login(user));
  c.on("error", () => {});
  await c.connect();
  onTestFinished(() => c.end().catch(() => {}));
  return c;
}

const part = (cursor: string | null, k: "o" | "n") => Number(new RegExp(`(?:^|;)${k}=(\\d+)`).exec(cursor ?? "")?.[1] ?? NaN);

/** A deliberately minimal SSE reader, independent of the SDK's parser (the server emits "\n" line ends). */
interface Msg {
  id: string;
  type: string;
  data: Record<string, unknown>;
  cursor: string | null;
  at: number;
}
class Raw {
  msgs: Msg[] = [];
  control: Array<{ event: string; data: string; id: string | null }> = [];
  comments = 0;
  ended = false;
  cursor: string | null = null;
  readonly status: number;
  private readonly ctl: AbortController;
  private constructor(status: number, ctl: AbortController) {
    this.status = status;
    this.ctl = ctl;
  }

  /** Opens a stream that is closed when the test finishes. */
  static async open(inst: Instance, topics: string[], headers: Record<string, string>, lastEventId?: string): Promise<Raw> {
    const ctl = new AbortController();
    onTestFinished(() => ctl.abort());
    const res = await fetch(`${inst.base}/v1/stream?topics=${encodeURIComponent(topics.join(","))}`, {
      headers: { ...headers, ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}) },
      signal: ctl.signal,
    });
    const r = new Raw(res.status, ctl);
    if (res.ok && res.body) void r.pump(res.body);
    else await res.body?.cancel();
    return r;
  }

  get ready(): boolean {
    return this.control.some((c) => c.event === "ready");
  }

  close(): void {
    this.ctl.abort();
  }

  private async pump(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let cut: number;
        while ((cut = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, cut).split("\n");
          buf = buf.slice(cut + 2);
          if (block.every((l) => l.startsWith(":"))) {
            this.comments++;
            continue;
          }
          const f = Object.fromEntries(block.map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 2)]));
          if (f.id !== undefined) this.cursor = f.id;
          if (f.event) this.control.push({ event: f.event, data: f.data ?? "", id: f.id ?? null });
          // Every delivered event has the contract's shape (T-099 G-07: stream.event is documented in OpenAPI now).
          else this.msgs.push({ ...(StreamEvent.parse(JSON.parse(f.data!)) as Omit<Msg, "cursor" | "at">), cursor: this.cursor, at: Date.now() });
        }
      }
    } catch {
      // aborted by close()
    }
    this.ended = true;
  }
}

let one: Instance;
let two: Instance;

beforeAll(async () => {
  db = await openDb();
  one = await instance("one");
  two = await instance("two");
});

afterAll(async () => {
  for (const s of servers) s.close();
  await Promise.allSettled(instances.map(async ({ deps, pools }) => {
    await closeStream(deps);
    await Promise.allSettled([pools.core.end(), pools.svc.end()]);
  }));
  await db.stop();
});

const listeners = async (prefix = "munim_stream_listen_") =>
  Number((await db.admin<{ n: string }>(
    `SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND application_name LIKE $1 || '%'`, [prefix])).rows[0]!.n);

describe("G1 · two instances, cross-instance delivery", () => {
  let A: Tenant;
  beforeAll(async () => {
    A = await world("g1");
  });

  it("a client on #2 receives 10/10 events committed via #1, each in < 2 s; 2 LISTEN connections", async () => {
    const onTwo = await Raw.open(two, [`kds:${A.outlets[0]}`], member(A, A.ownerSub));
    const onOne = await Raw.open(one, [`kds:${A.outlets[0]}`], member(A, A.ownerSub));
    expect([onTwo.status, onOne.status]).toEqual([200, 200]);
    await until(() => onTwo.ready && onOne.ready, 5_000, "ready");
    expect(await listeners()).toBe(2);

    const sent: string[] = [];
    const latency: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t0 = Date.now();
      const id = await emit(one, A, { outlet_id: A.outlets[0] });
      sent.push(id);
      await until(() => onTwo.msgs.some((m) => m.id === id), 2_000, `event ${i + 1} on #2`);
      latency.push(onTwo.msgs.find((m) => m.id === id)!.at - t0);
    }
    console.log(`G1 latencies (ms, commit via #1 → received on #2): ${latency.join(", ")}`);
    expect(onTwo.msgs.map((m) => m.id)).toEqual(sent);
    expect(latency.filter((ms) => ms < 2_000)).toHaveLength(10);
    await until(() => onOne.msgs.length === 10, 2_000, "#1's own subscriber");
    expect(onTwo.msgs.every((m) => m.type === "munim.orders.order.placed.v1" && m.data.outlet_id === A.outlets[0])).toBe(true);
    // The cursor is the outbox seq: consecutive per tenant, so 10 events advance it by exactly 10.
    const seqs = onTwo.msgs.map((m) => part(m.cursor, "o"));
    expect(seqs.every((s, i) => i === 0 || s === seqs[i - 1]! + 1)).toBe(true);
  });
});

describe("G2 · Last-Event-ID replay", () => {
  let A: Tenant;
  beforeAll(async () => {
    A = await world("g2");
  });

  it("drop the client, commit 5, reconnect → exactly the 5 missed, then live", async () => {
    const first = await Raw.open(two, [`kds:${A.outlets[0]}`], member(A, A.ownerSub));
    await until(() => first.ready, 5_000, "ready");
    const seen = await emit(one, A, { outlet_id: A.outlets[0] });
    await until(() => first.msgs.some((m) => m.id === seen), 2_000, "pre-drop event");
    const last = first.cursor!;
    first.close();

    const missed: string[] = [];
    for (let i = 0; i < 5; i++) missed.push(await emit(one, A, { outlet_id: A.outlets[0] }));
    // Noise the topic must filter out: another outlet's events.
    await emit(one, A, { outlet_id: A.outlets[1] });

    const again = await Raw.open(two, [`kds:${A.outlets[0]}`], member(A, A.ownerSub), last);
    expect(again.status).toBe(200);
    await until(() => again.msgs.length >= 5, 2_000, "replay");
    await sleep(300);
    expect(again.msgs.map((m) => m.id)).toEqual(missed);
    const live = await emit(one, A, { outlet_id: A.outlets[0] });
    await until(() => again.msgs.length >= 6, 2_000, "live after replay");
    await sleep(200);
    expect(again.msgs.map((m) => m.id)).toEqual([...missed, live]);
  });

  it("a malformed Last-Event-ID is 400; a member may not present a customer's n= cursor", async () => {
    expect((await Raw.open(two, [`kds:${A.outlets[0]}`], member(A, A.ownerSub), "o=yesterday")).status).toBe(400);
    expect((await Raw.open(two, [`kds:${A.outlets[0]}`], member(A, A.ownerSub), "n=1")).status).toBe(400);
  });
});

describe("late commit under the commit-ordered outbox.seq (W1 fix #25, #51)", () => {
  let A: Tenant;
  beforeAll(async () => {
    A = await world("late");
  });

  it("a transaction that started first but inserts after another is delivered after it, by seq, and never replayed twice", async () => {
    const sub = await Raw.open(two, [`kds:${A.outlets[0]}`], member(A, A.ownerSub));
    await until(() => sub.ready, 5_000, "ready");
    const row = (id: string) => [A.tenant, id, randomUUID(), { data: { outlet_id: A.outlets[0], status: "placed" } }];
    const insert = `INSERT INTO core.outbox (tenant_id, id, aggregatetype, aggregateid, type, payload) VALUES ($1, $2, 'order', $3, 'munim.orders.order.placed.v1', $4)`;
    // T2 starts first (its created_at = its start), T1 starts later, inserts and commits; then T2 inserts.
    const t2 = await session("munim_core");
    await t2.query("BEGIN");
    await t2.query("SELECT set_config('app.tenant_id', $1, true), now()", [A.tenant]);
    await sleep(20);
    const t1 = await session("munim_core");
    const [id1, id2] = [randomUUID(), randomUUID()];
    await t1.query("BEGIN");
    await t1.query("SELECT set_config('app.tenant_id', $1, true)", [A.tenant]);
    await t1.query(insert, row(id1));
    await t1.query("COMMIT");
    await until(() => sub.msgs.some((m) => m.id === id1), 2_000, "T1");
    await t2.query(insert, row(id2));
    await t2.query("COMMIT");
    await until(() => sub.msgs.some((m) => m.id === id2), 2_000, "T2 (started earlier, committed later)");

    const facts = (await db.admin<{ id: string; seq: string; created_at: Date }>(
      `SELECT id, seq, created_at FROM core.outbox WHERE id = ANY ($1::uuid[])`, [[id1, id2]])).rows;
    const by = Object.fromEntries(facts.map((f) => [f.id, f]));
    expect(by[id2]!.created_at.getTime()).toBeLessThan(by[id1]!.created_at.getTime());
    expect(Number(by[id2]!.seq)).toBe(Number(by[id1]!.seq) + 1);
    expect(sub.msgs.map((m) => m.id)).toEqual([id1, id2]);
    expect(sub.msgs.map((m) => part(m.cursor, "o"))).toEqual([Number(by[id1]!.seq), Number(by[id2]!.seq)]);

    const again = await Raw.open(two, [`kds:${A.outlets[0]}`], member(A, A.ownerSub), sub.cursor!);
    await until(() => again.ready, 5_000, "ready");
    const next = await emit(one, A, { outlet_id: A.outlets[0] });
    await until(() => again.msgs.length >= 1, 2_000, "live");
    await sleep(200);
    expect(again.msgs.map((m) => m.id)).toEqual([next]);
  });
});

describe("G3 · topic authorisation", () => {
  let A: Tenant;
  let B: Tenant;
  beforeAll(async () => {
    [A, B] = [await world("g3a"), await world("g3b")];
  });
  const status = async (topics: string[], headers: Record<string, string>, lastEventId?: string) => {
    const r = await Raw.open(two, topics, headers, lastEventId);
    if (r.status === 200) {
      await until(() => r.ready, 5_000, "ready");
      r.close();
    }
    return r.status;
  };

  it("outlet-1 staff: kds:<1> 200, kds:<2> 404, both together 404; another tenant's outlet 404", async () => {
    const staff = member(A, A.staffSub);
    expect(await status([`kds:${A.outlets[0]}`], staff)).toBe(200);
    expect(await status([`kds:${A.outlets[1]}`], staff)).toBe(404);
    expect(await status([`kds:${A.outlets[0]}`, `kds:${A.outlets[1]}`], staff)).toBe(404);
    expect(await status([`kds:${B.outlets[0]}`], member(A, A.ownerSub))).toBe(404);
    expect(await status([`kds:${randomUUID()}`], member(A, A.ownerSub))).toBe(404);
  });

  it("order:<id>: its customer 200, another customer's 404, no-profile login 404, members per outlet scope", async () => {
    expect(await status([`order:${A.orderMine}`], customer(A, A.customerSub))).toBe(200);
    expect(await status([`order:${A.orderOther}`], customer(A, A.customerSub))).toBe(404);
    expect(await status([`order:${A.orderMine}`], customer(A, `nobody-${randomUUID()}`))).toBe(404);
    expect(await status([`kds:${A.outlets[0]}`], customer(A, A.customerSub))).toBe(404);
    expect(await status([`order:${A.orderMine}`], member(A, A.staffSub))).toBe(200);
    expect(await status([`order:${A.orderO2}`], member(A, A.staffSub))).toBe(404);
    expect(await status([`order:${A.orderO2}`], member(A, A.ownerSub))).toBe(200);
    // A customer's cursor is n=…; a tenant-wide o=… is refused rather than replayed from (W1 fix #33).
    expect(await status([`order:${A.orderMine}`], customer(A, A.customerSub), "o=1")).toBe(400);
  });

  it("guest token (W1 fix #47): its own order 200; any other order, a second topic, a bad token or an o= cursor refused", async () => {
    expect(await status([`order:${A.guestOrder}`], guest(A))).toBe(200);
    expect(await status([`order:${A.orderMine}`], guest(A))).toBe(404);
    expect(await status([`order:${A.guestOrder}`, `order:${A.orderMine}`], guest(A))).toBe(404);
    expect(await status([`order:${A.guestOrder}`], guest(A, randomBytes(24).toString("base64url")))).toBe(404);
    expect(await status([`order:${A.guestOrder}`], { [GUEST_TOKEN_HEADER]: A.guestToken })).toBe(404);
    expect(await status([`order:${A.guestOrder}`], guest(A), "o=1")).toBe(400);
  });

  it("T-099 G-09: over a real server, the 200 event stream carries the listed origin's CORS headers; a non-listed origin gets none", async () => {
    const origin = "https://spice-route.example.test";
    const cors = await instance("cors", {}, [origin]);
    const open = async (o: string) => {
      const ac = new AbortController();
      const r = await fetch(`${cors.base}/v1/stream?topics=order:${A.guestOrder}`, { headers: { ...guest(A), Origin: o }, signal: ac.signal });
      const h = [r.status, r.headers.get("content-type"), r.headers.get("access-control-allow-origin"), r.headers.get("access-control-expose-headers")];
      ac.abort();
      await r.body?.cancel().catch(() => {});
      return h;
    };
    expect(await open(origin)).toEqual([200, "text/event-stream; charset=utf-8", origin, "X-Munim-Replayed, Retry-After"]);
    expect(await open("https://evil.example.test")).toEqual([200, "text/event-stream; charset=utf-8", null, null]);
  });

  it("inbox:<tenant> owner/manager of that tenant only; bad input 400/401", async () => {
    expect(await status([`inbox:${A.tenant}`], member(A, A.managerSub))).toBe(200);
    expect(await status([`inbox:${A.tenant}`], member(A, A.staffSub))).toBe(404);
    expect(await status([`inbox:${B.tenant}`], member(A, A.ownerSub))).toBe(404);
    expect(await status(["kds:not-a-uuid"], member(A, A.ownerSub))).toBe(400);
    expect(await status([], member(A, A.ownerSub))).toBe(400);
    expect(await status([`kds:${A.outlets[0]}`], { [TENANT_HEADER]: A.tenant })).toBe(401);
  });

  it("trace:<run> (W1 fix #37, #78): the member's outlet scope covers the run's; '{*}' runs owner/advisor/judge only", async () => {
    const run = async (t: Tenant, scope: string[]) => {
      const id = randomUUID();
      await db.withContext("munim_svc", { tenant_id: t.tenant, outlet_ids: "*" }, (c) =>
        c.query(`INSERT INTO intel.run (tenant_id, id, trigger, actor, outlet_scope, expires_at) VALUES ($1, $2, 'brief', 'brief', $3, now() + interval '1 hour')`,
          [t.tenant, id, scope]));
      return id;
    };
    const [r1, r2, r12, rB] = [await run(A, [A.outlets[0]]), await run(A, [A.outlets[1]]), await run(A, [A.outlets[0], A.outlets[1]]), await run(B, ["*"])];
    const cases = async () => [
      await status([`trace:${A.run}`], member(A, A.ownerSub)),
      await status([`trace:${A.run}`], member(A, A.managerSub)),
      await status([`trace:${A.run}`], member(A, A.staffSub)),
      await status([`trace:${r1}`], member(A, A.managerSub)),
      await status([`trace:${r2}`], member(A, A.managerSub)),
      await status([`trace:${r12}`], member(A, A.managerSub)),
      await status([`trace:${r12}`], member(A, A.ownerSub)),
      await status([`trace:${rB}`], member(A, A.ownerSub)),
      await status([`trace:${r1}`], customer(A, A.customerSub)),
      await status([`trace:${A.run}`], member(A, A.judgeSub)),
    ];
    expect(await cases()).toEqual([200, 404, 404, 200, 404, 404, 200, 404, 404, 200]);
    // The stream's own check, with 0014's run policy neutralised (an extra tenant-only permissive policy):
    // the same answers must hold, so RLS is not the only thing refusing them.
    await db.admin(`CREATE POLICY t006_open ON intel.run USING (tenant_id = (SELECT nullif(current_setting('app.tenant_id', true), '')::uuid))`);
    try {
      expect(await cases()).toEqual([200, 404, 404, 200, 404, 404, 200, 404, 404, 200]);
    } finally {
      await db.admin(`DROP POLICY t006_open ON intel.run`);
    }
  });
});

describe("inbox and trace channels", () => {
  let A: Tenant;
  beforeAll(async () => {
    A = await world("inbox");
  });

  it("drafts and findings reach the owner; an outlet-1 manager sees only those touching outlet 1", async () => {
    const owner = await Raw.open(two, [`inbox:${A.tenant}`], member(A, A.ownerSub));
    const mgr = await Raw.open(two, [`inbox:${A.tenant}`], member(A, A.managerSub));
    await until(() => owner.ready && mgr.ready, 5_000, "ready");
    const svc = { tenant_id: A.tenant, outlet_ids: "*" as const, role: "service" as const };
    const draft = (outlets: string[]) => db.withContext("munim_svc", svc, async (c) => {
      const id = randomUUID();
      await c.query(`INSERT INTO core.draft (tenant_id, id, outlet_ids, source, command_type, command_payload) VALUES ($1, $2, $3, 'member', 'orders.place.v1', '{}')`,
        [A.tenant, id, outlets]);
      return id;
    });
    const d2 = await draft([A.outlets[1]]);
    const d1 = await draft([A.outlets[0]]);
    await until(() => owner.msgs.length === 2 && mgr.msgs.length === 1, 2_000, "drafts");
    expect(owner.msgs.map((m) => m.id)).toEqual([d2, d1]);
    expect(mgr.msgs.map((m) => [m.id, m.type, m.data.status])).toEqual([[d1, "inbox.draft", "proposed"]]);
    expect(Object.keys(mgr.msgs[0]!.data).sort()).toEqual(["command_type", "finding_id", "outlet_ids", "status", "updated_at"]);

    // Findings ride the same channel (0012 trigger on intel.finding); a status change is a new event.
    const run = randomUUID();
    await db.withContext("munim_svc", { tenant_id: A.tenant, outlet_ids: "*" }, (c) =>
      c.query(`INSERT INTO intel.run (tenant_id, id, trigger, actor, outlet_scope, expires_at) VALUES ($1, $2, 'brief', 'brief', '{*}', now() + interval '1 hour')`, [A.tenant, run]));
    const finding = (outlets: string[]) => db.withContext("munim_svc", svc, async (c) => {
      const id = randomUUID();
      await c.query(`INSERT INTO intel.finding (tenant_id, id, run_id, outlet_ids, pack, type, severity, confidence_bp, envelope, dedupe_key)
                     VALUES ($1, $2, $3, $4, 'inventory', 'inventory.price_creep', 'high', 8000, '{}', $5)`, [A.tenant, id, run, outlets, `k-${id}`]);
      return id;
    });
    const f2 = await finding([A.outlets[1]]);
    const f1 = await finding([A.outlets[0]]);
    // A feed sends one event per `updated_at` it reads, so an update that commits before its first read of the new row folds
    // `open` and `resolved` into one event: wait for `open` on both before resolving.
    await until(() => owner.msgs.some((m) => m.id === f1) && mgr.msgs.some((m) => m.id === f1), 5_000, "f1 open");
    await db.withContext("munim_svc", svc, (c) => c.query(`UPDATE intel.finding SET status = 'resolved' WHERE tenant_id = $1 AND id = $2`, [A.tenant, f1]));
    await until(() => owner.msgs.length === 5 && mgr.msgs.length === 3, 2_000, "findings");
    expect(owner.msgs.slice(2).map((m) => [m.id, m.type, m.data.status])).toEqual([
      [f2, "inbox.finding", "open"], [f1, "inbox.finding", "open"], [f1, "inbox.finding", "resolved"]]);
    expect(mgr.msgs.slice(1).map((m) => [m.id, m.data.status])).toEqual([[f1, "open"], [f1, "resolved"]]);
    expect(Object.keys(mgr.msgs[1]!.data).sort()).toEqual(["outlet_ids", "pack", "severity", "status", "type", "updated_at"]);
  });

  it("trace:<run> streams intel.trace_event rows in seq order", async () => {
    // No silent skip (R3-m3): the table ships in 0012; if it is missing this test fails instead of passing empty.
    const exists = (await db.admin<{ ok: boolean }>(`SELECT to_regclass('intel.trace_event') IS NOT NULL AS ok`)).rows[0]!.ok;
    expect(exists).toBe(true);
    const run = randomUUID();
    await db.withContext("munim_svc", { tenant_id: A.tenant, outlet_ids: "*" }, (c) =>
      c.query(`INSERT INTO intel.run (tenant_id, id, trigger, actor, outlet_scope, expires_at) VALUES ($1, $2, 'brief', 'brief', '{*}', now() + interval '1 hour')`, [A.tenant, run]));
    const r = await Raw.open(two, [`trace:${run}`], member(A, A.ownerSub));
    expect(r.status).toBe(200);
    await until(() => r.ready, 5_000, "ready");
    // Columns as in 0012_compliance_goals_intel (intel.trace_event).
    await db.withContext("munim_svc", { tenant_id: A.tenant, outlet_ids: "*" }, async (c) => {
      for (let seq = 1; seq <= 3; seq++) {
        await c.query(`INSERT INTO intel.trace_event (tenant_id, run_id, seq, id, parent_id, kind, actor, payload, at) VALUES ($1, $2, $3, $4, NULL, 'route', 'router', '{}', now())`,
          [A.tenant, run, seq, randomUUID()]);
      }
    });
    await until(() => r.msgs.length === 3, 2_000, "trace events");
    expect(r.msgs.map((m) => m.data.seq)).toEqual([1, 2, 3]);
  });
});

describe("shoppers: customer and guest order tracking (W1 fix #33, #47)", () => {
  let A: Tenant;
  beforeAll(async () => {
    A = await world("shop");
  });

  it("a customer's cursor counts only their own order's events, never the tenant's; replay resumes by count", async () => {
    const x = await Raw.open(two, [`order:${A.orderMine}`], customer(A, A.customerSub));
    expect(x.status).toBe(200);
    await until(() => x.ready, 5_000, "ready");
    expect(x.control[0]!.id).toBe("n=0");

    const e1 = await advance(A, A.orderMine, "placed", "accepted");
    await until(() => x.msgs.length === 1, 2_000, "own event 1");
    // Other aggregates move the tenant's outbox.seq — five other events and another customer's order change.
    for (let i = 0; i < 5; i++) await emit(one, A, { outlet_id: A.outlets[0] });
    await advance(A, A.orderOther, "placed", "accepted");
    const e2 = await advance(A, A.orderMine, "accepted", "preparing");
    await until(() => x.msgs.length === 2, 2_000, "own event 2");
    await sleep(200);
    expect(x.msgs.map((m) => [m.id, m.type, m.data.to_status, m.cursor])).toEqual([
      [e1, "order.status", "accepted", "n=1"], [e2, "order.status", "preparing", "n=2"]]);
    // Ids and statuses only: no staff actor, no free-text reason.
    expect(Object.keys(x.msgs[0]!.data).sort()).toEqual(["at", "from_promised_at", "from_status", "order_id", "to_promised_at", "to_status"]);

    const again = await Raw.open(two, [`order:${A.orderMine}`], customer(A, A.customerSub), "n=1");
    await until(() => again.ready && again.msgs.length >= 1, 2_000, "replay from n=1");
    const e3 = await advance(A, A.orderMine, "preparing", "ready");
    await until(() => again.msgs.length >= 2, 2_000, "live");
    await sleep(200);
    expect(again.msgs.map((m) => [m.id, m.cursor])).toEqual([[e2, "n=2"], [e3, "n=3"]]);
  });

  it("two events of one transaction arrive in the order's seq, not by id (the ids are written out of order)", async () => {
    const x = await Raw.open(two, [`order:${A.orderMine}`], customer(A, A.customerSub));
    await until(() => x.ready, 5_000, "ready");
    const [late, early] = ["ffffffff-ffff-4fff-8fff-ffffffffffff", "00000000-0000-4000-8000-000000000001"];
    await db.withContext("munim_core", { tenant_id: A.tenant, outlet_ids: "*", role: "owner", member_id: A.owner, command_type: "kitchen.ticket.advance.v1" }, async (c) => {
      const outlet = (await c.query<{ outlet_id: string }>(`SELECT outlet_id FROM core."order" WHERE id = $1`, [A.orderMine])).rows[0]!.outlet_id;
      for (const [id, from, to] of [[late, "accepted", "preparing"], [early, "preparing", "ready"]]) {
        await c.query(`INSERT INTO core.order_event (tenant_id, id, outlet_id, order_id, kind, from_status, to_status, actor, reason)
                       VALUES ($1, $2, $3, $4, 'status', $5, $6, $7, null)`, [A.tenant, id, outlet, A.orderMine, from, to, { kind: "member", id: A.owner }]);
      }
      await c.query(`INSERT INTO core.outbox (tenant_id, id, aggregatetype, aggregateid, type, payload) VALUES ($1, $2, 'order', $3, 'munim.kitchen.ticket.advanced.v1', $4)`,
        [A.tenant, randomUUID(), A.orderMine, { data: { order_id: A.orderMine, outlet_id: outlet, status: "ready" } }]);
    });
    await until(() => x.msgs.length === 2, 2_000, "both events");
    expect(x.msgs.map((m) => [m.id, m.data.to_status])).toEqual([[late, "preparing"], [early, "ready"]]);
  });

  it("a guest with the order's token follows that order only", async () => {
    const g = await Raw.open(two, [`order:${A.guestOrder}`], guest(A));
    await until(() => g.ready, 5_000, "ready");
    await advance(A, A.orderMine, "ready", "completed");
    const e = await advance(A, A.guestOrder, "placed", "accepted");
    await until(() => g.msgs.length === 1, 2_000, "guest event");
    await sleep(200);
    expect(g.msgs.map((m) => [m.id, m.data.order_id, m.cursor])).toEqual([[e, A.guestOrder, "n=1"]]);
  });

  it("the shopper read context itself (no override, W1 fix #78) sees only the shopper's own order rows", async () => {
    // Events on four orders exist; the explicit order filter in the feed is not involved here — this asks RLS.
    await advance(A, A.orderOther, "placed", "accepted");
    await advance(A, A.orderO2, "placed", "accepted");
    const pool = new pg.Pool({ ...login("munim_core"), max: 1 });
    onTestFinished(() => pool.end());
    const visible = (ctx: ReturnType<typeof readContext>) => withContext(pool, ctx, async (q) => ({
      orders: (await q.query<{ id: string }>(`SELECT id FROM core."order" ORDER BY id`)).rows.map((r) => r.id),
      events: (await q.query<{ order_id: string }>(`SELECT DISTINCT order_id FROM core.order_event ORDER BY order_id`)).rows.map((r) => r.order_id),
      outbox: Number((await q.query<{ n: string }>(`SELECT count(*) AS n FROM core.outbox`)).rows[0]!.n),
    }));
    // Exactly the contexts the feed reads under (feed.ts readContext — authorise and every drain use it).
    const cust = readContext({ kind: "customer", tenant_id: A.tenant, channel_id: A.channel, customer_id: A.customerId, profile: true, sub: A.customerSub });
    const gst = readContext({ kind: "guest", tenant_id: A.tenant, channel_id: A.channel, order_id: A.guestOrder, guest_access_hash: sha256(A.guestToken).toString("hex") });
    expect(cust.outlet_ids).toEqual([]);
    expect(await visible(cust)).toEqual({ orders: [A.orderMine], events: [A.orderMine], outbox: 0 });
    expect(await visible(gst)).toEqual({ orders: [A.guestOrder], events: [A.guestOrder], outbox: 0 });
  });
});

describe("G4 · tenant isolation and forged notifications", () => {
  let A: Tenant;
  let B: Tenant;
  beforeAll(async () => {
    [A, B] = [await world("g4a"), await world("g4b")];
  });

  it("B receives 0 of A's 20 events (A's subscriber 20/20); a forged NOTIFY delivers nothing; red proof with RLS opened", async () => {
    const bSub = await Raw.open(two, [`kds:${B.outlets[0]}`], member(B, B.ownerSub));
    const aSub = await Raw.open(two, [`order:${A.orderMine}`], member(A, A.ownerSub));
    await until(() => bSub.ready && aSub.ready, 5_000, "ready");

    // Tenant A's rows name tenant B's outlet in their data: only RLS (and tenant routing) keeps them from B.
    const aIds: string[] = [];
    for (let i = 0; i < 20; i++) aIds.push(await emit(one, A, { outlet_id: B.outlets[0], order_id: A.orderMine }));
    await until(() => aSub.msgs.length === 20, 2_000, "A's own 20");
    expect(aSub.msgs.map((m) => m.id)).toEqual(aIds);

    // Forged: a NOTIFY on B's tenant naming A's row (any role can NOTIFY).
    await db.admin(`SELECT pg_notify('munim_outbox', $1)`, [`${B.tenant}:${aIds[0]}`]);
    await sleep(500);
    expect(bSub.msgs).toHaveLength(0);

    // Liveness: B's own event still arrives, so the zero above is not a dead stream.
    const bOwn = await emit(one, B, { outlet_id: B.outlets[0] });
    await until(() => bSub.msgs.length === 1, 2_000, "B's own event");
    expect(bSub.msgs.map((m) => m.id)).toEqual([bOwn]);

    // Red proof: open the outbox to every tenant (an extra permissive policy, gotcha 22) and forge again — the
    // same measurement now sees A's rows: exactly those whose (tenant A) seq is above B's cursor.
    const bSeq = part(bSub.cursor, "o");
    const expected = Number((await db.admin<{ n: string }>(`SELECT count(*) AS n FROM core.outbox WHERE id = ANY ($1::uuid[]) AND seq > $2`, [aIds, bSeq])).rows[0]!.n);
    await db.admin(`CREATE POLICY t006_open ON core.outbox USING (true)`);
    try {
      await db.admin(`SELECT pg_notify('munim_outbox', $1)`, [`${B.tenant}:${aIds[0]}`]);
      await until(() => bSub.msgs.length > 1, 2_000, "red proof: leaked rows");
      await sleep(200);
      const leaked = bSub.msgs.filter((m) => aIds.includes(m.id)).length;
      console.log(`G4 red proof: with the outbox opened, B's stream received ${leaked} of A's 20 rows (expected ${expected})`);
      expect(expected).toBeGreaterThan(0);
      expect(leaked).toBe(expected);
    } finally {
      await db.admin(`DROP POLICY t006_open ON core.outbox`);
    }
  });
});

describe("G5 · SDK reader", () => {
  let A: Tenant;
  beforeAll(async () => {
    A = await world("g5");
  });
  const sdk = (inst: Instance, topics: string[], t: Tenant, sub: string) => {
    const got: SdkStreamEvent[] = [];
    const states: string[] = [];
    let tokens = 0;
    const handle = openStream({
      baseUrl: inst.base,
      topics,
      token: () => {
        tokens++;
        return idp.sign({ sub });
      },
      headers: () => ({ [TENANT_HEADER]: t.tenant }),
      onEvent: (e) => got.push(e),
      onState: (s) => states.push(s),
      initialDelayMs: 50,
      maxDelayMs: 1_000,
    });
    onTestFinished(() => handle.close());
    return { handle, got, states, tokens: () => tokens };
  };
  const increasing = (ids: Array<string | null>) => ids.map((id) => part(id, "o")).every((n, i, a) => Number.isFinite(n) && (i === 0 || n > a[i - 1]!));

  it("resumes across a killed LISTEN connection: no loss, no duplicates, ids strictly increasing, fresh token", async () => {
    const s = sdk(two, [`kds:${A.outlets[0]}`], A, A.ownerSub);
    await until(() => s.states.includes("open"), 5_000, "open");
    const sent: string[] = [];
    for (let i = 0; i < 3; i++) sent.push(await emit(one, A, { outlet_id: A.outlets[0] }));
    await until(() => s.got.length === 3, 2_000, "first 3");
    const watcher = await Raw.open(two, [`kds:${A.outlets[0]}`], member(A, A.ownerSub));
    await until(() => watcher.ready, 5_000, "watcher ready");

    const killed = await db.admin(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity
                                    WHERE datname = current_database() AND application_name = 'munim_stream_listen_two'`);
    expect(killed.rowCount).toBe(1);
    // Every open stream on #2 gets the reconnect hint and is closed.
    await until(() => watcher.ended, 2_000, "listener-lost close");
    expect(watcher.control.map((c) => [c.event, c.data])).toEqual([["ready", "{}"], ["reconnect", JSON.stringify({ reason: "listener_lost" })]]);
    for (let i = 0; i < 4; i++) sent.push(await emit(one, A, { outlet_id: A.outlets[0] }));
    await until(() => s.states.filter((x) => x === "open").length >= 2, 10_000, "reopen");
    for (let i = 0; i < 3; i++) sent.push(await emit(one, A, { outlet_id: A.outlets[0] }));
    await until(() => s.got.length >= 10, 5_000, "all 10");
    await sleep(300);
    s.handle.close();
    await s.handle.done;

    expect(s.got.map((e) => e.id)).toEqual(sent);
    expect(new Set(s.got.map((e) => e.id)).size).toBe(10);
    expect(increasing(s.got.map((e) => e.lastEventId))).toBe(true);
    expect(s.tokens()).toBeGreaterThanOrEqual(2);
    expect(lines.some((l) => l.includes("two: stream: LISTEN connection lost"))).toBe(true);
  });

  it("server closes at max age with a reconnect hint; heartbeats arrive; the SDK resumes through repeated closes without loss", async () => {
    const short = await instance("short", { maxAgeMs: 700, heartbeatMs: 150 });
    const raw = await Raw.open(short, [`kds:${A.outlets[0]}`], member(A, A.ownerSub));
    await until(() => raw.ended, 3_000, "max-age close");
    expect(raw.comments).toBeGreaterThanOrEqual(3);
    expect(raw.control.map((c) => c.event)).toEqual(["ready", "reconnect"]);
    expect(JSON.parse(raw.control[1]!.data)).toEqual({ reason: "max_age" });

    const s = sdk(short, [`kds:${A.outlets[0]}`], A, A.ownerSub);
    await until(() => s.states.includes("open"), 5_000, "open");
    const sent: string[] = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 4_000) {
      sent.push(await emit(one, A, { outlet_id: A.outlets[0] }));
      await sleep(130);
    }
    await until(() => s.got.length >= sent.length, 5_000, "every event");
    await sleep(300);
    s.handle.close();
    await s.handle.done;
    console.log(`G5 max-age: ${sent.length} events across ${s.states.filter((x) => x === "open").length} connections`);
    expect(s.states.filter((x) => x === "open").length).toBeGreaterThanOrEqual(3);
    expect(s.got.map((e) => e.id)).toEqual(sent);
    expect(increasing(s.got.map((e) => e.lastEventId))).toBe(true);
  });

  it("a LISTEN factory that throws answers 503 and the process keeps serving", async () => {
    const broken = await instance("broken", {
      readyTimeoutMs: 300,
      connect: () => {
        throw new Error("no session connection string");
      },
    });
    const r = await Raw.open(broken, [`kds:${A.outlets[0]}`], member(A, A.ownerSub));
    expect(r.status).toBe(503);
    expect(lines.some((l) => l.startsWith("broken: stream: LISTEN connection failed"))).toBe(true);
    const ok = await Raw.open(two, [`kds:${A.outlets[0]}`], member(A, A.ownerSub));
    await until(() => ok.ready, 5_000, "healthy instance still streams");
  });

  it("a refused topic stops the reader instead of retrying", async () => {
    const s = sdk(two, [`kds:${randomUUID()}`], A, A.ownerSub);
    await expect(s.handle.done).rejects.toMatchObject({ name: "StreamRefused", status: 404 });
    expect(s.tokens()).toBe(1);
  });

  it("guest mode: follows its order with the guest token; a bad token or a 401 stops it (no retry, no Authorization)", async () => {
    const got: SdkStreamEvent[] = [];
    const g = openStream({
      baseUrl: two.base, topics: [`order:${A.guestOrder}`], guestToken: A.guestToken,
      headers: () => ({ [STOREFRONT_KEY_HEADER]: A.key }), onEvent: (e) => got.push(e), initialDelayMs: 50,
    });
    onTestFinished(() => g.close());
    await sleep(300);
    const e = await advance(A, A.guestOrder, "placed", "accepted");
    await until(() => got.length === 1, 2_000, "guest event via SDK");
    expect([got[0]!.id, got[0]!.lastEventId]).toEqual([e, "n=1"]);
    g.close();
    await g.done;

    const bad = openStream({
      baseUrl: two.base, topics: [`order:${A.guestOrder}`], guestToken: randomBytes(24).toString("base64url"),
      headers: () => ({ [STOREFRONT_KEY_HEADER]: A.key }), onEvent: () => {}, initialDelayMs: 50,
    });
    await expect(bad.done).rejects.toMatchObject({ name: "StreamRefused", status: 404 });

    const calls: Array<Record<string, string>> = [];
    const stub = (async (_url: string, init: { headers: Record<string, string> }) => {
      calls.push(init.headers);
      return new Response("{}", { status: 401 });
    }) as unknown as typeof fetch;
    const g401 = openStream({ baseUrl: "http://stub.invalid", topics: ["order:x"], guestToken: "guest-token-0123456789", onEvent: () => {}, fetch: stub, initialDelayMs: 10 });
    await expect(g401.done).rejects.toMatchObject({ name: "StreamRefused", status: 401 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.Authorization).toBeUndefined();
    expect(calls[0]![GUEST_TOKEN_HEADER]).toBe("guest-token-0123456789");
  });
});

describe("SDK guestToken option (R3-M6)", () => {
  it("sends X-Munim-Guest-Token and the storefront key on every request, from a string or a function", async () => {
    const seen: Array<Headers> = [];
    const fetchSpy = (async (req: Request) => {
      seen.push(req.headers);
      return new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const c = createMunimClient({ baseUrl: "http://sdk.test", storefrontKey: "sf_k", guestToken: async () => "guest-abc", fetch: fetchSpy });
    await c.GET("/v1/storefront/outlets", {});
    await createMunimClient({ baseUrl: "http://sdk.test", guestToken: "plain", fetch: fetchSpy }).GET("/v1/tenant", {});
    expect(seen.map((h) => h.get(GUEST_TOKEN_HEADER))).toEqual(["guest-abc", "plain"]);
    expect(seen[0]!.get(STOREFRONT_KEY_HEADER)).toBe("sf_k");
    expect(seen[1]!.get(STOREFRONT_KEY_HEADER)).toBeNull();
  });
});
