// Compact-JWS verification against a JWKS with node:crypto, shared by the IdP adapters. Only asymmetric
// algorithms are accepted (an `alg: none` or HS256 token is refused before any key lookup).
import { createPublicKey, verify as cryptoVerify, type JsonWebKey } from "node:crypto";
import { IdpError, type Identity } from "./port.ts";

export type Jwk = JsonWebKey & { kid?: string; alg?: string };
export interface Jwks {
  keys: Jwk[];
}

const ALGS: Record<string, { hash: string | null; p1363: boolean }> = {
  RS256: { hash: "sha256", p1363: false },
  ES256: { hash: "sha256", p1363: true },
  EdDSA: { hash: null, p1363: false },
};

export interface VerifyOptions {
  issuer?: string;
  audience?: string;
  /** Seconds of clock skew tolerated on exp/nbf. */
  leeway?: number;
  now?: () => number;
  /** Where this IdP puts "the email was confirmed". Default: a top-level `email_verified` claim. */
  emailVerified?: (claims: Record<string, unknown>) => boolean;
}

export function verifyJwt(token: string, jwks: Jwks, opts: VerifyOptions = {}): Identity {
  const parts = token.split(".");
  if (parts.length !== 3) throw new IdpError("malformed");
  const [h, p, s] = parts as [string, string, string];
  const header = decode(h);
  const alg = typeof header.alg === "string" ? ALGS[header.alg] : undefined;
  if (!alg) throw new IdpError("algorithm");
  const jwk = jwks.keys.find((k) => k.kid === header.kid && (k.alg === undefined || k.alg === header.alg));
  if (!jwk) throw new IdpError("unknown key");
  let ok = false;
  try {
    const key = createPublicKey({ key: jwk, format: "jwk" });
    const sig = Buffer.from(s, "base64url");
    ok = cryptoVerify(alg.hash, Buffer.from(`${h}.${p}`), alg.p1363 ? { key, dsaEncoding: "ieee-p1363" } : key, sig);
  } catch {
    ok = false;
  }
  if (!ok) throw new IdpError("signature");
  const claims = decode(p);
  const now = Math.floor((opts.now ?? Date.now)() / 1000);
  const leeway = opts.leeway ?? 30;
  if (typeof claims.exp !== "number" || claims.exp + leeway <= now) throw new IdpError("expired");
  if (typeof claims.nbf === "number" && claims.nbf - leeway > now) throw new IdpError("not yet valid");
  if (opts.issuer !== undefined && claims.iss !== opts.issuer) throw new IdpError("issuer");
  if (opts.audience !== undefined) {
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(opts.audience)) throw new IdpError("audience");
  }
  if (typeof claims.sub !== "string" || claims.sub === "") throw new IdpError("sub");
  const email = typeof claims.email === "string" ? claims.email : null;
  const verified = (opts.emailVerified ?? ((c) => c.email_verified === true))(claims);
  return { sub: claims.sub, email, email_verified: email !== null && verified };
}

function decode(part: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {}
  throw new IdpError("malformed");
}
