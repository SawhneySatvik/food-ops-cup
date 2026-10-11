// Finance read responses and routes (T-092a; hand list rows 3-6). Tenant-wide finance roles only (owner, advisor, judge).
// Amounts are the rows' own fields in minor units with their currency (R26). Imported text (an aggregator's order reference,
// a bank narration) is untrusted and travels as plain strings.
import { z } from "zod";
import { CurrencyCode, IsoDate, IsoDateTime, MinorAmount, Slug, Uuid7 } from "../shared/primitives.ts";
import type { QueryParam, Route } from "../shared/routes.ts";

const Page = <T extends z.ZodType>(item: T) => z.strictObject({ items: z.array(item), next_cursor: Uuid7.nullable() });

const SettlementItem = z.strictObject({
  settlement_id: Uuid7, channel_id: Uuid7, outlet_id: Uuid7.nullable(), period_from: IsoDate, period_to: IsoDate, paid_on: IsoDate.nullable(),
  external_ref: z.string(), net_minor: MinorAmount, currency: CurrencyCode, created_at: IsoDateTime,
}).meta({ title: "SettlementItem" });

const SettlementLineItem = z.strictObject({
  settlement_line_id: Uuid7, settlement_id: Uuid7, channel_id: Uuid7, line_no: z.int().min(1),
  line_kind: z.enum(["order", "ad_fee", "promo_share", "adjustment", "other"]), external_order_ref: z.string().nullable(), matched_order_id: Uuid7.nullable(),
  gross_minor: MinorAmount, commission_minor: MinorAmount, ad_fee_minor: MinorAmount, promo_share_minor: MinorAmount, tax_withheld_minor: MinorAmount,
  net_minor: MinorAmount, currency: CurrencyCode,
}).meta({ title: "SettlementLineItem" });

const BankLineItem = z.strictObject({
  bank_line_id: Uuid7, outlet_id: Uuid7.nullable(), account_ref: z.string(), value_date: IsoDate, amount_minor: MinorAmount, currency: CurrencyCode,
  method: z.enum(["upi", "card", "bank_transfer", "neft", "imps", "rtgs", "cash_deposit", "cheque", "fee", "other"]), payee_vpa: z.string().nullable(),
  narration: z.string().nullable(), external_ref: z.string(), created_at: IsoDateTime,
}).meta({ title: "BankLineItem" });

const dispute = {
  dispute_id: Uuid7, counterparty: z.enum(["channel", "supplier"]), channel_id: Uuid7.nullable(), supplier_id: Uuid7.nullable(), supplier_invoice_id: Uuid7.nullable(),
  basis: z.enum(["unapproved_ad_fee", "short_payout", "missing_payout", "overbilled", "duplicate_invoice", "other"]),
  total_claimed_minor: MinorAmount, currency: CurrencyCode, status: z.enum(["recorded", "sent", "resolved", "rejected", "withdrawn"]),
  resolved_minor: MinorAmount.nullable(), created_at: IsoDateTime,
};
const DisputeItem = z.strictObject(dispute).meta({ title: "DisputeItem" });
const DisputeDetail = z.strictObject({
  ...dispute,
  lines: z.array(z.strictObject({
    dispute_line_id: Uuid7, line_no: z.int().min(1), settlement_line_id: Uuid7.nullable(), order_id: Uuid7.nullable(), supplier_invoice_line_id: Uuid7.nullable(),
    claimed_minor: MinorAmount, currency: CurrencyCode,
  })),
});

const PeriodCloseItem = z.strictObject({
  period_close_id: Uuid7, outlet_id: Uuid7.nullable(), period_month: IsoDate,
  checklist: z.array(z.strictObject({ item_code: Slug, evidence_ref: z.string() })), net_minor: MinorAmount, currency: CurrencyCode, closed_by: Uuid7, closed_at: IsoDateTime,
}).meta({ title: "PeriodCloseItem" });

export const READ_SCHEMAS = {
  "v1.finance.settlements": Page(SettlementItem),
  "v1.finance.settlement-lines": Page(SettlementLineItem),
  "v1.finance.bank-lines": Page(BankLineItem),
  "v1.finance.disputes": Page(DisputeItem),
  "v1.finance.dispute": DisputeDetail,
  "v1.finance.period-closes": Page(PeriodCloseItem),
};

const uuid = { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" };
const date = { type: "string", format: "date" };
const param = (name: string, schema: Record<string, unknown>): QueryParam => ({ name, required: false, schema });
const cursor = param("cursor", uuid);
const limit = param("limit", { type: "integer", minimum: 1, maximum: 200 });
const read = (path: string, operationId: string, summary: string, response: string, extra: Partial<Route> = {}): Route =>
  ({ surface: "public", method: "get", path, operationId, summary, auth: "member", response, status: 200, ...extra });

export const READ_ROUTES: readonly Route[] = [
  read("/v1/finance/settlements", "listSettlements", "Channel settlements (owner, advisor, judge); from / to overlap the settlement period", "v1.finance.settlements", { query: [param("channel", uuid), param("from", date), param("to", date), limit, cursor] }),
  read("/v1/finance/settlement-lines", "listSettlementLines", "Settlement lines with commission, ad fee, promo share and tax withheld (owner, advisor, judge)", "v1.finance.settlement-lines", { query: [param("channel", uuid), param("from", date), param("to", date), limit, cursor] }),
  read("/v1/finance/bank-lines", "listBankLines", "Imported bank lines by value date (owner, advisor, judge)", "v1.finance.bank-lines", { query: [param("from", date), param("to", date), limit, cursor] }),
  read("/v1/finance/disputes", "listDisputes", "Recorded disputes with channels and suppliers (owner, advisor, judge)", "v1.finance.disputes",
    { query: [param("status", { type: "string", enum: ["recorded", "sent", "resolved", "rejected", "withdrawn"] }), param("counterparty", { type: "string", enum: ["channel", "supplier"] }), limit, cursor] }),
  read("/v1/finance/disputes/{id}", "getDispute", "One dispute with its claimed lines", "v1.finance.dispute", { pathParams: [{ name: "id", uuid: true }] }),
  read("/v1/finance/period-closes", "listPeriodCloses", "Closed periods with their checklist (owner, advisor, judge)", "v1.finance.period-closes", { query: [param("from", date), param("to", date), limit, cursor] }),
];
