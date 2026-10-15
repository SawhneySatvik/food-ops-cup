// file: components/staff/cares/listing-draft.tsx
"use client";
// An AI proposal to give food at risk to a simulated recipient (a cares.listing.publish.v1 draft). It changes nothing
// until the owner taps "Approve as …"; a manager sees it but cannot decide it (core refuses: owner and judge only).
// The quantity is a ref with its source chip, or "Cannot verify"; an edit is labelled as the owner's.
import { useState } from "react";
import { caresCan, editedListing, FOOD_KIND, lineName, listingDraftView, unitLabel, type ListingDraft, type Recipient } from "@/lib/munim/cares-flow";
import { lineageText, type Outcome } from "@/lib/munim/draft-decision";
import { dayLabel, formatDate, formatDayTime, formatTime } from "@/lib/munim/format";
import type { CellFormat, Snapshot } from "@/lib/munim/refs";
import type { Session } from "@/lib/munim/session";
import type { StaffClient } from "@/lib/munim/staff";
import { DRAFT_STATUS, specialistName } from "@/lib/munim/staff-copy";
import type { Schemas } from "@/lib/munim/types";
import { DecisionBar, useDecision } from "../decision";
import { DraftField } from "../draft-field";
import { DRAFT_TONE, SimulatedRecipient, SourcedValue, StatusPill } from "../source";
import { RecipientRanking } from "./recipients";

type Detail = Schemas["V1DraftDetail"] & { draft: ListingDraft };

export function ListingDraftCard({ detail, match, recipients, menu, ingredients, session, client, fmt, tz, onOpen, onOutcome }: {
  detail: Detail;
  /** The cares.recipient_match snapshot the proposal cites (GET /v1/snapshots/{id}); null while loading or unopenable. */
  match: Snapshot | null | "failed";
  recipients: readonly Recipient[];
  menu: Schemas["V1CatalogueMenu"] | null;
  ingredients: readonly Schemas["V1InventoryIngredients"]["items"][number][];
  session: Session;
  client: StaffClient;
  fmt: CellFormat;
  tz: string;
  onOpen: (snapshotId: string, refToken: string) => void;
  /** Refetch the proposals (and listings) for every settled answer; the page shows the toasts. */
  onOutcome: (o: Outcome) => void;
}) {
  const d = detail.draft;
  const view = listingDraftView(d, detail.unverified_refs);
  const [editing, setEditing] = useState(false);
  const [typed, setTyped] = useState<Record<number, number>>({});
  const dec = useDecision(client, d, "cares", onOutcome);
  const unverified = view.lines.some((l) => l.qty.kind === "unverified");
  const editsReady = Object.keys(typed).length > 0 && view.lines.every((l) => l.qty.kind !== "unverified" || typed[l.index] !== undefined);
  const recipient = recipients.find((r) => r.recipient_id === d.payload.recipient_id);
  const when = (iso: string) => formatDayTime(iso, tz, fmt.locale);
  const proposer = specialistName(d.source.replace(/^intel:/, ""));
  const pickup = `${formatTime(d.payload.pickup_from, tz, fmt.locale)} – ${formatTime(d.payload.pickup_to, tz, fmt.locale)}`;

  return (
    <article className="card grid gap-3 p-5" aria-label="Proposed donation">
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-[22px]">Give food at risk to a simulated recipient</h3>
        <StatusPill tone={DRAFT_TONE[d.status] ?? "new"}>{DRAFT_STATUS[d.status] ?? d.status}</StatusPill>
      </header>

      {view.lines.map(({ index, line, qty }) => (
        <div key={line.line_id}>
          <div className="draft-field">
            <p className="font-semibold">Food</p>
            <p>{lineName(line, menu, ingredients)} · {FOOD_KIND[line.food_kind]}{line.expires_on ? ` · use by ${formatDate(line.expires_on, fmt.locale)}` : ""}</p>
          </div>
          <DraftField
            label={`Quantity (${unitLabel(line.unit)})`} value={qty} column="qty_milli" fmt={fmt} onOpen={onOpen}
            edit={typed[index] ?? null} editorName={session.me.name} editing={editing}
            onEdit={(v) => setTyped((t) => { const n = { ...t }; if (v === null) delete n[index]; else n[index] = v; return n; })}
          />
        </div>
      ))}
      <div className="draft-field">
        <p className="font-semibold">To</p>
        <p className="flex flex-wrap items-center gap-2">{recipient?.name ?? "A simulated recipient that is no longer listed"} <SimulatedRecipient /></p>
      </div>
      <div className="draft-field">
        <p className="font-semibold">Pickup</p>
        <p>
          {dayLabel(d.payload.pickup_from, tz, fmt.locale)}{" "}
          {view.pickupRef ? <SourcedValue text={pickup} refToken={view.pickupRef} onOpen={onOpen} /> : <span className="src-value">{pickup}</span>}
        </p>
      </div>

      <details>
        <summary className="min-h-12 cursor-pointer font-semibold">Simulated recipients that could take it</summary>
        <div className="mt-3">
          {match === null ? <div className="skeleton h-24" role="status" aria-label="Loading" />
            : match === "failed" ? <p className="text-muted">The ranking can&apos;t be opened.</p>
            : <RecipientRanking snapshot={match} fmt={fmt} tz={tz} chosen={d.payload.recipient_id} onOpen={onOpen} />}
        </div>
      </details>

      <p className="lineage">{lineageText(detail, proposer, when)}{d.finding_id ? " · from a finding: food at risk of going to waste" : ""}</p>

      {d.status === "proposed" && (caresCan(session.me.role, "publish") ? (
        <DecisionBar
          name={session.me.name} unverified={unverified} editing={editing} onEdit={setEditing} editsReady={editsReady}
          busy={dec.busy} error={dec.error} retry={dec.retry} wait={dec.wait}
          onApprove={() => dec.approve(null, null)}
          onApproveEdited={(reason) => dec.approve(editedListing(d.payload, typed, session.me.member_id), reason)}
          onReject={dec.reject}
        />
      ) : (
        <p className="text-muted">Only the owner can approve or reject a donation.</p>
      ))}
    </article>
  );
}
