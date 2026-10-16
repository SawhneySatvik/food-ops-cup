// Read side of the customers module. Every list is a plain read of rows under the caller's RLS context
// (tenant; a customer context additionally sees only its own customer/loyalty rows). Outlet-scoped tables
// (reservation, review, bulk_order) are filtered to the member's outlets here — their RLS is tenant-only.
// Numbers are the rows' own fields; there is no aggregate in this file.
import type {
  BulkOrderView, CampaignView, CouponUseView, CustomerView, LoyaltyEntryView, LoyaltyLedgerResponse, ReservationView, ReviewView,
} from "@munim/contracts/customers";
import type { Queryable } from "../../runtoken/index.ts";

type Of<T extends { _output: unknown }> = T["_output"];
const iso = (d: Date | string): string => new Date(d).toISOString();
const int = (v: string | number | null): number | null => (v === null ? null : Number(v));

/** The record's `consent` as the view's {email, sms} (R71). A customer's own grant is {marketing, at} (accounts/handlers.ts), and
 *  "Send me offers" is consent for email only: sms needs its own flag. Staff can only withdraw, which writes email/sms false
 *  (records.ts); a channel's own flag wins over `marketing`, so a withdrawal holds. A value that is not a boolean counts as not
 *  set — the rule of the customers.consented_audience template (0035), which counts the audience a campaign cites. */
const consentFlags = (c: Record<string, unknown>): { email: boolean; sms: boolean } => {
  const flag = (k: string): boolean | undefined => {
    const v = c[k];
    return typeof v === "boolean" ? v : undefined;
  };
  return { email: flag("email") ?? flag("marketing") ?? false, sms: flag("sms") ?? false };
};

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

/** "+919876543210" → "+91••••••3210": country prefix (first 3) and the last four digits. */
export const maskPhone = (p: string | null): string | null => (p === null ? null : p.length <= 7 ? "••••" : `${p.slice(0, 3)}${"•".repeat(p.length - 7)}${p.slice(-4)}`);

export interface CustomerFilter {
  q?: string | undefined;
  limit: number;
  cursor?: string | undefined;
  full: boolean; // owner / manager / judge see full contacts; staff see masked phones and no email
}

export async function listCustomers(c: Queryable, f: CustomerFilter): Promise<{ customers: Of<typeof CustomerView>[]; next_cursor: string | null }> {
  const q = f.q?.trim() ?? "";
  const digits = q.replace(/\D/g, "");
  const like = `%${escapeLike(q)}%`;
  const r = await c.query<{ id: string; name: string | null; phone: string | null; email: string | null; consent: Record<string, unknown>; has_account: boolean; erased: boolean; created_at: Date }>(
    `SELECT id, name, phone, email, consent, idp_sub IS NOT NULL AS has_account, erased_at IS NOT NULL AS erased, created_at
       FROM core.customer
      WHERE ($1 = '' OR name ILIKE $2 OR ($6::boolean AND email ILIKE $2)
             OR ($3 <> '' AND (CASE WHEN $6 THEN regexp_replace(coalesce(phone, ''), '\\D', '', 'g')
                                    ELSE right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 4) END) LIKE '%' || $3 || '%'))
        AND ($4::uuid IS NULL OR id < $4::uuid)
      ORDER BY id DESC LIMIT $5`,
    // R1-m2: a caller shown masked contacts matches only what it is shown — the name and the phone's last four digits,
    // never the email or the hidden digits (a search that matched them would reveal them one guess at a time).
    [q, like, digits, f.cursor ?? null, f.limit + 1, f.full]);
  const page = r.rows.slice(0, f.limit);
  return {
    customers: page.map((x) => ({
      customer_id: x.id, name: x.name,
      phone: f.full ? x.phone : maskPhone(x.phone), email: f.full ? x.email : null,
      consent: consentFlags(x.consent), has_account: x.has_account, erased: x.erased, created_at: iso(x.created_at),
    })),
    next_cursor: r.rows.length > f.limit ? page[page.length - 1]!.id : null,
  };
}

interface EntryRow {
  id: string; customer_id: string; seq: string; kind: Of<typeof LoyaltyEntryView>["kind"]; points: string; balance_after: string;
  order_id: string | null; reverses_id: string | null; note: string | null; created_at: Date;
}

/** The ledger as the caller's RLS shows it: a member sees any customer's, a customer context only its own rows
 *  (another customer's id returns nothing — never an error that confirms it exists). Newest first. */
export async function readLoyalty(c: Queryable, customerId: string, limit = 100): Promise<Of<typeof LoyaltyLedgerResponse>> {
  const r = await c.query<EntryRow>(
    `SELECT id, customer_id, seq::text, kind, points::text, balance_after::text, order_id, reverses_id, note, created_at
       FROM core.loyalty_entry e WHERE e.customer_id = $1 ORDER BY e.seq DESC LIMIT $2`, [customerId, limit]);
  const entries = r.rows.map((e) => ({
    entry_id: e.id, customer_id: e.customer_id, seq: Number(e.seq), kind: e.kind, points: Number(e.points), balance_after: Number(e.balance_after),
    order_id: e.order_id, reverses_id: e.reverses_id, note: e.note, created_at: iso(e.created_at),
  }));
  // The balance is the newest entry's own balance_after (R40 C2), read from the same rows listed.
  return { customer_id: customerId, balance: entries[0]?.balance_after ?? 0, balance_entry_id: entries[0]?.entry_id ?? null, entries };
}

export async function customerExists(c: Queryable, customerId: string): Promise<boolean> {
  return (await c.query(`SELECT 1 FROM core.customer WHERE id = $1`, [customerId])).rows.length > 0;
}

export async function listCouponUses(c: Queryable, customerId: string): Promise<Of<typeof CouponUseView>[]> {
  const r = await c.query<{ id: string; coupon_id: string; order_id: string; customer_id: string | null; discount_minor: string; currency: string; applied_by: string; at: Date }>(
    `SELECT id, coupon_id, order_id, customer_id, discount_minor::text, currency, applied_by, at
       FROM core.coupon_use WHERE customer_id = $1 ORDER BY at DESC, id DESC LIMIT 200`, [customerId]);
  return r.rows.map((x) => ({
    coupon_use_id: x.id, coupon_id: x.coupon_id, order_id: x.order_id, customer_id: x.customer_id,
    discount_minor: Number(x.discount_minor), currency: x.currency.trim(), applied_by: x.applied_by, at: iso(x.at),
  }));
}

export async function listCampaigns(c: Queryable): Promise<Of<typeof CampaignView>[]> {
  const r = await c.query<{ id: string; name: string; channel: "email" | "sms"; outlet_ids: string[]; segment_snapshot_id: string; audience_count: number;
    message_key: string; coupon_id: string | null; send_at: Date; status: Of<typeof CampaignView>["status"]; created_at: Date }>(
    `SELECT id, name, channel, outlet_ids, segment_snapshot_id, audience_count, message_key, coupon_id, send_at, status, created_at
       FROM core.campaign ORDER BY created_at DESC, id DESC LIMIT 200`);
  return r.rows.map((x) => ({
    campaign_id: x.id, name: x.name, channel: x.channel, outlet_ids: x.outlet_ids, segment_snapshot_id: x.segment_snapshot_id,
    audience_count: x.audience_count, message_key: x.message_key, coupon_id: x.coupon_id, send_at: iso(x.send_at),
    status: x.status, never_auto_sent: true as const, created_at: iso(x.created_at),
  }));
}

/** Member outlet scope as SQL: null = every outlet. */
export type Scope = string[] | null;

export async function listReservations(c: Queryable, scope: Scope, f: { outlet_id?: string | undefined; from?: string | undefined; to?: string | undefined }): Promise<Of<typeof ReservationView>[]> {
  const r = await c.query<{ id: string; outlet_id: string; customer_id: string | null; name: string; phone: string | null; party_size: number; starts_at: Date;
    duration_min: number; table_ref: string | null; status: Of<typeof ReservationView>["status"]; note: string | null; created_at: Date }>(
    `SELECT id, outlet_id, customer_id, name, phone, party_size, starts_at, duration_min, table_ref, status, note, created_at
       FROM core.reservation
      WHERE ($1::uuid[] IS NULL OR outlet_id = ANY ($1)) AND ($2::uuid IS NULL OR outlet_id = $2)
        AND ($3::timestamptz IS NULL OR starts_at >= $3) AND ($4::timestamptz IS NULL OR starts_at < $4)
      ORDER BY starts_at, id LIMIT 500`, [scope, f.outlet_id ?? null, f.from ?? null, f.to ?? null]);
  return r.rows.map((x) => ({
    reservation_id: x.id, outlet_id: x.outlet_id, customer_id: x.customer_id, name: x.name, phone: x.phone, party_size: x.party_size,
    starts_at: iso(x.starts_at), duration_min: x.duration_min, table_ref: x.table_ref, status: x.status, note: x.note, created_at: iso(x.created_at),
  }));
}

export async function listReviews(c: Queryable, scope: Scope, f: { outlet_id?: string | undefined; limit: number }): Promise<Of<typeof ReviewView>[]> {
  const r = await c.query<{ id: string; outlet_id: string; channel_id: string | null; source: string; external_ref: string; rating: number; body: string | null; reviewed_at: Date; created_at: Date }>(
    `SELECT id, outlet_id, channel_id, source, external_ref, rating, body, reviewed_at, created_at
       FROM core.review WHERE ($1::uuid[] IS NULL OR outlet_id = ANY ($1)) AND ($2::uuid IS NULL OR outlet_id = $2)
      ORDER BY reviewed_at DESC, id DESC LIMIT $3`, [scope, f.outlet_id ?? null, f.limit]);
  return r.rows.map((x) => ({
    review_id: x.id, outlet_id: x.outlet_id, channel_id: x.channel_id, source: x.source, external_ref: x.external_ref, rating: x.rating,
    body: x.body, reviewed_at: iso(x.reviewed_at), created_at: iso(x.created_at),
  }));
}

export async function listBulkOrders(c: Queryable, scope: Scope, f: { outlet_id?: string | undefined }): Promise<Of<typeof BulkOrderView>[]> {
  const r = await c.query<{ id: string; outlet_id: string; customer_id: string | null; contact_name: string; contact_phone: string | null; deliver_at: Date;
    headcount: number | null; status: Of<typeof BulkOrderView>["status"]; quote_minor: string | null; advance_minor: string | null; currency: string | null;
    order_id: string | null; note: string | null; created_at: Date }>(
    `SELECT id, outlet_id, customer_id, contact_name, contact_phone, deliver_at, headcount, status, quote_minor::text, advance_minor::text, currency,
            order_id, note, created_at
       FROM core.bulk_order WHERE ($1::uuid[] IS NULL OR outlet_id = ANY ($1)) AND ($2::uuid IS NULL OR outlet_id = $2)
      ORDER BY deliver_at DESC, id DESC LIMIT 200`, [scope, f.outlet_id ?? null]);
  return r.rows.map((x) => ({
    bulk_order_id: x.id, outlet_id: x.outlet_id, customer_id: x.customer_id, contact_name: x.contact_name, contact_phone: x.contact_phone,
    deliver_at: iso(x.deliver_at), headcount: x.headcount, status: x.status, quote_minor: int(x.quote_minor), advance_minor: int(x.advance_minor),
    currency: x.currency?.trim() ?? null, order_id: x.order_id, note: x.note, created_at: iso(x.created_at),
  }));
}

/** One merchant-side customer record (T-092b), shaped and masked like a `listCustomers` row; null when not visible. */
export async function getCustomer(c: Queryable, id: string, full: boolean): Promise<Of<typeof CustomerView> | null> {
  const r = await c.query<{ id: string; name: string | null; phone: string | null; email: string | null; consent: Record<string, unknown>; has_account: boolean; erased: boolean; created_at: Date }>(
    `SELECT id, name, phone, email, consent, idp_sub IS NOT NULL AS has_account, erased_at IS NOT NULL AS erased, created_at FROM core.customer WHERE id = $1`, [id]);
  const x = r.rows[0];
  if (!x) return null;
  return {
    customer_id: x.id, name: x.name, phone: full ? x.phone : maskPhone(x.phone), email: full ? x.email : null,
    consent: consentFlags(x.consent), has_account: x.has_account, erased: x.erased, created_at: iso(x.created_at),
  };
}
