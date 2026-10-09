// Storefront commands. Guest checkout: the customer's own command creates their core.customer record
// (02-schema §2.1, R27 — a customer is a named person only for their own order and profile).
// T-032 owns this module from W2.
import { z } from "zod";
import { Email, IsoDateTime, NonEmpty } from "../shared/primitives.ts";
import type { Route } from "../shared/routes.ts";

/** No customer_id: core-api mints the guest's id and puts it on the principal (W1 fix #45). */
export const StorefrontGuestCreateV1 = z.strictObject({
  name: NonEmpty,
  /** E.164. */
  phone: z.string().regex(/^\+[1-9][0-9]{6,14}$/).nullable(),
  email: Email.nullable(),
  consent: z.strictObject({ marketing: z.boolean(), at: IsoDateTime }),
});

export const SCHEMAS = { "storefront.guest.create.v1": StorefrontGuestCreateV1 };
export const ROUTES: readonly Route[] = [];
