// Finance command handlers (T-026). Each is bound to one seeded command type and writes only that command's
// target_tables (the guard checks it, MB008); derived postings ride on posting rules (post.ts).
//   finance.channel_terms.set.v1   own command (owner/judge)          → core.channel_terms
//   finance.expense.record.v1      own command (owner/manager/judge)  → core.expense (+ finance.post_expense)
//   finance.budget.set.v1          own command (owner/judge)          → core.budget (one per outlet or business, category, month)
//   finance.dispute.draft.v1       own command or approved draft      → core.dispute, core.dispute_line, breaks → disputed
//   finance.period.close.v1        own command or approved draft      → core.period_close
//   finance.journal.adjust.v1      approved draft ONLY                → core.journal_entry, core.posting
import {
  FinanceBudgetSetV1, FinanceChannelTermsSetV1, FinanceDisputeDraftV1, FinanceExpenseRecordV1, FinanceJournalAdjustV1, FinancePeriodCloseV1,
} from "@munim/contracts/finance";
import type { CommandHandler } from "../../commit/index.ts";
import { uuidv7 } from "../../commit/index.ts";
import { ApiError } from "../../lib/errors.ts";
import type { Queryable } from "../../runtoken/index.ts";
import { checkBalancedNow, postFor } from "./post.ts";

type Schema<T> = { safeParse(v: unknown): { success: true; data: T } | { success: false } };

function parse<T>(schema: Schema<T>, payload: unknown): T {
  const r = schema.safeParse(payload);
  if (!r.success) throw new ApiError("invalid_payload");
  return r.data;
}

const decisionId = async (c: Queryable): Promise<string | null> =>
  (await c.query<{ d: string | null }>(`SELECT nullif(current_setting('app.decision_id', true), '') AS d`)).rows[0]?.d ?? null;

export const channelTermsSet: CommandHandler = {
  type: "finance.channel_terms.set.v1",
  async run(c, cmd) {
    const p = parse(FinanceChannelTermsSetV1, cmd.payload);
    if (p.valid_to !== null && p.valid_to <= p.valid_from) throw new ApiError("invalid_payload");
    if (!p.ads_opted_in && p.ad_spend_cap_minor !== null) throw new ApiError("invalid_payload");
    // New terms from valid_from end the channel's open-ended terms that began earlier; any other overlap is
    // the exclusion constraint's 409 (validity windows never overlap per channel).
    const ended = await c.query<{ id: string; valid_from: string }>(
      `UPDATE core.channel_terms SET valid_to = $2 WHERE channel_id = $1 AND valid_to IS NULL AND valid_from < $2
       RETURNING id, valid_from::text AS valid_from`, [p.channel_id, p.valid_from]);
    await c.query(
      `INSERT INTO core.channel_terms (tenant_id, id, channel_id, commission_bp, ads_opted_in, ad_spend_cap_minor, promo_share_bp, payout_cycle_days,
                                       currency, valid_from, valid_to)
       VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [p.channel_terms_id, p.channel_id, p.commission_bp, p.ads_opted_in, p.ad_spend_cap_minor, p.promo_share_bp, p.payout_cycle_days,
       p.currency, p.valid_from, p.valid_to]);
    return {
      entityId: p.channel_terms_id,
      audit: [
        ...ended.rows.map((r) => ({ entity: "core.channel_terms", entityId: r.id, before: { valid_to: null }, after: { valid_to: p.valid_from } })),
        { entity: "core.channel_terms", entityId: p.channel_terms_id, after: { channel_id: p.channel_id, valid_from: p.valid_from, valid_to: p.valid_to } },
      ],
    };
  },
};

export const expenseRecord: CommandHandler = {
  type: "finance.expense.record.v1",
  async run(c, cmd) {
    const p = parse(FinanceExpenseRecordV1, cmd.payload);
    if (p.tax_minor > p.amount_minor) throw new ApiError("invalid_payload");
    await c.query(
      `INSERT INTO core.expense (tenant_id, id, outlet_id, category, incurred_on, amount_minor, tax_minor, currency, payee, note, document_id)
       VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [p.expense_id, p.outlet_id, p.category, p.incurred_on, p.amount_minor, p.tax_minor, p.currency, p.payee, p.note, p.document_id]);
    const posted = await postFor(c, "finance.post_expense", `core.expense:${p.expense_id}`);
    return {
      entityId: p.expense_id,
      audit: [{ entity: "core.expense", entityId: p.expense_id, after: { outlet_id: p.outlet_id, category: p.category, journal_entry_id: posted.entry_id } }],
    };
  },
};

export const budgetSet: CommandHandler = {
  type: "finance.budget.set.v1",
  async run(c, cmd) {
    const p = parse(FinanceBudgetSetV1, cmd.payload);
    // One budget per outlet (or the whole business), category and month (0008's unique index): set again, that row's amount
    // changes. Locked, so two sets of one budget run one after the other. Who may set it is the book guard's verdict (0008's
    // authority row: owner and judge), which the write below meets before anything else is checked.
    const prior = (await c.query<{ id: string; amount_minor: string }>(
      `SELECT id, amount_minor::text AS amount_minor FROM core.budget
        WHERE outlet_id IS NOT DISTINCT FROM $1 AND category = $2 AND period_month = $3 FOR UPDATE`, [p.outlet_id, p.category, p.period_month])).rows[0];
    if (prior) {
      const kept = (await c.query<{ currency: string }>(`UPDATE core.budget SET amount_minor = $2 WHERE id = $1 RETURNING currency`, [prior.id, p.amount_minor])).rows[0]!;
      // The table's trigger judges the currency of a new row; an amount change keeps the row's, so another one is refused here.
      if (kept.currency !== p.currency) throw new ApiError("currency_mismatch");
      return {
        entityId: prior.id,
        audit: [{ entity: "core.budget", entityId: prior.id, before: { amount_minor: Number(prior.amount_minor) }, after: { amount_minor: p.amount_minor } }],
      };
    }
    await c.query(
      `INSERT INTO core.budget (tenant_id, id, outlet_id, category, period_month, amount_minor, currency, created_by)
       VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, current_setting('app.member_id')::uuid)`,
      [p.budget_id, p.outlet_id, p.category, p.period_month, p.amount_minor, p.currency]);
    return {
      entityId: p.budget_id,
      audit: [{ entity: "core.budget", entityId: p.budget_id,
        after: { outlet_id: p.outlet_id, category: p.category, period_month: p.period_month, amount_minor: p.amount_minor, currency: p.currency } }],
    };
  },
};

export const disputeDraft: CommandHandler = {
  type: "finance.dispute.draft.v1",
  async run(c, cmd) {
    const p = parse(FinanceDisputeDraftV1, cmd.payload);
    if (p.lines.some((l) => (l.settlement_line_id === null) === (l.order_id === null))) throw new ApiError("invalid_payload");
    // Lines are the claim's breakdown: when present they add up to the total (packs/finance.md §6 Σ row).
    if (p.lines.length && p.lines.reduce((a, l) => a + l.claimed_minor, 0) !== p.total_claimed_minor) throw new ApiError("invalid_payload");
    // One claim per order or settlement line while a dispute holding it is open (R-B S1-C: a weekly re-draft of the same
    // missing payout must not claim it twice). Serialised per tenant so two approvals cannot both pass the check. Inside an
    // approval the held line never clears on a retry, so the draft goes stale; a person's own command gets 409.
    const orders = p.lines.flatMap((l) => (l.order_id ? [l.order_id] : []));
    const settled = p.lines.flatMap((l) => (l.settlement_line_id ? [l.settlement_line_id] : []));
    if (new Set(orders).size !== orders.length || new Set(settled).size !== settled.length) throw new ApiError("invalid_payload");
    if (p.lines.length) {
      await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('core.dispute_line:' || current_setting('app.tenant_id'), 0))`);
      const held = await c.query(
        `SELECT 1 FROM core.dispute_line l JOIN core.dispute d ON d.tenant_id = l.tenant_id AND d.id = l.dispute_id
          WHERE d.status IN ('recorded', 'sent') AND (l.order_id = ANY ($1::uuid[]) OR l.settlement_line_id = ANY ($2::uuid[])) LIMIT 1`, [orders, settled]);
      if (held.rowCount) throw (await decisionId(c)) ? new ApiError("stale_draft", "stale_draft") : new ApiError("conflict");
    }
    await c.query(
      `INSERT INTO core.dispute (tenant_id, id, counterparty, channel_id, basis, total_claimed_minor, currency)
       VALUES (current_setting('app.tenant_id')::uuid, $1, 'channel', $2, $3, $4, $5)`,
      [p.dispute_id, p.channel_id, p.basis, p.total_claimed_minor, p.currency]);
    for (const [i, l] of p.lines.entries()) {
      await c.query(
        `INSERT INTO core.dispute_line (tenant_id, id, dispute_id, line_no, settlement_line_id, order_id, claimed_minor, currency)
         VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, $7)`,
        [uuidv7(), p.dispute_id, i + 1, l.settlement_line_id, l.order_id, l.claimed_minor, p.currency]);
    }
    // Every named break must be this channel's and still open.
    const moved = await c.query<{ id: string }>(
      `UPDATE core.reconciliation_break SET status = 'disputed', dispute_id = $1
        WHERE id = ANY ($2::uuid[]) AND channel_id = $3 AND status = 'open' RETURNING id`, [p.dispute_id, p.break_ids, p.channel_id]);
    if (moved.rowCount !== new Set(p.break_ids).size) throw new ApiError("conflict");
    return {
      entityId: p.dispute_id,
      audit: [
        { entity: "core.dispute", entityId: p.dispute_id, after: { channel_id: p.channel_id, basis: p.basis, lines: p.lines.length, status: "recorded" } },
        ...moved.rows.map((r) => ({ entity: "core.reconciliation_break", entityId: r.id, before: { status: "open" }, after: { status: "disputed", dispute_id: p.dispute_id } })),
      ],
    };
  },
};

export const periodClose: CommandHandler = {
  type: "finance.period.close.v1",
  async run(c, cmd) {
    const p = parse(FinancePeriodCloseV1, cmd.payload);
    if (!p.period_month.endsWith("-01")) throw new ApiError("invalid_payload");
    await c.query(
      `INSERT INTO core.period_close (tenant_id, id, outlet_id, period_month, checklist, net_minor, currency, closed_by)
       VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, current_setting('app.member_id')::uuid)`,
      [p.period_close_id, p.outlet_id, p.period_month, JSON.stringify(p.checklist), p.net_minor, p.currency]);
    return {
      entityId: p.period_close_id,
      audit: [{ entity: "core.period_close", entityId: p.period_close_id, after: { outlet_id: p.outlet_id, period_month: p.period_month } }],
    };
  },
};

/** Executes only inside an approved draft's transaction (approvals sets app.decision_id). The database would
 *  also admit an owner's own command (command_authority), so this handler is never mounted on a route and
 *  refuses without a decision. */
export const journalAdjust: CommandHandler = {
  type: "finance.journal.adjust.v1",
  async run(c, cmd) {
    const decision = await decisionId(c);
    if (!decision) throw new ApiError("forbidden", "authority_denied");
    const p = parse(FinanceJournalAdjustV1, cmd.payload);
    const signed = p.postings.map((x) => ({ account_id: x.account_id, amount_minor: x.side === "debit" ? x.amount_minor : -x.amount_minor }));
    if (signed.reduce((a, x) => a + x.amount_minor, 0) !== 0) throw new ApiError("invalid_payload");
    if (p.reverses_id) {
      // A reversal mirrors its entry exactly (per account), so the two net to zero.
      const orig = await c.query<{ account_id: string; amount_minor: string }>(
        `SELECT account_id, sum(amount_minor) AS amount_minor FROM core.posting WHERE journal_entry_id = $1 GROUP BY account_id`, [p.reverses_id]);
      if (!orig.rows.length) throw new ApiError("invalid_payload");
      const want = new Map(orig.rows.map((r) => [r.account_id, -Number(r.amount_minor)]));
      const got = new Map<string, number>();
      for (const x of signed) got.set(x.account_id, (got.get(x.account_id) ?? 0) + x.amount_minor);
      if (want.size !== got.size || [...want].some(([a, v]) => got.get(a) !== v)) throw new ApiError("invalid_payload");
    }
    await c.query(
      `INSERT INTO core.journal_entry (tenant_id, id, outlet_id, entry_date, reverses_id, decision_id, memo_key)
       VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6)`,
      [p.journal_entry_id, p.outlet_id, p.entry_date, p.reverses_id, decision, p.memo_key]);
    for (const x of signed) {
      await c.query(
        `INSERT INTO core.posting (tenant_id, id, journal_entry_id, account_id, amount_minor, currency)
         VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5)`, [uuidv7(), p.journal_entry_id, x.account_id, x.amount_minor, p.currency]);
    }
    await checkBalancedNow(c);
    return {
      entityId: p.journal_entry_id,
      audit: [{ entity: "core.journal_entry", entityId: p.journal_entry_id, after: { entry_date: p.entry_date, reverses_id: p.reverses_id, postings: p.postings.length } }],
    };
  },
};
