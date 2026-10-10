// The finance derivation rules core-domain implements (rule id → source table → target tables), for the
// rules-parity list in ../rules.ts (owned by T-003: merging these into DERIVATION_RULES and removing them
// from that test's pending list is reported, not done here). Each matches a seeded core.derivation_rule row.
const entry = (rule_id: string, source_table: string) =>
  ["core.journal_entry", "core.posting"].map((target_table) => ({ rule_id, source_table, target_table }));

export const POSTING_RULES = {
  "finance.post_order": "core.order",
  "finance.post_tender": "core.tender",
  "finance.post_grn": "core.goods_received",
  "finance.post_supplier_invoice": "core.supplier_invoice",
  "finance.post_settlement": "core.settlement",
  "finance.post_refund": "core.refund",
  "finance.post_expense": "core.expense",
  "finance.post_payroll": "core.payroll_draft",
  "finance.post_advance": "core.advance",
  "finance.post_loyalty_redemption": "core.order",
} as const;
export type PostingRuleId = keyof typeof POSTING_RULES;

// finance.reconcile_order and finance.reconcile_bank are seeded but not implemented yet (T-026 report).
export const RECONCILE_RULES = {
  "finance.reconcile_settlement": "core.settlement",
} as const;

export const RULES: ReadonlyArray<{ rule_id: string; source_table: string; target_table: string }> = [
  ...Object.entries(POSTING_RULES).flatMap(([id, src]) => entry(id, src)),
  ...Object.entries(RECONCILE_RULES).map(([rule_id, source_table]) => ({ rule_id, source_table, target_table: "core.reconciliation_break" })),
];
