// idp-identity-platform with an injected fetch: no network, synthetic keys and subjects only. Held: the JWKS is
// Google's securetoken URL; issuer, audience, expiry and signature are enforced; an unknown kid triggers one
// rate-limited refetch; HS256 is refused; email_verified is read from the signed claim.
import { createHmac, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { identityPlatformIdp, JWKS_URL } from "../index.ts";

const PROJECT = "synthetic-project";
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");

function rsaKey(kid: string) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" } };
}

function token(key: { kid: string; privateKey: KeyObject }, claims: Record<string, unknown> = {}) {
  const head = b64({ alg: "RS256", typ: "JWT", kid: key.kid });
  const now = Math.floor(Date.now() / 1000);
  const body = b64({ sub: "user-1", email: "c@example.test", email_verified: true, iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, iat: now, exp: now + 600, ...claims });
  const sig = sign("sha256", Buffer.from(`${head}.${body}`), key.privateKey).toString("base64url");
  return `${head}.${body}.${sig}`;
}

function jwksServer(initial: object[]) {
  const state = { keys: initial, calls: [] as string[] };
  const fetch = (async (url: string | URL) => {
    state.calls.push(String(url));
    return new Response(JSON.stringify({ keys: state.keys }), { status: 200 });
  }) as typeof globalThis.fetch;
  return { state, fetch };
}

describe("identityPlatformIdp", () => {
  const k = rsaKey("k1");

  it("accepts a good token and reads the signed email_verified claim", async () => {
    const s = jwksServer([k.jwk]);
    const idp = identityPlatformIdp({ projectId: PROJECT, fetch: s.fetch });
    expect(await idp.verify(token(k))).toEqual({ sub: "user-1", email: "c@example.test", email_verified: true });
    expect((await idp.verify(token(k, { email_verified: false }))).email_verified).toBe(false);
    expect(s.state.calls).toEqual([JWKS_URL]);
  });

  it("refuses a wrong audience", async () => {
    const idp = identityPlatformIdp({ projectId: PROJECT, fetch: jwksServer([k.jwk]).fetch });
    await expect(idp.verify(token(k, { aud: "other-project" }))).rejects.toThrow("audience");
  });

  it("refuses a wrong issuer", async () => {
    const idp = identityPlatformIdp({ projectId: PROJECT, fetch: jwksServer([k.jwk]).fetch });
    await expect(idp.verify(token(k, { iss: "https://securetoken.google.com/other-project" }))).rejects.toThrow("issuer");
  });

  it("refuses an expired token", async () => {
    const idp = identityPlatformIdp({ projectId: PROJECT, fetch: jwksServer([k.jwk]).fetch });
    await expect(idp.verify(token(k, { exp: Math.floor(Date.now() / 1000) - 3600 }))).rejects.toThrow("expired");
  });

  it("refuses an unknown kid, after exactly one rate-limited refetch", async () => {
    const s = jwksServer([k.jwk]);
    const idp = identityPlatformIdp({ projectId: PROJECT, fetch: s.fetch, now: () => Date.now() });
    await idp.verify(token(k));
    const other = rsaKey("k2");
    await expect(idp.verify(token(other))).rejects.toThrow("unknown key");
    expect(s.state.calls.length).toBe(1); // the refetch is rate-limited to one a minute
  });

  it("picks up a rotated key", async () => {
    let t = 1_000_000_000_000;
    const s = jwksServer([k.jwk]);
    const idp = identityPlatformIdp({ projectId: PROJECT, fetch: s.fetch, now: () => t });
    const rotated = rsaKey("k2");
    const mint = (key: typeof k) => token(key, { iat: t / 1000, exp: t / 1000 + 600 });
    await idp.verify(mint(k));
    s.state.keys = [k.jwk, rotated.jwk];
    t += 61_000;
    expect((await idp.verify(mint(rotated))).sub).toBe("user-1");
    expect(s.state.calls.length).toBe(2);
  });

  it("refuses a forged signature and an HS256 token", async () => {
    const idp = identityPlatformIdp({ projectId: PROJECT, fetch: jwksServer([k.jwk]).fetch });
    const forger = rsaKey("k1"); // same kid, different key
    await expect(idp.verify(token(forger))).rejects.toThrow("signature");
    const head = b64({ alg: "HS256", kid: "k1" });
    const body = b64({ sub: "x", exp: Math.floor(Date.now() / 1000) + 600 });
    const mac = createHmac("sha256", "secret").update(`${head}.${body}`).digest("base64url");
    await expect(idp.verify(`${head}.${body}.${mac}`)).rejects.toThrow("algorithm");
  });

  it("fails closed when the JWKS is unreachable", async () => {
    const idp = identityPlatformIdp({ projectId: PROJECT, fetch: (async () => { throw new Error("down"); }) as typeof fetch });
    await expect(idp.verify(token(k))).rejects.toThrow("jwks unavailable");
  });
});
