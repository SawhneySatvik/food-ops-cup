import { u } from "./_ids.ts";

export const SAMPLES: Record<string, unknown> = {
  "tenancy.provision.v1": { tenant_id: u(1), name: "Meena's Kitchens (synthetic)", country_code: "IN", is_demo: true, owner: { member_id: u(7), name: "Meena (synthetic)", email: "meena@example.test" } },
  "tenancy.outlet.create.v1": { outlet_id: u(2), name: "Indiranagar", kind: "restaurant", tz: "Asia/Kolkata", address: "12 Example Road, Bengaluru (synthetic)", tax_ids: { GSTIN: "29ABCDE1234F1Z5", FSSAI: "12345678901234" } },
  "tenancy.member.invite.v1": { member_id: u(8), name: "Ravi (synthetic)", email: "ravi@example.test", role: "manager", outlet_ids: [u(2)] },
  "tenancy.brand.create.v1": { brand_id: u(3), name: "Meena's Grill", outlet_ids: [u(2)] },
  "tenancy.channel.create.v1": { channel_id: u(4), name: "Swiggy", kind: "aggregator:swiggy" },
  "tenancy.device.register.v1": { device_id: u(5), outlet_id: u(2), kind: "pos", invoice_series: "IND-POS1" },
  "tenancy.onboard.v1": { tenant_id: u(1), owner_member_id: u(7), outlet_id: u(2), owner_name: "Meena (synthetic)", business_name: "Meena's Kitchens (synthetic)", kind: "restaurant", country_code: "IN", outlet: { name: "Indiranagar", address: "12 Example Road, Bengaluru (synthetic)", tz: "Asia/Kolkata", hours: { opens: "09:00", closes: "22:00" }, tax_ids: { FSSAI: "12345678901234" } } },
  "tenancy.outlet.update.v1": { outlet_id: u(2), accepting_orders: "busy", busy_extra_min: 10, pickup_slot_min: 15, upi_vpa: "meenas@okbank", business_day_cutoff: "04:00", hours: { opens: "10:00", closes: "23:00" } },
  "tenancy.tenant.update.v1": { name: "Meena's Kitchens", home_tz: "Asia/Kolkata", complete_onboarding: true },
  "tenancy.member.bind.v1": { member_id: u(8) },
  "demo.session.start.v1": { tenant_id: u(1), member_id: u(7), outlet_id: u(2), kind: "shop", country_code: "AU", idp_sub: null, judge_label: "Judge 7f3a (demo)" },
  "tenancy.storefront-key.create": { key_id: u(9), channel_id: u(4), allowed_origins: ["https://shop.example.test"] },
  "tenancy.storefront-key.created": { key_id: u(9), channel_id: u(4), key: "sfk_synthetic_key_value_0123456789abcdef", created_at: "2026-10-10T10:00:00Z" },
  "tenancy.storefront-key.list": { keys: [{ key_id: u(9), channel_id: u(4), allowed_origins: [], created_at: "2026-10-10T10:00:00Z", revoked_at: null }] },
  "tenancy.storefront-key.revoked": { key_id: u(9), revoked_at: "2026-10-10T11:00:00Z" },
  "tenancy.me.tenants": { tenants: [{ tenant_id: u(1), tenant_name: "Meena's Kitchens (synthetic)", role: "owner" }] },
};
