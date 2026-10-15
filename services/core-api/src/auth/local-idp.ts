// The local IdP every gate uses (03-arch §4), and the dev-only MUNIM_IDP=local sign-in. Holds an Ed25519 key pair,
// publishes it as a one-key JWKS, signs test ID tokens and verifies them exactly as a real adapter would (signature,
// exp, issuer, audience). Synthetic identities only; never wired into a deployment (resolveIdpMode refuses "local" in
// production and outside MUNIM_ENV=dev).
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifyJwt, type Jwks } from "./jwt.ts";
import type { Identity, IdP } from "./port.ts";

export const LOCAL_ISSUER = "munim-idp-local";
export const LOCAL_AUDIENCE = "munim";

export interface LocalIdp extends IdP {
  jwks: Jwks;
  /** A compact JWS for `sub`. `ttlSeconds` ≤ 0 gives an already-expired token. */
  sign(claims: { sub: string; email?: string; email_verified?: boolean }, opts?: { ttlSeconds?: number; issuer?: string }): string;
}

/** `privateKeyPem` makes the key persistent (the `MUNIM_IDP=local` dev server and the seed minter share one). */
export function createLocalIdp(opts: { now?: () => number; privateKeyPem?: string } = {}): LocalIdp {
  const privateKey = opts.privateKeyPem ? createPrivateKey(opts.privateKeyPem) : generateKeyPairSync("ed25519").privateKey;
  const publicKey = createPublicKey(privateKey);
  const pubJwk = publicKey.export({ format: "jwk" });
  // The kid is the key's own hash, so two processes loading one PEM agree on it.
  const kid = createHash("sha256").update(String(pubJwk.x)).digest("hex").slice(0, 16);
  const jwks: Jwks = { keys: [{ ...pubJwk, kid, alg: "EdDSA", use: "sig" }] };
  const now = opts.now ?? Date.now;
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return {
    jwks,
    sign(claims, o = {}) {
      const iat = Math.floor(now() / 1000);
      const head = b64({ alg: "EdDSA", typ: "JWT", kid });
      const body = b64({
        ...claims,
        iss: o.issuer ?? LOCAL_ISSUER,
        aud: LOCAL_AUDIENCE,
        iat,
        exp: iat + (o.ttlSeconds ?? 3600),
      });
      const sig = cryptoSign(null, Buffer.from(`${head}.${body}`), privateKey).toString("base64url");
      return `${head}.${body}.${sig}`;
    },
    async verify(token: string): Promise<Identity> {
      return verifyJwt(token, jwks, { issuer: LOCAL_ISSUER, audience: LOCAL_AUDIENCE, leeway: 0, now });
    },
  };
}

/** The dev server's and the seed minter's shared signing key: generated once under `<runDir>/idp-local/` (the
 *  run dir is git-ignored), file mode 0600, never committed. */
export function createPersistentLocalIdp(runDir: string): LocalIdp {
  const dir = join(runDir, "idp-local");
  const file = join(dir, "signing-key.pem");
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const pem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    writeFileSync(file, pem, { mode: 0o600 });
  }
  return createLocalIdp({ privateKeyPem: readFileSync(file, "utf8") });
}
