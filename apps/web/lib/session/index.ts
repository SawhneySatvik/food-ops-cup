// Session access for server code. The one token source in use is chosen here; swapping sign-in means changing this line.
import { cookies } from "next/headers";
import { devLocal } from "./dev-local.ts";
import { COOKIE, tokenClaims, type TokenSource } from "./port.ts";

export const tokenSource: TokenSource = devLocal;

export interface Session {
  token: string;
  tenantId: string | null;
  /** null = all outlets in the member's scope. */
  outletId: string | null;
  email: string | null;
}

/** The current member session, or null when nobody is signed in. */
export async function getSession(): Promise<Session | null> {
  const token = await tokenSource.bearer();
  if (!token) return null;
  const jar = await cookies();
  const scope = jar.get(COOKIE.scope)?.value;
  return {
    token,
    tenantId: jar.get(COOKIE.tenant)?.value ?? null,
    outletId: scope && scope !== "all" ? scope : null,
    email: tokenClaims(token).email ?? null,
  };
}

export { COOKIE, cookieOptions, type TokenSource } from "./port.ts";
