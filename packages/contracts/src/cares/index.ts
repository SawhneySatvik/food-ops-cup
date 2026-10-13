// Munim Cares (ADR-015): surplus listings to simulated recipients, hand-overs that move stock, B2B shared surplus
// offers, the public network page and the operator-published network total. Every listing is a book row; every
// publish, hand-over and claim step is a person's own command or an approved draft (R15, R16). Recipients are
// simulated (a DB CHECK). Quantities and prices are row fields (R26); the network impact total is a snapshot cell.
// Money on a claim is "Recorded, never processed" — nothing here posts to a ledger.
import { z } from "zod";
import { defineDraftable } from "../shared/draftables.ts";
import { CurrencyCode, IanaZone, IsoDate, IsoDateTime, LocalTime, MinorAmount, NonEmpty, QtyMilli, Slug, Unit, Uuid7 } from "../shared/primitives.ts";
import { Ref } from "../shared/refs.ts";
import type { QueryParam, Route } from "../shared/routes.ts";
import { Cell, SnapshotColumn, TemplateParams } from "../shared/snapshot.ts";

export const CityCode = z.string().regex(/^[a-z][a-z0-9_]*$/).max(40);
/** = core.cares_handover.void_reason_code CHECK (no dots, unlike Slug). */
const ReasonCode = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
export const FoodKind = z.enum(["cooked", "raw", "packaged"]);
export const ListingKind = z.enum(["donation", "offer"]);
export const ListingStatus = z.enum(["published", "allocated", "closed", "withdrawn"]);
export const ClaimStatus = z.enum(["requested", "cancelled", "closed", "received"]);
const LatE6 = z.int().min(-90_000_000).max(90_000_000);
const LngE6 = z.int().min(-180_000_000).max(180_000_000);

// ---- Commands (ADR §1.3). Names equal the command_authority rows of 0028.
export const CaresProfileSetV1 = z.strictObject({
  status: z.enum(["active", "paused"]),
  /** Shown on the public network page and to B2B counterparties; the business's own chosen name. */
  public_name: NonEmpty.max(120),
  b2b_enabled: z.boolean(),
  /** Every outlet that takes part. Each city's country must equal the tenant's (R30, `cares_city_mismatch`). */
  outlets: z
    .array(
      z.strictObject({
        outlet_id: Uuid7,
        city_code: CityCode,
        lat_e6: LatE6,
        lng_e6: LngE6,
        pickup_from: LocalTime,
        pickup_to: LocalTime,
        active: z.boolean(),
      }),
    )
    .max(50),
});

/** Own command (owner/judge) or an approved intel draft. Cooked lines (`item_id`) only through the own command.
 *  A donation names a recipient and has unpriced lines; an offer has no recipient, no cooked lines and priced lines. */
export const CaresListingPublishV1 = z.strictObject({
  listing_id: Uuid7,
  outlet_id: Uuid7,
  kind: ListingKind,
  recipient_id: Uuid7.nullable(),
  pickup_from: IsoDateTime,
  pickup_to: IsoDateTime,
  lines: z
    .array(
      z.strictObject({
        line_id: Uuid7,
        food_kind: FoodKind,
        /** Exactly one of item_id (cooked) and ingredient_id (raw, packaged). */
        item_id: Uuid7.nullable(),
        ingredient_id: Uuid7.nullable(),
        batch_id: Uuid7.nullable(),
        qty_milli: QtyMilli.positive(),
        unit: Unit,
        expires_on: IsoDate.nullable(),
        /** Offers only: typed by the owner, with the cost cell beside it. */
        unit_price_minor: MinorAmount.positive().nullable(),
        currency: CurrencyCode.nullable(),
      })
        // = cares_listing_line_cooked_portion: a DB 23514 would surface as a 500, not a typed 422. (Dropped from the
        // derived proposal shape, which copies no object checks; the command re-validates at approval.)
        .refine((l) => l.food_kind !== "cooked" || l.unit === "portion", { message: "cooked lines must be in portion", path: ["unit"] }),
    )
    .min(1)
    .max(50),
});
export const CARES_LISTING_DRAFT = defineDraftable("cares.listing.publish.v1", CaresListingPublishV1);

export const CaresListingWithdrawV1 = z.strictObject({ listing_id: Uuid7 });

export const CaresHandoverRecordV1 = z.strictObject({
  handover_id: Uuid7,
  listing_id: Uuid7,
  /** Offers: the accepted allocation. Donations: null. */
  allocation_id: Uuid7.nullable(),
  /** No handed_at: core stamps it (a client-chosen time would select the recipe version). */
  /** Σ over non-voided hand-overs per listing line may not exceed that line's qty (`qty_exceeds_listed`). An offer's
   *  hand-over is all-or-nothing: every line at exactly its accepted qty, else 409 `handover_must_be_complete`. */
  lines: z.array(z.strictObject({ listing_line_id: Uuid7, qty_milli: QtyMilli.positive() })).min(1).max(50),
});
/** A donation's hand-over only: an offer's hand-over is final in v1 (409 `offer_handover_final`). */
export const CaresHandoverVoidV1 = z.strictObject({ handover_id: Uuid7, reason_code: ReasonCode });

/** Buyer. Claims every line of the offer at the offered qty and price (all-or-nothing); core re-derives them from
 *  `core.cares_market_offers` in the same transaction. The buyer only maps each offer line to their own ingredient. */
export const CaresClaimCreateV1 = z.strictObject({
  claim_id: Uuid7,
  outlet_id: Uuid7,
  offer_tenant_id: Uuid7,
  offer_listing_id: Uuid7,
  lines: z.array(z.strictObject({ offer_line_id: Uuid7, ingredient_id: Uuid7 })).min(1).max(50),
});
export const CaresClaimCancelV1 = z.strictObject({ claim_id: Uuid7 });
export const CaresClaimCloseV1 = z.strictObject({ claim_id: Uuid7 });
export const CaresClaimDecideV1 = z.strictObject({
  allocation_id: Uuid7,
  listing_id: Uuid7,
  claim_tenant_id: Uuid7,
  claim_id: Uuid7,
  verdict: z.enum(["accepted", "declined"]),
});
export const CaresClaimReceiveV1 = z.strictObject({ claim_id: Uuid7 });

// ---- Member read models (ADR §1.2, §1.5). Every number is a row's own field.
/** Hard rule 5 (DECISIONS 12 Oct 2026): every member Cares view and every public impact response carries both labels
 *  unconditionally — `all_synthetic` does not gate them — and the one generic note key (no legal text). B2B prices also
 *  carry "Recorded, never processed". */
const CaresLabels = {
  labels: z.strictObject({ data: z.literal("Measured on synthetic data"), recipients: z.literal("to simulated recipients") }),
  note_key: z.literal("cares.note.check_local_rules"),
};
const MoneyLabel = { money_label: z.literal("Recorded, never processed") };
const ListingLine = z.strictObject({
  line_id: Uuid7,
  line_no: z.int().min(1),
  food_kind: FoodKind,
  item_id: Uuid7.nullable(),
  ingredient_id: Uuid7.nullable(),
  batch_id: Uuid7.nullable(),
  qty_milli: QtyMilli,
  unit: Unit,
  expires_on: IsoDate.nullable(),
  unit_price_minor: MinorAmount.nullable(),
  currency: CurrencyCode.nullable(),
});
const HandoverView = z.strictObject({
  handover_id: Uuid7,
  allocation_id: Uuid7.nullable(),
  status: z.enum(["recorded", "voided"]),
  handed_at: IsoDateTime,
  recorded_by: Uuid7,
  voided_by: Uuid7.nullable(),
  void_reason_code: ReasonCode.nullable(),
  lines: z.array(z.strictObject({ listing_line_id: Uuid7, qty_milli: QtyMilli })),
});
export const CaresListingView = z.strictObject({
  listing_id: Uuid7,
  outlet_id: Uuid7,
  kind: ListingKind,
  status: ListingStatus,
  recipient_id: Uuid7.nullable(),
  pickup_from: IsoDateTime,
  pickup_to: IsoDateTime,
  pickup_on: IsoDate,
  published_by: Uuid7,
  published_at: IsoDateTime,
  lines: z.array(ListingLine),
  handovers: z.array(HandoverView),
});
export const CaresListingsResponse = z.strictObject({ items: z.array(CaresListingView), next_cursor: Uuid7.nullable(), ...CaresLabels });
export const CaresListingResponse = z.strictObject({ ...CaresListingView.shape, ...CaresLabels });

export const CaresProfileResponse = z.strictObject({
  /** The country pack carries a `cares` block (else Cares is off: `cares_not_available`). */
  available: z.boolean(),
  /** An operator enabled Cares for this business (`platform.cares_enablement`). */
  enabled: z.boolean(),
  profile: z.strictObject({ status: z.enum(["active", "paused"]), public_name: NonEmpty, b2b_enabled: z.boolean() }).nullable(),
  outlets: z.array(
    z.strictObject({ outlet_id: Uuid7, city_code: CityCode, lat_e6: LatE6, lng_e6: LngE6, pickup_from: LocalTime, pickup_to: LocalTime, active: z.boolean() }),
  ),
  ...CaresLabels,
});

export const CaresRecipientsResponse = z.strictObject({
  items: z.array(
    z.strictObject({
      recipient_id: Uuid7,
      city_code: CityCode,
      /** Always contains "(simulated)". */
      name: NonEmpty,
      kind: z.enum(["ngo", "food_bank"]),
      simulated: z.literal(true),
      accepts_cooked: z.boolean(),
      accepts_raw: z.boolean(),
      accepts_packaged: z.boolean(),
      capacity_kg_per_day: z.int().min(0),
      capacity_portions_per_day: z.int().min(0),
      receiving_from: LocalTime,
      receiving_to: LocalTime,
      lat_e6: LatE6,
      lng_e6: LngE6,
    }),
  ),
  ...CaresLabels,
});

/** `core.cares_market_offers`: other businesses' published offers in the caller's opted-in cities. */
export const CaresMarketResponse = z.strictObject({
  items: z.array(
    z.strictObject({
      offer_tenant_id: Uuid7,
      listing_id: Uuid7,
      business_name: NonEmpty,
      outlet_name: NonEmpty,
      city_code: CityCode,
      pickup_from: IsoDateTime,
      pickup_to: IsoDateTime,
      pickup_on: IsoDate,
      lines: z.array(
        z.strictObject({
          offer_line_id: Uuid7,
          food_kind: FoodKind,
          label: z.string(),
          qty_milli: QtyMilli,
          unit: Unit,
          expires_on: IsoDate.nullable(),
          unit_price_minor: MinorAmount,
          currency: CurrencyCode,
        }),
      ),
    }),
  ),
  ...CaresLabels,
  ...MoneyLabel,
});

/** `core.cares_claim_outcome` for the buyer's own claim. "declined" also covers withdrawn and allocated elsewhere. */
const ClaimOutcome = z.strictObject({
  verdict: z.enum(["accepted", "declined", "none"]),
  allocation_id: Uuid7.nullable(),
  decided_at: IsoDateTime.nullable(),
  lines: z.array(z.strictObject({ offer_line_id: Uuid7, handed_qty_milli: QtyMilli })),
});
export const CaresClaimsResponse = z.strictObject({
  items: z.array(
    z.strictObject({
      claim_id: Uuid7,
      outlet_id: Uuid7,
      offer_tenant_id: Uuid7,
      offer_listing_id: Uuid7,
      allocation_id: Uuid7.nullable(),
      status: ClaimStatus,
      /** Recorded, never processed. */
      total_minor: MinorAmount,
      currency: CurrencyCode,
      created_by: Uuid7,
      created_at: IsoDateTime,
      lines: z.array(
        z.strictObject({
          offer_line_id: Uuid7,
          ingredient_id: Uuid7,
          qty_milli: QtyMilli,
          unit: Unit,
          unit_price_minor: MinorAmount,
          expires_on: IsoDate.nullable(),
          received_qty_milli: QtyMilli.nullable(),
        }),
      ),
      outcome: ClaimOutcome,
    }),
  ),
  ...CaresLabels,
  ...MoneyLabel,
});

/** `core.cares_inbound_claims`: claims on the caller's own offer. */
export const CaresInboundClaimsResponse = z.strictObject({
  items: z.array(
    z.strictObject({
      claim_tenant_id: Uuid7,
      claim_id: Uuid7,
      buyer_public_name: NonEmpty,
      status: ClaimStatus,
      created_at: IsoDateTime,
      lines: z.array(z.strictObject({ offer_line_id: Uuid7, qty_milli: QtyMilli, unit_price_minor: MinorAmount })),
    }),
  ),
  ...CaresLabels,
  ...MoneyLabel,
});

// ---- Public read models (ADR §2.1, §2.3): no credential. Recipients always read "Simulated recipient".
export const CaresNetworkCitiesResponse = z.strictObject({ items: z.array(z.strictObject({ code: CityCode, country_code: z.string().regex(/^[A-Z]{2}$/), name: NonEmpty })) });

export const CaresNetworkListing = z.strictObject({
  listing_id: Uuid7,
  city_code: CityCode,
  business_name: NonEmpty,
  outlet_name: NonEmpty,
  pickup_from: IsoDateTime,
  pickup_to: IsoDateTime,
  /** The outlet's IANA time zone: render pickup_from / pickup_to in it (G-14). */
  tz: IanaZone,
  recipient_name: NonEmpty,
  recipient_simulated: z.literal(true),
  lines: z.array(
    z.strictObject({
      line_no: z.int().min(1),
      food_kind: FoodKind,
      label_key: z.string().nullable(),
      label: z.string().nullable(),
      qty_milli: QtyMilli,
      unit: Unit,
      expires_on: IsoDate.nullable(),
    }),
  ),
});
export const CaresNetworkListingsResponse = z.strictObject({ items: z.array(CaresNetworkListing), next_cursor: Uuid7.nullable() });
/** The storefront section: the key's own tenant only, uncached. */
export const CaresStorefrontResponse = z.strictObject({ items: z.array(CaresNetworkListing) });

const ImpactFact = <T extends z.ZodType>(value: T) => z.strictObject({ value, ref: Ref });
/** The latest published network snapshot covering the city (or the Σ). Each value sits beside its
 *  ⟨snap:<id>·<row>·<col>⟩ ref; `GET /v1/cares-network/snapshots/{id}` opens the stored rows. */
export const CaresNetworkImpactResponse = z.strictObject({
  snapshot_id: Uuid7,
  /** = the snapshot's created_at. */
  as_of: IsoDateTime,
  template_id: Slug,
  template_version: z.int().min(1),
  /** Σ row first (city_code null), then one row per city. */
  rows: z.array(
    z.strictObject({
      city_code: CityCode.nullable(),
      businesses: ImpactFact(z.int()),
      donations: ImpactFact(z.int()),
      /** Cooked portions donated, in thousandths (the "meals"). */
      meals_portions_milli: ImpactFact(z.int()),
      weight_g: ImpactFact(z.int()),
      volume_ml: ImpactFact(z.int()),
      all_synthetic: ImpactFact(z.boolean()),
    }),
  ),
  ...CaresLabels,
});

const NetworkSnapshotBase = {
  snapshot_id: Uuid7,
  template_id: Slug,
  template_version: z.int().min(1),
  params: TemplateParams,
  columns: z.array(SnapshotColumn),
  rows: z.array(z.record(z.string(), Cell)).max(500),
  row_count: z.int().min(0).max(500),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  created_at: IsoDateTime,
};
/** A published network snapshot opened publicly (404 when unpublished). */
export const CaresNetworkSnapshotResponse = z.strictObject({ ...NetworkSnapshotBase, published_at: IsoDateTime, ...CaresLabels });
/** Operator view: who minted it and whether/how it was published. */
export const CaresNetworkSnapshotMint = z.strictObject({ template_id: Slug, params: TemplateParams });
/** `params` of a `platform.cares_network_impact` mint (= the template's params_schema, 0028): city_code null = every city. */
export const CaresNetworkImpactParams = z.strictObject({ from: IsoDate, to: IsoDate, city_code: CityCode.nullable() });
export const CaresOperatorNetworkSnapshot = z.strictObject({
  ...NetworkSnapshotBase,
  minted_by_operator_id: Uuid7,
  published_at: IsoDateTime.nullable(),
  publish_draft_id: Uuid7.nullable(),
});
export const CaresOperatorNetworkSnapshotsResponse = z.strictObject({ items: z.array(CaresOperatorNetworkSnapshot) });

export const SCHEMAS = {
  "cares.profile.set.v1": CaresProfileSetV1,
  "cares.listing.publish.v1": CaresListingPublishV1,
  "cares.listing.withdraw.v1": CaresListingWithdrawV1,
  "cares.handover.record.v1": CaresHandoverRecordV1,
  "cares.handover.void.v1": CaresHandoverVoidV1,
  "cares.claim.create.v1": CaresClaimCreateV1,
  "cares.claim.cancel.v1": CaresClaimCancelV1,
  "cares.claim.close.v1": CaresClaimCloseV1,
  "cares.claim.decide.v1": CaresClaimDecideV1,
  "cares.claim.receive.v1": CaresClaimReceiveV1,
  "proposal.cares.listing.publish.v1": CARES_LISTING_DRAFT.proposal,
  "cares.network-snapshot-mint": CaresNetworkSnapshotMint,
  "v1.cares.profile": CaresProfileResponse,
  "v1.cares.recipients": CaresRecipientsResponse,
  "v1.cares.listings": CaresListingsResponse,
  "v1.cares.listing": CaresListingResponse,
  "v1.cares.market": CaresMarketResponse,
  "v1.cares.claims": CaresClaimsResponse,
  "v1.cares.inbound-claims": CaresInboundClaimsResponse,
  "v1.cares-network.cities": CaresNetworkCitiesResponse,
  "v1.cares-network.listings": CaresNetworkListingsResponse,
  "v1.cares-network.listing": CaresNetworkListing,
  "v1.cares-network.impact": CaresNetworkImpactResponse,
  "v1.cares-network.snapshot": CaresNetworkSnapshotResponse,
  "v1.storefront.cares": CaresStorefrontResponse,
  "platform.cares-network-snapshot": CaresOperatorNetworkSnapshot,
  "platform.cares-network-snapshots": CaresOperatorNetworkSnapshotsResponse,
};

// ---- Routes (ADR §5). The mounted side is T-095a (member), T-095b (public, storefront, operator).
const uuid = { type: "string", pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" };
const param = (name: string, schema: Record<string, unknown>, required = false): QueryParam => ({ name, required, schema });
const cursor = param("cursor", uuid);
const limit = (max: number) => param("limit", { type: "integer", minimum: 1, maximum: max });
const city = param("city", { type: "string", pattern: "^[a-z][a-z0-9_]*$", maxLength: 40 });
const idParam = [{ name: "id", uuid: true }];
const read = (path: string, operationId: string, summary: string, response: string, extra: Partial<Route> = {}): Route =>
  ({ surface: "public", method: "get", path, operationId, summary, auth: "member", response, status: 200, ...extra });
const command = (path: string, operationId: string, type: string, summary: string, extra: Partial<Route> = {}): Route =>
  ({ surface: "public", method: "post", path, operationId, summary: `${type} — ${summary}`, auth: "member", command: type, response: "command-result", status: 200, conflict: true, ...extra });
const publicRead = (path: string, operationId: string, summary: string, response: string, extra: Partial<Route> = {}): Route =>
  read(path, operationId, summary, response, { auth: "public", ...extra });

export const ROUTES: readonly Route[] = [
  read("/v1/cares/profile", "getCaresProfile", "The business's Munim Cares setup: availability, operator enablement, profile and outlet cities", "v1.cares.profile"),
  command("/v1/cares/profile", "setCaresProfile", "cares.profile.set.v1", "opt in or pause, name the business, set each outlet's city, location and pickup hours"),
  read("/v1/cares/recipients", "listCaresRecipients", "Simulated recipients in the outlet's city", "v1.cares.recipients", { query: [param("outlet", uuid, true)] }),
  read("/v1/cares/listings", "listCaresListings", "Surplus listings and their hand-overs, newest first", "v1.cares.listings", {
    query: [param("outlet", uuid), param("kind", { type: "string", enum: ["donation", "offer"] }), param("status", { type: "string", enum: ["published", "allocated", "closed", "withdrawn"] }), cursor, limit(200)],
  }),
  command("/v1/cares/listings", "publishCaresListing", "cares.listing.publish.v1", "publish a donation or an offer (owner or judge; intel may draft it, cooked lines only by the owner's own command)"),
  read("/v1/cares/listings/{id}", "getCaresListing", "One listing with its lines and hand-overs", "v1.cares.listing", { pathParams: idParam }),
  command("/v1/cares/listings/{id}:withdraw", "withdrawCaresListing", "cares.listing.withdraw.v1", "withdraw a published listing (not after an offer is allocated)", { pathParams: idParam }),
  command("/v1/cares/handovers", "recordCaresHandover", "cares.handover.record.v1", "record what was handed over; core derives the stock movements"),
  command("/v1/cares/handovers/{id}:void", "voidCaresHandover", "cares.handover.void.v1", "void a recorded hand-over with a reason; stock comes back (not after the buyer received)", { pathParams: idParam }),
  read("/v1/cares/market", "listCaresMarket", "Other businesses' shared surplus offers in the caller's cities (needs B2B on)", "v1.cares.market", { query: [param("listing", uuid)] }),
  read("/v1/cares/claims", "listCaresClaims", "The buyer's own claims with their outcome", "v1.cares.claims", { query: [param("outlet", uuid)] }),
  command("/v1/cares/claims", "createCaresClaim", "cares.claim.create.v1", "claim every line of an offer at the offered quantity (all-or-nothing); the price is recorded, never processed"),
  command("/v1/cares/claims/{id}:cancel", "cancelCaresClaim", "cares.claim.cancel.v1", "cancel a claim before any verdict", { pathParams: idParam }),
  command("/v1/cares/claims/{id}:close", "closeCaresClaim", "cares.claim.close.v1", "close a claim whose outcome is declined", { pathParams: idParam }),
  command("/v1/cares/claims/{id}:receive", "receiveCaresClaim", "cares.claim.receive.v1", "receive an accepted, handed-over claim into stock", { pathParams: idParam }),
  read("/v1/cares/listings/{id}/claims", "listCaresInboundClaims", "Claims on the caller's own offer", "v1.cares.inbound-claims", { pathParams: idParam }),
  command("/v1/cares/listings/{id}:decide", "decideCaresClaim", "cares.claim.decide.v1", "accept or decline one claim on the caller's offer (one accepted claim per offer)", { pathParams: idParam }),

  // Public: no credential, read-only, 60 requests a minute per client (ADR §2.2). Cached 30 s; a withdrawn listing may show that long.
  publicRead("/v1/cares-network/cities", "listCaresNetworkCities", "Cities with surplus-sharing businesses (Simulated recipients; Check your local food-donation rules)", "v1.cares-network.cities"),
  publicRead("/v1/cares-network/listings", "listCaresNetworkListings", "Live donation listings in a city to Simulated recipients", "v1.cares-network.listings", { query: [city, cursor, limit(50)] }),
  publicRead("/v1/cares-network/listings/{id}", "getCaresNetworkListing", "One live donation listing (404 when not live)", "v1.cares-network.listing", { pathParams: idParam }),
  publicRead("/v1/cares-network/impact", "getCaresNetworkImpact", "Meals shared across Munim to Simulated recipients: the latest published network snapshot, each value beside its ref", "v1.cares-network.impact", { query: [city] }),
  publicRead("/v1/cares-network/snapshots/{id}", "getCaresNetworkSnapshot", "A published network snapshot with its rows and sha256 (404 when unpublished)", "v1.cares-network.snapshot", { pathParams: idParam }),
  read("/v1/storefront/cares", "getStorefrontCares", "The storefront key's own live donation listings (uncached; a bad key or a non-storefront channel is 404)", "v1.storefront.cares", { auth: "storefront" }),

  // Operator: the network total is minted by the operator's own command (R27) and published by an approved config draft
  // with target `cares_public_impact:<snapshot_id>` (R24). Other Cares config targets: cares_city, cares_recipient, cares_enablement.
  { surface: "public", method: "post", path: "/platform/v1/network-snapshots", operationId: "mintCaresNetworkSnapshot", summary: "Mint the network impact snapshot (operator template platform.cares_network_impact); nothing is public until a config draft publishes it",
    auth: "operator", request: "cares.network-snapshot-mint", response: "platform.cares-network-snapshot", status: 201 },
  { surface: "public", method: "get", path: "/platform/v1/network-snapshots", operationId: "listCaresNetworkSnapshots", summary: "Minted network snapshots with their publish state", auth: "operator",
    response: "platform.cares-network-snapshots", status: 200 },
];
