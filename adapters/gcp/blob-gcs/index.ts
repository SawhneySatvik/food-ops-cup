// blob-gcs — the Cloud Storage BlobStore (03-arch ports; the port is services/core-api/src/modules/imports/blob.ts).
// Cloud Storage JSON API over fetch, bearer token from the Cloud Run metadata server. No SDK dependency.
// Keys are `<tenant>/<sha256>` only (the same check the local store makes), so a key can never walk out of its
// tenant prefix. UNVERIFIED against a real bucket: URL shapes follow the public JSON API reference.
import type { BlobStore } from "../../../services/core-api/src/modules/imports/blob.ts";
import { metadataTokenSource, type TokenSource } from "../metadata-token.ts";

const KEY = /^[0-9a-f-]{36}\/[0-9a-f]{64}$/;
const TIMEOUT_MS = 30_000;

export function gcsBlobStore(o: {
  bucket: string; fetch?: typeof fetch | undefined; token?: TokenSource | undefined; apiBase?: string | undefined; timeoutMs?: number | undefined;
}): BlobStore {
  const call = o.fetch ?? fetch;
  const token = o.token ?? metadataTokenSource({ fetch: o.fetch });
  const base = (o.apiBase ?? "https://storage.googleapis.com").replace(/\/+$/, "");
  const bucket = encodeURIComponent(o.bucket);
  const send = async (url: string, init: RequestInit, what: string): Promise<Response> => {
    try {
      return await call(url, {
        ...init, headers: { ...init.headers, Authorization: `Bearer ${await token()}` }, signal: AbortSignal.timeout(o.timeoutMs ?? TIMEOUT_MS),
      });
    } catch {
      throw new Error(`blob ${what}: storage unreachable`);
    }
  };
  const checked = (key: string) => {
    if (!KEY.test(key)) throw new Error("blob key is not <tenant>/<sha256>");
    return key;
  };
  return {
    async put(key, bytes) {
      const res = await send(`${base}/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(checked(key))}`,
        { method: "POST", headers: { "content-type": "application/octet-stream" }, body: Buffer.from(bytes) }, "put");
      if (!res.ok) throw new Error(`blob put: HTTP ${res.status}`);
    },
    async get(key) {
      const res = await send(`${base}/storage/v1/b/${bucket}/o/${encodeURIComponent(checked(key))}?alt=media`, {}, "get");
      if (res.status === 404) throw new Error("blob get: not found");
      if (!res.ok) throw new Error(`blob get: HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}
