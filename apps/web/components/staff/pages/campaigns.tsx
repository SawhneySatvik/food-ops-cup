// file: components/staff/pages/campaigns.tsx
"use client";
// /staff/campaigns (T-128, R67): messages to customers. A campaign exists only once a person approves the Customers desk's
// proposal (it waits in the inbox first); Munim never sends one. Each shows its fixed message, how it would go, the planned
// day and its audience — the cell of the segment snapshot the proposal cited, with its chip, never a count this screen made.
// A queued one can be cancelled; on the demo business the owner can record it as sent (simulated), and the screen says
// plainly that nothing left Munim. Owners and managers of every outlet act; others read.
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { CAMPAIGN_STATUS, CHANNEL, NO_SEND, RECORD_SENT, messageWords } from "@/lib/munim/campaign-words";
import type { MunimError } from "@/lib/munim/client";
import { envelope } from "@/lib/munim/commands";
import { draftTitle } from "@/lib/munim/drafts";
import { dayLabel, formatWhen } from "@/lib/munim/format";
import { formatCell, snapRef, outletNames, type CellFormat, type Snapshot } from "@/lib/munim/refs";
import { can } from "@/lib/munim/session";
import { staffErrorText, staffWriteErrorText } from "@/lib/munim/staff-copy";
import { templateWords } from "@/lib/munim/template-words";
import type { Schemas } from "@/lib/munim/types";
import { SITE } from "@/lib/site";
import { useStaff } from "../shell";
import { CannotVerify, SnapshotDrawer, SourcedValue, StatusPill } from "../source";
import { ErrorNote, Toast, useToast } from "../../ui";
import { NotForRole, type OpenRef } from "./inbox";

type Campaign = Schemas["V1Campaign"];

/** The audience: the Σ row's at_risk_count of the churn segment the campaign names (R67), from the snapshot itself. */
function Audience({ snap, fmt, onOpen, mine }: { snap: Snapshot | "failed" | undefined; fmt: CellFormat; onOpen: OpenRef; mine: boolean }) {
  if (!mine) return <CannotVerify why="Its customers are at outlets beyond yours." />;
  if (snap === undefined) return <span className="skeleton inline-block h-6 w-16 align-middle" aria-hidden="true" />;
  if (snap === "failed" || snap.template_id !== "customers.churn_segments") return <CannotVerify why="The group's rows can't be opened." />;
  const row = snap.rows.findIndex((r) => r.customer_id === null);
  const value = row >= 0 ? snap.rows[row]!.at_risk_count : undefined;
  if (value === undefined || value === null) return <CannotVerify />;
  return <SourcedValue text={formatCell(value, "at_risk_count", fmt)} refToken={snapRef(snap.snapshot_id, row, "at_risk_count")} onOpen={onOpen} />;
}

export function CampaignsPage() {
  const { session, client, outlet, outlets, handleAuth } = useStaff();
  const me = session.me;
  const allowed = can(session, "campaigns");
  const everyOutlet = me.outlet_ids === "*";
  const mayCancel = everyOutlet && ["owner", "manager", "judge"].includes(me.role);
  const mayRecord = everyOutlet && ["owner", "judge"].includes(me.role);
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [proposals, setProposals] = useState<Schemas["V1DraftsResponse"]["items"]>([]);
  const [snaps, setSnaps] = useState<Record<string, Snapshot | "failed">>({});
  const [tenant, setTenant] = useState<Schemas["V1Tenant"] | null>(null);
  const [error, setError] = useState<MunimError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actError, setActError] = useState<{ id: string; text: string } | null>(null);
  const [drawer, setDrawer] = useState<{ snapshotId: string; refToken: string } | null>(null);
  const [toast, say] = useToast();

  const load = useCallback(async () => {
    const [c, d] = await Promise.all([client.listCampaigns(), client.listDrafts({ status: "proposed" })]);
    if (!c.ok) {
      if (!handleAuth(c.error)) setError(c.error);
      return;
    }
    setError(null);
    setCampaigns(c.data.campaigns);
    if (d.ok) setProposals(d.data.items.filter((x) => x.draft.command_type === "customers.campaign.create.v1"));
    // A segment opens only for someone whose outlets cover it (core: 404): don't ask for one this person cannot open.
    const mine = (x: Campaign) => me.outlet_ids === "*" || (x.outlet_ids.length > 0 && x.outlet_ids.every((o) => (me.outlet_ids as string[]).includes(o)));
    const ids = [...new Set(c.data.campaigns.filter(mine).map((x) => x.segment_snapshot_id))];
    const opened = await Promise.all(ids.map((id) => client.getSnapshot(id)));
    setSnaps(Object.fromEntries(ids.map((id, i) => [id, opened[i]!.ok ? (opened[i] as { data: Snapshot }).data : "failed"])));
  }, [client, handleAuth, me.outlet_ids]);

  useEffect(() => {
    if (!allowed) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on mount; state is set after the response
    void load();
    void client.getTenant().then((r) => r.ok && setTenant(r.data));
  }, [allowed, client, load]);

  const act = async (c: Campaign, verb: "cancel" | "sent") => {
    setBusy(`${verb}:${c.campaign_id}`);
    setActError(null);
    const r = verb === "cancel" ? await client.cancelCampaign(envelope("customers.campaign.cancel.v1", { campaign_id: c.campaign_id }))
      : await client.recordCampaignSent(envelope("customers.campaign.record_sent.v1", { campaign_id: c.campaign_id }));
    setBusy(null);
    if (r.ok) {
      say(verb === "cancel" ? "Cancelled. Nothing was sent." : "Recorded as sent (simulated). No message left Munim.");
      return void load();
    }
    if (handleAuth(r.error)) return;
    setActError({ id: c.campaign_id, text: staffWriteErrorText(r.error, "campaigns") });
    void load();
  };

  if (!allowed) return <NotForRole />;
  if (!outlet) return <main className="wrap staff-main"><div className="state-box" role="status">Loading</div></main>;
  const tz = outlet.tz;
  const fmt: CellFormat | null = tenant ? { locale: SITE.locale, currency: tenant.base_currency, outletNames: outletNames(outlets) } : null;
  const open: OpenRef = (snapshotId, refToken) => setDrawer({ snapshotId, refToken });
  const outletWords = (ids: string[]) => (ids.length === 0 ? "Whole business" : ids.map((o) => outlets.find((x) => x.id === o)?.name ?? "An outlet").join(", "));

  return (
    <main className="wrap staff-main space-y-6 pb-10">
      <div>
        <h1 className="section-title">Campaigns</h1>
        <p className="mt-3 max-w-[70ch] text-muted">Messages to your customers. The Customers desk proposes one when regulars stop coming; a person approves it first. {NO_SEND}</p>
      </div>
      {error && <div className="space-y-2"><ErrorNote>{staffErrorText(error, "campaigns")}</ErrorNote><button type="button" className="btn btn-plain" onClick={() => void load()}>Try again</button></div>}

      {proposals.length > 0 && (
        <section aria-labelledby="waiting-title" className="space-y-3">
          <h2 id="waiting-title" className="section-title text-[28px]">Waiting for approval</h2>
          <ul className="grid gap-3">
            {proposals.map(({ draft }) => (
              <li key={draft.draft_id}>
                <Link href={`/staff/inbox/${draft.draft_id}`} className="card card-link grid gap-1 p-4 text-ink no-underline">
                  <span className="badge justify-self-start">Proposal · waiting for you</span>
                  <span className="text-[19px] font-semibold">{draftTitle(draft.command_type)}</span>
                  <span className="text-[15px] text-muted">From the Customers desk · {outletWords(draft.outlet_ids)} · {formatWhen(draft.created_at, tz, SITE.locale)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section aria-labelledby="list-title" className="space-y-3">
        <h2 id="list-title" className="section-title text-[28px]">Approved campaigns</h2>
        {campaigns === null || !fmt ? <div className="skeleton h-32" role="status" aria-label="Loading" />
          : campaigns.length === 0 ? <div className="state-box"><p>No campaigns yet. When the Customers desk proposes one, it waits in your inbox.</p></div>
          : (
            <ul className="grid gap-3">
              {campaigns.map((c) => {
                const s = CAMPAIGN_STATUS[c.status];
                return (
                  <li key={c.campaign_id} className="card space-y-3 p-5">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusPill tone={s.tone}>{s.words}</StatusPill>
                      <span className="text-[15px] text-muted">{outletWords(c.outlet_ids)} · approved {formatWhen(c.created_at, tz, SITE.locale)}</span>
                    </div>
                    <h3 className="text-[22px]">{c.name}</h3>
                    <blockquote className="rounded-[14px] border-[1.5px] border-bg-deep bg-bg p-3 text-[17px]">{messageWords(c.message_key)}</blockquote>
                    <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-3">
                      <div><dt className="text-[14px] text-muted">By</dt><dd className="font-semibold">{CHANNEL[c.channel]}</dd></div>
                      <div><dt className="text-[14px] text-muted">Planned for</dt><dd className="font-semibold">{dayLabel(c.send_at, tz, SITE.locale)}</dd></div>
                      <div><dt className="text-[14px] text-muted">Customers it would reach</dt><dd><Audience snap={snaps[c.segment_snapshot_id]} fmt={fmt} onOpen={open} mine={me.outlet_ids === "*" || (c.outlet_ids.length > 0 && c.outlet_ids.every((o) => (me.outlet_ids as string[]).includes(o)))} /></dd></div>
                    </dl>
                    <p className="badge badge-sim h-auto whitespace-normal py-1">{NO_SEND}</p>
                    {c.status === "queued" && (
                      <div className="space-y-2">
                        {actError?.id === c.campaign_id && <ErrorNote>{actError.text}</ErrorNote>}
                        <div className="flex flex-wrap gap-3">
                          {mayRecord && tenant?.is_demo && (
                            <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => void act(c, "sent")}>{busy === `sent:${c.campaign_id}` ? "Recording…" : `Record as sent (simulated) as ${me.name}`}</button>
                          )}
                          {mayCancel && <button type="button" className="btn btn-plain text-danger" disabled={busy !== null} onClick={() => void act(c, "cancel")}>{busy === `cancel:${c.campaign_id}` ? "Cancelling…" : `Cancel as ${me.name}`}</button>}
                        </div>
                        {mayRecord && tenant?.is_demo && <p className="text-[14px] text-muted">{RECORD_SENT}</p>}
                        {!mayCancel && <p className="text-[14px] text-muted">The owner, or a manager of every outlet, can cancel it.</p>}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
      </section>
      {fmt && <SnapshotDrawer client={client} open={drawer} onClose={() => setDrawer(null)} fmt={fmt} tz={tz} label={templateWords} />}
      <Toast message={toast} />
    </main>
  );
}
