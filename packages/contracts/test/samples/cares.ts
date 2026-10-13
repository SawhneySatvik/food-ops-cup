import { S1, T, T_PG, T_Z, snapRef, u } from "./_ids.ts";

const publishLine = { line_id: u(1301), food_kind: "packaged", item_id: null, ingredient_id: u(40), batch_id: u(41), qty_milli: 40000, unit: "unit", expires_on: "2026-10-15", unit_price_minor: null, currency: null };
const publish = { listing_id: u(1300), outlet_id: u(2), kind: "donation", recipient_id: u(1310), pickup_from: T, pickup_to: T_Z, lines: [publishLine] };
const listingLine = { line_id: u(1301), line_no: 1, food_kind: "packaged", item_id: null, ingredient_id: u(40), batch_id: u(41), qty_milli: 40000, unit: "unit", expires_on: "2026-10-15", unit_price_minor: null, currency: null };
const listing = {
  listing_id: u(1300), outlet_id: u(2), kind: "donation", status: "published", recipient_id: u(1310), pickup_from: T, pickup_to: T_Z, pickup_on: "2026-10-12", published_by: u(8), published_at: T_PG,
  lines: [listingLine],
  handovers: [{ handover_id: u(1320), allocation_id: null, status: "recorded", handed_at: T, recorded_by: u(8), voided_by: null, void_reason_code: null, lines: [{ listing_line_id: u(1301), qty_milli: 40000 }] }],
};
const netListing = {
  listing_id: u(1300), city_code: "pune", business_name: "Demo Kitchen", outlet_name: "Koregaon Park", pickup_from: T, pickup_to: T_Z, tz: "Asia/Kolkata", recipient_name: "Anna Daan (simulated)", recipient_simulated: true,
  lines: [{ line_no: 1, food_kind: "packaged", label_key: null, label: "Yoghurt cup", qty_milli: 40000, unit: "unit", expires_on: "2026-10-15" }],
};
const fact = (col: string, value: number | boolean) => ({ value, ref: snapRef(S1, 0, col) });
const impactRow = (city: string | null) => ({
  city_code: city, businesses: fact("businesses", 4), donations: fact("donations", 4), meals_portions_milli: fact("meals_portions_milli", 24000), weight_g: fact("weight_g", 8000), volume_ml: fact("volume_ml", 0), all_synthetic: fact("all_synthetic", true),
});
const snapBase = {
  snapshot_id: S1, template_id: "platform.cares_network_impact", template_version: 1, params: { from: "2026-10-01", to: "2026-10-12", city_code: null },
  columns: [{ name: "businesses", type: "integer", numeric_source: "count:core.cares_profile" }],
  rows: [{ businesses: 4 }], row_count: 1, sha256: "a".repeat(64), created_at: T_PG,
};
const ml = { labels: { data: "Measured on synthetic data", recipients: "to simulated recipients" }, note_key: "cares.note.check_local_rules" };
const money = { money_label: "Recorded, never processed" };
const claimLine = { offer_line_id: u(1330), ingredient_id: u(42), qty_milli: 20000000, unit: "g", unit_price_minor: 4000, expires_on: "2026-10-16", received_qty_milli: null };

export const SAMPLES: Record<string, unknown> = {
  "cares.profile.set.v1": { status: "active", public_name: "Demo Kitchen", b2b_enabled: true, outlets: [{ outlet_id: u(2), city_code: "pune", lat_e6: 18_536_000, lng_e6: 73_893_000, pickup_from: "15:00", pickup_to: "18:00", active: true }] },
  "cares.listing.publish.v1": publish,
  "cares.listing.withdraw.v1": { listing_id: u(1300) },
  "cares.handover.record.v1": { handover_id: u(1320), listing_id: u(1300), allocation_id: null, lines: [{ listing_line_id: u(1301), qty_milli: 40000 }] },
  "cares.handover.void.v1": { handover_id: u(1320), reason_code: "wrong_recipient" },
  "cares.claim.create.v1": { claim_id: u(1340), outlet_id: u(2), offer_tenant_id: u(1), offer_listing_id: u(1300), lines: [{ offer_line_id: u(1330), ingredient_id: u(42) }] },
  "cares.claim.cancel.v1": { claim_id: u(1340) },
  "cares.claim.close.v1": { claim_id: u(1340) },
  "cares.claim.decide.v1": { allocation_id: u(1350), listing_id: u(1300), claim_tenant_id: u(1), claim_id: u(1340), verdict: "accepted" },
  "cares.claim.receive.v1": { claim_id: u(1340) },
  "proposal.cares.listing.publish.v1": { ...publish, lines: [{ ...publishLine, qty_milli: snapRef(S1, 0, "at_risk_qty_milli") }] },
  "cares.network-snapshot-mint": { template_id: "platform.cares_network_impact", params: { from: "2026-10-01", to: "2026-10-12", city_code: null } },
  "v1.cares.profile": { available: true, enabled: true, profile: { status: "active", public_name: "Demo Kitchen", b2b_enabled: true }, outlets: [{ outlet_id: u(2), city_code: "pune", lat_e6: 18_536_000, lng_e6: 73_893_000, pickup_from: "15:00", pickup_to: "18:00", active: true }], ...ml },
  "v1.cares.recipients": { items: [{ recipient_id: u(1310), city_code: "pune", name: "Anna Daan (simulated)", kind: "ngo", simulated: true, accepts_cooked: false, accepts_raw: false, accepts_packaged: true, capacity_kg_per_day: 50, capacity_portions_per_day: 0, receiving_from: "10:00", receiving_to: "19:00", lat_e6: 18_520_000, lng_e6: 73_856_000 }], ...ml },
  "v1.cares.listings": { items: [listing], next_cursor: null, ...ml },
  "v1.cares.listing": { ...listing, ...ml },
  "v1.cares.market": { items: [{ offer_tenant_id: u(1), listing_id: u(1300), business_name: "Demo Kitchen", outlet_name: "Koregaon Park", city_code: "pune", pickup_from: T, pickup_to: T_Z, pickup_on: "2026-10-15", lines: [{ offer_line_id: u(1330), food_kind: "raw", label: "Onion", qty_milli: 20000000, unit: "g", expires_on: "2026-10-16", unit_price_minor: 4000, currency: "INR" }] }], ...ml, ...money },
  "v1.cares.claims": {
    items: [{ claim_id: u(1340), outlet_id: u(2), offer_tenant_id: u(1), offer_listing_id: u(1300), allocation_id: null, status: "requested", total_minor: 80000, currency: "INR", created_by: u(8), created_at: T_PG, lines: [claimLine], outcome: { verdict: "none", allocation_id: null, decided_at: null, lines: [] } }],
    ...ml, ...money,
  },
  "v1.cares.inbound-claims": { items: [{ claim_tenant_id: u(1), claim_id: u(1340), buyer_public_name: "Demo Kitchen", status: "requested", created_at: T_PG, lines: [{ offer_line_id: u(1330), qty_milli: 20000000, unit_price_minor: 4000 }] }], ...ml, ...money },
  "v1.cares-network.cities": { items: [{ code: "pune", country_code: "IN", name: "Pune" }] },
  "v1.cares-network.listings": { items: [netListing], next_cursor: u(1300) },
  "v1.cares-network.listing": netListing,
  "v1.cares-network.impact": { snapshot_id: S1, as_of: T_PG, template_id: "platform.cares_network_impact", template_version: 1, rows: [impactRow(null), impactRow("pune")], ...ml },
  "v1.cares-network.snapshot": { ...snapBase, published_at: T_PG, ...ml },
  "v1.storefront.cares": { items: [netListing] },
  "platform.cares-network-snapshot": { ...snapBase, minted_by_operator_id: u(7), published_at: null, publish_draft_id: null },
  "platform.cares-network-snapshots": { items: [{ ...snapBase, minted_by_operator_id: u(7), published_at: T_PG, publish_draft_id: u(1360) }] },
  "munim.cares.listing.published.v1": { ...eventBase("listing.published"), data: { listing_id: u(1300), outlet_id: u(2), kind: "donation" } },
  "munim.cares.listing.closed.v1": { ...eventBase("listing.closed"), data: { listing_id: u(1300), outlet_id: u(2), kind: "donation", status: "withdrawn" } },
  "munim.cares.handover.recorded.v1": { ...eventBase("handover.recorded", u(1320)), data: { handover_id: u(1320), listing_id: u(1300), outlet_id: u(2), kind: "donation" } },
  "munim.cares.handover.voided.v1": { ...eventBase("handover.voided", u(1320)), data: { handover_id: u(1320), listing_id: u(1300), outlet_id: u(2), kind: "offer" } },
  "munim.cares.claim.created.v1": { ...eventBase("claim.created", u(1340)), data: { claim_id: u(1340), outlet_id: u(2) } },
  "munim.cares.claim.decided.v1": { ...eventBase("claim.decided", u(1340)), data: { claim_id: u(1340), listing_id: u(1300), outlet_id: u(2), verdict: "declined" } },
};

function eventBase(kind: string, subject = u(1300)) {
  return { specversion: "1.0", id: u(1370), source: `/tenants/${u(1)}/cares`, type: `munim.cares.${kind}.v1`, subject, time: T, datacontenttype: "application/json", tenantid: u(1), munimrun: "eyJhbGciOiJFZERTQSJ9.eyJydW5faWQiOiJ4In0.c2lnbmF0dXJl" };
}
