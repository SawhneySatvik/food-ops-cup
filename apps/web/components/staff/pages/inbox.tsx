// file: components/staff/pages/inbox.tsx
"use client";
// /staff/inbox: what waits for a person (GET /v1/inbox: open findings and proposed drafts, newest first) and what was
// decided (GET /v1/drafts?status=decided). A finding reads with its source chips and can be dismissed with a reason.
// A draft opens its own page, because the list does not say which of its numbers trace (20 §3.2). Live updates on
// inbox:<tenant> wake a refetch. Owners and managers only. Also exports the pieces owner home reuses.
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOnline } from "@/lib/hooks";
import type { MunimError } from "@/lib/munim/client";
import { attemptFor, retryable, type CommandAttempt } from "@/lib/munim/commands";
import { draftTitle, findingTitle, personName, sourceName, type Draft, type Decision } from "@/lib/munim/drafts";
import { formatWhen } from "@/lib/munim/format";
import { columnOf, formatCell, parseRef, outletNames, type CellFormat } from "@/lib/munim/refs";
import { can } from "@/lib/munim/session";
import { watchFor } from "@/lib/munim/staff-app";
import { abstainText, DRAFT_STATUS, REJECT_REASONS, specialistName, staffErrorText, staffWriteErrorText, VERDICT } from "@/lib/munim/staff-copy";
import { topic, type LiveState } from "@/lib/munim/staff-stream";
import { templateWords } from "@/lib/munim/template-words";
import type { Schemas } from "@/lib/munim/types";
import { SITE } from "@/lib/site";
import { useStaff } from "../shell";
import { AiSegment, CannotVerify, DRAFT_TONE, SnapshotDrawer, SourcedValue, StatusPill, type PillTone } from "../source";
import { ErrorNote, FullPage, OfflineBanner, Toast, useToast } from "../../ui";

type Finding = Schemas["V1Finding"];
type InboxItem = Schemas["V1InboxResponse"]["items"][number];
type ReasonCode = (typeof REJECT_REASONS)[number]["code"];
export type OpenRef = (snapshotId: string, refToken: string) => void;

const SEVERITY: Record<Finding["severity"], [string, PillTone]> = { low: ["Low", "done"], medium: ["Medium", "warn"], high: ["High", "late"], critical: ["Critical", "late"] };
const ALREADY_DISMISSED = "Someone already dismissed this. The inbox has been refreshed.";

/** Owner home, the inbox and a draft: the person's role cannot open this page. */
export function NotForRole() {
  return (
    <FullPage title="This page is for owners and managers." action={<Link href="/staff" className="btn btn-primary">Go to my screen</Link>}>
      <p>Your screens are in the menu above.</p>
    </FullPage>
  );
}

/** The line by a title when live updates are not running, with its Refresh button. */
export function LiveLine({ state, onRefresh }: { state: LiveState; onRefresh: () => void }) {
  if (state === "open" || state === "connecting") return null;
  return (
    <p className="flex flex-wrap items-center gap-2 text-[15px] text-muted" role="status">
      Live updates are off. Tap Refresh to update.
      <button type="button" className="btn btn-plain" onClick={onRefresh}>Refresh</button>
    </p>
  );
}

/** One open finding: what a specialist noticed, every number with its chip, and Dismiss with a reason code. */
export function FindingCard({ finding, fmt, tz, onOpen, onChanged }: { finding: Finding; fmt: CellFormat; tz: string; onOpen: OpenRef; onChanged: (toast: string) => void }) {
  const { session, client, handleAuth } = useStaff();
  const [asking, setAsking] = useState(false);
  const [code, setCode] = useState<ReasonCode | "">("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const attempt = useRef<CommandAttempt<"findings.dismiss.v1", Schemas["FindingsDismissV1"]> | null>(null);
  const e = finding.envelope;
  const impact = e.impact_ref ? finding.resolved_refs.find((r) => r.ref === e.impact_ref) : undefined;
  const impactRef = e.impact_ref ? parseRef(e.impact_ref) : null;
  const [sev, tone] = SEVERITY[finding.severity];
  const mayDismiss = session.me.role === "owner" || session.me.role === "manager" || session.me.role === "judge";

  const dismiss = async () => {
    if (!code || busy) return;
    const a = attemptFor(attempt.current, JSON.stringify([finding.finding_id, code]), "findings.dismiss.v1", () => ({ finding_id: finding.finding_id, reason_code: code }));
    attempt.current = a;
    setBusy(true);
    setNote(null);
    const r = await client.dismissFinding(finding.finding_id, a.body);
    setBusy(false);
    if (r.ok) {
      attempt.current = null;
      onChanged("Dismissed.");
      return;
    }
    if (handleAuth(r.error)) return;
    if (!retryable(r.error)) attempt.current = null;
    // 409 conflict (no reason code): the finding is no longer open. 404: it left this person's scope.
    if (r.error.code === "conflict" || r.error.kind === "not_found") onChanged(ALREADY_DISMISSED);
    else setNote(staffWriteErrorText(r.error, "inbox"));
  };

  return (
    <article id={`finding-${finding.finding_id}`} className="card space-y-3 p-5" aria-labelledby={`f-${finding.finding_id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="badge">Finding</span>
        <StatusPill tone={tone}>{sev}</StatusPill>
        <span className="text-[15px] text-muted">{specialistName(finding.pack)} · {formatWhen(finding.created_at, tz, SITE.locale)}</span>
      </div>
      <h3 id={`f-${finding.finding_id}`} className="text-[22px]">{findingTitle(finding.type)}</h3>
      {e.abstained ? (
        <p><CannotVerify /> {abstainText(e.reason_code)}</p>
      ) : (
        <>
          {e.segments.map((s, i) => <AiSegment key={i} segment={s} resolved={finding.resolved_refs} fmt={fmt} onOpen={onOpen} />)}
          <p className="font-semibold">
            Impact:{" "}
            {impact && impactRef ? <SourcedValue text={formatCell(impact.value, columnOf(impactRef), fmt)} refToken={impact.ref} onOpen={onOpen} /> : <CannotVerify />}
          </p>
        </>
      )}
      {mayDismiss && (asking ? (
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid gap-1 font-semibold">
            Why dismiss it?
            <select value={code} onChange={(ev) => setCode(ev.target.value as ReasonCode | "")} disabled={busy}>
              <option value="">Choose a reason</option>
              {REJECT_REASONS.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
            </select>
          </label>
          <button type="button" className="btn btn-primary" disabled={!code || busy} onClick={() => void dismiss()}>{busy ? "Saving…" : `Dismiss as ${session.me.name}`}</button>
          <button type="button" className="btn btn-plain" disabled={busy} onClick={() => setAsking(false)}>Keep it</button>
        </div>
      ) : (
        <button type="button" className="btn btn-plain" onClick={() => setAsking(true)}>Dismiss</button>
      ))}
      {note && <ErrorNote>{note}</ErrorNote>}
    </article>
  );
}

/** One draft in a list: what it proposes, who, its status and outlet, and the way into its page. */
export function DraftRow({ draft, decision, outletName, tz }: { draft: Draft; decision: Decision | null; outletName: (id: string) => string; tz: string }) {
  const where = draft.outlet_ids.length === 0 ? "Whole business" : draft.outlet_ids.map(outletName).join(", ");
  return (
    <article className="card flex flex-wrap items-center justify-between gap-3 p-5">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="badge">Proposal</span>
          <StatusPill tone={DRAFT_TONE[draft.status] ?? "new"}>{DRAFT_STATUS[draft.status] ?? draft.status}</StatusPill>
        </div>
        <h3 className="text-[22px]">{draftTitle(draft.command_type)}</h3>
        <p className="text-[15px] text-muted">
          {sourceName(draft.source)} · {where} · proposed {formatWhen(draft.created_at, tz, SITE.locale)}
          {decision && ` · ${VERDICT[decision.verdict]} by ${personName(decision.decided_by)}`}
        </p>
      </div>
      <Link href={`/staff/inbox/${draft.draft_id}`} className="btn btn-secondary">{draft.status === "proposed" ? "Review" : "Open"}</Link>
    </article>
  );
}

export function InboxPage() {
  const { session, client, outlets, handleAuth } = useStaff();
  const allowed = can(session, "inbox");
  const [tab, setTab] = useState<"waiting" | "decided">("waiting");
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [decided, setDecided] = useState<Schemas["V1DraftsResponse"] | null>(null);
  const [tenant, setTenant] = useState<Schemas["V1Tenant"] | null>(null);
  const [error, setError] = useState<MunimError | null>(null);
  const [live, setLive] = useState<LiveState>("connecting");
  const [drawer, setDrawer] = useState<{ snapshotId: string; refToken: string } | null>(null);
  const [toast, setToast] = useToast();
  const online = useOnline();

  const load = useCallback(async () => {
    const [i, d] = await Promise.all([client.listInbox(), client.listDrafts({ status: "decided" })]);
    if ((!i.ok && handleAuth(i.error)) || (!d.ok && handleAuth(d.error))) return;
    if (i.ok) {
      setItems(i.data.items);
      setCursor(i.data.next_cursor);
      setError(null);
    } else setError(i.error);
    if (d.ok) setDecided(d.data);
  }, [client, handleAuth]);

  const loadMore = async () => {
    if (!cursor) return;
    const r = await client.listInbox(cursor);
    if (r.ok) {
      setItems((prev) => [...(prev ?? []), ...r.data.items]);
      setCursor(r.data.next_cursor);
    } else if (!handleAuth(r.error)) setError(r.error);
  };

  useEffect(() => {
    if (!allowed) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set after the response
    void load();
    void client.getTenant().then((r) => r.ok && setTenant(r.data));
    // inbox:<tenant> is owner and manager only: this page never opens for anyone else.
    return watchFor(session, [topic.inbox(session.tenantId)], () => void load(), setLive);
  }, [allowed, client, load, session]);

  if (!allowed) return <NotForRole />;

  const tz = outlets[0]?.tz ?? tenant?.home_tz ?? "UTC";
  const fmt: CellFormat | null = tenant ? { locale: SITE.locale, currency: tenant.base_currency, outletNames: outletNames(outlets) } : null;
  const outletName = (id: string) => outlets.find((o) => o.id === id)?.name ?? "Another outlet";
  const changed = (msg: string) => {
    setToast(msg);
    void load();
  };
  const waiting = items?.length ?? 0;

  return (
    <>
      <OfflineBanner top="staff" show={!online} text="You're offline. Showing the last update." />
      <main className="wrap staff-main space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h1 className="section-title">Inbox</h1>
          <LiveLine state={live} onRefresh={() => void load()} />
        </div>
        <div className="flex gap-2" role="tablist" aria-label="Inbox">
          <button type="button" role="tab" aria-selected={tab === "waiting"} className="chip" aria-current={tab === "waiting" ? "page" : undefined} onClick={() => setTab("waiting")}>
            Waiting for you{items ? ` · ${waiting}${cursor ? "+" : ""}` : ""}
          </button>
          <button type="button" role="tab" aria-selected={tab === "decided"} className="chip" aria-current={tab === "decided" ? "page" : undefined} onClick={() => setTab("decided")}>
            Decided{decided ? ` · ${decided.items.length}${decided.has_more ? "+" : ""}` : ""}
          </button>
        </div>
        <p className="text-[15px] text-muted">Munim&apos;s AI proposes; nothing changes until a person approves it.</p>

        {error && items === null && (
          <div className="space-y-2">
            <ErrorNote>{staffErrorText(error, "inbox")}</ErrorNote>
            <button type="button" className="btn btn-plain" onClick={() => void load()}>Try again</button>
          </div>
        )}
        {(items === null || !fmt) && !error && <div className="grid gap-4" role="status" aria-label="Loading">{[0, 1, 2].map((k) => <div key={k} className="skeleton h-40" />)}</div>}

        {fmt && items && tab === "waiting" && (
          items.length === 0 ? (
            <div className="state-box"><p>Nothing waiting for you.</p></div>
          ) : (
            <div className="grid gap-4">
              {items.map((it) => it.kind === "finding"
                ? <FindingCard key={it.finding.finding_id} finding={it.finding} fmt={fmt} tz={tz} onOpen={(s, r) => setDrawer({ snapshotId: s, refToken: r })} onChanged={changed} />
                : <DraftRow key={it.draft.draft_id} draft={it.draft} decision={null} outletName={outletName} tz={tz} />)}
              {cursor && <button type="button" className="btn btn-plain justify-self-center" onClick={() => void loadMore()}>Show more</button>}
            </div>
          )
        )}
        {fmt && decided && tab === "decided" && (
          decided.items.length === 0 ? (
            <div className="state-box"><p>Nothing decided yet.</p></div>
          ) : (
            <div className="grid gap-4">
              {decided.items.map((d) => <DraftRow key={d.draft.draft_id} draft={d.draft} decision={d.decision} outletName={outletName} tz={tz} />)}
            </div>
          )
        )}

        {fmt && <SnapshotDrawer client={client} open={drawer} onClose={() => setDrawer(null)} fmt={fmt} tz={tz} label={templateWords} />}
        <Toast message={toast} />
      </main>
    </>
  );
}
