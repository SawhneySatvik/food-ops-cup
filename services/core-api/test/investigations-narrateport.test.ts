// R-D item 1 (W3 close review): core's HTTP NarratePort reaches intel. Against a real local HTTP listener standing in for
// intel (the system boundary): one POST to exactly `/investigate:narrate` (base URL with and without a path and a
// trailing slash), the run token as the bearer, the service secret, the JSON body, intel's JSON back; a non-2xx rejects
// with the status only (never the body or the token).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpNarratePort } from "../src/modules/investigations/index.ts";

const SECRET = "rd1-test-service-secret-not-real";
const TOKEN = "header.payload.signature";
let server: Server;
let base: string;
let status = 200;
const seen: Array<{ method: string | undefined; path: string | undefined; auth: string | undefined; secret: string | undefined; body: string }> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d: Buffer) => { body += d.toString(); });
    req.on("end", () => {
      seen.push({ method: req.method, path: req.url, auth: req.headers.authorization, secret: req.headers["x-munim-service-secret"] as string | undefined, body });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(status === 200 ? { answer_id: "a1", tainted: false, source: "model" } : { detail: `${TOKEN} leaked` }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

describe("NarratePort → intel", () => {
  it.each([[""], ["/"]])("base URL%s: one POST to /investigate:narrate with the bearer token, the service secret and the JSON body", async (suffix) => {
    seen.length = 0;
    const port = createHttpNarratePort({ url: `${base}${suffix}`, serviceSecret: SECRET });
    expect(await port(TOKEN, { answer_id: "a1" })).toEqual({ answer_id: "a1", tainted: false, source: "model" });
    expect(seen).toEqual([{ method: "POST", path: "/investigate:narrate", auth: `Bearer ${TOKEN}`, secret: SECRET, body: JSON.stringify({ answer_id: "a1" }) }]);
  });
  it("a base URL with a path keeps it: /intel/investigate:narrate", async () => {
    seen.length = 0;
    await createHttpNarratePort({ url: `${base}/intel`, serviceSecret: SECRET })(TOKEN, {});
    expect(seen.map((s) => s.path)).toEqual(["/intel/investigate:narrate"]);
  });
  it("a non-2xx rejects with the status only, never the body or the token", async () => {
    status = 502;
    const err = await createHttpNarratePort({ url: base, serviceSecret: SECRET })(TOKEN, {}).catch((e: Error) => e);
    status = 200;
    expect((err as Error).message).toBe("intel /investigate:narrate: HTTP 502");
  });
});
