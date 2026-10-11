// Finance read models. Aggregates reach a screen only as snapshot cells (R26, guarantee clause 2), so the
// P&L and GST read models are written here as the snapshot TEMPLATES W3 (M-C) installs — this file is the
// source of their SQL, and the T-026 gates run exactly this SQL as a template against hand-written answer
// keys. No route here returns an aggregate. The Tally export returns posting rows' own amounts.
import { codesOf, PNL_GROUPS, ROLES, type TallyVoucher, tallyCsv } from "@munim/core-domain/finance";
import type { Tx } from "./post.ts";
import { tenantPack } from "./post.ts";

const list = (codes: readonly string[]) => codes.map((c) => `'${c}'`).join(", ");
const INMONTH = (col: string) => `${col} >= :period_month::date AND ${col} < (:period_month::date + interval '1 month')`;

/** finance.pnl — P&L by outlet / brand / channel from postings only (closed periods immutable). */
const PNL_SQL = `SELECT coalesce((CASE :group_by WHEN 'outlet' THEN je.outlet_id WHEN 'brand' THEN je.brand_id WHEN 'channel' THEN je.channel_id END)::text, 'unassigned') AS key,
       coalesce(-sum(p.amount_minor) FILTER (WHERE a.type = 'income'), 0)::bigint AS revenue_minor,
       coalesce(sum(p.amount_minor) FILTER (WHERE a.code IN (${list(codesOf(PNL_GROUPS.cogs))})), 0)::bigint AS cogs_minor,
       coalesce(sum(p.amount_minor) FILTER (WHERE a.code IN (${list(codesOf(PNL_GROUPS.channel_fees))})), 0)::bigint AS channel_fees_minor,
       coalesce(sum(p.amount_minor) FILTER (WHERE a.code IN (${list(codesOf(PNL_GROUPS.labour))})), 0)::bigint AS labour_minor,
       coalesce(sum(p.amount_minor) FILTER (WHERE a.type = 'expense' AND a.code NOT IN (${list([...codesOf(PNL_GROUPS.cogs), ...codesOf(PNL_GROUPS.channel_fees), ...codesOf(PNL_GROUPS.labour)])})), 0)::bigint AS other_minor,
       (-sum(p.amount_minor))::bigint AS net_minor
  FROM core.journal_entry je
  JOIN core.posting p ON p.tenant_id = je.tenant_id AND p.journal_entry_id = je.id
  JOIN core.account a ON a.tenant_id = p.tenant_id AND a.id = p.account_id
 WHERE a.type IN ('income', 'expense') AND :group_by IN ('outlet', 'brand', 'channel') AND ${INMONTH("je.entry_date")}
 GROUP BY 1 ORDER BY 1`;

/** Orders whose tax the operator pays (pack aggregators with tax_treatment operator_collects_excluded) are
 *  not the merchant's output tax — the same reading as postOrder. */
const EXCLUDED_KINDS = `SELECT 'aggregator:' || (a ->> 'code') FROM core.tenant t
          JOIN platform.country_pack cp ON cp.code = t.country_code AND cp.status = 'active'
          CROSS JOIN LATERAL jsonb_array_elements(cp.doc -> 'aggregators') a
         WHERE a ->> 'tax_treatment' = 'operator_collects_excluded'
           AND cp.version = (SELECT max(v.version) FROM platform.country_pack v WHERE v.code = t.country_code AND v.status = 'active')`;

/** finance.gst_check v2 (0023 F4) — completed orders' own-liability tax vs output tax posted from them, per outlet;
 *  `outlet_id` (nullable, required as every named param) narrows both sides to one outlet, NULL = every outlet in scope. */
const GST_CHECK_SQL = `WITH ot AS (
  SELECT o.outlet_id, sum(o.tax_minor)::bigint AS order_tax_minor
    FROM core."order" o JOIN core.channel ch ON ch.tenant_id = o.tenant_id AND ch.id = o.channel_id
   WHERE o.status = 'completed' AND ${INMONTH("o.business_date")} AND ch.kind NOT IN (${EXCLUDED_KINDS})
     AND (:outlet_id::uuid IS NULL OR o.outlet_id = :outlet_id::uuid)
   GROUP BY o.outlet_id),
pt AS (
  SELECT je.outlet_id, (-sum(p.amount_minor))::bigint AS posted_tax_minor
    FROM core.journal_entry je
    JOIN core.posting p ON p.tenant_id = je.tenant_id AND p.journal_entry_id = je.id
    JOIN core.account a ON a.tenant_id = p.tenant_id AND a.id = p.account_id
   WHERE je.posting_rule = 'finance.post_order' AND a.code IN (${list(ROLES.output_tax.codes)}) AND ${INMONTH("je.entry_date")}
     AND (:outlet_id::uuid IS NULL OR je.outlet_id = :outlet_id::uuid)
   GROUP BY je.outlet_id)
SELECT coalesce(ot.outlet_id, pt.outlet_id) AS outlet_id, coalesce(ot.order_tax_minor, 0) AS order_tax_minor,
       coalesce(pt.posted_tax_minor, 0) AS posted_tax_minor, coalesce(pt.posted_tax_minor, 0) - coalesce(ot.order_tax_minor, 0) AS diff_minor
  FROM ot FULL JOIN pt ON pt.outlet_id = ot.outlet_id
 ORDER BY 1`;

/** finance.gst_summary — the month's output tax (net of refunds and channel withholding), input tax and the
 *  net payable, per outlet (unassigned = tenant-wide entries), from postings. */
const GST_SUMMARY_SQL = `SELECT coalesce(je.outlet_id::text, 'unassigned') AS key,
       coalesce(-sum(p.amount_minor) FILTER (WHERE a.code IN (${list(ROLES.output_tax.codes)})), 0)::bigint AS output_tax_minor,
       coalesce(sum(p.amount_minor) FILTER (WHERE a.code IN (${list(ROLES.input_tax.codes)})), 0)::bigint AS input_tax_minor,
       (coalesce(-sum(p.amount_minor) FILTER (WHERE a.code IN (${list(ROLES.output_tax.codes)})), 0)
        - coalesce(sum(p.amount_minor) FILTER (WHERE a.code IN (${list(ROLES.input_tax.codes)})), 0))::bigint AS net_payable_minor
  FROM core.journal_entry je
  JOIN core.posting p ON p.tenant_id = je.tenant_id AND p.journal_entry_id = je.id
  JOIN core.account a ON a.tenant_id = p.tenant_id AND a.id = p.account_id
 WHERE a.code IN (${list([...ROLES.output_tax.codes, ...ROLES.input_tax.codes])}) AND ${INMONTH("je.entry_date")}
 GROUP BY 1 ORDER BY 1`;

const POSTING = "core.posting.amount_minor";
const MONTH_PARAM = { period_month: { type: "string", format: "date" } };

/** Templates for M-C to install (evidence.snapshot_template rows). min_role owner: finance is owner-level. */
export const FINANCE_TEMPLATES = [
  {
    id: "finance.pnl", version: 1, sql: PNL_SQL, min_role: "advisor",
    params_schema: { type: "object", required: ["period_month", "group_by"], additionalProperties: false,
      properties: { ...MONTH_PARAM, group_by: { type: "string", enum: ["outlet", "brand", "channel"] } } },
    columns: [
      { name: "key", type: "text" },
      ...["revenue_minor", "cogs_minor", "channel_fees_minor", "labour_minor", "other_minor", "net_minor"].map((name) => ({ name, type: "integer", numeric_source: POSTING })),
    ],
  },
  {
    id: "finance.gst_check", version: 2, sql: GST_CHECK_SQL, min_role: "advisor",
    params_schema: { type: "object", required: ["period_month", "outlet_id"], additionalProperties: false,
      properties: { ...MONTH_PARAM, outlet_id: { type: ["string", "null"], format: "uuid" } } },
    columns: [
      { name: "outlet_id", type: "uuid" },
      { name: "order_tax_minor", type: "integer", numeric_source: "core.order.tax_minor" },
      { name: "posted_tax_minor", type: "integer", numeric_source: POSTING },
      { name: "diff_minor", type: "integer", numeric_source: POSTING },
    ],
  },
  {
    id: "finance.gst_summary", version: 1, sql: GST_SUMMARY_SQL, min_role: "owner",
    params_schema: { type: "object", required: ["period_month"], additionalProperties: false, properties: MONTH_PARAM },
    columns: [
      { name: "key", type: "text" },
      ...["output_tax_minor", "input_tax_minor", "net_payable_minor"].map((name) => ({ name, type: "integer", numeric_source: POSTING })),
    ],
  },
] as const;

/** The Tally CSV for entries dated from..to (inclusive), every amount a posting row's own field. */
export async function tallyExport(tx: Tx, from: string, to: string): Promise<{ file_name: string; content_type: "text/csv"; content: string }> {
  const r = await tx.query<{ entry_id: string; entry_date: string; narration: string; account_code: string; account_name: string; amount_minor: string }>(
    `SELECT je.id AS entry_id, je.entry_date::text AS entry_date, coalesce(je.memo_key, je.posting_rule, 'finance.manual') AS narration,
            a.code AS account_code, a.name AS account_name, p.amount_minor
       FROM core.journal_entry je
       JOIN core.posting p ON p.tenant_id = je.tenant_id AND p.journal_entry_id = je.id
       JOIN core.account a ON a.tenant_id = p.tenant_id AND a.id = p.account_id
      WHERE je.entry_date BETWEEN $1::date AND $2::date
      ORDER BY je.entry_date, je.created_at, je.id, p.amount_minor DESC, a.code`, [from, to]);
  const vouchers: TallyVoucher[] = [];
  for (const row of r.rows) {
    let v = vouchers.at(-1);
    if (v?.entry_id !== row.entry_id) {
      v = { entry_id: row.entry_id, entry_date: row.entry_date, narration: row.narration, postings: [] };
      vouchers.push(v);
    }
    (v.postings as Array<TallyVoucher["postings"][number]>).push({ account_code: row.account_code, account_name: row.account_name, amount_minor: Number(row.amount_minor) });
  }
  const pack = await tenantPack(tx);
  return { file_name: `munim-tally-${from}-to-${to}.csv`, content_type: "text/csv", content: tallyCsv(vouchers, pack.currency.minor_unit) };
}

/** Recorded channel terms, the rows' own fields, newest window first (one channel when `channelId` is given). */
export async function listChannelTerms(tx: Tx, channelId: string | null) {
  const r = await tx.query<{ id: string; channel_id: string; commission_bp: number; ads_opted_in: boolean; ad_spend_cap_minor: string | null;
    promo_share_bp: number; payout_cycle_days: number; currency: string; valid_from: string; valid_to: string | null }>(
    `SELECT id, channel_id, commission_bp, ads_opted_in, ad_spend_cap_minor::text, promo_share_bp, payout_cycle_days, currency, valid_from::text, valid_to::text
       FROM core.channel_terms WHERE $1::uuid IS NULL OR channel_id = $1 ORDER BY channel_id, valid_from DESC, id`, [channelId]);
  return {
    channel_terms: r.rows.map((t) => ({
      channel_terms_id: t.id, channel_id: t.channel_id, commission_bp: t.commission_bp, ads_opted_in: t.ads_opted_in,
      ad_spend_cap_minor: t.ad_spend_cap_minor === null ? null : Number(t.ad_spend_cap_minor), promo_share_bp: t.promo_share_bp,
      payout_cycle_days: t.payout_cycle_days, currency: t.currency, valid_from: t.valid_from, valid_to: t.valid_to,
    })),
  };
}
