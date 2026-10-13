"use client";
import {
  AbstainBlock, AiGate, Button, DraftFrame, Input, LivePill, RecordedOnlyNote, RefText, SimulatedBadge, SnapshotSourceProvider,
  StateDeny, StateEmpty, StateError, StateLoading, StateNotFound, StateOffline, SyntheticBadge, type ResolvedRef,
} from "@munim/ui";
import { snapRef } from "@munim/contracts/shared";
import { useEffect, useState, type ReactNode } from "react";
import { api, snapshotSource } from "../../../lib/api.ts";
import { t } from "../../../lib/i18n/index.ts";

const IN = { country: "IN", tz: "Asia/Kolkata" };
// A well-formed id that no snapshot has: renders "cannot verify".
const NO_SUCH = "0199e7a0-0000-7000-8000-0000000000ff";

function Block({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section data-state-id={id} style={{ display: "grid", gap: "var(--space-3)", padding: "var(--space-5)", background: "var(--surface-sunken)", borderRadius: "var(--radius-md)" }}>
      <h2 style={{ font: "var(--type-sm)", color: "var(--text-secondary)", margin: 0 }}>{title}</h2>
      {children}
    </section>
  );
}

/** With ?snap=<id> (a snapshot this session can read), the sample answer cites that snapshot's real first row. */
function SampleAnswer({ snapshotId }: { snapshotId: string | null }) {
  const [resolved, setResolved] = useState<ResolvedRef[] | null>(snapshotId ? null : []);
  const [cell, setCell] = useState(snapRef(NO_SUCH, 0, "net_payable_minor"));
  useEffect(() => {
    if (!snapshotId) return;
    void api.GET("/v1/snapshots/{id}", { params: { path: { id: snapshotId } } }).then(({ data }) => {
      const col = data?.columns.find((c) => c.name.endsWith("_minor"))?.name;
      const ref = col ? snapRef(snapshotId, 0, col) : snapRef(snapshotId, 0, "x");
      setCell(ref);
      setResolved(data && col && data.rows[0] ? [{ ref, value: data.rows[0][col] ?? null }] : []);
    });
  }, [snapshotId]);
  if (!resolved) return <StateLoading rows={2} />;
  return (
    <div data-sample="answer">
      <RefText format={IN} resolved={resolved}
        envelope={{ abstained: false, segments: [{ text: `Net tax payable this month is ${cell}; the other figure is ${snapRef(NO_SUCH, 0, "total_minor")}.`, refs: [] }] }} />
      <RefText format={IN} resolved={resolved}
        envelope={{ abstained: false, segments: [{ text: `Waste rose 12 times since ${cell}.`, refs: [] }] }} />
    </div>
  );
}

export function Gallery({ snapshotId }: { snapshotId: string | null }) {
  return (
    <SnapshotSourceProvider source={snapshotSource}>
      <main style={{ maxWidth: 960, margin: "0 auto", padding: "var(--space-8) var(--space-6)", display: "grid", gap: "var(--space-6)" }}>
        <header>
          <h1 style={{ font: "var(--type-2xl)", margin: 0 }}>{t("dev.states.title")}</h1>
          <p style={{ color: "var(--text-secondary)" }}>{t("dev.states.lede")}</p>
        </header>
        <Block id="S-load" title="S-load"><StateLoading rows={3} /></Block>
        <Block id="S-empty" title="S-empty"><StateEmpty message="No drafts waiting." action={<Button>Refresh</Button>} /></Block>
        <Block id="S-err" title="S-err"><StateError onRetry={() => {}} /></Block>
        <Block id="S-off" title="S-off"><StateOffline onRetry={() => {}} /></Block>
        <Block id="S-sse" title="S-sse"><div style={{ display: "flex", gap: "var(--space-6)" }}><LivePill state="open" /><LivePill state="retrying" /></div></Block>
        <Block id="S-deny" title="S-deny"><StateDeny /></Block>
        <Block id="S-abst" title="S-abst"><AbstainBlock reasonCode="number_grammar" format={IN} checked={[{ token: snapRef(NO_SUCH, 0, "x"), snapshot_id: NO_SUCH }]} /></Block>
        <Block id="S-aioff" title="S-aioff (the AI panel renders nothing)"><AiGate enabled={false}><Button>Ask</Button></AiGate></Block>
        <Block id="S-404" title="S-404"><StateNotFound /></Block>
        <Block id="labels" title="Labels"><div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-4)", alignItems: "center" }}><SimulatedBadge /><SimulatedBadge of="data" /><SyntheticBadge /></div><RecordedOnlyNote /></Block>
        <Block id="draft" title="Draft frame"><DraftFrame><p style={{ margin: 0 }}>Proposed change, waiting for a named person.</p></DraftFrame><DraftFrame state="stale"><p style={{ margin: 0 }}>Proposed change.</p></DraftFrame></Block>
        <Block id="controls" title="Buttons and inputs">
          <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-3)" }}>
            <Button variant="primary">Approve</Button><Button>Edit</Button><Button variant="ghost">Cancel</Button><Button variant="danger">Reject</Button>
            <Button variant="primary" busy>Approve</Button><Button disabled>Disabled</Button>
          </div>
          <Input id="amount" label="Amount" inputMode="decimal" error="Enter an amount in rupees and paise." />
        </Block>
        <Block id="refs" title={t("dev.states.sample_heading")}><SampleAnswer snapshotId={snapshotId} /></Block>
      </main>
    </SnapshotSourceProvider>
  );
}
