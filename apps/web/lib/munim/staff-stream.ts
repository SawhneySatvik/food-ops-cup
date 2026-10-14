// file: lib/munim/staff-stream.ts
// Live updates for staff screens: the SDK's fetch-based openStream with the member's bearer token and the tenant
// header (never EventSource, which cannot send them). Events carry ids and statuses only, so the screen never reads
// state from an event: every event (and every reconnect) is a wake-up to refetch the board, order or inbox.
import { TENANT_HEADER } from "@munim/sdk";
import type { Session } from "./session";
import { openStream, StreamRefused, type StreamState } from "./stream";

/** kds:<outlet> (tickets and orders of one outlet), order:<id>, inbox:<tenant> (owner and manager only). Up to 10. */
export const topic = {
  kds: (outletId: string) => `kds:${outletId}`,
  order: (orderId: string) => `order:${orderId}`,
  inbox: (tenantId: string) => `inbox:${tenantId}`,
};

export type LiveState = StreamState | "refused";

export interface WatchOptions {
  baseUrl: string;
  session: Pick<Session, "token" | "tenantId">;
  topics: readonly string[];
  /** Refetch here. Called at most once per 300 ms, and once each time the stream (re)opens. */
  onWake: () => void;
  /** "refused" = the server will not serve these topics to this person (404): show "Live updates are off" and
   *  keep the screen's Refresh button. Never retry a refused stream. */
  onState?: (s: LiveState) => void;
  extraHeaders?: () => Record<string, string>;
}

/** Starts watching; returns a stop function (call it on unmount or when the outlet changes). */
export function watch(o: WatchOptions): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const wake = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      o.onWake();
    }, 300);
  };
  const handle = openStream({
    baseUrl: o.baseUrl.replace(/\/+$/, ""),
    topics: o.topics,
    token: () => o.session.token,
    headers: () => ({ ...(o.extraHeaders?.() ?? {}), [TENANT_HEADER]: o.session.tenantId }),
    onEvent: wake,
    onState: (s) => {
      if (s === "open") wake(); // anything missed while reconnecting is refetched
      o.onState?.(s);
    },
  });
  handle.done.catch((e: unknown) => {
    if (e instanceof StreamRefused) o.onState?.("refused");
  });
  return () => {
    if (timer) clearTimeout(timer);
    handle.close();
  };
}
