// Purchasing setup commands (02-schema §2.6). A PO exists only once committed; intel proposes
// purchasing.po.create.v1 as a draft whose numbers are refs (approvals module, shared/draft.ts).
import { z } from "zod";
import { CurrencyCode, IsoDate, MinorAmount, NonEmpty, QtyMilli, Unit, Uuid7 } from "../shared/primitives.ts";
import { defineDraftable } from "../shared/draftables.ts";
import type { Route } from "../shared/routes.ts";

export const PurchasingSupplierUpsertV1 = z.strictObject({
  supplier_id: Uuid7,
  name: NonEmpty,
  /** `simulated` suppliers are the suppliers-sim agents; always labelled "Simulated" in the UI. */
  kind: z.enum(["real", "simulated"]),
  a2a_card_url: z.string().regex(/^https?:\/\/\S+$/).max(500).nullable(),
  terms: z.strictObject({ payment_days: z.int().nonnegative(), notes: z.string().max(500).nullable() }),
});

export const PurchasingPoCreateV1 = z.strictObject({
  po_id: Uuid7,
  supplier_id: Uuid7,
  /** One outlet, or several for a pooled PO. */
  outlet_ids: z.array(Uuid7).min(1),
  currency: CurrencyCode,
  expected_on: IsoDate.nullable(),
  negotiation_run_id: Uuid7.nullable(),
  /** Line order is array order; core numbers the lines. */
  lines: z
    .array(
      z.strictObject({
        ingredient_id: Uuid7,
        qty_milli: QtyMilli.positive(),
        unit: Unit,
        unit_price_minor: MinorAmount.nonnegative(),
      }),
    )
    .min(1),
});

/** Intel proposes purchase orders as drafts; executing one commits the PO. */
export const PO_CREATE_DRAFT = defineDraftable("purchasing.po.create.v1", PurchasingPoCreateV1);

export const SCHEMAS = {
  "purchasing.supplier.upsert.v1": PurchasingSupplierUpsertV1,
  "purchasing.po.create.v1": PurchasingPoCreateV1,
  "proposal.purchasing.po.create.v1": PO_CREATE_DRAFT.proposal,
};
export const ROUTES: readonly Route[] = [];
