// Fetch-based SSE reader for core-api's GET /v1/stream (ADR-005). Hand-written (not generated): browsers'
// EventSource cannot send `Authorization` or refresh a token on reconnect (gotcha 23), so this reads the
// response body itself, sends a fresh bearer token and `Last-Event-ID` on every (re)connect, and backs off
// exponentially between attempts. Runs in browsers and Node 18+ (fetch, ReadableStream, TextDecoder).

/** One delivered event: `{id, type, data}` as the server sends it, plus the stream position after it. */
export interface StreamEvent {
  id: string;
  type: string;
  data: unknown;
  /** The Last-Event-ID the client will resume from after this event. */
  lastEventId: string | null;
}

export type StreamState = "connecting" | "open" | "retrying" | "closed";

export interface StreamOptions {
  /** core-api base URL, e.g. "https://api.example.test". */
  baseUrl: string;
  /** e.g. ["kds:<outlet id>"], ["order:<order id>"], ["inbox:<tenant id>", "trace:<run id>"]. */
  topics: readonly string[];
  /** Members and signed-in customers: called before every (re)connect, so an expired token is replaced. */
  token?: () => string | Promise<string>;
  /** Guests: the order's access token from placement, sent as `X-Munim-Guest-Token` (no `Authorization`).
   *  It cannot be refreshed, so a 401 or 404 stops the reader. Set exactly one of `token` / `guestToken`. */
  guestToken?: string;
  /** Extra headers per request: `X-Munim-Tenant` for members, `X-Munim-Storefront-Key` for customers. */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  onEvent: (event: StreamEvent) => void;
  onState?: (state: StreamState, detail?: { status?: number; error?: unknown }) => void;
  /** Resume from a position saved earlier. */
  lastEventId?: string;
  signal?: AbortSignal;
  /** First retry delay; doubles per failed attempt up to maxDelayMs (with jitter). Default 500 / 30 000. */
  initialDelayMs?: number;
  maxDelayMs?: number;
  fetch?: typeof fetch;
}

/** A refusal that retrying cannot fix (400 bad topics/cursor, 403, 404 unknown or unauthorised topic). */
export class StreamRefused extends Error {
  override name = "StreamRefused";
  readonly status: number;
  constructor(status: number) {
    super(`stream refused: HTTP ${status}`);
    this.status = status;
  }
}

export interface StreamHandle {
  /** Stop reading and stop reconnecting. */
  close(): void;
  /** Settles when the stream stops: resolves on close/abort, rejects with StreamRefused. */
  readonly done: Promise<void>;
  readonly lastEventId: string | null;
}

interface Parsed {
  event: string;
  data: string;
  id: string | undefined;
  retry: number | undefined;
}

/** Splits SSE text into events (WHATWG "event stream interpretation"): comments skipped, `data` lines joined
 *  by "\n", `id` without NUL accepted, `retry` digits only. Returns the events and the unparsed remainder. */
export function parseSse(buffer: string): { events: Parsed[]; rest: string } {
  const events: Parsed[] = [];
  let cur: Parsed = { event: "", data: "", id: undefined, retry: undefined };
  let hasData = false;
  let start = 0;
  for (;;) {
    const m = /\r\n|\r|\n/.exec(buffer.slice(start));
    if (!m) break;
    // A lone "\r" at the very end may be the first half of "\r\n": wait for more input.
    if (m[0] === "\r" && start + m.index === buffer.length - 1) break;
    const line = buffer.slice(start, start + m.index);
    start += m.index + m[0].length;
    if (line === "") {
      if (hasData || cur.id !== undefined || cur.retry !== undefined || cur.event) events.push(cur);
      cur = { event: "", data: "", id: undefined, retry: undefined };
      hasData = false;
      continue;
    }
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") {
      cur.data = hasData ? `${cur.data}\n${value}` : value;
      hasData = true;
    } else if (field === "event") cur.event = value;
    else if (field === "id" && !value.includes("\0")) cur.id = value;
    else if (field === "retry" && /^\d+$/.test(value)) cur.retry = Number(value);
  }
  return { events, rest: buffer.slice(start) };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/** Opens the stream and keeps it open until closed, aborted or refused. */
// Same header as the generated client's exported GUEST_TOKEN_HEADER (kept private here so the two exports never collide in
// index.ts); core-api's stream gate checks it end-to-end.
const GUEST_TOKEN_HEADER = "X-Munim-Guest-Token";

export function openStream(opts: StreamOptions): StreamHandle {
  if ((opts.token === undefined) === (opts.guestToken === undefined)) throw new TypeError("openStream: set exactly one of token / guestToken");
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  if (opts.signal?.aborted) ctl.abort();
  const doFetch = opts.fetch ?? fetch;
  const initial = opts.initialDelayMs ?? 500;
  const max = opts.maxDelayMs ?? 30_000;
  let lastEventId: string | null = opts.lastEventId ?? null;
  const url = `${opts.baseUrl.replace(/\/$/, "")}/v1/stream?topics=${encodeURIComponent(opts.topics.join(","))}`;

  const run = async () => {
    let attempt = 0;
    let serverRetry: number | undefined;
    while (!ctl.signal.aborted) {
      opts.onState?.("connecting");
      let refused: StreamRefused | null = null;
      try {
        const res = await doFetch(url, {
          headers: {
            ...(await opts.headers?.()),
            Accept: "text/event-stream",
            ...(opts.token ? { Authorization: `Bearer ${await opts.token()}` } : { [GUEST_TOKEN_HEADER]: opts.guestToken! }),
            ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}),
          },
          signal: ctl.signal,
        });
        // 401: the token expired — the next attempt asks for a fresh one (a guest token cannot be refreshed, so
        // a guest stops). 5xx/503: the server or its LISTEN connection is down. Any other non-200 will not
        // change by retrying.
        if (!res.ok && res.status < 500 && (res.status !== 401 || opts.guestToken !== undefined)) refused = new StreamRefused(res.status);
        if (!res.ok || !res.body) {
          await res.body?.cancel().catch(() => {});
          if (refused) throw refused;
          opts.onState?.("retrying", { status: res.status });
        } else {
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const { events, rest } = parseSse(buffer);
            buffer = rest;
            let reconnect = false;
            for (const e of events) {
              if (e.id !== undefined) lastEventId = e.id;
              if (e.retry !== undefined) serverRetry = e.retry;
              if (e.event === "ready") {
                attempt = 0;
                opts.onState?.("open");
              } else if (e.event === "reconnect") reconnect = true;
              else if (e.event === "" && e.data !== "") {
                const msg = JSON.parse(e.data) as { id: string; type: string; data: unknown };
                opts.onEvent({ id: msg.id, type: msg.type, data: msg.data, lastEventId });
              }
            }
            if (reconnect) {
              await reader.cancel().catch(() => {});
              break;
            }
          }
          opts.onState?.("retrying");
        }
      } catch (error) {
        if (error instanceof StreamRefused) throw error;
        if (ctl.signal.aborted) break;
        opts.onState?.("retrying", { error });
      }
      // The server's `retry:` is the floor; failed attempts double it, with jitter so clients spread out.
      const base = Math.max(serverRetry ?? 0, initial);
      const delay = Math.min(max, base * 2 ** attempt) * (0.5 + Math.random() / 2);
      attempt++;
      await sleep(delay, ctl.signal);
    }
  };

  const done = run().finally(() => {
    opts.signal?.removeEventListener("abort", onAbort);
    opts.onState?.("closed");
  });
  return {
    close: () => ctl.abort(),
    done,
    get lastEventId() {
      return lastEventId;
    },
  };
}
