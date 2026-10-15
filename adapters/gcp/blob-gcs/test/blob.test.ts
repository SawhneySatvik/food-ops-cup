// gcsBlobStore against a local HTTP server standing in for the Cloud Storage JSON API (port 4370) and one for the
// metadata server (4371): real HTTP, so binary bodies and URL encoding are really exercised. No Google calls.
// The port's contract cases are shared with every BlobStore adapter (services/core-api/test/blob-store.kit.ts, T-116); the
// URL-shape and token-cache cases below are this adapter's own.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BLOB_STORE_CONTRACT, type BlobStoreSubject } from "../../../../services/core-api/test/blob-store.kit.ts";
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

const subject: BlobStoreSubject = {
  store,
  refused: () => gcsBlobStore({ bucket: "bkt", apiBase: "http://127.0.0.1:4370", token: async () => "wrong" }),
  unreachable: () => gcsBlobStore({ bucket: "bkt", apiBase: "http://127.0.0.1:4379", token: async () => "t" }),
  requests: () => seen.length,
  secrets: ["synthetic-token", "127.0.0.1"],
};

describe("gcsBlobStore (BlobStore contract)", () => {
  for (const c of BLOB_STORE_CONTRACT) it(c.name, () => c.run(subject));
});

describe("gcsBlobStore (Cloud Storage specifics)", () => {
  it("encodes the key into one object name", () => {
    expect(seen.find((s) => s.method === "POST")!.url).toContain(`name=${encodeURIComponent(key("a"))}`);
    expect(seen.find((s) => s.method === "GET")!.url).toContain(`/o/${encodeURIComponent(key("a"))}?alt=media`);
  });

  it("fetches the metadata token once and caches it", () => {
    expect(metaHits).toBe(1); // every call above shared one source
  });
});
