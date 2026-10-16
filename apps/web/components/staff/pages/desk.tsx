// file: components/staff/pages/desk.tsx
"use client";
// /staff/office/[desk] (T-128): one specialist's desk (GET /v1/specialists/{id}): what it owns, its open findings with their
// source chips, the proposals it has waiting, its track record and the conversations addressed to it. The track record's
// counts are cells of the snapshot core minted for this viewer, opened here and shown with their chips — never a number this
// screen counted. "Ask {desk}" opens Ask Munim with the desk's @name filled in. Owners and managers.
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { MunimError } from "@/lib/munim/client";
import { draftTitle } from "@/lib/munim/drafts";
import { formatWhen } from "@/lib/munim/format";
import { DESKS, DESK_BLURB, type Desk } from "@/lib/munim/office";
import { formatCell, outletNames, type CellFormat, type Snapshot } from "@/lib/munim/refs";
import { can } from "@/lib/munim/session";
import { specialistName, staffErrorText } from "@/lib/munim/staff-copy";
import { templateWords } from "@/lib/munim/template-words";
import type { Schemas } from "@/lib/munim/types";
import { SITE } from "@/lib/site";
import { useStaff } from "../shell";
import { DeskArt } from "../office-art";
import { CannotVerify, SnapshotDrawer, SourcedValue } from "../source";
import { ErrorNote, FullPage, Toast, useToast } from "../../ui";
import { FindingCard, NotForRole, type OpenRef } from "./inbox";

type DeskView = Schemas["V1SpecialistDesk"];
const RECORD: Array<[keyof NonNullable<NonNullable<DeskView["track_record"]>["cells"]>, string]> = [
  ["proposed", "Proposed"], ["approved", "Approved as proposed"], ["edited", "Approved with edits"], ["rejected", "Rejected"], ["stale", "Went out of date"], ["abstained", "Couldn't answer from the books"],
];

export function DeskPage() {
  const { desk } = useParams<{ desk: string }>();
  const { session, client, outlet, outlets, handleAuth } = useStaff();
  const allowed = can(session, "office");
  const known = (DESKS as readonly string[]).includes(desk);
  const [view, setView] = useState<DeskView | "not_found" | null>(null);
  const [record, setRecord] = useState<Snapshot | "failed" | null>(null);
  const [tenant, setTenant] = useState<Schemas["V1Tenant"] | null>(null);
  const [error, setError] = useState<MunimError | null>(null);
  const [drawer, setDrawer] = useState<{ snapshotId: string; refToken: string } | null>(null);
  const [toast, setToast] = useToast();

  const load = useCallback(async () => {
    if (!known) return;
    const r = await client.getSpecialistDesk(desk);
    if (!r.ok) {
      if (r.error.kind === "not_found") setView("not_found");
      else if (!handleAuth(r.error)) setError(r.error);
      return;
    }
    setView(r.data);
    setError(null);
    const t = r.data.track_record;
    if (t?.cells) {
      const s = await client.getSnapshot(t.snapshot_id);
      setRecord(s.ok ? s.data : "failed");
    } else setRecord(null);
  }, [client, desk, known, handleAuth]);

  useEffect(() => {
    if (!allowed) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set after the response
    void load();
    void client.getTenant().then((r) => r.ok && setTenant(r.data));
  }, [allowed, client, load]);

  if (!allowed) return <NotForRole />;
  if (!known || view === "not_found") return <FullPage title="There is no such desk." action={<Link href="/staff/office" className="btn btn-primary">Back to the office</Link>} />;
  if (error && !view) return <main className="wrap staff-main space-y-3"><ErrorNote>{staffErrorText(error, "office")}</ErrorNote><button type="button" className="btn btn-plain" onClick={() => void load()}>Try again</button></main>;
  if (!view || !tenant || !outlet) return <main className="wrap staff-main"><div className="state-box" role="status">Loading</div></main>;

  const d = desk as Desk;
  const tz = outlet.tz;
  const fmt: CellFormat = { locale: SITE.locale, currency: tenant.base_currency, outletNames: outletNames(outlets) };
  const open: OpenRef = (snapshotId, refToken) => setDrawer({ snapshotId, refToken });
  const cells = view.track_record?.cells ?? null;
  const name = specialistName(d);

  return (
    <main className="wrap staff-main space-y-6 pb-10">
      <Link href="/staff/office" className="inline-flex min-h-12 items-center font-semibold">← The office</Link>
      <header className="grid items-center gap-4 sm:grid-cols-[160px_1fr]">
        <div className="card p-2"><DeskArt desk={d} active={view.findings.length > 0 || view.drafts.length > 0} /></div>
        <div className="space-y-2">
          <h1 className="section-title">{d === "manager" ? "The Manager" : `${name} desk`}</h1>
          <p className="text-[18px]">{DESK_BLURB[d]}</p>
          <Link href={d === "manager" ? "/staff/ask" : `/staff/ask?to=${d}`} className="btn btn-secondary">Ask {name}</Link>
        </div>
      </header>
      {!view.applicable && <p className="card p-4">This desk&apos;s work is switched off for your outlets, so it has nothing here.</p>}

      {d !== "manager" && (
        <section aria-labelledby="record-title" className="card space-y-3 p-5">
          <h2 id="record-title" className="text-[24px]">Track record</h2>
          {view.track_record === null ? <p className="text-muted">Shown to owners and managers.</p>
            : cells === null ? <p className="text-muted">No proposals from this desk yet.</p>
            : record === null ? <div className="skeleton h-16" role="status" aria-label="Loading the track record" />
            : record === "failed" ? <CannotVerify why="The track record's rows can't be opened." />
            : (
              <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {RECORD.map(([key, words]) => {
                  const ref = cells[key];
                  const value = record.rows[0]?.[key];
                  return (
                    <li key={key} className="flex flex-wrap items-center justify-between gap-2 border-b-[1.5px] border-bg-deep py-2">
                      <span>{words}</span>
                      {value === undefined ? <CannotVerify /> : <SourcedValue text={formatCell(value, key, fmt)} refToken={ref} onOpen={open} />}
                    </li>
                  );
                })}
              </ul>
            )}
        </section>
      )}

      <section aria-labelledby="findings-title" className="space-y-3">
        <h2 id="findings-title" className="section-title text-[28px]">What it noticed</h2>
        {view.findings.length === 0 ? <div className="state-box"><p>Nothing open at this desk.</p></div>
          : <ul className="grid gap-3">{view.findings.map((f) => <li key={f.finding_id}><FindingCard finding={f} fmt={fmt} tz={tz} onOpen={open} onChanged={(t) => { setToast(t); void load(); }} /></li>)}</ul>}
      </section>

      <section aria-labelledby="drafts-title" className="space-y-3">
        <h2 id="drafts-title" className="section-title text-[28px]">Waiting for you</h2>
        {view.drafts.length === 0 ? <div className="state-box"><p>No proposals from this desk are waiting.</p></div>
          : (
            <ul className="grid gap-3">
              {view.drafts.map((x) => (
                <li key={x.draft_id}>
                  <Link href={`/staff/inbox/${x.draft_id}`} className="card card-link grid gap-1 p-4 text-ink no-underline">
                    <span className="badge justify-self-start">Proposal · waiting for you</span>
                    <span className="text-[19px] font-semibold">{draftTitle(x.command_type)}</span>
                    <span className="text-[15px] text-muted">Proposed {formatWhen(x.created_at, tz, SITE.locale)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
      </section>

      <section aria-labelledby="threads-title" className="space-y-3">
        <h2 id="threads-title" className="section-title text-[28px]">Conversations</h2>
        {view.threads.length === 0 ? <div className="state-box"><p>Nobody has asked this desk anything yet.</p></div>
          : (
            <ul className="grid gap-2">
              {view.threads.map((t) => (
                <li key={t.thread_id}><Link href={`/staff/ask/${t.thread_id}`} className="card card-link flex min-h-12 items-center justify-between gap-2 p-4 text-ink no-underline"><span className="font-semibold">A conversation</span><span className="text-[15px] text-muted">{formatWhen(t.last_activity_at, tz, SITE.locale)}</span></Link></li>
              ))}
            </ul>
          )}
      </section>
      <SnapshotDrawer client={client} open={drawer} onClose={() => setDrawer(null)} fmt={fmt} tz={tz} label={templateWords} />
      <Toast message={toast} />
    </main>
  );
}
