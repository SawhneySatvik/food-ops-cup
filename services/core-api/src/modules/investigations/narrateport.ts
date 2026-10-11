// The HTTP NarratePort (T-083): core → intel `POST /investigate:narrate` with the step's `ask` run token as the bearer and
// the service secret. One L1 call at most on intel's side, so the timeout is short; no retry (a retry could spend a
// second model call). A failed or slow intel leaves core's template narration in place (rule 11). Errors carry the
// status or the error's name only, never a body or the token.
import type { NarratePort } from "./index.ts";

export const SERVICE_SECRET_HEADER = "x-munim-service-secret";
export const NARRATE_TIMEOUT_MS = 30_000;

export interface HttpNarratePortOptions {
  /** intel's base URL, e.g. http://127.0.0.1:8081 */
  url: string;
  serviceSecret: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export function createHttpNarratePort(o: HttpNarratePortOptions): NarratePort {
  // "./": a bare "investigate:narrate" parses as an absolute URL whose scheme is `investigate:` (R-D, review W3 close).
  const endpoint = new URL("./investigate:narrate", o.url.endsWith("/") ? o.url : `${o.url}/`).toString();
  const doFetch = o.fetch ?? fetch;
  const timeoutMs = o.timeoutMs ?? NARRATE_TIMEOUT_MS;
  return async (runToken, body) => {
    let res: Response;
    try {
      res = await doFetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${runToken}`, [SERVICE_SECRET_HEADER]: o.serviceSecret },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new Error(`intel /investigate:narrate: ${(e as Error).name}`);
    }
    if (!res.ok) {
      await res.arrayBuffer().catch(() => undefined);
      throw new Error(`intel /investigate:narrate: HTTP ${res.status}`);
    }
    try {
      return await res.json();
    } catch (e) {
      throw new Error(`intel /investigate:narrate: ${(e as Error).name}`);
    }
  };
}
