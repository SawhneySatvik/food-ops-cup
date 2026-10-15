// Mock orders. A serverless host may answer each request from a different instance, so the order record travels
// inside the guest token itself (signed, so it cannot be edited). Status is a pure function of the time since
// placing: placed -> accepted (45 s) -> preparing (75 s) -> ready (110 s), then it stays ready.
// The token holds order data only: never the shopper's name, phone or email.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Schemas } from "@munim/sdk";
import { CURRENCY, TAX } from "./data";

type OrderView = Schemas["StorefrontOrderView"];
type Preview = Schemas["StorefrontPreviewResponse"];

const SECRET = process.env.MOCK_TOKEN_SECRET ?? "cobnut-mock-only-not-a-real-secret";
const STEPS: { status: OrderView["status"]; afterMs: number }[] = [
  { status: "placed", afterMs: 0 },
  { status: "accepted", afterMs: 45_000 },
  { status: "preparing", afterMs: 75_000 },
  { status: "ready", afterMs: 110_000 },
];

export interface OrderRecord {
  v: 1;
  /** A random nonce so two tokens for identical orders differ. */
  n: string;
  order_id: string;
  outlet_id: string;
  ticket_no: number;
  business_date: string;
  created_at: string;
  promised_at: string;
  pickup_window_id: string | null;
  subtotal_minor: number;
  discount_minor: number;
  tax_minor: number;
  total_minor: number;
  lines: [string, string | null, number, number, number, number][]; // item, variant, qty_milli, unit, discount, tax
}

const b64 = (s: Buffer | string) => Buffer.from(s).toString("base64url");
const sign = (body: string) => createHmac("sha256", SECRET).update(body).digest("base64url");

export function recordFrom(orderId: string, outletId: string, ticketNo: number, businessDate: string, created: Date, promised: Date, windowId: string | null, p: Preview): OrderRecord {
  return {
    v: 1,
    n: randomBytes(6).toString("hex"),
    order_id: orderId,
    outlet_id: outletId,
    ticket_no: ticketNo,
    business_date: businessDate,
    created_at: created.toISOString(),
    promised_at: promised.toISOString(),
    pickup_window_id: windowId,
    subtotal_minor: p.subtotal_minor,
    discount_minor: p.discount_minor,
    tax_minor: p.tax_minor,
    total_minor: p.total_minor,
    lines: p.lines.map((l) => [l.item_id, l.variant_id, l.qty_milli, l.unit_price_minor, l.line_discount_minor, l.tax_minor]),
  };
}

export function issueToken(r: OrderRecord): string {
  const body = b64(JSON.stringify(r));
  return `gst_${body}.${sign(body)}`;
}

/** The order a token opens, or null for any tampered, malformed or foreign token. */
export function readToken(token: string | null): OrderRecord | null {
  if (!token?.startsWith("gst_")) return null;
  const [body, mac] = token.slice(4).split(".");
  if (!body || !mac) return null;
  const want = Buffer.from(sign(body));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const r = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as OrderRecord;
    return r.v === 1 ? r : null;
  } catch {
    return null;
  }
}

/** Status events that have happened by `now`, oldest first. */
export function eventsUntil(r: OrderRecord, now: Date): OrderView["events"] {
  const created = new Date(r.created_at).getTime();
  return STEPS.filter((s) => created + s.afterMs <= now.getTime()).map((s, i, all) => ({
    kind: "status" as const,
    from_status: i === 0 ? null : all[i - 1]!.status,
    to_status: s.status,
    from_promised_at: null,
    to_promised_at: null,
    reason: null,
    at: new Date(created + s.afterMs).toISOString(),
  }));
}

export function viewOf(r: OrderRecord, now: Date): OrderView {
  const events = eventsUntil(r, now);
  return {
    order_id: r.order_id,
    outlet_id: r.outlet_id,
    kind: "pickup",
    status: (events[events.length - 1]?.to_status ?? "placed") as OrderView["status"],
    ticket_no: r.ticket_no,
    business_date: r.business_date,
    promised_at: r.promised_at,
    pickup_window_id: r.pickup_window_id,
    subtotal_minor: r.subtotal_minor,
    discount_minor: r.discount_minor,
    tax_minor: r.tax_minor,
    total_minor: r.total_minor,
    currency: CURRENCY,
    created_at: r.created_at,
    cancel_window_min: 1,
    reschedule_window_min: 1,
    pay_at_counter: true,
    prices_include_tax: false,
    lines: r.lines.map(([item_id, variant_id, qty_milli, unit_price_minor, line_discount_minor, tax_minor], i) => ({
      line_no: i + 1,
      item_id,
      variant_id,
      qty_milli,
      unit_price_minor,
      line_discount_minor,
      tax_minor,
      tax_rate_bp: TAX.rateBp,
      tax_component_rates: TAX.components.map((c) => ({ code: c.code, rate_bp: c.rateBp })),
    })),
    events,
  };
}
