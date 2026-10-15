// file: lib/munim/cares-flow.ts
// Munim Cares on the staff side (14): who may do what, whether Cares is on for the outlet, the snapshot params the
// screen mints, reading an AI listing proposal, the ranked simulated recipients, and the command attempts for
// publishing, handing over and withdrawing. Every recipient is simulated; every quantity on screen is a row field or a
// snapshot cell; nothing here adds up a quantity. Plain TypeScript, no React.
import { attemptFor, type CommandAttempt } from "./commands";
import { formatQty, shownName } from "./format";
import { draftValue, parseRef, type DraftValue, type Snapshot } from "./refs";
import type { Role } from "./session";
import type { Schemas } from "./types";
import { uuidv7 } from "./uuid";

export type CaresProfile = Schemas["V1CaresProfile"];
export type Listing = Schemas["V1CaresListings"]["items"][number];
export type Recipient = Schemas["V1CaresRecipients"]["items"][number];
type Draft = Schemas["V1Draft"];
type Menu = Schemas["V1CatalogueMenu"];
type Ingredient = Schemas["V1InventoryIngredients"]["items"][number];

// ---- who may do what (core.command_authority, 0028; every snapshot template here is manager and up) ----
const ROLES = {
  /** Food at risk, ranked recipients, AI listing proposals, impact. Staff never see these panels (404 for them). */
  insight: ["owner", "manager", "judge"],
  /** Publish a listing, or approve / reject an AI listing proposal. A manager is refused (403), so they never see it. */
  publish: ["owner", "judge"],
  withdraw: ["owner", "manager", "judge"],
  handover: ["owner", "manager", "staff", "judge"],
} as const satisfies Record<string, readonly Role[]>;
export type CaresAction = keyof typeof ROLES;
export const caresCan = (role: Role, action: CaresAction): boolean => (ROLES[action] as readonly Role[]).includes(role);

// ---- is Cares on here? ----
export type CaresGate = "on" | "cares_not_available" | "cares_not_enabled" | "cares_paused" | "cares_not_opted_in";
/** In the order core refuses: the country pack, the operator's switch, the business's profile, the outlet. */
export function caresGate(p: CaresProfile, outletId: string): CaresGate {
  if (!p.available) return "cares_not_available";
  if (!p.enabled) return "cares_not_enabled";
  if (!p.profile || p.profile.status !== "active") return "cares_paused";
  return p.outlets.some((o) => o.outlet_id === outletId && o.active) ? "on" : "cares_not_opted_in";
}
export const GATE_TEXT: Record<Exclude<CaresGate, "on">, string> = {
  cares_not_available: "Munim Cares isn't available in this country yet.",
  cares_not_enabled: "Munim Cares isn't switched on for this business yet.",
  cares_paused: "Munim Cares is paused for this business.",
  cares_not_opted_in: "This outlet hasn't joined Munim Cares.",
};

// ---- snapshot params (the business date comes from GET /v1/catalogue/menu, never the tablet's clock) ----
/** "2026-10-14" -> "2026-10-01": a string edit, not date arithmetic. */
export const monthStart = (businessDate: string): string => `${businessDate.slice(0, 8)}01`;
/** Batches at this outlet expiring within the watcher's horizon (seven days) that may not be used in time. */
export const atRiskParams = (outletId: string, businessDate: string) => ({ outlet_id: outletId, days: 7, as_of: businessDate });
/** Food shared this month at this outlet: row 0 is the total. */
export const impactParams = (outletId: string, businessDate: string) => ({ outlet_id: outletId, from: monthStart(businessDate), to: businessDate });

/** The impact cells shown, in order, with the words around each (the first three as on owner home, 12). Every value
 *  is a cell of cares.impact row 0. */
export const IMPACT_CELLS = [
  { column: "handovers", label: "Hand-overs", after: "" },
  { column: "portions_milli", label: "Portions", after: "" },
  { column: "units_milli", label: "Packed items", after: "" },
  { column: "weight_g", label: "By weight", after: " g" },
  { column: "value_at_cost_minor", label: "Value at cost", after: "" },
] as const;

// ---- food at risk (inventory.expiry_risk rows) ----
export interface AtRiskRow {
  row: number;
  batchId: string;
  ingredientId: string;
  unit: string;
  expiresOn: string;
  /** A shop SKU is listed as packaged food; anything else as raw. */
  foodKind: "raw" | "packaged";
}
export function atRiskRows(s: Snapshot): AtRiskRow[] {
  return s.rows.flatMap((r, row) =>
    typeof r.batch_id === "string" && typeof r.ingredient_id === "string" && typeof r.unit === "string" && typeof r.expiry_on === "string"
      ? [{ row, batchId: r.batch_id, ingredientId: r.ingredient_id, unit: r.unit, expiresOn: r.expiry_on, foodKind: r.is_sku === true ? ("packaged" as const) : ("raw" as const) }]
      : [],
  );
}

// ---- ranked simulated recipients (cares.recipient_match rows; the row order IS the rank, best first) ----
export interface MatchRow {
  row: number;
  recipientId: string;
  /** The recipient's own name, which says "(simulated)". */
  name: string;
  fits: boolean;
  pickupFrom: string;
  pickupTo: string;
  pickupOn: string;
}
/** Only simulated rows (core lists no other kind; a row that says otherwise is never shown). */
export function matchRows(s: Snapshot): MatchRow[] {
  return s.rows.flatMap((r, row) =>
    r.simulated === true && typeof r.recipient_id === "string" && typeof r.name === "string" && typeof r.pickup_from === "string" && typeof r.pickup_to === "string" && typeof r.pickup_on === "string"
      ? [{ row, recipientId: r.recipient_id, name: r.name, fits: r.capacity_fit === true, pickupFrom: r.pickup_from, pickupTo: r.pickup_to, pickupOn: r.pickup_on }]
      : [],
  );
}

// ---- an AI listing proposal (cares.listing.publish.v1 draft) ----
export type ListingPayload = Extract<Draft["payload"], { listing_id: string; recipient_id: string | null }>;
export type ListingDraft = Draft & { payload: ListingPayload };
export const isListingDraft = (d: Draft): d is ListingDraft => d.command_type === "cares.listing.publish.v1";

export interface ListingDraftView {
  lines: { index: number; line: ListingPayload["lines"][number]; qty: DraftValue }[];
  /** The ranked recipients the proposal chose from (its based_on cites them), or null. */
  matchSnapshotId: string | null;
  /** The based_on ref of the pickup start, when it is the very value the payload carries (shown as its source). */
  pickupRef: string | null;
}

/** Reads a proposal: each quantity is a ref (or "Cannot verify"); the recipient and pickup times are plain values the
 *  code copied from the match row, cited in based_on. `unverified` = GET /v1/drafts/{id} unverified_refs. */
export function listingDraftView(d: ListingDraft, unverified: readonly string[]): ListingDraftView {
  const match = d.based_on.filter((b) => b.template_id === "cares.recipient_match");
  const first = match[0] ? parseRef(match[0].ref) : null;
  const pickup = match.find((b) => {
    const p = parseRef(b.ref);
    return p?.kind === "snap" && p.column === "pickup_from" && b.expected === d.payload.pickup_from;
  });
  return {
    lines: d.payload.lines.map((line, index) => ({ index, line, qty: draftValue(line.qty_milli, `/lines/${index}/qty_milli`, d.resolved_refs, unverified) })),
    matchSnapshotId: first?.kind === "snap" ? first.snapshotId : null,
    pickupRef: pickup?.ref ?? null,
  };
}

// ---- the owner's own listing (cares.listing.publish.v1, owner and judge) ----
export interface OwnListing {
  outletId: string;
  food: { kind: "cooked"; itemId: string } | { kind: "raw" | "packaged"; ingredientId: string; batchId: string | null };
  /** As typed, in thousandths of `unit` (parseTyped with a *_milli column). */
  qtyMilli: number;
  unit: string;
  expiresOn: string | null;
}
/** cares.recipient_match params for what the owner wants to list. */
export const matchParams = (f: OwnListing) => ({
  outlet_id: f.outletId,
  needs_cooked: f.food.kind === "cooked",
  needs_raw: f.food.kind === "raw",
  needs_packaged: f.food.kind === "packaged",
  qty_milli: f.qtyMilli,
  unit: f.unit,
  expires_on: f.expiresOn,
});

export type PublishAttempt = CommandAttempt<"cares.listing.publish.v1", Schemas["CaresListingPublishV1"]>;
/** A donation to the chosen simulated recipient, at the pickup window its match row gives (no time maths here). */
export function publishAttempt(prev: PublishAttempt | null, f: OwnListing, pick: MatchRow): PublishAttempt {
  return attemptFor(prev, JSON.stringify(["publish", f, pick.recipientId, pick.pickupFrom, pick.pickupTo]), "cares.listing.publish.v1", () => ({
    listing_id: uuidv7(),
    outlet_id: f.outletId,
    kind: "donation" as const,
    recipient_id: pick.recipientId,
    pickup_from: pick.pickupFrom,
    pickup_to: pick.pickupTo,
    lines: [{
      line_id: uuidv7(),
      food_kind: f.food.kind,
      item_id: f.food.kind === "cooked" ? f.food.itemId : null,
      ingredient_id: f.food.kind === "cooked" ? null : f.food.ingredientId,
      batch_id: f.food.kind === "cooked" ? null : f.food.batchId,
      qty_milli: f.qtyMilli,
      unit: f.unit,
      expires_on: f.expiresOn,
      unit_price_minor: null,
      currency: null,
    }],
  }));
}

/** Units a person may list in: cooked food in portions; stock in its base unit or the larger one core converts. */
export const unitsFor = (food: OwnListing["food"]["kind"], baseUnit: string | null): string[] =>
  food === "cooked" ? ["portion"] : baseUnit === "g" ? ["g", "kg"] : baseUnit === "ml" ? ["ml", "l"] : baseUnit ? [baseUnit] : [];

// ---- hand-over and withdraw ----
export const recordedHandovers = (l: Listing) => l.handovers.filter((h) => h.status === "recorded");
/** "Hand over everything listed" sends each line's listed quantity, so it is offered only while nothing has been
 *  handed over yet: anything else would need "listed minus handed", which the browser never works out. */
export const canHandOverAll = (l: Listing): boolean => l.status === "published" && recordedHandovers(l).length === 0;

export type HandoverAttempt = CommandAttempt<"cares.handover.record.v1", Schemas["CaresHandoverRecordV1"]>;
/** `typed` = "all", or the quantity typed per listing line id (thousandths; empty lines left out). Core checks the
 *  total against what was listed (409 qty_exceeds_listed) and closes the listing when everything is handed over. */
export function handoverAttempt(prev: HandoverAttempt | null, l: Listing, typed: "all" | Readonly<Record<string, number>>): HandoverAttempt {
  const lines = typed === "all"
    ? l.lines.map((x) => ({ listing_line_id: x.line_id, qty_milli: x.qty_milli }))
    : l.lines.flatMap((x) => (typed[x.line_id] ? [{ listing_line_id: x.line_id, qty_milli: typed[x.line_id]! }] : []));
  return attemptFor(prev, JSON.stringify(["handover", l.listing_id, lines]), "cares.handover.record.v1", () => ({
    handover_id: uuidv7(),
    listing_id: l.listing_id,
    allocation_id: null,
    lines,
  }));
}

export type WithdrawAttempt = CommandAttempt<"cares.listing.withdraw.v1", Schemas["CaresListingWithdrawV1"]>;
export const withdrawAttempt = (prev: WithdrawAttempt | null, listingId: string): WithdrawAttempt =>
  attemptFor(prev, JSON.stringify(["withdraw", listingId]), "cares.listing.withdraw.v1", () => ({ listing_id: listingId }));

// ---- words ----
export const FOOD_KIND: Record<string, string> = { cooked: "Cooked", raw: "Raw", packaged: "Packaged" };
const UNIT_WORDS: Record<string, [one: string, many: string]> = { piece: ["piece", "pieces"], portion: ["portion", "portions"] };
/** The unit in words for a label: "pieces", "portions", "g". */
export const unitLabel = (unit: string): string => (UNIT_WORDS[unit] ?? [unit, unit])[1];
/** "12 pieces", "1 portion", "400 ml": a row field or cell shown with its unit word. */
export const qtyText = (qtyMilli: number, unit: string, locale: string): string =>
  `${formatQty(qtyMilli, locale)} ${(UNIT_WORDS[unit] ?? [unit, unit])[qtyMilli === 1000 ? 0 : 1]}`;
/** A listing line's food: the menu's display name (cooked) or the ingredient's name (stock). Lines carry ids only. */
export function lineName(line: { item_id: string | null; ingredient_id: string | null }, menu: Menu | null, ingredients: readonly Ingredient[]): string {
  if (line.item_id) {
    const e = menu?.entries.find((x) => x.item_id === line.item_id);
    return e ? shownName(e) : "Menu item";
  }
  return ingredients.find((x) => x.ingredient_id === line.ingredient_id)?.name ?? "Stock item";
}
