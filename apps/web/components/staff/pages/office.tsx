// file: components/staff/pages/office.tsx
"use client";
// /staff/office (T-128; screens/back-office.md B1 in Cobnut's look): the Manager and the eight specialists at their desks,
// the simulated suppliers' bay and the owner's desk. Pick a recent run and watch it again: each trace event lights the desk
// that did it, with a bubble in our words for its kind. Nothing is staged — with no runs the office is quiet — and no number
// is drawn: a finding or a proposal links to where its figures are. The event list under the floor is the same replay as a
// list, and the only view when the person prefers reduced motion. Owners and managers.
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { MunimError } from "@/lib/munim/client";
import { formatTime, formatWhen } from "@/lib/munim/format";
import { DESKS, bubbleOf, runWords, type Bubble, type Run, type Spot, type Trace } from "@/lib/munim/office";
import { can } from "@/lib/munim/session";
import { SIMULATED_SUPPLIER, specialistName, staffErrorText } from "@/lib/munim/staff-copy";
import { SITE } from "@/lib/site";
import { useStaff } from "../shell";
import { DeskArt, OwnerDeskArt, SupplierBayArt } from "../office-art";
import { ErrorNote } from "../../ui";
import { NotForRole } from "./inbox";

const REDUCED = "(prefers-reduced-motion: reduce)";
const subscribeReduced = (cb: () => void) => {
  const m = window.matchMedia(REDUCED);
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
};
const useReducedMotion = () => useSyncExternalStore(subscribeReduced, () => window.matchMedia(REDUCED).matches, () => false);

/** A desk tile: the art, the name, and the bubble while the replay is at it. */
function Tile({ spot, href, bubble, children }: { spot: Spot; href: string | null; bubble: Bubble | null; children: React.ReactNode }) {
  const name = spot === "suppliers" ? "Supplier bay" : spot === "owner" ? "Your desk" : specialistName(spot);
  const body = (
    <>
      {children}
      <span className="office-desk-name">{name}</span>
      {spot === "suppliers" && <span className="badge badge-sim justify-self-center">{SIMULATED_SUPPLIER}</span>}
      {bubble && <span className="office-bubble" data-tone={bubble.tone} role="status">{bubble.words}</span>}
    </>
  );
  return href ? <Link href={href} className="office-desk" data-active={bubble ? "true" : undefined} aria-label={`${name}: open the desk`}>{body}</Link>
    : <div className="office-desk" data-active={bubble ? "true" : undefined}>{body}</div>;
}

/** Where an event's link goes: the finding in the inbox, or the proposal's own page. */
const linkOf = (b: Bubble): string | null => (b.draftId ? `/staff/inbox/${b.draftId}` : b.findingId ? `/staff/inbox#finding-${b.findingId}` : null);

export function OfficePage() {
  const { session, client, outlet, handleAuth } = useStaff();
  const allowed = can(session, "office");
  const reduced = useReducedMotion();
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [events, setEvents] = useState<Trace[] | null>(null);
  const [error, setError] = useState<MunimError | null>(null);
  const [at, setAt] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<1 | 4>(1);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadRuns = useCallback(async () => {
    const r = await client.listRuns();
    if (r.ok) {
      setRuns(r.data.items);
      setError(null);
      setRunId((cur) => cur ?? r.data.items[0]?.run_id ?? null);
    } else if (!handleAuth(r.error)) setError(r.error);
  }, [client, handleAuth]);

  useEffect(() => {
    if (!allowed) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set after the response
    void loadRuns();
  }, [allowed, loadRuns]);

  useEffect(() => {
    if (!runId) return;
    let live = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a new run: clear the last one's replay, then fetch
    setEvents(null);
    setAt(-1);
    setPlaying(false);
    void client.getTraces(runId).then((r) => {
      if (!live) return;
      if (r.ok) setEvents(r.data.events);
      else if (!handleAuth(r.error)) setError(r.error);
    });
    return () => { live = false; };
  }, [client, runId, handleAuth]);

  useEffect(() => {
    if (!playing || !events) return;
    timer.current = setInterval(() => setAt((n) => {
      if (n + 1 >= events.length) {
        setPlaying(false);
        return n;
      }
      return n + 1;
    }), speed === 1 ? 1400 : 350);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [playing, events, speed]);

  const bubbles = useMemo(() => (events ?? []).map(bubbleOf), [events]);
  const current = at >= 0 ? bubbles[at] ?? null : null;
  const bubbleAt = (spot: Spot) => (current && current.spot === spot ? current : null);

  if (!allowed) return <NotForRole />;
  if (!outlet) return <main className="wrap staff-main"><div className="state-box" role="status">Loading</div></main>;
  const tz = outlet.tz;
  const run = runs?.find((r) => r.run_id === runId) ?? null;
  const play = () => {
    if (!events?.length) return;
    if (at + 1 >= events.length) setAt(-1);
    setPlaying(true);
  };

  return (
    <main className="wrap staff-main space-y-5 pb-10">
      <div>
        <h1 className="section-title">The office</h1>
        <p className="mt-3 max-w-[70ch] text-muted">Munim&apos;s Manager and its eight specialists, at their desks. Pick a recent run to watch what they did, step by step, from the run&apos;s own record. Tap a desk to see what it is working on.</p>
      </div>

      {error && <div className="space-y-2"><ErrorNote>{staffErrorText(error, "office")}</ErrorNote><button type="button" className="btn btn-plain" onClick={() => void loadRuns()}>Try again</button></div>}

      <section aria-label="Replay a run" className="card flex flex-wrap items-end gap-3 p-4">
        {runs === null ? <div className="skeleton h-12 w-64" aria-hidden="true" />
          : runs.length === 0 ? <p className="text-muted">The office is quiet. Ask a question or wait for the morning brief to see the team work.</p>
          : (
            <>
              <label className="block min-w-[min(100%,320px)] flex-1 font-semibold">
                Run
                <select value={runId ?? ""} onChange={(e) => setRunId(e.target.value)}>
                  {runs.map((r) => <option key={r.run_id} value={r.run_id}>{runWords(r)} · {formatWhen(r.issued_at, tz, SITE.locale)}</option>)}
                </select>
              </label>
              {!reduced && (
                <div className="flex flex-wrap gap-2">
                  <button type="button" className="btn btn-primary" disabled={!events?.length} onClick={() => (playing ? setPlaying(false) : play())}>{playing ? "Pause" : at < 0 ? "Watch it" : at + 1 >= (events?.length ?? 0) ? "Watch again" : "Carry on"}</button>
                  <button type="button" className="btn btn-plain" disabled={!events?.length || at + 1 >= (events?.length ?? 0)} onClick={() => { setPlaying(false); setAt((n) => n + 1); }}>Next step</button>
                  <button type="button" className="btn btn-plain" aria-pressed={speed === 4} onClick={() => setSpeed((s) => (s === 1 ? 4 : 1))}>{speed === 1 ? "Faster" : "Normal speed"}</button>
                </div>
              )}
            </>
          )}
      </section>

      {!reduced && (
        <section aria-label="The office floor" className="office-floor">
          <div className="office-grid">
            {DESKS.map((d) => (
              <Tile key={d} spot={d} href={`/staff/office/${d}`} bubble={bubbleAt(d)}>
                <DeskArt desk={d} active={bubbleAt(d) !== null} />
              </Tile>
            ))}
            <Tile spot="suppliers" href="/staff/suppliers" bubble={bubbleAt("suppliers")}><SupplierBayArt active={bubbleAt("suppliers") !== null} /></Tile>
            <Tile spot="owner" href="/staff/inbox" bubble={bubbleAt("owner")}><OwnerDeskArt active={bubbleAt("owner") !== null} /></Tile>
          </div>
        </section>
      )}

      {run && (
        <section aria-labelledby="log-title" className="space-y-3">
          <h2 id="log-title" className="section-title text-[28px]">What happened</h2>
          <p className="text-muted">{runWords(run)} · started {formatWhen(run.issued_at, tz, SITE.locale)}. Every line is read from the run&apos;s record; the figures are in what it links to.</p>
          {events === null ? <div className="skeleton h-32" role="status" aria-label="Loading the run" />
            : events.length === 0 ? <div className="state-box"><p>This run recorded nothing.</p></div>
            : (
              <ol className="grid gap-2">
                {events.map((e, i) => {
                  const b = bubbles[i]!;
                  const link = linkOf(b);
                  return (
                    <li key={e.id} className="card flex flex-wrap items-center gap-x-3 gap-y-1 p-3" aria-current={i === at ? "step" : undefined} style={i === at ? { borderColor: "var(--primary)" } : undefined}>
                      <span className="num text-[14px] text-muted">{formatTime(e.at, tz, SITE.locale)}</span>
                      <span className="font-semibold">{b.spot === "suppliers" ? `${specialistName(b.desk)} · supplier bay` : b.spot === "owner" ? `${specialistName(b.desk)} → your desk` : specialistName(b.desk)}</span>
                      <span className="office-bubble" data-tone={b.tone}>{b.words}</span>
                      {link && <Link href={link} className="inline-flex min-h-12 items-center font-semibold">{b.draftId ? "Open the proposal" : "Open the finding"}</Link>}
                    </li>
                  );
                })}
              </ol>
            )}
        </section>
      )}
    </main>
  );
}
