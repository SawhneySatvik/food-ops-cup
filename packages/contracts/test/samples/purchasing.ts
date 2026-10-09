import { u } from "./_ids.ts";

export const poCreate = {
  po_id: u(60),
  supplier_id: u(50),
  outlet_ids: [u(2)],
  currency: "INR",
  expected_on: "2026-10-11",
  negotiation_run_id: null,
  lines: [{ ingredient_id: u(40), qty_milli: 12000, unit: "kg", unit_price_minor: 34000 }],
};

export const SAMPLES: Record<string, unknown> = {
  "purchasing.supplier.upsert.v1": { supplier_id: u(50), name: "Steady Dairy (simulated supplier)", kind: "simulated", a2a_card_url: "https://suppliers-sim.example.test/steady/.well-known/agent-card.json", terms: { payment_days: 15, notes: null } },
  "purchasing.po.create.v1": poCreate,
};
