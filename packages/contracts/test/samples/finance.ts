import { S1, snapRef, u } from "./_ids.ts";

const terms = {
  channel_terms_id: u(1100), channel_id: u(30), commission_bp: 2200, ads_opted_in: true, ad_spend_cap_minor: 500000, promo_share_bp: 0,
  payout_cycle_days: 7, currency: "INR", valid_from: "2026-09-01", valid_to: null,
};
const expense = {
  expense_id: u(1101), outlet_id: u(2), category: "utilities", incurred_on: "2026-09-03", amount_minor: 450000, tax_minor: 0, currency: "INR",
  payee: "Synthetic Power Co", note: null, document_id: null,
};
const dispute = {
  dispute_id: u(1102), channel_id: u(30), basis: "short_payout", currency: "INR", break_ids: [u(1103)], total_claimed_minor: 2400,
  lines: [{ settlement_line_id: u(1104), order_id: null, claimed_minor: 2400 }],
};
const close = {
  period_close_id: u(1105), outlet_id: u(2), period_month: "2026-09-01", currency: "INR", net_minor: 1250000,
  checklist: [{ item_code: "settlements_imported", evidence_ref: `snap:${S1}` }],
};
const adjust = {
  journal_entry_id: u(1106), entry_date: "2026-10-01", outlet_id: null, reverses_id: null, currency: "INR", memo_key: "finance.memo.disputed_fee",
  postings: [{ account_id: u(1107), side: "debit", amount_minor: 3000 }, { account_id: u(1108), side: "credit", amount_minor: 3000 }],
};

export const SAMPLES: Record<string, unknown> = {
  "finance.channel_terms.set.v1": terms,
  "finance.expense.record.v1": expense,
  "finance.dispute.draft.v1": dispute,
  "finance.period.close.v1": close,
  "finance.journal.adjust.v1": adjust,
  "proposal.finance.dispute.draft.v1": {
    ...dispute, basis: "unapproved_ad_fee", lines: [], total_claimed_minor: snapRef(S1, 0, "unapproved_minor"),
  },
  "proposal.finance.journal.adjust.v1": {
    ...adjust, postings: adjust.postings.map((p) => ({ ...p, amount_minor: snapRef(S1, 0, "unapproved_minor") })),
  },
  "proposal.finance.period.close.v1": { ...close, net_minor: snapRef(S1, 0, "net_minor") },
  "v1.finance.channel-terms": { channel_terms: [terms, { ...terms, channel_terms_id: u(1109), ads_opted_in: false, ad_spend_cap_minor: null, valid_from: "2026-01-01", valid_to: "2026-09-01" }] },
  "v1.finance.tally-export": {
    file_name: "munim-tally-2026-09-01-to-2026-09-30.csv", content_type: "text/csv",
    content: `Date,Voucher Type,Voucher No,Ledger Code,Ledger,Debit,Credit,Narration\r\n30-09-2026,Journal,${u(1106)},1000,Cash on hand,10.00,,finance.post_tender\r\n`,
  },
};
