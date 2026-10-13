// Gate (T-095c, ADR-015 §5): the Munim Cares contracts against hand-kept expectations — the ADR §1.3 command list, the §5 route
// table, the §1.3 reason codes — never against the module under test. Each refusal is paired with an accept.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CaresNetworkImpactResponse, CaresNetworkListing } from "../src/cares/index.ts";
import { GoalsTaskCreateV1 } from "../src/goals/index.ts";
import { REASON_CODES } from "../src/shared/reason-codes.ts";
import { draftable } from "../src/shared/draftables.ts";
import { loadRegistry } from "../src/registry.ts";
import { PKG, loadSamples } from "./helpers.ts";

const reg = await loadRegistry();
const SAMPLES = await loadSamples();
const cares = reg.routes.filter((r) => /^\/(v1\/cares|v1\/cares-network|v1\/storefront\/cares|platform\/v1\/network-snapshots)/.test(r.path));
const openapi = JSON.parse(readFileSync(join(PKG, "generated", "openapi", "public.json"), "utf8"));
/** internal.json carries every component (public.json only those its operations reach — no events, proposals or pack). */
const allComponents = JSON.parse(readFileSync(join(PKG, "generated", "openapi", "internal.json"), "utf8")).components.schemas;

// ADR-015 §1.3, by hand (the names 0028 registers in command_authority).
const COMMANDS = [
  "cares.profile.set.v1", "cares.listing.publish.v1", "cares.listing.withdraw.v1", "cares.handover.record.v1", "cares.handover.void.v1",
  "cares.claim.create.v1", "cares.claim.cancel.v1", "cares.claim.close.v1", "cares.claim.decide.v1", "cares.claim.receive.v1",
];
// ADR-015 §1.3 "New ReasonCodes", by hand.
const CODES = [
  "cares_not_available", "cares_not_enabled", "cares_not_opted_in", "cares_city_mismatch",
  "recipient_ineligible", "listing_expired", "qty_exceeds_on_hand", "qty_exceeds_listed", "cooked_hold_exceeded", "line_expired", "no_eligible_recipient", "no_rostered_staff",
  "offer_not_enabled", "offer_closed", "claim_decided", "claim_received", "rate_limited",
  // Orchestrator ruling 2-B (fix cycle W1): an offer's hand-over is all-or-nothing and final.
  "handover_must_be_complete", "offer_handover_final",
];
const PUBLIC_PATHS = ["/v1/cares-network/cities", "/v1/cares-network/impact", "/v1/cares-network/listings", "/v1/cares-network/listings/{id}", "/v1/cares-network/snapshots/{id}"];

describe("Munim Cares contracts (ADR-015 §5)", () => {
  it("25 routes: 17 member, 5 public, 1 storefront, 2 operator", () => {
    expect(cares).toHaveLength(25);
    const by = (a: string) => cares.filter((r) => r.auth === a);
    expect([by("member").length, by("public").length, by("storefront").length, by("operator").length]).toEqual([17, 5, 1, 2]);
  });

  it("the member commands are exactly the ADR §1.3 list, one route each", () => {
    expect(cares.filter((r) => r.command).map((r) => r.command).sort()).toEqual([...COMMANDS].sort());
  });

  it("auth 'public' is exactly the five network paths, and only those routes have an empty OpenAPI security", () => {
    expect(cares.filter((r) => r.auth === "public").map((r) => r.path).sort()).toEqual(PUBLIC_PATHS);
    const open = Object.entries(openapi.paths as Record<string, Record<string, { security: unknown[] }>>).flatMap(([p, ops]) =>
      Object.values(ops).filter((o) => o.security.length === 0).map(() => p),
    );
    expect(open.sort()).toEqual(PUBLIC_PATHS);
    expect(reg.routes.filter((r) => r.auth === "public" && !PUBLIC_PATHS.includes(r.path))).toEqual([]);
  });

  it("the storefront Cares route is keyed (storefrontKey), not public", () => {
    const op = openapi.paths["/v1/storefront/cares"].get;
    expect(op.security).toEqual([{ storefrontKey: [] }, { storefrontKey: [], customerToken: [] }]);
  });

  it("the SDK ships a credential-free client and lists the public operations", () => {
    const client = readFileSync(join(PKG, "..", "sdk", "src", "gen", "client.ts"), "utf8");
    expect(client).toContain("export function createPublicClient");
    expect(client).toContain('"GET /v1/cares-network/listings/{id}"');
  });

  it("all 17 new reason codes exist, once", () => {
    for (const c of CODES) expect(REASON_CODES, c).toContain(c);
    expect(REASON_CODES.filter((c, i) => REASON_CODES.indexOf(c) !== i)).toEqual([]);
  });

  it("no schema carries a legal or compliance text field (founder answer 4)", () => {
    const names: string[] = [];
    const walk = (n: unknown) => {
      if (Array.isArray(n)) n.forEach(walk);
      else if (n && typeof n === "object") for (const [k, v] of Object.entries(n)) (k === "properties" ? names.push(...Object.keys(v as object)) : null, walk(v));
    };
    for (const [n, s] of Object.entries(allComponents)) if (/cares/i.test(n)) walk(s);
    walk(allComponents.CountryPack.properties.cares); // the rest of the pack has its own compliance calendar
    expect(names.length).toBeGreaterThan(100);
    expect(names).toContain("cooked_max_hold_min");
    expect(names.filter((k) => /legal|licen[cs]e|compliance|regulation|fssai|disclaimer/i.test(k))).toEqual([]);
  });
});

describe("cares.listing.publish.v1 draft (ADR-015 §4)", () => {
  const d = draftable("cares.listing.publish.v1")!;
  const sample = SAMPLES["cares.listing.publish.v1"] as { lines: Array<Record<string, unknown>> };
  const proposal = SAMPLES["proposal.cares.listing.publish.v1"] as { lines: Array<Record<string, unknown>> };

  it("accept: qty as a snapshot ref; refuse: a typed number", () => {
    expect(d.proposal.safeParse(proposal).success).toBe(true);
    expect(d.proposal.safeParse(sample).success).toBe(false);
    expect(d.proposal.safeParse({ ...proposal, lines: [{ ...proposal.lines[0], unit_price_minor: 4000 }] }).success).toBe(false);
  });
  it("the command itself still takes the owner's typed numbers", () => {
    expect(d.command.safeParse(sample).success).toBe(true);
    expect(d.command.safeParse({ ...sample, lines: [{ ...sample.lines[0], qty_milli: 0 }] }).success).toBe(false);
  });
});

describe("goals.task.create.v1 gains cares_listing_id (ADR-015 §5)", () => {
  const task = SAMPLES["goals.task.create.v1"] as Record<string, unknown>;
  const listing = "0199e0a0-0000-7000-8000-000000000514";
  it("accept: omitted → null (every older proposal), and a listing id", () => {
    expect(GoalsTaskCreateV1.parse(task).cares_listing_id).toBeNull();
    expect(GoalsTaskCreateV1.parse({ ...task, cares_listing_id: listing }).cares_listing_id).toBe(listing);
    const p = draftable("goals.task.create.v1")!.proposal;
    expect((p.parse(task) as Record<string, unknown>).cares_listing_id).toBeNull();
    expect((p.parse({ ...task, cares_listing_id: listing }) as Record<string, unknown>).cares_listing_id).toBe(listing);
  });
  it("refuse: a non-uuid listing id", () => {
    expect(GoalsTaskCreateV1.safeParse({ ...task, cares_listing_id: "x" }).success).toBe(false);
  });
});

describe("public shapes keep the simulated labels and the refs", () => {
  const listing = SAMPLES["v1.cares-network.listing"] as Record<string, unknown>;
  const impact = SAMPLES["v1.cares-network.impact"] as { rows: Array<Record<string, { value: unknown; ref: string }>> };
  it("a recipient on the public page is always simulated", () => {
    expect(CaresNetworkListing.safeParse(listing).success).toBe(true);
    expect(CaresNetworkListing.safeParse({ ...listing, recipient_simulated: false }).success).toBe(false);
  });
  it("every network impact value sits beside a snapshot ref; a bare value is refused", () => {
    expect(CaresNetworkImpactResponse.safeParse(impact).success).toBe(true);
    const bare = structuredClone(impact);
    (bare.rows[0] as Record<string, unknown>).donations = 4;
    expect(CaresNetworkImpactResponse.safeParse(bare).success).toBe(false);
    const cite = structuredClone(impact);
    cite.rows[0]!.donations!.ref = "4";
    expect(CaresNetworkImpactResponse.safeParse(cite).success).toBe(false);
  });
});
