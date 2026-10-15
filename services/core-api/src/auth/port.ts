// IdP port (03-arch §4): verify a bearer ID token and return who it names. Adapters: adapters/gcp/idp-identity-platform,
// ./local-idp.ts (every gate, and the dev-only MUNIM_IDP=local), and the dev mapping's. Roles never come from the token
// (gotcha 11) — Postgres decides.
export interface Identity {
  sub: string;
  email: string | null;
  /** The IdP says this address was confirmed. An unverified email never claims an invite (B16); absent = false. */
  email_verified: boolean;
}

export interface VerifyOpts {
  /** Ask the IdP whether the address is confirmed (R1-M5). Only the routes that bind an email to a person need it:
   *  /v1/onboarding, /v1/members:bind and a customer's first sign-in at a merchant (/v1/account:link, R41's
   *  verified-email merge). Without it an adapter may skip that round trip and report `email_verified: false`;
   *  every other member and customer request depends on the token's signature alone. */
  needEmailVerified?: boolean;
}

export interface IdP {
  /** Resolves the identity, or rejects with IdpError for any bad, forged, expired or unreadable token. */
  verify(token: string, opts?: VerifyOpts): Promise<Identity>;
}

export class IdpError extends Error {
  override name = "IdpError";
}
