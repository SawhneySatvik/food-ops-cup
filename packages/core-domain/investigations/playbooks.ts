// Investigation playbooks as data (ADR-014 §7.2, §7.5; ledger R45 F1, F8, F10). Framework-free and reviewed like code:
// no model ever sets a verdict or a status (P10) — `judge` and `nextStatus` below are the only places they are decided.
// Each item names its owning specialist (F8); the narration of a step is signed item by item with that specialist.
//
// Specialist per item (BOARD T-083 gate 8). ADR §7.5 has no specialist column, so each item takes the owner of its
// evidence templates in the specialist registry (packages/contracts/src/intel/specialists.ts) and 04 §12.1's
// "Owns" column: close_status, settlement_vs_orders → finance; price_creep and waste_week (and 04 §12.1 "price creep,
// waste") → inventory_purchasing; deal_cost, menu_matrix → catalogue; labour_pct → people. INFERENCE where §7.5 lists
// templates of two owners (H1, H2): the registry owner of the first-listed template wins.
//
// Verdict rules (BOARD ruling, 11 Oct, "share sign"): a bridge row explains the change when it moves the same way as
// the total — supported iff Σ share_bp of the item's components × sign(margin_delta) ≥ 1,000. Volume/mix (H6) is
// judged on revenue_volume + cogs_volume_mix together (the key: −2,080 + 2,040 = −40 → refuted). Waste (H2) is a
// valuation row that moves no margin (consumption posts nothing under the purchases method, W2-R5; cogs_volume_mix
// gives it back), so it is judged on its own row alone, never netted with that giveback. INFERENCE: the ruling's
// "own quantity rule" is read as the waste row's own move against the margin change, at the same 1,000 bar.
export type ItemStatus = "pending" | "supported" | "refuted" | "cannot_verify";
export type InvestigationStatus = "open" | "waiting" | "done" | "no_driver_found" | "cannot_verify" | "cancelled" | "exhausted";
export type Specialist = "catalogue" | "kitchen" | "inventory_purchasing" | "finance" | "people" | "customers" | "compliance" | "market";

/** A param value: `$<name>` takes the investigation's param, anything else (incl. null) is literal. */
export type ParamSource = string | null;

export type Rule =
  /** Every listed `item_code` row of every minted month reads `done`; otherwise cannot_verify (data missing). */
  | { kind: "close_status"; items: readonly string[] }
  /** Σ share_bp of the components × sign(margin_delta_minor's delta) ≥ min_bp → supported, else refuted. */
  | { kind: "bridge_share"; components: readonly string[]; min_bp: number };

export interface PlaybookItem {
  item_id: string;
  label_key: string;
  specialist: Specialist;
  template_id: string;
  /** One mint per entry (H0 mints its template for both months). */
  params_from: ReadonlyArray<Readonly<Record<string, ParamSource>>>;
  verdict: Rule;
  /** Evaluated only once this item is supported (settlement-based rows wait for the data gate). */
  data_gate: string | null;
  /** Digit-free sentences per verdict; `{cells}` becomes the verdict's cell refs. Used when the model's is unusable. */
  narration: Readonly<Record<Exclude<ItemStatus, "pending">, string>>;
}

export interface Playbook {
  playbook_id: string;
  /** 04 §12.1: Finance owns the margin bridge items of margin_fall — the narration run's actor. */
  owner: Specialist;
  /** The data-completeness gate (H0): `waiting` while it cannot be verified. */
  gate: string;
  /** The bridge's residual: |share_bp| above `max_bp` means no driver explains the change (INFERENCE threshold, §7.4). */
  residual: { template_id: string; params_from: Readonly<Record<string, ParamSource>>; component: string; max_bp: number };
  max_steps: number;
  items: readonly PlaybookItem[];
}

const MONTHS = { period_month: "$period_month", compare_month: "$compare_month" } as const;
const SHARE = (components: string[]): Rule => ({ kind: "bridge_share", components, min_bp: 1000 });
const bridgeItem = (item_id: string, specialist: Specialist, components: string[], what: string, data_gate: string | null = null): PlaybookItem => ({
  item_id, label_key: `investigation.margin_fall.${item_id}`, specialist, template_id: "finance.margin_bridge", params_from: [MONTHS],
  verdict: SHARE(components), data_gate,
  narration: {
    supported: `${what} moved the margin the same way as the total change {cells}.`,
    refuted: `${what} does not explain this margin change {cells}.`,
    cannot_verify: `${what} cannot be checked from the books for these months {cells}.`,
  },
});

export const MARGIN_FALL: Playbook = {
  playbook_id: "margin_fall",
  owner: "finance",
  gate: "data_complete",
  residual: { template_id: "finance.margin_bridge", params_from: MONTHS, component: "unexplained", max_bp: 2000 },
  max_steps: 10,
  items: [
    {
      item_id: "data_complete", label_key: "investigation.margin_fall.data_complete", specialist: "finance", template_id: "finance.close_status",
      params_from: [{ period_month: "$period_month", outlet_id: null }, { period_month: "$compare_month", outlet_id: null }],
      verdict: { kind: "close_status", items: ["pos_days_closed", "settlements_imported", "bank_imported"] }, data_gate: null,
      narration: {
        supported: "The tills, payouts and bank lines are complete for the months compared {cells}.",
        refuted: "The tills, payouts and bank lines are not complete for the months compared {cells}.",
        cannot_verify: "Some tills, payouts or bank lines are still missing for the months compared, so the answer waits for them {cells}.",
      },
    },
    bridgeItem("supplier_price", "inventory_purchasing", ["cogs_supplier_price"], "Supplier prices"),
    bridgeItem("waste", "inventory_purchasing", ["waste"], "Waste"),
    bridgeItem("deals", "catalogue", ["deal_discount"], "Deals and discounts"),
    bridgeItem("channel_fees", "finance", ["channel_fees"], "Channel fees", "data_complete"),
    bridgeItem("labour", "people", ["labour"], "Labour cost"),
    bridgeItem("volume_mix", "catalogue", ["revenue_volume", "cogs_volume_mix"], "Sales volume and mix"),
  ],
};

export const PLAYBOOKS: Readonly<Record<string, Playbook>> = { margin_fall: MARGIN_FALL };
