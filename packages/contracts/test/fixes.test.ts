// W1 fix cycle 1 (docs/plan/W1-FIX-LIST.md) — contract rules, with parity against the frozen migrations
// where the database already fixes the value (code outranks docs).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DraftView, DraftsApproveV1 } from "../src/approvals/index.ts";
import { CatalogueItemUpsertV1 } from "../src/catalogue/index.ts";
import { MovementKind } from "../src/events/index.ts";
import { DraftsRequest } from "../src/internal/index.ts";
import { KitchenTicketStatus } from "../src/kitchen/index.ts";
import { OrdersPlaceV1, OrdersPreviewRequest, OrdersTenderRecordV1, TenderView } from "../src/orders/index.ts";
import { CountryPack } from "../src/packs/index.ts";
import { loadRegistry } from "../src/registry.ts";
import { CommandResult } from "../src/shared/command.ts";
import { COUPON_CODE_PATTERN, CouponCode } from "../src/shared/primitives.ts";
import { StorefrontGuestCreateV1 } from "../src/storefront/index.ts";
import { PKG, loadSamples } from "./helpers.ts";

await loadRegistry();
const SAMPLES = await loadSamples();
const MIGRATIONS = join(PKG, "..", "..", "db", "migrations");
const sql = (f: string) => readFileSync(join(MIGRATIONS, f), "utf8");
const js = (n: string) => JSON.parse(readFileSync(join(PKG, "generated", "json-schema", `${n}.schema.json`), "utf8"));
const openapi = JSON.parse(readFileSync(join(PKG, "generated", "openapi", "public.json"), "utf8"));

describe("#40 one coupon-code regex = the DB's", () => {
  it("equals core.coupon.code's CHECK in 0004", () => {
    const m = /code\s+text\s+NOT NULL CHECK \(code ~ '([^']+)'\)/.exec(sql("0004_catalogue_orders_customer.sql"));
    expect(m?.[1]).toBe(COUPON_CODE_PATTERN);
  });
  it.each([
    ["DIWALI-10", true],
    ["ABC", true],
    ["A".repeat(32), true],
    ["diwali10", false],
    ["-ABC", false],
    ["AB", false],
    ["A".repeat(33), false],
    ["DIWALI 10", false],
  ])("%s → %s", (code, ok) => {
    expect(CouponCode.safeParse(code).success).toBe(ok);
    const place = SAMPLES["orders.place.v1"] as any;
    expect(OrdersPlaceV1.safeParse({ ...place, coupon_codes: [code] }).success).toBe(ok);
    expect(OrdersPreviewRequest.safeParse({ ...(SAMPLES["orders.preview.request"] as any), coupon_codes: [code] }).success).toBe(ok);
  });
});

describe("#39 a SKU names its stock ingredient", () => {
  const sku = { item_id: "0199e0a0-0000-7000-8000-000000000015", name_key: "sku.x", category: "dairy", brand_id: null, barcode: null, mrp_minor: 5800, currency: "INR", active: true, variants: [], option_groups: [], kind: "sku" };
  it("sku without stock_ingredient_id → refused (null and missing); with it → accepted; a dish may omit it", () => {
    expect(CatalogueItemUpsertV1.safeParse({ ...sku, stock_ingredient_id: null }).success).toBe(false);
    expect(CatalogueItemUpsertV1.safeParse(sku).success).toBe(false);
    expect(CatalogueItemUpsertV1.safeParse({ ...sku, stock_ingredient_id: "0199e0a0-0000-7000-8000-000000000043" }).success).toBe(true);
    expect(CatalogueItemUpsertV1.safeParse({ ...sku, kind: "dish", stock_ingredient_id: null }).success).toBe(true);
  });
  it("the generated JSON Schema enforces it too (sku variant requires a uuid string)", () => {
    const variants = (js("catalogue.item.upsert.v1").oneOf ?? js("catalogue.item.upsert.v1").anyOf) as any[];
    const v = variants.find((x) => x.properties.kind.const === "sku");
    expect([v.required.includes("stock_ingredient_id"), v.properties.stock_ingredient_id.type]).toEqual([true, "string"]);
  });
  it("tax_class is gone from the item (it lives on price); mrp_minor and currency travel together", () => {
    expect(CatalogueItemUpsertV1.safeParse({ ...sku, stock_ingredient_id: "0199e0a0-0000-7000-8000-000000000043", tax_class: "goods_5" }).success).toBe(false);
    expect(CatalogueItemUpsertV1.safeParse({ ...sku, stock_ingredient_id: "0199e0a0-0000-7000-8000-000000000043", currency: null }).success).toBe(false);
  });
  it("option groups: max ≥ min, required ⇒ min ≥ 1, deltas non-zero and one per ingredient", () => {
    const dish = SAMPLES["catalogue.item.upsert.v1"] as any;
    const g = dish.option_groups[0];
    const withGroup = (x: object) => ({ ...dish, option_groups: [{ ...g, ...x }] });
    expect(CatalogueItemUpsertV1.safeParse(dish).success).toBe(true);
    expect(CatalogueItemUpsertV1.safeParse(withGroup({ min_select: 3 })).success).toBe(false);
    expect(CatalogueItemUpsertV1.safeParse(withGroup({ required: true, min_select: 0 })).success).toBe(false);
    const o = g.options[0];
    expect(CatalogueItemUpsertV1.safeParse(withGroup({ options: [{ ...o, ingredient_deltas: [{ ...o.ingredient_deltas[0], qty_milli: 0 }] }] })).success).toBe(false);
    expect(CatalogueItemUpsertV1.safeParse(withGroup({ options: [{ ...o, ingredient_deltas: [o.ingredient_deltas[0], { ...o.ingredient_deltas[0], delta_id: "0199e0a0-0000-7000-8000-000000000099" }] }] })).success).toBe(false);
  });
});

describe("#52 tenant-wide drafts: outlet_ids may be empty", () => {
  it("DraftsRequest and DraftView accept []", () => {
    expect(DraftsRequest.safeParse({ ...(SAMPLES["internal.drafts.request"] as any), outlet_ids: [] }).success).toBe(true);
    expect(DraftView.safeParse({ ...(SAMPLES["v1.draft"] as any), outlet_ids: [] }).success).toBe(true);
  });
  it("…but not a malformed id", () => {
    expect(DraftsRequest.safeParse({ ...(SAMPLES["internal.drafts.request"] as any), outlet_ids: ["*"] }).success).toBe(false);
  });
});

describe("#45 customer_id never comes from a payload", () => {
  it.each(["storefront.guest.create.v1", "orders.place.v1", "orders.preview.request"])("%s has no customer_id and refuses one", (n) => {
    expect(JSON.stringify(js(n))).not.toContain("customer_id");
    const schema = { "storefront.guest.create.v1": StorefrontGuestCreateV1, "orders.place.v1": OrdersPlaceV1, "orders.preview.request": OrdersPreviewRequest }[n]!;
    expect(schema.safeParse({ ...(SAMPLES[n] as any), customer_id: "0199e0a0-0000-7000-8000-000000000009" }).success).toBe(false);
  });
});

describe("DB parity (#38 #41 #42)", () => {
  it("kitchen ticket states = core.kitchen_ticket.status CHECK", () => {
    const m = /status\s+text\s+NOT NULL DEFAULT 'queued' CHECK \(status IN \(([^)]+)\)\)/.exec(sql("0004_catalogue_orders_customer.sql"));
    expect([...KitchenTicketStatus.options]).toEqual(m![1]!.split(",").map((x) => x.trim().replaceAll("'", "")));
  });
  it("movement kinds = core.stock_movement.kind CHECK", () => {
    const ddl = sql("0005_inventory_store_purchasing.sql").split("CREATE TABLE core.stock_movement")[1]!.split(";")[0]!;
    const m = /kind\s+text\s+NOT NULL CHECK \(kind IN \(([^)]+)\)\)/.exec(ddl.replace(/\s*\n\s*/g, " "));
    expect([...MovementKind.options].sort()).toEqual(m![1]!.split(",").map((x) => x.trim().replaceAll("'", "")).sort());
  });
  it("movement ref_type pattern = core.stock_movement.ref_type CHECK", () => {
    const m = /ref_type\s+text\s+CHECK \(ref_type ~ '([^']+)'\)/.exec(sql("0005_inventory_store_purchasing.sql"));
    expect(js("munim.inventory.movement.recorded.v1").properties.data.properties.ref_type.pattern).toBe(m![1]);
  });
});

describe("#43 #59 tenders", () => {
  const view = SAMPLES["v1.tender"] as any;
  it("card / UPI: tendered, change and rounding null; cash: all set and change = tendered − amount", () => {
    expect(TenderView.safeParse({ ...view, method: "card", tendered_minor: null, change_minor: null, rounding_minor: null }).success).toBe(true);
    expect(TenderView.safeParse({ ...view, method: "card" }).success).toBe(false);
    expect(TenderView.safeParse({ ...view, change_minor: 1 }).success).toBe(false);
    expect(TenderView.safeParse({ ...view, rounding_minor: null }).success).toBe(false);
  });
  it("record: cash carries tendered (core computes the amount); card carries the amount", () => {
    const rec = SAMPLES["orders.tender.record.v1"] as any;
    expect(OrdersTenderRecordV1.safeParse({ ...rec, method: "card", tendered_minor: null, amount_minor: 58380, ref: "APPR-1" }).success).toBe(true);
    expect(OrdersTenderRecordV1.safeParse({ ...rec, method: "card" }).success).toBe(false);
    expect(OrdersTenderRecordV1.safeParse({ ...rec, amount_minor: 100 }).success).toBe(false);
  });
});

describe("#3 #2 #5 HTTP contract", () => {
  it("CommandResult has no `replayed`; command routes declare the X-Munim-Replayed response header", () => {
    expect(CommandResult.safeParse({ ...(SAMPLES["command-result"] as any), replayed: false }).success).toBe(false);
    for (const path of ["/v1/drafts/{id}:approve", "/v1/drafts/{id}:reject", "/platform/v1/tenants:provision"])
      expect(Object.keys(openapi.paths[path].post.responses[path.includes("provision") ? "201" : "200"].headers)).toEqual(["X-Munim-Replayed"]);
  });
  it("member routes require X-Munim-Tenant; the storefront key is declared", () => {
    const s = openapi.components.securitySchemes;
    expect([s.tenantHeader.name, s.storefrontKey.name]).toEqual(["X-Munim-Tenant", "X-Munim-Storefront-Key"]);
    expect(openapi.paths["/v1/drafts"].get.security).toEqual([{ memberToken: [], tenantHeader: [] }]);
  });
  it("approve / reject 409 bodies are the decision error (stale `changes`, `already_decided`)", () => {
    expect(openapi.paths["/v1/drafts/{id}:approve"].post.responses["409"].content["application/json"].schema.$ref).toBe("#/components/schemas/DraftsDecisionError");
    const err = SAMPLES["drafts.decision-error"] as any;
    expect(DraftsApproveV1).toBeDefined();
    expect(err.changes.length).toBe(1);
  });
  it("@munim/contracts/registry resolves by package name", async () => {
    const m = await import("@munim/contracts/registry");
    expect((await m.loadRegistry()).modules).toContain("approvals");
  });
});

describe("#4 tax id ↔ receipt field", () => {
  const load = (c: string) => JSON.parse(readFileSync(join(PKG, "packs", `${c}.json`), "utf8"));
  it("each printed tax id links a required receipt field", () => {
    expect(CountryPack.parse(load("IN")).tax_ids.map((t) => [t.code, t.receipt_field])).toEqual([["GSTIN", "gstin"], ["FSSAI", "fssai_number"]]);
    expect(CountryPack.parse(load("AU")).tax_ids.map((t) => [t.code, t.receipt_field])).toEqual([["ABN", "abn"]]);
  });
  it.each([
    ["field not in required_fields", (p: any) => ({ ...p, tax_ids: [{ ...p.tax_ids[0], receipt_field: "mystery" }] })],
    ["on_receipt without a field", (p: any) => ({ ...p, tax_ids: [{ ...p.tax_ids[0], receipt_field: null }] })],
  ])("refused: %s", (_l, mutate) => {
    expect(CountryPack.safeParse(mutate(load("AU"))).success).toBe(false);
  });
  it("cash rounding: AU 5c, IN ₹1 (INFERENCE, noted)", () => {
    expect([CountryPack.parse(load("AU")).cash_rounding_minor, CountryPack.parse(load("IN")).cash_rounding_minor]).toEqual([5, 100]);
    expect(load("IN")._unverified.some((x: string) => x.startsWith("cash_rounding_minor 100"))).toBe(true);
  });
});
