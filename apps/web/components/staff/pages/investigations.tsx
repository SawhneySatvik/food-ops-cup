// file: components/staff/pages/investigations.tsx
"use client";
// /staff/investigations (T-128): the investigations this person can see, newest first, and "Start an investigation".
// Munim's one playbook today asks "Why did the margin fall?" for a month against the month before it. The modes offered
// stop at this role's ceiling (GET /v1/ai/policy); the investigation id is the client's (its idempotency key), so a retry of
// the same choice reuses it. Owners, advisors and judges: the playbook reads finance figures, which a manager cannot open.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOnline } from "@/lib/hooks";
import type { MunimError } from "@/lib/munim/client";
import { formatWhen } from "@/lib/munim/format";
import { MODE, PLAYBOOK_WORDS, STATUS, modesUpTo, monthBefore, monthWords, type Mode } from "@/lib/munim/investigation-words";
import { can } from "@/lib/munim/session";
import { watchFor } from "@/lib/munim/staff-app";
import { staffErrorText, staffWriteErrorText } from "@/lib/munim/staff-copy";
import { topic, type LiveState } from "@/lib/munim/staff-stream";
import type { Schemas } from "@/lib/munim/types";
import { uuidv7 } from "@/lib/munim/uuid";
import { SITE } from "@/lib/site";
import { useStaff } from "../shell";
import { StatusPill } from "../source";
import { ErrorNote, FullPage, OfflineBanner } from "../../ui";
import { LiveLine } from "./inbox";

type Item = Schemas["V1InvestigationsResponse"]["items"][number];

/** Investigations: for the roles that may read the finance figures they judge on. */
export function NotForInvestigations() {
  return (
    <FullPage title="Investigations are for the owner." action={<Link href="/staff" className="btn btn-primary">Go to my screen</Link>}>
      <p>They read the business&apos;s finance figures, which your role can&apos;t open.</p>
    </FullPage>
  );
}

/** The month pair in words: "September 2026 against August 2026". */
export const pairWords = (p: { period_month: string; compare_month: string }) => `${monthWords(p.period_month, SITE.locale)} against ${monthWords(p.compare_month, SITE.locale)}`;

function StartForm({ today, ceiling, onStarted }: { today: string; ceiling: Mode; onStarted: (id: string) => void }) {
  const { session, client, outlets, handleAuth } = useStaff();
  const me = session.me;
  const months = Array.from({ length: 6 }, (_, i) => monthBefore(today, i + 1));
  const [period, setPeriod] = useState(months[0]!);
  const [scope, setScope] = useState<string>(me.outlet_ids === "*" ? "*" : (outlets[0]?.id ?? ""));
  const [mode, setMode] = useState<Mode>(modesUpTo(ceiling).includes("plan") ? "plan" : "step");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One id per choice confirmed: the same choice again (a retry) sends the same id, which core replays.
  const attempt = useRef<{ key: string; id: string } | null>(null);
  const start = async () => {
    const key = JSON.stringify([period, scope, mode]);
    if (attempt.current?.key !== key) attempt.current = { key, id: uuidv7() };
    setBusy(true);
    setError(null);
    const r = await client.createInvestigation({
      investigation_id: attempt.current.id, playbook_id: "margin_fall", mode,
      params: { period_month: period, compare_month: monthBefore(period, 1) },
      ...(scope === "*" ? {} : { outlet_scope: [scope] }),
    });
    setBusy(false);
    if (r.ok) return onStarted(r.data.investigation_id);
    if (handleAuth(r.error)) return;
    setError(staffWriteErrorText(r.error, "investigations"));
  };
  return (
    <section aria-labelledby="start-title" className="card space-y-4 p-5">
      <h2 id="start-title" className="text-[24px]">Start an investigation</h2>
      <p className="text-muted">{PLAYBOOK_WORDS.margin_fall} Munim&apos;s specialists check each likely cause against the books, and every finding carries the rows it came from.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block font-semibold">
          Month to explain
          <select value={period} onChange={(e) => setPeriod(e.target.value)} disabled={busy}>
            {months.map((m) => <option key={m} value={m}>{monthWords(m, SITE.locale)} against {monthWords(monthBefore(m, 1), SITE.locale)}</option>)}
          </select>
        </label>
        <label className="block font-semibold">
          Outlets
          <select value={scope} onChange={(e) => setScope(e.target.value)} disabled={busy}>
            {me.outlet_ids === "*" && <option value="*">All outlets</option>}
            {outlets.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        </label>
      </div>
      <fieldset className="space-y-2">
        <legend className="font-semibold">How it runs</legend>
        <div className="grid gap-2 md:grid-cols-3">
          {modesUpTo(ceiling).map((m) => (
            <label key={m} className="choice items-start p-3">
              <input type="radio" name="mode" value={m} checked={mode === m} onChange={() => setMode(m)} disabled={busy} className="mt-1 size-5 flex-none" />
              <span><span className="block font-semibold">{MODE[m].name}</span><span className="block text-[15px] text-muted">{MODE[m].how}</span></span>
            </label>
          ))}
        </div>
      </fieldset>
      {error && <ErrorNote>{error}</ErrorNote>}
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void start()}>{busy ? "Starting…" : "Start the investigation"}</button>
    </section>
  );
}

export function InvestigationsPage() {
  const router = useRouter();
  const { session, client, outlet, outlets, handleAuth } = useStaff();
  const allowed = can(session, "investigations");
  const online = useOnline();
  const [items, setItems] = useState<Item[] | null>(null);
  const [error, setError] = useState<MunimError | null>(null);
  const [today, setToday] = useState<string | null>(null);
  const [ceiling, setCeiling] = useState<Mode | null>(null);
  const [live, setLive] = useState<LiveState>("connecting");

  const load = useCallback(async () => {
    const r = await client.listInvestigations();
    if (r.ok) {
      setItems(r.data.items);
      setError(null);
    } else if (!handleAuth(r.error)) setError(r.error);
  }, [client, handleAuth]);

  useEffect(() => {
    if (!allowed) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set after the response
    void load();
    void client.getAiPolicy().then((r) => r.ok && setCeiling(r.data.ceilings.find((c) => c.role === session.me.role)?.mode_ceiling ?? "step"));
    return watchFor(session, [topic.inbox(session.tenantId)], () => void load(), setLive);
  }, [allowed, client, load, session]);

  useEffect(() => {
    if (!allowed || !outlet) return;
    // "Today" is the outlet's business date, as the menu reports it (never the tablet's clock).
    void client.getMenu(outlet.id, "counter").then((r) => r.ok && setToday(r.data.business_date));
  }, [allowed, client, outlet]);

  if (!allowed) return <NotForInvestigations />;
  if (!outlet) return <main className="wrap staff-main"><div className="state-box" role="status">Loading</div></main>;
  const tz = outlet.tz;
  const scopeWords = (s: Item["outlet_scope"]) => ((s as string[])[0] === "*" ? "All outlets" : (s as string[]).map((id) => outlets.find((o) => o.id === id)?.name ?? "An outlet").join(", "));

  return (
    <>
      <OfflineBanner top="staff" show={!online} text="You're offline. Showing the last update." />
      <main className="wrap staff-main space-y-6 pb-10">
        <div>
          <h1 className="section-title">Investigations</h1>
          <p className="mt-3 max-w-[70ch] text-muted">A hard question, checked cause by cause against the books by Munim&apos;s specialists. Nothing here changes the books: an investigation only reads them.</p>
        </div>
        {today && ceiling ? <StartForm today={today} ceiling={ceiling} onStarted={(id) => router.push(`/staff/investigations/${id}`)} />
          : <div className="skeleton h-48" role="status" aria-label="Loading the form" />}
        <section aria-labelledby="list-title" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="list-title" className="section-title text-[28px]">Earlier investigations</h2>
            <LiveLine state={live} onRefresh={() => void load()} />
          </div>
          {error ? (
            <div className="space-y-2"><ErrorNote>{staffErrorText(error, "investigations")}</ErrorNote><button type="button" className="btn btn-plain" onClick={() => void load()}>Try again</button></div>
          ) : items === null ? <div className="skeleton h-32" role="status" aria-label="Loading" />
            : items.length === 0 ? <div className="state-box"><p>No investigations yet. Start one above.</p></div>
            : (
              <ul className="grid gap-3">
                {items.map((i) => (
                  <li key={i.investigation_id}>
                    <Link href={`/staff/investigations/${i.investigation_id}`} className="card card-link grid gap-2 p-4 text-ink no-underline">
                      <span className="flex flex-wrap items-center gap-2">
                        <StatusPill tone={STATUS[i.status].tone}>{STATUS[i.status].words}</StatusPill>
                        <span className="badge">{MODE[i.mode].name}</span>
                      </span>
                      <span className="text-[20px] font-semibold">{PLAYBOOK_WORDS[i.playbook_id]} {pairWords(i.params)}</span>
                      <span className="text-[15px] text-muted">
                        {scopeWords(i.outlet_scope)} · {i.steps_done === 0 ? "Not run yet" : "Run"} · started {formatWhen(i.created_at, tz, SITE.locale)}
                        {i.created_by === session.me.member_id ? " by you" : " by a teammate"}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
        </section>
      </main>
    </>
  );
}
