// IdP port (03-arch §4): verify a bearer ID token and return who it names. Adapters: adapters/dev/idp-devhost
// (dev), adapters/dev/idp-local (every gate). Roles never come from the token (gotcha 11) — Postgres decides.
export interface Identity {
  sub: string;
  email: string | null;
}

export interface IdP {
  /** Resolves the identity, or rejects with IdpError for any bad, forged, expired or unreadable token. */
  verify(token: string): Promise<Identity>;
}

export class IdpError extends Error {
  override name = "IdpError";
}
