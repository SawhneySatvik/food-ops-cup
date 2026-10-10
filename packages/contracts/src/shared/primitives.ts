// Shared scalar shapes (03-architecture §1.5). IDs are lowercase UUIDv7 strings, money is integer minor
// units + ISO 4217 code, times are ISO-8601 with an explicit offset. Kept as plain pattern strings so the
// generated Pydantic models hold the exact JSON text (no UUID / datetime / Decimal re-serialisation drift).
import { z } from "zod";

export const UUID7_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

/** Client-generated UUIDv7 (lowercase). */
export const Uuid7 = z.string().regex(new RegExp(`^${UUID7_PATTERN}$`));
/** ISO-8601 date-time with an offset (`Z` or `±hh:mm`); fractional seconds allowed. */
export const IsoDateTime = z.iso.datetime({ offset: true });
export const IsoDate = z.iso.date();
/** Outlet-local wall-clock time, hh:mm. */
export const LocalTime = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/);
export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/);
export const CountryCode = z.string().regex(/^[A-Z]{2}$/);
/** IANA zone name, e.g. Asia/Kolkata, Australia/Melbourne. */
export const IanaZone = z.string().regex(/^[A-Za-z]+\/[A-Za-z_]+$/);
/** Integer minor units (paise, cents). Postgres bigint; JSON safe-integer range. */
export const MinorAmount = z.int();
/** Quantities in thousandths of `unit` (02-schema §0). */
export const QtyMilli = z.int();
/** Basis points, 0..10000. */
export const BasisPoints = z.int().min(0).max(10000);
export const Unit = z.string().regex(/^[a-z][a-z_]{0,15}$/);
export const Slug = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/);
export const NonEmpty = z.string().min(1).max(200);
/** Outlet ids, or ["*"] for every outlet. */
export const OutletScope = z.union([z.array(Uuid7).min(1), z.array(z.literal("*")).length(1)]);
export const MemberRole = z.enum(["owner", "manager", "staff", "advisor", "judge"]);
/** Plain pattern, not `format: email` — keeps the Python side free of an email-validator dependency. */
export const Email = z.string().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/).max(254);
/** `<module>.<verb…>.v<N>` (03-architecture §1.6). */
export const CommandType = z.string().regex(/^[a-z][a-z_]*(\.[a-z][a-z_]*)+\.v[1-9][0-9]*$/);

/** Coupon code — the one definition, equal to the DB check on core.coupon.code. */
export const COUPON_CODE_PATTERN = "^[A-Z0-9][A-Z0-9-]{2,31}$";
export const CouponCode = z.string().regex(new RegExp(COUPON_CODE_PATTERN));

/** HTTP headers core-api reads / sets (declared in the generated OpenAPI and set by the SDK). */
export const TENANT_HEADER = "X-Munim-Tenant";
export const STOREFRONT_KEY_HEADER = "X-Munim-Storefront-Key";
/** The guest access token returned once at placement (W1 fix #47); only its sha256 is stored. */
export const GUEST_TOKEN_HEADER = "X-Munim-Guest-Token";
/** Set to "true" on a replayed command response; the body is byte-identical to the first response. */
export const REPLAYED_HEADER = "X-Munim-Replayed";

/** Money: integer minor units + ISO 4217 currency (03-architecture §1.5). The currency must equal the
 *  tenant's base currency (R30); that check is core's, not the schema's. */
export const Money = z.strictObject({ amount_minor: MinorAmount, currency: CurrencyCode });
export type Money = z.infer<typeof Money>;
