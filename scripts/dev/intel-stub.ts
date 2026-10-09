// Local stand-in for intel (W3 builds the real one): records every POST to `/events`, `/watch:sweep` and
// `/brief` in memory and answers 202. It does no work and holds no model. Bodies and tokens are kept in memory
// for the smoke test to verify and are never logged: the CLI prints paths and event ids only.
//   node scripts/dev/intel-stub.ts [--port <n> | --port=<n>]   (default 8081 = config's default intel URL)
// GET /_calls returns {path, event_ids} per call (no tokens, no secrets) so a dev can see what arrived.
import { createServer, type IncomingMessage } from "node:http";
import { resolve } from "node:path";

export const STUB_PATHS = ["/events", "/watch:sweep", "/brief"] as const;
export type StubPath = (typeof STUB_PATHS)[number];

export interface StubCall {
  path: StubPath;
  /** The `x-munim-service-secret` header as received. */
  secret: string | null;
  /** `/watch:sweep`, `/brief`: the bearer run token. */
  runToken: string | null;
  /** `/events`: the CloudEvents of the batch. */
  events: Array<Record<string, unknown>>;
}

export interface IntelStub {
  url: string;
  port: number;
  calls: StubCall[];
  close(): Promise<void>;
}

async function body(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function startIntelStub(opts: { port?: number; onCall?: (c: StubCall) => void } = {}): Promise<IntelStub> {
  const calls: StubCall[] = [];
  const server = createServer(async (req, res) => {
    const path = (req.url ?? "").split("?")[0] as StubPath;
    if (req.method === "GET" && path === ("/_calls" as string)) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(calls.map((c) => ({ path: c.path, event_ids: c.events.map((e) => e.id) }))));
      return;
    }
    if (req.method !== "POST" || !STUB_PATHS.includes(path)) {
      res.writeHead(404).end();
      return;
    }
    const text = await body(req);
    let events: Array<Record<string, unknown>> = [];
    if (path === "/events") {
      try {
        const parsed = JSON.parse(text) as unknown;
        events = Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : [parsed as Record<string, unknown>];
      } catch {
        res.writeHead(400).end();
        return;
      }
    }
    const auth = req.headers.authorization;
    const call: StubCall = {
      path,
      secret: (req.headers["x-munim-service-secret"] as string | undefined) ?? null,
      runToken: auth?.startsWith("Bearer ") ? auth.slice(7) : null,
      events,
    };
    calls.push(call);
    opts.onCall?.(call);
    res.writeHead(202).end();
  });
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(opts.port ?? 0, "127.0.0.1", () => ok());
  });
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    calls,
    close: () => new Promise<void>((ok) => {
      server.closeAllConnections();
      server.close(() => ok());
    }),
  };
}

function parsePort(argv: string[]): number {
  let port = 8081;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const v = a === "--port" ? argv[++i] : a.startsWith("--port=") ? a.slice(7) : undefined;
    if (v === undefined) throw new Error(`intel-stub: unknown argument '${a}'`);
    port = Number(v);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("intel-stub: --port must be 1–65535");
  }
  return port;
}

if (import.meta.filename === resolve(process.argv[1] ?? "")) {
  const stub = await startIntelStub({
    port: parsePort(process.argv.slice(2)),
    onCall: (c) => console.log(JSON.stringify({ at: new Date().toISOString(), event: "intel-stub.call", path: c.path, event_ids: c.events.map((e) => e.id) })),
  });
  console.log(`intel-stub: listening on ${stub.url} (records /events, /watch:sweep, /brief; answers 202)`);
  const stop = () => void stub.close().then(() => process.exit(0));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
