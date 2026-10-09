// One LISTEN connection per process — here, per Deps object, so a gate can run two app instances with two
// listeners in one test process (ADR-005, R33). A notification is only a wake-up: its payload is read for
// the tenant id (routing) and nothing else; each woken feed re-reads under its own RLS context (feed.ts).
// On connection loss every feed gets a reconnect hint and is closed; clients come back with Last-Event-ID
// once the listener is up again, and the cursor replay covers the gap.
import type pg from "pg";
import type { Logger } from "@munim/config";

export const CHANNELS = ["munim_outbox", "munim_inbox", "munim_trace"] as const;
export type Channel = (typeof CHANNELS)[number];

/** What the hub needs from a subscriber. */
export interface Listener {
  readonly tenant: string;
  wake(channel: Channel): void;
  lost(): void;
}

const TENANT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BACKOFF_MS = [250, 500, 1_000, 2_000, 5_000, 10_000];
const PING_MS = 20_000;

export class Hub {
  private client: pg.Client | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private waiters: Array<() => void> = [];
  private attempt = 0;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private ping: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private traces = false;
  private readonly connect: () => pg.Client;
  private readonly log: Logger;

  constructor(connect: () => pg.Client, log: Logger) {
    this.connect = connect;
    this.log = log;
    void this.start();
  }

  /** Resolves once LISTEN is active; rejects after `timeoutMs` (the route answers 503). */
  ready(timeoutMs: number): Promise<void> {
    if (this.client) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== done);
        reject(new Error("stream: listener not ready"));
      }, timeoutMs);
      const done = () => {
        clearTimeout(t);
        resolve();
      };
      this.waiters.push(done);
    });
  }

  add(l: Listener): void {
    let set = this.listeners.get(l.tenant);
    if (!set) this.listeners.set(l.tenant, (set = new Set()));
    set.add(l);
  }

  remove(l: Listener): void {
    const set = this.listeners.get(l.tenant);
    set?.delete(l);
    if (set?.size === 0) this.listeners.delete(l.tenant);
  }

  /** Capability check: on a database without `intel.trace_event` (added by 0012) trace topics deliver nothing. Cached once true. */
  async hasTraces(db: pg.ClientBase): Promise<boolean> {
    if (this.traces) return true;
    const r = await db.query<{ ok: boolean }>(`SELECT to_regclass('intel.trace_event') IS NOT NULL AS ok`);
    return (this.traces = r.rows[0]!.ok);
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.retry);
    clearInterval(this.ping);
    for (const l of [...this.listeners.values()].flatMap((s) => [...s])) l.lost();
    const c = this.client;
    this.client = null;
    await c?.end().catch(() => {});
  }

  private async start(): Promise<void> {
    if (this.closed) return;
    let c: pg.Client | undefined;
    try {
      // Inside the try: a factory that throws (e.g. a missing session URL) retries with backoff and the
      // request answers 503, instead of an unhandled rejection taking the process down.
      c = this.connect();
      const client = c;
      c.on("error", () => this.lose(client));
      c.on("end", () => this.lose(client));
      c.on("notification", (n) => this.notify(n));
      await c.connect();
      await c.query(CHANNELS.map((ch) => `LISTEN ${ch}`).join("; "));
    } catch (err) {
      this.log("stream: LISTEN connection failed", err);
      c?.removeAllListeners();
      await c?.end().catch(() => {});
      this.schedule();
      return;
    }
    if (this.closed) {
      await c.end().catch(() => {});
      return;
    }
    this.client = c;
    this.attempt = 0;
    // A half-open TCP connection never errors on its own: a ping that does not answer in time counts as loss.
    this.ping = setInterval(() => {
      const t = setTimeout(() => this.lose(c), PING_MS / 2);
      t.unref();
      c.query("SELECT 1").then(() => clearTimeout(t), () => clearTimeout(t));
    }, PING_MS);
    this.ping.unref();
    for (const w of this.waiters.splice(0)) w();
  }

  private lose(c: pg.Client): void {
    if (c !== this.client) return;
    this.client = null;
    clearInterval(this.ping);
    c.removeAllListeners();
    c.on("error", () => {});
    void c.end().catch(() => {});
    this.log("stream: LISTEN connection lost; reconnecting");
    for (const l of [...this.listeners.values()].flatMap((s) => [...s])) l.lost();
    this.schedule();
  }

  private schedule(): void {
    if (this.closed) return;
    const ms = BACKOFF_MS[Math.min(this.attempt++, BACKOFF_MS.length - 1)]!;
    this.retry = setTimeout(() => void this.start(), ms);
    this.retry.unref();
  }

  private notify(n: pg.Notification): void {
    const tenant = n.payload?.slice(0, 36) ?? "";
    if (!TENANT.test(tenant) || !(CHANNELS as readonly string[]).includes(n.channel)) return;
    for (const l of this.listeners.get(tenant) ?? []) l.wake(n.channel as Channel);
  }
}
