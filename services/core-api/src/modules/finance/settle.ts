// Settlements and bank lines arrive only through an APPROVED import (R28). T-030's import commit — running
// under the approved imports.run.commit.v1 decision, with its import run already flipped to 'committed' in
// the same transaction — calls these seams:
//   recordSettlement(tx, s)  → settlement + lines, its journal entry (finance.post_settlement), its breaks
//                              (finance.reconcile_settlement);
//   recordBankLines(tx, …)   → statement lines (no posting rule: bank money is posted from tenders and
//                              settlements; the lines are what those are matched against).
// Order matters: the posting and reconcile rules' source_state needs the run to be 'committed', so both seams
// refuse a run in any other state before writing anything.
import { channelTreatment } from "@munim/core-domain/finance";
import { ApiError } from "../../lib/errors.ts";
import { uuidv7 } from "../../commit/index.ts";
import { postFor, tenantPack, type Tx, underRule } from "./post.ts";

export type SettlementInput = {
  settlement_id: string;
  channel_id: string;
  outlet_id: string | null;
  period_from: string;
  period_to: string;
  paid_on: string | null;
  external_ref: string;
  net_minor: number;
  currency: string;
  import_run_id: string;
  lines: Array<{
    line_id: string;
    line_no: number;
    line_kind: "order" | "ad_fee" | "promo_share" | "adjustment" | "other";
    external_order_ref: string | null;
    matched_order_id: string | null;
    gross_minor: number;
    commission_minor: number;
    ad_fee_minor: number;
    promo_share_minor: number;
    tax_withheld_minor: number;
    net_minor: number;
  }>;
};

export type BankLineInput = {
  bank_line_id: string;
  outlet_id: string | null;
  account_ref: string;
  value_date: string;
  amount_minor: number;
  currency: string;
  method: "upi" | "card" | "bank_transfer" | "neft" | "imps" | "rtgs" | "cash_deposit" | "cheque" | "fee" | "other";
  payee_vpa: string | null;
  narration: string | null;
  external_ref: string;
};

/** A settlement or bank line with no import run, or one not committed, is refused (book_write_refused):
 *  nothing is recorded or reconciled until a person approves the import. */
async function requireCommittedRun(tx: Tx, runId: string | null | undefined): Promise<void> {
  if (!runId) throw new ApiError("book_write_refused", "authority_denied");
  const r = await tx.query<{ status: string }>(`SELECT status FROM core.import_run WHERE id = $1`, [runId]);
  if (r.rows[0]?.status !== "committed") throw new ApiError("book_write_refused", "authority_denied");
}

export async function recordSettlement(tx: Tx, s: SettlementInput): Promise<{ settlement_id: string; entry_id: string | null; break_ids: string[] }> {
  await requireCommittedRun(tx, s.import_run_id);
  await tx.query(
    `INSERT INTO core.settlement (tenant_id, id, channel_id, outlet_id, period_from, period_to, paid_on, external_ref, net_minor, currency, import_run_id)
     VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [s.settlement_id, s.channel_id, s.outlet_id, s.period_from, s.period_to, s.paid_on, s.external_ref, s.net_minor, s.currency, s.import_run_id]);
  for (const l of s.lines) {
    await tx.query(
      `INSERT INTO core.settlement_line (tenant_id, id, settlement_id, line_no, line_kind, external_order_ref, matched_order_id, gross_minor,
                                         commission_minor, ad_fee_minor, promo_share_minor, tax_withheld_minor, net_minor, currency)
       VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [l.line_id, s.settlement_id, l.line_no, l.line_kind, l.external_order_ref, l.matched_order_id, l.gross_minor, l.commission_minor,
       l.ad_fee_minor, l.promo_share_minor, l.tax_withheld_minor, l.net_minor, s.currency]);
  }
  const posted = await postFor(tx, "finance.post_settlement", `core.settlement:${s.settlement_id}`);
  const breaks = await reconcileSettlement(tx, s.settlement_id);
  return { settlement_id: s.settlement_id, entry_id: posted.entry_id, break_ids: breaks };
}

export async function recordBankLines(tx: Tx, importRunId: string, lines: readonly BankLineInput[]): Promise<string[]> {
  await requireCommittedRun(tx, importRunId);
  for (const b of lines) {
    await tx.query(
      `INSERT INTO core.bank_line (tenant_id, id, outlet_id, account_ref, value_date, amount_minor, currency, method, payee_vpa, narration, external_ref, import_run_id)
       VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [b.bank_line_id, b.outlet_id, b.account_ref, b.value_date, b.amount_minor, b.currency, b.method, b.payee_vpa, b.narration, b.external_ref, importRunId]);
  }
  return lines.map((b) => b.bank_line_id);
}

type Terms = { commission_bp: number; ads_opted_in: boolean; ad_spend_cap_minor: string | null };

/** finance.reconcile_settlement — breaks a person can dispute (packs/finance.md §2):
 *   short_payout: an order line paid less than expected net = order total − contracted commission on gross
 *     − the tax the pack says the operator keeps − our refunds, by at least the pack's line threshold
 *     (detectors.finance.short_payout). R2-S2-9: where the operator collects the tax (IN Sec 9(5)) that is the
 *     ORDER's own tax, never the file's figure — a statement withholding more is short by the excess. Where the
 *     merchant collects it, the file's withholding is a credit against our output tax (post_settlement), not money
 *     lost, so the file's figure is expected;
 *   unapproved_deduction: an ad fee when the channel's terms say not opted in (per line), or the month's ad
 *     fees above the recorded cap (one break for the excess not already broken).
 *  No terms for the settlement date → no break (cannot verify; intel refuses with consent_record_missing).
 *  Re-running never duplicates a break. */
export async function reconcileSettlement(tx: Tx, settlementId: string): Promise<string[]> {
  const s = (await tx.query<{ channel_id: string; outlet_id: string | null; period_to: string; currency: string; import_run_id: string | null }>(
    `SELECT channel_id, outlet_id, period_to::text AS period_to, currency, import_run_id FROM core.settlement WHERE id = $1`, [settlementId])).rows[0];
  if (!s) throw new Error("finance: settlement not found");
  const terms = (await tx.query<Terms>(
    `SELECT commission_bp, ads_opted_in, ad_spend_cap_minor FROM core.channel_terms
      WHERE channel_id = $1 AND valid_from <= $2::date AND (valid_to IS NULL OR valid_to > $2::date)`, [s.channel_id, s.period_to])).rows[0];
  if (!terms) return [];
  const pack = await tenantPack(tx);
  const th = pack.detectors["finance.short_payout"]?.thresholds ?? {};
  const kind = (await tx.query<{ kind: string }>(`SELECT kind FROM core.channel WHERE id = $1`, [s.channel_id])).rows[0]!.kind;
  const operatorTax = channelTreatment(pack, kind).operator_collects;
  const minLine = th.line_short_minor_gte ?? 1;
  const minBp = th.line_short_bp_gte ?? 0;

  type B = { kind: string; settlement_line_id: string | null; order_id: string | null; amount_minor: number };
  const out: B[] = [];
  const shorts = await tx.query<{ line_id: string; order_id: string; short_minor: string; expected_minor: string }>(
    `SELECT sl.id AS line_id, o.id AS order_id, x.expected_minor, x.expected_minor - sl.net_minor AS short_minor
       FROM core.settlement_line sl
       JOIN core."order" o ON o.tenant_id = sl.tenant_id AND o.id = sl.matched_order_id
       CROSS JOIN LATERAL (SELECT o.total_minor - round(sl.gross_minor * $2::numeric / 10000)::bigint - CASE WHEN $3::boolean THEN o.tax_minor ELSE sl.tax_withheld_minor END
                                  - coalesce((SELECT sum(f.amount_minor) FROM core.refund f WHERE f.tenant_id = o.tenant_id AND f.order_id = o.id), 0)
                                  AS expected_minor) x
      WHERE sl.settlement_id = $1 AND sl.line_kind = 'order'
        AND NOT EXISTS (SELECT 1 FROM core.reconciliation_break b WHERE b.settlement_line_id = sl.id AND b.kind = 'short_payout')
      ORDER BY sl.line_no`, [settlementId, terms.commission_bp, operatorTax]);
  for (const r of shorts.rows) {
    const short = Number(r.short_minor);
    if (short > 0 && short >= Math.max(minLine, Math.ceil((Number(r.expected_minor) * minBp) / 10000))) {
      out.push({ kind: "short_payout", settlement_line_id: r.line_id, order_id: r.order_id, amount_minor: short });
    }
  }

  if (!terms.ads_opted_in) {
    const ads = await tx.query<{ line_id: string; ad_fee_minor: string }>(
      `SELECT sl.id AS line_id, sl.ad_fee_minor FROM core.settlement_line sl
        WHERE sl.settlement_id = $1 AND sl.ad_fee_minor > 0
          AND NOT EXISTS (SELECT 1 FROM core.reconciliation_break b WHERE b.settlement_line_id = sl.id AND b.kind = 'unapproved_deduction')
        ORDER BY sl.line_no`, [settlementId]);
    for (const a of ads.rows) out.push({ kind: "unapproved_deduction", settlement_line_id: a.line_id, order_id: null, amount_minor: Number(a.ad_fee_minor) });
  } else if (terms.ad_spend_cap_minor !== null) {
    // The month's ad fees on this channel (settlements by period_to) above the cap, less the excess already
    // broken this month. The break hangs on this settlement's last ad-fee line (its month = that settlement's).
    const m = (await tx.query<{ excess: string; line_id: string | null }>(
      `WITH month AS (SELECT date_trunc('month', $2::date)::date AS m),
            fees AS (SELECT sl.id, sl.line_no, sl.settlement_id, sl.ad_fee_minor, st.channel_id
                       FROM core.settlement st JOIN core.settlement_line sl ON sl.tenant_id = st.tenant_id AND sl.settlement_id = st.id, month
                      WHERE st.channel_id = $1 AND date_trunc('month', st.period_to)::date = month.m AND sl.ad_fee_minor > 0)
       SELECT greatest(coalesce((SELECT sum(ad_fee_minor) FROM fees), 0) - $3::bigint, 0)
              - coalesce((SELECT sum(b.amount_minor) FROM core.reconciliation_break b JOIN fees f ON f.id = b.settlement_line_id
                           WHERE b.kind = 'unapproved_deduction'), 0) AS excess,
              (SELECT f.id FROM fees f WHERE f.settlement_id = $4 ORDER BY f.line_no DESC LIMIT 1) AS line_id`,
      [s.channel_id, s.period_to, terms.ad_spend_cap_minor, settlementId])).rows[0]!;
    if (Number(m.excess) > 0 && m.line_id) out.push({ kind: "unapproved_deduction", settlement_line_id: m.line_id, order_id: null, amount_minor: Number(m.excess) });
  }

  const ids: string[] = [];
  await underRule(tx, "finance.reconcile_settlement", `core.settlement:${settlementId}`, async () => {
    for (const b of out) {
      const id = uuidv7();
      await tx.query(
        `INSERT INTO core.reconciliation_break (tenant_id, id, kind, channel_id, outlet_id, settlement_line_id, order_id, import_run_id, amount_minor, currency)
         VALUES (current_setting('app.tenant_id')::uuid, $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, b.kind, s.channel_id, s.outlet_id, b.settlement_line_id, b.order_id, s.import_run_id, b.amount_minor, s.currency]);
      ids.push(id);
    }
  });
  return ids;
}
