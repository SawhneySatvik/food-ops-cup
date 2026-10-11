// The HTTP AskPort (T-082b): core → intel `POST /ask` with the ask's run token as the bearer and the service secret.
// The ask is synchronous (T-088a): the member's request waits for intel, which runs route.intent and up to the run's
// model-call budget, so the timeout is well above the publisher's 5 s. No retry: the call spends model calls and
// intel stores its answer under core's answer id before answering — a hung or failed intel is `unavailable` (503,
// nothing written; threads/index.ts). Errors carry the status or the error's name only, never a body or the token.
import type { AskPort } from "./index.ts";

export const SERVICE_SECRET_HEADER = "x-munim-service-secret";
export const ASK_TIMEOUT_MS = 90_000;

export interface HttpAskPortOptions {
  /** intel's base URL, e.g. http://127.0.0.1:8081 */
  url: string;
  serviceSecret: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export function createHttpAskPort(o: HttpAskPortOptions): AskPort {
  const endpoint = new URL("ask", o.url.endsWith("/") ? o.url : `${o.url}/`).toString();
  const doFetch = o.fetch ?? fetch;
  const timeoutMs = o.timeoutMs ?? ASK_TIMEOUT_MS;
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
      throw new Error(`intel /ask: ${(e as Error).name}`);
    }
    if (!res.ok) {
      await res.arrayBuffer().catch(() => undefined);
      throw new Error(`intel /ask: HTTP ${res.status}`);
    }
    try {
      return await res.json();
    } catch (e) {
      throw new Error(`intel /ask: ${(e as Error).name}`);
    }
  };
}
