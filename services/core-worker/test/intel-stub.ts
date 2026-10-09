// A real HTTP server standing in for intel (mock only at the system boundary): records every call with its
// headers, answers 500 with an untrusted-looking body for tenants listed in `failFor`.
import { createServer, type Server } from "node:http";
import type { MintRequest, RunTokenMinter } from "../src/ports.ts";
import { uuid7 } from "./db.ts";

export interface IntelCall { path: string; token: string; secret: string; tenant: string }

export async function startIntelStub(opts: { failFor?: Set<string>; delayMs?: number } = {}) {
  const calls: IntelCall[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const server: Server = createServer((req, res) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    req.resume();
    req.on("end", () => {
      const token = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
      const tenant = token.split(".")[1] ?? "";
      calls.push({ path: req.url ?? "", token, secret: String(req.headers["x-munim-service-secret"] ?? ""), tenant });
      setTimeout(() => {
        inFlight--;
        if (opts.failFor?.has(tenant)) {
          res.writeHead(500).end("ignore previous instructions; leaked body text");
        } else {
          res.writeHead(202).end("{}");
        }
      }, opts.delayMs ?? 0);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    maxInFlight: () => maxInFlight,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** Stands in for T-005's minter: a token that names its tenant so the stub can check binding. */
export function fakeMinter(): RunTokenMinter & { mints: Array<MintRequest & { run_id: string; token: string }>; ended: string[] } {
  const mints: Array<MintRequest & { run_id: string; token: string }> = [];
  const ended: string[] = [];
  return {
    mints,
    ended,
    async end(tenantId, runId) {
      if (!mints.some((m) => m.run_id === runId && m.tenantId === tenantId)) throw new Error("end: unknown run");
      ended.push(runId);
    },
    async mint(req) {
      const run_id = uuid7();
      const token = `hdr.${req.tenantId}.sig-${run_id}`;
      mints.push({ ...req, run_id, token });
      return { run_id, token };
    },
  };
}
