// GET /v1/stream?topics=a,b — server-sent events over a plain streamed response (ADR-005, 03-arch §1.9).
// Clients use fetch-based SSE (packages/sdk/src/stream.ts), never EventSource: the bearer token rides in
// `Authorization` and `Last-Event-ID` is resent on every reconnect (gotcha 23). Members authenticate with
// `X-Munim-Tenant`; customers with the storefront key + their token; guests with the storefront key + the
// order's guest access token (`X-Munim-Guest-Token`, W1 fix #47). Any topic the caller may not read → 404
// for the whole request. Heartbeat comment every 20 s; the server ends the stream at 55 min.
import { Hono, type MiddlewareHandler } from "hono";
import pg from "pg";
import { GUEST_TOKEN_HEADER, requireCustomer, requireGuest, requireMember, STOREFRONT_KEY_HEADER } from "../auth/resolve.ts";
import { ApiError } from "../lib/errors.ts";
import type { AppEnv, Deps } from "../lib/types.ts";
import { authorise, Feed, parseCursor, parseTopics } from "./feed.ts";
import { Hub } from "./hub.ts";

export interface StreamOptions {
  /** A new, unconnected client for the LISTEN connection. It must be a session-mode connection (direct or
   *  session pooler): a transaction pooler does not deliver notifications. */
  connect?: () => pg.Client;
  heartbeatMs?: number;
  maxAgeMs?: number;
  /** How long a request waits for the LISTEN connection before answering 503. */
  readyTimeoutMs?: number;
}

const options = new WeakMap<Deps, StreamOptions>();
const hubs = new WeakMap<Deps, Hub>();

/** Called by the composition root (server.ts) before serving; gates pass their own LISTEN client factory. */
export function configureStream(deps: Deps, opts: StreamOptions): void {
  options.set(deps, opts);
}

/** Ends every open stream (with a reconnect hint) and the LISTEN connection — for shutdown and tests. */
export async function closeStream(deps: Deps): Promise<void> {
  const hub = hubs.get(deps);
  hubs.delete(deps);
  await hub?.close();
}

function hubFor(deps: Deps): Hub {
  let hub = hubs.get(deps);
  if (!hub) {
    let connect = options.get(deps)?.connect;
    if (!connect) {
      if (deps.config.nodeEnv !== "test") {
        deps.log("stream: no session connection configured (configureStream); LISTEN falls back to the app pool's URL, which a transaction pooler does not serve");
      }
      connect = () => new pg.Client({ ...deps.pools.core.options, application_name: "munim_stream_listen", keepAlive: true });
    }
    hub = new Hub(connect, deps.log);
    hubs.set(deps, hub);
  }
  return hub;
}

const anySubscriber: MiddlewareHandler<AppEnv> = (c, next) =>
  (c.req.header(GUEST_TOKEN_HEADER) ? requireGuest : c.req.header(STOREFRONT_KEY_HEADER) ? requireCustomer : requireMember)(c, next);

export const router = new Hono<AppEnv>().get("/v1/stream", anySubscriber, async (c) => {
  const deps = c.var.deps;
  const p = c.var.principal;
  if (p.kind === "operator") throw new ApiError("not_found");
  const topics = parseTopics(c.req.query("topics"));
  const raw = c.req.header("Last-Event-ID");
  const last = raw ? parseCursor(raw, p.kind !== "member") : null;
  await authorise(deps, p, topics);

  const opts = options.get(deps) ?? {};
  const hub = hubFor(deps);
  try {
    await hub.ready(opts.readyTimeoutMs ?? 5_000);
  } catch {
    throw new ApiError("unavailable");
  }

  const enc = new TextEncoder();
  let feed: Feed | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(ctrl) {
      const sink = {
        // Either call throws once the client has gone away and the stream is already closed.
        write: (s: string) => {
          try {
            ctrl.enqueue(enc.encode(s));
          } catch {}
        },
        end: () => {
          try {
            ctrl.close();
          } catch {}
        },
      };
      feed = new Feed(deps, hub, p, topics, sink, {
        heartbeatMs: opts.heartbeatMs ?? 20_000,
        maxAgeMs: opts.maxAgeMs ?? 55 * 60_000,
      });
      feed.start(last);
    },
    cancel() {
      feed?.close();
    },
  });
  c.req.raw.signal.addEventListener("abort", () => feed?.close(), { once: true });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
  });
});
