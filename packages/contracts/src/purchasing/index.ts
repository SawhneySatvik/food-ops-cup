// Purchasing commands (02-schema §2.6) and read models. A PO exists only once committed; intel proposes
// purchasing.po.create.v1, purchasing.invoice.dispute.v1 and purchasing.supplier_return.create.v1 as drafts
// whose numbers are refs (approvals module, shared/draft.ts). Simulated suppliers (project rule 12) carry
// the literal label in every read model that names a supplier.
import { z } from "zod";
import { CurrencyCode, IsoDate, IsoDateTime, MinorAmount, NonEmpty, QtyMilli, Unit, Uuid7 } from "../shared/primitives.ts";
import { defineDraftable } from "../shared/draftables.ts";
import type { Route } from "../shared/routes.ts";

/** The one label (project rule 12; R7). Read models carry it for `kind = "simulated"`, null for real. */
export const SIMULATED_SUPPLIER_LABEL = "Simulated supplier";

const PriceObservation = z.strictObject({
  price_id: Uuid7,
  ingredient_id: Uuid7,
  unit: Unit,
  unit_price_minor: MinorAmount.nonnegative(),
  currency: CurrencyCode,
  observed_at: IsoDateTime,
  source_ref: NonEmpty,
});

export const PurchasingSupplierUpsertV1 = z.strictObject({
  supplier_id: Uuid7,
  name: NonEmpty,
  /** `simulated` suppliers are the suppliers-sim agents; always labelled "Simulated supplier" in read models.
   *  A supplier's kind is fixed once created. */
  kind: z.enum(["real", "simulated"]),
  a2a_card_url: z.string().regex(/^https?:\/\/\S+$/).max(500).nullable(),
  terms: z.strictObject({ payment_days: z.int().nonnegative(), notes: z.string().max(500).nullable() }),
  /** Price observations recorded with the supplier (core.supplier_price is written only by this command). */
  prices: z.array(PriceObservation).max(200),
});

export const PurchasingPoCreateV1 = z.strictObject({
  po_id: Uuid7,
  supplier_id: Uuid7,
  /** One outlet, or several for a pooled PO. */
  outlet_ids: z.array(Uuid7).min(1),
  currency: CurrencyCode,
  expected_on: IsoDate.nullable(),
  negotiation_run_id: Uuid7.nullable(),
  /** Line order is array order; core numbers the lines and totals the PO. */
  lines: z
    .array(
      z.strictObject({
        ingredient_id: Uuid7,
        qty_milli: QtyMilli.positive(),
        unit: Unit,
        unit_price_minor: MinorAmount.nonnegative(),
      }),
    )
    .min(1),
});

/** Goods received at one outlet, optionally against a PO. The receiver is the signed-in member. */
export const PurchasingGrnReceiveV1 = z.strictObject({
  grn_id: Uuid7,
  outlet_id: Uuid7,
  supplier_id: Uuid7,
  po_id: Uuid7.nullable(),
  received_at: IsoDateTime.nullable(),
  note: z.string().max(500).nullable(),
  lines: z
    .array(
      z.strictObject({
        grn_line_id: Uuid7,
        po_line_id: Uuid7.nullable(),
        ingredient_id: Uuid7,
        qty_milli: QtyMilli.positive(),
        unit: Unit,
        /** Null → the PO line's price (po_line_id required). */
        unit_cost_minor: MinorAmount.nonnegative().nullable(),
        currency: CurrencyCode,
        /** Required for batch-tracked ingredients, refused for the others. */
        batch: z
          .strictObject({ batch_id: Uuid7, batch_code: NonEmpty, expires_on: IsoDate.nullable(), mrp_minor: MinorAmount.positive().nullable() })
          .nullable(),
      }),
    )
    .min(1),
});

/** A supplier's invoice as recorded. Totals are core's: client-sent totals do not exist in this schema. */
export const PurchasingInvoiceRecordV1 = z.strictObject({
  supplier_invoice_id: Uuid7,
  supplier_id: Uuid7,
  invoice_no: NonEmpty,
  invoice_date: IsoDate,
  po_id: Uuid7.nullable(),
  currency: CurrencyCode,
  lines: z
    .array(
      z.strictObject({
        line_id: Uuid7,
        po_line_id: Uuid7.nullable(),
        ingredient_id: Uuid7.nullable(),
        description: NonEmpty.nullable(),
        qty_milli: QtyMilli.positive(),
        unit: Unit,
        unit_price_minor: MinorAmount.nonnegative(),
        tax_minor: MinorAmount.nonnegative(),
      }),
    )
    .min(1),
});

/** Owner/judge approval of a recorded invoice; core then derives the payable and the postings. */
export const PurchasingInvoiceApproveV1 = z.strictObject({ supplier_invoice_id: Uuid7 });

/** A dispute is recorded for the owner to send; Munim never sends it (finance pack §6). */
export const PurchasingInvoiceDisputeV1 = z.strictObject({
  dispute_id: Uuid7,
  supplier_invoice_id: Uuid7,
  basis: z.enum(["overbilled", "duplicate_invoice", "other"]),
  lines: z.array(z.strictObject({ invoice_line_id: Uuid7, claimed_minor: MinorAmount.positive() })).min(1),
});

/** Stock leaving for the supplier. The returning member and the unit cost come from core, never the payload. */
export const PurchasingSupplierReturnCreateV1 = z.strictObject({
  supplier_return_id: Uuid7,
  outlet_id: Uuid7,
  supplier_id: Uuid7,
  goods_received_id: Uuid7.nullable(),
  reason_code: z.string().regex(/^[a-z][a-z0-9_]*$/).max(40),
  note: NonEmpty,
  lines: z
    .array(z.strictObject({ batch_id: Uuid7.nullable(), ingredient_id: Uuid7, qty_milli: QtyMilli.positive(), unit: Unit }))
    .min(1),
});

/** A person asks the simulated suppliers to quote one ingredient for the outlets they choose (T-114; founder Q16 default:
 *  one ingredient, outlets inside the person's own scope). An RFQ to simulated suppliers is not books (R22): core records
 *  the request (audit), then starts the negotiation run under the person's identity. No quantity is typed: the RFQ
 *  quantity is the shortfall cell the run mints (pack inventory-purchasing §6), and a purchase order comes back only as a
 *  draft a person approves (R16). */
export const PurchasingRfqRequestV1 = z.strictObject({
  rfq_id: Uuid7,
  ingredient_id: Uuid7,
  outlet_ids: z.array(Uuid7).min(1).max(20).refine((a) => new Set(a).size === a.length, { message: "outlet_ids must be distinct" }),
});

/** core → intel `/negotiate` body (the run token rides as the bearer; its outlet scope is `outlet_ids`). Every value is
 *  core's own read of the tenant (tenant-trusted names, ADR-014 §6.4); intel still checks each supplier is simulated. */
export const IntelNegotiateRequest = z.strictObject({
  rfq_id: Uuid7,
  ingredient_id: Uuid7,
  /** The ingredient's name and base unit as core holds them (sent to the simulated suppliers). */
  item_name: NonEmpty,
  unit: Unit,
  currency: CurrencyCode,
  /** The tenant's country pack currency minor unit (rule 7: read from the pack, never coded). */
  minor_unit: z.int().min(0).max(4),
  outlet_ids: z.array(Uuid7).min(1).max(20),
  /** Active simulated suppliers with an agent card. */
  suppliers: z.array(z.strictObject({ supplier_id: Uuid7, kind: z.literal("simulated"), card_url: z.string().regex(/^https?:\/\/\S+$/).max(500) })).max(10),
  /** The items sold at those outlets: the run forecasts each (the shortfall and the deal review read the forecast). */
  item_ids: z.array(Uuid7).max(200),
});
/** intel → core: the run and what came of it — ids and a code only, never supplier text or a number. */
export const IntelNegotiateResponse = z.strictObject({
  run_id: Uuid7,
  status: z.enum([
    "drafted", "draft_refused", "no_shortfall", "no_suppliers", "no_reference_price", "no_quote", "no_passing_quote", "model_blocked", "not_simulated",
  ]),
  draft_id: Uuid7.nullable(),
});

/** Intel proposes purchase orders as drafts; executing one commits the PO. */
export const PO_CREATE_DRAFT = defineDraftable("purchasing.po.create.v1", PurchasingPoCreateV1);
export const INVOICE_DISPUTE_DRAFT = defineDraftable("purchasing.invoice.dispute.v1", PurchasingInvoiceDisputeV1);
export const SUPPLIER_RETURN_DRAFT = defineDraftable("purchasing.supplier_return.create.v1", PurchasingSupplierReturnCreateV1);
/** Invoice vision (T-056, ADR-014 §2.1): intel reads a supplier invoice into this draft; each number is a span of the
 *  document's text (`⟨cite:doc:<id>·<start>-<end>⟩`), shown beside the value. A span is not a cell, so the draft cannot
 *  execute as proposed: the approver types each number (R26) and core totals the invoice. Proposed only by the
 *  ingestion workflow, never by a model tool. */
export const INVOICE_RECORD_DRAFT = defineDraftable("purchasing.invoice.record.v1", PurchasingInvoiceRecordV1);

// ---- read models: row fields only (One Guarantee clause 2); no sums or aggregates ----
const SupplierRef = z.strictObject({
  supplier_id: Uuid7,
  name: NonEmpty,
  kind: z.enum(["real", "simulated"]),
  /** "Simulated supplier" when kind = simulated, else null. */
  label: z.literal(SIMULATED_SUPPLIER_LABEL).nullable(),
});

export const SupplierView = z.strictObject({
  ...SupplierRef.shape,
  a2a_card_url: z.string().nullable(),
  payment_days: z.int().nullable(),
  notes: z.string().nullable(),
  active: z.boolean(),
  /** Empty for staff (costs are not shown to them). */
  prices: z.array(PriceObservation),
});

export const PoView = z.strictObject({
  po_id: Uuid7,
  supplier: SupplierRef,
  outlet_ids: z.array(Uuid7),
  status: z.enum(["committed", "received", "cancelled"]),
  currency: CurrencyCode,
  total_minor: MinorAmount,
  expected_on: IsoDate.nullable(),
  negotiation_run_id: Uuid7.nullable(),
  created_at: IsoDateTime,
  lines: z.array(
    z.strictObject({ po_line_id: Uuid7, line_no: z.int(), ingredient_id: Uuid7, qty_milli: QtyMilli, unit: Unit, unit_price_minor: MinorAmount }),
  ),
});

export const GrnView = z.strictObject({
  grn_id: Uuid7,
  outlet_id: Uuid7,
  supplier: SupplierRef,
  po_id: Uuid7.nullable(),
  received_at: IsoDateTime,
  received_by: Uuid7,
  note: z.string().nullable(),
  lines: z.array(
    z.strictObject({
      grn_line_id: Uuid7,
      po_line_id: Uuid7.nullable(),
      ingredient_id: Uuid7,
      batch_id: Uuid7.nullable(),
      qty_milli: QtyMilli,
      unit: Unit,
      unit_cost_minor: MinorAmount,
      currency: CurrencyCode,
    }),
  ),
});

export const InvoiceView = z.strictObject({
  supplier_invoice_id: Uuid7,
  supplier: SupplierRef,
  invoice_no: z.string(),
  invoice_date: IsoDate,
  po_id: Uuid7.nullable(),
  subtotal_minor: MinorAmount,
  tax_minor: MinorAmount,
  total_minor: MinorAmount,
  currency: CurrencyCode,
  status: z.enum(["recorded", "approved", "disputed", "void"]),
  created_at: IsoDateTime,
  lines: z.array(
    z.strictObject({
      line_id: Uuid7,
      line_no: z.int(),
      po_line_id: Uuid7.nullable(),
      ingredient_id: Uuid7.nullable(),
      description: z.string().nullable(),
      qty_milli: QtyMilli,
      unit: Unit,
      unit_price_minor: MinorAmount,
      tax_minor: MinorAmount,
      line_total_minor: MinorAmount,
    }),
  ),
  /** The payable derived from this invoice once approved (its own row), else null. */
  payable: z.strictObject({ payable_id: Uuid7, due_on: IsoDate, amount_minor: MinorAmount, status: z.enum(["open", "paid", "disputed", "void"]) }).nullable(),
});

export const SupplierReturnView = z.strictObject({
  supplier_return_id: Uuid7,
  outlet_id: Uuid7,
  supplier: SupplierRef,
  goods_received_id: Uuid7.nullable(),
  reason_code: z.string(),
  note: z.string(),
  returned_by: Uuid7,
  returned_at: IsoDateTime,
  lines: z.array(
    z.strictObject({
      ingredient_id: Uuid7,
      batch_id: Uuid7.nullable(),
      qty_milli: QtyMilli,
      unit: Unit,
      /** Per one base unit, rounded. */
      unit_cost_minor: MinorAmount,
      /** The cost of 1000 base units (exact; the return's value is qty_milli × this ÷ 1,000,000). */
      unit_cost_per_1000_minor: MinorAmount,
      currency: CurrencyCode,
    }),
  ),
});

const list = <T extends z.ZodType>(item: T) => z.strictObject({ items: z.array(item) });

export const SCHEMAS = {
  "purchasing.supplier.upsert.v1": PurchasingSupplierUpsertV1,
  "purchasing.po.create.v1": PurchasingPoCreateV1,
  "purchasing.grn.receive.v1": PurchasingGrnReceiveV1,
  "purchasing.invoice.record.v1": PurchasingInvoiceRecordV1,
  "purchasing.invoice.approve.v1": PurchasingInvoiceApproveV1,
  "purchasing.invoice.dispute.v1": PurchasingInvoiceDisputeV1,
  "purchasing.supplier_return.create.v1": PurchasingSupplierReturnCreateV1,
  "purchasing.rfq.request.v1": PurchasingRfqRequestV1,
  "purchasing.intel-negotiate.request": IntelNegotiateRequest,
  "purchasing.intel-negotiate.response": IntelNegotiateResponse,
  "proposal.purchasing.po.create.v1": PO_CREATE_DRAFT.proposal,
  "proposal.purchasing.invoice.dispute.v1": INVOICE_DISPUTE_DRAFT.proposal,
  "proposal.purchasing.invoice.record.v1": INVOICE_RECORD_DRAFT.proposal,
  "proposal.purchasing.supplier_return.create.v1": SUPPLIER_RETURN_DRAFT.proposal,
  "v1.supplier": SupplierView,
  "v1.suppliers": list(SupplierView),
  "v1.purchase-order": PoView,
  "v1.purchase-orders": list(PoView),
  "v1.goods-received": GrnView,
  "v1.goods-received.list": list(GrnView),
  "v1.supplier-invoice": InvoiceView,
  "v1.supplier-invoices": list(InvoiceView),
  "v1.supplier-return": SupplierReturnView,
  "v1.supplier-returns": list(SupplierReturnView),
};

const id = [{ name: "id", uuid: true }];
const get = (path: string, operationId: string, summary: string, response: string, withId = false): Route => ({
  surface: "public", method: "get", path, operationId, summary, auth: "member", response, status: 200, ...(withId ? { pathParams: id } : {}),
});
const post = (path: string, operationId: string, command: string, summary: string, status: 200 | 201, withId = false): Route => ({
  surface: "public", method: "post", path, operationId, summary, auth: "member", command, response: "command-result", status, conflict: true,
  ...(withId ? { pathParams: id } : {}),
});

export const ROUTES: readonly Route[] = [
  get("/v1/suppliers", "listSuppliers", "Suppliers; simulated ones carry the label \"Simulated supplier\"", "v1.suppliers"),
  get("/v1/suppliers/{id}", "getSupplier", "One supplier with its price observations", "v1.supplier", true),
  post("/v1/suppliers", "upsertSupplier", "purchasing.supplier.upsert.v1", "purchasing.supplier.upsert.v1 — create or update a supplier (kind is fixed)", 201),
  get("/v1/purchase-orders", "listPurchaseOrders", "Purchase orders touching the caller's outlets (a pooled PO shows to each listed outlet's managers)", "v1.purchase-orders"),
  get("/v1/purchase-orders/{id}", "getPurchaseOrder", "One purchase order with its lines", "v1.purchase-order", true),
  post("/v1/purchase-orders", "createPurchaseOrder", "purchasing.po.create.v1", "purchasing.po.create.v1 — commit a purchase order (single or pooled)", 201),
  get("/v1/goods-received", "listGoodsReceived", "Goods received in the caller's outlets", "v1.goods-received.list"),
  get("/v1/goods-received/{id}", "getGoodsReceived", "One goods-received note with its lines", "v1.goods-received", true),
  post("/v1/goods-received", "receiveGoods", "purchasing.grn.receive.v1", "purchasing.grn.receive.v1 — receive goods (creates batches, stock movements and postings)", 201),
  get("/v1/supplier-invoices", "listSupplierInvoices", "Supplier invoices (not for staff)", "v1.supplier-invoices"),
  get("/v1/supplier-invoices/{id}", "getSupplierInvoice", "One supplier invoice with its lines and derived payable", "v1.supplier-invoice", true),
  post("/v1/supplier-invoices", "recordSupplierInvoice", "purchasing.invoice.record.v1", "purchasing.invoice.record.v1 — record an invoice; a repeated supplier + number is refused with 409", 201),
  post("/v1/supplier-invoices/{id}:approve", "approveSupplierInvoice", "purchasing.invoice.approve.v1", "purchasing.invoice.approve.v1 — approve a recorded invoice (owner); derives the payable", 200, true),
  post("/v1/supplier-invoices/{id}:dispute", "disputeSupplierInvoice", "purchasing.invoice.dispute.v1", "purchasing.invoice.dispute.v1 — record a dispute for the owner to send", 201, true),
  get("/v1/supplier-returns", "listSupplierReturns", "Supplier returns in the caller's outlets", "v1.supplier-returns"),
  post("/v1/supplier-returns", "createSupplierReturn", "purchasing.supplier_return.create.v1", "purchasing.supplier_return.create.v1 — return stock to a supplier", 201),
  post("/v1/rfq-requests", "requestQuotes", "purchasing.rfq.request.v1",
    "purchasing.rfq.request.v1 — ask the simulated suppliers to quote one ingredient for the chosen outlets; any purchase order comes back as a draft to approve", 201),
];
