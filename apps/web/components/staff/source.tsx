// file: components/staff/source.tsx
"use client";
// How an AI number looks: the value, formatted from its snapshot cell, with a source chip that opens the rows behind
// it; or the "Cannot verify" chip when it does not trace. Plus the stat card (owner home), the simulated badges and
// the status pill. AI text is rendered as text nodes only, never as HTML.
import { useEffect, useRef, useState } from "react";
import { cellOf, columnOf, drawerCell, formatCell, parseRef, renderSegment, type CellFormat, type Part, type ResolvedRef, type Snapshot } from "@/lib/munim/refs";
import type { StaffClient } from "@/lib/munim/staff";
import { CANNOT_VERIFY, SIMULATED_RECIPIENT, SIMULATED_SUPPLIER } from "@/lib/munim/staff-copy";
import { formatDayTime } from "@/lib/munim/format";
import { AlertIcon, CloseIcon } from "../icons";

/** The little ledger-stamp mark inside a source chip (drawn for this project: a stamp with two ruled lines). */
const StampMark = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
    <rect x="2" y="2" width="12" height="12" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
    <path d="M5 6.5h6M5 9.5h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
);

export function CannotVerify({ why }: { why?: string }) {
  return (
    <span className="cv-chip" title={why}>
      <AlertIcon size={16} /> {CANNOT_VERIFY}
    </span>
  );
}

/** A traced value: the formatted cell and its chip. `onOpen` gets the snapshot id (open the drawer). */
export function SourcedValue({ text, refToken, onOpen }: { text: string; refToken: string; onOpen: (snapshotId: string, refToken: string) => void }) {
  const p = parseRef(refToken);
  if (!p || p.kind !== "snap") return <span className="src-value">{text}</span>; // a quoted span: shown, no rows to open
  return (
    <>
      <span className="src-value">{text}</span>
      <button type="button" className="src-chip" onClick={() => onOpen(p.snapshotId, refToken)} aria-label={`Source of ${text}: open the rows`}>
        <StampMark /> Source
      </button>
    </>
  );
}

/** One AI segment (answer, finding): plain text, traced values with chips, and "Cannot verify" for the rest. */
export function AiSegment({ segment, resolved, fmt, onOpen }: { segment: { text: string; refs: readonly string[] }; resolved: readonly ResolvedRef[]; fmt: CellFormat; onOpen: (snapshotId: string, refToken: string) => void }) {
  const parts: Part[] = renderSegment(segment, resolved);
  return (
    <p className="leading-relaxed">
      {parts.map((p, i) =>
        p.kind === "text" ? <span key={i}>{p.text}</span>
        : p.kind === "value" ? <SourcedValue key={i} text={formatCell(p.value, columnOf(p.parsed), fmt)} refToken={p.ref} onOpen={onOpen} />
        : <CannotVerify key={i} />,
      )}
    </p>
  );
}

/** Owner home: one figure from a snapshot cell the screen minted. `value` undefined = still loading. */
export function StatCard({ label, value, refToken, note, onOpen }: { label: string; value: string | null | undefined; refToken: string | null; note?: string; onOpen: (snapshotId: string, refToken: string) => void }) {
  return (
    <div className="card stat">
      <p className="stat-label">{label}</p>
      {value === undefined ? <div className="skeleton h-10 w-32" aria-hidden="true" />
        : value === null || refToken === null ? <CannotVerify />
        : <p className="stat-value"><SourcedValue text={value} refToken={refToken} onOpen={onOpen} /></p>}
      {note && <p className="text-[14px] text-muted">{note}</p>}
    </div>
  );
}

/** The snapshot drawer: the rows behind a ref, with the cited cell outlined. 404 (not this person's) = Cannot verify. */
export function SnapshotDrawer({ client, open, onClose, fmt, tz, label }: {
  client: StaffClient;
  open: { snapshotId: string; refToken: string } | null;
  onClose: () => void;
  fmt: CellFormat;
  tz: string;
  /** Plain words for a template id ("inventory.waste_week" -> "Waste this week"); falls back to the id. */
  label?: (templateId: string) => string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [snap, setSnap] = useState<Snapshot | null | "failed">(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
    if (!open) return;
    let live = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset before loading the next snapshot
    setSnap(null);
    void client.getSnapshot(open.snapshotId).then((r) => { if (live) setSnap(r.ok ? r.data : "failed"); });
    return () => { live = false; };
  }, [open, client]);
  const cited = open ? parseRef(open.refToken) : null;
  // Id columns mean nothing to a person (and v7 ids share their first characters), so only a cited id column is shown,
  // by its last characters.
  const columns = snap && snap !== "failed" ? snap.columns.filter((c) => c.type !== "uuid" || (cited?.kind === "snap" && cited.column === c.name)) : [];
  return (
    <dialog ref={ref} className="drawer" aria-labelledby="snap-title" onClose={onClose}>
      <div className="flex items-center justify-between gap-3 border-b-[1.5px] border-line p-4">
        <h2 id="snap-title" className="text-[24px]">Where this number comes from</h2>
        <button type="button" className="btn btn-plain btn-round" onClick={onClose} aria-label="Close"><CloseIcon size={20} /></button>
      </div>
      <div className="space-y-3 p-4">
        {snap === null && <div className="skeleton h-40" role="status" aria-label="Loading the rows" />}
        {snap === "failed" && <p><CannotVerify /> These rows can&apos;t be opened.</p>}
        {snap && snap !== "failed" && (
          <>
            <p className="font-semibold">{label?.(snap.template_id) ?? snap.template_id}</p>
            <p className="text-[14px] text-muted">
              Taken from the books {formatDayTime(snap.created_at, tz, fmt.locale)} · {snap.run_id ? "by Munim's AI, for the text you were reading" : "for this screen"} · {snap.row_count} {snap.row_count === 1 ? "row" : "rows"}
            </p>
            {cited && cited.kind === "snap" && cellOf(snap, cited) === undefined && <p><CannotVerify /> The cited cell is not in these rows.</p>}
            <div className="overflow-x-auto">
              <table className="snap-table">
                <thead><tr>{columns.map((c) => <th key={c.name} className={c.type === "integer" || c.type === "numeric" ? "num" : undefined} scope="col">{c.name}</th>)}</tr></thead>
                <tbody>
                  {snap.rows.map((row, i) => {
                    const here = cited?.kind === "snap" && cited.row === i;
                    return (
                      <tr key={i} aria-current={here ? "true" : undefined}>
                        {columns.map((c) => (
                          <td key={c.name} className={c.type === "integer" || c.type === "numeric" ? "num" : undefined} aria-current={here && cited?.kind === "snap" && cited.column === c.name ? "true" : undefined}>
                            {drawerCell(c.type, row[c.name], c.name, fmt)}
                            {c.name === "name" && row.simulated === true && <> <SimulatedRecipient /></>}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-[14px] text-muted">Demo: all data is synthetic.</p>
          </>
        )}
      </div>
    </dialog>
  );
}

/** Wherever a supplier's name appears. */
export const SimulatedSupplier = () => <span className="badge badge-sim">{SIMULATED_SUPPLIER}</span>;
/** Wherever a donation recipient's name appears (the name keeps its "(simulated)"). */
export const SimulatedRecipient = () => <span className="badge badge-sim">{SIMULATED_RECIPIENT}</span>;

export type PillTone = "new" | "work" | "ready" | "done" | "stop" | "warn" | "late";
/** A status in words, with a tone. Never colour alone: the word is always there. */
export const StatusPill = ({ tone, children }: { tone: PillTone; children: React.ReactNode }) => <span className={`badge badge-${tone}`}>{children}</span>;
export const ORDER_TONE: Record<string, PillTone> = { placed: "new", accepted: "work", preparing: "work", ready: "ready", completed: "done", rejected: "stop", cancelled: "stop" };
export const TICKET_TONE: Record<string, PillTone> = { queued: "new", preparing: "work", ready: "ready", done: "done" };
export const DRAFT_TONE: Record<string, PillTone> = { proposed: "new", executing: "work", executed: "ready", failed: "stop", rejected: "done", stale: "warn" };
