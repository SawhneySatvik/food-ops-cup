// gcsBlobStore against a local HTTP server standing in for the Cloud Storage JSON API (port 4370) and one for the
// metadata server (4371): real HTTP, so binary bodies and URL encoding are really exercised. No Google calls.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gcsBlobStore } from "../index.ts";
import { metadataTokenSource } from "../../metadata-token.ts";

const TENANT = "11111111-2222-3333-4444-555555555555";
const key = (c: string) => `${TENANT}/${c.repeat(64)}`;
const objects = new Map<string, Buffer>();
const seen: Array<{ method: string; url: string; auth: string | undefined }> = [];
let metaHits = 0;
let storage: Server;
let meta: Server;

const listen = (s: Server, port: number) => new Promise<void>((r) => s.listen(port, "127.0.0.1", r));

beforeAll(async () => {
  storage = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const u = new URL(req.url!, "http://x");
      seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization });
      if (req.headers.authorization !== "Bearer synthetic-token") { res.writeHead(401).end(); return; }
      if (req.method === "POST" && u.pathname === "/upload/storage/v1/b/bkt/o") {
        objects.set(u.searchParams.get("name")!, Buffer.concat(chunks));
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
        return;
      }
      const m = /^\/storage\/v1\/b\/bkt\/o\/(.+)$/.exec(u.pathname);
      const obj = m && objects.get(decodeURIComponent(m[1]!));
      if (req.method === "GET" && u.searchParams.get("alt") === "media" && obj) res.writeHead(200).end(obj);
      else res.writeHead(404).end("{}");
    });
  });
  meta = createServer((req, res) => {
    metaHits++;
    if (req.headers["metadata-flavor"] !== "Google") { res.writeHead(403).end(); return; }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: "synthetic-token", expires_in: 3599 }));
  });
  await listen(storage, 4370);
  await listen(meta, 4371);
});
afterAll(() => { storage.close(); meta.close(); });

const source = metadataTokenSource({ url: "http://127.0.0.1:4371/token" });
const store = () => gcsBlobStore({ bucket: "bkt", apiBase: "http://127.0.0.1:4370", token: source });

describe("gcsBlobStore (BlobStore contract)", () => {
  it("puts and gets every byte value back", async () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    await store().put(key("a"), bytes);
    expect(await store().get(key("a"))).toEqual(bytes);
  });

  it("put twice overwrites with the new bytes", async () => {
    await store().put(key("b"), new Uint8Array([1, 2]));
    await store().put(key("b"), new Uint8Array([3]));
    expect(await store().get(key("b"))).toEqual(new Uint8Array([3]));
  });

  it("a missing key rejects", async () => {
    await expect(store().get(key("c"))).rejects.toThrow("not found");
  });

  it("refuses a key that is not <tenant>/<sha256>, before any request", async () => {
    const before = seen.length;
    await expect(store().put("../escape", new Uint8Array([1]))).rejects.toThrow("not <tenant>/<sha256>");
    await expect(store().get(`${TENANT}/short`)).rejects.toThrow("not <tenant>/<sha256>");
    expect(seen.length).toBe(before);
  });

  it("encodes the key into one object name", () => {
    expect(seen.find((s) => s.method === "POST")!.url).toContain(`name=${encodeURIComponent(key("a"))}`);
    expect(seen.find((s) => s.method === "GET")!.url).toContain(`/o/${encodeURIComponent(key("a"))}?alt=media`);
  });

  it("an auth failure surfaces the status only", async () => {
    const bad = gcsBlobStore({ bucket: "bkt", apiBase: "http://127.0.0.1:4370", token: async () => "wrong" });
    await expect(bad.get(key("a"))).rejects.toThrow("blob get: HTTP 401");
  });

  it("an unreachable store rejects without leaking the URL", async () => {
    const down = gcsBlobStore({ bucket: "bkt", apiBase: "http://127.0.0.1:4379", token: async () => "t" });
    await expect(down.put(key("a"), new Uint8Array([1]))).rejects.toThrow("blob put: storage unreachable");
  });

  it("fetches the metadata token once and caches it", () => {
    expect(metaHits).toBe(1); // every call above shared one source
  });
});
