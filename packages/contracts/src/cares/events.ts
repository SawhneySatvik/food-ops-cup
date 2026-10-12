// Munim Cares events (ADR-015 §5). Ids and categorical fields only (shared/cloudevents.ts): no quantities, no prices.
import { z } from "zod";
import { cloudEvent } from "../shared/cloudevents.ts";
import { Uuid7 } from "../shared/primitives.ts";

const ListingKind = z.enum(["donation", "offer"]);

export const CaresListingPublishedV1 = cloudEvent("munim.cares.listing.published.v1", "cares", z.strictObject({ listing_id: Uuid7, outlet_id: Uuid7, kind: ListingKind }));
export const CaresListingClosedV1 = cloudEvent(
  "munim.cares.listing.closed.v1",
  "cares",
  z.strictObject({ listing_id: Uuid7, outlet_id: Uuid7, kind: ListingKind, status: z.enum(["closed", "withdrawn"]) }),
);
export const CaresHandoverRecordedV1 = cloudEvent(
  "munim.cares.handover.recorded.v1",
  "cares",
  z.strictObject({ handover_id: Uuid7, listing_id: Uuid7, outlet_id: Uuid7, kind: ListingKind }),
);
export const CaresHandoverVoidedV1 = cloudEvent(
  "munim.cares.handover.voided.v1",
  "cares",
  z.strictObject({ handover_id: Uuid7, listing_id: Uuid7, outlet_id: Uuid7, kind: ListingKind }),
);
export const CaresClaimCreatedV1 = cloudEvent("munim.cares.claim.created.v1", "cares", z.strictObject({ claim_id: Uuid7, outlet_id: Uuid7 }));
export const CaresClaimDecidedV1 = cloudEvent(
  "munim.cares.claim.decided.v1",
  "cares",
  z.strictObject({ claim_id: Uuid7, listing_id: Uuid7, outlet_id: Uuid7, verdict: z.enum(["accepted", "declined"]) }),
);

export const CARES_EVENT_SCHEMAS = {
  "munim.cares.listing.published.v1": CaresListingPublishedV1,
  "munim.cares.listing.closed.v1": CaresListingClosedV1,
  "munim.cares.handover.recorded.v1": CaresHandoverRecordedV1,
  "munim.cares.handover.voided.v1": CaresHandoverVoidedV1,
  "munim.cares.claim.created.v1": CaresClaimCreatedV1,
  "munim.cares.claim.decided.v1": CaresClaimDecidedV1,
};
