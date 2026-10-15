// file: lib/counter-hooks.ts
"use client";
// The till's client hooks: what the counter needs for an outlet (counter menu, counter channel, POS device), the
// debounced preview, today's orders, one order kept fresh by its live topic, and the two writes (place, tender) with
// the one-attempt rule. Screens own the layout; every number they show comes from these responses.
import { useCallback, useEffect, useRef, useState } from "react";
import type { MunimError } from "./munim/client";
import { retryable } from "./munim/commands";
import type { Session } from "./munim/session";
import type { StaffClient } from "./munim/staff";
import { watchFor } from "./munim/staff-app";
import { topic, type LiveState } from "./munim/staff-stream";
import { placeAttempt, previewBodyFor, type PlaceAttempt, type TenderAttempt, type TillContext, type TillLine } from "./munim/till";
import type { Schemas } from "./munim/types";

type Menu = Schemas["V1CatalogueMenu"];
type Channel = Schemas["V1Channels"]["channels"][number];
type Preview = Schemas["OrdersPreviewResponse"];
type Order = Schemas["V1Order"];
type OrderItem = Schemas["V1OrdersList"]["items"][number];

export type Load<T> = { state: "loading" } | { state: "ready"; data: T } | { state: "failed"; error: MunimError };

export interface TillSetup {
  menu: Menu;
  /** The business's active counter channel. */
  counter: Channel;
  /** Every channel, for "Counter" / "Website (pickup)" labels on the order list. */
  channels: Channel[];
  /** The outlet's POS device (numbers the invoice), or null when it has none. */
  deviceId: string | null;
}

/** Counter menu + channels + devices for one outlet, in parallel. `noCounter` = the business has no active counter
 *  channel (the till cannot sell). Refetched every 60 s while visible and when the tab comes back (sold-out tiles
 *  follow the menu), and by `reload` (Try again). A refetch keeps the last good menu on screen until it answers. */
export function useTillSetup(client: StaffClient, outletId: string | null, onAuth: (e: MunimError) => boolean) {
  const [load, setLoad] = useState<Load<TillSetup> | { state: "noCounter" }>({ state: "loading" });
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!outletId) return;
    let live = true;
    void Promise.all([client.getMenu(outletId, "counter"), client.listChannels(), client.listDevices()]).then(([m, c, d]) => {
      if (!live) return;
      const bad = [m, c, d].find((r) => !r.ok);
      if (bad && !bad.ok) {
        const error = bad.error;
        if (!onAuth(error)) setLoad((cur) => (cur.state === "ready" ? cur : { state: "failed", error })); // a failed refetch keeps the menu
        return;
      }
      if (!m.ok || !c.ok || !d.ok) return;
      const counter = c.data.channels.find((x) => x.kind === "counter" && x.active);
      if (!counter) return setLoad({ state: "noCounter" });
      const pos = d.data.devices.find((x) => x.outlet_id === outletId && x.kind === "pos");
      setLoad({ state: "ready", data: { menu: m.data, counter, channels: c.data.channels, deviceId: pos?.id ?? null } });
    });
    return () => { live = false; };
  }, [client, outletId, onAuth, n]);
  useEffect(() => {
    const again = () => { if (document.visibilityState === "visible") setN((x) => x + 1); };
    const t = setInterval(again, 60_000);
    document.addEventListener("visibilitychange", again);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", again); };
  }, []);
  return { load, reload: useCallback(() => setN((x) => x + 1), []) };
}

export interface PreviewState {
  preview: Preview | null;
  loading: boolean;
  error: MunimError | null;
}

/** Re-prices the cart 300 ms after each change, and whenever `again` changes ("Try again", after a refusal). A
 *  response older than the latest request is dropped, so the rail never shows the total of a cart that no longer
 *  exists. Writes nothing. */
export function useTillPreview(client: StaffClient, ctx: TillContext | null, lines: readonly TillLine[], again: unknown = 0): PreviewState {
  const [state, setState] = useState<PreviewState>({ preview: null, loading: false, error: null });
  const seq = useRef(0);
  const key = JSON.stringify([ctx, lines.map((l) => [l.entry.item_id, l.entry.variant_id, l.optionIds, l.qty]), again]);
  useEffect(() => {
    const mine = ++seq.current;
    if (!ctx || lines.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing the preview when the cart empties
      setState({ preview: null, loading: false, error: null });
      return;
    }
    setState((s) => ({ ...s, loading: true }));
    const t = setTimeout(async () => {
      const r = await client.previewOrder(previewBodyFor(ctx, lines));
      if (mine !== seq.current) return;
      setState(r.ok ? { preview: r.data, loading: false, error: null } : { preview: null, loading: false, error: r.error });
    }, 300);
    return () => clearTimeout(t);
    // `key` captures every input that changes the price (the note does not).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, client]);
  return state;
}

export type PlaceOutcome = { ok: true; orderId: string } | { ok: false; error: MunimError; keep: boolean };

/** One place attempt per thing the person confirmed. A retry after a network error, timeout, 429 or 5xx sends the
 *  same envelope (core replays it: never two orders). Any other failure ends the attempt, a reused key (409
 *  idempotency_conflict, our bug) included: nothing is sent again without a tap, and the next tap is a new attempt. */
export function usePlace(client: StaffClient) {
  const attempt = useRef<PlaceAttempt | null>(null);
  const [busy, setBusy] = useState(false);
  const place = useCallback(async (ctx: TillContext, lines: readonly TillLine[], previewTotalMinor: number): Promise<PlaceOutcome> => {
    setBusy(true);
    try {
      const a = placeAttempt(attempt.current, ctx, lines, previewTotalMinor);
      attempt.current = a;
      const r = await client.placeOrder(a.body);
      if (r.ok) {
        attempt.current = null;
        return { ok: true, orderId: r.data.entity_id };
      }
      const keep = retryable(r.error);
      if (!keep) attempt.current = null;
      return { ok: false, error: r.error, keep };
    } finally {
      setBusy(false);
    }
  }, [client]);
  return { place, busy };
}

/** Today's orders at the outlet, newest first, with "Load more" while there is a next page. */
export function useTodayOrders(client: StaffClient, outletId: string | null, businessDate: string | null, onAuth: (e: MunimError) => boolean) {
  const [items, setItems] = useState<OrderItem[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState<MunimError | null>(null);
  const fetchPage = useCallback(async (cursor?: string) => {
    if (!outletId || !businessDate) return;
    const r = await client.listOrders({ outlet: outletId, business_date: businessDate, limit: 50, ...(cursor ? { cursor } : {}) });
    if (!r.ok) {
      if (!onAuth(r.error)) setError(r.error);
      return;
    }
    setError(null);
    setItems((prev) => (cursor && prev ? [...prev, ...r.data.items] : r.data.items));
    setNext(r.data.next_cursor);
  }, [client, outletId, businessDate, onAuth]);
  const refresh = useCallback(() => void fetchPage(), [fetchPage]);
  const more = useCallback(() => { if (next) void fetchPage(next); }, [fetchPage, next]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- the first page loads when the outlet or day is known
  useEffect(() => { void fetchPage(); }, [fetchPage]);
  return { items, hasMore: next !== null, error, refresh, more };
}

/** Wakes `onWake` on every live event of the topics (and on every reopen). `off` drives "Live updates are off": the
 *  stream was refused, or has been retrying for over 5 s (the planned reconnect, about every 50 s on the mock and 55
 *  min on the real API, takes about a second and is not shown). */
export function useLive(session: Session, topics: readonly string[], onWake: () => void): { state: LiveState; off: boolean } {
  const [state, setState] = useState<LiveState>("connecting");
  const [stuck, setStuck] = useState(false);
  const wake = useRef(onWake);
  useEffect(() => { wake.current = onWake; });
  const key = topics.join(",");
  useEffect(() => {
    if (!key) return;
    return watchFor(session, key.split(","), () => wake.current(), setState);
  }, [session, key]);
  useEffect(() => {
    if (state !== "retrying") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the stream recovered
      setStuck(false);
      return;
    }
    const t = setTimeout(() => setStuck(true), 5000);
    return () => clearTimeout(t);
  }, [state]);
  return { state, off: state === "refused" || stuck };
}

/** One order, refetched on every event of `order:<id>`. `missing` = 404 (not found, or not in the person's outlets). */
export function useOrder(client: StaffClient, session: Session, orderId: string, onAuth: (e: MunimError) => boolean) {
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<MunimError | null>(null);
  const refresh = useCallback(async () => {
    const r = await client.getOrder(orderId);
    if (r.ok) {
      setOrder(r.data);
      setError(null);
    } else if (!onAuth(r.error)) setError(r.error);
  }, [client, orderId, onAuth]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- the order loads once the id is known
  useEffect(() => { void refresh(); }, [refresh]);
  const live = useLive(session, [topic.order(orderId)], () => void refresh());
  return { order, error, missing: error?.kind === "not_found", refresh, liveOff: live.off };
}

/** The tender panel's attempt: kept until it succeeds or fails for good (same rule as placing). */
export function useTender(client: StaffClient, orderId: string) {
  const attempt = useRef<TenderAttempt | null>(null);
  const [busy, setBusy] = useState(false);
  const record = useCallback(async (build: (prev: TenderAttempt | null) => TenderAttempt): Promise<{ ok: true; tenderId: string } | { ok: false; error: MunimError }> => {
    setBusy(true);
    const a = build(attempt.current);
    attempt.current = a;
    const r = await client.recordTender(orderId, a.body);
    setBusy(false);
    if (r.ok) {
      attempt.current = null;
      return { ok: true, tenderId: r.data.entity_id };
    }
    if (!retryable(r.error)) attempt.current = null;
    return { ok: false, error: r.error };
  }, [client, orderId]);
  return { record, busy };
}
