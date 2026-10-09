// Tenancy setup commands (02-schema §2.1). Field names follow the core.* columns. Currency, FY start,
// tax rules and time zones come from the tenant's country pack, never from a request (R21, R30).
import { z } from "zod";
import { CountryCode, Email, IanaZone, MemberRole, NonEmpty, Uuid7 } from "../shared/primitives.ts";
import type { Route } from "../shared/routes.ts";

/** Operator command (R27; `/platform/v1/tenants:provision`). The country chosen here is fixed once
 *  onboarding completes (R30) — there is no later country-change command. */
export const TenancyProvisionV1 = z.strictObject({
  tenant_id: Uuid7,
  name: NonEmpty,
  /** One of the published country packs (platform.country_pack.code). */
  country_code: CountryCode,
  is_demo: z.boolean(),
  owner: z.strictObject({ member_id: Uuid7, name: NonEmpty, email: Email }),
});

export const OutletKind = z.enum(["restaurant", "cloud_kitchen", "store"]);

export const TenancyOutletCreateV1 = z.strictObject({
  outlet_id: Uuid7,
  name: NonEmpty,
  kind: OutletKind,
  /** Must be one of the tenant's pack `timezones`. */
  tz: IanaZone,
  address: z.string().min(1).max(500),
  /** Keyed by the pack's tax_ids[].code (e.g. GSTIN, FSSAI, ABN); values checked against its pattern. */
  tax_ids: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.string().min(1).max(64)),
});

export const TenancyMemberInviteV1 = z.strictObject({
  member_id: Uuid7,
  name: NonEmpty,
  email: Email,
  /** Judges are created per demo session by the platform, never invited. */
  role: MemberRole.exclude(["judge"]),
  /** `[]` = all outlets (owner/advisor). */
  outlet_ids: z.array(Uuid7),
});

export const TenancyBrandCreateV1 = z.strictObject({
  brand_id: Uuid7,
  name: NonEmpty,
  outlet_ids: z.array(Uuid7).min(1),
});

/** `aggregator:<code>` codes come from the pack's aggregators[].code. */
export const ChannelKind = z.union([
  z.enum(["counter", "table_qr", "pickup", "own_site"]),
  z.string().regex(/^aggregator:[a-z][a-z0-9_]*$/),
]);

export const TenancyChannelCreateV1 = z.strictObject({
  channel_id: Uuid7,
  name: NonEmpty,
  kind: ChannelKind,
});

export const TenancyDeviceRegisterV1 = z.strictObject({
  device_id: Uuid7,
  outlet_id: Uuid7,
  kind: z.enum(["pos", "kds"]),
  /** Per-device invoice series prefix (POS only; null for KDS). */
  invoice_series: z.string().regex(/^[A-Z][A-Z0-9-]{0,15}$/).nullable(),
});

export const SCHEMAS = {
  "tenancy.provision.v1": TenancyProvisionV1,
  "tenancy.outlet.create.v1": TenancyOutletCreateV1,
  "tenancy.member.invite.v1": TenancyMemberInviteV1,
  "tenancy.brand.create.v1": TenancyBrandCreateV1,
  "tenancy.channel.create.v1": TenancyChannelCreateV1,
  "tenancy.device.register.v1": TenancyDeviceRegisterV1,
};

export const ROUTES: readonly Route[] = [
  {
    surface: "public",
    method: "post",
    path: "/platform/v1/tenants:provision",
    operationId: "provisionTenant",
    summary: "tenancy.provision.v1 — operator provisions a tenant (03-architecture §1.9)",
    auth: "operator",
    command: "tenancy.provision.v1",
    response: "command-result",
    status: 201,
    conflict: true,
  },
];
