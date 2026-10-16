// Command handlers of the customers module. Each is bound to one seeded command type and writes only that
// command's target_tables (db/migrations 0007, 0011). A handler runs inside executeCommand's transaction, which has
// already set app.command_type; it never sets it. Payloads are parsed again here (defence in depth).
//   customers.customer.upsert.v1   → core.customer          (a person's own command; consent can only be withdrawn)
//   customers.loyalty.adjust.v1    → core.loyalty_entry     (owner/manager/judge, tenant scope)
//   customers.campaign.create.v1   → core.campaign          (ONLY via an approved draft — the database refuses a direct write)
//   customers.campaign.cancel.v1   → core.campaign          (status queued → cancelled; the only other status move is
//                                                          campaign-sent.ts, a demo business's simulated record, R67)
//   customers.reservation.upsert.v1 / review.record.v1 / bulk_order.upsert.v1
import {
  CustomersBulkOrderUpsertV1, CustomersCampaignCancelV1, CustomersCampaignCreateV1, CustomersCustomerUpsertV1,
  CustomersLoyaltyAdjustV1, CustomersReservationUpsertV1, CustomersReviewRecordV1,
} from "@munim/contracts/customers";
import { uuidv7, type CommandHandler, type HandlerOutput } from "../../commit/index.ts";
import { ApiError } from "../../lib/errors.ts";

interface Schema {
  _output: unknown;
  safeParse(x: unknown): { success: boolean; data?: unknown };
}
function parse<S extends Schema>(schema: S, payload: unknown): S["_output"] {
  const r = schema.safeParse(payload);
  if (!r.success) throw new ApiError("invalid_payload");
  return r.data as S["_output"];
}

const TENANT = `current_setting('app.tenant_id')::uuid`;
const ME = `nullif(current_setting('app.member_id', true), '')::uuid`;

export const customerUpsert: CommandHandler = {
  type: "customers.customer.upsert.v1",
  async run(c, command): Promise<HandlerOutput> {
    const p = parse(CustomersCustomerUpsertV1, command.payload);
    const withdrawn = Object.fromEntries(p.withdraw_consent.map((ch) => [ch, false]));
    const cur = await c.query<{ consent: Record<string, boolean>; erased: boolean; has_account: boolean; name: string | null; phone: string | null; email: string | null }>(
      `SELECT consent, erased_at IS NOT NULL AS erased, idp_sub IS NOT NULL AS has_account, name, phone, email FROM core.customer WHERE id = $1 FOR UPDATE`, [p.customer_id]);
    let consent: Record<string, boolean>;
    const row = cur.rows[0];
    if (row) {
      if (row.erased) throw new ApiError("customer_erased");
      // Staff see a masked phone and no email (reads.ts), so they cannot send either back: a staff save keeps the stored
      // email, and a null phone means "unchanged" (a typed number replaces it). A signed-in customer's name and phone are
      // their own: staff cannot change them (R1-m3) — only withdraw consent.
      const staff = (await c.query<{ r: string | null }>(`SELECT nullif(current_setting('app.role', true), '') AS r`)).rows[0]!.r === "staff";
      const phone = staff && p.phone === null ? row.phone : p.phone;
      const email = staff ? row.email : p.email;
      if (staff && row.has_account && (p.name !== row.name || phone !== row.phone)) throw new ApiError("forbidden", "authority_denied");
      // Only ever false: a member can withdraw a customer's consent, never grant it.
      consent = { ...row.consent, ...withdrawn };
      await c.query(`UPDATE core.customer SET name = $2, phone = $3, email = $4, consent = $5 WHERE id = $1`,
        [p.customer_id, p.name, phone, email, consent]);
    } else {
      consent = withdrawn;
      // A customer record entered by the merchant: known to the business, no account of its own (idp_sub null).
      await c.query(
        `INSERT INTO core.customer (tenant_id, id, name, phone, email, consent, is_guest, created_by, origin)
         VALUES (${TENANT}, $1, $2, $3, $4, $5, false, ${ME}, '{}')`,
        [p.customer_id, p.name, p.phone, p.email, consent]);
    }
    // Audit carries ids and consent flags only — no name, phone or email.
    return { entityId: p.customer_id, audit: [{ entity: "core.customer", entityId: p.customer_id, after: { customer_id: p.customer_id, consent } }] };
  },
};

export const loyaltyAdjust: CommandHandler = {
  type: "customers.loyalty.adjust.v1",
  async run(c, command): Promise<HandlerOutput> {
    const p = parse(CustomersLoyaltyAdjustV1, command.payload);
    const cust = await c.query<{ erased: boolean }>(`SELECT erased_at IS NOT NULL AS erased FROM core.customer WHERE id = $1 FOR UPDATE`, [p.customer_id]);
    if (!cust.rows[0]) throw new ApiError("not_found");
    if (cust.rows[0].erased) throw new ApiError("customer_erased");
    const id = uuidv7();
    // seq / balance_after are set by the ledger trigger under the customer's row lock; < 0 → MB011.
    await c.query(
      `INSERT INTO core.loyalty_entry (tenant_id, id, customer_id, seq, kind, points, balance_after, note, created_by, origin)
       VALUES (${TENANT}, $1, $2, 0, 'adjust', $3, 0, $4, ${ME}, '{}')`, [id, p.customer_id, p.points, p.note]);
    return { entityId: id, audit: [{ entity: "core.loyalty_entry", entityId: id, after: { entry_id: id, customer_id: p.customer_id, kind: "adjust", points: p.points } }] };
  },
};

/** Registered as the DRAFT handler only: approvals runs it with app.decision_id set, which is the one path the
 *  database admits (core.campaign_from_decision). It stores a queued campaign and does nothing else — it contains no
 *  send, no channel call, no schedule. */
export const campaignCreate: CommandHandler = {
  type: "customers.campaign.create.v1",
  async run(c, command): Promise<HandlerOutput> {
    const p = parse(CustomersCampaignCreateV1, command.payload);
    // The audience is the consented customers of the cited segment; none → nothing is prepared (pack §7).
    if (p.audience_count === 0) throw new ApiError("invalid_payload", "no_marketing_consent");
    const keys = p.placeholders.map((x) => x.key);
    if (new Set(keys).size !== keys.length) throw new ApiError("invalid_payload");
    await c.query(
      `INSERT INTO core.campaign (tenant_id, id, name, channel, outlet_ids, segment_snapshot_id, audience_count, message_key, placeholders,
                                  coupon_id, send_at, window_from, window_to, created_by, origin)
       VALUES (${TENANT}, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, ${ME}, '{}')`,
      [p.campaign_id, p.name, p.channel, p.outlet_ids, p.segment_snapshot_id, p.audience_count, p.message_key,
       Object.fromEntries(p.placeholders.map((x) => [x.key, x.value])), p.coupon_id, p.send_at, p.window_from, p.window_to]);
    return { entityId: p.campaign_id, audit: [{ entity: "core.campaign", entityId: p.campaign_id, after: { campaign_id: p.campaign_id, status: "queued", channel: p.channel } }] };
  },
};

export const campaignCancel: CommandHandler = {
  type: "customers.campaign.cancel.v1",
  async run(c, command): Promise<HandlerOutput> {
    const p = parse(CustomersCampaignCancelV1, command.payload);
    const r = await c.query(`UPDATE core.campaign SET status = 'cancelled' WHERE id = $1 AND status = 'queued'`, [p.campaign_id]);
    if (r.rowCount === 0) {
      const exists = await c.query(`SELECT 1 FROM core.campaign WHERE id = $1`, [p.campaign_id]);
      throw new ApiError(exists.rows[0] ? "illegal_transition" : "not_found");
    }
    return { entityId: p.campaign_id, audit: [{ entity: "core.campaign", entityId: p.campaign_id, before: { status: "queued" }, after: { status: "cancelled" } }] };
  },
};

export const reservationUpsert: CommandHandler = {
  type: "customers.reservation.upsert.v1",
  async run(c, command): Promise<HandlerOutput> {
    const p = parse(CustomersReservationUpsertV1, command.payload);
    const cur = await c.query<{ outlet_id: string }>(`SELECT outlet_id FROM core.reservation WHERE id = $1 FOR UPDATE`, [p.reservation_id]);
    if (cur.rows[0]) {
      if (cur.rows[0].outlet_id !== p.outlet_id) throw new ApiError("invalid_payload"); // a booking does not move outlet
      await c.query(
        `UPDATE core.reservation SET customer_id = $2, name = $3, phone = $4, party_size = $5, starts_at = $6, duration_min = $7,
                table_ref = $8, status = $9, note = $10 WHERE id = $1`,
        [p.reservation_id, p.customer_id, p.name, p.phone, p.party_size, p.starts_at, p.duration_min, p.table_ref, p.status, p.note]);
    } else {
      if (p.status !== "booked") throw new ApiError("invalid_payload");
      await c.query(
        `INSERT INTO core.reservation (tenant_id, id, outlet_id, customer_id, name, phone, party_size, starts_at, duration_min, table_ref, status, note, created_by, origin)
         VALUES (${TENANT}, $1, $2, $3, $4, $5, $6, $7, $8, $9, 'booked', $10, ${ME}, '{}')`,
        [p.reservation_id, p.outlet_id, p.customer_id, p.name, p.phone, p.party_size, p.starts_at, p.duration_min, p.table_ref, p.note]);
    }
    return { entityId: p.reservation_id, audit: [{ entity: "core.reservation", entityId: p.reservation_id, after: { reservation_id: p.reservation_id, status: p.status } }] };
  },
};

export const reviewRecord: CommandHandler = {
  type: "customers.review.record.v1",
  async run(c, command): Promise<HandlerOutput> {
    const p = parse(CustomersReviewRecordV1, command.payload);
    await c.query(
      `INSERT INTO core.review (tenant_id, id, outlet_id, channel_id, source, external_ref, rating, body, reviewed_at, created_by, origin)
       VALUES (${TENANT}, $1, $2, $3, $4, $5, $6, $7, $8, ${ME}, '{}')`,
      [p.review_id, p.outlet_id, p.channel_id, p.source, p.external_ref, p.rating, p.body, p.reviewed_at]);
    // The review text is untrusted and stays out of the audit entry.
    return { entityId: p.review_id, audit: [{ entity: "core.review", entityId: p.review_id, after: { review_id: p.review_id, source: p.source, rating: p.rating } }] };
  },
};

export const bulkOrderUpsert: CommandHandler = {
  type: "customers.bulk_order.upsert.v1",
  async run(c, command): Promise<HandlerOutput> {
    const p = parse(CustomersBulkOrderUpsertV1, command.payload);
    const cur = await c.query<{ outlet_id: string }>(`SELECT outlet_id FROM core.bulk_order WHERE id = $1 FOR UPDATE`, [p.bulk_order_id]);
    if (cur.rows[0]) {
      if (cur.rows[0].outlet_id !== p.outlet_id) throw new ApiError("invalid_payload");
      await c.query(
        `UPDATE core.bulk_order SET customer_id = $2, contact_name = $3, contact_phone = $4, deliver_at = $5, headcount = $6, status = $7,
                quote_minor = $8, advance_minor = $9, currency = $10, order_id = $11, note = $12 WHERE id = $1`,
        [p.bulk_order_id, p.customer_id, p.contact_name, p.contact_phone, p.deliver_at, p.headcount, p.status, p.quote_minor, p.advance_minor, p.currency, p.order_id, p.note]);
    } else {
      if (p.status !== "enquiry" && p.status !== "quoted") throw new ApiError("invalid_payload");
      await c.query(
        `INSERT INTO core.bulk_order (tenant_id, id, outlet_id, customer_id, contact_name, contact_phone, deliver_at, headcount, status,
                quote_minor, advance_minor, currency, order_id, note, created_by, origin)
         VALUES (${TENANT}, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, ${ME}, '{}')`,
        [p.bulk_order_id, p.outlet_id, p.customer_id, p.contact_name, p.contact_phone, p.deliver_at, p.headcount, p.status, p.quote_minor, p.advance_minor, p.currency, p.order_id, p.note]);
    }
    return { entityId: p.bulk_order_id, audit: [{ entity: "core.bulk_order", entityId: p.bulk_order_id, after: { bulk_order_id: p.bulk_order_id, status: p.status } }] };
  },
};

