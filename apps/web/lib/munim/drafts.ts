// file: lib/munim/drafts.ts
// The one module for AI drafts, used by the draft page (12), the Cares proposal card (14) and the purchase-order
// proposal card (15): the payload's numbers (each a ref, or a person's edit), who may decide a draft (core's rule),
// which buttons it gets, the payload sent with "Approve with my edits" ({ value, typed_by }), approve and reject as one
// frozen attempt each (01 §4), what every answer means (409 / 422), and the words for titles, sources, decisions and
// history. Nothing here decides anything by itself: every call starts from a person's tap. Nothing adds a number up:
// an edit replaces one leaf, whole, with what the person typed. Plain TypeScript, no React.
import type { MunimError, Result } from "./client";
import { attemptFor, retryable, type CommandAttempt } from "./commands";
import { titleCase } from "./format";
import { draftValue, parseRef, type DraftValue } from "./refs";
import type { Me, Role } from "./session";
import { ROLE_LABEL, specialistName, VERDICT } from "./staff-copy";
import type { Schemas } from "./types";

export type Draft = Schemas["V1Draft"];
export type DraftDetail = Schemas["V1DraftDetail"];
export type Decision = NonNullable<DraftDetail["decision"]>;
export type HistoryEntry = DraftDetail["history"][number];
export type StaleChange = NonNullable<HistoryEntry["changes"]>[number];
export type EditedPayload = NonNullable<Schemas["DraftsApproveV1"]["edited_payload"]>;
export type RejectCode = NonNullable<Schemas["DraftsRejectV1"]["reason_code"]>;
export type ApproveAttempt = CommandAttempt<"drafts.approve.v1", Schemas["DraftsApproveV1"]>;
export type RejectAttempt = CommandAttempt<"drafts.reject.v1", Schemas["DraftsRejectV1"]>;

const isEdit = (x: unknown): x is { value: number; typed_by: string } => typeof x === "object" && x !== null && "value" in x && "typed_by" in x;
const isRef = (x: unknown): x is string => typeof x === "string" && x.startsWith("⟨");

// ---------------------------------------------------------------- the numbers
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

// ---------------------------------------------------------------- who may decide it
/** core's rule (approvals decide.ts): drafts.approve.v1 (or drafts.reject.v1) AND the draft's own command type must
 *  both allow the role (core.command_authority, one row per type, below: every type core can draft). Both decide verbs
 *  are owner, manager, judge. A type not listed is refused, as core refuses a type with no authority row. */
const DECIDE: readonly Role[] = ["owner", "manager", "judge"];
const OWNER: readonly Role[] = ["owner", "judge"];
const TYPE_ROLES: Record<string, readonly Role[]> = {
  "cares.listing.publish.v1": OWNER,
  "catalogue.coupon.set.v1": DECIDE,
  "catalogue.deal.end.v1": DECIDE,
  "catalogue.price.set.v1": DECIDE,
  "catalogue.recipe.version.create.v1": DECIDE,
  "compliance.maintenance.schedule.v1": DECIDE,
  "customers.campaign.create.v1": DECIDE,
  "finance.dispute.draft.v1": OWNER,
  "finance.journal.adjust.v1": OWNER,
  "finance.period.close.v1": OWNER,
  "goals.goal.create.v1": DECIDE,
  "goals.task.create.v1": DECIDE,
  "imports.format.approve.v1": DECIDE,
  "imports.run.commit.v1": DECIDE,
  "inventory.reorder_level.set.v1": DECIDE,
  "inventory.transfer.create.v1": DECIDE,
  "kitchen.prep_list.create.v1": DECIDE,
  "kitchen.prep_time.set.v1": DECIDE,
  "people.payroll_draft.create.v1": OWNER,
  "people.roster.create.v1": DECIDE,
  "purchasing.invoice.dispute.v1": DECIDE,
  "purchasing.invoice.record.v1": DECIDE,
  "purchasing.po.create.v1": DECIDE,
  "purchasing.supplier_return.create.v1": DECIDE,
};
/** Types whose authority row is scoped to the whole business: only someone with every outlet may decide them. */
const WHOLE_BUSINESS = new Set([
  "catalogue.coupon.set.v1", "catalogue.deal.end.v1", "catalogue.recipe.version.create.v1", "customers.campaign.create.v1", "finance.dispute.draft.v1",
  "finance.journal.adjust.v1", "imports.format.approve.v1", "imports.run.commit.v1", "purchasing.invoice.dispute.v1", "purchasing.invoice.record.v1",
]);

export const mayDecide = (role: Role, commandType: string): boolean => DECIDE.includes(role) && (TYPE_ROLES[commandType] ?? []).includes(role);

/** Which decision buttons a draft gets. */
export type ApproveGate =
  /** Not proposed any more: no buttons. */
  | { kind: "closed" }
  /** This person's role or outlets cannot decide it: no buttons, one line saying who can. */
  | { kind: "not_for_you"; why: "staff" | "role" | "whole_business" | "outlets" }
  /** A snapshot cell this person cannot open, or a ref no field holds: Reject only. */
  | { kind: "untraceable" }
  /** These fields do not trace: "Approve" hidden; type each one, then "Approve with my edits". */
  | { kind: "type_first"; paths: string[] }
  /** Everything traces: "Approve", or "Edit" then "Approve with my edits". */
  | { kind: "open" };

/** The outlets a payload writes to, as core reads them (approvals decide.ts outletTargets): none = the whole business. */
const targetsOf = (payload: unknown): string[] => {
  const p = payload as { outlet_id?: unknown; outlet_ids?: unknown };
  return typeof p.outlet_id === "string" ? [p.outlet_id] : Array.isArray(p.outlet_ids) ? p.outlet_ids.filter((x): x is string => typeof x === "string") : [];
};

export function approveGate(d: DraftDetail, fields: readonly NumericField[], me: Me): ApproveGate {
  if (d.draft.status !== "proposed") return { kind: "closed" };
  if (!DECIDE.includes(me.role)) return { kind: "not_for_you", why: "staff" };
  if (!mayDecide(me.role, d.draft.command_type)) return { kind: "not_for_you", why: "role" };
  // Core judges every one of the draft's outlets and every outlet its payload writes to; none means the whole
  // business, which needs every outlet, as does a whole-business command type.
  const targets = targetsOf(d.draft.payload);
  const mine = me.outlet_ids;
  if (mine !== "*" && (d.draft.outlet_ids.length === 0 || targets.length === 0 || WHOLE_BUSINESS.has(d.draft.command_type))) return { kind: "not_for_you", why: "whole_business" };
  if (mine !== "*" && [...d.draft.outlet_ids, ...targets].some((o) => !mine.includes(o))) return { kind: "not_for_you", why: "outlets" };
  const held = new Set(fields.flatMap((f) => (f.value.kind === "unverified" ? [f.value.ref] : [])));
  // Typing over a snapshot cell does not help: core re-reads the cells a draft was based on under the approver's
  // scope and refuses with cannot_verify. And a ref no field holds (a based_on cell) has nothing to type into. Only a
  // quoted value (a simulated supplier's price, ⟨cite:…⟩) can be replaced by the value the person checked.
  if (d.unverified_refs.some((r) => !held.has(r) || parseRef(r)?.kind === "snap")) return { kind: "untraceable" };
  const paths = fields.filter((f) => f.value.kind === "unverified").map((f) => f.path);
  return paths.length > 0 ? { kind: "type_first", paths } : { kind: "open" };
}

/** The line above the decision buttons, or null. */
export function gateLine(g: ApproveGate, commandType: string): string | null {
  if (g.kind === "not_for_you") {
    if (g.why === "staff") return "Owners and managers decide proposals.";
    if (g.why === "whole_business") return "Only the owner can decide this one: it changes the whole business.";
    if (g.why === "outlets") return "Only the owner can decide this one: it covers outlets beyond yours.";
    return commandType === "cares.listing.publish.v1" ? "Only the owner can approve or reject a donation." : "Only the owner can decide this one.";
  }
  if (g.kind === "untraceable") return "Some numbers this draft relies on can't be opened with your access, so it can't be approved. You can reject it.";
  if (g.kind === "type_first") return "Some numbers in this draft don't trace to your books. Type the values you checked, or reject it.";
  return null;
}

/** "Approve with my edits" is enabled once at least one value is typed, every untraced field has one, and the reason
 *  box holds 1–500 characters. `edits` is keyed by JSON Pointer path, in the field's own units (parseTyped). */
export function editsReady(gate: ApproveGate, edits: Readonly<Record<string, number>>, reason: string): boolean {
  if (gate.kind !== "open" && gate.kind !== "type_first") return false;
  const r = reason.trim();
  const covered = gate.kind === "open" || gate.paths.every((p) => p in edits);
  return Object.keys(edits).length > 0 && covered && r.length >= 1 && r.length <= 500;
}

/** The edited_payload: the proposed payload with each edited leaf replaced, whole, by {value, typed_by: <the
 *  approver's member_id>} (R26). Every other ref stays exactly as proposed (core checks that it is the same ref at the
 *  same path, and that typed_by is the person approving). */
export function withEdits(payload: Draft["payload"], edits: Readonly<Record<string, number>>, memberId: string): EditedPayload {
  const copy = structuredClone(payload) as unknown as Record<string, unknown>;
  for (const [path, value] of Object.entries(edits)) {
    const keys = path.split("/").slice(1);
    let at = copy;
    for (const k of keys.slice(0, -1)) at = at[k] as Record<string, unknown>;
    at[keys[keys.length - 1]!] = { value, typed_by: memberId };
  }
  return copy as unknown as EditedPayload;
}

// ---------------------------------------------------------------- deciding it
/** Approve as proposed (`edited` null, `reason` null) or with the person's edits (withEdits, and a reason). The same
 *  inputs again = the same attempt (a retry). */
export function approveAttempt(prev: ApproveAttempt | null, draft: { draft_id: string; command_type: string }, edited: EditedPayload | null, reason: string | null): ApproveAttempt {
  return attemptFor(prev, JSON.stringify(["approve", draft.draft_id, edited, reason]), "drafts.approve.v1", () => ({
    draft_id: draft.draft_id,
    command_type: draft.command_type,
    edited_payload: edited,
    reason,
  }));
}

/** Reject always carries a reason code and a note (1–500 characters). */
export function rejectAttempt(prev: RejectAttempt | null, draftId: string, code: RejectCode, note: string): RejectAttempt {
  return attemptFor(prev, JSON.stringify(["reject", draftId, code, note]), "drafts.reject.v1", () => ({ draft_id: draftId, reason: note, reason_code: code }));
}

/** What an approve or reject answer means for the screen that sent it. */
export type Outcome =
  /** Approve answers the EXECUTED command's type and entity (a PO, a listing); reject answers drafts.reject.v1. */
  | { kind: "done"; type: string; entityId: string }
  /** network, 429 or 5xx: the same attempt may be sent again (after error.retryAfterMs on a 429) */
  | { kind: "retry"; error: MunimError }
  /** 409 stale_draft: the cells behind it moved; the draft is now "stale" and can no longer be approved or rejected */
  | { kind: "stale" }
  /** 409 already_decided: someone else decided first */
  | { kind: "decided_elsewhere" }
  /** 422 cannot_verify: a number no longer traces; refetch the draft, its fields show "Cannot verify" */
  | { kind: "cannot_verify"; error: MunimError }
  /** 422 execution_failed: approved but not applied; nothing changed */
  | { kind: "failed_to_apply"; error: MunimError }
  | { kind: "signed_out"; error: MunimError }
  | { kind: "not_found" }
  /** any other refusal (403 authority_denied, a reason code from the command): show staffErrorText */
  | { kind: "refused"; error: MunimError };

export function outcomeOf(r: Result<Schemas["CommandResult"]>): Outcome {
  if (r.ok) return { kind: "done", type: r.data.type, entityId: r.data.entity_id };
  const e = r.error;
  if (e.status === 401) return { kind: "signed_out", error: e };
  if (e.kind === "not_found") return { kind: "not_found" };
  if (retryable(e)) return { kind: "retry", error: e };
  if (e.code === "stale_draft") return { kind: "stale" };
  if (e.code === "already_decided") return { kind: "decided_elsewhere" };
  if (e.code === "cannot_verify") return { kind: "cannot_verify", error: e };
  if (e.code === "execution_failed") return { kind: "failed_to_apply", error: e };
  return { kind: "refused", error: e };
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
  "customers.campaign.create.v1": "A message to regulars who stopped coming",
};
/** What a draft proposes, in words, from its command type. */
export const draftTitle = (commandType: string): string => TITLE[commandType] ?? "A proposed change";

const FINDING: Record<string, string> = {
  "inventory.waste_spike": "More waste than a usual week",
  "kitchen.ticket_drift": "Tickets running past their prep time",
  "inventory.expiry_risk": "Food at risk of going to waste",
  "customers.regulars_lapsing": "Regulars who have stopped coming",
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
  audience_count: "Customers it would reach",
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

/** The lineage line under a draft (02 §5): who proposed it and when, the finding it came from, and who decided it.
 *  Names come from the decision (decided_by.name), never from the model. */
export function lineageLine(d: DraftDetail, when: (iso: string) => string, finding: string | null): string {
  const parts = [`Proposed by ${sourceName(d.draft.source)} · ${when(d.draft.created_at)}`];
  if (d.draft.finding_id) parts.push(finding ? `from a finding: ${finding}` : "from a finding");
  if (d.decision) parts.push(`${VERDICT[d.decision.verdict]} by ${personName(d.decision.decided_by)} · ${when(d.decision.decided_at)}`);
  return parts.join(" · ");
}
