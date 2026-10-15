// Blob port (03-architecture ports): the bytes of an uploaded document live outside Postgres; core.document
// keeps only the key (`storage_ref`). The local store writes under `.run/blobs/` (git-ignored); a hosted
// adapter (Cloud Storage, adapters/gcp/blob-gcs; a dev checkout's own shared store) implements the same two calls.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface BlobStore {
  /** Idempotent: the key is content-addressed, so writing it twice writes the same bytes. */
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
}

const KEY = /^[0-9a-f-]{36}\/[0-9a-f]{64}$/;

/** `<tenant>/<sha256>` — the only keys this module writes. */
export const blobKey = (tenantId: string, sha256: string) => `${tenantId}/${sha256}`;

export function localBlobStore(dir: string): BlobStore {
  const path = (key: string) => {
    if (!KEY.test(key)) throw new Error("blob key is not <tenant>/<sha256>");
    return join(dir, key);
  };
  return {
    async put(key, bytes) {
      const p = path(key);
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, bytes);
    },
    async get(key) {
      return new Uint8Array(await readFile(path(key)));
    },
  };
}

/** The repository's `.run/blobs` (services/core-api/src/modules/imports → repo root). */
export const DEFAULT_BLOB_DIR = resolve(import.meta.dirname, "../../../../..", ".run", "blobs");
