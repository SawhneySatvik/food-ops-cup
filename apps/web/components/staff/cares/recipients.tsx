// file: components/staff/cares/recipients.tsx
"use client";
// Simulated recipients ranked by core (a cares.recipient_match snapshot: the row order is the rank, best first; the
// browser never re-sorts or scores them). Each figure is a cell with its source chip. Used read-only under an AI
// proposal, and as the picker for the owner's own listing.
import { cellOf, formatCell, snapRef, type CellFormat, type Snapshot } from "@/lib/munim/refs";
import { dayLabel, formatTime } from "@/lib/munim/format";
import { matchRows, type MatchRow } from "@/lib/munim/cares-flow";
import { CannotVerify, SimulatedRecipient, SourcedValue, StatusPill } from "../source";

export function RecipientRanking({ snapshot, fmt, tz, chosen, onChoose, onOpen }: {
  snapshot: Snapshot;
  fmt: CellFormat;
  tz: string;
  /** The recipient the proposal (or the owner) chose. */
  chosen: string | null;
  /** Present for the owner's own listing: each row gets "Choose". */
  onChoose?: (m: MatchRow) => void;
  onOpen: (snapshotId: string, refToken: string) => void;
}) {
  const rows = matchRows(snapshot);
  if (rows.length === 0) return <p className="state-box">No simulated recipient can take this food at this outlet&apos;s pickup times.</p>;
  const cell = (row: number, column: string, after: string) => {
    const v = cellOf(snapshot, { kind: "snap", snapshotId: snapshot.snapshot_id, row, column });
    return v === undefined ? <CannotVerify /> : <SourcedValue text={`${formatCell(v, column, fmt)}${after}`} refToken={snapRef(snapshot.snapshot_id, row, column)} onOpen={onOpen} />;
  };
  return (
    <ol className="grid gap-3" aria-label="Simulated recipients, best match first">
      {rows.map((m, i) => (
        <li key={m.recipientId} className="card grid gap-2 p-4" aria-current={chosen === m.recipientId ? "true" : undefined}>
          <p className="flex flex-wrap items-center gap-2 font-semibold">
            {m.name} <SimulatedRecipient />
            {i === 0 && <StatusPill tone="new">Best match</StatusPill>}
            {chosen === m.recipientId && <StatusPill tone="ready">Chosen</StatusPill>}
          </p>
          <p>
            Pickup {dayLabel(m.pickupFrom, tz, fmt.locale)}{" "}
            <SourcedValue text={`${formatTime(m.pickupFrom, tz, fmt.locale)} – ${formatTime(m.pickupTo, tz, fmt.locale)}`} refToken={snapRef(snapshot.snapshot_id, m.row, "pickup_from")} onOpen={onOpen} />
          </p>
          <p className="text-[15px] text-muted">
            Distance {cell(m.row, "distance_m", " m")} · Overlap with your pickup hours {cell(m.row, "overlap_min", " min")} · {m.fits ? "Has room for this" : "May not have room for all of it"}
          </p>
          {onChoose && (
            <button type="button" className="btn btn-secondary justify-self-start" aria-pressed={chosen === m.recipientId} onClick={() => onChoose(m)}>
              {chosen === m.recipientId ? "Chosen" : `Choose ${m.name}`}
            </button>
          )}
        </li>
      ))}
    </ol>
  );
}
