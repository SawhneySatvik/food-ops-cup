// T-095a gates (ADR-015 §8) — Munim Cares member module through the real app, two businesses in one database. Every
// expected quantity is typed by hand from the fixture (recipe lines, stock received, the 20 kg offer), never computed by
// the code under test; each refusal is paired with an accept. Red-proofs: test/redproof-cares.sh (source plants, judged by
// the process exit code — gotcha 33). Synthetic data only; recipients are simulated.
import { CommandEnvelope, CommandResult } from "@munim/contracts";
import {
  CaresClaimsResponse, CaresInboundClaimsResponse, CaresListingResponse, CaresListingsResponse, CaresMarketResponse, CaresProfileResponse, CaresRecipientsResponse,
} from "@munim/contracts/cares";
import { SCHEMAS as EVENTS } from "@munim/contracts/events";
import { TasksResponse } from "@munim/contracts/goals";
import { snapRef } from "@munim/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CoreTx, executeCommand, verifyAuditChain } from "../src/commit/index.ts";
import { svcTx } from "../src/commit/testkit.ts";
import { ApiError } from "../src/lib/errors.ts";
import { runTemplate } from "../src/modules/approvals/snapshots.ts";
import { handlers } from "../src/modules/cares/index.ts";
import { dish, type Env, inDays, inMinutes, type Res, type Side, startCares, stocked, uuidv7 } from "./cares.kit.ts";
import { addTemplate } from "./compliance.kit.ts";

let e: Env;
let A: Side;
let B: Side;
let recipient: string;
/** A's onion (base kg, 50 kg at outlet 1); B's onion (base kg); B's loose onion in grams (base g: the wrong unit for a kg offer). */
let onionA: string;
let onionB: string;
let gramsB: string;
/** The pulao recipe: 120 g onion + 200 g rice (5% waste) per portion; 10 kg of each at A's outlet 1. */
let onionG: string;
let riceG: string;
let pulao: string;

const COMMANDS = ["cares.profile.set.v1", "cares.listing.publish.v1", "cares.listing.withdraw.v1", "cares.handover.record.v1", "cares.handover.void.v1",
  "cares.claim.create.v1", "cares.claim.cancel.v1", "cares.claim.close.v1", "cares.claim.decide.v1", "cares.claim.receive.v1"];
const REPLAYED = new Set<string>();
/** Test-side plants for redproof-cares.sh (gates the code under test cannot break: the guard stamps origin, the chain is the DB's). */
const PLANT = process.env.MUNIM_CARES_PLANT ?? "";
if (!["", "forged-origin", "audit-tamper"].includes(PLANT)) throw new Error(`MUNIM_CARES_PLANT: unknown plant ${PLANT}`);

beforeAll(async () => {
  e = await startCares();
  ({ A, B } = e);
  recipient = (await e.one<{ id: string }>(`SELECT id FROM platform.cares_recipient WHERE city_code = 'mumbai' ORDER BY id LIMIT 1`)).id;
  onionA = await stocked(A, "Onion", "kg", A.w.outlets[0], 50000);
  onionB = await stocked(B, "Onion", "kg", B.w.outlets[0], 1000);
  gramsB = await stocked(B, "Onion loose", "g", B.w.outlets[0], 1000);
  onionG = await stocked(A, "Onion (kitchen)", "g", A.w.outlets[0], 10_000_000);
  riceG = await stocked(A, "Rice", "g", A.w.outlets[0], 10_000_000);
  pulao = await dish(A, [{ ingredient_id: onionG, qty_milli: 120000, unit: "g", waste_pct_bp: 0 }, { ingredient_id: riceG, qty_milli: 200000, unit: "g", waste_pct_bp: 500 }]);
});
afterAll(() => e?.stop());

// ---- helpers -------------------------------------------------------------------------------------------------------
/** The command twice with one key: 200 both times, byte-identical bodies, the replay flagged (idempotent replay gate). */
async function twice(s: Side, path: string, who: Parameters<Side["call"]>[2], type: string, payload: Record<string, unknown>) {
  const body = { command_id: uuidv7(), idempotency_key: `k-${uuidv7()}`, type, payload };
  const r1 = await s.call("POST", path, who, body);
  const t1 = await r1.text();
  const r2 = await s.call("POST", path, who, body);
  const t2 = await r2.text();
  expect([r1.status, r2.status, t1]).toEqual([200, 200, t2]);
  expect([r1.headers.get("X-Munim-Replayed"), r2.headers.get("X-Munim-Replayed")]).toEqual([null, "true"]);
  REPLAYED.add(type);
  return CommandResult.parse(JSON.parse(t1));
}
async function refused(r: Res, status: number, code: string, reason: string | null = null) {
  const b = await r.json();
  expect([r.status, b.error?.code, b.error?.reason_code]).toEqual([status, code, reason]);
}
const listings = (id: string) => e.count(`SELECT count(*) n FROM core.cares_listing WHERE id = $1`, [id]);
const moves = (ref: string) => e.db.admin<{ ingredient_id: string; kind: string; qty: string }>(
  `SELECT ingredient_id, kind, qty_milli::text AS qty FROM core.stock_movement WHERE ref_id = $1 ORDER BY kind, ingredient_id`, [ref]).then((r) => r.rows);

const donation = (s: Side, over: Record<string, unknown> = {}, line: Record<string, unknown> = {}) => ({
  listing_id: uuidv7(), outlet_id: s.w.outlets[0], kind: "donation", recipient_id: recipient, pickup_from: inMinutes(60), pickup_to: inMinutes(180),
  lines: [{ line_id: uuidv7(), food_kind: "raw", item_id: null, ingredient_id: onionA, batch_id: null, qty_milli: 5000, unit: "kg", expires_on: inDays(6),
    unit_price_minor: null, currency: null, ...line }],
  ...over,
});
const cookedLine = (portions_milli: number) => ({ line_id: uuidv7(), food_kind: "cooked", item_id: pulao, ingredient_id: null, batch_id: null, qty_milli: portions_milli,
  unit: "portion", expires_on: null, unit_price_minor: null, currency: null });
const publish = (s: Side, who: Parameters<Side["call"]>[2], p: Record<string, unknown>) => s.cmd("/v1/cares/listings", who, "cares.listing.publish.v1", p);
const handover = (s: Side, who: Parameters<Side["call"]>[2], listing_id: string, lines: Array<[string, number]>, allocation_id: string | null = null) =>
  s.cmd("/v1/cares/handovers", who, "cares.handover.record.v1",
    { handover_id: uuidv7(), listing_id, allocation_id, lines: lines.map(([listing_line_id, qty_milli]) => ({ listing_line_id, qty_milli })) });

/** Operator config draft: propose, then approve (R24). Returns the applied draft. */
async function configDraft(target: string, patch: Record<string, unknown>) {
  const p = await e.operator("POST", "/platform/v1/config-drafts", { target, patch });
  expect(p.status).toBe(201);
  const d = await p.json();
  const a = await e.operator("POST", `/platform/v1/config-drafts/${d.id}:approve`, { reason: "synthetic test" });
  expect(a.status).toBe(200);
  const applied = await a.json();
  expect(applied.status).toBe("applied");
  return applied as { id: string };
}

// ---- setup: enablement, cities, recipients, profile ----------------------------------------------------------------
describe("setup through operator config drafts and the owner's profile command", () => {
  it("GET profile: available (pack v4 cares block), enabled (the world's approved draft), the 2 opted-in outlets, both labels and the note key", async () => {
    const r = await A.call("GET", "/v1/cares/profile", "owner");
    const body = CaresProfileResponse.parse(await r.json());
    expect([body.available, body.enabled, body.profile?.public_name, body.outlets.length]).toEqual([true, true, "Synthetic Kitchen", 2]);
    expect([body.labels.data, body.labels.recipients, body.note_key]).toEqual(["Measured on synthetic data", "to simulated recipients", "cares.note.check_local_rules"]);
    // An outlet manager sees only its own outlet's Cares row (RLS).
    expect(CaresProfileResponse.parse(await (await A.call("GET", "/v1/cares/profile", "mgr2")).json()).outlets.map((o) => o.outlet_id)).toEqual([A.w.outlets[1]]);
  });

  it("a recipient without '(simulated)' in its name is refused at propose (0 drafts); a simulated one in a new AU city is applied with simulated = true", async () => {
    const before = await e.count(`SELECT count(*) n FROM platform.config_draft`);
    const bad = await e.operator("POST", "/platform/v1/config-drafts", { target: `cares_recipient:${uuidv7()}`, patch: recipientPatch("melbourne", "Real Pantry") });
    await refused(bad, 422, "invalid_payload");
    expect(await e.count(`SELECT count(*) n FROM platform.config_draft`)).toBe(before);
    await configDraft("cares_city:melbourne", { country_code: "AU", name: "Melbourne", status: "active" });
    const id = uuidv7();
    await configDraft(`cares_recipient:${id}`, recipientPatch("melbourne", "Yarra Pantry (simulated)"));
    expect(await e.one(`SELECT city_code, simulated, status FROM platform.cares_recipient WHERE id = $1`, [id])).toEqual({ city_code: "melbourne", simulated: true, status: "active" });
  });

  it("profile.set: a city in another country → 422 cares_city_mismatch (nothing written); the business's own city → 200; a manager → 403", async () => {
    const outlets = (city: string) => [{ outlet_id: A.w.outlets[0], city_code: city, lat_e6: 19_076_000, lng_e6: 72_877_700, pickup_from: "10:00", pickup_to: "22:00", active: true }];
    const set = (city: string) => ({ status: "active", public_name: "Synthetic Kitchen", b2b_enabled: true, outlets: outlets(city) });
    await refused(await A.cmd("/v1/cares/profile", "owner", "cares.profile.set.v1", set("melbourne")), 422, "invalid_payload", "cares_city_mismatch");
    expect(await e.one(`SELECT city_code FROM core.cares_outlet WHERE outlet_id = $1`, [A.w.outlets[0]])).toEqual({ city_code: "mumbai" });
    await twice(A, "/v1/cares/profile", "owner", "cares.profile.set.v1", set("mumbai"));
    expect(await e.one(`SELECT to_char(pickup_to, 'HH24:MI') AS t FROM core.cares_outlet WHERE outlet_id = $1`, [A.w.outlets[0]])).toEqual({ t: "22:00" });
    await refused(await A.cmd("/v1/cares/profile", "mgr1", "cares.profile.set.v1", set("mumbai")), 403, "book_write_refused", "authority_denied");
    // The outlet row's audit entry carries the prior row as `before`: opt out, then back in (state restored).
    const off = { ...set("mumbai"), outlets: outlets("mumbai").map((o) => ({ ...o, active: false })) };
    expect((await A.cmd("/v1/cares/profile", "owner", "cares.profile.set.v1", off)).status).toBe(200);
    expect((await A.cmd("/v1/cares/profile", "owner", "cares.profile.set.v1", set("mumbai"))).status).toBe(200);
    const trail = (await e.db.admin(`SELECT before, after FROM core.audit_log WHERE tenant_id = $1 AND entity = 'core.cares_outlet' AND entity_id = $2 ORDER BY seq`,
      [A.w.tenant, A.w.outlets[0]])).rows.slice(-3);
    expect(trail).toEqual([
      { before: { city_code: "mumbai", active: true }, after: { city_code: "mumbai", active: true } },
      { before: { city_code: "mumbai", active: true }, after: { city_code: "mumbai", active: false } },
      { before: { city_code: "mumbai", active: false }, after: { city_code: "mumbai", active: true } },
    ]);
  });

  it("not enabled: the operator's approved draft turns Cares off → publish 409 cares_not_enabled, 0 listings; a second draft turns it on → 200", async () => {
    const off = await configDraft(`cares_enablement:${A.w.tenant}`, { enabled: false });
    expect(await e.one(`SELECT enabled, config_draft_id FROM platform.cares_enablement WHERE tenant_id = $1`, [A.w.tenant])).toEqual({ enabled: false, config_draft_id: off.id });
    expect(CaresProfileResponse.parse(await (await A.call("GET", "/v1/cares/profile", "owner")).json()).enabled).toBe(false);
    const p = donation(A);
    await refused(await publish(A, "owner", p), 409, "conflict", "cares_not_enabled");
    expect(await listings(p.listing_id)).toBe(0);
    await configDraft(`cares_enablement:${A.w.tenant}`, { enabled: true });
    expect((await publish(A, "owner", p)).status).toBe(200);
    expect(await listings(p.listing_id)).toBe(1);
  });
});

function recipientPatch(city: string, name: string) {
  return { city_code: city, name, kind: "ngo", accepts_cooked: true, accepts_raw: true, accepts_packaged: true, capacity_kg_per_day: 100,
    capacity_portions_per_day: 200, receiving_from: "09:00", receiving_to: "21:00", lat_e6: -37_813_600, lng_e6: 144_963_100, status: "active" };
}

// ---- publish (own command and approved draft) ----------------------------------------------------------------------
describe("publish", () => {
  it("own command: one listing published by the owner, pickup_on set by core, an ids-only published event; replay is byte-identical", async () => {
    const p = donation(A);
    const res = await twice(A, "/v1/cares/listings", "owner", "cares.listing.publish.v1", p);
    expect(res.entity_id).toBe(p.listing_id);
    const row = await e.one(`SELECT l.status, l.published_by, l.origin->>'kind' AS origin, l.pickup_on = ((l.pickup_from AT TIME ZONE o.tz) - o.business_day_cutoff)::date AS ok
                               FROM core.cares_listing l JOIN core.outlet o ON o.tenant_id = l.tenant_id AND o.id = l.outlet_id WHERE l.id = $1`, [p.listing_id]);
    expect(row).toEqual({ status: "published", published_by: A.w.owner, origin: "command", ok: true });
    const ev = await e.one<{ payload: any }>(`SELECT payload FROM core.outbox WHERE aggregateid = $1 AND type = 'munim.cares.listing.published.v1'`, [p.listing_id]);
    expect(EVENTS["munim.cares.listing.published.v1"].omit({ munimrun: true }).parse(ev.payload).data).toEqual({ listing_id: p.listing_id, outlet_id: A.w.outlets[0], kind: "donation" });
    const one = CaresListingResponse.parse(await (await A.call("GET", `/v1/cares/listings/${p.listing_id}`, "owner")).json());
    expect([one.lines[0]!.qty_milli, one.lines[0]!.unit, one.labels.recipients]).toEqual([5000, "kg", "to simulated recipients"]);
  });

  it("final-payload refusals, each beside an accepted twin: on-hand, a past pickup, a recipient in another city, an expiry before pickup + 1 day, a non-base unit, staff", async () => {
    const other = (await e.one<{ id: string }>(`SELECT id FROM platform.cares_recipient WHERE city_code = 'melbourne' LIMIT 1`)).id;
    const cases: Array<[Record<string, unknown>, number, string, string | null]> = [
      [donation(A, {}, { qty_milli: 60000 }), 409, "conflict", "qty_exceeds_on_hand"],
      [donation(A, { pickup_from: inMinutes(-180), pickup_to: inMinutes(-60) }), 422, "invalid_payload", "listing_expired"],
      [donation(A, { recipient_id: other }), 422, "invalid_payload", "recipient_ineligible"],
      [donation(A, {}, { expires_on: inDays(0) }), 422, "invalid_payload", "line_expired"],
      [donation(A, {}, { qty_milli: 5_000_000, unit: "g" }), 400, "bad_request", "unit_mismatch"],
    ];
    for (const [p, status, code, reason] of cases) {
      await refused(await publish(A, "owner", p), status, code, reason);
      expect(await listings(p.listing_id as string)).toBe(0);
    }
    await refused(await publish(A, "staff", donation(A)), 403, "book_write_refused", "authority_denied");
    await refused(await publish(A, "mgr1", donation(A)), 403, "book_write_refused", "authority_denied");
    const twin = donation(A, {}, { qty_milli: 50000, expires_on: inDays(3) });
    expect((await publish(A, "owner", twin)).status).toBe(200);
  });

  it("an approved intel draft creates exactly 1 listing, published_by = the approver; a manager's approval → 403 (DB: MB006) and 0 listings", async () => {
    await addTemplate(e.db, "test.cares_qty", `SELECT 4000::bigint AS qty FROM core.tenant WHERE tenant_id = current_setting('app.tenant_id')::uuid`,
      [{ name: "qty", type: "integer", numeric_source: "core.stock_movement.qty_milli" }]);
    const snap = await mint(A, "test.cares_qty");
    const p = donation(A, {}, { qty_milli: snapRef(snap, 0, "qty") });
    const d = await draft(A, "cares.listing.publish.v1", p, [A.w.outlets[0]]);
    expect(await listings(p.listing_id)).toBe(0);
    await refused(await approve(A, "mgr1", d), 403, "forbidden", "authority_denied");
    expect(await listings(p.listing_id)).toBe(0);
    // The database's own half: the manager's decision row is refused whatever the API does.
    const mb006 = await e.db.withContext("munim_core", { tenant_id: A.w.tenant, outlet_ids: [A.w.outlets[0]], role: "manager", member_id: A.ids.mgr1 }, (c) =>
      c.query(`INSERT INTO core.decision (tenant_id, id, draft_id, verdict, final_payload, decided_by) VALUES ($1, $2, $3, 'approved', '{}', $4)`,
        [A.w.tenant, uuidv7(), d, A.ids.mgr1])).then(() => "inserted", (err: { code?: string }) => err.code);
    expect(mb006).toBe("MB006");
    const ok = await approve(A, "owner", d);
    expect(ok.status).toBe(200);
    expect(await listings(p.listing_id)).toBe(1);
    const row = await e.one<{ published_by: string; origin: { kind: string; decision_id: string }; qty: string }>(
      `SELECT l.published_by, l.origin, ll.qty_milli::text AS qty FROM core.cares_listing l JOIN core.cares_listing_line ll ON ll.listing_id = l.id WHERE l.id = $1`, [p.listing_id]);
    expect([row.published_by, row.origin.kind, row.qty]).toEqual([A.w.owner, "decision", "4000"]);
    expect((await e.one(`SELECT decided_by FROM core.decision WHERE id = $1`, [row.origin.decision_id])).decided_by).toBe(A.w.owner);
  });

  it("a cooked line through an approved draft: the database refuses it (cooked food only by the owner's own command) → draft failed, 0 listings", async () => {
    const snap = await mint(A, "test.cares_qty");
    const p = donation(A, { lines: [{ ...cookedLine(0), qty_milli: snapRef(snap, 0, "qty") }] });
    const d = await draft(A, "cares.listing.publish.v1", p, [A.w.outlets[0]]);
    await refused(await approve(A, "owner", d), 422, "execution_failed");
    expect(await e.one(`SELECT status, failure_reason FROM core.draft WHERE id = $1`, [d])).toEqual({ status: "failed", failure_reason: "sqlstate_mb004" });
    expect(await listings(p.listing_id)).toBe(0);
  });

  it("withdraw: a manager withdraws a published listing (ids-only closed event); a second withdraw → 409 illegal_transition", async () => {
    const p = donation(A);
    expect((await publish(A, "owner", p)).status).toBe(200);
    await twice(A, `/v1/cares/listings/${p.listing_id}:withdraw`, "mgr1", "cares.listing.withdraw.v1", { listing_id: p.listing_id });
    expect(await e.one(`SELECT status FROM core.cares_listing WHERE id = $1`, [p.listing_id])).toEqual({ status: "withdrawn" });
    expect((await e.one<{ payload: any }>(`SELECT payload FROM core.outbox WHERE aggregateid = $1 AND type = 'munim.cares.listing.closed.v1'`, [p.listing_id])).payload.data.status).toBe("withdrawn");
    await refused(await A.cmd(`/v1/cares/listings/${p.listing_id}:withdraw`, "mgr1", "cares.listing.withdraw.v1", { listing_id: p.listing_id }), 409, "illegal_transition");
    await refused(await A.cmd(`/v1/cares/listings/${uuidv7()}:withdraw`, "mgr1", "cares.listing.withdraw.v1", { listing_id: p.listing_id }), 422, "invalid_payload");
  });
});

// ---- hand-overs ----------------------------------------------------------------------------------------------------
describe("hand-overs", () => {
  it("6 cooked portions: exactly the recipe's 2 ingredient rows × 6 (onion −720 g, rice −1260 g with 5% waste); the void brings Σ back to 0", async () => {
    const line = cookedLine(6000);
    const p = donation(A, { lines: [line] });
    expect((await publish(A, "owner", p)).status).toBe(200);
    // Staff of the listing's outlet hand it over.
    const h = await twice(A, "/v1/cares/handovers", "staff", "cares.handover.record.v1",
      { handover_id: uuidv7(), listing_id: p.listing_id, allocation_id: null, lines: [{ listing_line_id: line.line_id, qty_milli: 6000 }] });
    expect(await moves(h.entity_id)).toEqual([
      { ingredient_id: onionG, kind: "donation", qty: "-720000" },
      { ingredient_id: riceG, kind: "donation", qty: "-1260000" },
    ].sort((a, b) => (a.ingredient_id < b.ingredient_id ? -1 : 1)));
    expect(await e.one(`SELECT status FROM core.cares_listing WHERE id = $1`, [p.listing_id])).toEqual({ status: "closed" });
    expect(await e.one(`SELECT origin->>'rule_id' AS rule FROM core.stock_movement WHERE ref_id = $1 LIMIT 1`, [h.entity_id])).toEqual({ rule: "inventory.cares_handover" });
    // Only owner / judge void (staff → 403); the owner's void returns the stock.
    await refused(await A.cmd(`/v1/cares/handovers/${h.entity_id}:void`, "staff", "cares.handover.void.v1", { handover_id: h.entity_id, reason_code: "spoiled" }),
      403, "book_write_refused", "authority_denied");
    await twice(A, `/v1/cares/handovers/${h.entity_id}:void`, "owner", "cares.handover.void.v1", { handover_id: h.entity_id, reason_code: "recipient_absent" });
    const sums = (await e.db.admin(`SELECT ingredient_id, sum(qty_milli)::text AS s, count(*) FILTER (WHERE kind = 'cares_reversal')::int AS rev FROM core.stock_movement
                                    WHERE ref_id = $1 GROUP BY ingredient_id ORDER BY ingredient_id`, [h.entity_id])).rows;
    expect(sums.map((r) => [r.s, r.rev])).toEqual([["0", 1], ["0", 1]]);
    await refused(await A.cmd(`/v1/cares/handovers/${h.entity_id}:void`, "owner", "cares.handover.void.v1", { handover_id: h.entity_id, reason_code: "again" }), 409, "illegal_transition");
  });

  it("Σ per line ≤ the listed qty: 6 of 5 kg → 409 qty_exceeds_listed; 3 kg, then 3 kg again → 409; 2 kg completes and closes the listing", async () => {
    const p = donation(A);
    const lineId = (p.lines[0] as { line_id: string }).line_id;
    expect((await publish(A, "owner", p)).status).toBe(200);
    await refused(await handover(A, "owner", p.listing_id, [[lineId, 6000]]), 409, "conflict", "qty_exceeds_listed");
    expect((await handover(A, "staff", p.listing_id, [[lineId, 3000]])).status).toBe(200);
    expect(await e.one(`SELECT status FROM core.cares_listing WHERE id = $1`, [p.listing_id])).toEqual({ status: "published" });
    await refused(await handover(A, "staff", p.listing_id, [[lineId, 3000]]), 409, "conflict", "qty_exceeds_listed");
    expect((await handover(A, "staff", p.listing_id, [[lineId, 2000]])).status).toBe(200);
    expect(await e.one(`SELECT status FROM core.cares_listing WHERE id = $1`, [p.listing_id])).toEqual({ status: "closed" });
    expect(await e.one(`SELECT sum(m.qty_milli)::text AS s FROM core.stock_movement m JOIN core.cares_handover h ON h.id = m.ref_id WHERE h.listing_id = $1`, [p.listing_id]))
      .toEqual({ s: "-5000" });
    await refused(await handover(A, "staff", p.listing_id, [[lineId, 1]]), 409, "illegal_transition");
  });

  it("staff of another outlet: hand-over of an outlet-2 listing → 404, nothing written", async () => {
    const onion2 = await stocked(A, "Onion (outlet 2)", "kg", A.w.outlets[1], 5000);
    const p = donation(A, { outlet_id: A.w.outlets[1] }, { ingredient_id: onion2, qty_milli: 1 });
    expect((await publish(A, "owner", p)).status).toBe(200);
    const r = await handover(A, "staff", p.listing_id, [[(p.lines[0] as { line_id: string }).line_id, 1]]);
    await refused(r, 404, "not_found");
    expect(await e.count(`SELECT count(*) n FROM core.cares_handover WHERE listing_id = $1`, [p.listing_id])).toBe(0);
  });
});

// ---- B2B shared surplus offers (record only) -----------------------------------------------------------------------
describe("B2B: a 20 kg onion offer from A, claimed by B", () => {
  const offer = { listing_id: uuidv7(), line: uuidv7() };
  const claim1 = uuidv7();
  const claim2 = uuidv7();
  let allocation = "";
  let handoverId = "";

  it("A offers 20 kg at 3000 a kg; B's market lists it (Recorded, never processed); B claims all of it from outlet 1 and outlet 2", async () => {
    await twice(A, "/v1/cares/listings", "owner", "cares.listing.publish.v1", {
      listing_id: offer.listing_id, outlet_id: A.w.outlets[0], kind: "offer", recipient_id: null, pickup_from: inMinutes(60), pickup_to: inMinutes(240),
      lines: [{ line_id: offer.line, food_kind: "raw", item_id: null, ingredient_id: onionA, batch_id: null, qty_milli: 20000, unit: "kg", expires_on: inDays(6),
        unit_price_minor: 3000, currency: "INR" }],
    });
    const market = CaresMarketResponse.parse(await (await B.call("GET", `/v1/cares/market?listing=${offer.listing_id}`, "owner")).json());
    expect(market.items.map((o) => [o.offer_tenant_id, o.lines[0]!.qty_milli, o.lines[0]!.unit_price_minor])).toEqual([[A.w.tenant, 20000, 3000]]);
    expect(market.money_label).toBe("Recorded, never processed");
    const claim = (id: string, outlet: string, ingredient: string) =>
      ({ claim_id: id, outlet_id: outlet, offer_tenant_id: A.w.tenant, offer_listing_id: offer.listing_id, lines: [{ offer_line_id: offer.line, ingredient_id: ingredient }] });
    // The buyer's ingredient must be in the offer line's unit (stock moves in base units): a gram-based one → 400.
    await refused(await B.cmd("/v1/cares/claims", "owner", "cares.claim.create.v1", claim(uuidv7(), B.w.outlets[0], gramsB)), 400, "bad_request", "unit_mismatch");
    await twice(B, "/v1/cares/claims", "owner", "cares.claim.create.v1", claim(claim1, B.w.outlets[0], onionB));
    expect((await B.cmd("/v1/cares/claims", "mgr2", "cares.claim.create.v1", claim(claim2, B.w.outlets[1], onionB))).status).toBe(200);
    // total re-derived by core: 20 kg × 3000 = 60000 (hand-typed).
    expect(await e.one(`SELECT total_minor::text AS t, currency, status FROM core.cares_claim WHERE id = $1`, [claim1])).toEqual({ t: "60000", currency: "INR", status: "requested" });
    const inbound = CaresInboundClaimsResponse.parse(await (await A.call("GET", `/v1/cares/listings/${offer.listing_id}/claims`, "owner")).json());
    expect(inbound.items.map((c) => [c.claim_id, c.status]).sort()).toEqual([[claim1, "requested"], [claim2, "requested"]].sort());
  });

  it("two concurrent accepts: exactly 1 accepted and 1 offer_closed (the listing row is locked first)", async () => {
    const ctx = { tenant_id: A.w.tenant, outlet_ids: "*" as const, role: "owner", member_id: A.w.owner };
    const actor = { kind: "member" as const, id: A.w.owner, role: "owner" };
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const holding = new Promise<void>((r) => (held = r));
    const slow: CoreTx = (fn) => e.db.withContext("munim_core", ctx, async (c) => {
      const out = await fn(c);
      held();
      await gate;
      return out;
    });
    const fast: CoreTx = (fn) => e.db.withContext("munim_core", ctx, fn);
    const decide = (claim: string, allocation_id: string) => CommandEnvelope.parse({ command_id: uuidv7(), idempotency_key: `k-${uuidv7()}`, type: "cares.claim.decide.v1",
      payload: { allocation_id, listing_id: offer.listing_id, claim_tenant_id: B.w.tenant, claim_id: claim, verdict: "accepted" } });
    allocation = uuidv7();
    const first = executeCommand({ tx: slow, tenantId: A.w.tenant, actor }, decide(claim1, allocation), handlers.claimDecide);
    await holding;
    const second = executeCommand({ tx: fast, tenantId: A.w.tenant, actor }, decide(claim2, uuidv7()), handlers.claimDecide).then(() => "accepted", (err) => err);
    await new Promise((r) => setTimeout(r, 300));
    release();
    await first;
    const lost = await second;
    expect([lost instanceof ApiError, (lost as ApiError).code, (lost as ApiError).reason_code]).toEqual([true, "conflict", "offer_closed"]);
    expect(await e.db.admin(`SELECT verdict, count(*)::int AS n FROM core.cares_allocation WHERE listing_id = $1 GROUP BY verdict`, [offer.listing_id]).then((r) => r.rows))
      .toEqual([{ verdict: "accepted", n: 1 }]);
    expect(await e.one(`SELECT status FROM core.cares_listing WHERE id = $1`, [offer.listing_id])).toEqual({ status: "allocated" });
  });

  it("decide over HTTP: a replayed decline of a fresh claim is byte-identical; the accepted claim cannot be decided twice (claim_decided)", async () => {
    // Allocated, the offer has left B's market: a new claim on it → offer_closed.
    await refused(await B.cmd("/v1/cares/claims", "owner", "cares.claim.create.v1",
      { claim_id: uuidv7(), outlet_id: B.w.outlets[0], offer_tenant_id: A.w.tenant, offer_listing_id: offer.listing_id, lines: [{ offer_line_id: offer.line, ingredient_id: onionB }] }),
      409, "conflict", "offer_closed");
    const decline = { allocation_id: uuidv7(), listing_id: offer.listing_id, claim_tenant_id: B.w.tenant, claim_id: claim2, verdict: "declined" };
    await refused(await A.cmd(`/v1/cares/listings/${offer.listing_id}:decide`, "owner", "cares.claim.decide.v1", { ...decline, verdict: "accepted" }), 409, "conflict", "offer_closed");
    await twice(A, `/v1/cares/listings/${offer.listing_id}:decide`, "owner", "cares.claim.decide.v1", decline);
    await refused(await A.cmd(`/v1/cares/listings/${offer.listing_id}:decide`, "owner", "cares.claim.decide.v1", { ...decline, allocation_id: uuidv7(), claim_id: claim1 }),
      409, "conflict", "claim_decided");
  });

  it("buyer side: cancel after accept → claim_decided; close after decline → 200; receive before the hand-over → refused", async () => {
    await refused(await B.cmd(`/v1/cares/claims/${claim1}:cancel`, "owner", "cares.claim.cancel.v1", { claim_id: claim1 }), 409, "conflict", "claim_decided");
    await refused(await B.cmd(`/v1/cares/claims/${claim1}:close`, "owner", "cares.claim.close.v1", { claim_id: claim1 }), 409, "conflict", "claim_decided");
    await twice(B, `/v1/cares/claims/${claim2}:close`, "mgr2", "cares.claim.close.v1", { claim_id: claim2 });
    expect(await e.one(`SELECT status FROM core.cares_claim WHERE id = $1`, [claim2])).toEqual({ status: "closed" });
    await refused(await B.cmd(`/v1/cares/claims/${claim1}:receive`, "staff", "cares.claim.receive.v1", { claim_id: claim1 }), 409, "illegal_transition");
    const mine = CaresClaimsResponse.parse(await (await B.call("GET", "/v1/cares/claims", "owner")).json());
    expect(mine.items.filter((c) => c.claim_id === claim1).map((c) => [c.outcome.verdict, c.outcome.allocation_id])).toEqual([["accepted", allocation]]);
  });

  it("A's staff hand over 20 kg (Σ surplus_out = −20000); B's staff receive it (Σ surplus_in = +20000); then A's void → offer_handover_final", async () => {
    // Staff outside the claim's outlet: B's outlet-1 staff cannot receive an outlet-2 claim (404).
    await refused(await B.cmd(`/v1/cares/claims/${claim2}:receive`, "staff", "cares.claim.receive.v1", { claim_id: claim2 }), 404, "not_found");
    // Ruling 2-B: an offer's hand-over is all-or-nothing — 10 of the accepted 20 kg → 409 handover_must_be_complete, nothing written.
    await refused(await A.cmd("/v1/cares/handovers", "staff", "cares.handover.record.v1",
      { handover_id: uuidv7(), listing_id: offer.listing_id, allocation_id: allocation, lines: [{ listing_line_id: offer.line, qty_milli: 10000 }] }),
      409, "conflict", "handover_must_be_complete");
    expect(await e.count(`SELECT count(*) n FROM core.cares_handover WHERE listing_id = $1`, [offer.listing_id])).toBe(0);
    const h = await twice(A, "/v1/cares/handovers", "staff", "cares.handover.record.v1",
      { handover_id: uuidv7(), listing_id: offer.listing_id, allocation_id: allocation, lines: [{ listing_line_id: offer.line, qty_milli: 20000 }] });
    handoverId = h.entity_id;
    expect(await e.one(`SELECT sum(qty_milli)::text AS s FROM core.stock_movement WHERE tenant_id = $1 AND kind = 'surplus_out'`, [A.w.tenant])).toEqual({ s: "-20000" });
    expect(await e.one(`SELECT status FROM core.cares_listing WHERE id = $1`, [offer.listing_id])).toEqual({ status: "closed" });
    await twice(B, `/v1/cares/claims/${claim1}:receive`, "staff", "cares.claim.receive.v1", { claim_id: claim1 });
    expect(await e.one(`SELECT sum(qty_milli)::text AS s FROM core.stock_movement WHERE tenant_id = $1 AND kind = 'surplus_in'`, [B.w.tenant])).toEqual({ s: "20000" });
    expect(await e.one(`SELECT c.status, c.allocation_id, l.received_qty_milli::text AS got FROM core.cares_claim c JOIN core.cares_claim_line l ON l.claim_id = c.id WHERE c.id = $1`, [claim1]))
      .toEqual({ status: "received", allocation_id: allocation, got: "20000" });
    await refused(await A.cmd(`/v1/cares/handovers/${handoverId}:void`, "owner", "cares.handover.void.v1", { handover_id: handoverId, reason_code: "late" }), 409, "conflict", "offer_handover_final");
  });

  it("cancel before any verdict → 200 (a second offer)", async () => {
    const o = { listing_id: uuidv7(), line: uuidv7() };
    expect((await publish(A, "owner", { listing_id: o.listing_id, outlet_id: A.w.outlets[0], kind: "offer", recipient_id: null, pickup_from: inMinutes(60), pickup_to: inMinutes(240),
      lines: [{ line_id: o.line, food_kind: "raw", item_id: null, ingredient_id: onionA, batch_id: null, qty_milli: 1000, unit: "kg", expires_on: inDays(6), unit_price_minor: 2500, currency: "INR" }] })).status).toBe(200);
    const id = uuidv7();
    expect((await B.cmd("/v1/cares/claims", "owner", "cares.claim.create.v1",
      { claim_id: id, outlet_id: B.w.outlets[0], offer_tenant_id: A.w.tenant, offer_listing_id: o.listing_id, lines: [{ offer_line_id: o.line, ingredient_id: onionB }] })).status).toBe(200);
    await twice(B, `/v1/cares/claims/${id}:cancel`, "owner", "cares.claim.cancel.v1", { claim_id: id });
    expect(await e.one(`SELECT status FROM core.cares_claim WHERE id = $1`, [id])).toEqual({ status: "cancelled" });
  });
});

// ---- the claim lock, named batches and tracked receipts ------------------------------------------------------------
describe("B2B: a final offer hand-over, named batches, tracked receipts", () => {
  /** A 1-line offer from A's outlet 1, claimed by B's outlet 1 with `ingredient`, accepted and handed over in full. */
  async function handedOffer(kg: number, ingredient: string) {
    const o = { listing_id: uuidv7(), line: uuidv7(), claim: uuidv7(), allocation: uuidv7(), handover: uuidv7() };
    expect((await publish(A, "owner", { listing_id: o.listing_id, outlet_id: A.w.outlets[0], kind: "offer", recipient_id: null, pickup_from: inMinutes(60), pickup_to: inMinutes(240),
      lines: [{ line_id: o.line, food_kind: "raw", item_id: null, ingredient_id: onionA, batch_id: null, qty_milli: kg * 1000, unit: "kg", expires_on: inDays(7),
        unit_price_minor: 2000, currency: "INR" }] })).status).toBe(200);
    expect((await B.cmd("/v1/cares/claims", "owner", "cares.claim.create.v1",
      { claim_id: o.claim, outlet_id: B.w.outlets[0], offer_tenant_id: A.w.tenant, offer_listing_id: o.listing_id, lines: [{ offer_line_id: o.line, ingredient_id: ingredient }] })).status).toBe(200);
    expect((await A.cmd(`/v1/cares/listings/${o.listing_id}:decide`, "owner", "cares.claim.decide.v1",
      { allocation_id: o.allocation, listing_id: o.listing_id, claim_tenant_id: B.w.tenant, claim_id: o.claim, verdict: "accepted" })).status).toBe(200);
    expect((await A.cmd("/v1/cares/handovers", "owner", "cares.handover.record.v1",
      { handover_id: o.handover, listing_id: o.listing_id, allocation_id: o.allocation, lines: [{ listing_line_id: o.line, qty_milli: kg * 1000 }] })).status).toBe(200);
    return o;
  }

  it("an offer's hand-over is final: the owner's void before the buyer receives → 409 offer_handover_final; the stock stays out, then comes in", async () => {
    const o = await handedOffer(1, onionB);
    await refused(await A.cmd(`/v1/cares/handovers/${o.handover}:void`, "owner", "cares.handover.void.v1", { handover_id: o.handover, reason_code: "late" }),
      409, "conflict", "offer_handover_final");
    expect(await e.one(`SELECT status FROM core.cares_handover WHERE id = $1`, [o.handover])).toEqual({ status: "recorded" });
    expect((await B.cmd(`/v1/cares/claims/${o.claim}:receive`, "staff", "cares.claim.receive.v1", { claim_id: o.claim })).status).toBe(200);
    expect([(await moves(o.handover)).map((m) => m.qty), (await moves(o.claim)).map((m) => m.qty)]).toEqual([["-1000"], ["1000"]]);
  });

  it("a donation line naming a batch draws that batch (not the FEFO-first one); a batchless line of the same ingredient draws FEFO; l → ml exactly", async () => {
    const milk = uuidv7();
    const [early, late] = [uuidv7(), uuidv7()];
    await A.asOwner("inventory.ingredient.upsert.v1", (c) =>
      c.query(`INSERT INTO core.ingredient (tenant_id, id, name, base_unit, tracked_by_batch) VALUES ($1, $2, 'Milk', 'ml', true)`, [A.w.tenant, milk]));
    await A.asOwner("inventory.stock.receive.v1", async (c) => {
      for (const [b, days] of [[early, 5], [late, 8]] as const) {
        await c.query(`INSERT INTO core.batch (tenant_id, id, outlet_id, ingredient_id, batch_code, expires_on) VALUES ($1, $2, $3, $4, $5, $6)`,
          [A.w.tenant, b, A.w.outlets[0], milk, `M-${days}`, inDays(days)]);
        await c.query(`INSERT INTO core.stock_movement (tenant_id, id, outlet_id, ingredient_id, batch_id, qty_milli, unit, kind) VALUES ($1, $2, $3, $4, $5, 10000000, 'ml', 'receipt')`,
          [A.w.tenant, uuidv7(), A.w.outlets[0], milk, b]);
      }
    });
    const named = { line_id: uuidv7(), food_kind: "packaged", item_id: null, ingredient_id: milk, batch_id: late, qty_milli: 2000, unit: "l", expires_on: inDays(8),
      unit_price_minor: null, currency: null };
    const loose = { ...named, line_id: uuidv7(), batch_id: null, qty_milli: 1000, expires_on: inDays(5) };
    const p = donation(A, { lines: [named, loose] });
    expect((await publish(A, "owner", p)).status).toBe(200);
    const r = await handover(A, "owner", p.listing_id, [[named.line_id, 2000], [loose.line_id, 1000]]);
    expect(r.status).toBe(200);
    const h = CommandResult.parse(await r.json()).entity_id;
    const got = (await e.db.admin(`SELECT batch_id, qty_milli::text AS q, unit FROM core.stock_movement WHERE ref_id = $1 ORDER BY qty_milli`, [h])).rows;
    expect(got).toEqual([{ batch_id: late, q: "-2000000", unit: "ml" }, { batch_id: early, q: "-1000000", unit: "ml" }]);
  });

  it("a batch-tracked buyer ingredient receives into one new batch: code cares-<claim line>, the offer line's expiry, surplus_in on it", async () => {
    const batched = uuidv7();
    await B.asOwner("inventory.ingredient.upsert.v1", (c) =>
      c.query(`INSERT INTO core.ingredient (tenant_id, id, name, base_unit, tracked_by_batch) VALUES ($1, $2, 'Onion (batched)', 'kg', true)`, [B.w.tenant, batched]));
    const o = await handedOffer(2, batched);
    expect((await B.cmd(`/v1/cares/claims/${o.claim}:receive`, "staff", "cares.claim.receive.v1", { claim_id: o.claim })).status).toBe(200);
    const line = (await e.one<{ id: string }>(`SELECT id FROM core.cares_claim_line WHERE claim_id = $1`, [o.claim])).id;
    const batch = await e.db.admin(`SELECT b.id, b.outlet_id, b.batch_code, b.expires_on::text AS exp, b.mrp_minor, b.supplier_id, b.origin->>'rule_id' AS rule
                                      FROM core.batch b WHERE b.tenant_id = $1 AND b.ingredient_id = $2`, [B.w.tenant, batched]);
    expect(batch.rows.map(({ id: _id, ...rest }) => rest)).toEqual([
      { outlet_id: B.w.outlets[0], batch_code: `cares-${line}`, exp: inDays(7), mrp_minor: null, supplier_id: null, rule: "inventory.cares_claim_receive" },
    ]);
    expect((await e.db.admin(`SELECT batch_id, qty_milli::text AS q, kind FROM core.stock_movement WHERE ref_id = $1`, [o.claim])).rows)
      .toEqual([{ batch_id: batch.rows[0]!.id, q: "2000", kind: "surplus_in" }]);
  });
});

// ---- reads, tasks, kill switch, and the guarantee ------------------------------------------------------------------
describe("reads, tasks and the AI kill switch", () => {
  it("recipients and listings parse with both labels; a manager's out-of-scope outlet filter → 404", async () => {
    const r = CaresRecipientsResponse.parse(await (await A.call("GET", `/v1/cares/recipients?outlet=${A.w.outlets[0]}`, "owner")).json());
    expect(r.items.length).toBeGreaterThanOrEqual(2);
    expect(r.items.every((x) => x.name.includes("(simulated)") && x.simulated === true && x.city_code === "mumbai")).toBe(true);
    const l = CaresListingsResponse.parse(await (await A.call("GET", `/v1/cares/listings?outlet=${A.w.outlets[0]}&kind=offer&limit=200`, "owner")).json());
    expect(l.items.some((x) => x.status === "closed" && x.handovers.length === 1)).toBe(true);
    expect([l.labels.data, l.note_key]).toEqual(["Measured on synthetic data", "cares.note.check_local_rules"]);
    expect((await A.call("GET", `/v1/cares/listings?outlet=${A.w.outlets[1]}`, "mgr1")).status).toBe(404);
    expect((await A.call("DELETE", "/v1/cares/listings", "owner")).status).toBe(405);
  });

  it("a pack-and-hand-over task names its listing (TaskView.cares_listing_id); another outlet's listing → 404", async () => {
    const p = donation(A);
    expect((await publish(A, "owner", p)).status).toBe(200);
    const t = { task_id: uuidv7(), outlet_id: A.w.outlets[0], title_key: "cares.task.pack_and_hand_over", assignee_member_id: A.w.staff, due_on: inDays(0), finding_id: null,
      cares_listing_id: p.listing_id };
    expect((await A.cmd("/v1/tasks", "owner", "goals.task.create.v1", t)).status).toBe(200);
    const tasks = TasksResponse.parse(await (await A.call("GET", `/v1/tasks?outlet=${A.w.outlets[0]}`, "owner")).json());
    expect(tasks.items.find((x) => x.id === t.task_id)?.cares_listing_id).toBe(p.listing_id);
    await refused(await A.cmd("/v1/tasks", "owner", "goals.task.create.v1", { ...t, task_id: uuidv7(), outlet_id: A.w.outlets[1] }), 404, "not_found");
  });

  it("with intel.enabled = false every Cares route still answers", async () => {
    await e.db.admin(`UPDATE platform.feature_flag SET value = 'false' WHERE key = 'intel.enabled'`);
    try {
      const listing = (await e.one<{ id: string }>(`SELECT id FROM core.cares_listing WHERE tenant_id = $1 AND kind = 'offer' ORDER BY id LIMIT 1`, [A.w.tenant])).id;
      for (const path of ["/v1/cares/profile", `/v1/cares/recipients?outlet=${A.w.outlets[0]}`, "/v1/cares/listings", `/v1/cares/listings/${listing}`,
        `/v1/cares/listings/${listing}/claims`, "/v1/cares/market", "/v1/cares/claims"]) {
        expect([path, (await A.call("GET", path, "owner")).status]).toEqual([path, 200]);
      }
      expect((await publish(A, "owner", donation(A))).status).toBe(200);
    } finally {
      await e.db.admin(`UPDATE platform.feature_flag SET value = 'true' WHERE key = 'intel.enabled'`);
    }
  });
});

describe("the guarantee", () => {
  it("every Cares command was replayed byte-identically (10 of 10)", () => {
    expect([...REPLAYED].sort()).toEqual([...COMMANDS].sort());
  });

  it("audit chains verify for both businesses", async () => {
    for (const s of [A, B]) {
      if (PLANT === "audit-tamper") {
        await e.db.admin(`SET session_replication_role = replica; UPDATE core.audit_log SET hash = repeat('f', 64) WHERE tenant_id = '${s.w.tenant}' AND seq = 2; SET session_replication_role = origin`);
      }
      const v = await verifyAuditChain(svcTx(e.db), s.w.tenant);
      expect([v.ok, v.firstBadSeq]).toEqual([true, null]);
      expect(v.rows).toBeGreaterThan(0);
    }
  });

  it("clause 1: every Cares book row and Cares movement traces to a named member (own command or decision) or a Cares rule over such a row; every Cares audit entry names a member", async () => {
    const tables = ["cares_profile", "cares_outlet", "cares_listing", "cares_listing_line", "cares_handover", "cares_handover_line", "cares_claim", "cares_claim_line", "cares_allocation"];
    const rows = (await e.db.admin<{ t: string; tenant_id: string; origin: any }>(
      tables.map((t) => `SELECT '${t}' AS t, tenant_id, origin FROM core.${t}`).join(" UNION ALL "))).rows;
    const members = new Set((await e.db.admin<{ k: string }>(`SELECT tenant_id || ':' || id AS k FROM core.member`)).rows.map((r) => r.k));
    const deciders = new Map((await e.db.admin<{ id: string; k: string }>(`SELECT id, tenant_id || ':' || decided_by AS k FROM core.decision`)).rows.map((r) => [r.id, r.k]));
    const named = (tenant: string, o: any) =>
      (o.kind === "command" && members.has(`${tenant}:${o.principal_id}`)) || (o.kind === "decision" && members.has(deciders.get(o.decision_id) ?? ""));
    if (PLANT === "forged-origin") rows.push({ t: "cares_listing", tenant_id: A.w.tenant, origin: { kind: "command", principal_id: uuidv7() } });
    expect(rows.length).toBeGreaterThan(40);
    expect(rows.filter((r) => !named(r.tenant_id, r.origin)).map((r) => `${r.t}:${JSON.stringify(r.origin)}`)).toEqual([]);

    const moved = (await e.db.admin<{ tenant_id: string; kind: string; origin: any; src: any }>(
      `SELECT m.tenant_id, m.kind, m.origin, coalesce(h.origin, c.origin) AS src FROM core.stock_movement m
         LEFT JOIN core.cares_handover h ON h.tenant_id = m.tenant_id AND h.id = m.ref_id AND m.ref_type = 'core.cares_handover'
         LEFT JOIN core.cares_claim c ON c.tenant_id = m.tenant_id AND c.id = m.ref_id AND m.ref_type = 'core.cares_claim'
        WHERE m.kind IN ('donation', 'surplus_out', 'surplus_in', 'cares_reversal')`)).rows;
    // This file's Cares movements (hand-typed): cooked 2 out + 2 reversals; 5 kg in 3 + 2 kg → 2; the 20 kg offer 1 out + 1 in; the
    // void race 1 out + 1 in; the named-batch donation 2 out; the tracked receipt 1 out + 1 in.
    expect(moved.length).toBe(14);
    expect(moved.filter((m) => !(m.origin.kind === "derivation" && /^inventory\.cares_/.test(m.origin.rule_id) && m.src && named(m.tenant_id, m.src)))).toEqual([]);

    // gotcha 34: later changes (status moves, voids, receives) trace through the audit log, never `origin`.
    const audit = (await e.db.admin<{ tenant_id: string; actor: any; decision_id: string | null }>(
      `SELECT tenant_id, actor, decision_id FROM core.audit_log WHERE entity LIKE 'core.cares\\_%'`)).rows;
    expect(audit.length).toBeGreaterThan(20);
    expect(audit.filter((a) => !(a.actor.kind === "member" && members.has(`${a.tenant_id}:${a.actor.id}`)))).toEqual([]);
  });
});

// ---- draft plumbing (as compliance.kit: a snapshot minted by a run, a proposed draft, the approve route) -------------
async function mint(s: Side, templateId: string): Promise<string> {
  const id = uuidv7();
  await e.db.withContext("munim_svc", { tenant_id: s.w.tenant, outlet_ids: "*", role: "service" }, async (c) => {
    const run = uuidv7();
    await c.query(`INSERT INTO intel.run (tenant_id, id, trigger, actor, outlet_scope, expires_at) VALUES ($1, $2, 'event', 'watcher:events', '{*}', now() + interval '1 hour')`, [s.w.tenant, run]);
    const { rows } = await runTemplate(c, templateId, 1, {});
    await c.query(`INSERT INTO evidence.snapshot (tenant_id, id, template_id, template_version, params, run_id, outlet_scope, rows, row_count, sha256)
                   VALUES ($1, $2, $3, 1, '{}', $4, '{*}', $5, $6, repeat('0', 64))`, [s.w.tenant, id, templateId, run, JSON.stringify(rows), rows.length]);
  });
  return id;
}
async function draft(s: Side, command_type: string, payload: Record<string, unknown>, outlets: string[]): Promise<string> {
  const id = uuidv7();
  await e.db.withContext("munim_svc", { tenant_id: s.w.tenant, outlet_ids: "*", role: "service" }, (c) =>
    c.query(`INSERT INTO core.draft (tenant_id, id, outlet_ids, source, command_type, command_payload, based_on) VALUES ($1, $2, $3, 'intel:inventory_purchasing', $4, $5, '[]')`,
      [s.w.tenant, id, outlets, command_type, payload]));
  return id;
}
const approve = (s: Side, who: Parameters<Side["call"]>[2], draftId: string) =>
  s.call("POST", `/v1/drafts/${draftId}:approve`, who, {
    command_id: uuidv7(), idempotency_key: `approve-${uuidv7()}`, type: "drafts.approve.v1",
    payload: { draft_id: draftId, command_type: "cares.listing.publish.v1", edited_payload: null, reason: null },
  });
