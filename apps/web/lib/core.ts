// core-api's address and the typed server-side client. MUNIM_CORE_API_URL is server-only (no NEXT_PUBLIC_ prefix):
// browsers only ever call the same-origin proxy at /api/v1/…, which attaches the session.
import { createMunimClient, type MunimClient } from "@munim/sdk";

export const coreUrl = (): string => (process.env.MUNIM_CORE_API_URL || "http://127.0.0.1:8790").replace(/\/$/, "");

/** What core's /health says about sign-in: "local" only on a dev server started with MUNIM_IDP=local (R44a). */
export async function coreIdp(): Promise<string | null> {
  try {
    const res = await fetch(`${coreUrl()}/health`, { cache: "no-store", signal: AbortSignal.timeout(3000) });
    const body = (await res.json()) as { idp?: unknown };
    return typeof body.idp === "string" ? body.idp : null;
  } catch {
    return null;
  }
}

/** A typed client for server components and actions, acting as the given member in the given tenant. */
export function serverClient(token: string, tenantId?: string | null): MunimClient {
  return createMunimClient({
    baseUrl: coreUrl(),
    token: () => token,
    ...(tenantId ? { tenantId } : {}),
    fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, cache: "no-store" }),
  });
}
