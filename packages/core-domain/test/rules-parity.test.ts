// W1 fix #55: every core.derivation_rule row seeded by db/migrations has a core-domain rule, or is listed
// here with the ticket that implements it; every core-domain rule has a matching seeded row.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DERIVATION_RULES, RULE_IDS } from "../rules.ts";

const MIGRATIONS = fileURLToPath(new URL("../../../db/migrations/", import.meta.url));
// Rules the database allow-lists whose deterministic code lives elsewhere or lands later.
const NOT_IN_CORE_DOMAIN_YET: Record<string, string> = {
  "purchasing.payable_from_invoice": "T-025",
  "inventory.receive_grn": "T-024",
  "inventory.record_waste": "T-024",
  "inventory.transfer_out": "T-024",
  "inventory.transfer_in": "T-024",
  "inventory.supplier_return": "T-024",
  "inventory.sale_return": "T-024",
  "customers.loyalty_earn": "T-028",
  "customers.loyalty_reverse": "T-028",
  // 0014 (W1 fix cycle 1)
  "finance.reconcile_bank": "T-026",
  "finance.reconcile_order": "T-026",
  "orders.reprice": "T-022",
  // 0015 (W2 fix, Batch A)
  "inventory.reverse_order_consumption": "T-022", // written by orders on cancel / reject (W2-R6, B5)
  "finance.reverse_supplier_invoice": "T-026",
  "finance.reverse_payroll": "T-026",
  "customers.merge_verified_email": "T-035",
  // 0016 (W2 fix cycle 1)
  "customers.erase_merged_guests": "T-035", // the definer core.customer_erase_merged_guests (R1-M1)
  // 0017 (W2 fix cycle 2)
  "customers.claim_guest_token": "T-035", // the definer core.customer_claim_guest_token (R41 erasure gap)
};

function seededRows(): Array<{ rule_id: string; source_table: string; target_table: string }> {
  const rows: Array<{ rule_id: string; source_table: string; target_table: string }> = [];
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) {
    const sql = readFileSync(MIGRATIONS + f, "utf8").replace(/--[^\n]*/g, ""); // a `;` inside a comment must not end a VALUES list
    for (const block of sql.matchAll(/INSERT INTO core\.derivation_rule\s*\([^)]*\)\s*VALUES([\s\S]*?);/g))
      for (const m of block[1]!.matchAll(/\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/g)) rows.push({ rule_id: m[1]!, source_table: m[2]!, target_table: m[3]! });
  }
  return rows;
}

describe("derivation rule-id parity with core.derivation_rule", () => {
  const rows = seededRows();

  it("every seeded rule id is implemented here or listed with its owner", () => {
    // Floor = the W1 baseline (0005: 2, 0008: 17, 0011: 2, counted by hand 10 Oct); migrations only add rows.
    expect(rows.length).toBeGreaterThanOrEqual(21);
    const unaccounted = [...new Set(rows.map((r) => r.rule_id))].filter((id) => !RULE_IDS.includes(id) && !(id in NOT_IN_CORE_DOMAIN_YET));
    expect(unaccounted).toEqual([]);
  });

  it("every core-domain rule has its seeded (rule, source, target) row, and none is also listed as pending", () => {
    // Floor = inventory 2 + finance 8 posting rules + reconcile_settlement (counted by hand 10 Oct, B7).
    expect(new Set(RULE_IDS).size).toBeGreaterThanOrEqual(11);
    for (const r of DERIVATION_RULES) expect(rows).toContainEqual({ ...r });
    expect(RULE_IDS.filter((id) => id in NOT_IN_CORE_DOMAIN_YET)).toEqual([]);
  });
});
