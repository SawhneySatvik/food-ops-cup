// Compile-time proof that the generated client is typed (checked by `tsc -p .` in `make typecheck`).
// Each @ts-expect-error must fire; if the generated types degraded to `any`, tsc reports the directive
// as unused and the typecheck goes red.
import { createMunimClient, GUEST_TOKEN_HEADER, isReplayed, TENANT_HEADER, type Schemas } from "../src/index.ts";

const client = createMunimClient({ baseUrl: "http://localhost:8080", token: () => "token", tenantId: "0199e0a0-0000-7000-8000-000000000001" });
const guest = createMunimClient({ baseUrl: "http://localhost:8080", storefrontKey: () => "sf_live_example" });
const header: "X-Munim-Tenant" = TENANT_HEADER;
const tracker = createMunimClient({ baseUrl: "http://localhost:8080", storefrontKey: "sf_live_example", guestToken: () => "guest-token" });
const guestHeader: "X-Munim-Guest-Token" = GUEST_TOKEN_HEADER;
// @ts-expect-error guestToken is a string or a function returning one, never a number
createMunimClient({ baseUrl: "http://localhost:8080", guestToken: 7 });
void guest, header, tracker, guestHeader;
const id = "0199e0a0-0000-7000-8000-000000000384";
const provision = {
  command_id: id,
  idempotency_key: "provision-0001",
  type: "tenancy.provision.v1" as const,
  payload: { tenant_id: id, name: "Demo (synthetic)", country_code: "IN", is_demo: true, owner: { member_id: id, name: "Owner", email: "o@example.test" } },
};

export async function typed(): Promise<void> {
  const snap = await client.GET("/v1/snapshots/{id}", { params: { path: { id } } });
  if (snap.data) {
    const sha: string = snap.data.sha256;
    const rows: Schemas["Snapshot"]["rows"] = snap.data.rows;
    void sha, rows;
  }
  await client.POST("/platform/v1/tenants:provision", { body: provision });
  const preview = await client.POST("/v1/orders:preview", {
    body: { outlet_id: id, channel_id: id, brand_id: null, kind: "takeaway", pickup_window_id: null, promised_at: null, coupon_codes: [], loyalty_redeem_points: 0, lines: [{ item_id: id, variant_id: null, option_ids: [], qty_milli: 1000, barcode: null }] },
  });
  if (preview.data) {
    const label: "preview" = preview.data.label;
    const priceRef: string = preview.data.lines[0]!.price_ref;
    void label, priceRef;
  }
  const approved = await client.POST("/v1/drafts/{id}:approve", {
    params: { path: { id } },
    body: { command_id: id, idempotency_key: "approve-0001", type: "drafts.approve.v1", payload: { draft_id: id, command_type: "purchasing.po.create.v1", edited_payload: null, reason: null } },
  });
  const replay: boolean = isReplayed(approved.response);
  if (approved.error && "changes" in approved.error) void approved.error.changes;
  void replay;
  // @ts-expect-error a replay is a header, not a body field
  if (approved.data) void approved.data.replayed;
  await client.POST("/v1/snapshots", { body: { template_id: "catalogue.dish_margin", params: { outlet_id: id } } });

  // @ts-expect-error unknown route
  await client.GET("/v1/not-a-route");
  // @ts-expect-error path parameter is required
  await client.GET("/v1/snapshots/{id}", { params: { path: {} } });
  // @ts-expect-error the envelope's type is pinned to the route's command
  await client.POST("/platform/v1/tenants:provision", { body: { ...provision, type: "orders.place.v1" } });
  // @ts-expect-error a preview line needs a quantity
  await client.POST("/v1/orders:preview", { body: { outlet_id: id, channel_id: id, brand_id: null, kind: "takeaway", pickup_window_id: null, promised_at: null, coupon_codes: [], loyalty_redeem_points: 0, lines: [{ item_id: id, variant_id: null, option_ids: [], barcode: null }] } });
  // @ts-expect-error is_demo is a boolean
  await client.POST("/platform/v1/tenants:provision", { body: { ...provision, payload: { ...provision.payload, is_demo: "yes" } } });
  if (snap.data) {
    // @ts-expect-error sha256 is a string
    const n: number = snap.data.sha256;
    void n;
  }
}
