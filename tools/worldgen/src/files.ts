// The files a merchant exports from an aggregator, in the synthetic layouts core-api's built-in parsers read
// (the same headers; "-shaped" synthetic data, never an operator's real export). Money columns are written in
// the unit the header names (rupees/dollars as decimals, paise/cents as integers).
import { csv, major } from "./csv.ts";

export type Layout = "swiggy" | "zomato" | "ubereats" | "doordash";

/** One payout line. `kind` is the line's meaning; `net` is always gross − commission − ads − promo − tax. */
export interface PayoutLine {
  kind: "order" | "ads";
  orderRef: string;
  orderDate: string;
  gross: number;
  commission: number;
  ad: number;
  promo: number;
  tax: number;
}

export const netOf = (l: PayoutLine): number => l.gross - l.commission - l.ad - l.promo - l.tax;

const dmy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

interface Spec {
  header: string[];
  date: (d: string) => string;
  money: (m: number) => string;
  labels: { order: string; ads: string };
  currency: string | null;
  /** column index of the payout net column (the TOTAL row carries the file's total there). */
  netCol: number;
}
const SPEC: Record<Layout, Spec> = {
  swiggy: {
    header: ["Payout Ref", "Cycle Start", "Cycle End", "Paid On", "Outlet", "Order No", "Order Date", "Line Type", "Order Value (Rs)", "Commission (Rs)", "Ads (Rs)", "Discount Share (Rs)", "GST Withheld (Rs)", "Net Payable (Rs)"],
    date: dmy, money: major, labels: { order: "Order", ads: "Ads" }, currency: null, netCol: 13,
  },
  zomato: {
    header: ["settlement_id", "period_from", "period_to", "settled_on", "outlet_name", "order_id", "order_date", "entry_type", "bill_amount_paise", "platform_fee_paise", "ads_fee_paise", "promo_paise", "tax_deducted_paise", "payout_paise", "currency"],
    date: (d) => d, money: String, labels: { order: "order", ads: "ads" }, currency: "INR", netCol: 13,
  },
  ubereats: {
    header: ["Statement ID", "Period Start", "Period End", "Payment Date", "Store", "Order ID", "Date", "Type", "Sales (incl. GST)", "Service Fee", "Marketing", "Offers", "Tax Withheld", "Payout", "Currency"],
    date: dmy, money: major, labels: { order: "Order", ads: "Marketing" }, currency: "AUD", netCol: 13,
  },
  doordash: {
    header: ["payout_id", "start_date", "end_date", "payout_date", "store_name", "order_ref", "order_date", "transaction_type", "subtotal_cents", "commission_cents", "marketing_cents", "promotion_cents", "withheld_cents", "net_cents"],
    date: (d) => d, money: String, labels: { order: "delivery", ads: "marketing_fee" }, currency: null, netCol: 13,
  },
};

export function payoutFile(layout: Layout, p: { ref: string; outlet: string; from: string; to: string; paidOn: string }, lines: PayoutLine[]): string {
  const s = SPEC[layout];
  const rows: Array<Array<string | number>> = [s.header];
  let total = 0;
  for (const l of lines) {
    const net = netOf(l);
    total += net;
    rows.push([
      p.ref, s.date(p.from), s.date(p.to), s.date(p.paidOn), p.outlet, l.orderRef, s.date(l.orderDate), l.kind === "order" ? s.labels.order : s.labels.ads,
      s.money(l.gross), s.money(l.commission), s.money(l.ad), s.money(l.promo), s.money(l.tax), s.money(net), ...(s.currency ? [s.currency] : []),
    ]);
  }
  const t: Array<string | number> = s.header.map(() => "");
  t[0] = "TOTAL";
  t[s.netCol] = s.money(total);
  rows.push(t);
  return csv(rows);
}
