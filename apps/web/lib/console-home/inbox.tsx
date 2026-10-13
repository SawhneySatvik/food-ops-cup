"use client";
// C1 home panels (screens/console-home-inbox-ask.md): the morning brief and the inbox. The inbox renders the list the
// console context holds (the same list the chrome badge counts, refreshed by the inbox:<tenant> stream), so badge and
// list cannot disagree (R40 C3). Finding text renders only through RefText; impact chips are the finding's impact_ref.
// Order is core's: /v1/inbox and /v1/findings come newest first (no client re-ranking — no money arithmetic here).
import { Badge, IconAlert, IconInfo, RefText, StateEmpty, StateError, StateLoading, createFormatter } from "@munim/ui";
import type { Schemas } from "@munim/sdk";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api.ts";
import { useConsole, type InboxItem, type Outlet } from "../console/context.tsx";
import { t } from "../i18n/index.ts";
import { draftTypeLabel, proposedBy, severityLabel, specialistName } from "./labels.ts";
import { RefValue } from "./ref-value.tsx";

type Finding = Schemas["V1Finding"];
type Draft = Schemas["V1Draft"];

/** Severity as text + shape (▲ for high/critical, ● otherwise) — never colour alone. */
export function SeverityMark({ severity }: { severity: string }) {
  const high = severity === "high" || severity === "critical";
  return (
    <span className="ch-severity" data-severity={severity}>
      <Badge tone={high ? "warning" : "neutral"} icon={high ? <IconAlert size={14} /> : <IconInfo size={14} />}>{severityLabel(severity)}</Badge>
    </span>
  );
}

export function outletSubject(ids: readonly string[], outlets: readonly Outlet[]): string {
  if (ids.length === 0) return t("console.draft.all_outlets");
  return ids.map((id) => outlets.find((o) => o.id === id)?.name).filter(Boolean).join(", ");
}

/** The impact chip of a finding: its impact_ref cell, as core resolved it for this viewer. */
function Impact({ finding }: { finding: Finding }) {
  const c = useConsole();
  const ref = finding.envelope.impact_ref;
  if (!ref) return null;
  return (
    <span className="ch-impact">
      <span className="ch-meta">{t("console.inbox.impact")}</span>
      <RefValue token={ref} resolved={finding.resolved_refs} format={c.format} />
    </span>
  );
}

function FindingRow({ finding, draftId }: { finding: Finding; draftId: string | null }) {
  const c = useConsole();
  return (
    <li className="ch-item" data-kind="finding" data-finding={finding.finding_id}>
      <div className="ch-item-head">
        <SeverityMark severity={finding.severity} />
        <span className="ch-meta">{t("console.inbox.finding")} · {specialistName(finding.pack)}</span>
      </div>
      <div className="ch-item-body">
        <RefText envelope={finding.envelope} resolved={finding.resolved_refs} format={c.format} />
      </div>
      {draftId && (
        <div className="ch-item-actions">
          <Link className="mu-btn" data-variant="secondary" href={`/console/inbox/${draftId}`}>{t("console.home.brief.review_draft")} ▸</Link>
        </div>
      )}
    </li>
  );
}

function DraftRow({ draft, finding }: { draft: Draft; finding: Finding | null }) {
  const c = useConsole();
  const subject = outletSubject(draft.outlet_ids, c.outlets);
  return (
    <li className="ch-item" data-kind="draft" data-draft={draft.draft_id}>
      <div className="ch-item-head">
        <Badge tone="accent">{t("draft.label")}</Badge>
        <strong className="ch-item-title">{[draftTypeLabel(draft.command_type), subject].filter(Boolean).join(" · ")}</strong>
        <span className="ch-meta">{proposedBy(draft.source)}</span>
      </div>
      <div className="ch-item-actions">
        {finding && <Impact finding={finding} />}
        <Link className="mu-btn" data-variant="primary" href={`/console/inbox/${draft.draft_id}`}>{t("console.inbox.review")}</Link>
      </div>
    </li>
  );
}

const findingsOf = (items: readonly InboxItem[]) => new Map(items.flatMap((i) => (i.kind === "finding" ? [[i.finding.finding_id, i.finding] as const] : [])));
export function draftForFinding(items: readonly InboxItem[], findingId: string): string | null {
  for (const i of items) if (i.kind === "draft" && i.draft.finding_id === findingId) return i.draft.draft_id;
  return null;
}

/** The inbox list (findings + drafts awaiting a person). Count = list length; "N+" when core capped it. */
export function InboxPanel() {
  const c = useConsole();
  const [retrying, setRetrying] = useState(false);
  const fmt = useMemo(() => createFormatter(c.format), [c.format]);
  const retry = useCallback(() => { setRetrying(true); void c.refreshInbox().finally(() => setRetrying(false)); }, [c]);
  if (!c.inbox) {
    // Owners and managers read the inbox; a null list for them is a failed load (S-err, the other panels render).
    if (c.member.role === "advisor") return null;
    return (
      <section className="mu-card ch-panel" data-panel="inbox" aria-labelledby="ch-inbox-h">
        <h2 id="ch-inbox-h">{t("console.inbox.title")}</h2>
        {retrying ? <StateLoading rows={3} /> : <StateError onRetry={retry} />}
      </section>
    );
  }
  const { items, nextCursor } = c.inbox;
  const count = `${fmt.number(items.length)}${nextCursor ? "+" : ""}`;
  const byFinding = findingsOf(items);
  return (
    <section className="mu-card ch-panel" data-panel="inbox" aria-labelledby="ch-inbox-h">
      <h2 id="ch-inbox-h">{t("console.inbox.title")} <span className="ch-count" data-count={items.length}>({count})</span></h2>
      {items.length === 0 ? (
        <StateEmpty message={t("console.inbox.empty")} />
      ) : (
        <ul className="ch-list" data-list="inbox">
          {items.map((i) =>
            i.kind === "finding"
              ? <FindingRow key={i.finding.finding_id} finding={i.finding} draftId={draftForFinding(items, i.finding.finding_id)} />
              : <DraftRow key={i.draft.draft_id} draft={i.draft} finding={i.draft.finding_id ? byFinding.get(i.draft.finding_id) ?? null : null} />)}
        </ul>
      )}
      {nextCursor && <p className="ch-meta">{t("console.inbox.capped", { count: fmt.number(items.length) })}</p>}
    </section>
  );
}

const BRIEF_LINES = 5;
type BriefLoad = { status: "loading" } | { status: "error" } | { status: "ok"; findings: Finding[]; preparedAt: string | null };

/** The morning brief: the open findings core returns first (GET /v1/findings?status=open), each its stored, validated
 *  envelope through RefText. Header: the producing run's issued_at when it was the brief run; otherwise these lines came
 *  from the watchers' rules alone — "Prepared from rules only" (S-aioff never shows an error). */
export function BriefPanel() {
  const c = useConsole();
  const fmt = useMemo(() => createFormatter(c.format), [c.format]);
  const [load, setLoad] = useState<BriefLoad>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  // Re-read when the inbox stream refreshes the list; the previous lines stay on screen meanwhile (S-sse: silent).
  useEffect(() => {
    let live = true;
    (async () => {
      const { data } = await api.GET("/v1/findings", { params: { query: { status: "open", limit: BRIEF_LINES } } });
      if (!data) throw new Error("findings");
      const top = data.items[0];
      let preparedAt: string | null = null;
      if (top) {
        const runs = await api.GET("/v1/runs", { params: { query: { finding: top.finding_id, limit: 1 } } });
        const run = runs.data?.items[0];
        if (run && run.trigger === "brief") preparedAt = run.issued_at;
      }
      if (live) setLoad({ status: "ok", findings: data.items, preparedAt });
    })().catch(() => live && setLoad({ status: "error" }));
    return () => { live = false; };
  }, [attempt, c.inbox]);

  const items = c.inbox?.items ?? [];
  return (
    <section className="mu-card ch-panel" data-panel="brief" aria-labelledby="ch-brief-h">
      <div className="ch-panel-head">
        <h2 id="ch-brief-h">{t("console.home.brief.title")}</h2>
        {load.status === "ok" && load.findings.length > 0 && (
          <span className="ch-meta" data-brief-source={load.preparedAt ? "brief" : "rules"}>
            {load.preparedAt ? t("console.home.brief.prepared_at", { time: fmt.time(load.preparedAt) }) : t("console.home.brief.rules_only")}
          </span>
        )}
      </div>
      {load.status === "loading" && <StateLoading rows={3} />}
      {load.status === "error" && <StateError onRetry={() => { setLoad({ status: "loading" }); setAttempt((n) => n + 1); }} />}
      {load.status === "ok" && load.findings.length === 0 && <StateEmpty message={t("console.home.brief.empty")} />}
      {load.status === "ok" && load.findings.length > 0 && (
        <ol className="ch-list ch-brief" data-list="brief">
          {load.findings.map((f) => {
            const draftId = draftForFinding(items, f.finding_id);
            return (
              <li key={f.finding_id} className="ch-item" data-finding={f.finding_id}>
                <div className="ch-item-head">
                  <SeverityMark severity={f.severity} />
                  <span className="ch-meta">{specialistName(f.pack)}</span>
                </div>
                <div className="ch-item-body"><RefText envelope={f.envelope} resolved={f.resolved_refs} format={c.format} /></div>
                {draftId && (
                  <div className="ch-item-actions">
                    <Link className="mu-btn" data-variant="secondary" href={`/console/inbox/${draftId}`}>{t("console.home.brief.review_draft")} ▸</Link>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

export function ReadOnlyBanner() {
  return <p className="ch-banner" role="note" data-banner="read-only"><IconInfo size={18} />{t("console.home.read_only")}</p>;
}
