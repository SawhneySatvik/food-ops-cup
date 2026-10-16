// file: lib/munim/refs.ts
// Refs: the only way a number written by Munim's AI reaches the screen. AI text never carries digits; it carries
// tokens like ⟨snap:<snapshot id>·<row>·<column>⟩ that name one cell of a snapshot core-api minted from the books.
// This file splits text into plain parts and ref parts, finds each ref's value in the response's resolved_refs, and
// formats a cell for display. Anything that cannot be traced becomes { kind: "unverified" }: the UI shows
// "Cannot verify", never a guess and never the model's own words. Plain TypeScript, no React.
import { formatMoney, formatQty, formatRate } from "./format";
import type { Schemas } from "./types";

export type Snapshot = Schemas["Snapshot"];
export type Cell = string | number | boolean | null;
/** `{ ref, value }` as core resolved it for this viewer (answers, findings, drafts; drafts add a JSON Pointer `path`). */
export interface ResolvedRef {
  ref: string;
  value: Cell;
  path?: string;
}

const U = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const SNAP = new RegExp(`^⟨snap:(${U})·(0|[1-9][0-9]*)·([a-z_][a-z0-9_]*)⟩$`, "u");
const CITE = new RegExp(`^⟨cite:(?:row:([a-z_][a-z0-9_]*\\.[a-z_][a-z0-9_]*):(${U})|(doc|msg|claim|snapshot):(${U}))(?:·(0|[1-9][0-9]*)-(0|[1-9][0-9]*))?⟩$`, "u");
/** Every ⟨…⟩ token, well-formed or not (a fresh regex each call: a shared /g regex keeps state). */
const anyToken = () => /⟨[^⟩]*⟩/gu;

export type ParsedRef =
  | { kind: "snap"; snapshotId: string; row: number; column: string }
  | { kind: "row"; table: string; id: string }
  | { kind: "doc" | "msg" | "claim" | "snapshot"; id: string };

/** One ref token -> its parts; null when it is not well-formed (render "Cannot verify"). */
export function parseRef(token: string): ParsedRef | null {
  const s = SNAP.exec(token);
  if (s) return { kind: "snap", snapshotId: s[1]!, row: Number(s[2]), column: s[3]! };
  const c = CITE.exec(token);
  if (!c) return null;
  if (c[1]) return { kind: "row", table: c[1], id: c[2]! };
  return { kind: c[3] as "doc" | "msg" | "claim" | "snapshot", id: c[4]! };
}

export type Part =
  | { kind: "text"; text: string }
  | { kind: "value"; ref: string; parsed: ParsedRef; value: Cell }
  | { kind: "unverified"; ref: string | null };

/** True when plain text (refs removed) still holds a digit: a number the model typed. Never shown. */
export const hasFreeDigits = (text: string): boolean => /\p{Nd}/u.test(text.replace(anyToken(), ""));

/** Splits one AI segment into parts. `resolved` is the response's resolved_refs. A segment with a free digit is
 *  returned as one "unverified" part, so a model-typed number can never reach the screen. */
export function renderSegment(segment: { text: string; refs: readonly string[] }, resolved: readonly ResolvedRef[]): Part[] {
  if (hasFreeDigits(segment.text)) return [{ kind: "unverified", ref: null }];
  const byRef = new Map(resolved.map((r) => [r.ref, r.value]));
  const parts: Part[] = [];
  let at = 0;
  for (const m of segment.text.matchAll(anyToken())) {
    if (m.index > at) parts.push({ kind: "text", text: segment.text.slice(at, m.index) });
    at = m.index + m[0].length;
    const parsed = parseRef(m[0]);
    if (parsed && byRef.has(m[0])) parts.push({ kind: "value", ref: m[0], parsed, value: byRef.get(m[0])! });
    else parts.push({ kind: "unverified", ref: m[0] });
  }
  if (at < segment.text.length) parts.push({ kind: "text", text: segment.text.slice(at) });
  return parts;
}

/** A draft field's value: the proposed ref (with its resolved value), a person's edit, or unverified. */
export type DraftValue =
  | { kind: "proposed"; ref: string; parsed: ParsedRef; value: Cell }
  | { kind: "edited"; value: number; typedBy: string }
  | { kind: "unverified"; ref: string };

/** Reads one numeric leaf of a draft payload. `path` is its JSON Pointer ("/lines/0/unit_price_minor"). */
export function draftValue(leaf: unknown, path: string, resolved: readonly ResolvedRef[], unverified: readonly string[]): DraftValue {
  if (typeof leaf === "object" && leaf !== null && "value" in leaf && "typed_by" in leaf) {
    const e = leaf as { value: number; typed_by: string };
    return { kind: "edited", value: e.value, typedBy: e.typed_by };
  }
  const ref = String(leaf);
  const parsed = parseRef(ref);
  const hit = resolved.find((r) => r.path === path && r.ref === ref);
  if (!parsed || !hit || unverified.includes(ref)) return { kind: "unverified", ref };
  return { kind: "proposed", ref, parsed, value: hit.value };
}

/** How to show a cell, from its column name (core's naming rule: *_minor money, *_milli thousandths, *_bp basis
 *  points). `currency` is the business's base currency (GET /v1/tenant), used only for *_minor columns. */
export interface CellFormat {
  locale: string;
  currency: string;
  /** outlet id -> name, from the outlets the session already has (GET /v1/outlets); an `outlet_id` cell shows the name. */
  outletNames?: Readonly<Record<string, string>>;
}
/** The names to put in `CellFormat.outletNames`. */
export const outletNames = (outlets: readonly { id: string; name: string }[]): Record<string, string> => Object.fromEntries(outlets.map((o) => [o.id, o.name]));

/** An `outlet_id` cell as the outlet's name; null for any other cell, or an outlet the session has no name for (that one is
 *  shown as stored). The cell stays the snapshot's: only its look changes. */
const outletLabel = (value: Cell | undefined, column: string, f: CellFormat): string | null =>
  column === "outlet_id" && typeof value === "string" ? (f.outletNames?.[value] ?? null) : null;

/** One cell of the snapshot drawer's table: an id column shows its last 8 characters (v7 ids share their first ones), unless it
 *  is an outlet the session knows by name. */
export const drawerCell = (type: string, value: Cell | undefined, column: string, f: CellFormat): string =>
  type === "uuid" ? (outletLabel(value, column, f) ?? `…${String(value ?? "—").slice(-8)}`) : formatCell(value ?? null, column, f);

export function formatCell(value: Cell, column: string, f: CellFormat): string {
  if (value === null) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  const outlet = outletLabel(value, column, f);
  if (outlet !== null) return outlet;
  const n = typeof value === "number" ? value : /^-?\d+$/.test(value) ? Number(value) : null;
  if (n === null) return String(value); // text, dates and numeric strings with a fraction are shown as stored
  if (column.endsWith("_minor")) return formatMoney(n, f.currency, f.locale);
  if (column.endsWith("_milli")) return formatQty(n, f.locale);
  if (column.endsWith("_bp")) return formatRate(n, f.locale);
  if (column.endsWith("_sec")) return n < 120 ? `${n} s` : `${Math.floor(n / 60)} min${n % 60 ? ` ${n % 60} s` : ""}`;
  return new Intl.NumberFormat(f.locale).format(n);
}

/** What a person typed into a draft field, in the field's own units: "1,410.50" in a *_minor field -> 141050, "9" in a
 *  *_milli field -> 9000, "1800" in a *_sec field -> 1800. Digits are moved as text (no floating point); null when it is
 *  not a plain non-negative number or has more decimals than the unit allows. */
export function parseTyped(text: string, column: string, currency: string): number | null {
  const t = text.trim().replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  const digits = column.endsWith("_minor") ? (new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2) : column.endsWith("_milli") ? 3 : 0;
  return frac.length > digits ? null : Number(whole! + frac.padEnd(digits, "0"));
}

/** The column a part shows, for formatCell: the snap ref's column, or "" for a quoted span. */
export const columnOf = (p: ParsedRef): string => (p.kind === "snap" ? p.column : "");

/** A snapshot cell by ref, from an opened snapshot; undefined when the row or column is not there. */
export function cellOf(s: Snapshot, ref: ParsedRef): Cell | undefined {
  if (ref.kind !== "snap" || ref.snapshotId !== s.snapshot_id) return undefined;
  const row = s.rows[ref.row];
  return row && ref.column in row ? row[ref.column] : undefined;
}

/** The snap ref for one cell of a snapshot the screen minted itself (owner home stat cards). */
export const snapRef = (snapshotId: string, row: number, column: string): string => `⟨snap:${snapshotId}·${row}·${column}⟩`;
