// file: lib/munim/supply-flow.ts
// Suppliers on the staff side (15): stock below its minimum, an AI purchase-order proposal and the simulated
// suppliers' quotes behind it, the approver's typed prices, a person's own purchase order, and goods received.
// Every supplier here is simulated. No line total, PO total, reorder quantity or "cheaper by" is worked out in the
// browser: core totals every PO, and a person types every quantity and price. Plain TypeScript, no React.
import type { MunimError } from "./client";
import { attemptFor, type CommandAttempt } from "./commands";
import { draftValue, parseRef, type DraftValue, type Snapshot } from "./refs";
import { staffErrorText } from "./staff-copy";
import type { Schemas } from "./types";
import { uuidv7 } from "./uuid";

type Draft = Schemas["V1Draft"];
export type Supplier = Schemas["V1Supplier"];
export type PurchaseOrder = Schemas["V1PurchaseOrder"];
export type GoodsReceived = Schemas["V1GoodsReceived"];
type Ingredient = Schemas["V1InventoryIngredients"]["items"][number];

/** Owner, manager and judge (CAN.suppliers; purchasing.po.create.v1 and drafts.approve.v1). */
export const SUPPLIER_ROLES = ["owner", "manager", "judge"] as const;

// ---- stock below its minimum (inventory.below_reorder rows: tenant-wide, so keep this outlet's) ----
export interface LowRow {
  row: number;
  ingredientId: string;
  /** The ingredient's own name (a text cell). */
  name: string;
}
export const lowRowsFor = (s: Snapshot, outletId: string): LowRow[] =>
  s.rows.flatMap((r, row) => (r.outlet_id === outletId && typeof r.ingredient_id === "string" ? [{ row, ingredientId: r.ingredient_id, name: String(r.ingredient_name ?? "") }] : []));

// ---- an AI purchase-order proposal (purchasing.po.create.v1 draft) ----
export type PoPayload = Extract<Draft["payload"], { po_id: string; negotiation_run_id: string | null }>;
export type PoDraft = Draft & { payload: PoPayload };
export const isPoDraft = (d: Draft): d is PoDraft => d.command_type === "purchasing.po.create.v1";

export interface PoDraftLine {
  index: number;
  line: PoPayload["lines"][number];
  /** Quantity and price are cells of the negotiation's quote comparison (core's negotiation review): each with its
   *  chip, or "Cannot verify" for a person who may not open that snapshot (the run's outlet scope). */
  qty: DraftValue;
  price: DraftValue;
  /** The quote comparison row the price cites. The viewer's own comparison of the same negotiation lists the same
   *  quotes in the same order (core sorts by round, then supplier), so this row is marked "Proposed" there. */
  quoteRow: number | null;
}
export function poDraftLines(d: PoDraft, unverified: readonly string[]): PoDraftLine[] {
  return d.payload.lines.map((line, index) => {
    const cited = parseRef(String(line.unit_price_minor));
    return {
      index,
      line,
      qty: draftValue(line.qty_milli, `/lines/${index}/qty_milli`, d.resolved_refs, unverified),
      price: draftValue(line.unit_price_minor, `/lines/${index}/unit_price_minor`, d.resolved_refs, unverified),
      quoteRow: cited?.kind === "snap" ? cited.row : null,
    };
  });
}

// ---- the simulated suppliers' quotes (purchasing.quote_compare, minted by the viewer for the negotiation) ----
export const quoteParams = (negotiationRunId: string) => ({ negotiation_run_id: negotiationRunId });
export interface QuoteRow {
  row: number;
  quoteId: string;
  supplierId: string;
}
export const quoteRows = (s: Snapshot): QuoteRow[] =>
  s.rows.flatMap((r, row) => (typeof r.quote_id === "string" && typeof r.supplier_id === "string" ? [{ row, quoteId: r.quote_id, supplierId: r.supplier_id }] : []));

// ---- a person's own purchase order (purchasing.po.create.v1) ----
export interface NewPoLine {
  ingredientId: string;
  /** Typed, in thousandths of `unit`. */
  qtyMilli: number;
  unit: string;
  /** Typed, in minor units per one `unit`. */
  unitPriceMinor: number;
}
export type CreatePoAttempt = CommandAttempt<"purchasing.po.create.v1", Schemas["PurchasingPoCreateV1"]>;
/** One outlet (the one the person is working in). Core numbers the lines and works out the total. */
export function newPoAttempt(prev: CreatePoAttempt | null, input: { supplierId: string; outletId: string; currency: string; expectedOn: string | null; lines: readonly NewPoLine[] }): CreatePoAttempt {
  return attemptFor(prev, JSON.stringify(["po", input]), "purchasing.po.create.v1", () => ({
    po_id: uuidv7(),
    supplier_id: input.supplierId,
    outlet_ids: [input.outletId],
    currency: input.currency,
    expected_on: input.expectedOn,
    negotiation_run_id: null,
    lines: input.lines.map((l) => ({ ingredient_id: l.ingredientId, qty_milli: l.qtyMilli, unit: l.unit, unit_price_minor: l.unitPriceMinor })),
  }));
}
/** Units a person may order in: the ingredient's base unit or the larger one core converts. */
export const orderUnits = (baseUnit: string): string[] => (baseUnit === "g" ? ["kg", "g"] : baseUnit === "ml" ? ["l", "ml"] : [baseUnit]);

// ---- goods received (purchasing.grn.receive.v1) ----
export interface ReceiveLine {
  poLineId: string;
  ingredientId: string;
  /** Typed, in thousandths of `unit` (or the PO line's own quantity for "Received in full"). */
  qtyMilli: number;
  unit: string;
  /** Required for a batch-tracked ingredient, null for the others (core refuses either mistake with 400). */
  batch: { code: string; expiresOn: string | null } | null;
}
/** "Received in full" sends each PO line's own quantity, so it is offered only before any goods came in against the PO
 *  (anything else would need "ordered minus received", which the browser never works out). */
export const canReceiveInFull = (po: PurchaseOrder, grns: readonly GoodsReceived[]): boolean =>
  po.status === "committed" && !grns.some((g) => g.po_id === po.po_id);
export const fullLines = (po: PurchaseOrder, ingredients: readonly Ingredient[], batch: (poLineId: string) => ReceiveLine["batch"]): ReceiveLine[] =>
  po.lines.map((l) => ({ poLineId: l.po_line_id, ingredientId: l.ingredient_id, qtyMilli: l.qty_milli, unit: l.unit, batch: ingredients.find((i) => i.ingredient_id === l.ingredient_id)?.tracked_by_batch ? batch(l.po_line_id) : null }));

export type ReceiveAttempt = CommandAttempt<"purchasing.grn.receive.v1", Schemas["PurchasingGrnReceiveV1"]>;
/** The cost of each line is the PO line's price (unit_cost_minor null); core stamps the time and the receiver. */
export function receiveAttempt(prev: ReceiveAttempt | null, po: PurchaseOrder, outletId: string, lines: readonly ReceiveLine[], note: string | null): ReceiveAttempt {
  return attemptFor(prev, JSON.stringify(["grn", po.po_id, outletId, lines, note]), "purchasing.grn.receive.v1", () => ({
    grn_id: uuidv7(),
    outlet_id: outletId,
    supplier_id: po.supplier.supplier_id,
    po_id: po.po_id,
    received_at: null,
    note,
    lines: lines.map((l) => ({
      grn_line_id: uuidv7(),
      po_line_id: l.poLineId,
      ingredient_id: l.ingredientId,
      qty_milli: l.qtyMilli,
      unit: l.unit,
      unit_cost_minor: null,
      currency: po.currency,
      batch: l.batch ? { batch_id: uuidv7(), batch_code: l.batch.code, expires_on: l.batch.expiresOn, mrp_minor: null } : null,
    })),
  }));
}

/** Goods-received refusals carry no reason code: name them here, by code. */
export function receiveErrorText(e: MunimError): string {
  if (e.code === "conflict" && !e.reasonCode) return "This purchase order was already received or cancelled. It has been refreshed.";
  if (e.code === "bad_request") return "Check each line's quantity and batch code, then try again.";
  return staffErrorText(e, "suppliers");
}

/** An ingredient's name and base unit; lines and rows carry ids only. */
// ---- a request for quotes (purchasing.rfq.request.v1): the simulated suppliers quote one ingredient for chosen outlets ----
export type RfqAttempt = CommandAttempt<"purchasing.rfq.request.v1", Schemas["PurchasingRfqRequestV1"]>;

/** One attempt per ingredient and set of outlets confirmed: tapping again for the same sends the same envelope, so a lost
 *  answer never starts a second negotiation. No quantity is typed: core asks for the shortfall it reads itself. */
export function rfqAttempt(prev: RfqAttempt | null, ingredientId: string, outletIds: readonly string[]): RfqAttempt {
  const outlets = [...outletIds].sort();
  return attemptFor(prev, JSON.stringify([ingredientId, outlets]), "purchasing.rfq.request.v1", () => ({ rfq_id: uuidv7(), ingredient_id: ingredientId, outlet_ids: outlets }));
}

export interface RfqOutcome {
  text: string;
  /** The purchase-order draft to open, when one was made. */
  draftId: string | null;
  /** A draft waits in the inbox (or may: a replay cannot say). */
  inbox: boolean;
}

const RFQ_WORDS: Record<string, string> = {
  drafted: "Quotes requested — a purchase order is waiting for approval.",
  draft_refused: "Quotes came back, but no purchase order could be drafted from them. Nothing is waiting for approval.",
  no_shortfall: "No shortfall yet. What's on hand covers the coming days, so no supplier was asked.",
  no_suppliers: "No simulated supplier can be asked for quotes yet. Nothing was sent.",
  no_reference_price: "No supplier has a recorded price for this yet, so there is nothing to weigh quotes against. Nothing was sent.",
  no_quote: "No supplier could quote. Nothing was drafted.",
  no_passing_quote: "Quotes came back, but none fit the budget and terms. Nothing was drafted.",
  model_blocked: "AI is switched off or this month's AI budget is spent, so no supplier reply can be read. Nothing was sent.",
  not_simulated: "Only simulated suppliers can be asked. Nothing was sent.",
};

/** What came of a request for quotes, from core's status header. None (a replay of the same tap): the request is on record
 *  and its draft, if any, is in the inbox. */
export function rfqOutcome(negotiation: string | null, draftId: string | null): RfqOutcome {
  if (negotiation === null) return { text: "Quotes were already requested with this tap. Any purchase order drafted from them is in your inbox.", draftId: null, inbox: true };
  const text = RFQ_WORDS[negotiation];
  if (!text) return { text: "Quotes requested. Any purchase order drafted from them is in your inbox.", draftId: null, inbox: true };
  return { text, draftId: negotiation === "drafted" ? draftId : null, inbox: negotiation === "drafted" };
}

/** The answer was lost on the way back (a dropped connection, the browser's timeout or a gateway's 504): core may have the
 *  request, so only the same envelope may be sent again. */
export const lostRfq = (e: MunimError): boolean => e.kind === "network" || e.status === 504;

/** A request for quotes that failed. 503: core recorded the request but could not reach the negotiation, so nothing was drafted
 *  and the next tap is a new request. A dropped connection may have reached core: look in the inbox before asking again. */
export function rfqErrorText(e: MunimError): string {
  if (lostRfq(e)) return "The connection dropped while the simulated suppliers were being asked. Look in your inbox for a purchase order before asking again; tapping again is safe.";
  if (e.status === 503) return "The simulated suppliers couldn't be asked just now. Nothing was drafted. Try again in a moment.";
  return staffErrorText(e, "suppliers");
}

export const ingredientOf = (ingredients: readonly Ingredient[], id: string): { name: string; baseUnit: string } => {
  const i = ingredients.find((x) => x.ingredient_id === id);
  return { name: i?.name ?? "Stock item", baseUnit: i?.base_unit ?? "" };
};
