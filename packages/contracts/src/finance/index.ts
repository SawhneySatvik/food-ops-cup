// Finance commands (T-026; packs/finance.md §6, §10; 02-schema §2.7). Postings are never commands: they are
// derived by core under seeded posting rules. Disputes, journal adjustments and period closes are draftable
// (intel proposes; numbers are refs). Payments and payouts are recorded, never processed (project rule 5).
import { z } from "zod";
import { defineDraftable } from "../shared/draftables.ts";
import { BasisPoints, CurrencyCode, IsoDate, MinorAmount, NonEmpty, Slug, Uuid7 } from "../shared/primitives.ts";
import { RefId } from "../shared/refs.ts";
import type { Route } from "../shared/routes.ts";
import { READ_ROUTES, READ_SCHEMAS } from "./read-routes.ts";

/** What the owner agreed with an aggregator for a validity window (an own command, never drafted). Setting
 *  terms from `valid_from` ends the channel's open-ended terms that started earlier; any other overlap is
 *  refused (409). */
export const FinanceChannelTermsSetV1 = z.strictObject({
  channel_terms_id: Uuid7,
  channel_id: Uuid7,
  commission_bp: BasisPoints,
  ads_opted_in: z.boolean(),
  /** Monthly ad-spend cap; null = no cap recorded (must be null when not opted in). */
  ad_spend_cap_minor: MinorAmount.nonnegative().nullable(),
  promo_share_bp: BasisPoints,
  payout_cycle_days: z.int().min(1).max(90),
  currency: CurrencyCode,
  valid_from: IsoDate,
  valid_to: IsoDate.nullable(),
});

export const ExpenseCategory = z.enum(["rent", "utilities", "repairs", "marketing", "packaging", "bank_charges", "professional_fees", "other"]);

/** An expense paid by the business; `amount_minor` includes `tax_minor`. Posts under finance.post_expense. */
export const FinanceExpenseRecordV1 = z.strictObject({
  expense_id: Uuid7,
  outlet_id: Uuid7,
  category: ExpenseCategory,
  incurred_on: IsoDate,
  amount_minor: MinorAmount.positive(),
  tax_minor: MinorAmount.nonnegative(),
  currency: CurrencyCode,
  payee: NonEmpty,
  note: z.string().min(1).max(500).nullable(),
  document_id: Uuid7.nullable(),
});

export const BudgetCategory = z.enum(["purchases", "labour", "marketing", "utilities", "maintenance", "other"]);

/** A month's budget for one spending category, for one outlet or (outlet_id null) the whole business — an own command of the
 *  owner (or judge). There is one budget per outlet, category and month: set again, that budget's amount changes (the result's
 *  entity_id is its id). The deal review reads the `purchases` one (purchasing.deal_inputs budget_left_minor); with none it
 *  cannot verify a quote (budget_missing). */
export const FinanceBudgetSetV1 = z.strictObject({
  budget_id: Uuid7,
  outlet_id: Uuid7.nullable(),
  category: BudgetCategory,
  /** First day of the month. */
  period_month: IsoDate,
  amount_minor: MinorAmount.nonnegative(),
  currency: CurrencyCode,
});

/** A claim against a channel, recorded and printed for the owner to send — Munim never sends it. Each line
 *  names exactly one of settlement_line_id / order_id (ad-fee disputes carry no lines). `break_ids` are the
 *  reconciliation breaks this dispute covers (they move to `disputed`). */
export const FinanceDisputeDraftV1 = z.strictObject({
  dispute_id: Uuid7,
  channel_id: Uuid7,
  basis: z.enum(["unapproved_ad_fee", "short_payout", "missing_payout"]),
  lines: z.array(z.strictObject({ settlement_line_id: Uuid7.nullable(), order_id: Uuid7.nullable(), claimed_minor: MinorAmount.positive() })),
  total_claimed_minor: MinorAmount.positive(),
  currency: CurrencyCode,
  break_ids: z.array(Uuid7),
});

/** Close a month for one outlet (or the whole business, outlet_id null). After it, entries dated in that
 *  month are refused (period_closed). Permanent in v1. */
export const FinancePeriodCloseV1 = z.strictObject({
  period_close_id: Uuid7,
  outlet_id: Uuid7.nullable(),
  /** First day of the month. */
  period_month: IsoDate,
  /** Each item's evidence as a ref id (`snap:<id>` or a row/doc cite id) — an id, not a ⟨…⟩ cell token, so
   *  approval never substitutes a value for it. */
  checklist: z.array(z.strictObject({ item_code: Slug, evidence_ref: RefId })).min(1),
  net_minor: MinorAmount,
  currency: CurrencyCode,
});

/** A manual journal entry — executes only through an approved draft. Amounts are unsigned with a side, so
 *  one cited cell can balance both sides; Σ debit must equal Σ credit. `reverses_id` makes it the (single)
 *  reversal of a committed entry. */
export const FinanceJournalAdjustV1 = z.strictObject({
  journal_entry_id: Uuid7,
  entry_date: IsoDate,
  outlet_id: Uuid7.nullable(),
  reverses_id: Uuid7.nullable(),
  postings: z.array(z.strictObject({ account_id: Uuid7, side: z.enum(["debit", "credit"]), amount_minor: MinorAmount.positive() })).min(2),
  currency: CurrencyCode,
  memo_key: Slug,
});

export const DISPUTE_DRAFT = defineDraftable("finance.dispute.draft.v1", FinanceDisputeDraftV1);
export const JOURNAL_ADJUST_DRAFT = defineDraftable("finance.journal.adjust.v1", FinanceJournalAdjustV1);
export const PERIOD_CLOSE_DRAFT = defineDraftable("finance.period.close.v1", FinancePeriodCloseV1);

/** The Tally export: a journal-voucher CSV (one row per posting; every amount a posting row's own field). */
export const TallyExport = z.strictObject({
  file_name: z.string().regex(/^munim-tally-[0-9]{4}-[0-9]{2}-[0-9]{2}-to-[0-9]{4}-[0-9]{2}-[0-9]{2}\.csv$/),
  content_type: z.literal("text/csv"),
  content: z.string(),
});

/** A channel's recorded terms, every validity window (the rows' own fields: the inputs short-payout and ad-fee checks
 *  read). Owner, advisor, judge — like the Tally export. */
export const ChannelTermsListResponse = z.strictObject({ channel_terms: z.array(FinanceChannelTermsSetV1) });

export const SCHEMAS = {
  ...READ_SCHEMAS,
  "finance.channel_terms.set.v1": FinanceChannelTermsSetV1,
  "finance.expense.record.v1": FinanceExpenseRecordV1,
  "finance.budget.set.v1": FinanceBudgetSetV1,
  "finance.dispute.draft.v1": FinanceDisputeDraftV1,
  "finance.period.close.v1": FinancePeriodCloseV1,
  "finance.journal.adjust.v1": FinanceJournalAdjustV1,
  "proposal.finance.dispute.draft.v1": DISPUTE_DRAFT.proposal,
  "proposal.finance.journal.adjust.v1": JOURNAL_ADJUST_DRAFT.proposal,
  "proposal.finance.period.close.v1": PERIOD_CLOSE_DRAFT.proposal,
  "v1.finance.tally-export": TallyExport,
  "v1.finance.channel-terms": ChannelTermsListResponse,
};

const post = (path: string, operationId: string, command: string, summary: string): Route => ({
  surface: "public", method: "post", path, operationId, summary, auth: "member", command, response: "command-result", status: 201, conflict: true,
});
const date = { type: "string", format: "date" };

export const ROUTES: readonly Route[] = [
  ...READ_ROUTES,
  post("/v1/finance/channel-terms", "setChannelTerms", "finance.channel_terms.set.v1", "finance.channel_terms.set.v1 — record agreed commission, ad and promo terms for a channel (owner)"),
  post("/v1/finance/expenses", "recordExpense", "finance.expense.record.v1", "finance.expense.record.v1 — record an expense (posts it)"),
  post("/v1/finance/budgets", "setBudget", "finance.budget.set.v1", "finance.budget.set.v1 — set a month's budget for one spending category, for one outlet or the whole business (owner)"),
  post("/v1/finance/disputes", "recordDispute", "finance.dispute.draft.v1", "finance.dispute.draft.v1 — record a channel dispute for the owner to send (also draftable)"),
  post("/v1/finance/period-closes", "closePeriod", "finance.period.close.v1", "finance.period.close.v1 — close a month (also draftable); later entries dated in it are refused"),
  {
    surface: "public", method: "get", path: "/v1/finance/exports/tally", operationId: "exportTally",
    summary: "Journal vouchers for a date range as a Tally-importable CSV (owner, advisor, judge)", auth: "member", response: "v1.finance.tally-export", status: 200,
    query: [{ name: "from", required: true, schema: date }, { name: "to", required: true, schema: date }],
  },
  {
    surface: "public", method: "get", path: "/v1/finance/channel-terms", operationId: "listChannelTerms",
    summary: "Recorded channel terms (commission, ad consent and cap, validity), newest window first (owner, advisor, judge)", auth: "member",
    response: "v1.finance.channel-terms", status: 200, query: [{ name: "channel_id", required: false, schema: { type: "string", format: "uuid" } }],
  },
];
