// The token-source port: everything in apps/web gets the signed-in member's bearer token through this interface, so
// the real sign-in for a deployment (a later founder decision) replaces one implementation and nothing else.
// Server-only: tokens live in httpOnly cookies and never reach browser code.

export interface TokenSource {
  /** Stable id, for logs and the sign-in page ("dev-local" today). */
  readonly id: string;
  /** Where a visitor with no session is sent. */
  readonly signInPath: string;
  /** The member's bearer token for this request, or null. May refresh an expiring token (and re-set its cookie
   *  where the caller can set cookies: route handlers and server actions). */
  bearer(): Promise<string | null>;
}

/** Cookie names. All httpOnly + SameSite=Lax (a cross-site POST to an approve route must not carry the session). */
export const COOKIE = {
  token: "munim_token",
  tenant: "munim_tenant",
  /** "all" or one outlet id — the chrome's scope switch. */
  scope: "munim_scope",
  theme: "munim_theme",
  /** dev-local only: "<world>:<persona>", so an expired dev token can be re-minted. */
  devPersona: "munim_dev_persona",
} as const;

export const cookieOptions = (maxAgeSeconds?: number) => ({
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  ...(maxAgeSeconds !== undefined ? { maxAge: maxAgeSeconds } : {}),
});

/** The JWT payload, unverified — only to read `exp` and `email` of a token this server already holds. Core verifies. */
export function tokenClaims(token: string): { exp?: number; email?: string; sub?: string } {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { exp?: number; email?: string };
  } catch {
    return {};
  }
}
