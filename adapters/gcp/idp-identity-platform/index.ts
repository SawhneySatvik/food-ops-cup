// idp-identity-platform — the IdP adapter for Google Identity Platform / Firebase Auth (R35). Verifies ID tokens
// (RS256) against Google's published securetoken JWKS: issuer `https://securetoken.google.com/<project>`,
// audience `<project>`. Reuses core-api's verifyJwt; no library. `email_verified` is a top-level claim signed by
// Google, so it is read from the token (no extra round trip, `needEmailVerified` changes nothing).
// Roles never come from the token (gotcha 11).
// UNVERIFIED against a live project: the JWKS URL and claim names follow Google's public docs.
import { verifyJwt, type Jwks } from "../../../services/core-api/src/auth/jwt.ts";
import { IdpError, type Identity, type IdP, type VerifyOpts } from "../../../services/core-api/src/auth/port.ts";

export const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const TTL_MS = 10 * 60_000;
const MIN_REFETCH_MS = 60_000;
const TIMEOUT_MS = 3_000;

export function identityPlatformIdp(opts: {
  projectId: string; fetch?: typeof fetch; now?: () => number; timeoutMs?: number; jwksUrl?: string;
}): IdP {
  const get = opts.fetch ?? fetch;
  const clock = opts.now ?? Date.now;
  const verifyOpts = { issuer: `https://securetoken.google.com/${opts.projectId}`, audience: opts.projectId, now: clock };
  let cached: { jwks: Jwks; at: number } | null = null;

  async function load(force: boolean): Promise<Jwks> {
    const now = clock();
    if (cached && now - cached.at < (force ? MIN_REFETCH_MS : TTL_MS)) return cached.jwks;
    let res: Response;
    try {
      res = await get(opts.jwksUrl ?? JWKS_URL, { signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS) });
    } catch {
      throw new IdpError("jwks unavailable");
    }
    if (!res.ok) throw new IdpError("jwks unavailable");
    const jwks = (await res.json().catch(() => ({}))) as Jwks;
    if (!Array.isArray(jwks.keys)) throw new IdpError("jwks malformed");
    cached = { jwks, at: now };
    return jwks;
  }

  return {
    async verify(token: string, _o: VerifyOpts = {}): Promise<Identity> {
      try {
        return verifyJwt(token, await load(false), verifyOpts);
      } catch (e) {
        // A rotated key: refetch once (rate-limited) and retry.
        if (e instanceof IdpError && e.message === "unknown key") return verifyJwt(token, await load(true), verifyOpts);
        throw e;
      }
    },
  };
}

export { DEMO_KEYS, ensureDemoAccounts, demoEmail, demoPassword, passwordGrant, DemoAccountError } from "./demo-accounts.ts";
