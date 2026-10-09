// Allow-listed deterministic derivations owned by this module (03-architecture §1.3 branch 3). Each id
// matches a `core.derivation_rule` row (0005 seed); the parity test reads the migrations.
export const RULES = [
  { rule_id: "inventory.consume_order", source_table: "core.order", target_table: "core.stock_movement" },
  { rule_id: "inventory.consume_sku", source_table: "core.order", target_table: "core.stock_movement" },
] as const;
