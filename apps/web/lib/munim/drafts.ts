// file: lib/munim/drafts.ts
// What the inbox and the draft page need beyond 02's DraftField: the payload's numeric fields (each a ref, or a
// person's edit), the approve rule (20 §3.2), the payload sent with "Approve with my edits", and the words for titles,
// sources, decisions and history. Plain TypeScript, no React. Nothing here adds a number up: a person's edit replaces
// one leaf, whole, with what they typed.
import { titleCase } from "./format";
import { draftValue, parseRef, type DraftValue } from "./refs";
import type { Me } from "./session";
import { ROLE_LABEL, specialistName, VERDICT } from "./staff-copy";
import type { Schemas } from "./types";

export type Draft = Schemas["V1Draft"];
export type DraftDetail = Schemas["V1DraftDetail"];
export type Decision = NonNullable<DraftDetail["decision"]>;
export type HistoryEntry = DraftDetail["history"][number];
export type StaleChange = NonNullable<HistoryEntry["changes"]>[number];
export type EditablePayload = NonNullable<Schemas["DraftsApproveV1"]["edited_payload"]>;

const isEdit = (x: unknown): x is { value: number; typed_by: string } => typeof x === "object" && x !== null && "value" in x && "typed_by" in x;
const isRef = (x: unknown): x is string => typeof x === "string" && x.startsWith("⟨");

export interface NumericField {
  /** JSON Pointer into the payload ("/lines/0/unit_price_minor"): the key for resolved_refs and for edits. */
  path: string;
  /** The payload field's name: formats the value (formatCell) and names the unit (unitOf). */
  column: string;
  /** The payload line the field sits on (payload.lines[i]: its ingredient or item, its unit); null at the top level. */
  line: Record<string, unknown> | null;
  value: DraftValue;
}

/** Every numeric field of a draft, in payload order. The contract admits no bare number in a draft payload: each one
 *  is a ref (as proposed) or `{value, typed_by}` (a person's edit). */
export function numericFields(d: DraftDetail): NumericField[] {
  const out: NumericField[] = [];
  const walk = (x: unknown, path: string, column: string, line: Record<string, unknown> | null): void => {
    if (isRef(x) || isEdit(x)) {
      out.push({ path, column, line, value: draftValue(x, path, d.draft.resolved_refs, d.unverified_refs) });
    } else if (Array.isArray(x)) {
      x.forEach((v, i) => walk(v, `${path}/${i}`, column, line));
    } else if (typeof x === "object" && x !== null) {
      const o = x as Record<string, unknown>;
      const isLine = /^\/lines\/\d+$/.test(path);
      for (const [k, v] of Object.entries(o)) walk(v, `${path}/${k}`, k, isLine ? o : line);
    }
  };
  walk(d.draft.payload, "", "", null);
  return out;
}

/** Which decision buttons a draft gets. */
export type ApproveGate =
  /** Not proposed any more: no buttons. */
  | { kind: "closed" }
  /** This person's role or outlets cannot decide it: no buttons, one line saying who can. */
  | { kind: "not_for_you" }
  /** A snapshot cell this person cannot open, or a ref no field holds: Reject only. */
  | { kind: "untraceable" }
  /** These fields do not trace: "Approve" hidden; type each one, then "Approve with my edits". */
  | { kind: "type_first"; paths: string[] }
  /** Everything traces: "Approve", or "Edit" then "Approve with my edits". */
  | { kind: "open" };

/** Roles that may decide a draft (core's authority for drafts.approve.v1 / drafts.reject.v1). Deciding also needs the
 *  draft's own command's authority (core's roleAllowed): a Cares listing is owner and judge only (14 §1). */
const DECIDERS: readonly string[] = ["owner", "manager", "judge"];
const DECIDERS_BY_TYPE: Readonly<Record<string, readonly string[]>> = { "cares.listing.publish.v1": ["owner", "judge"] };

export function approveGate(d: DraftDetail, fields: readonly NumericField[], me: Me): ApproveGate {
  if (d.draft.status !== "proposed") return { kind: "closed" };
  // A draft for the whole business (no outlets) is decided by someone who has every outlet (core: owner-level).
  if (!(DECIDERS_BY_TYPE[d.draft.command_type] ?? DECIDERS).includes(me.role) || (d.draft.outlet_ids.length === 0 && me.outlet_ids !== "*")) return { kind: "not_for_you" };
  const held = new Set(fields.flatMap((f) => (f.value.kind === "unverified" ? [f.value.ref] : [])));
  // Typing over a snapshot cell does not help: core re-reads the cells a draft was based on under the approver's
  // scope and refuses with cannot_verify. And a ref no field holds (a based_on cell) has nothing to type into. Only a
  // quoted value (a simulated supplier's price, ⟨cite:…⟩) can be replaced by the value the person checked.
  if (d.unverified_refs.some((r) => !held.has(r) || parseRef(r)?.kind === "snap")) return { kind: "untraceable" };
  const paths = fields.filter((f) => f.value.kind === "unverified").map((f) => f.path);
  return paths.length > 0 ? { kind: "type_first", paths } : { kind: "open" };
}

/** "Approve with my edits" is enabled once at least one value is typed, every untraced field has one, and the reason
 *  box holds 1–500 characters. */
export function editsReady(gate: ApproveGate, edits: Readonly<Record<string, number>>, reason: string): boolean {
  if (gate.kind !== "open" && gate.kind !== "type_first") return false;
  const r = reason.trim();
  const covered = gate.kind === "open" || gate.paths.every((p) => p in edits);
  return Object.keys(edits).length > 0 && covered && r.length >= 1 && r.length <= 500;
}

/** The edited_payload: the proposed payload with each edited leaf replaced, whole, by {value, typed_by: <the
 *  approver's member_id>}. Every other ref stays exactly as proposed (core checks that it is the same ref at the same
 *  path, and that typed_by is the person approving). */
export function withEdits(payload: Draft["payload"], edits: Readonly<Record<string, number>>, memberId: string): EditablePayload {
  const copy = structuredClone(payload) as unknown as Record<string, unknown>;
  for (const [path, value] of Object.entries(edits)) {
    const keys = path.split("/").slice(1);
    let at = copy;
    for (const k of keys.slice(0, -1)) at = at[k] as Record<string, unknown>;
    at[keys[keys.length - 1]!] = { value, typed_by: memberId };
  }
  return copy as unknown as EditablePayload;
}

/** The cells that changed since the draft was proposed (a stale draft's history), each with its old and new ref. */
export const staleChanges = (d: DraftDetail): StaleChange[] => d.history.flatMap((h) => h.changes ?? []);

// ---------------------------------------------------------------- words
const TITLE: Record<string, string> = {
  "kitchen.prep_time.set.v1": "Change an item's prep time",
  "kitchen.prep_list.create.v1": "A prep list",
  "purchasing.po.create.v1": "A purchase order",
  "purchasing.invoice.dispute.v1": "Dispute a supplier invoice",
  "purchasing.supplier_return.create.v1": "Send goods back to a supplier",
  "inventory.reorder_level.set.v1": "Change a reorder level",
  "inventory.transfer.create.v1": "Move stock between outlets",
  "catalogue.price.set.v1": "Change a price",
  "catalogue.recipe.version.create.v1": "A new recipe version",
  "catalogue.deal.end.v1": "End a deal",
  "cares.listing.publish.v1": "List surplus food on Munim Cares",
  "goals.task.create.v1": "A task for the team",
};
/** What a draft proposes, in words, from its command type. */
export const draftTitle = (commandType: string): string => TITLE[commandType] ?? "A proposed change";

const FINDING: Record<string, string> = {
  "inventory.waste_spike": "More waste than a usual week",
  "kitchen.ticket_drift": "Tickets running past their prep time",
  "inventory.expiry_risk": "Stock close to its use-by date",
};
/** What a finding is about, from its type. */
export const findingTitle = (type: string): string => FINDING[type] ?? titleCase(type);

const FIELD: Record<string, string> = {
  prep_sec: "Prep time",
  qty_milli: "Quantity",
  unit_price_minor: "Price",
  price_minor: "Price",
  min_qty_milli: "Minimum",
  par_qty_milli: "Par level",
  min_spend_minor: "Minimum spend",
};
/** A numeric field's label, from its payload name. */
export const fieldLabel = (column: string): string => FIELD[column] ?? titleCase(column);

/** Who proposed it: the specialist for "intel:<pack>", else an import or a person. */
export const sourceName = (source: string): string =>
  source.startsWith("intel:") ? specialistName(source.slice("intel:".length)) : source === "import" ? "An import" : "A team member";

/** A person as core names them; the name is null for a member who has none. */
export const personName = (p: { name: string | null }): string => p.name ?? "a team member";

const EVENT: Record<string, string> = {
  proposed: "Proposed",
  approved: "Approved",
  edited: "Approved with edits",
  rejected: "Rejected",
  executing: "Applying",
  executed: "Applied",
  failed: "Couldn't apply",
  stale: "Out of date",
};
/** One history row in words: "Approved with edits · Nandini Mehrotra (demo)". */
export function historyWords(h: HistoryEntry): string {
  const by = typeof h.by === "string" ? sourceName(h.by) : "name" in h.by ? personName(h.by) : (ROLE_LABEL[h.by.role] ?? "A team member");
  return `${EVENT[h.event] ?? titleCase(h.event)} · ${by}`;
}

/** The lineage line under a draft (02 §5): who proposed it and when, the finding it came from, and who decided it. */
export function lineageLine(d: DraftDetail, when: (iso: string) => string, finding: string | null): string {
  const parts = [`Proposed by ${sourceName(d.draft.source)} · ${when(d.draft.created_at)}`];
  if (d.draft.finding_id) parts.push(finding ? `from a finding: ${finding}` : "from a finding");
  if (d.decision) parts.push(`${VERDICT[d.decision.verdict]} by ${personName(d.decision.decided_by)} · ${when(d.decision.decided_at)}`);
  return parts.join(" · ");
}
