// file: lib/kitchen-hooks.ts
"use client";
// The kitchen display's client hooks. useBoard keeps the last good board and refetches it on every live event of
// kds:<outlet>, on every stream reopen, every 30 s while the screen is visible (colour and timers are core's verdict
// at `as_of`, never the tablet's clock) and when the tab comes back. useAdvance sends one step per tap with the
// one-attempt rule and refetches after every answer; nothing is moved on screen before core says so.
import { useCallback, useEffect, useRef, useState } from "react";
import type { MunimError } from "./munim/client";
import { envelope, retryable, type Envelope } from "./munim/commands";
import { boardLanes, namesFrom, sizesOf, ticketNews, type Board, type Ticket } from "./munim/kitchen";
import type { Session } from "./munim/session";
import type { StaffClient } from "./munim/staff";
import { watchFor } from "./munim/staff-app";
import { topic, type LiveState } from "./munim/staff-stream";
import type { Schemas } from "./munim/types";

type Menu = Schemas["V1CatalogueMenu"];
type Order = Schemas["V1Order"];
const POLL_MS = 30_000;

export interface BoardState {
  /** The last board core sent (kept while offline or after a failed refetch); null until the first one. */
  board: Board | null;
  /** The last refetch's failure, or null. A not_found / not_applicable error with no board is a full-page state. */
  error: MunimError | null;
  names: (nameKey: string) => string;
  /** The size of a line ("1 kg (serves 8–10)"), from the ticket's order; null while unknown or when it has none. */
  sizeOf: (orderId: string, lineNo: number) => string | null;
  live: LiveState;
  /** "Live updates are off": refused, or retrying for over 5 s (a planned reconnect takes about a second). */
  liveOff: boolean;
  lanes: { now: Ticket[]; later: Ticket[] };
  refresh: () => void;
}

export function useBoard(client: StaffClient, session: Session, outletId: string, station: string | null, onAuth: (e: MunimError) => boolean, announce: (lines: string[]) => void): BoardState {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<MunimError | null>(null);
  const [menus, setMenus] = useState<Menu[]>([]);
  const [orders, setOrders] = useState<Map<string, Order>>(new Map());
  const [live, setLive] = useState<LiveState>("connecting");
  const [stuck, setStuck] = useState(false);
  const last = useRef<Board | null>(null);
  const asked = useRef(new Set<string>());
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const say = useRef(announce);
  const wake = useRef<() => Promise<void>>(async () => {});
  useEffect(() => { say.current = announce; });

  // A new station starts a new board: nothing on it is "new" (no false announcements).
  useEffect(() => { last.current = null; }, [station]);

  // Names: once per outlet, from the menu of every active channel kind (the board sends name keys only).
  useEffect(() => {
    let alive = true;
    void client.listChannels().then(async (c) => {
      const kinds = c.ok ? [...new Set(c.data.channels.filter((x) => x.active).map((x) => x.kind))] : ["counter"];
      const got = await Promise.all(kinds.map((k) => client.getMenu(outletId, k)));
      if (alive) setMenus(got.flatMap((r) => (r.ok ? [r.data] : [])));
    });
    return () => { alive = false; };
  }, [client, outletId]);

  const refresh = useCallback(async () => {
    const r = await client.getBoard(outletId, station ?? undefined);
    if (!r.ok) {
      if (onAuth(r.error)) return;
      setError(r.error);
      if (r.error.kind === "rate_limited" && !retryTimer.current) {
        retryTimer.current = setTimeout(() => { retryTimer.current = null; void wake.current(); }, r.error.retryAfterMs ?? 5000);
      }
      return;
    }
    setError(null);
    say.current(ticketNews(last.current, r.data));
    last.current = r.data;
    setBoard(r.data);
    // Sizes: one order read per order not seen yet (the board's lines carry no variant).
    for (const id of new Set(r.data.tickets.map((t) => t.order_id))) {
      if (asked.current.has(id)) continue;
      asked.current.add(id);
      void client.getOrder(id).then((o) => {
        if (o.ok) setOrders((m) => new Map(m).set(id, o.data));
        else asked.current.delete(id); // try again on the next refetch
      });
    }
  }, [client, outletId, station, onAuth]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the first board loads when the outlet or station is known
    void refresh();
    const tick = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, POLL_MS);
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
      if (retryTimer.current) clearTimeout(retryTimer.current);
      retryTimer.current = null;
    };
  }, [refresh]);

  // Live: every event and every reopen is a wake-up to refetch. A refused stream keeps polling and the Refresh button.
  useEffect(() => { wake.current = refresh; });
  useEffect(() => watchFor(session, [topic.kds(outletId)], () => void wake.current(), setLive), [session, outletId]);

  useEffect(() => {
    if (live !== "retrying") {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the stream recovered
      setStuck(false);
      return;
    }
    const t = setTimeout(() => setStuck(true), 5000);
    return () => clearTimeout(t);
  }, [live]);

  const sizeOf = (orderId: string, lineNo: number) => {
    const o = orders.get(orderId);
    return o ? (sizesOf(o, menus).get(lineNo) ?? null) : null;
  };
  return {
    board, error, names: namesFrom(menus), sizeOf, live, liveOff: live === "refused" || stuck,
    lanes: board ? boardLanes(board) : { now: [], later: [] },
    refresh: () => void refresh(),
  };
}

type AdvanceCommand = Envelope<"kitchen.ticket.advance.v1", Schemas["KitchenTicketAdvanceV1"]>;
export type AdvanceOutcome = { ok: true } | { ok: false; error: MunimError };

/** One step per tap, waiting for core's 200 (no optimistic move). The same envelope is resent after a network
 *  error, timeout, 429 or 5xx; a 409 (someone moved it first) or 404 ends the attempt, and the board refetches. */
export function useAdvance(client: StaffClient, refresh: () => void) {
  const attempts = useRef(new Map<string, AdvanceCommand>());
  const [busy, setBusy] = useState<string | null>(null);
  const advance = useCallback(async (t: Ticket, to: "preparing" | "ready" | "done"): Promise<AdvanceOutcome> => {
    const fp = JSON.stringify([t.ticket_id, t.status, to]);
    const body = attempts.current.get(fp) ?? envelope("kitchen.ticket.advance.v1", { ticket_id: t.ticket_id, from_status: t.status, to_status: to });
    attempts.current.set(fp, body);
    setBusy(t.ticket_id);
    const r = await client.advanceTicket(t.ticket_id, body);
    setBusy(null);
    if (r.ok || !retryable(r.error)) attempts.current.delete(fp);
    if (r.ok || r.error.kind !== "network") refresh();
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }, [client, refresh]);
  return { advance, busy };
}
