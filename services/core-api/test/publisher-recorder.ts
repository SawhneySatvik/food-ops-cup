// A recording stand-in for intel `/events`: counts every CloudEvent id it receives and the service secret
// each request carried. `failFirst` answers the first N requests with 503 *after* recording them (the
// "delivered but the response was lost" case); `status` answers every request with it; `hang` never answers.
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

export interface Recorder {
  url: string;
  received: Map<string, number>;
  requests: { path: string; secret: string | undefined; contentType: string | undefined; ids: string[]; events: Record<string, unknown>[] }[];
  close(): Promise<void>;
}

async function readBody(req: IncomingMessage): Promise<string> {
  let s = "";
  for await (const chunk of req) s += chunk;
  return s;
}

export async function startRecorder(opts: { failFirst?: number; status?: number; hang?: boolean } = {}): Promise<Recorder> {
  const received = new Map<string, number>();
  const requests: Recorder["requests"] = [];
  let failures = opts.failFirst ?? 0;
  const server = createServer(async (req, res) => {
    const events = JSON.parse(await readBody(req)) as Record<string, unknown>[];
    const ids = events.map((e) => String(e.id));
    requests.push({ path: req.url ?? "", secret: req.headers["x-munim-service-secret"] as string | undefined, contentType: req.headers["content-type"], ids, events });
    for (const id of ids) received.set(id, (received.get(id) ?? 0) + 1);
    if (opts.hang) return;
    if (opts.status) {
      res.writeHead(opts.status).end();
      return;
    }
    if (failures > 0) {
      failures--;
      res.writeHead(503).end();
      return;
    }
    res.writeHead(202, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    requests,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

/** A port with nothing listening (bound, then released). */
export async function deadUrl(): Promise<string> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as AddressInfo;
  await new Promise<void>((r) => s.close(() => r()));
  return `http://127.0.0.1:${port}`;
}

/** Violations of "every expected id delivered exactly once, nothing else delivered". */
export function exactlyOnce(expected: readonly string[], received: Map<string, number>): string[] {
  const out: string[] = [];
  for (const id of expected) if (received.get(id) !== 1) out.push(`${id}: delivered ${received.get(id) ?? 0}x`);
  for (const id of received.keys()) if (!expected.includes(id)) out.push(`${id}: unexpected`);
  return out;
}
