// Munim Cares member reads (ADR-015 §1.2, §1.5). Rows under the member's own RLS context, or the three id-keyed definer
// reads for the other side of a B2B offer (0028: each re-checks the member and returns 0 rows without one). No aggregate
// is computed here (R26): impact is the `cares.impact` snapshot. Every response carries the hard-rule-5 labels
// unconditionally (DECISIONS 12 Oct) and the one generic note key; B2B money carries "Recorded, never processed".
import { ApiError } from "../../lib/errors.ts";
import type { Queryable } from "../../runtoken/index.ts";
import { tenantPack } from "../inventory/index.ts";

export const LABELS = {
  labels: { data: "Measured on synthetic data", recipients: "to simulated recipients" },
  note_key: "cares.note.check_local_rules",
} as const;
export const MONEY = { money_label: "Recorded, never processed" } as const;

const T = `current_setting('app.tenant_id')::uuid`;
const num = (v: string | number | null) => (v === null ? null : Number(v));

export async function profile(c: Queryable) {
  const available = (await tenantPack(c)).cares !== undefined;
  const en = (await c.query<{ enabled: boolean }>(`SELECT enabled FROM platform.cares_enablement WHERE tenant_id = ${T}`)).rows[0];
  const pr = (await c.query<{ status: "active" | "paused"; public_name: string; b2b_enabled: boolean }>(`SELECT status, public_name, b2b_enabled FROM core.cares_profile`)).rows[0];
  const outlets = (await c.query(
    `SELECT outlet_id, city_code, lat_e6, lng_e6, to_char(pickup_from, 'HH24:MI') AS pickup_from, to_char(pickup_to, 'HH24:MI') AS pickup_to, active
       FROM core.cares_outlet ORDER BY outlet_id`)).rows;
  return { available, enabled: en?.enabled === true, profile: pr ?? null, outlets, ...LABELS };
}

/** Active simulated recipients in the outlet's Cares city (none until the outlet is opted in). */
export async function recipients(c: Queryable, outletId: string) {
  const r = await c.query<Record<string, any>>(
    `SELECT r.id AS recipient_id, r.city_code, r.name, r.kind, r.simulated, r.accepts_cooked, r.accepts_raw, r.accepts_packaged, r.capacity_kg_per_day,
            r.capacity_portions_per_day, to_char(r.receiving_from, 'HH24:MI') AS receiving_from, to_char(r.receiving_to, 'HH24:MI') AS receiving_to, r.lat_e6, r.lng_e6
       FROM core.cares_outlet co JOIN platform.cares_recipient r ON r.city_code = co.city_code AND r.status = 'active' AND r.simulated
      WHERE co.outlet_id = $1 ORDER BY r.name, r.id`, [outletId]);
  return { items: r.rows, ...LABELS };
}

const LISTING = `SELECT id, outlet_id, kind, status, recipient_id, pickup_from, pickup_to, pickup_on::text AS pickup_on, published_by, published_at FROM core.cares_listing`;

/** Lines and hand-overs (with their lines) of the given listings, as the contract's CaresListingView. */
async function views(c: Queryable, rows: Array<Record<string, any>>) {
  const ids = rows.map((r) => r.id);
  const lines = (await c.query<Record<string, any>>(
    `SELECT id, listing_id, line_no, food_kind, item_id, ingredient_id, batch_id, qty_milli::text AS qty_milli, unit, expires_on::text AS expires_on,
            unit_price_minor::text AS unit_price_minor, currency FROM core.cares_listing_line WHERE listing_id = ANY ($1::uuid[]) ORDER BY line_no`, [ids])).rows;
  const hos = (await c.query<Record<string, any>>(
    `SELECT id, listing_id, allocation_id, status, handed_at, recorded_by, voided_by, void_reason_code FROM core.cares_handover
      WHERE listing_id = ANY ($1::uuid[]) ORDER BY id`, [ids])).rows;
  const hoLines = (await c.query<Record<string, any>>(
    `SELECT handover_id, listing_line_id, qty_milli::text AS qty_milli FROM core.cares_handover_line WHERE handover_id = ANY ($1::uuid[]) ORDER BY id`,
    [hos.map((h) => h.id)])).rows;
  return rows.map((r) => ({
    listing_id: r.id, outlet_id: r.outlet_id, kind: r.kind, status: r.status, recipient_id: r.recipient_id, pickup_from: r.pickup_from.toISOString(),
    pickup_to: r.pickup_to.toISOString(), pickup_on: r.pickup_on, published_by: r.published_by, published_at: r.published_at.toISOString(),
    lines: lines.filter((l) => l.listing_id === r.id).map((l) => ({
      line_id: l.id, line_no: l.line_no, food_kind: l.food_kind, item_id: l.item_id, ingredient_id: l.ingredient_id, batch_id: l.batch_id,
      qty_milli: Number(l.qty_milli), unit: l.unit, expires_on: l.expires_on, unit_price_minor: num(l.unit_price_minor), currency: l.currency,
    })),
    handovers: hos.filter((h) => h.listing_id === r.id).map((h) => ({
      handover_id: h.id, allocation_id: h.allocation_id, status: h.status, handed_at: h.handed_at.toISOString(), recorded_by: h.recorded_by,
      voided_by: h.voided_by, void_reason_code: h.void_reason_code,
      lines: hoLines.filter((x) => x.handover_id === h.id).map((x) => ({ listing_line_id: x.listing_line_id, qty_milli: Number(x.qty_milli) })),
    })),
  }));
}

export async function listings(c: Queryable, q: { outlet: string | null; kind: string | null; status: string | null; cursor: string | null; limit: number }) {
  const rows = (await c.query<Record<string, any>>(
    `${LISTING} WHERE ($1::uuid IS NULL OR outlet_id = $1) AND ($2::text IS NULL OR kind = $2) AND ($3::text IS NULL OR status = $3) AND ($4::uuid IS NULL OR id < $4)
      ORDER BY id DESC LIMIT $5`, [q.outlet, q.kind, q.status, q.cursor, q.limit + 1])).rows;
  const shown = rows.slice(0, q.limit);
  return { items: await views(c, shown), next_cursor: rows.length > q.limit ? shown.at(-1)!.id as string : null, ...LABELS };
}

export async function listing(c: Queryable, id: string) {
  const r = (await c.query<Record<string, any>>(`${LISTING} WHERE id = $1`, [id])).rows[0];
  if (!r) throw new ApiError("not_found");
  return { ...(await views(c, [r]))[0]!, ...LABELS };
}

/** Other businesses' live offers in the caller's Cares cities (core.cares_market_offers; empty without B2B on). */
export async function market(c: Queryable, listingId: string | null) {
  const r = await c.query<Record<string, any>>(
    `SELECT offer_tenant_id, listing_id, business_name, outlet_name, city_code, pickup_from, pickup_to, pickup_on::text AS pickup_on, lines
       FROM core.cares_market_offers($1)`, [listingId]);
  return { items: r.rows.map((o) => ({ ...o, pickup_from: o.pickup_from.toISOString(), pickup_to: o.pickup_to.toISOString(), lines: o.lines ?? [] })), ...LABELS, ...MONEY };
}

/** The buyer's own claims, newest first, each with the offerer's outcome (core.cares_claim_outcome). */
export async function claims(c: Queryable, outlet: string | null) {
  const rows = (await c.query<Record<string, any>>(
    `SELECT id, outlet_id, offer_tenant_id, offer_listing_id, allocation_id, status, total_minor::text AS total_minor, currency, created_by, created_at
       FROM core.cares_claim WHERE ($1::uuid IS NULL OR outlet_id = $1) ORDER BY id DESC LIMIT 200`, [outlet])).rows;
  const lines = (await c.query<Record<string, any>>(
    `SELECT claim_id, offer_line_id, ingredient_id, qty_milli::text AS qty_milli, unit, unit_price_minor::text AS unit_price_minor, expires_on::text AS expires_on,
            received_qty_milli::text AS received_qty_milli FROM core.cares_claim_line WHERE claim_id = ANY ($1::uuid[]) ORDER BY offer_line_id`, [rows.map((r) => r.id)])).rows;
  const items = [];
  for (const r of rows) {
    const o = (await c.query<{ verdict: string; allocation_id: string | null; decided_at: Date | null; lines: unknown[] }>(
      `SELECT verdict, allocation_id, decided_at, lines FROM core.cares_claim_outcome($1)`, [r.id])).rows[0];
    items.push({
      claim_id: r.id, outlet_id: r.outlet_id, offer_tenant_id: r.offer_tenant_id, offer_listing_id: r.offer_listing_id, allocation_id: r.allocation_id, status: r.status,
      total_minor: Number(r.total_minor), currency: r.currency, created_by: r.created_by, created_at: r.created_at.toISOString(),
      lines: lines.filter((l) => l.claim_id === r.id).map((l) => ({
        offer_line_id: l.offer_line_id, ingredient_id: l.ingredient_id, qty_milli: Number(l.qty_milli), unit: l.unit, unit_price_minor: Number(l.unit_price_minor),
        expires_on: l.expires_on, received_qty_milli: num(l.received_qty_milli),
      })),
      outcome: o ? { verdict: o.verdict, allocation_id: o.allocation_id, decided_at: o.decided_at?.toISOString() ?? null, lines: o.lines }
        : { verdict: "none", allocation_id: null, decided_at: null, lines: [] },
    });
  }
  return { items, ...LABELS, ...MONEY };
}

/** Claims on the caller's own offer (core.cares_inbound_claims); the listing must be one the caller can see. */
export async function inboundClaims(c: Queryable, listingId: string) {
  if (!(await c.query(`SELECT 1 FROM core.cares_listing WHERE id = $1`, [listingId])).rows[0]) throw new ApiError("not_found");
  const r = await c.query<Record<string, any>>(
    `SELECT claim_tenant_id, claim_id, buyer_public_name, status, created_at, lines FROM core.cares_inbound_claims($1)`, [listingId]);
  return { items: r.rows.map((x) => ({ ...x, created_at: x.created_at.toISOString(), lines: x.lines ?? [] })), ...LABELS, ...MONEY };
}
