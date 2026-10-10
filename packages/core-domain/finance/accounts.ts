// Chart of accounts and posting roles (T-026; packs/finance.md; R21). The country pack carries the chart
// (code, name, type) with no semantics, so posting rules name ROLES and resolve each to the first candidate
// code present in the tenant's chart. Codes are the pack's own (shared by every pack today); a code that a
// pack does not carry is never assumed — it is either one of Munim's structural accounts below (seeded beside
// the pack's chart) or the role is absent (`optional`) and the rule says what happens instead.
import type { CountryPack } from "@munim/contracts/packs";

export type AccountType = "asset" | "liability" | "equity" | "income" | "expense";
export type ChartAccount = { code: string; name: string; type: AccountType };

/** Accounts the seeded posting rules need that the pack charts do not carry (INFERENCE, reported to the pack
 *  owner): order and tender are separate rules, so own-channel sales clear through a receivable; GRN and
 *  supplier invoice are separate rules, so goods received wait in GRNI until invoiced; cash rounding, staff
 *  advances recovered through payroll, and expense categories with no pack account. Country-agnostic.
 *  seedChart adds each one whose code the pack does not already define. */
export const STRUCTURAL_ACCOUNTS: readonly ChartAccount[] = [
  { code: "1110", name: "Counter sales clearing", type: "asset" },
  { code: "1250", name: "Staff advances", type: "asset" },
  { code: "2050", name: "Goods received not invoiced", type: "liability" },
  { code: "4900", name: "Cash rounding", type: "income" },
  { code: "6900", name: "Other operating expenses", type: "expense" },
];

export type Role =
  | "cash"
  | "bank"
  | "channel_receivable"
  | "counter_receivable"
  | "input_tax"
  | "staff_advances"
  | "payables"
  | "grni"
  | "output_tax"
  | "sales"
  | "rounding"
  | "cogs"
  | "wastage"
  | "commission"
  | "channel_promotions"
  | "rent"
  | "utilities"
  | "wages"
  | "payment_fees"
  | "loyalty_redemption"
  | "other_expense";

/** role → candidate codes (first present wins) and the account type the role must have. */
export const ROLES: Readonly<Record<Role, { codes: readonly string[]; type: AccountType; optional?: true }>> = {
  cash: { codes: ["1000"], type: "asset" },
  bank: { codes: ["1010"], type: "asset" },
  channel_receivable: { codes: ["1100"], type: "asset" },
  counter_receivable: { codes: ["1110"], type: "asset" },
  // Absent from a pack whose tax classes give no input-tax credit: the tax is part of the cost instead.
  input_tax: { codes: ["1300"], type: "asset", optional: true },
  staff_advances: { codes: ["1250"], type: "asset" },
  payables: { codes: ["2000"], type: "liability" },
  grni: { codes: ["2050"], type: "liability" },
  output_tax: { codes: ["2100"], type: "liability" },
  sales: { codes: ["4000"], type: "income" },
  rounding: { codes: ["4900"], type: "income" },
  cogs: { codes: ["5000"], type: "expense" },
  wastage: { codes: ["5100"], type: "expense" },
  commission: { codes: ["6000"], type: "expense" },
  channel_promotions: { codes: ["6010"], type: "expense" },
  rent: { codes: ["6100"], type: "expense" },
  utilities: { codes: ["6200"], type: "expense" },
  wages: { codes: ["6300"], type: "expense" },
  payment_fees: { codes: ["6400"], type: "expense" },
  // Points carry no liability when earned (no earn posting): what they paid for is revenue given up — a contra-revenue
  // income account (debit balance), the account 0016 backfills into existing charts.
  loyalty_redemption: { codes: ["4100"], type: "income" },
  other_expense: { codes: ["6900"], type: "expense" },
};

/** P&L columns (finance.pnl): revenue = every income account; these expense groups by role; `other` = every
 *  other expense account. */
export const PNL_GROUPS = {
  cogs: ["cogs", "wastage"],
  channel_fees: ["commission", "channel_promotions"],
  labour: ["wages"],
} as const satisfies Record<string, readonly Role[]>;

export const codesOf = (roles: readonly Role[]): string[] => roles.flatMap((r) => [...ROLES[r].codes]);

/** The chart a new tenant starts with: the pack's accounts, then each structural account whose code the
 *  pack does not define. A structural code the pack defines with another type is a pack conflict (throws). */
export function chartFor(pack: Pick<CountryPack, "chart_of_accounts">): ChartAccount[] {
  const out: ChartAccount[] = pack.chart_of_accounts.map((a) => ({ code: a.code, name: a.name, type: a.type }));
  for (const s of STRUCTURAL_ACCOUNTS) {
    const hit = out.find((a) => a.code === s.code);
    if (!hit) out.push({ ...s });
    else if (hit.type !== s.type) throw new Error(`chartFor: pack account ${s.code} is ${hit.type}, Munim needs ${s.type}`);
  }
  return out;
}

export class AccountMissing extends Error {
  readonly role: Role;
  constructor(role: Role) {
    super(`account_missing: no account in the chart for role ${role}`);
    this.name = "AccountMissing";
    this.role = role;
  }
}

/** The tenant's code for each role it has (role → account), checking the account type. A required role
 *  with no account throws only when a rule asks for it (`need`). */
export function roleResolver<A extends { code: string; type: string }>(chart: readonly A[]) {
  const byCode = new Map(chart.map((a) => [a.code, a]));
  const find = (role: Role): A | undefined => {
    for (const code of ROLES[role].codes) {
      const a = byCode.get(code);
      if (a && a.type === ROLES[role].type) return a;
    }
    return undefined;
  };
  return {
    has: (role: Role) => find(role) !== undefined,
    need(role: Role): A {
      const a = find(role);
      if (!a) throw new AccountMissing(role);
      return a;
    },
  };
}
