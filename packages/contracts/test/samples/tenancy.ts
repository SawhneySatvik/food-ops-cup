import { u } from "./_ids.ts";

export const SAMPLES: Record<string, unknown> = {
  "tenancy.provision.v1": { tenant_id: u(1), name: "Meena's Kitchens (synthetic)", country_code: "IN", is_demo: true, owner: { member_id: u(7), name: "Meena (synthetic)", email: "meena@example.test" } },
  "tenancy.outlet.create.v1": { outlet_id: u(2), name: "Indiranagar", kind: "restaurant", tz: "Asia/Kolkata", address: "12 Example Road, Bengaluru (synthetic)", tax_ids: { GSTIN: "29ABCDE1234F1Z5", FSSAI: "12345678901234" } },
  "tenancy.member.invite.v1": { member_id: u(8), name: "Ravi (synthetic)", email: "ravi@example.test", role: "manager", outlet_ids: [u(2)] },
  "tenancy.brand.create.v1": { brand_id: u(3), name: "Meena's Grill", outlet_ids: [u(2)] },
  "tenancy.channel.create.v1": { channel_id: u(4), name: "Swiggy", kind: "aggregator:swiggy" },
  "tenancy.device.register.v1": { device_id: u(5), outlet_id: u(2), kind: "pos", invoice_series: "IND-POS1" },
};
