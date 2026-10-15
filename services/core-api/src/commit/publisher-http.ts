// The Publisher adapter every deployment uses (03-architecture §0, §4; R35): POSTs a batch of CloudEvents to intel
// `/events` with the service secret header; each event carries its own run token in the `munimrun`
// extension. Retries once on a network error, timeout, 429 or 5xx; any other status fails at once.
// Delivery is at-least-once: duplicate ids in one batch are sent once, and a retried batch re-sends the same
// ids, which intel dedupes (events:claim). Dependency-free (global fetch) and structurally typed; composeCoreApi and
// core-worker's composeWorker pass it in as their Publisher.

/** The header intel checks against its configured service secret. */
export const SERVICE_SECRET_HEADER = "x-munim-service-secret";
export const BATCH_CONTENT_TYPE = "application/cloudevents-batch+json";

export interface CloudEventLike {
  id: string;
  munimrun: string;
}

export interface HttpPublisherOptions {
  /** intel's base URL, e.g. http://127.0.0.1:8081 */
  url: string;
  serviceSecret: string;
  /** Per attempt. A hung intel must not hold the user's request for long. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export function createHttpPublisher(o: HttpPublisherOptions) {
  const endpoint = new URL("events", o.url.endsWith("/") ? o.url : `${o.url}/`).toString();
  const doFetch = o.fetch ?? fetch;
  const timeoutMs = o.timeoutMs ?? 5000;

  async function attempt(body: string): Promise<{ ok: true } | { ok: false; retry: boolean; detail: string }> {
    try {
      const res = await doFetch(endpoint, {
        method: "POST",
        headers: { "content-type": BATCH_CONTENT_TYPE, [SERVICE_SECRET_HEADER]: o.serviceSecret },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      await res.arrayBuffer();
      if (res.ok) return { ok: true };
      return { ok: false, retry: res.status === 429 || res.status >= 500, detail: `HTTP ${res.status}` };
    } catch (e) {
      // Name only: a fetch error message can echo request details.
      return { ok: false, retry: true, detail: (e as Error).name };
    }
  }

  return {
    async publish(events: readonly CloudEventLike[]): Promise<void> {
      const unique = [...new Map(events.map((e) => [e.id, e])).values()];
      if (unique.length === 0) return;
      const body = JSON.stringify(unique);
      let r = await attempt(body);
      if (!r.ok && r.retry) r = await attempt(body);
      if (!r.ok) throw new Error(`publisher-http: ${unique.length} event(s) not delivered (${r.detail})`);
    },
  };
}
