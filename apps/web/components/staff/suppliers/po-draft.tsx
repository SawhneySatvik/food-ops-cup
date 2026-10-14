// file: components/staff/suppliers/po-draft.tsx
"use client";
// An AI proposal to buy from a simulated supplier (a purchasing.po.create.v1 draft). Its quantity traces to the quote
// comparison; its price is a simulated supplier's quote, which core does not resolve for the approver, so it always
// shows "Cannot verify": "Approve" is hidden and the approver types the price they agreed ("Approve with my edits").
// The quoted price is shown beside the input with its source chip, never copied into it.
import { useState } from "react";
import type { Outcome } from "@/lib/munim/draft-decision";
import { lineageText } from "@/lib/munim/draft-decision";
import { formatDate, formatDayTime } from "@/lib/munim/format";
import { formatCell, snapRef, type CellFormat, type Snapshot } from "@/lib/munim/refs";
import type { Session } from "@/lib/munim/session";
import type { StaffClient } from "@/lib/munim/staff";
import { DRAFT_STATUS, specialistName } from "@/lib/munim/staff-copy";
import { editedPo, ingredientOf, missingEdits, poDraftLines, quoteRows, type PoDraft, type PoEdits, type Supplier } from "@/lib/munim/supply-flow";
import type { Schemas } from "@/lib/munim/types";
import { DecisionBar, useDecision } from "../decision";
import { DraftField } from "../draft-field";
import { DRAFT_TONE, SimulatedSupplier, SourcedValue, StatusPill } from "../source";
import { QuoteTable } from "./quotes";

type Detail = Schemas["V1DraftDetail"] & { draft: PoDraft };

export function PoDraftCard({ detail, quotes, suppliers, ingredients, outletName, session, client, fmt, tz, onOpen, onOutcome }: {
  detail: Detail;
  /** purchasing.quote_compare minted for this viewer with the proposal's negotiation_run_id; null while loading. */
  quotes: Snapshot | null | "failed";
  suppliers: readonly Supplier[];
  ingredients: readonly Schemas["V1InventoryIngredients"]["items"][number][];
  outletName: (id: string) => string;
  session: Session;
  client: StaffClient;
  fmt: CellFormat;
  tz: string;
  onOpen: (snapshotId: string, refToken: string) => void;
  onOutcome: (o: Outcome) => void;
}) {
  const d = detail.draft;
  const lines = poDraftLines(d, detail.unverified_refs);
  const supplier = suppliers.find((s) => s.supplier_id === d.payload.supplier_id);
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<PoEdits>({ qty: {}, price: {} });
  const dec = useDecision(client, d, "suppliers", onOutcome);
  const unverified = lines.some((l) => l.qty.kind === "unverified" || l.price.kind === "unverified");
  const typedAny = Object.keys(edits.qty).length > 0 || Object.keys(edits.price).length > 0;
  const proposer = specialistName(d.source.replace(/^intel:/, ""));
  const put = (field: "qty" | "price", i: number) => (v: number | null) =>
    setEdits((e) => { const n = { ...e[field] }; if (v === null) delete n[i]; else n[i] = v; return { ...e, [field]: n }; });
  const quoted = (quoteId: string | null) => {
    if (!quotes || quotes === "failed" || !quoteId) return null;
    const q = quoteRows(quotes).find((r) => r.quoteId === quoteId);
    return q ? <SourcedValue text={formatCell(quotes.rows[q.row]!.unit_price_minor ?? null, "unit_price_minor", fmt)} refToken={snapRef(quotes.snapshot_id, q.row, "unit_price_minor")} onOpen={onOpen} /> : null;
  };

  return (
    <article className="card grid gap-3 p-5" aria-label="Proposed purchase order">
      <header className="flex flex-wrap items-center gap-2">
        <h3 className="text-[22px]">Order from {supplier?.name ?? "a supplier no longer listed"}</h3>
        <SimulatedSupplier />
        <StatusPill tone={DRAFT_TONE[d.status] ?? "new"}>{DRAFT_STATUS[d.status] ?? d.status}</StatusPill>
      </header>
      <div className="draft-field"><p className="font-semibold">For</p><p>{d.payload.outlet_ids.map(outletName).join(", ")}</p></div>
      <div className="draft-field"><p className="font-semibold">Expected</p><p>{d.payload.expected_on ? formatDate(d.payload.expected_on, fmt.locale) : "Not set"}</p></div>
      {lines.map((l) => {
        const ing = ingredientOf(ingredients, l.line.ingredient_id);
        return (
          <div key={l.index} className="rounded-[var(--radius-field)] border-[1.5px] border-bg-deep p-3">
            <p className="font-semibold">{ing.name}</p>
            <DraftField label={`Quantity (${l.line.unit})`} value={l.qty} column="qty_milli" fmt={fmt} onOpen={onOpen}
              edit={edits.qty[l.index] ?? null} editorName={session.me.name} editing={editing} onEdit={put("qty", l.index)} />
            <DraftField label={`Price per ${l.line.unit}`} value={l.price} column="unit_price_minor" fmt={fmt} onOpen={onOpen}
              edit={edits.price[l.index] ?? null} editorName={session.me.name} editing={editing} onEdit={put("price", l.index)} />
            {quoted(l.quoteId) && <p className="text-[15px]">The simulated supplier quoted {quoted(l.quoteId)} per unit. Type the price you agreed.</p>}
          </div>
        );
      })}
      <p className="text-[14px] text-muted">Munim works out the total when it is approved. Recorded only — Munim does not process payments. Simulated supplier: nothing is sent to a real business.</p>
      <details open>
        <summary className="min-h-12 cursor-pointer font-semibold">Compare the quotes</summary>
        <div className="mt-3">
          {quotes === null ? <div className="skeleton h-24" role="status" aria-label="Loading" />
            : quotes === "failed" ? <p className="text-muted">The quotes can&apos;t be opened.</p>
            : <QuoteTable snapshot={quotes} suppliers={suppliers} citedQuoteId={lines[0]?.quoteId ?? null} fmt={fmt} onOpen={onOpen} />}
        </div>
      </details>
      <p className="lineage">{lineageText(detail, proposer, (iso) => formatDayTime(iso, tz, fmt.locale))}</p>
      {d.status === "proposed" && (
        <DecisionBar
          name={session.me.name} unverified={unverified} editing={editing} onEdit={setEditing}
          editsReady={typedAny && !missingEdits(lines, edits)}
          busy={dec.busy} error={dec.error} retry={dec.retry} wait={dec.wait}
          onApprove={() => dec.approve(null, null)}
          onApproveEdited={(reason) => dec.approve(editedPo(d.payload, edits, session.me.member_id), reason)}
          onReject={dec.reject}
        />
      )}
    </article>
  );
}
