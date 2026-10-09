// Ref grammar (03-architecture §1.7, R25/R26). The only way a number, date or quotation reaches a
// person from intel: the renderer substitutes the cell / span named by the ref.
//   ⟨snap:<snapshot-id>·<row>·<column>⟩
//   ⟨cite:<kind>:<id>[·<start>-<end>]⟩    kind ∈ row | doc | msg | claim | snapshot
// For kind `row` the id is `<schema>.<table>:<uuid>` (04-agent-framework §4 example).
// `RefId` is the bare form used in an envelope segment's `refs[]` ("snap:<id>", "row:core.x:<id>").
// Delimiters: U+27E8 ⟨, U+27E9 ⟩, U+00B7 · (middle dot).
import { z } from "zod";
import { UUID7_PATTERN } from "./primitives.ts";

export const CITE_KINDS = ["row", "doc", "msg", "claim", "snapshot"] as const;
export type CiteKind = (typeof CITE_KINDS)[number];
export const OPEN = "⟨";
export const CLOSE = "⟩";
export const DOT = "·";

const U = UUID7_PATTERN;
const COLUMN = "[a-z_][a-z0-9_]*";
const TABLE = "[a-z_][a-z0-9_]*\\.[a-z_][a-z0-9_]*";
const INDEX = "(?:0|[1-9][0-9]*)";
const SPAN = `(?:${DOT}${INDEX}-${INDEX})?`;
const CITE_ID = `(?:row:${TABLE}:${U}|(?:doc|msg|claim|snapshot):${U})`;

/** Source strings (no anchors, no flags needed) so Python and SQL can reuse them verbatim. */
export const SNAP_REF_SOURCE = `${OPEN}snap:${U}${DOT}${INDEX}${DOT}${COLUMN}${CLOSE}`;
export const CITE_REF_SOURCE = `${OPEN}cite:${CITE_ID}${SPAN}${CLOSE}`;
export const REF_SOURCE = `(?:${SNAP_REF_SOURCE}|${CITE_REF_SOURCE})`;
export const REF_ID_SOURCE = `(?:snap:${U}|${CITE_ID})`;
/** Matches every ref-shaped token (well-formed or not) so a validator can strip / inspect them. */
export const ANY_REF_TOKEN_SOURCE = `${OPEN}[^${CLOSE}]*${CLOSE}`;
/** A factory, because a shared /g regex keeps `lastIndex` state between calls. */
export const anyRefTokens = (): RegExp => new RegExp(ANY_REF_TOKEN_SOURCE, "gu");
/** A factory for scanning prose for well-formed refs (global). */
export const refTokens = (): RegExp => new RegExp(REF_SOURCE, "gu");

/** Anchored parsers. Snap groups: 1 = snapshot id, 2 = row, 3 = column. */
export const SNAP_REF_CAPTURE = new RegExp(`^${OPEN}snap:(${U})${DOT}(${INDEX})${DOT}(${COLUMN})${CLOSE}$`, "u");
/** Cite groups: 1 = kind, 2 = id (for `row`: `<schema>.<table>:<uuid>`), 3 = span start, 4 = span end. */
export const CITE_REF_CAPTURE = new RegExp(
  `^${OPEN}cite:(?:(row):(${TABLE}:${U})|(doc|msg|claim|snapshot):(${U}))(?:${DOT}(${INDEX})-(${INDEX}))?${CLOSE}$`,
  "u",
);

export const SnapCellRef = z.string().regex(new RegExp(`^${SNAP_REF_SOURCE}$`, "u"));
export const CiteRef = z.string().regex(new RegExp(`^${CITE_REF_SOURCE}$`, "u"));
/** A ref in a payload position: a snapshot cell, or a cited row / document span (R26). */
export const Ref = z.string().regex(new RegExp(`^${REF_SOURCE}$`, "u"));
export const RefId = z.string().regex(new RegExp(`^${REF_ID_SOURCE}$`, "u"));

export type Ref = z.infer<typeof Ref>;

export type ParsedRef =
  | { kind: "snap"; snapshot_id: string; row: number; column: string }
  | { kind: CiteKind; id: string; span: [number, number] | null };

/** Parse one ref token; null when it is not well-formed. Syntax only — accepts exactly what `Ref`
 *  accepts. Whether the snapshot / row / column / span exists in the tenant is the resolver's job. */
export function parseRef(token: string): ParsedRef | null {
  const s = SNAP_REF_CAPTURE.exec(token);
  if (s) return { kind: "snap", snapshot_id: s[1]!, row: Number(s[2]), column: s[3]! };
  const c = CITE_REF_CAPTURE.exec(token);
  if (!c) return null;
  const kind = (c[1] ?? c[3]) as CiteKind;
  const id = (c[2] ?? c[4])!;
  return { kind, id, span: c[5] === undefined ? null : [Number(c[5]), Number(c[6])] };
}

export function snapRef(snapshotId: string, row: number, column: string): string {
  return `${OPEN}snap:${snapshotId}${DOT}${row}${DOT}${column}${CLOSE}`;
}
export function citeRef(kind: CiteKind, id: string, span?: [number, number]): string {
  return `${OPEN}cite:${kind}:${id}${span ? `${DOT}${span[0]}-${span[1]}` : ""}${CLOSE}`;
}
