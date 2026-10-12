// One SSE subscriber: its topics, its cursor, and the drain that serves both replay and live. A wake-up from
// the hub never carries data in: the feed re-reads under the subscriber's own RLS context (contextOf), so a forged
// NOTIFY delivers at most what the subscriber could already read (One Guarantee: NOTIFY carries ids only;
// data is re-read under RLS).
//
// Cursor (the SSE `id:`), one part per channel the stream uses:
//   o=<seq>                              core.outbox.seq — per tenant, assigned under the per-tenant commit
//                                        lock (0007), so commit-ordered and gapless: a late commit cannot
//                                        land behind the cursor (members)
//   n=<count>                            customers and guests: how many of their order's events they have
//                                        had. A customer never sees the tenant-wide outbox.seq — it would
//                                        tell them the merchant's event volume (W1 fix #33)
//   i=<updated_at UTC, µs>,<draft id>    core.draft, ordered by (updated_at, id)
//   f=<updated_at UTC, µs>,<finding id>  intel.finding, ordered by (updated_at, id)
//   v=<updated_at UTC, µs>,<inv. id>     core.investigation, ordered by (updated_at, id) — investigation progress (T-084b):
//                                        each step, stop, cancel and plan approval moves the row; the client re-reads
//                                        GET /v1/investigations/{id} for the checklist and its refs
//   t.<run id>=<seq>                     intel.trace_event, seq within a run
// Drafts, findings and investigations have no commit-ordered column: updated_at is a transaction-START time, so their reads
// look back LOOKBACK behind the cursor and skip rows this feed has already sent; the cursor only moves
// forward, and an event that does not move it is sent without an `id:` line. KNOWN LIMIT (i/f/v): a late
// draft/finding/investigation change that commits while the client is disconnected, behind its Last-Event-ID, or a
// transaction open longer than LOOKBACK, is not delivered.
import type pg from "pg";
import { contextOf, type Principal } from "../auth/resolve.ts";
import { type AppContext, withContext } from "../lib/db.ts";
import { ApiError } from "../lib/errors.ts";
import type { Deps } from "../lib/types.ts";
import { restrictedStopReason, statusVisible } from "../modules/investigations/redact.ts";
import type { Channel, Hub, Listener } from "./hub.ts";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const TS = "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{6}Z";
const INT = "0|[1-9]\\d{0,17}";
const TOPIC = new RegExp(`^(kds|inbox|trace|order):(${UUID})$`);
const PART = new RegExp(`^(?:([on])=(${INT})|([ifv])=(${TS}),(${UUID})|t\\.(${UUID})=(${INT}))$`);
const MAX_TOPICS = 10;
const PAGE = 200;
const ZERO: Pos = { ts: "1970-01-01T00:00:00.000000Z", id: "00000000-0000-0000-0000-000000000000" };
/** Postgres text of a timestamptz in the cursor's exact format (µs precision round-trips through ::timestamptz). */
const tsSql = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export interface Topics {
  kds: string[];
  orders: string[];
  /** The tenant named by inbox:<tenant>, or null. */
  inbox: string | null;
  runs: string[];
}

interface Pos {
  ts: string;
  id: string;
}

/** Cursor parts read through the look-back window: drafts, findings, investigations. */
type Part = "i" | "f" | "v";

export interface Cursor {
  o?: number;
  n?: number;
  i?: Pos;
  f?: Pos;
  v?: Pos;
  t: Map<string, number>;
}

/** A customer or a guest: the storefront side, which reads only its own order rows. */
type Shopper = Extract<Principal, { kind: "customer" | "guest" }>;
export type Subscriber = Extract<Principal, { kind: "member" }> | Shopper;
const isShopper = (p: Subscriber): p is Shopper => p.kind !== "member";

/**
 * The one context every read of a subscriber runs under: its own, never wider (W1 fix #78). Customers get
 * outlet_ids '{}' and 0014's RESTRICTIVE customer_scope; guests app.role 'guest' + app.guest_access_hash and
 * guest_scope. The gate "shopper read context" queries through this function.
 */
export function readContext(p: Subscriber): AppContext {
  return contextOf(p);
}

/** `?topics=a,b` → topics; anything malformed → 400. Ids are lowercased (NOTIFY payloads are lowercase). */
export function parseTopics(raw: string | undefined): Topics {
  const items = [...new Set((raw ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))];
  if (items.length === 0 || items.length > MAX_TOPICS) throw new ApiError("bad_request");
  const t: Topics = { kds: [], orders: [], inbox: null, runs: [] };
  for (const item of items) {
    const m = TOPIC.exec(item);
    if (!m) throw new ApiError("bad_request");
    const [, kind, id] = m as unknown as [string, string, string];
    if (kind === "kds") t.kds.push(id);
    else if (kind === "order") t.orders.push(id);
    else if (kind === "trace") t.runs.push(id);
    else if (t.inbox) throw new ApiError("bad_request");
    else t.inbox = id;
  }
  return t;
}

/** `Last-Event-ID` → cursor; malformed, or a part this kind of subscriber never receives → 400. */
export function parseCursor(raw: string, shopper: boolean): Cursor {
  const c: Cursor = { t: new Map() };
  for (const part of raw.split(";")) {
    const m = PART.exec(part);
    if (!m || shopper !== (m[1] === "n")) throw new ApiError("bad_request");
    if (m[1]) c[m[1] as "o" | "n"] = Number(m[2]);
    else if (m[3]) c[m[3] as Part] = { ts: m[4]!, id: m[5]! };
    else c.t.set(m[6]!, Number(m[7]));
  }
  return c;
}

export function formatCursor(c: Cursor): string {
  const parts: string[] = [];
  if (c.o !== undefined) parts.push(`o=${c.o}`);
  if (c.n !== undefined) parts.push(`n=${c.n}`);
  if (c.i) parts.push(`i=${c.i.ts},${c.i.id}`);
  if (c.f) parts.push(`f=${c.f.ts},${c.f.id}`);
  if (c.v) parts.push(`v=${c.v.ts},${c.v.id}`);
  for (const [run, seq] of c.t) parts.push(`t.${run}=${seq}`);
  return parts.join(";");
}

/**
 * Every topic must be readable by this subscriber, or the whole request is 404 — the same answer for "not
 * yours" and "does not exist" (gotcha 16). Existence is checked under the subscriber's own read context.
 *   kds:<outlet>   member whose outlet scope covers it
 *   inbox:<tenant> owner or manager of that tenant (managers then see only drafts/findings touching their outlets and
 *                  the investigations their scope covers)
 *   trace:<run>    member whose outlet scope covers the run's outlet_scope; a '{*}' run: owner, advisor or
 *                  judge only (W1 fix #37, #78 — the same roles as 0014's run policy)
 *   order:<id>     a member whose outlet scope covers the order; the signed-in customer who owns it; or the
 *                  guest holding that order's access token (one topic only)
 */
export async function authorise(deps: Deps, p: Subscriber, t: Topics): Promise<void> {
  if (isShopper(p) && (t.kds.length || t.inbox || t.runs.length)) throw new ApiError("not_found");
  if (p.kind === "guest" && (t.orders.length !== 1 || t.orders[0] !== p.order_id.toLowerCase())) throw new ApiError("not_found");
  if (p.kind === "customer" && !p.profile) throw new ApiError("not_found");
  if (p.kind === "member") {
    if (t.inbox && (t.inbox !== p.tenant_id.toLowerCase() || (p.role !== "owner" && p.role !== "manager"))) throw new ApiError("not_found");
    if (p.outlet_ids !== "*" && t.kds.some((o) => !(p.outlet_ids as string[]).includes(o))) throw new ApiError("not_found");
  }
  const ok = await withContext(deps.pools.core, readContext(p), async (db) => {
    const count = async (sql: string, params: unknown[]) => Number((await db.query<{ n: string }>(sql, params)).rows[0]!.n);
    if (t.kds.length && (await count(`SELECT count(*) AS n FROM core.outlet WHERE id = ANY ($1::uuid[])`, [t.kds])) !== t.kds.length) return false;
    if (t.runs.length) {
      const runs = (await db.query<{ outlet_scope: string[] }>(`SELECT outlet_scope FROM intel.run WHERE id = ANY ($1::uuid[])`, [t.runs])).rows;
      if (runs.length !== t.runs.length || p.kind !== "member") return false;
      for (const r of runs) {
        if (r.outlet_scope.includes("*") ? !["owner", "advisor", "judge"].includes(p.role)
          : p.outlet_ids !== "*" && r.outlet_scope.some((o) => !(p.outlet_ids as string[]).includes(o))) return false;
      }
    }
    if (t.orders.length) {
      // A customer must own each order (explicitly, as well as by RLS); a guest's one order was matched by
      // its token hash in requireGuest and is re-checked here under the guest's context (0014 guest_scope).
      const owner = p.kind === "customer" ? p.customer_id : null;
      const n = await count(`SELECT count(*) AS n FROM core."order" WHERE id = ANY ($1::uuid[]) AND ($2::uuid IS NULL OR customer_id = $2)`,
        [t.orders, owner]);
      if (n !== t.orders.length) return false;
    }
    return true;
  });
  if (!ok) throw new ApiError("not_found");
}

export interface Sink {
  write(chunk: string): void;
  end(): void;
}

/** Retry hint (ms) sent with `ready` and with every reconnect hint. */
export const RETRY_MS = 1_000;

/** How far draft/finding reads look behind the cursor for late-committing transactions. */
const LOOKBACK_S = 120;

type Row = { id: string; ts: string };

const after = (a: Pos, b: Pos) => a.ts > b.ts || (a.ts === b.ts && a.id > b.id);

export class Feed implements Listener {
  readonly tenant: string;
  private readonly ctx: AppContext;
  private readonly shopper: boolean;
  private readonly channels: Channel[];
  private cursor: Cursor = { t: new Map() };
  /** Drafts/findings/investigations already sent (or behind the client's position at start), `id@ts` → ts, for the look-back. */
  private seen: Record<Part, Map<string, string>> = { i: new Map(), f: new Map(), v: new Map() };
  /** Shopper feeds: order_event ids already counted into `n`. */
  private delivered = new Set<string>();
  private pending = new Set<Channel>();
  private scheduled = false;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private timers: Array<ReturnType<typeof setTimeout>> = [];
  private readonly deps: Deps;
  private readonly hub: Hub;
  private readonly topics: Topics;
  private readonly sink: Sink;

  constructor(deps: Deps, hub: Hub, subscriber: Subscriber, topics: Topics, sink: Sink,
    timing: { heartbeatMs: number; maxAgeMs: number }) {
    this.deps = deps;
    this.hub = hub;
    this.topics = topics;
    this.sink = sink;
    this.tenant = subscriber.tenant_id.toLowerCase();
    this.ctx = readContext(subscriber);
    this.shopper = isShopper(subscriber);
    this.channels = [
      // Shoppers wake on outbox notifications too (an order change commits an outbox event) but read
      // core.order_event: 0014 denies customers the outbox.
      ...(topics.kds.length || topics.orders.length ? (["munim_outbox"] as const) : []),
      ...(topics.inbox ? (["munim_inbox"] as const) : []),
      ...(topics.runs.length ? (["munim_trace"] as const) : []),
    ];
    const hb = setInterval(() => this.write(": hb\n\n"), timing.heartbeatMs);
    // Before a proxy's request cap (Cloud Run: 60 min) the server ends the stream; the client resumes by cursor.
    const max = setTimeout(() => this.hint("max_age"), timing.maxAgeMs);
    hb.unref();
    max.unref();
    this.timers.push(hb, max);
  }

  /**
   * Register for wake-ups first, then fix the cursor (marking what is at or behind it as already sent) and
   * drain — so a row committed at any point after registration is delivered exactly once. With Last-Event-ID
   * the drain is the replay; without it the cursor starts at the newest row the subscriber can see.
   */
  start(last: Cursor | null): void {
    this.hub.add(this);
    this.enqueue(async () => {
      this.cursor = await this.initial(last);
      for (const part of ["i", "f", "v"] as const) {
        const upTo = this.cursor[part];
        if (upTo) await this.window(part, (r) => this.seen[part].set(`${r.id}@${r.ts}`, r.ts), upTo);
      }
      this.write(`retry: ${RETRY_MS}\nid: ${formatCursor(this.cursor)}\nevent: ready\ndata: {}\n\n`);
      for (const ch of this.channels) this.pending.add(ch);
      await this.drainPending();
    });
  }

  wake(channel: Channel): void {
    if (this.closed || !this.channels.includes(channel)) return;
    this.pending.add(channel);
    if (this.scheduled) return;
    this.scheduled = true;
    this.enqueue(() => this.drainPending());
  }

  lost(): void {
    this.hint("listener_lost");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.hub.remove(this);
    this.sink.end();
  }

  private hint(reason: string): void {
    this.write(`retry: ${RETRY_MS}\nevent: reconnect\ndata: ${JSON.stringify({ reason })}\n\n`);
    this.close();
  }

  private write(chunk: string): void {
    if (!this.closed) this.sink.write(chunk);
  }

  /** Runs fn after everything queued before it, so events leave in order. A failed read closes the stream
   *  with a reconnect hint rather than skipping: the client's replay re-reads from its cursor. */
  private enqueue(fn: () => Promise<void>): void {
    this.queue = this.queue.then(async () => {
      if (this.closed) return;
      try {
        await fn();
      } catch (err) {
        this.deps.log("stream: re-read failed", err);
        this.hint("read_failed");
      }
    });
  }

  private async drainPending(): Promise<void> {
    this.scheduled = false;
    const channels = [...this.pending];
    this.pending.clear();
    for (const ch of channels) {
      if (ch === "munim_outbox") await (this.shopper ? this.drainOrderEvents() : this.drainOutbox());
      else if (ch === "munim_inbox") {
        await this.drain("i");
        await this.drain("f");
        await this.drain("v");
      } else await this.drainTrace();
    }
  }

  private read<T>(fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
    return withContext(this.deps.pools.core, this.ctx, fn);
  }

  /** Sends one event; the `id:` line only when the cursor moved (a late draft/finding leaves the position). */
  private emit(moved: boolean, id: string, type: string, data: unknown): void {
    const idLine = moved ? `id: ${formatCursor(this.cursor)}\n` : "";
    this.write(`${idLine}data: ${JSON.stringify({ id, type, data })}\n\n`);
  }

  /** The subscribed orders' events, oldest first (≤ a few dozen per order). `at` is the transaction's start, so
   *  events written in one transaction tie on it and the random-looking uuid `id` is no order: `seq` (0016,
   *  per order, commit-ordered) breaks the tie. `at` stays the major key so the list across orders keeps growing
   *  at its tail, which the positional `n=` cursor relies on. Under a shopper's context RLS
   *  returns only their own orders' rows. */
  private async orderEvents(db: pg.ClientBase) {
    return (await db.query<{ id: string; order_id: string; kind: string; from_status: string | null; to_status: string | null;
      from_promised_at: string | null; to_promised_at: string | null; at: string }>(
      `SELECT id, order_id, kind, from_status, to_status, ${tsSql("from_promised_at")} AS from_promised_at,
              ${tsSql("to_promised_at")} AS to_promised_at, ${tsSql("at")} AS at
         FROM core.order_event WHERE order_id = ANY ($1::uuid[]) ORDER BY at, order_id, seq LIMIT 1000`,
      [this.topics.orders],
    )).rows;
  }

  /** Missing parts of `last` (or all of them, on a fresh stream) start at the newest row the subscriber can see. */
  private async initial(last: Cursor | null): Promise<Cursor> {
    const c: Cursor = { t: new Map() };
    await this.read(async (db) => {
      const newest = async (sql: string) => (await db.query<Pos>(sql)).rows[0] ?? ZERO;
      if (this.channels.includes("munim_outbox") && this.shopper) {
        // The first n of the order's events count as had; a fresh stream has had all that exist now.
        const rows = await this.orderEvents(db);
        const had = last?.n ?? rows.length;
        for (const r of rows.slice(0, had)) this.delivered.add(r.id);
        c.n = had;
      } else if (this.channels.includes("munim_outbox")) {
        c.o = last?.o ?? Number((await db.query<{ s: string }>(`SELECT coalesce(max(seq), 0) AS s FROM core.outbox`)).rows[0]!.s);
      }
      if (this.channels.includes("munim_inbox")) {
        c.i = last?.i ?? (await newest(`SELECT ${tsSql("updated_at")} AS ts, id FROM core.draft ORDER BY updated_at DESC, id DESC LIMIT 1`));
        c.f = last?.f ?? (await newest(`SELECT ${tsSql("updated_at")} AS ts, id FROM intel.finding ORDER BY updated_at DESC, id DESC LIMIT 1`));
        c.v = last?.v ?? (await newest(`SELECT ${tsSql("updated_at")} AS ts, id FROM core.investigation ORDER BY updated_at DESC, id DESC LIMIT 1`));
      }
      const traces = this.topics.runs.length > 0 && (await this.hub.hasTraces(db));
      for (const run of this.topics.runs) {
        let seq = last?.t.get(run);
        if (seq === undefined) {
          seq = traces
            ? Number((await db.query<{ s: string }>(`SELECT coalesce(max(seq), 0) AS s FROM intel.trace_event WHERE run_id = $1`, [run])).rows[0]!.s)
            : 0;
        }
        c.t.set(run, seq);
      }
    });
    return c;
  }

  /** Members. core.outbox RLS is tenant-only, so the topic filter is what narrows a tenant's events to this
   *  subscriber: kds:<outlet> = order and kitchen events naming the outlet; order:<id> = events about it. */
  private async drainOutbox(): Promise<void> {
    for (;;) {
      const rows = await this.read(async (db) =>
        (await db.query<{ seq: string; id: string; type: string; data: unknown }>(
          `SELECT seq, id, type, payload->'data' AS data
             FROM core.outbox
            WHERE seq > $1
              AND (((type LIKE 'munim.orders.%' OR type LIKE 'munim.kitchen.%') AND payload->'data'->>'outlet_id' = ANY ($2::text[]))
                   OR aggregateid = ANY ($3::text[]) OR payload->'data'->>'order_id' = ANY ($3::text[]))
            ORDER BY seq LIMIT ${PAGE}`,
          [this.cursor.o, this.topics.kds, this.topics.orders],
        )).rows,
      );
      for (const r of rows) {
        this.cursor.o = Number(r.seq);
        this.emit(true, r.id, r.type, r.data);
      }
      if (rows.length < PAGE || this.closed) return;
    }
  }

  /** Customers and guests: their order's status and promise changes — never `actor` (staff ids) or `reason`
   *  (free staff text). Late rows (an earlier `at` committing later) are still sent: membership in
   *  `delivered`, not position, decides. */
  private async drainOrderEvents(): Promise<void> {
    const rows = await this.read((db) => this.orderEvents(db));
    for (const r of rows) {
      if (this.delivered.has(r.id)) continue;
      this.delivered.add(r.id);
      this.cursor.n = (this.cursor.n ?? 0) + 1;
      this.emit(true, r.id, `order.${r.kind}`, {
        order_id: r.order_id, from_status: r.from_status, to_status: r.to_status,
        from_promised_at: r.from_promised_at, to_promised_at: r.to_promised_at, at: r.at,
      });
    }
  }

  /**
   * Pages through drafts, findings or investigations from LOOKBACK before the cursor (up to `upTo` when given), oldest first,
   * calling `each`. RLS narrows all three to the subscriber's outlets.
   */
  private async window(part: Part, each: (r: Row & Record<string, unknown>) => void, upTo?: Pos): Promise<void> {
    const floor = this.cursor[part]!.ts;
    let page: Pos = ZERO;
    for (;;) {
      const rows = await this.read(async (db) => {
        const common = [floor, page.ts, page.id, upTo?.ts ?? null, upTo?.id ?? null];
        if (part === "v") {
          const rows = (await db.query<Row & { status: string; mode: string; stop_reason: string | null; playbook_id: string; outlet_scope: string[]; created_by: string }>(
            `SELECT id, status, mode, stop_reason, playbook_id, outlet_scope::text[] AS outlet_scope, created_by, ${tsSql("updated_at")} AS ts
               FROM core.investigation
              WHERE updated_at > $1::timestamptz - interval '${LOOKBACK_S} seconds'
                AND (updated_at, id) > ($2::timestamptz, $3::uuid)
                AND ($4::timestamptz IS NULL OR (updated_at, id) <= ($4::timestamptz, $5::uuid))
              ORDER BY updated_at, id LIMIT ${PAGE}`,
            common,
          )).rows;
          // R-D: the status (and the stop reason, which can name the verdict) is `restricted` / null unless this
          // subscriber may open every template the playbook judges on (the creator still sees `ceiling`, redact.ts).
          const visible = await statusVisible(db, this.ctx.role ?? "", rows.map((x) => x.playbook_id));
          return rows.map((x) => (visible.has(x.playbook_id) ? x
            : { ...x, status: "restricted", stop_reason: restrictedStopReason(x.stop_reason, x.created_by, this.ctx.member_id) }));
        }
        if (part === "f") {
          return (await db.query<Row & { status: string; pack: string; type: string; severity: string; outlet_ids: string[] }>(
            `SELECT id, status, pack, type, severity, outlet_ids, ${tsSql("updated_at")} AS ts
               FROM intel.finding
              WHERE updated_at > $1::timestamptz - interval '${LOOKBACK_S} seconds'
                AND (updated_at, id) > ($2::timestamptz, $3::uuid)
                AND ($4::timestamptz IS NULL OR (updated_at, id) <= ($4::timestamptz, $5::uuid))
              ORDER BY updated_at, id LIMIT ${PAGE}`,
            common,
          )).rows;
        }
        return (await db.query<Row & { status: string; command_type: string; outlet_ids: string[]; finding_id: string | null }>(
          `SELECT id, status, command_type, outlet_ids, finding_id, ${tsSql("updated_at")} AS ts
             FROM core.draft
            WHERE updated_at > $1::timestamptz - interval '${LOOKBACK_S} seconds'
              AND (updated_at, id) > ($2::timestamptz, $3::uuid)
              AND ($4::timestamptz IS NULL OR (updated_at, id) <= ($4::timestamptz, $5::uuid))
            ORDER BY updated_at, id LIMIT ${PAGE}`,
          common,
        )).rows;
      });
      for (const r of rows) {
        page = { ts: r.ts, id: r.id };
        each(r);
      }
      if (rows.length < PAGE || this.closed) return;
    }
  }

  private async drain(part: Part): Promise<void> {
    const seen = this.seen[part];
    await this.window(part, (r) => {
      const k = `${r.id}@${r.ts}`;
      if (seen.has(k)) return;
      seen.set(k, r.ts);
      const moved = after(r, this.cursor[part]!);
      if (moved) this.cursor[part] = { ts: r.ts, id: r.id };
      // Findings: categorical fields only — no confidence or impact numbers (those render from snapshots).
      if (part === "f") this.emit(moved, r.id, "inbox.finding", { status: r.status, pack: r.pack, type: r.type, severity: r.severity, outlet_ids: r.outlet_ids, updated_at: r.ts });
      // Investigations: categorical fields only — the checklist, steps and every value are read through the API.
      else if (part === "v") this.emit(moved, r.id, "inbox.investigation", { status: r.status, mode: r.mode, stop_reason: r.stop_reason, playbook_id: r.playbook_id, outlet_scope: r.outlet_scope, updated_at: r.ts });
      // Drafts: ids and status only — the payload is fetched through the drafts API.
      else this.emit(moved, r.id, "inbox.draft", { status: r.status, command_type: r.command_type, outlet_ids: r.outlet_ids, finding_id: r.finding_id, updated_at: r.ts });
    });
    // Forget what fell out of the look-back (with a second's margin: JS dates carry ms, the cursor µs).
    const edge = new Date(Date.parse(this.cursor[part]!.ts) - (LOOKBACK_S + 1) * 1000).toISOString().replace("Z", "000Z");
    for (const [k, ts] of seen) if (ts < edge) seen.delete(k);
  }

  private async drainTrace(): Promise<void> {
    for (const run of this.topics.runs) {
      for (;;) {
        const rows = await this.read(async (db) => {
          if (!(await this.hub.hasTraces(db))) return [];
          return (await db.query<{ id: string; seq: string; parent_id: string | null; kind: string; actor: string; payload: unknown; at: string }>(
            `SELECT id, seq, parent_id, kind, actor, payload, ${tsSql("at")} AS at
               FROM intel.trace_event WHERE run_id = $1 AND seq > $2 ORDER BY seq LIMIT ${PAGE}`,
            [run, this.cursor.t.get(run)],
          )).rows;
        });
        for (const r of rows) {
          this.cursor.t.set(run, Number(r.seq));
          this.emit(true, r.id, `trace.${r.kind}`, { run_id: run, seq: Number(r.seq), parent_id: r.parent_id, kind: r.kind, actor: r.actor, at: r.at, payload: r.payload });
        }
        if (rows.length < PAGE || this.closed) break;
      }
    }
  }
}
