// Fix-cycle gate for T-095c: contracts against the DB's own CHECKs (read from the migration SQL text, never from the enums under
// test), so a contract that accepts what the DB refuses (a 500 instead of a typed 422) or the reverse goes red.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CaresHandoverRecordV1, CaresHandoverVoidV1, CaresListingPublishV1, CaresMarketResponse, CaresProfileSetV1 } from "../src/cares/index.ts";
import { MovementKind as EventKind, MovementRecordedV1 } from "../src/events/index.ts";
import { MovementKind as ResponseKind } from "../src/inventory/index.ts";
import { MOVEMENT_KIND_VALUES } from "../src/inventory/read-routes.ts";
import { PKG, loadSamples } from "./helpers.ts";

const ROOT = join(PKG, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const quoted = (s: string) => [...s.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
const SAMPLES = await loadSamples();

// 0028 replaces 0005's kind CHECK with a complete named list; 0005's own list must be a subset of it.
const sql0028 = read("db/migrations/0028_cares.sql");
const sql0005 = read("db/migrations/0005_inventory_store_purchasing.sql");
const DB_KINDS = quoted(/ADD CONSTRAINT stock_movement_kind_check CHECK \(kind IN \(([^)]*)\)/.exec(sql0028)![1]!);
const KINDS_0005 = quoted(/kind\s+text\s+NOT NULL CHECK \(kind IN \(([^)]*)\)/.exec(sql0005.split("CREATE TABLE core.stock_movement")[1]!)![1]!);

describe("stock movement kinds = the DB CHECK (0005 + 0028)", () => {
  it("the SQL lists are what we expect to be reading", () => {
    expect(KINDS_0005).toHaveLength(8);
    expect(DB_KINDS).toHaveLength(12);
    for (const k of KINDS_0005) expect(DB_KINDS).toContain(k);
    for (const k of ["donation", "surplus_out", "surplus_in", "cares_reversal"]) expect(DB_KINDS).toContain(k);
  });
  it("every contract and core-api list equals the DB list", () => {
    const sorted = (a: readonly string[]) => [...a].sort();
    expect(sorted(ResponseKind.options)).toEqual(sorted(DB_KINDS));
    expect(sorted(EventKind.options)).toEqual(sorted(DB_KINDS));
    expect(sorted(MOVEMENT_KIND_VALUES)).toEqual(sorted(DB_KINDS));
    const idx = read("services/core-api/src/modules/inventory/index.ts");
    expect(sorted(quoted(/const MOVEMENT_KINDS = \[([^\]]*)\]/.exec(idx.replace(/"/g, "'"))![1]!))).toEqual(sorted(DB_KINDS));
    const stock = read("services/core-api/src/modules/inventory/stock.ts");
    expect(sorted(quoted(/export type Kind = ([^;]*);/.exec(stock.replace(/"/g, "'"))![1]!))).toEqual(sorted(DB_KINDS));
  });
  it("a movement.recorded event with a Cares kind parses; an unknown kind does not", () => {
    const base = SAMPLES["munim.inventory.movement.recorded.v1"] as { data: Record<string, unknown> };
    expect(base).toBeDefined();
    for (const kind of ["donation", "cares_reversal"]) expect(MovementRecordedV1.safeParse({ ...base, data: { ...base.data, kind } }).success, kind).toBe(true);
    expect(MovementRecordedV1.safeParse({ ...base, data: { ...base.data, kind: "gift" } }).success).toBe(false);
  });
});

describe("Cares commands = the 0028 CHECKs", () => {
  const publish = SAMPLES["cares.listing.publish.v1"] as { lines: Array<Record<string, unknown>> };
  const profile = SAMPLES["cares.profile.set.v1"] as Record<string, unknown>;
  const cooked = { ...publish.lines[0], food_kind: "cooked", item_id: "0199e0a0-0000-7000-8000-000000000999", ingredient_id: null, batch_id: null };

  it("the DB text we mirror is really there", () => {
    expect(sql0028).toContain("void_reason_code ~ '^[a-z][a-z0-9_]{0,63}$'");
    expect(sql0028).toContain("length(public_name) BETWEEN 1 AND 120");
    expect(sql0028).toContain("cares_listing_line_cooked_portion CHECK (food_kind <> 'cooked' OR unit = 'portion')");
  });
  it("void reason_code: a dotted or over-long code is refused, a plain one accepted", () => {
    const v = SAMPLES["cares.handover.void.v1"] as Record<string, unknown>;
    expect(CaresHandoverVoidV1.safeParse(v).success).toBe(true);
    expect(CaresHandoverVoidV1.safeParse({ ...v, reason_code: "a.b" }).success).toBe(false);
    expect(CaresHandoverVoidV1.safeParse({ ...v, reason_code: "a".repeat(65) }).success).toBe(false);
    expect(CaresHandoverVoidV1.safeParse({ ...v, reason_code: "a".repeat(64) }).success).toBe(true);
  });
  it("public_name caps at 120", () => {
    expect(CaresProfileSetV1.safeParse({ ...profile, public_name: "x".repeat(120) }).success).toBe(true);
    expect(CaresProfileSetV1.safeParse({ ...profile, public_name: "x".repeat(121) }).success).toBe(false);
  });
  it("cooked lines must be in portions", () => {
    expect(CaresListingPublishV1.safeParse({ ...publish, lines: [{ ...cooked, unit: "portion" }] }).success).toBe(true);
    expect(CaresListingPublishV1.safeParse({ ...publish, lines: [{ ...cooked, unit: "kg" }] }).success).toBe(false);
    expect(CaresListingPublishV1.safeParse({ ...publish, lines: [{ ...publish.lines[0], unit: "kg" }] }).success).toBe(true);
  });
  it("handed_at is not client-chosen: the record command refuses it", () => {
    const r = SAMPLES["cares.handover.record.v1"] as Record<string, unknown>;
    expect(CaresHandoverRecordV1.safeParse(r).success).toBe(true);
    expect(CaresHandoverRecordV1.safeParse({ ...r, handed_at: "2026-10-12T10:00:00Z" }).success).toBe(false);
  });
});

describe("cares_market_offers returns city_code and pickup_on", () => {
  it("the SQL function returns them; the response carries them and refuses an item without", () => {
    expect(sql0028).toContain("RETURNS TABLE (offer_tenant_id uuid, listing_id uuid, business_name text, outlet_name text, city_code text, pickup_from timestamptz,\n               pickup_to timestamptz, pickup_on date, lines jsonb)");
    const m = SAMPLES["v1.cares.market"] as { items: Array<Record<string, unknown>> };
    expect(CaresMarketResponse.safeParse(m).success).toBe(true);
    expect(m.items[0]!.city_code).toBe("pune");
    const { city_code: _c, ...without } = m.items[0]!;
    expect(CaresMarketResponse.safeParse({ items: [without] }).success).toBe(false);
  });
});
