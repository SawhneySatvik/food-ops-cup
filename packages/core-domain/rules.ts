// Every derivation rule core-domain implements (W1 fix #55). core-api sets `app.posting_rule` to one of
// these ids; each must have its `core.derivation_rule` row (rules-parity test).
import { RULES as FINANCE } from "./finance/rules.ts";
import { RULES as INVENTORY } from "./inventory/rules.ts";

export const DERIVATION_RULES: ReadonlyArray<{ rule_id: string; source_table: string; target_table: string }> = [...INVENTORY, ...FINANCE];
export const RULE_IDS: readonly string[] = DERIVATION_RULES.map((r) => r.rule_id);
