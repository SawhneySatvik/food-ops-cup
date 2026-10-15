// The BlobStore port's contract (src/modules/imports/blob.ts), shared by every hosted adapter's tests (T-116): each adapter's
// test file runs every case below against its own local stand-in server (`for (const c of BLOB_STORE_CONTRACT) it(c.name, …)`).
// Plain node:assert, no test runner import, so an adapter package runs it with its own vitest. Adapter-specific cases (URL
// shapes, token caching) stay in the adapter's own file.
import assert from "node:assert/strict";
import type { BlobStore } from "../src/modules/imports/blob.ts";

export interface BlobStoreSubject {
  /** A store on the stand-in, with the credential it accepts. */
  store(): BlobStore;
  /** The same stand-in, with a credential it refuses. */
  refused(): BlobStore;
  /** A store whose server is not listening. */
  unreachable(): BlobStore;
  /** Requests the stand-in has received so far. */
  requests(): number;
  /** Secrets that must never appear in an error message (the credential, the server's address). */
  secrets: string[];
}

const TENANT = "11111111-2222-3333-4444-555555555555";
/** One key per case (a distinct hex digit), so the cases share a stand-in without seeing each other's objects. */
const key = (digit: string) => `${TENANT}/${digit.repeat(64)}`;

const rejects = async (p: Promise<unknown>, message: string | RegExp, s: BlobStoreSubject) => {
  const e = await p.then(() => assert.fail("expected a rejection"), (x: unknown) => x as Error);
  if (typeof message === "string") assert.equal(e.message, message);
  else assert.match(e.message, message);
  for (const secret of s.secrets) assert.ok(!e.message.includes(secret), "the error names no secret and no address");
};

export const BLOB_STORE_CONTRACT: Array<{ name: string; run(s: BlobStoreSubject): Promise<void> }> = [
  { name: "puts and gets every byte value back (two store instances: nothing is kept in the process)", async run(s) {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    await s.store().put(key("a"), bytes);
    assert.deepEqual(await s.store().get(key("a")), bytes);
  } },
  { name: "put twice overwrites with the new bytes (the key is content-addressed, so a real re-put is the same bytes)", async run(s) {
    await s.store().put(key("b"), new Uint8Array([1, 2]));
    await s.store().put(key("b"), new Uint8Array([3]));
    assert.deepEqual(await s.store().get(key("b")), new Uint8Array([3]));
  } },
  { name: "a missing key rejects: blob get: not found", async run(s) {
    await rejects(s.store().get(key("c")), "blob get: not found", s);
  } },
  { name: "refuses a key that is not <tenant>/<sha256>, before any request", async run(s) {
    const before = s.requests();
    await rejects(s.store().put("../escape", new Uint8Array([1])), "blob key is not <tenant>/<sha256>", s);
    await rejects(s.store().get(`${TENANT}/short`), "blob key is not <tenant>/<sha256>", s);
    await rejects(s.store().get(`${TENANT}/${"a".repeat(64)}/../x`), "blob key is not <tenant>/<sha256>", s);
    assert.equal(s.requests(), before);
  } },
  { name: "a refused credential surfaces the HTTP status only", async run(s) {
    await rejects(s.refused().get(key("a")), /^blob get: HTTP 4\d\d$/, s);
    await rejects(s.refused().put(key("e"), new Uint8Array([1])), /^blob put: HTTP 4\d\d$/, s);
  } },
  { name: "an unreachable store rejects without leaking the URL", async run(s) {
    await rejects(s.unreachable().put(key("a"), new Uint8Array([1])), "blob put: storage unreachable", s);
    await rejects(s.unreachable().get(key("a")), "blob get: storage unreachable", s);
  } },
];
