// T-023 gates — the kitchen module through the real app (member auth → withContext → RLS → book guard).
//   illegal transition 409 / legal 200 (stale from_status, skips, reversals, replay); tickets created with the order
//   by station with their due_at; ticket numbers (the order's ticket_no) reset at the outlet's cutoff, not midnight;
//   KDS colours at the D-2 thresholds on hand-written timestamps; a prep-list draft writes nothing until approved and
//   approval writes exactly the expected lines; shops: the kitchen does not apply. Synthetic data only.
// Expected values are written by hand in this file, never derived from the code under test.
import { createLogger } from "@munim/config";
import { CommandResult } from "@munim/contracts";
import { KdsBoardResponse, PrepListResponse } from "@munim/contracts/kitchen";
import { PACKS } from "@munim/contracts/packs";
import { businessDate } from "@munim/core-domain/tz";
import { buildWorld, type TestDb } from "@munim/db";
import type { Hono } from "hono";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AppEnv, createApp, TENANT_HEADER } from "../src/app.ts";
import { type CommandHandler, executeCommand, uuidv7 } from "../src/commit/index.ts";
import { parseStoredEvent } from "../src/commit/outbox.ts";
import { createTicketsFor, buildBoard, ticketColour, isLegalAdvance } from "../src/modules/kitchen/index.ts";
import { createLocalIdp } from "../src/auth/local-idp.ts";
import { runTemplate } from "../src/modules/approvals/snapshots.ts";
import { seedChart } from "../src/modules/finance/index.ts";
import { openDb } from "./db.ts";

const idp = createLocalIdp();
let db: TestDb;
let pools: { core: pg.Pool; svc: pg.Pool };
let app: Hono<AppEnv>;

const T = {
  tenant: "", owner: "", staff: "", mgr1: uuidv7(), mgr2: uuidv7(), channel: "", currency: "", customer: "",
  outlets: ["", "", ""] as [string, string, string], shop: uuidv7(),
  itemTandoor: "", itemPlain: uuidv7(), ingredient: "", ing2: uuidv7(),
  subs: { owner: `owner-${uuidv7()}`, staff: `staff-${uuidv7()}`, mgr1: `mgr1-${uuidv7()}`, mgr2: `mgr2-${uuidv7()}` },
};
type Who = keyof typeof T.subs;
const own = (command_type: string) => ({ tenant_id: T.tenant, outlet_ids: "*" as const, role: "owner" as const, member_id: T.owner, command_type });

type Res = Omit<Response, "json"> & { json(): Promise<any> };
const call = async (method: string, path: string, who: Who, body?: unknown): Promise<Res> =>
  (await app.request(path, {
    method,
    headers: { Authorization: `Bearer ${idp.sign({ sub: T.subs[who] })}`, [TENANT_HEADER]: T.tenant, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })) as Res;
const one = async <R extends pg.QueryResultRow>(sql: string, params: unknown[] = []) => (await db.admin(sql, params)).rows[0] as R;
const count = async (sql: string, params: unknown[] = []) => Number((await one<{ n: string }>(sql, params)).n);
const env = (type: string, payload: unknown, key = `k-${uuidv7()}`) => ({ command_id: uuidv7(), idempotency_key: key, type, payload });

/** Stand-in for T-022's orders.place.v1: inserts the order and lines, then calls THE SEAM in the same transaction. */
async function place(o: { outlet: string; items: string[]; promised_at?: string | null; status?: string; customer?: string; total?: number; options?: string[] }): Promise<{ order: string; tickets: Array<{ ticket_id: string; station: string }>; applicable: boolean }> {
  const order = uuidv7();
  let result!: Awaited<ReturnType<typeof createTicketsFor>>;
  const handler: CommandHandler = {
    type: "orders.place.v1",
    async run(c) {
      await c.query(
        `INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, kind, status, subtotal_minor, tax_minor, total_minor, currency, pricing_snapshot, promised_at, customer_id)
         VALUES ($1, $2, $3, $4, 'dine_in', $5, $8, 0, $8, $6, '{}', $7, $9)`,
        [T.tenant, order, o.outlet, T.channel, o.status ?? "placed", T.currency, o.promised_at ?? null, o.total ?? 1000, o.customer ?? null]);
      for (const [i, item] of o.items.entries()) {
        await c.query(`INSERT INTO core.order_line (tenant_id, id, outlet_id, order_id, line_no, item_id, qty_milli, unit_price_minor, options) VALUES ($1, $2, $3, $4, $5, $6, 1000, 1000, $7)`,
          [T.tenant, uuidv7(), o.outlet, order, i + 1, item, JSON.stringify(i === 0 ? o.options ?? [] : [])]);
      }
      result = await createTicketsFor(c, order);
      return { entityId: order, audit: [{ entity: "core.order", entityId: order }, ...result.audit], events: result.events };
    },
  };
  await executeCommand({ tx: (fn) => db.withContext("munim_core", own("orders.place.v1"), fn), tenantId: T.tenant, actor: { kind: "member", id: T.owner, role: "owner" } },
    env("orders.place.v1", {}) as never, handler);
  return { order, tickets: result.tickets, applicable: result.applicable };
}

beforeAll(async () => {
  db = await openDb();
  const w = await buildWorld(db);
  Object.assign(T, { tenant: w.tenant, owner: w.owner, staff: w.staff, outlets: w.outlets, channel: w.channel, currency: w.currency, itemTandoor: w.item, ingredient: w.ingredient, customer: w.customer });
  // Completion through the kitchen posts the sale (W2-R9): finance needs the pack's full chart (the world seeds
  // only cash + sales; A12 moves this into buildWorld), and earn skips guest profiles (T-028).
  await db.withContext("munim_core", own("finance.account.upsert.v1"), (c) => seedChart(c, PACKS.IN));
  await db.withContext("munim_core", own("customers.customer.upsert.v1"), (c) =>
    c.query(`UPDATE core.customer SET is_guest = false, idp_sub = 'kitchen-cust-sub' WHERE id = $1`, [w.customer]));
  await db.withContext("munim_core", own("tenancy.member.invite.v1"), async (c) => {
    await c.query(`UPDATE core.member SET idp_sub = $2 WHERE id = $1`, [T.owner, T.subs.owner]);
    await c.query(`UPDATE core.member SET idp_sub = $2 WHERE id = $1`, [T.staff, T.subs.staff]);
    for (const [who, outlets] of [["mgr1", [T.outlets[0]]], ["mgr2", [T.outlets[1]]]] as const) {
      await c.query(`INSERT INTO core.member (tenant_id, id, idp_sub, name, email) VALUES ($1, $2, $3, $4, $5)`, [T.tenant, T[who], T.subs[who], `Synthetic ${who}`, `${who}@example.test`]);
      await c.query(`INSERT INTO core.membership (tenant_id, member_id, role, outlet_ids) VALUES ($1, $2, 'manager', $3)`, [T.tenant, T[who], outlets]);
    }
  });
  await db.withContext("munim_core", own("tenancy.outlet.create.v1"), (c) =>
    c.query(`INSERT INTO core.outlet (tenant_id, id, name, kind, tz, address) VALUES ($1, $2, 'Synthetic Shop', 'store', 'Asia/Kolkata', 'Synthetic street')`, [T.tenant, T.shop]));
  await db.withContext("munim_core", own("catalogue.item.upsert.v1"), (c) =>
    c.query(`INSERT INTO core.item (tenant_id, id, kind, name_key, category) VALUES ($1, $2, 'dish', 'menu.plain_rice', 'mains')`, [T.tenant, T.itemPlain]));
  await db.withContext("munim_core", own("inventory.ingredient.upsert.v1"), (c) =>
    c.query(`INSERT INTO core.ingredient (tenant_id, id, name, base_unit) VALUES ($1, $2, 'Synthetic ingredient 2', 'g')`, [T.tenant, T.ing2]));
  // Test-only snapshot template (fixture DB clone): a prep quantity per ingredient — what kitchen.prep_need will be (W3).
  await db.admin(`INSERT INTO evidence.snapshot_template (id, version, sql, params_schema, columns, min_role) VALUES ('test.prep_need', 1, $1, '{"type":"object"}', $2, 'manager')`, [
    `SELECT i.id AS ingredient_id, CASE WHEN i.name = 'Synthetic ingredient 2' THEN 800 ELSE 4200 END::bigint AS prep_qty_milli FROM core.ingredient i WHERE i.id = ANY (ARRAY[:a::uuid, :b::uuid]) ORDER BY (i.name = 'Synthetic ingredient 2')`,
    JSON.stringify([{ name: "ingredient_id", type: "uuid" }, { name: "prep_qty_milli", type: "integer", numeric_source: "core.stock_movement.qty_milli" }]),
  ]);
  pools = { core: db.pool("munim_core", 8), svc: db.pool("munim_svc", 2) };
  const config = { nodeEnv: "test", redact: (s: string) => s };
  app = await createApp({ pools, idp, storefronts: async () => null, config, log: createLogger(config, () => {}) });
});

afterAll(async () => {
  await pools?.core.end();
  await pools?.svc.end();
  await db?.stop();
});

// ── pure rules on hand-written timestamps ───────────────────────────────────────────────────────────────────
describe("D-2 colour thresholds (hand-written timestamps)", () => {
  const due = new Date("2026-10-10T12:00:00.000Z");
  const at = (s: string) => new Date(`2026-10-10T${s}Z`);
  it.each([
    ["11:56:59.999", "normal"], ["11:57:00.000", "amber"], ["11:58:30.000", "amber"], ["11:59:59.999", "amber"],
    ["12:00:00.000", "red"], ["12:00:01.000", "red"], ["13:00:00.000", "red"], ["09:00:00.000", "normal"],
  ] as const)("now %s vs due 12:00:00 → %s", (now, colour) => {
    expect(ticketColour(at(now), due, "preparing")).toBe(colour);
    expect(ticketColour(at(now), due, "queued")).toBe(colour);
  });
  it("a ready ticket and a ticket with no due time are never coloured", () => {
    expect(ticketColour(at("12:30:00.000"), due, "ready")).toBe("normal");
    expect(ticketColour(at("12:30:00.000"), null, "preparing")).toBe("normal");
  });
  it("legal moves are one step forward only", () => {
    expect([isLegalAdvance("queued", "preparing"), isLegalAdvance("preparing", "ready"), isLegalAdvance("ready", "done")]).toEqual([true, true, true]);
    expect([isLegalAdvance("queued", "ready"), isLegalAdvance("queued", "done"), isLegalAdvance("ready", "preparing"), isLegalAdvance("done", "done"), isLegalAdvance("done", "queued")]).toEqual([false, false, false, false, false]);
  });
  it("the cutoff, not midnight, ends the business day (core-domain parity, instants written by hand)", () => {
    // Asia/Kolkata is UTC+05:30: 22:00Z = 03:30 on 11 Oct local (before the 04:00 cutoff) → still 10 Oct's business day.
    expect(businessDate("2026-10-10T22:00:00Z", "Asia/Kolkata", "04:00")).toBe("2026-10-10");
    expect(businessDate("2026-10-10T22:30:00Z", "Asia/Kolkata", "04:00")).toBe("2026-10-11");
  });
});

// ── tickets: creation by station, due_at, the advance command ───────────────────────────────────────────────
describe("tickets are created with the order, routed by station", () => {
  it("a tandoor dish (prep_time 600 s) and a plain dish (no prep_time) → two tickets, due 600 s and 900 s after creation", async () => {
    const p = await place({ outlet: T.outlets[0], items: [T.itemTandoor, T.itemPlain] });
    expect(p.applicable).toBe(true);
    expect(p.tickets.map((t) => t.station).sort()).toEqual(["kitchen", "tandoor"]);
    const rows = (await db.admin(`SELECT station, status, extract(epoch FROM due_at - created_at)::int AS lead FROM core.kitchen_ticket WHERE order_id = $1 ORDER BY station`, [p.order])).rows;
    expect(rows).toEqual([{ station: "kitchen", status: "queued", lead: 900 }, { station: "tandoor", status: "queued", lead: 600 }]);
    // A scheduled order's tickets are due at its promised time.
    const s = await place({ outlet: T.outlets[0], items: [T.itemTandoor], promised_at: "2026-10-10T17:00:00Z" });
    expect((await one<{ d: string }>(`SELECT due_at AT TIME ZONE 'UTC' AS d FROM core.kitchen_ticket WHERE order_id = $1`, [s.order])).d.toString()).toContain("17:00:00");
  });

  it("the seam is idempotent and writes the created events with data.outlet_id (registered schema, outbox)", async () => {
    const p = await place({ outlet: T.outlets[0], items: [T.itemTandoor] });
    const again = await db.withContext("munim_core", own("orders.place.v1"), (c) => createTicketsFor(c, p.order));
    expect({ n: again.tickets.length, events: again.events.length, same: again.tickets[0]!.ticket_id === p.tickets[0]!.ticket_id }).toEqual({ n: 1, events: 0, same: true });
    expect(await count(`SELECT count(*) n FROM core.kitchen_ticket WHERE order_id = $1`, [p.order])).toBe(1);
    const ev = await one<{ payload: unknown }>(`SELECT payload FROM core.outbox WHERE type = 'munim.kitchen.ticket.created.v1' AND aggregateid = $1`, [p.tickets[0]!.ticket_id]);
    const parsed = parseStoredEvent(ev.payload);
    expect(parsed.data).toEqual({ ticket_id: p.tickets[0]!.ticket_id, order_id: p.order, outlet_id: T.outlets[0], station: "tandoor", status: "queued" });
  });
});

describe("the seam inside a shopper's transaction", () => {
  it("a customer's own order gets its ticket (written as the system, outlet in app.outlet_ids)", async () => {
    const customer = (await one<{ id: string }>(`SELECT id FROM core.customer LIMIT 1`)).id;
    const order = uuidv7();
    await db.withContext("munim_core", own("orders.place.v1"), async (c) => {
      await c.query(`INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, kind, subtotal_minor, total_minor, currency, pricing_snapshot, customer_id) VALUES ($1, $2, $3, $4, 'pickup', 100, 100, $5, '{}', $6)`,
        [T.tenant, order, T.outlets[0], T.channel, T.currency, customer]);
      await c.query(`INSERT INTO core.order_line (tenant_id, id, outlet_id, order_id, line_no, item_id, qty_milli, unit_price_minor) VALUES ($1, $2, $3, $4, 1, $5, 1000, 100)`, [T.tenant, uuidv7(), T.outlets[0], order, T.itemTandoor]);
    });
    const r = await db.withContext("munim_core", { tenant_id: T.tenant, outlet_ids: [T.outlets[0]], role: "customer", customer_id: customer, command_type: "orders.place.v1" }, (c) => createTicketsFor(c, order));
    expect(r.tickets.map((t) => t.station)).toEqual(["tandoor"]);
    expect(await count(`SELECT count(*) n FROM core.kitchen_ticket WHERE order_id = $1`, [order])).toBe(1);
  });
});

describe("kitchen.ticket.advance.v1", () => {
  const advance = (who: Who, id: string, from: string, to: string, key?: string) =>
    call("POST", `/v1/kitchen/tickets/${id}:advance`, who, env("kitchen.ticket.advance.v1", { ticket_id: id, from_status: from, to_status: to }, key));
  const status = async (id: string) => (await one<{ status: string }>(`SELECT status FROM core.kitchen_ticket WHERE id = $1`, [id])).status;
  const orderStatus = async (id: string) => (await one<{ status: string }>(`SELECT status FROM core."order" WHERE id = $1`, [id])).status;

  it("illegal moves → 409 illegal_transition (skip, reversal, repeat); legal → 200; nothing changes on a refusal", async () => {
    const p = await place({ outlet: T.outlets[0], items: [T.itemTandoor] });
    const t = p.tickets[0]!.ticket_id;
    for (const [from, to] of [["queued", "ready"], ["queued", "done"], ["queued", "queued"], ["preparing", "queued"]] as const) {
      const r = await advance("staff", t, from, to);
      expect([r.status, (await r.json()).error.code]).toEqual([409, "illegal_transition"]);
    }
    expect(await status(t)).toBe("queued");
    const ok = await advance("staff", t, "queued", "preparing");
    expect(ok.status).toBe(200);
    expect(CommandResult.parse(await ok.json())).toMatchObject({ type: "kitchen.ticket.advance.v1", entity_id: t });
    expect(await status(t)).toBe("preparing");
    // accepted_at is stamped when work starts; ready_at when it is ready.
    expect((await one<{ a: boolean; r: boolean }>(`SELECT accepted_at IS NOT NULL a, ready_at IS NOT NULL r FROM core.kitchen_ticket WHERE id = $1`, [t]))).toEqual({ a: true, r: false });
  });

  it("a stale from_status (another device moved it first) → 409 and the second move does not apply", async () => {
    const p = await place({ outlet: T.outlets[0], items: [T.itemTandoor] });
    const t = p.tickets[0]!.ticket_id;
    expect((await advance("staff", t, "queued", "preparing")).status).toBe(200);
    const stale = await advance("mgr1", t, "queued", "preparing");
    expect([stale.status, (await stale.json()).error.code]).toEqual([409, "illegal_transition"]);
    expect(await status(t)).toBe("preparing");
    expect(await count(`SELECT count(*) n FROM core.outbox WHERE type = 'munim.kitchen.ticket.advanced.v1' AND aggregateid = $1`, [t])).toBe(1);
  });

  it("walks the order: placed → accepted → preparing on the first start, ready when every station is ready, completed when all done (order_event rows)", async () => {
    const p = await place({ outlet: T.outlets[0], items: [T.itemTandoor, T.itemPlain] });
    const [a, b] = [p.tickets.find((x) => x.station === "tandoor")!.ticket_id, p.tickets.find((x) => x.station === "kitchen")!.ticket_id];
    expect(await orderStatus(p.order)).toBe("placed");
    expect((await advance("staff", a, "queued", "preparing")).status).toBe(200);
    expect(await orderStatus(p.order)).toBe("preparing");
    expect((await advance("staff", a, "preparing", "ready")).status).toBe(200);
    expect(await orderStatus(p.order)).toBe("preparing"); // the other station has not started
    expect((await advance("staff", b, "queued", "preparing")).status).toBe(200);
    expect((await advance("staff", b, "preparing", "ready")).status).toBe(200);
    expect(await orderStatus(p.order)).toBe("ready");
    expect((await advance("staff", a, "ready", "done")).status).toBe(200);
    expect(await orderStatus(p.order)).toBe("ready");
    expect((await advance("staff", b, "ready", "done")).status).toBe(200);
    expect(await orderStatus(p.order)).toBe("completed");
    // Hops of one advance share the transaction's `at` and uuidv7 ids are not monotonic within a millisecond: the
    // order's own sequence (0016 seq, R3-M1) is the order they were written in.
    const ev = (await db.admin(`SELECT from_status, to_status FROM core.order_event WHERE order_id = $1 AND from_status IS NOT NULL ORDER BY seq`, [p.order])).rows;
    expect(ev).toEqual([
      { from_status: "placed", to_status: "accepted" }, { from_status: "accepted", to_status: "preparing" },
      { from_status: "preparing", to_status: "ready" }, { from_status: "ready", to_status: "completed" },
    ]);
    // Every advance wrote one kitchen event naming the outlet (what the kds:<outlet> topic selects).
    const evs = (await db.admin(`SELECT payload->'data' d FROM core.outbox WHERE type = 'munim.kitchen.ticket.advanced.v1' AND payload->'data'->>'order_id' = $1`, [p.order])).rows;
    expect(evs.length).toBe(6);
    expect(evs.every((e) => (e as { d: { outlet_id: string } }).d.outlet_id === T.outlets[0])).toBe(true);
    // A done ticket cannot move again.
    expect((await advance("staff", a, "done", "done")).status).toBe(409);
  });

  it("W2-R9: completion through the kitchen goes through orders.advanceOrder — each order_event paired with its outbox event, the loyalty earn and the sale posting derived", async () => {
    // Hand values: total 2500, tax 0 → net 2500 → earn floor(2500 / 1000) = 2 points (T-028 rate); the sale entry
    // debits the receivable 2500 and credits sales 2500 (no tax line at 0).
    const p = await place({ outlet: T.outlets[0], items: [T.itemTandoor], customer: T.customer, total: 2500 });
    const t = p.tickets[0]!.ticket_id;
    for (const [a, b] of [["queued", "preparing"], ["preparing", "ready"], ["ready", "done"]] as const) expect((await advance("staff", t, a, b)).status).toBe(200);
    expect(await orderStatus(p.order)).toBe("completed");
    const statusEvents = await count(`SELECT count(*) n FROM core.order_event WHERE order_id = $1 AND kind = 'status' AND from_status IS NOT NULL`, [p.order]);
    const paired = (await db.admin(`SELECT payload->'data'->>'from_status' AS f, payload->'data'->>'to_status' AS t, payload->'data'->>'outlet_id' AS o
                                      FROM core.outbox WHERE type = 'munim.orders.order.status_changed.v1' AND aggregateid = $1 ORDER BY seq`, [p.order])).rows;
    expect([statusEvents, paired]).toEqual([4, [
      { f: "placed", t: "accepted", o: T.outlets[0] }, { f: "accepted", t: "preparing", o: T.outlets[0] },
      { f: "preparing", t: "ready", o: T.outlets[0] }, { f: "ready", t: "completed", o: T.outlets[0] },
    ]]);
    const earn = (await db.admin(`SELECT points::int, origin->>'rule_id' AS rule FROM core.loyalty_entry WHERE order_id = $1`, [p.order])).rows;
    expect(earn).toEqual([{ points: 2, rule: "customers.loyalty_earn" }]);
    const je = (await db.admin(
      `SELECT j.origin->>'kind' AS kind, j.origin->>'rule_id' AS rule, sum(p.amount_minor) FILTER (WHERE p.amount_minor > 0)::int AS dr, sum(p.amount_minor)::int AS net
         FROM core.journal_entry j JOIN core.posting p ON p.tenant_id = j.tenant_id AND p.journal_entry_id = j.id
        WHERE j.source_id = $1 GROUP BY j.tenant_id, j.id`, [p.order])).rows;
    expect(je).toEqual([{ kind: "derivation", rule: "finance.post_order", dr: 2500, net: 0 }]);
  });

  it("a cancelled order's ticket cannot advance (409)", async () => {
    const p = await place({ outlet: T.outlets[0], items: [T.itemTandoor] });
    await db.withContext("munim_core", own("kitchen.ticket.advance.v1"), (c) => c.query(`UPDATE core."order" SET status = 'cancelled' WHERE id = $1`, [p.order]));
    expect((await advance("staff", p.tickets[0]!.ticket_id, "queued", "preparing")).status).toBe(409);
  });

  it("a staff member of another outlet gets 404 (RLS), the outlet's own staff 200; replay returns the same bytes", async () => {
    const p = await place({ outlet: T.outlets[1], items: [T.itemTandoor] });
    const t = p.tickets[0]!.ticket_id;
    const other = await advance("staff", t, "queued", "preparing"); // staff is scoped to outlet 1 only
    expect([other.status, (await other.json()).error.code]).toEqual([404, "not_found"]);
    expect(await status(t)).toBe("queued");
    const body = env("kitchen.ticket.advance.v1", { ticket_id: t, from_status: "queued", to_status: "preparing" }, "advance-replay-key-1");
    const first = await call("POST", `/v1/kitchen/tickets/${t}:advance`, "mgr2", body);
    const second = await call("POST", `/v1/kitchen/tickets/${t}:advance`, "mgr2", body);
    expect([first.status, second.status, second.headers.get("X-Munim-Replayed")]).toEqual([200, 200, "true"]);
    expect(await second.text()).toBe(await first.text());
    expect(await count(`SELECT count(*) n FROM core.outbox WHERE type = 'munim.kitchen.ticket.advanced.v1' AND aggregateid = $1`, [t])).toBe(1);
  });

  it("a body whose ticket_id differs from the path → 422; an unknown ticket → 404", async () => {
    const p = await place({ outlet: T.outlets[0], items: [T.itemTandoor] });
    const r = await call("POST", `/v1/kitchen/tickets/${p.tickets[0]!.ticket_id}:advance`, "staff", env("kitchen.ticket.advance.v1", { ticket_id: uuidv7(), from_status: "queued", to_status: "preparing" }));
    expect(r.status).toBe(422);
    const ghost = uuidv7();
    expect((await advance("staff", ghost, "queued", "preparing")).status).toBe(404);
  });
});

// ── ticket numbers roll at the cutoff in the outlet's timezone ─────────────────────────────────────────────
describe("short ticket numbers reset at the outlet's business-day cutoff, not midnight", () => {
  // The trigger reads now(); so the test moves the CUTOFF instead of the clock: with the clock at mid-day local time,
  // cutoff 23:59 puts "now" in yesterday's business day and cutoff 00:00 in today's.
  const zones = ["Asia/Kolkata", "Australia/Melbourne", "Pacific/Auckland", "America/New_York"];
  const hourIn = (z: string) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: z, hour: "2-digit", hourCycle: "h23" }).format(new Date()));
  const dateIn = (z: string, shiftDays = 0) => {
    const d = new Date(Date.now() + shiftDays * 86_400_000);
    return new Intl.DateTimeFormat("en-CA", { timeZone: z, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  };
  const setOutlet = (outlet: string, sets: string, params: unknown[] = []) =>
    db.withContext("munim_core", own("tenancy.outlet.update.v1"), (c) => c.query(`UPDATE core.outlet SET ${sets} WHERE id = $1`, [outlet, ...params]));
  const orderNo = async (outlet: string) => {
    const o = uuidv7();
    await db.withContext("munim_core", own("orders.place.v1"), (c) => c.query(
      `INSERT INTO core."order" (tenant_id, id, outlet_id, channel_id, kind, subtotal_minor, total_minor, currency, pricing_snapshot) VALUES ($1, $2, $3, $4, 'takeaway', 100, 100, $5, '{}')`,
      [T.tenant, o, outlet, T.channel, T.currency]));
    return one<{ business_date: string; ticket_no: number }>(`SELECT business_date::text, ticket_no FROM core."order" WHERE id = $1`, [o]);
  };

  it("two orders before the cutoff are #1, #2 of yesterday's business day; the first after it is #1 of today's; the old day keeps counting", async () => {
    const zone = zones.find((z) => hourIn(z) >= 6 && hourIn(z) <= 20)!;
    const outlet = T.outlets[2];
    await setOutlet(outlet, "tz = $2, business_day_cutoff = '23:59'", [zone]);
    const yesterday = dateIn(zone, -1);
    const today = dateIn(zone);
    expect(await orderNo(outlet)).toEqual({ business_date: yesterday, ticket_no: 1 });
    expect(await orderNo(outlet)).toEqual({ business_date: yesterday, ticket_no: 2 });
    await setOutlet(outlet, "business_day_cutoff = '00:00'");
    expect(await orderNo(outlet)).toEqual({ business_date: today, ticket_no: 1 });
    await setOutlet(outlet, "business_day_cutoff = '23:59'");
    expect(await orderNo(outlet)).toEqual({ business_date: yesterday, ticket_no: 3 });
    // Another outlet counts on its own.
    expect((await orderNo(T.outlets[1])).ticket_no).toBeGreaterThanOrEqual(1);
    expect(await count(`SELECT count(*) n FROM core.ticket_counter WHERE outlet_id = $1`, [outlet])).toBe(2);
  });
});

// ── KDS read model ────────────────────────────────────────────────────────────────────────────────────────
describe("KDS board", () => {
  it("colours match D-2 on hand-written timestamps; red first; ready tickets are not coloured; scheduled orders go to 'later'", async () => {
    // Earlier tests left tickets due at the real clock; this board is judged at a fixed instant, so start clean.
    await db.admin(`DELETE FROM core.kitchen_ticket WHERE outlet_id = $1`, [T.outlets[1]]);
    // An option on the dish: the board names it for the station (contract: option id + name key).
    const [group, hot] = [uuidv7(), uuidv7()];
    await db.withContext("munim_core", own("catalogue.item.upsert.v1"), async (c) => {
      await c.query(`INSERT INTO core.option_group (tenant_id, id, item_id, name_key, max_select) VALUES ($1, $2, $3, 'menu.kds_spice', 1)`, [T.tenant, group, T.itemTandoor]);
      await c.query(`INSERT INTO core.option (tenant_id, id, option_group_id, name_key, price_delta_minor, currency) VALUES ($1, $2, $3, 'menu.kds_spice.hot', 0, $4)`, [T.tenant, hot, group, T.currency]);
    });
    const mk = async (due: string, items = [T.itemTandoor], options: string[] = []) => {
      const p = await place({ outlet: T.outlets[1], items, options });
      await db.admin(`UPDATE core.kitchen_ticket SET due_at = $2 WHERE order_id = $1`, [p.order, due]);
      return p;
    };
    const normal = await mk("2026-10-10T12:03:01Z"); // 3:01 ahead of "now" (12:00:00): now < due − 3 min → normal
    const amber = await mk("2026-10-10T12:02:59Z"); // 2:59 ahead → amber
    const edge = await mk("2026-10-10T12:03:00Z"); // exactly 3:00 ahead → amber (due − 3 min ≤ now)
    const red = await mk("2026-10-10T12:00:00Z", [T.itemTandoor], [hot]); // due == now → red
    const late = await mk("2026-10-10T11:30:00Z"); // 30 min late → red
    const far = await mk("2026-10-10T13:00:00Z");
    const ready = await mk("2026-10-10T11:00:00Z");
    await db.admin(`UPDATE core.kitchen_ticket SET status = 'ready' WHERE order_id = $1`, [ready.order]);
    const later = await place({ outlet: T.outlets[1], items: [T.itemTandoor], promised_at: "2026-10-10T14:00:00Z" });
    const now = new Date("2026-10-10T12:00:00Z");
    const board = KdsBoardResponse.parse(await db.withContext("munim_core", own("kitchen.ticket.advance.v1"), (c) => buildBoard(c, T.outlets[1], now)));
    const colourOf = (p: { tickets: Array<{ ticket_id: string }> }) => board.tickets.find((x) => x.ticket_id === p.tickets[0]!.ticket_id)!.colour;
    expect([colourOf(normal), colourOf(amber), colourOf(edge), colourOf(red), colourOf(late), colourOf(far), colourOf(ready)])
      .toEqual(["normal", "amber", "amber", "red", "red", "normal", "normal"]);
    // Red tickets sort first, the longest-late first.
    const mine = board.tickets.filter((t) => [late, red].some((p) => p.tickets[0]!.ticket_id === t.ticket_id));
    expect(board.tickets.slice(0, 2).map((t) => t.ticket_id)).toEqual([late.tickets[0]!.ticket_id, red.tickets[0]!.ticket_id]);
    expect(mine.length).toBe(2);
    const lt = board.tickets.find((t) => t.ticket_id === later.tickets[0]!.ticket_id)!;
    // promised 14:00Z, outlet default prep 15 min → surfaces 13:45Z
    expect([lt.lane, lt.surface_at, lt.due_at]).toEqual(["later", "2026-10-10T13:45:00.000Z", "2026-10-10T14:00:00.000Z"]);
    expect(board.tickets.find((t) => t.ticket_id === red.tickets[0]!.ticket_id)!.lane).toBe("now");
    // Lines carry the dish's name_key and quantity; a station filter narrows the board.
    expect(board.tickets.find((t) => t.ticket_id === red.tickets[0]!.ticket_id)!.lines).toEqual([
      { line_no: 1, item_id: T.itemTandoor, name_key: "menu.paneer_tikka", qty_milli: 1000, options: [{ option_id: hot, name_key: "menu.kds_spice.hot" }], note: null }]);
    const kitchenOnly = await db.withContext("munim_core", own("kitchen.ticket.advance.v1"), (c) => buildBoard(c, T.outlets[1], now, "kitchen"));
    expect(kitchenOnly.tickets.every((t) => t.station === "kitchen")).toBe(true);
    expect(kitchenOnly.tickets.length).toBe(0);
  });

  it("a multi-item order shows each station only its own lines; the route serves the same shape (member scope enforced)", async () => {
    const p = await place({ outlet: T.outlets[0], items: [T.itemTandoor, T.itemPlain] });
    const r = await call("GET", `/v1/kitchen/board?outlet=${T.outlets[0]}`, "staff");
    expect(r.status).toBe(200);
    const board = KdsBoardResponse.parse(await r.json());
    const names = (station: string) => board.tickets.find((t) => t.order_id === p.order && t.station === station)!.lines.map((l) => l.name_key);
    expect([names("tandoor"), names("kitchen")]).toEqual([["menu.paneer_tikka"], ["menu.plain_rice"]]);
    expect(board.stations).toEqual(expect.arrayContaining(["kitchen", "tandoor"]));
    // staff of outlet 1 may not read outlet 2's board
    expect((await call("GET", `/v1/kitchen/board?outlet=${T.outlets[1]}`, "staff")).status).toBe(404);
    expect((await call("GET", `/v1/kitchen/board?outlet=nope`, "staff")).status).toBe(400);
  });
});

// ── shops: not applicable ─────────────────────────────────────────────────────────────────────────────────
describe("kitchen is not applicable to shops", () => {
  it("the seam writes no ticket for a shop order; every kitchen route refuses with 400 — while the same call on a restaurant succeeds", async () => {
    const p = await place({ outlet: T.shop, items: [T.itemPlain] });
    expect({ applicable: p.applicable, tickets: p.tickets.length }).toEqual({ applicable: false, tickets: 0 });
    expect(await count(`SELECT count(*) n FROM core.kitchen_ticket WHERE outlet_id = $1`, [T.shop])).toBe(0);
    const board = await call("GET", `/v1/kitchen/board?outlet=${T.shop}`, "owner");
    const refusal = (await board.json()).error;
    expect([board.status, refusal.code, refusal.reason_code]).toEqual([400, "bad_request", "not_applicable"]);
    expect((await call("GET", `/v1/kitchen/prep-list?outlet=${T.shop}&business_date=2026-10-10`, "owner")).status).toBe(400);
    const pl = await call("POST", "/v1/kitchen/prep-lists", "owner", env("kitchen.prep_list.create.v1", { prep_list_id: uuidv7(), outlet_id: T.shop, business_date: "2026-10-12", lines: [{ ingredient_id: T.ingredient, qty_milli: 1000, unit: "g" }] }));
    expect(pl.status).toBe(400);
    expect(await count(`SELECT count(*) n FROM core.prep_list WHERE outlet_id = $1`, [T.shop])).toBe(0);
    expect((await call("GET", `/v1/kitchen/board?outlet=${T.outlets[0]}`, "owner")).status).toBe(200);
  });
});

// ── prep times ────────────────────────────────────────────────────────────────────────────────────────────
describe("kitchen.prep_time.set.v1", () => {
  const set = (who: Who, over: Record<string, unknown> = {}) =>
    call("POST", "/v1/kitchen/prep-times", who, env("kitchen.prep_time.set.v1", { outlet_id: T.outlets[0], item_id: T.itemTandoor, station: "tandoor", prep_sec: 900, valid_from: "2026-10-20", ...over }));
  it("staff → 403; a manager's own command closes the open row and adds the new one; an earlier start → 409", async () => {
    const denied = await set("staff");
    expect([denied.status, (await denied.json()).error.reason_code]).toEqual([403, "authority_denied"]);
    expect(await count(`SELECT count(*) n FROM core.prep_time WHERE outlet_id = $1 AND item_id = $2 AND station = 'tandoor'`, [T.outlets[0], T.itemTandoor])).toBe(1);
    expect((await set("mgr1")).status).toBe(200);
    const rows = (await db.admin(`SELECT prep_sec, valid_from::text, valid_to::text FROM core.prep_time WHERE outlet_id = $1 AND item_id = $2 AND station = 'tandoor' ORDER BY valid_from`, [T.outlets[0], T.itemTandoor])).rows;
    expect(rows).toEqual([{ prep_sec: 600, valid_from: "2026-10-01", valid_to: "2026-10-20" }, { prep_sec: 900, valid_from: "2026-10-20", valid_to: null }]);
    expect((await set("mgr1", { valid_from: "2026-10-15", prep_sec: 700 })).status).toBe(409);
    expect((await set("mgr2")).status).toBe(404); // outlet 1 is not manager 2's
    // a new order on a later business date would use it; today (10 Oct) still uses 600 s — covered by the first test.
  });
});

// ── prep lists: drafts write nothing until approved ──────────────────────────────────────────────────────
describe("prep lists", () => {
  const OUT = () => T.outlets[0];
  async function snapshot(): Promise<string> {
    const id = uuidv7();
    const params = { a: T.ingredient, b: T.ing2 };
    await db.withContext("munim_svc", { tenant_id: T.tenant, outlet_ids: "*", role: "service" }, async (c) => {
      const run = uuidv7();
      await c.query(`INSERT INTO intel.run (tenant_id, id, trigger, actor, outlet_scope, expires_at) VALUES ($1, $2, 'event', 'watcher:events', $3, now() + interval '1 hour')`, [T.tenant, run, [OUT()]]);
      const { rows } = await runTemplate(c, "test.prep_need", 1, params);
      await c.query(`INSERT INTO evidence.snapshot (tenant_id, id, template_id, template_version, params, run_id, outlet_scope, rows, row_count, sha256)
                     VALUES ($1, $2, 'test.prep_need', 1, $3, $4, $5, $6, $7, repeat('0', 64))`, [T.tenant, id, params, run, [OUT()], JSON.stringify(rows), rows.length]);
    });
    return id;
  }
  const ref = (snap: string, row: number) => `⟨snap:${snap}·${row}·prep_qty_milli⟩`;
  async function draftFor(date: string, snap: string): Promise<{ id: string; list: string }> {
    const id = uuidv7();
    const list = uuidv7();
    const payload = {
      prep_list_id: list, outlet_id: OUT(), business_date: date,
      lines: [{ ingredient_id: T.ingredient, qty_milli: ref(snap, 0), unit: "g" }, { ingredient_id: T.ing2, qty_milli: ref(snap, 1), unit: "kg" }],
    };
    await db.withContext("munim_svc", { tenant_id: T.tenant, outlet_ids: "*", role: "service" }, (c) =>
      c.query(`INSERT INTO core.draft (tenant_id, id, outlet_ids, source, command_type, command_payload, based_on) VALUES ($1, $2, $3, 'intel:kitchen', 'kitchen.prep_list.create.v1', $4, $5)`,
        [T.tenant, id, [OUT()], payload, JSON.stringify([ref(snap, 0), ref(snap, 1)])]));
    return { id, list };
  }
  const approve = (who: Who, draft: string, edited: unknown = null) =>
    call("POST", `/v1/drafts/${draft}:approve`, who, env("drafts.approve.v1", { draft_id: draft, command_type: "kitchen.prep_list.create.v1", edited_payload: edited, reason: edited ? "Fewer covers tonight" : null }));
  const lines = async (list: string) => (await db.admin(`SELECT ingredient_id, qty_milli::int AS qty_milli, unit FROM core.prep_list_line WHERE prep_list_id = $1 ORDER BY unit`, [list])).rows;

  it("states: an existing list shows its lines; a date with no list, draft or forecast cannot be verified (forecast_stale); with a forecast it is 'none'", async () => {
    const r = await call("GET", `/v1/kitchen/prep-list?outlet=${OUT()}&business_date=2026-10-10`, "staff");
    const v = PrepListResponse.parse(await r.json());
    expect([v.state, v.prep_list?.lines]).toEqual(["approved", [{ ingredient_id: T.ingredient, item_id: null, qty_milli: 2000000, unit: "g" }]]);
    const stale = PrepListResponse.parse(await (await call("GET", `/v1/kitchen/prep-list?outlet=${OUT()}&business_date=2027-01-05`, "staff")).json());
    expect([stale.state, stale.reason_code, stale.prep_list]).toEqual(["cannot_verify", "forecast_stale", null]);
    await db.admin(`INSERT INTO intel.forecast_point (tenant_id, id, forecast_run_id, outlet_id, item_id, business_on, method, qty_milli, lo_qty_milli, hi_qty_milli, inputs_snapshot_id)
                    SELECT tenant_id, $1, forecast_run_id, outlet_id, item_id, '2027-01-05', method, qty_milli, lo_qty_milli, hi_qty_milli, inputs_snapshot_id FROM intel.forecast_point WHERE outlet_id = $2 LIMIT 1`, [uuidv7(), OUT()]);
    const none = PrepListResponse.parse(await (await call("GET", `/v1/kitchen/prep-list?outlet=${OUT()}&business_date=2027-01-05`, "staff")).json());
    expect([none.state, none.reason_code]).toEqual(["none", null]);
  });

  it("a draft writes nothing: 0 lists, 0 lines, state 'waiting' with no quantities; staff cannot approve; owner approval writes exactly the two snapshot-cell lines", async () => {
    const snap = await snapshot();
    const d = await draftFor("2026-10-12", snap);
    expect([await count(`SELECT count(*) n FROM core.prep_list WHERE id = $1`, [d.list]), await count(`SELECT count(*) n FROM core.prep_list_line WHERE prep_list_id = $1`, [d.list])]).toEqual([0, 0]);
    const waiting = PrepListResponse.parse(await (await call("GET", `/v1/kitchen/prep-list?outlet=${OUT()}&business_date=2026-10-12`, "staff")).json());
    expect([waiting.state, waiting.prep_list]).toEqual(["waiting", null]);
    const denied = await approve("staff", d.id);
    expect(denied.status).toBe(403);
    expect(await count(`SELECT count(*) n FROM core.prep_list WHERE id = $1`, [d.list])).toBe(0);
    // refs resolve to the snapshot's cells: the world ingredient → row 0 = 4200 (g), ingredient 2 → row 1 = 800 (kg)
    const ok = await approve("mgr1", d.id);
    expect(ok.status).toBe(200);
    expect(await lines(d.list)).toEqual([{ ingredient_id: T.ingredient, qty_milli: 4200, unit: "g" }, { ingredient_id: T.ing2, qty_milli: 800, unit: "kg" }].sort((a, b) => a.unit.localeCompare(b.unit)));
    const head = await one<{ status: string; draft_id: string; business_date: string }>(`SELECT status, draft_id, business_date::text FROM core.prep_list WHERE id = $1`, [d.list]);
    expect(head).toEqual({ status: "open", draft_id: d.id, business_date: "2026-10-12" });
    const done = PrepListResponse.parse(await (await call("GET", `/v1/kitchen/prep-list?outlet=${OUT()}&business_date=2026-10-12`, "staff")).json());
    expect([done.state, done.prep_list?.lines.length]).toEqual(["approved", 2]);
    // a second approval of the same draft is refused and writes nothing more
    expect((await approve("mgr1", d.id)).status).toBe(409);
    expect(await lines(d.list)).toHaveLength(2);
  });

  it("an edited approval writes the typed quantity (labelled as the approver's); a rejected draft writes nothing; a second list for the same date is refused", async () => {
    const snap = await snapshot();
    const d = await draftFor("2026-10-13", snap);
    const edited = {
      prep_list_id: d.list, outlet_id: OUT(), business_date: "2026-10-13",
      lines: [{ ingredient_id: T.ingredient, qty_milli: { value: 3000, typed_by: T.mgr1 }, unit: "g" }, { ingredient_id: T.ing2, qty_milli: ref(snap, 1), unit: "kg" }],
    };
    expect((await approve("mgr1", d.id, edited)).status).toBe(200);
    expect(await lines(d.list)).toEqual([{ ingredient_id: T.ingredient, qty_milli: 3000, unit: "g" }, { ingredient_id: T.ing2, qty_milli: 800, unit: "kg" }]);
    const rej = await draftFor("2026-10-14", snap);
    const r = await call("POST", `/v1/drafts/${rej.id}:reject`, "mgr1", env("drafts.reject.v1", { draft_id: rej.id, reason: "Not needed" }));
    expect(r.status).toBe(200);
    expect(await count(`SELECT count(*) n FROM core.prep_list WHERE id = $1`, [rej.list])).toBe(0);
    // a manager's own direct command for the already-listed date → 409, nothing added
    const dup = await call("POST", "/v1/kitchen/prep-lists", "mgr1", env("kitchen.prep_list.create.v1", { prep_list_id: uuidv7(), outlet_id: OUT(), business_date: "2026-10-13", lines: [{ ingredient_id: T.ingredient, qty_milli: 1, unit: "g" }] }));
    expect(dup.status).toBe(409);
    // …and on a free date the manager's own command (typed numbers) works, staff's does not.
    const mine = uuidv7();
    const payload = { prep_list_id: mine, outlet_id: OUT(), business_date: "2026-10-15", lines: [{ ingredient_id: T.ingredient, qty_milli: 1500, unit: "g" }] };
    expect((await call("POST", "/v1/kitchen/prep-lists", "staff", env("kitchen.prep_list.create.v1", payload))).status).toBe(403);
    expect(await count(`SELECT count(*) n FROM core.prep_list WHERE id = $1`, [mine])).toBe(0);
    expect((await call("POST", "/v1/kitchen/prep-lists", "mgr1", env("kitchen.prep_list.create.v1", payload))).status).toBe(200);
    expect(await lines(mine)).toEqual([{ ingredient_id: T.ingredient, qty_milli: 1500, unit: "g" }]);
  });
});
