// lib/munim/track.ts: from 01-api-client.md
// Live order tracking: the stream wakes us up, the order read is the truth, polling covers stream outages.
import type { MunimClient } from "./client";
import { openStream } from "./stream";
import type { Schemas } from "./types";

export type OrderView = Schemas["StorefrontOrderView"];
const FINAL = new Set(["completed", "rejected", "cancelled"]);

export interface TrackOptions {
  client: MunimClient;
  baseUrl: string;
  storefrontKey: string;
  orderId: string;
  guestToken: string;
  onOrder: (order: OrderView) => void;
  /** true while the stream is open ("Live"); false while reconnecting or polling ("Updating…"). */
  onLive: (live: boolean) => void;
  /** Two 404s in a row: not this browser's order (or the mock forgot it). Show "This link isn't valid." */
  onNotFound: () => void;
  /** Called on a failed read that is not a 404 (offline, 5xx). Keep showing the last order. */
  onError?: (kind: "network" | "other") => void;
  pollMs?: number;
}

/** Starts tracking; returns a stop function (call it on unmount). */
export function trackOrder(o: TrackOptions): () => void {
  let stopped = false;
  let misses = 0;
  let poll: ReturnType<typeof setInterval> | undefined;
  const startPolling = () => {
    poll ??= setInterval(() => void refresh(), o.pollMs ?? 15_000);
  };
  const stopPolling = () => {
    if (poll) clearInterval(poll);
    poll = undefined;
  };

  const stream = openStream({
    baseUrl: o.baseUrl,
    topics: [`order:${o.orderId}`],
    guestToken: o.guestToken,
    headers: () => ({ "X-Munim-Storefront-Key": o.storefrontKey }),
    onEvent: () => void refresh(), // the event carries ids and statuses only: re-read the order
    onState: (s) => {
      if (stopped) return;
      o.onLive(s === "open");
      if (s === "open") stopPolling();
      else if (s !== "closed") startPolling();
    },
  });
  stream.done.catch(() => {
    if (!stopped) {
      o.onLive(false);
      startPolling(); // refused (e.g. 404): keep polling, keep showing the last update
    }
  });

  async function refresh(): Promise<void> {
    const r = await o.client.getOrder(o.orderId, o.guestToken);
    if (stopped) return;
    if (r.ok) {
      misses = 0;
      o.onOrder(r.data);
      if (FINAL.has(r.data.status)) stop(); // nothing will change any more
    } else if (r.error.kind === "not_found") {
      if (++misses >= 2) {
        stop();
        o.onNotFound();
      } else setTimeout(() => void refresh(), 2_000);
    } else o.onError?.(r.error.kind === "network" ? "network" : "other");
  }

  function stop() {
    stopped = true;
    stream.close();
    stopPolling();
  }

  void refresh();
  return stop;
}
