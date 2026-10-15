// file: components/staff/draft-field.tsx
"use client";
// One numeric field of an AI draft: the proposed value with its source chip, or "Cannot verify"; and, once the
// approver types a value, their edit labelled as theirs beside the struck-through proposal. The draft card in 12
// lays these out; this file fixes how each one looks and what it says.
import { columnOf, formatCell, parseTyped, type CellFormat, type DraftValue } from "@/lib/munim/refs";
import { CannotVerify, SourcedValue } from "./source";

/** The unit a person types in, by the field's name: "INR" for *_minor, "seconds" for *_sec, the line's unit otherwise. */
export const unitOf = (column: string, currency: string, lineUnit = "quantity"): string =>
  column.endsWith("_minor") ? currency : column.endsWith("_sec") ? "seconds" : column.endsWith("_milli") ? lineUnit : "number";

export function DraftField({ label, value, edit, editorName, fmt, column, lineUnit, onOpen, onEdit, editing }: {
  label: string;
  /** draftValue(leaf, path, resolved_refs, unverified_refs) from refs.ts. */
  value: DraftValue;
  /** What the approver typed, already in the field's own units (parseTyped), or null. */
  edit: number | null;
  editorName: string;
  fmt: CellFormat;
  /** The payload field name ("unit_price_minor", "qty_milli", "prep_sec") so the value is formatted by its unit. */
  column: string;
  /** The payload line's unit ("kg", "g"), for the input's label on a quantity field. */
  lineUnit?: string;
  onOpen: (snapshotId: string, refToken: string) => void;
  /** Present while the card is in edit mode: renders the input. */
  onEdit?: (v: number | null) => void;
  editing?: boolean;
}) {
  const proposed =
    value.kind === "proposed" ? <SourcedValue text={formatCell(value.value, columnOf(value.parsed) || column, fmt)} refToken={value.ref} onOpen={onOpen} />
    : value.kind === "edited" ? <span className="src-value">{formatCell(value.value, column, fmt)}</span>
    : <CannotVerify />;
  return (
    <div className="draft-field">
      <p className="font-semibold">{label}</p>
      <div className="space-y-1">
        <p className={edit !== null ? "draft-proposed-struck" : undefined}>
          {value.kind === "edited" ? <span className="draft-edit-label">Edited earlier · </span> : <span className="text-muted">Proposed · </span>}
          {proposed}
        </p>
        {edit !== null && (
          <p>
            <span className="src-value">{formatCell(edit, column, fmt)}</span> <span className="draft-edit-label">Edited by {editorName}</span>
          </p>
        )}
        {editing && onEdit && (
          <label className="block text-[14px] font-semibold">
            {value.kind === "unverified" ? "Type the value you checked" : "Change it (optional)"} ({unitOf(column, fmt.currency, lineUnit)})
            <input inputMode="decimal" onChange={(e) => onEdit(parseTyped(e.target.value, column, fmt.currency))} />
          </label>
        )}
      </div>
    </div>
  );
}
