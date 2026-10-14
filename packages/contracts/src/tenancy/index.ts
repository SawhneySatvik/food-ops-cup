// Tenancy setup commands (02-schema §2.1). Field names follow the core.* columns. Currency, FY start,
// tax rules and time zones come from the tenant's country pack, never from a request (R21, R30).
import { z } from "zod";
import { BasisPoints, CountryCode, CurrencyCode, Email, IanaZone, IsoDate, IsoDateTime, LocalTime, MemberRole, NonEmpty, Uuid7 } from "../shared/primitives.ts";
import type { Route } from "../shared/routes.ts";
import { READ_ROUTES, READ_SCHEMAS } from "./read-routes.ts";

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
/** The outlet's public phone number, E.164 (0029 core.outlet.phone; shown on the storefront, G-04). */
export const OutletPhone = z.string().regex(/^\+[1-9][0-9]{6,14}$/);

export const TenancyOutletCreateV1 = z.strictObject({
  outlet_id: Uuid7,
  name: NonEmpty,
  kind: OutletKind,
  /** Must be one of the tenant's pack `timezones`. */
  tz: IanaZone,
  address: z.string().min(1).max(500),
  /** Keyed by the pack's tax_ids[].code (e.g. GSTIN, FSSAI, ABN); values checked against its pattern. */
  tax_ids: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.string().min(1).max(64)),
  /** Optional (absent = none). */
  phone: OutletPhone.nullable().optional(),
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

// ---- T-020: self-serve onboarding, settings, member bind, storefront keys, demo session --------------------
/** What the owner picks on ON2. "shop" is the outlet kind `store` in the database. */
export const OnboardKind = z.enum(["restaurant", "cloud_kitchen", "shop"]);
const TaxIds = z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.string().min(1).max(64));
const Hours = z.strictObject({ opens: LocalTime, closes: LocalTime }).refine((h) => h.opens < h.closes, "opens before closes");

/** `POST /v1/onboarding` (signed-in person, no tenant yet): one call creates tenant + first outlet + owner
 *  membership + the pack-and-kind defaults and sets `onboarded_at` — country is fixed from here on (R30).
 *  `tenant_id` is IGNORED (R1-m6): core mints the tenant id from sha256("munim.onboard", verified sub,
 *  idempotency_key) as a UUIDv7 and returns it as `entity_id` in the 201 result; the same envelope twice returns
 *  the same id, a new idempotency key from the same person makes a new tenant. `owner_member_id` and `outlet_id`
 *  are still the client's. Currency, FY start and the
 *  default time zone come from the country pack, never from this payload. The owner's email comes from the
 *  verified IdP identity. */
export const TenancyOnboardV1 = z.strictObject({
  /** Ignored by core (R1-m6); kept so the envelope shape stays stable. The minted id is `entity_id` of the result. */
  tenant_id: Uuid7,
  owner_member_id: Uuid7,
  outlet_id: Uuid7,
  owner_name: NonEmpty,
  business_name: NonEmpty,
  kind: OnboardKind,
  country_code: CountryCode,
  outlet: z.strictObject({
    name: NonEmpty,
    address: z.string().min(1).max(500),
    /** Optional; must be one of the pack's time zones. Default: the pack's default zone. */
    tz: IanaZone.optional(),
    /** Default "09:00"–"22:00" every day. */
    hours: Hours.optional(),
    /** Format-checked against the pack's patterns when present; absence is allowed (ON3). */
    tax_ids: TaxIds,
  }),
});

/** R47 D7: a negotiation bound as basis points of the reference price (1–20,000: up to double). */
export const NegotiationBp = z.int().min(1).max(20000);
export const NEGOTIATION_DEFAULTS = { target_bp: 9500, walkaway_bp: 11000 } as const;

/** The owner's targets the packs judge against (core.business_policy). A policy is versioned by validity: this opens a new version from
 *  `valid_from` (which must be after the version it replaces) and closes the old one; fields not given carry over. `outlet_id` null =
 *  the tenant-wide policy; an outlet id = that outlet's override. */
export const TenancyPolicySetV1 = z
  .strictObject({
    outlet_id: Uuid7.nullable(),
    valid_from: IsoDate,
    labour_target_bp: BasisPoints.optional(),
    target_margin_bp: BasisPoints.optional(),
    /** R47 D3: the deal review's margin floor (a quote whose margin at the quoted cost is below it fails) — at most target_margin_bp —
     *  and the shortest supplier payment term it accepts, in days (0003's columns). At most 365: a quote's payment_days is 0..365
     *  (0012 intel.supplier_quote), so a longer minimum could never be met. */
    margin_floor_bp: BasisPoints.optional(),
    min_payment_days: z.int().min(0).max(365).optional(),
    /** R47 D7: the share of the reference price a negotiation aims at, and the most it will pay before walking away (basis points of the
     *  reference: 9500 = 95%, 11000 = 110%, the defaults when unset). Not BasisPoints: a walk-away above 100% is normal. Target ≤ walk-away. */
    negotiation_target_bp: NegotiationBp.optional(),
    negotiation_walkaway_bp: NegotiationBp.optional(),
  })
  .refine((p) => p.labour_target_bp !== undefined || p.target_margin_bp !== undefined || p.margin_floor_bp !== undefined
    || p.min_payment_days !== undefined || p.negotiation_target_bp !== undefined || p.negotiation_walkaway_bp !== undefined, "set at least one target");

export const AcceptingOrders = z.enum(["open", "busy", "paused"]);
const Minutes = (max: number, min = 0) => z.int().min(min).max(max);

/** Owner / outlet-manager settings (ON3 / settings "outlets"). Time zone is not editable (it dates the
 *  invoice series and the business day). */
export const TenancyOutletUpdateV1 = z
  .strictObject({
    outlet_id: Uuid7,
    name: NonEmpty.optional(),
    address: z.string().min(1).max(500).optional(),
    tax_ids: TaxIds.optional(),
    accepting_orders: AcceptingOrders.optional(),
    busy_extra_min: Minutes(240).optional(),
    default_prep_min: Minutes(240).optional(),
    cancel_window_min: Minutes(1440).optional(),
    reschedule_window_min: Minutes(1440).optional(),
    pickup_slot_min: Minutes(120, 5).optional(),
    pickup_lead_min: Minutes(1440).optional(),
    upi_vpa: z.string().regex(/^[A-Za-z0-9._-]{2,256}@[A-Za-z][A-Za-z0-9]{1,63}$/).nullable().optional(),
    /** null clears it. */
    phone: OutletPhone.nullable().optional(),
    business_day_cutoff: LocalTime.optional(),
    /** Replaces the weekly hours of all seven days. */
    hours: Hours.optional(),
  })
  .refine((o) => Object.keys(o).length > 1, "change at least one field");

/** Business settings. `country_code` exists only so the database's lock is reachable: after onboarding any
 *  change of it is refused with `country_locked` (R30); before onboarding the currency and FY start follow
 *  the new pack. `complete_onboarding` finishes an operator-provisioned tenant (sets `onboarded_at`). */
export const TenancyTenantUpdateV1 = z
  .strictObject({
    name: NonEmpty.optional(),
    home_tz: IanaZone.nullable().optional(),
    country_code: CountryCode.optional(),
    complete_onboarding: z.literal(true).optional(),
  })
  .refine((o) => Object.keys(o).length > 0, "change at least one field");

/** The invitee's first sign-in: binds the verified IdP subject to the invited member row, once. */
export const TenancyMemberBindV1 = z.strictObject({ member_id: Uuid7 });

/** The owner changes another member's role and outlet scope (never their own; never a judge, whom the platform
 *  makes). `[]` = all outlets (owner/advisor); a manager or staff member needs at least one outlet. */
export const TenancyMemberRoleSetV1 = z.strictObject({
  member_id: Uuid7,
  role: MemberRole.exclude(["judge"]),
  outlet_ids: z.array(Uuid7),
});

/** The owner deactivates another member: their sign-in stops resolving; everything they recorded stays. */
export const TenancyMemberDeactivateV1 = z.strictObject({ member_id: Uuid7 });

/** `/platform/v1/demo-sessions` (operator): an ephemeral named judge who owns a fresh demo tenant (R27). */
export const DemoSessionStartV1 = z.strictObject({
  tenant_id: Uuid7,
  member_id: Uuid7,
  outlet_id: Uuid7,
  kind: OnboardKind,
  country_code: CountryCode,
  /** The judge's IdP subject when the session already has one; null → bound at first sign-in. */
  idp_sub: z.string().min(1).max(256).nullable(),
  /** Shown as "Judge 7f3a (demo)". */
  judge_label: NonEmpty,
});

export const StorefrontKeyCreateRequest = z.strictObject({
  key_id: Uuid7,
  channel_id: Uuid7,
  allowed_origins: z.array(z.string().regex(/^https?:\/\/[^/\s]+$/)).max(20),
});
/** The raw key appears in this response only; the database keeps its sha256. */
export const StorefrontKeyCreated = z.strictObject({
  key_id: Uuid7,
  channel_id: Uuid7,
  key: z.string().min(16).max(256),
  created_at: IsoDateTime,
});
export const StorefrontKeyView = z.strictObject({
  key_id: Uuid7,
  channel_id: Uuid7,
  allowed_origins: z.array(z.string()),
  created_at: IsoDateTime,
  revoked_at: IsoDateTime.nullable(),
});
export const StorefrontKeyList = z.strictObject({ keys: z.array(StorefrontKeyView) });
export const StorefrontKeyRevoked = z.strictObject({ key_id: Uuid7, revoked_at: IsoDateTime });

/** `GET /v1/me/tenants`: where this sign-in is an active member (via core.memberships_for_sub). */
export const MeTenantsResponse = z.strictObject({
  tenants: z.array(z.strictObject({ tenant_id: Uuid7, tenant_name: NonEmpty, role: MemberRole })),
});

// ---- Settings reads (T-020): the rows' own fields. Outlet times leave as postgres renders them ("04:00:00").
const ClockTime = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/);
export const TenantView = z.strictObject({
  tenant_id: Uuid7,
  name: NonEmpty,
  country_code: CountryCode,
  base_currency: CurrencyCode,
  fy_start_month: z.int().min(1).max(12),
  status: z.enum(["active", "retired"]),
  is_demo: z.boolean(),
  onboarded_at: IsoDateTime.nullable(),
  home_tz: IanaZone.nullable(),
});
export const OutletView = z.strictObject({
  id: Uuid7,
  name: NonEmpty,
  kind: OutletKind,
  tz: IanaZone,
  address: z.string(),
  tax_ids: TaxIds,
  accepting_orders: AcceptingOrders,
  busy_extra_min: Minutes(240),
  default_prep_min: Minutes(240),
  cancel_window_min: Minutes(1440),
  reschedule_window_min: Minutes(1440),
  pickup_slot_min: Minutes(120, 5),
  pickup_lead_min: Minutes(1440),
  upi_vpa: z.string().nullable(),
  business_day_cutoff: ClockTime,
  /** 0029: the outlet's public phone (E.164), null = none. */
  phone: z.string().nullable(),
});
export const OutletsResponse = z.strictObject({ outlets: z.array(OutletView) });
/** `GET /v1/me` (R51 A-2): the caller's own membership, as core resolved it from the verified token. `outlet_ids` is the
 *  scope every read and command is judged under: `"*"` = every outlet (owner, advisor, judge with no outlet list), else
 *  exactly these outlets (possibly none). */
export const MeResponse = z.strictObject({
  member_id: Uuid7,
  tenant_id: Uuid7,
  name: NonEmpty,
  role: MemberRole,
  outlet_ids: z.union([z.literal("*"), z.array(Uuid7)]),
});
export const BrandsResponse = z.strictObject({ brands: z.array(z.strictObject({ id: Uuid7, name: NonEmpty, outlet_ids: z.array(Uuid7), active: z.boolean() })) });
export const ChannelsResponse = z.strictObject({ channels: z.array(z.strictObject({ id: Uuid7, name: NonEmpty, kind: ChannelKind, active: z.boolean() })) });
export const DevicesResponse = z.strictObject({
  devices: z.array(z.strictObject({ id: Uuid7, outlet_id: Uuid7, kind: z.enum(["pos", "kds"]), invoice_series: z.string().nullable(), last_seen_at: IsoDateTime.nullable() })),
});
/** Owner (or judge) only. `signed_in` = the invite has been bound to a sign-in. */
export const MembersResponse = z.strictObject({
  members: z.array(z.strictObject({ id: Uuid7, name: NonEmpty, email: Email, active: z.boolean(), signed_in: z.boolean(), role: MemberRole, outlet_ids: z.array(Uuid7) })),
});

export const SCHEMAS = {
  ...READ_SCHEMAS,
  "tenancy.provision.v1": TenancyProvisionV1,
  "tenancy.outlet.create.v1": TenancyOutletCreateV1,
  "tenancy.member.invite.v1": TenancyMemberInviteV1,
  "tenancy.brand.create.v1": TenancyBrandCreateV1,
  "tenancy.channel.create.v1": TenancyChannelCreateV1,
  "tenancy.device.register.v1": TenancyDeviceRegisterV1,
  "tenancy.onboard.v1": TenancyOnboardV1,
  "tenancy.outlet.update.v1": TenancyOutletUpdateV1,
  "tenancy.tenant.update.v1": TenancyTenantUpdateV1,
  "tenancy.policy.set.v1": TenancyPolicySetV1,
  "tenancy.member.bind.v1": TenancyMemberBindV1,
  "tenancy.member.role.set.v1": TenancyMemberRoleSetV1,
  "tenancy.member.deactivate.v1": TenancyMemberDeactivateV1,
  "demo.session.start.v1": DemoSessionStartV1,
  "tenancy.storefront-key.create": StorefrontKeyCreateRequest,
  "tenancy.storefront-key.created": StorefrontKeyCreated,
  "tenancy.storefront-key.list": StorefrontKeyList,
  "tenancy.storefront-key.revoked": StorefrontKeyRevoked,
  "tenancy.me.tenants": MeTenantsResponse,
  "v1.tenant": TenantView,
  "v1.outlets": OutletsResponse,
  "v1.me": MeResponse,
  "v1.brands": BrandsResponse,
  "v1.channels": ChannelsResponse,
  "v1.devices": DevicesResponse,
  "v1.members": MembersResponse,
};

export const ROUTES: readonly Route[] = [
  ...READ_ROUTES,
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
  { surface: "public", method: "post", path: "/v1/outlets", operationId: "createOutlet", summary: "tenancy.outlet.create.v1 — add an outlet (owner)", auth: "member", command: "tenancy.outlet.create.v1", response: "command-result", status: 200, conflict: true },
  { surface: "public", method: "post", path: "/v1/outlets/{id}:update", operationId: "updateOutlet", summary: "tenancy.outlet.update.v1 — outlet settings (owner; manager of that outlet)", auth: "member", command: "tenancy.outlet.update.v1", response: "command-result", status: 200, conflict: true, pathParams: [{ name: "id", uuid: true }] },
  { surface: "public", method: "post", path: "/v1/brands", operationId: "createBrand", summary: "tenancy.brand.create.v1 — add a brand (owner)", auth: "member", command: "tenancy.brand.create.v1", response: "command-result", status: 200, conflict: true },
  { surface: "public", method: "post", path: "/v1/channels", operationId: "createChannel", summary: "tenancy.channel.create.v1 — add a sales channel (owner)", auth: "member", command: "tenancy.channel.create.v1", response: "command-result", status: 200, conflict: true },
  { surface: "public", method: "post", path: "/v1/devices", operationId: "registerDevice", summary: "tenancy.device.register.v1 — register a POS or KDS device (owner; manager of that outlet)", auth: "member", command: "tenancy.device.register.v1", response: "command-result", status: 200, conflict: true },
  { surface: "public", method: "post", path: "/v1/members:invite", operationId: "inviteMember", summary: "tenancy.member.invite.v1 — invite a member by email (owner)", auth: "member", command: "tenancy.member.invite.v1", response: "command-result", status: 200, conflict: true },
  { surface: "public", method: "post", path: "/v1/tenant:update", operationId: "updateTenant", summary: "tenancy.tenant.update.v1 — business settings; country is locked after onboarding (R30)", auth: "member", command: "tenancy.tenant.update.v1", response: "command-result", status: 200, conflict: true },
  { surface: "public", method: "post", path: "/v1/policy", operationId: "setBusinessPolicy", summary: "tenancy.policy.set.v1 — the owner's labour and margin targets, as a new dated version (owner)", auth: "member", command: "tenancy.policy.set.v1", response: "command-result", status: 200, conflict: true },
  { surface: "public", method: "post", path: "/platform/v1/demo-sessions", operationId: "startDemoSession", summary: "demo.session.start.v1 — operator starts an ephemeral judge session on a fresh demo tenant", auth: "operator", command: "demo.session.start.v1", response: "command-result", status: 201, conflict: true },
  { surface: "public", method: "post", path: "/v1/storefront-keys", operationId: "createStorefrontKey", summary: "Create a storefront key; the raw key is returned once (owner)", auth: "member", request: "tenancy.storefront-key.create", response: "tenancy.storefront-key.created", status: 201, conflict: true },
  { surface: "public", method: "get", path: "/v1/storefront-keys", operationId: "listStorefrontKeys", summary: "Storefront keys (no key material)", auth: "member", response: "tenancy.storefront-key.list", status: 200 },
  { surface: "public", method: "post", path: "/v1/onboarding", operationId: "onboard", summary: "tenancy.onboard.v1 — a signed-in person with no tenant creates one: tenant, first outlet, owner membership, pack defaults. The owner's email is the verified IdP email; the same envelope twice makes one tenant", auth: "identity", command: "tenancy.onboard.v1", response: "command-result", status: 201, conflict: true },
  { surface: "public", method: "get", path: "/v1/me/tenants", operationId: "listMyTenants", summary: "Where this sign-in is an active member", auth: "identity", response: "tenancy.me.tenants", status: 200 },
  { surface: "public", method: "post", path: "/v1/members:bind", operationId: "bindMember", summary: "tenancy.member.bind.v1 — the invitee's first sign-in binds the IdP subject to the invited member, once. Tenant from the invite link (X-Munim-Tenant); the email must match the invite AND be verified by the IdP, else 404", auth: "member", command: "tenancy.member.bind.v1", response: "command-result", status: 200, conflict: true },
  { surface: "public", method: "get", path: "/v1/me", operationId: "getMe", summary: "The caller's own member id, name, role and outlet scope in this tenant (read-only)", auth: "member", response: "v1.me", status: 200 },
  { surface: "public", method: "get", path: "/v1/tenant", operationId: "getTenant", summary: "The business's settings row", auth: "member", response: "v1.tenant", status: 200 },
  { surface: "public", method: "get", path: "/v1/outlets", operationId: "listOutlets", summary: "Outlets in the caller's scope", auth: "member", response: "v1.outlets", status: 200 },
  { surface: "public", method: "get", path: "/v1/brands", operationId: "listBrands", summary: "Brands", auth: "member", response: "v1.brands", status: 200 },
  { surface: "public", method: "get", path: "/v1/channels", operationId: "listChannels", summary: "Sales channels", auth: "member", response: "v1.channels", status: 200 },
  { surface: "public", method: "get", path: "/v1/devices", operationId: "listDevices", summary: "POS and KDS devices", auth: "member", response: "v1.devices", status: 200 },
  { surface: "public", method: "get", path: "/v1/members", operationId: "listMembers", summary: "Members and their roles (owner only)", auth: "member", response: "v1.members", status: 200 },
  { surface: "public", method: "post", path: "/v1/members/{id}:set-role", operationId: "setMemberRole", summary: "tenancy.member.role.set.v1 — change another member's role and outlet scope (owner)", auth: "member", command: "tenancy.member.role.set.v1", response: "command-result", status: 200, conflict: true, pathParams: [{ name: "id", uuid: true }] },
  { surface: "public", method: "post", path: "/v1/members/{id}:deactivate", operationId: "deactivateMember", summary: "tenancy.member.deactivate.v1 — deactivate another member; their sign-in stops resolving, their records stay (owner)", auth: "member", command: "tenancy.member.deactivate.v1", response: "command-result", status: 200, conflict: true, pathParams: [{ name: "id", uuid: true }] },
  { surface: "public", method: "post", path: "/v1/storefront-keys/{id}:revoke", operationId: "revokeStorefrontKey", summary: "Revoke a storefront key; it stops resolving at once (owner)", auth: "member", response: "tenancy.storefront-key.revoked", status: 200, pathParams: [{ name: "id", uuid: true }] },
];
