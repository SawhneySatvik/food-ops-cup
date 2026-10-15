import { S1, T, citeRef, snapRef, u } from "./_ids.ts";

export const poCreate = {
  po_id: u(60),
  supplier_id: u(50),
  outlet_ids: [u(2)],
  currency: "INR",
  expected_on: "2026-10-11",
  negotiation_run_id: null,
  lines: [{ ingredient_id: u(40), qty_milli: 12000, unit: "kg", unit_price_minor: 34000 }],
};

const supplier = { supplier_id: u(50), name: "Steady Dairy", kind: "simulated", label: "Simulated supplier" };
const realSupplier = { supplier_id: u(51), name: "Local Mandi Traders", kind: "real", label: null };
const priceObs = { price_id: u(52), ingredient_id: u(40), unit: "kg", unit_price_minor: 34000, currency: "INR", observed_at: T, source_ref: "quote:fixture" };
const poLine = { po_line_id: u(61), line_no: 1, ingredient_id: u(40), qty_milli: 12000, unit: "kg", unit_price_minor: 34000 };
const grnLine = { grn_line_id: u(71), po_line_id: u(61), ingredient_id: u(40), batch_id: u(72), qty_milli: 12000, unit: "kg", unit_cost_minor: 34000, currency: "INR" };
const invLine = { line_id: u(81), line_no: 1, po_line_id: u(61), ingredient_id: u(40), description: null, qty_milli: 12000, unit: "kg", unit_price_minor: 34000, tax_minor: 20400, line_total_minor: 428400 };

export const supplierView = { ...supplier, a2a_card_url: "https://suppliers-sim.example.test/steady/.well-known/agent-card.json", payment_days: 15, notes: null, active: true, prices: [priceObs] };
export const poView = { po_id: u(60), supplier, outlet_ids: [u(2)], status: "committed", currency: "INR", total_minor: 408000, expected_on: "2026-10-11", negotiation_run_id: null, created_at: T, lines: [poLine] };
export const grnView = { grn_id: u(70), outlet_id: u(2), supplier, po_id: u(60), received_at: T, received_by: u(8), note: null, lines: [grnLine] };
export const invoiceView = {
  supplier_invoice_id: u(80), supplier: realSupplier, invoice_no: "INV-1042", invoice_date: "2026-10-09", po_id: u(60), subtotal_minor: 408000, tax_minor: 20400,
  total_minor: 428400, currency: "INR", status: "approved", created_at: T, lines: [invLine],
  payable: { payable_id: u(83), due_on: "2026-10-24", amount_minor: 428400, status: "open" },
};
export const returnView = {
  supplier_return_id: u(90), outlet_id: u(2), supplier, goods_received_id: u(70), reason_code: "damaged", note: "torn pack", returned_by: u(8), returned_at: T,
  lines: [{ ingredient_id: u(40), batch_id: u(72), qty_milli: 2000, unit: "kg", unit_cost_minor: 34000, unit_cost_per_1000_minor: 34000000, currency: "INR" }],
};

export const SAMPLES: Record<string, unknown> = {
  "purchasing.supplier.upsert.v1": {
    supplier_id: u(50), name: "Steady Dairy (simulated supplier)", kind: "simulated", a2a_card_url: "https://suppliers-sim.example.test/steady/.well-known/agent-card.json",
    terms: { payment_days: 15, notes: null }, prices: [priceObs],
  },
  "purchasing.po.create.v1": poCreate,
  "purchasing.grn.receive.v1": {
    grn_id: u(70), outlet_id: u(2), supplier_id: u(50), po_id: u(60), received_at: T, note: null,
    lines: [{ grn_line_id: u(71), po_line_id: u(61), ingredient_id: u(40), qty_milli: 12000, unit: "kg", unit_cost_minor: null, currency: "INR",
      batch: { batch_id: u(72), batch_code: "B-2026-10-09", expires_on: "2026-10-13", mrp_minor: null } }],
  },
  "purchasing.invoice.record.v1": {
    supplier_invoice_id: u(80), supplier_id: u(51), invoice_no: "INV-1042", invoice_date: "2026-10-09", po_id: u(60), currency: "INR",
    lines: [{ line_id: u(81), po_line_id: u(61), ingredient_id: u(40), description: null, qty_milli: 12000, unit: "kg", unit_price_minor: 34000, tax_minor: 20400 }],
  },
  "purchasing.invoice.approve.v1": { supplier_invoice_id: u(80) },
  "purchasing.invoice.dispute.v1": { dispute_id: u(85), supplier_invoice_id: u(80), basis: "overbilled", lines: [{ invoice_line_id: u(81), claimed_minor: 7200 }] },
  "purchasing.supplier_return.create.v1": {
    supplier_return_id: u(90), outlet_id: u(2), supplier_id: u(50), goods_received_id: u(70), reason_code: "damaged", note: "torn pack",
    lines: [{ batch_id: u(72), ingredient_id: u(40), qty_milli: 2000, unit: "kg" }],
  },
  "purchasing.rfq.request.v1": { rfq_id: u(96), ingredient_id: u(40), outlet_ids: [u(2), u(3)] },
  "purchasing.intel-negotiate.request": {
    rfq_id: u(96), ingredient_id: u(40), item_name: "Tomato", unit: "kg", currency: "INR", minor_unit: 2, outlet_ids: [u(2), u(3)],
    suppliers: [{ supplier_id: u(50), kind: "simulated", card_url: "https://suppliers-sim.example.test/steady/.well-known/agent-card.json" }],
    item_ids: [u(30), u(31)],
  },
  "purchasing.intel-negotiate.response": { run_id: u(97), status: "drafted", draft_id: u(98) },
  "proposal.purchasing.invoice.dispute.v1": {
    dispute_id: u(85), supplier_invoice_id: u(80), basis: "overbilled", lines: [{ invoice_line_id: u(81), claimed_minor: snapRef(S1, 0, "overbilled_minor") }],
  },
  // Invoice vision (T-056): numbers are spans of document u(87)'s text; the strings are as read off the page.
  "proposal.purchasing.invoice.record.v1": {
    supplier_invoice_id: u(80), supplier_id: u(51), invoice_no: "INV-1042", invoice_date: "2026-10-09", po_id: null, currency: "INR",
    lines: [{ line_id: u(81), po_line_id: null, ingredient_id: u(40), description: null, qty_milli: citeRef("doc", u(87), [112, 114]), unit: "kg",
      unit_price_minor: citeRef("doc", u(87), [118, 124]), tax_minor: citeRef("doc", u(87), [131, 137]) }],
  },
  "proposal.purchasing.supplier_return.create.v1": {
    supplier_return_id: u(90), outlet_id: u(2), supplier_id: u(50), goods_received_id: u(70), reason_code: "expired", note: "unsellable before expiry",
    lines: [{ batch_id: u(72), ingredient_id: u(40), qty_milli: citeRef("row", `core.stock_movement:${u(95)}`), unit: "kg" }],
  },
  "v1.supplier": supplierView,
  "v1.suppliers": { items: [supplierView] },
  "v1.purchase-order": poView,
  "v1.purchase-orders": { items: [poView] },
  "v1.goods-received": grnView,
  "v1.goods-received.list": { items: [grnView] },
  "v1.supplier-invoice": invoiceView,
  "v1.supplier-invoices": { items: [invoiceView] },
  "v1.supplier-return": returnView,
  "v1.supplier-returns": { items: [returnView] },
};
