// file: components/staff/pages/investigation.tsx
"use client";
// /staff/investigations/[id] (T-128): one investigation. The checklist — each likely cause, the specialist who owns it, its
// verdict and the cells it read (source chips) — then the plan to approve (Plan and Auto), then each step's write-up signed
// item by item. Verdicts are core's, judged in code from snapshots; the write-up's every number is a cell or "Cannot verify".
// Only the person who started it approves its plan or cancels it (core refuses anyone else); anyone who can see it may run the
// next step. Approving a plan runs its steps inside that one request, so the wait is long. Live updates on inbox:<tenant>.
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useOnline } from "@/lib/hooks";
import type { MunimError } from "@/lib/munim/client";
import { formatWhen } from "@/lib/munim/format";
import { ITEM_STATUS, MODE, PLAYBOOK_WORDS, STATUS, STOP_REASON, TRIGGERED, isTerminal, itemWords, modesUpTo, type Mode } from "@/lib/munim/investigation-words";
import { formatCell, parseRef, outletNames, type CellFormat } from "@/lib/munim/refs";
import { can } from "@/lib/munim/session";
import { watchFor } from "@/lib/munim/staff-app";
import { specialistName, staffErrorText, staffWriteErrorText } from "@/lib/munim/staff-copy";
import { topic, type LiveState } from "@/lib/munim/staff-stream";
import { templateWords } from "@/lib/munim/template-words";
import type { Schemas } from "@/lib/munim/types";
import { SITE, UUID7 } from "@/lib/site";
import { useStaff } from "../shell";
import { AiSegment, CannotVerify, SnapshotDrawer, SourcedValue, StatusPill } from "../source";
import { ErrorNote, FullPage, OfflineBanner } from "../../ui";
import { LiveLine, type OpenRef } from "./inbox";
import { NotForInvestigations, pairWords } from "./investigations";

type View = Schemas["V1Investigation"];

/** What each cell is, by its column (the margin bridge's rows, a close-status row). */
const CELL_LABEL: Record<string, string> = { delta_minor: "Change", share_bp: "Share of the whole change", open_count: "Still missing" };

/** The cells an item's verdict read, each as its value with a chip (or "Cannot verify" for one this person cannot open). */
function Cells({ refs, view, fmt, onOpen }: { refs: readonly string[]; view: View; fmt: CellFormat; onOpen: OpenRef }) {
  if (refs.length === 0) return null;
  return (
    <span className="flex flex-wrap items-center gap-x-1 gap-y-2">
      {refs.map((r) => {
        const hit = view.resolved_refs.find((x) => x.ref === r);
        const p = parseRef(r);
        const label = p?.kind === "snap" ? CELL_LABEL[p.column] : undefined;
        return (
          <span key={r} className="inline-flex items-center gap-1 pr-2 text-[15px]">
            {label && <span className="text-muted">{label}</span>}
            {hit && p?.kind === "snap" ? <SourcedValue text={formatCell(hit.value, p.column, fmt)} refToken={r} onOpen={onOpen} /> : <CannotVerify />}
          </span>
        );
      })}
    </span>
  );
}

export function InvestigationPage() {
  const { id } = useParams<{ id: string }>();
  const { session, client, outlet, outlets, handleAuth } = useStaff();
  const me = session.me;
  const allowed = can(session, "investigations");
  const online = useOnline();
  const [view, setView] = useState<View | "not_found" | null>(null);
  const [loadError, setLoadError] = useState<MunimError | null>(null);
  const [tenant, setTenant] = useState<Schemas["V1Tenant"] | null>(null);
  const [ceiling, setCeiling] = useState<Mode>("step");
  const [busy, setBusy] = useState<"plan" | "auto" | "step" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<LiveState>("connecting");
  const [drawer, setDrawer] = useState<{ snapshotId: string; refToken: string } | null>(null);
  const valid = UUID7.test(id);

  const load = useCallback(async () => {
    if (!valid) return;
    const r = await client.getInvestigation(id);
    if (r.ok) {
      setView(r.data);
      setLoadError(null);
    } else if (r.error.kind === "not_found") setView("not_found");
    else if (!handleAuth(r.error)) setLoadError(r.error);
  }, [client, id, valid, handleAuth]);

  useEffect(() => {
    if (!allowed || !valid) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set after the response
    void load();
    void client.getTenant().then((r) => r.ok && setTenant(r.data));
    void client.getAiPolicy().then((r) => r.ok && setCeiling(r.data.ceilings.find((c) => c.role === me.role)?.mode_ceiling ?? "step"));
    return watchFor(session, [topic.inbox(session.tenantId)], () => void load(), setLive);
  }, [allowed, valid, client, load, session, me.role]);

  const act = async (which: "plan" | "auto" | "step" | "cancel") => {
    if (!view || view === "not_found" || busy) return;
    setBusy(which);
    setError(null);
    const r = which === "cancel" ? await client.cancelInvestigation(view.investigation_id)
      : which === "step" ? await client.continueInvestigation(view.investigation_id, view.steps_done + 1)
      : await client.approvePlan(view.investigation_id, which);
    setBusy(null);
    if (r.ok) return setView(r.data);
    if (handleAuth(r.error)) return;
    setError(staffWriteErrorText(r.error, "investigations"));
    void load();
  };

  if (!allowed) return <NotForInvestigations />;
  if (!valid || view === "not_found") {
    return <FullPage title="We couldn't find that investigation." action={<Link href="/staff/investigations" className="btn btn-primary">All investigations</Link>}><p>It may be outside the outlets you can see.</p></FullPage>;
  }
  if (loadError && !view) {
    return <main className="wrap staff-main space-y-3"><ErrorNote>{staffErrorText(loadError, "investigations")}</ErrorNote><button type="button" className="btn btn-plain" onClick={() => void load()}>Try again</button></main>;
  }
  if (!view || !tenant || !outlet) return <main className="wrap staff-main"><div className="state-box" role="status">Loading</div></main>;

  const tz = outlet.tz;
  const fmt: CellFormat = { locale: SITE.locale, currency: tenant.base_currency, outletNames: outletNames(outlets) };
  const open: OpenRef = (snapshotId, refToken) => setDrawer({ snapshotId, refToken });
  const mine = view.created_by === me.member_id;
  const restricted = view.status === "restricted";
  const done = isTerminal(view.status);
  const planOpen = view.plan !== null && view.plan.approved_by === null && !done && !restricted;
  const canStep = !done && !restricted && (view.mode === "step" || view.plan?.approved_by !== null);
  const scopeWords = (view.outlet_scope as string[])[0] === "*" ? "All outlets" : (view.outlet_scope as string[]).map((o) => outlets.find((x) => x.id === o)?.name ?? "An outlet").join(", ");
  const estimate = view.plan?.estimate;
  const estimateHit = estimate?.estimate_ref ? view.resolved_refs.find((r) => r.ref === estimate.estimate_ref) : undefined;

  return (
    <>
      <OfflineBanner top="staff" show={!online} text="You're offline. Showing the last update." />
      <main className="wrap staff-main space-y-6 pb-10">
        <Link href="/staff/investigations" className="inline-flex min-h-12 items-center font-semibold">← All investigations</Link>
        <header className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone={STATUS[view.status].tone}>{STATUS[view.status].words}</StatusPill>
            <span className="badge">{MODE[view.mode].name}</span>
            <LiveLine state={live} onRefresh={() => void load()} />
          </div>
          <h1 className="section-title">{PLAYBOOK_WORDS[view.playbook_id]}</h1>
          <p className="text-[18px]">{pairWords(view.params)} · {scopeWords}</p>
          <p className="text-[15px] text-muted">Started {formatWhen(view.created_at, tz, SITE.locale)} {mine ? "by you" : "by a teammate"}. It only reads the books; nothing here changes them.</p>
          {restricted && <p className="card p-4">This investigation reads the business&apos;s finance figures, which your role can&apos;t open, so its findings aren&apos;t shown to you.</p>}
          {view.stop_reason && STOP_REASON[view.stop_reason] && <p className="note-warn font-semibold" role="status">{STOP_REASON[view.stop_reason]}</p>}
        </header>

        {planOpen && view.plan && (
          <section aria-labelledby="plan-title" className="card space-y-4 p-5">
            <h2 id="plan-title" className="text-[24px]">The plan</h2>
            <p>Munim will check each of these against the books, then write up what it found. Every step runs once you approve.</p>
            <ol className="list-decimal space-y-1 pl-6">
              {view.plan.items.map((i) => <li key={i.item_id}>{itemWords(i.label_key)} <span className="text-muted">· {specialistName(i.specialist)}</span></li>)}
            </ol>
            <p><span className="font-semibold">Specialists involved:</span> {view.plan.specialists.map((s) => specialistName(s)).join(", ")}</p>
            <p className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">What it may cost in AI:</span>
              {estimate?.status === "computed" && estimate.estimate_ref && estimateHit
                ? <><SourcedValue text={formatCell(estimateHit.value, "estimate_minor", fmt)} refToken={estimate.estimate_ref} onOpen={open} /> <span className="text-muted">({estimate.label})</span></>
                : <CannotVerify why="No earlier step has recorded what it cost yet." />}
            </p>
            {mine ? (
              <div className="flex flex-wrap gap-3">
                <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => void act("plan")}>{busy === "plan" ? "Running the plan…" : `Approve plan as ${me.name}`}</button>
                {modesUpTo(ceiling).includes("auto") && (
                  <button type="button" className="btn btn-secondary" disabled={busy !== null} onClick={() => void act("auto")}>{busy === "auto" ? "Running the plan…" : `Approve and let it run on its own as ${me.name}`}</button>
                )}
              </div>
            ) : <p className="text-muted">Only the person who started it can approve its plan.</p>}
            {(busy === "plan" || busy === "auto") && <p className="text-muted" role="status">Each step reads the books and is written up. This can take a few minutes; keep this page open.</p>}
          </section>
        )}

        <section aria-labelledby="checks-title" className="space-y-3">
          <h2 id="checks-title" className="section-title text-[28px]">What was checked</h2>
          <ul className="grid gap-3">
            {view.checklist.map((c) => (
              <li key={c.item_id} className="card space-y-2 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[19px] font-semibold">{itemWords(c.label_key)}</p>
                  <StatusPill tone={ITEM_STATUS[c.status].tone}>{ITEM_STATUS[c.status].words}</StatusPill>
                </div>
                <p className="text-[15px] text-muted">Checked by {specialistName(c.signature.specialist)}{c.frozen ? " · settled" : ""}</p>
                <Cells refs={c.refs} view={view} fmt={fmt} onOpen={open} />
              </li>
            ))}
          </ul>
        </section>

        {view.steps.length > 0 && (
          <section aria-labelledby="steps-title" className="space-y-3">
            <h2 id="steps-title" className="section-title text-[28px]">What each step found</h2>
            {view.steps.map((s) => (
              <article key={s.step_no} className="card space-y-3 p-4">
                <p className="font-semibold">Step {s.step_no} · {TRIGGERED[s.triggered_by]} · {formatWhen(s.started_at, tz, SITE.locale)}</p>
                {s.narration ? s.narration.envelope.segments.map((seg, i) => (
                  <div key={i} className="space-y-1 border-t-[1.5px] border-bg-deep pt-2 first:border-t-0 first:pt-0">
                    <p className="text-[14px] font-bold text-muted">{specialistName(s.narration!.signatures[i]?.specialist)}</p>
                    <AiSegment segment={seg} resolved={view.resolved_refs} fmt={fmt} onOpen={open} />
                  </div>
                )) : <p className="text-muted">{restricted ? "Not shown at your role." : "This step has no write-up yet."}</p>}
              </article>
            ))}
          </section>
        )}

        {!restricted && (
          <div className="space-y-3">
            {error && <ErrorNote>{error}</ErrorNote>}
            <div className="flex flex-wrap gap-3">
              {canStep && <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => void act("step")}>{busy === "step" ? "Running the step…" : `Run step ${view.steps_done + 1}`}</button>}
              {!done && mine && <button type="button" className="btn btn-plain text-danger" disabled={busy !== null} onClick={() => void act("cancel")}>{busy === "cancel" ? "Cancelling…" : "Cancel investigation"}</button>}
            </div>
            {done && view.status === "done" && <p className="text-muted">Done: the causes marked &quot;Explains it&quot; account for the change. Open any number to see its rows.</p>}
          </div>
        )}
        <SnapshotDrawer client={client} open={drawer} onClose={() => setDrawer(null)} fmt={fmt} tz={tz} label={templateWords} />
      </main>
    </>
  );
}
