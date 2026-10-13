"use client";
// K1 ticket board + K2 station filter (screens/kds.md). Everything on a card is a field of the board row core returned;
// events carry ids only (the project rules), so every event refetches the board rather than patching state from the payload.
// Moves go through kitchen.ticket.advance.v1 — one step forward, guarded by from_status (rule 10); a 409 means another
// screen moved it first: say so and re-render from the row.
import type { Schemas } from "@munim/sdk";
import { Button, createFormatter, IconAlert, IconCheck, IconOffline, LivePill, StateEmpty, StateLoading, uiT } from "@munim/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, newIdempotencyKey } from "../api.ts";
import { t } from "../i18n/index.ts";
import { useStream } from "../live.ts";
import { actionFor, channelLabel, cueOf, humanize, nextDueMs, sortTickets, stationCounts, type Cue, type Ticket } from "./logic.ts";

export interface KdsOutlet { id: string; name: string; tz: string }
type Board = Schemas["V1KdsBoard"];

const LS_STATION = "munim.kds.station";
const LS_CONTRAST = "munim.kds.contrast";
const POLL_MS = 10_000; // slow safety net for the amber edge; SSE carries everything else
const DUE_SLACK_MS = 1_500;

function channelText(kind: string): string {
  const c = channelLabel(kind);
  return "text" in c ? c.text : t(c.key, c.vars);
}

interface Attempt { commandId: string; key: string; from: Ticket["status"]; to: Ticket["status"] }

/** Shape cue (§5): circle = new, ring = in progress, triangle = at risk, octagon = late, check = ready. */
function CueShape({ cue }: { cue: Cue }) {
  if (cue === "at_risk") return <IconAlert size={28} />;
  if (cue === "ready") return <IconCheck size={28} />;
  const shape = cue === "late"
    ? <path d="M8.5 3h7L21 8.5v7L15.5 21h-7L3 15.5v-7Z" fill="currentColor" />
    : cue === "new" ? <circle cx="12" cy="12" r="8" fill="currentColor" /> : <circle cx="12" cy="12" r="7" fill="none" strokeWidth="3" />;
  return <svg width="28" height="28" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true" focusable="false" data-shape={cue}>{shape}</svg>;
}

export function KdsBoard(props: { outlets: KdsOutlet[]; outletId: string | null; country: string; fallbackTz: string }) {
  const { outlets, outletId, country } = props;
  const outlet = outlets.find((o) => o.id === outletId) ?? null;
  const fmt = useMemo(() => createFormatter({ country, tz: outlet?.tz ?? props.fallbackTz }), [country, outlet?.tz, props.fallbackTz]);
  const live = useStream(outletId ? [`kds:${outletId}`] : null, () => void load());

  const [board, setBoard] = useState<Board | null>(null);
  const [failed, setFailed] = useState(false);
  const [skew, setSkew] = useState(0); // core's clock minus this device's, so timers agree with core's verdict
  const [now, setNow] = useState(() => Date.now());
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [station, setStation] = useState("all");
  const [high, setHigh] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [offline, setOffline] = useState<ReadonlySet<string>>(new Set());
  const [flash, setFlash] = useState<ReadonlySet<string>>(new Set());
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const attempts = useRef(new Map<string, Attempt>());
  const seen = useRef<Set<string> | null>(null);
  const inflight = useRef(false);
  const again = useRef(false);

  // Device-local choices (not records).
  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("station");
    setStation(fromUrl ?? localStorage.getItem(LS_STATION) ?? "all");
    setHigh(localStorage.getItem(LS_CONTRAST) === "high");
  }, []);

  const load = useCallback(async () => {
    if (!outletId) return;
    if (inflight.current) { again.current = true; return; }
    inflight.current = true;
    try {
      const { data } = await api.GET("/v1/kitchen/board", { params: { query: { outlet: outletId } } });
      if (!data) { setFailed(true); return; }
      setFailed(false);
      setSkew(Date.parse(data.as_of) - Date.now());
      setBoard(data);
      // A ticket that was not on the board before gets the 1 s outline (§6); the first load highlights nothing.
      const ids = new Set(data.tickets.map((x) => x.ticket_id));
      if (seen.current) {
        const added = [...ids].filter((id) => !seen.current!.has(id));
        if (added.length) {
          setFresh((f) => new Set([...f, ...added]));
          setTimeout(() => setFresh((f) => new Set([...f].filter((id) => !added.includes(id)))), 1000);
        }
      }
      seen.current = ids;
    } catch {
      setFailed(true);
    } finally {
      inflight.current = false;
      if (again.current) { again.current = false; void load(); }
    }
  }, [outletId]);

  useEffect(() => { void load(); }, [load]);
  // Replay after a reconnect covers missed events; refetch anyway so a long gap cannot leave a stale board.
  useEffect(() => { if (live === "open") void load(); }, [live, load]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    const poll = setInterval(() => void load(), POLL_MS);
    return () => { clearInterval(id); clearInterval(poll); };
  }, [load]);

  // The late verdict is core's: refetch just after the earliest due_at passes.
  const due = board ? nextDueMs(board.tickets, now + skew) : null;
  useEffect(() => {
    if (due === null) return;
    const id = setTimeout(() => void load(), Math.max(0, due - (Date.now() + skew)) + DUE_SLACK_MS);
    return () => clearTimeout(id);
  }, [due, skew, load]);

  // Display names: item_id → menu display name; a missing one falls back to the humanised name_key.
  useEffect(() => {
    if (!outletId) return;
    void api.GET("/v1/catalogue/menu", { params: { query: { outlet: outletId, channel_kind: "counter" } } }).then(({ data }) => {
      if (data) setNames(new Map(data.entries.flatMap((e) => (e.display_name ? [[e.item_id, e.display_name] as const] : []))));
    }).catch(() => undefined);
  }, [outletId]);

  const clock = now + skew;
  const nowTickets = useMemo(() => sortTickets((board?.tickets ?? []).filter((x) => x.lane === "now"), clock), [board, clock]);
  const laterTickets = useMemo(() => (board?.tickets ?? []).filter((x) => x.lane === "later"), [board]);
  const counts = useMemo(() => stationCounts(nowTickets), [nowTickets]);
  const shown = station === "all" ? nowTickets : nowTickets.filter((x) => x.station === station);
  const lateCount = shown.filter((x) => cueOf(x, clock) === "late").length;
  const newCount = nowTickets.filter((x) => x.status === "queued").length;

  useEffect(() => {
    document.title = newCount > 0 ? t("kds.tab_title_new", { count: String(newCount) }) : t("kds.tab_title");
  }, [newCount]);

  const pickStation = (s: string) => { setStation(s); localStorage.setItem(LS_STATION, s); };
  const toggleContrast = () => { const next = !high; setHigh(next); localStorage.setItem(LS_CONTRAST, next ? "high" : "normal"); };

  const mark = (set: typeof setBusy, id: string, on: boolean) => set((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n; });

  async function advance(tk: Ticket) {
    const act = actionFor(tk);
    if (!act || busy.has(tk.ticket_id)) return;
    // One key per intent: a Retry after "Not saved" resends the same key and command id (03-arch §1.6).
    let a = attempts.current.get(tk.ticket_id);
    if (!a || a.from !== tk.status || a.to !== act.to) {
      a = { commandId: newIdempotencyKey(), key: newIdempotencyKey(), from: tk.status, to: act.to };
      attempts.current.set(tk.ticket_id, a);
    }
    mark(setBusy, tk.ticket_id, true);
    mark(setOffline, tk.ticket_id, false);
    try {
      const { response } = await api.POST("/v1/kitchen/tickets/{id}:advance", {
        params: { path: { id: tk.ticket_id } },
        body: { command_id: a.commandId, idempotency_key: a.key, type: "kitchen.ticket.advance.v1", payload: { ticket_id: tk.ticket_id, from_status: a.from, to_status: a.to } },
      });
      attempts.current.delete(tk.ticket_id);
      if (response.status === 409) {
        // Another screen moved it first: flash the card, name where it is now, re-render from the row.
        mark(setFlash, tk.ticket_id, true);
        setTimeout(() => mark(setFlash, tk.ticket_id, false), 800);
        const { data } = await api.GET("/v1/kitchen/board", { params: { query: { outlet: outletId! } } });
        const now = data?.tickets.find((x) => x.ticket_id === tk.ticket_id)?.status ?? "done";
        setToast(t("kds.conflict", { status: t(`kds.status.${now}`) }));
      } else if (response.status === 403) {
        setToast(t("kds.deny"));
      } else if (!response.ok) {
        setToast(uiT("common.state.err"));
      }
      await load();
    } catch {
      mark(setOffline, tk.ticket_id, true); // keep the attempt: Retry reuses its key
    } finally {
      mark(setBusy, tk.ticket_id, false);
    }
  }

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(id);
  }, [toast]);

  const name = (id: string, key: string) => names.get(id) ?? humanize(key);
  const stationChips = ["all", ...(board?.stations ?? [])];

  return (
    <div className="kds" data-kds-contrast={high ? "high" : undefined} data-contrast={high ? "high" : "normal"}>
      <header className="kds-bar">
        <h1>{t("kds.title", { outlet: outlet?.name ?? "" })}</h1>
        {outlets.length > 1 && (
          <select aria-label={t("kds.outlet")} value={outletId ?? ""} onChange={(e) => { window.location.search = `?outlet=${e.target.value}`; }}>
            {outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        )}
        <div className="kds-chips" role="group" aria-label={t("kds.stations")}>
          {stationChips.map((s) => (
            <button key={s} type="button" className="kds-chip" aria-pressed={station === s} data-station={s} onClick={() => pickStation(s)}>
              {s === "all" ? t("kds.station.all") : humanize(s)} <span className="kds-count">{s === "all" ? nowTickets.length : counts.get(s) ?? 0}</span>
            </button>
          ))}
        </div>
        <span className="kds-spacer" />
        <span className="kds-late-count" data-testid="late-count">{t("kds.late_count", { count: String(lateCount) })}</span>
        <button type="button" className="kds-chip" aria-pressed={high} data-testid="contrast" onClick={toggleContrast}>{t("kds.contrast")}</button>
        <LivePill state={live} />
      </header>

      {toast && (
        <div className="kds-toast" role="status" data-testid="toast">
          <span>{toast}</span>
          <button type="button" className="kds-chip" onClick={() => setToast(null)}>{t("kds.dismiss")}</button>
        </div>
      )}

      {!outletId ? <StateEmpty message={t("kds.no_outlet")} /> : !board && !failed ? <StateLoading rows={4} /> : (
        <div className="kds-body" data-stale={live === "retrying" || failed ? "true" : undefined}>
          {failed && !board ? <p role="alert">{uiT("common.state.err")}</p> : shown.length === 0 && laterTickets.length === 0 ? (
            <StateEmpty message={t("kds.empty")} />
          ) : (
            <div className="kds-lanes">
              <ul className="kds-grid" aria-label={t("kds.tickets")}>
                {shown.map((tk) => {
                  const cue = cueOf(tk, clock);
                  const act = actionFor(tk);
                  const over = tk.due_at ? fmt.elapsed(Math.max(0, (clock - Date.parse(tk.due_at)) / 1000)) : "";
                  const label = cue === "late" ? t("kds.state.late", { over }) : t(`kds.state.${cue}`);
                  return (
                    <li key={tk.ticket_id} className="kds-card" data-ticket-id={tk.ticket_id} data-ticket-no={tk.ticket_no} data-cue={cue}
                      data-status={tk.status} data-flash={flash.has(tk.ticket_id) || undefined} data-fresh={fresh.has(tk.ticket_id) || undefined}>
                      <div className="kds-card-head">
                        <span className="kds-no">#{tk.ticket_no}</span>
                        <span className="kds-timer" data-testid="timer">{fmt.elapsed((clock - Date.parse(tk.started_at)) / 1000)}</span>
                      </div>
                      <div className="kds-cue" data-testid="cue"><CueShape cue={cue} /><span>{label}</span></div>
                      <div className="kds-meta">
                        {t(`kds.kind.${tk.kind}`)} · {channelText(tk.channel_kind)}{tk.table_ref ? ` · ${t("kds.table", { ref: tk.table_ref })}` : ""}
                        {board && board.stations.length > 1 ? ` · ${humanize(tk.station)}` : ""}
                      </div>
                      <ul className="kds-lines">
                        {tk.lines.map((l) => (
                          <li key={l.line_no}>
                            <span className="kds-line-name">{fmt.qtyMilli(l.qty_milli)} {name(l.item_id, l.name_key)}</span>
                            {l.options.map((o) => <span key={o.option_id} className="kds-mod">+ {humanize(o.name_key)}</span>)}
                            {l.note && <span className="kds-note">{l.note}</span>}
                          </li>
                        ))}
                      </ul>
                      {tk.due_at && <div className="kds-due">{t("kds.due", { time: fmt.time(tk.due_at) })}</div>}
                      {offline.has(tk.ticket_id) && (
                        <p className="kds-off" role="alert"><IconOffline size={20} /> {t("kds.off")}</p>
                      )}
                      {act && (
                        <Button variant="primary" size="lg" className="kds-action" busy={busy.has(tk.ticket_id)}
                          aria-label={offline.has(tk.ticket_id) ? undefined : t(`${act.key}_aria`, { no: String(tk.ticket_no) })} onClick={() => void advance(tk)}>
                          {offline.has(tk.ticket_id) ? uiT("common.action.retry") : t(act.key)}
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
              {laterTickets.length > 0 && (
                <aside className="kds-later" aria-label={t("kds.later")}>
                  <h2>{t("kds.later")}</h2>
                  <ul>
                    {laterTickets.map((tk) => (
                      <li key={tk.ticket_id} className="kds-card" data-ticket-id={tk.ticket_id} data-lane="later">
                        <span className="kds-no">#{tk.ticket_no}</span>
                        <div className="kds-meta">{t("kds.scheduled")}{tk.surface_at ? ` · ${t("kds.scheduled.shows", { time: fmt.time(tk.surface_at) })}` : ""}</div>
                      </li>
                    ))}
                  </ul>
                </aside>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
