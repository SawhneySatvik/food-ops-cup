// Munim Cares command handlers (ADR-015 §1.3, §3; 0028 is the contract: command_authority, the cares_rules triggers and
// the derivation bindings). Each handler is bound to one command type and runs inside executeCommand (idempotency, audit
// chain, outbox after commit). The database is the backstop for every rule here; these checks exist to answer with a typed
// reason before a trigger would refuse, and to read the row first so an outlet outside the caller's scope is 404 (RLS).
// Lock order: command_log (executeCommand) first. Offerer paths (withdraw, hand-over record and void, decide): the listing
// row FOR UPDATE → the claim lock (hand-over of an offer, decide) → audit. Buyer paths (cancel, close, receive): the claim
// lock → audit. Profile set, publish and claim create take neither. The claim lock key is the claim's own tenant and id,
// byte-identical on both sides: 'cares_claim:<claim tenant>:<claim id>'.
import {
  CaresClaimCancelV1, CaresClaimCloseV1, CaresClaimCreateV1, CaresClaimDecideV1, CaresClaimReceiveV1, CaresHandoverRecordV1, CaresHandoverVoidV1,
  CaresListingPublishV1, CaresListingWithdrawV1, CaresProfileSetV1,
} from "@munim/contracts/cares";
import type { ReasonCode } from "@munim/contracts";
import { caresBaseFactor, claimTotal } from "@munim/core-domain/cares";
import { type AuditEntry, type CommandHandler, type EventDraft, uuidv7 } from "../../commit/index.ts";
import { ApiError } from "../../lib/errors.ts";
import type { Queryable } from "../../runtoken/index.ts";
import { deriveCaresHandover, deriveCaresReceive, onHand, reverseCaresHandover, tenantPack } from "../inventory/index.ts";

const T = `current_setting('app.tenant_id')::uuid`;
const ME = `nullif(current_setting('app.member_id', true), '')::uuid`;
type Kind = "donation" | "offer";

function parse<S>(schema: { safeParse(v: unknown): { success: true; data: S } | { success: false } }, payload: unknown): S {
  const r = schema.safeParse(payload);
  if (!r.success) throw new ApiError("invalid_payload");
  return r.data;
}
const first = async <R extends object>(c: Queryable, sql: string, params: unknown[] = []) => (await c.query<R>(sql, params)).rows[0];
const conflict = (reason: ReasonCode) => new ApiError("conflict", reason);
const invalid = (reason: ReasonCode | null = null) => new ApiError("invalid_payload", reason);

/** The pack's cares block (absent = Cares is off) and the operator's enablement (R24: an approved config draft). */
async function caresOn(c: Queryable) {
  const cares = (await tenantPack(c)).cares;
  if (!cares) throw new ApiError("out_of_pack_scope", "cares_not_available");
  const en = await first<{ enabled: boolean }>(c, `SELECT enabled FROM platform.cares_enablement WHERE tenant_id = ${T}`);
  if (!en?.enabled) throw conflict("cares_not_enabled");
  return cares;
}

/** An outlet the caller can see (its scope): else 404, as RLS answers for its rows. */
async function visibleOutlet(c: Queryable, outletId: string): Promise<void> {
  const ok = await first(c,
    `SELECT 1 FROM core.outlet WHERE id = $1 AND (current_setting('app.outlet_ids', true) = '{*}'
       OR id = ANY (nullif(nullif(current_setting('app.outlet_ids', true), ''), '{*}')::uuid[]))`, [outletId]);
  if (!ok) throw new ApiError("not_found");
}

/** The business takes part (profile active) and the outlet is opted in (active); its Cares city. */
async function optedIn(c: Queryable, outletId: string) {
  await visibleOutlet(c, outletId);
  const r = await first<{ city_code: string | null; b2b_enabled: boolean }>(c,
    `SELECT co.city_code, pr.b2b_enabled FROM core.cares_profile pr
       LEFT JOIN core.cares_outlet co ON co.tenant_id = pr.tenant_id AND co.outlet_id = $1 AND co.active
      WHERE pr.status = 'active'`, [outletId]);
  if (!r?.city_code) throw conflict("cares_not_opted_in");
  return { city_code: r.city_code, b2b_enabled: r.b2b_enabled };
}

async function claimLock(c: Queryable, claimTenant: string, claimId: string): Promise<void> {
  await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('cares_claim:' || $1 || ':' || $2, 0))`, [claimTenant, claimId]);
}

/** The listing row, locked (ADR-015 §1.3 decide locking: the handler's first statement). RLS hides another outlet's → 404. */
async function lockListing(c: Queryable, listingId: string) {
  const l = await first<{ id: string; outlet_id: string; kind: Kind; status: string }>(c,
    `SELECT id, outlet_id, kind, status FROM core.cares_listing WHERE tenant_id = ${T} AND id = $1 FOR UPDATE`, [listingId]);
  if (!l) throw new ApiError("not_found");
  return l;
}

const listingEvent = (type: "published" | "closed", l: { id: string; outlet_id: string; kind: Kind }, status?: "closed" | "withdrawn"): EventDraft => ({
  type: `munim.cares.listing.${type}.v1`, subject: l.id, aggregateType: "cares_listing",
  data: { listing_id: l.id, outlet_id: l.outlet_id, kind: l.kind, ...(status ? { status } : {}) },
});

// ---- profile -------------------------------------------------------------------------------------------------------
export const profileSet: CommandHandler = {
  type: "cares.profile.set.v1",
  async run(c, cmd) {
    const p = parse(CaresProfileSetV1, cmd.payload);
    await caresOn(c);
    const ids = p.outlets.map((o) => o.outlet_id);
    if (new Set(ids).size !== ids.length || p.outlets.some((o) => o.pickup_to <= o.pickup_from)) throw invalid();
    const known = await c.query<{ id: string }>(`SELECT id FROM core.outlet WHERE id = ANY ($1::uuid[])`, [ids]);
    if (known.rowCount !== ids.length) throw new ApiError("not_found");
    // R30: one country per business — every city is in the tenant's own country.
    const cities = await c.query<{ code: string; ok: boolean }>(
      `SELECT ci.code, ci.status = 'active' AND ci.country_code = t.country_code AS ok
         FROM platform.cares_city ci, core.tenant t WHERE t.tenant_id = ${T} AND ci.code = ANY ($1::text[])`, [[...new Set(p.outlets.map((o) => o.city_code))]]);
    for (const o of p.outlets) {
      const city = cities.rows.find((x) => x.code === o.city_code);
      if (!city?.ok) throw invalid("cares_city_mismatch");
    }
    const prior = await first<{ id: string; status: string; public_name: string; b2b_enabled: boolean }>(c, `SELECT id, status, public_name, b2b_enabled FROM core.cares_profile`);
    const id = prior?.id ?? uuidv7();
    if (prior) {
      await c.query(`UPDATE core.cares_profile SET status = $2, public_name = $3, b2b_enabled = $4 WHERE id = $1`, [id, p.status, p.public_name, p.b2b_enabled]);
    } else {
      await c.query(`INSERT INTO core.cares_profile (tenant_id, id, status, public_name, b2b_enabled) VALUES (${T}, $1, $2, $3, $4)`, [id, p.status, p.public_name, p.b2b_enabled]);
    }
    const audit: AuditEntry[] = [{ entity: "core.cares_profile", entityId: id, before: prior ? { status: prior.status, public_name: prior.public_name, b2b_enabled: prior.b2b_enabled } : null,
      after: { status: p.status, public_name: p.public_name, b2b_enabled: p.b2b_enabled } }];
    const priorOutlets = (await c.query<{ outlet_id: string; city_code: string; active: boolean }>(
      `SELECT outlet_id, city_code, active FROM core.cares_outlet WHERE outlet_id = ANY ($1::uuid[])`, [ids])).rows;
    for (const o of p.outlets) {
      await c.query(
        `INSERT INTO core.cares_outlet (tenant_id, outlet_id, city_code, lat_e6, lng_e6, pickup_from, pickup_to, active) VALUES (${T}, $1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tenant_id, outlet_id) DO UPDATE SET city_code = excluded.city_code, lat_e6 = excluded.lat_e6, lng_e6 = excluded.lng_e6,
           pickup_from = excluded.pickup_from, pickup_to = excluded.pickup_to, active = excluded.active`,
        [o.outlet_id, o.city_code, o.lat_e6, o.lng_e6, o.pickup_from, o.pickup_to, o.active]);
      const was = priorOutlets.find((x) => x.outlet_id === o.outlet_id);
      audit.push({ entity: "core.cares_outlet", entityId: o.outlet_id, before: was ? { city_code: was.city_code, active: was.active } : null,
        after: { city_code: o.city_code, active: o.active } });
    }
    return { entityId: id, audit };
  },
};

// ---- listings ------------------------------------------------------------------------------------------------------
/** Own command (owner / judge) or an approved draft (published_by = the approver: app.member_id). Final-payload checks
 *  (R27): opted in, an eligible simulated recipient, a pickup not over, expiry ≥ pickup date + the pack's days, a cooked
 *  pickup within the pack's hold, raw / packaged qty ≤ on-hand. A cooked line under a draft is the database's refusal
 *  (MB004: cooked food is listed only by its owner's own command). */
export const listingPublish: CommandHandler = {
  type: "cares.listing.publish.v1",
  async run(c, cmd) {
    const p = parse(CaresListingPublishV1, cmd.payload);
    const cares = await caresOn(c);
    const outlet = await optedIn(c, p.outlet_id);
    if (p.kind === "offer" && (!cares.offers_enabled || !outlet.b2b_enabled)) throw conflict("offer_not_enabled");
    const lineIds = p.lines.map((l) => l.line_id);
    if (new Set(lineIds).size !== lineIds.length || p.lines.some((l) => !cares.food_kinds.includes(l.food_kind))) throw invalid();

    const when = (await first<{ live: boolean; ordered: boolean; pickup_on: string; within_hold: boolean; currency: string }>(c,
      `SELECT $2::timestamptz > now() AS live, $2::timestamptz > $1::timestamptz AS ordered,
              ((($1::timestamptz) AT TIME ZONE o.tz) - o.business_day_cutoff)::date::text AS pickup_on,
              $1::timestamptz <= now() + make_interval(mins => $4) AS within_hold, t.base_currency AS currency
         FROM core.outlet o, core.tenant t WHERE o.id = $3 AND t.tenant_id = ${T}`, [p.pickup_from, p.pickup_to, p.outlet_id, cares.cooked_max_hold_min]))!;
    if (!when.ordered) throw invalid();
    if (!when.live) throw invalid("listing_expired");
    if (p.lines.some((l) => l.food_kind === "cooked") && !when.within_hold) throw invalid("cooked_hold_exceeded");

    if (p.kind === "donation") {
      if (p.recipient_id === null) throw invalid("recipient_ineligible");
      const r = await first<{ ok: boolean; cooked: boolean; raw: boolean; packaged: boolean }>(c,
        `SELECT r.status = 'active' AND r.simulated AND r.city_code = $2 AS ok, r.accepts_cooked AS cooked, r.accepts_raw AS raw, r.accepts_packaged AS packaged
           FROM platform.cares_recipient r WHERE r.id = $1`, [p.recipient_id, outlet.city_code]);
      if (!r?.ok || p.lines.some((l) => !r[l.food_kind])) throw invalid("recipient_ineligible");
    } else if (p.recipient_id !== null) throw invalid();

    // Stock each raw / packaged line takes, in base units, per batch (or per ingredient when it names none).
    const need = new Map<string, { ingredient_id: string; batch_id: string | null; qty: number }>();
    for (const l of p.lines) {
      const priced = l.unit_price_minor !== null && l.currency !== null;
      if (p.kind === "donation" ? l.unit_price_minor !== null || l.currency !== null : !priced || l.food_kind === "cooked") throw invalid();
      if (priced && l.currency !== when.currency) throw new ApiError("currency_mismatch");
      if (l.expires_on !== null && !(await expiryOk(c, l.expires_on, when.pickup_on, cares.min_days_left_at_pickup))) throw invalid("line_expired");
      if (l.food_kind === "cooked") {
        if (l.item_id === null || l.ingredient_id !== null || l.batch_id !== null) throw invalid();
        if (!(await first(c, `SELECT 1 FROM core.item WHERE id = $1`, [l.item_id]))) throw new ApiError("not_found");
        continue;
      }
      if (l.ingredient_id === null || l.item_id !== null) throw invalid();
      const ing = await first<{ base_unit: string; tracked_by_batch: boolean }>(c, `SELECT base_unit, tracked_by_batch FROM core.ingredient WHERE id = $1`, [l.ingredient_id]);
      if (!ing) throw new ApiError("not_found");
      const f = caresBaseFactor(l.unit, ing.base_unit);
      if (f === null) throw new ApiError("bad_request", "unit_mismatch");
      if (l.batch_id !== null) {
        const b = await first<{ expires_on: string | null }>(c, `SELECT expires_on::text FROM core.batch WHERE id = $1 AND outlet_id = $2 AND ingredient_id = $3`,
          [l.batch_id, p.outlet_id, l.ingredient_id]);
        if (!b || !ing.tracked_by_batch) throw invalid();
        if (b.expires_on !== null && !(await expiryOk(c, b.expires_on, when.pickup_on, cares.min_days_left_at_pickup))) throw invalid("line_expired");
      }
      const k = `${l.ingredient_id}|${l.batch_id}`;
      need.set(k, { ingredient_id: l.ingredient_id, batch_id: l.batch_id, qty: (need.get(k)?.qty ?? 0) + l.qty_milli * f });
    }
    for (const n of need.values()) {
      const have = n.batch_id === null
        ? (await onHand(c, p.outlet_id, [n.ingredient_id])).get(n.ingredient_id)!
        : Number((await first<{ q: string }>(c, `SELECT coalesce(sum(qty_milli), 0)::text AS q FROM core.stock_movement WHERE outlet_id = $1 AND batch_id = $2`,
            [p.outlet_id, n.batch_id]))!.q);
      if (n.qty > have) throw conflict("qty_exceeds_on_hand");
    }

    // pickup_on with the trigger's own expression (0028 cares_listing_rules), never computed in TS.
    const ins = await c.query(
      `INSERT INTO core.cares_listing (tenant_id, id, outlet_id, kind, recipient_id, pickup_from, pickup_to, pickup_on, published_by)
       SELECT ${T}, $1, o.id, $3, $4, $5::timestamptz, $6::timestamptz, ((($5::timestamptz) AT TIME ZONE o.tz) - o.business_day_cutoff)::date, ${ME}
         FROM core.outlet o WHERE o.id = $2
       ON CONFLICT DO NOTHING`, [p.listing_id, p.outlet_id, p.kind, p.recipient_id, p.pickup_from, p.pickup_to]);
    if (ins.rowCount !== 1) throw new ApiError("conflict");
    for (const [i, l] of p.lines.entries()) {
      await c.query(
        `INSERT INTO core.cares_listing_line (tenant_id, id, listing_id, line_no, food_kind, item_id, ingredient_id, batch_id, qty_milli, unit, expires_on, unit_price_minor, currency)
         VALUES (${T}, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [l.line_id, p.listing_id, i + 1, l.food_kind, l.item_id, l.ingredient_id, l.batch_id, l.qty_milli, l.unit, l.expires_on, l.unit_price_minor, l.currency]);
    }
    const l = { id: p.listing_id, outlet_id: p.outlet_id, kind: p.kind };
    return {
      entityId: p.listing_id,
      audit: [{ entity: "core.cares_listing", entityId: p.listing_id, after: { kind: p.kind, outlet_id: p.outlet_id, recipient_id: p.recipient_id, lines: p.lines.length } }],
      events: [listingEvent("published", l)],
    };
  },
};

/** expires_on ≥ pickup date + the pack's minimum days left (a batch's single expiry is a last-use date, ADR-015 §6). */
async function expiryOk(c: Queryable, expires: string, pickupOn: string, minDays: number): Promise<boolean> {
  return (await first<{ ok: boolean }>(c, `SELECT $1::date >= $2::date + $3::int AS ok`, [expires, pickupOn, minDays]))!.ok;
}

/** Published only: an offer cannot be withdrawn once a claim on it is accepted (allocated). */
export const listingWithdraw: CommandHandler = {
  type: "cares.listing.withdraw.v1",
  async run(c, cmd) {
    const p = parse(CaresListingWithdrawV1, cmd.payload);
    const l = await lockListing(c, p.listing_id);
    if (l.status !== "published") throw new ApiError("illegal_transition");
    await c.query(`UPDATE core.cares_listing SET status = 'withdrawn' WHERE id = $1`, [l.id]);
    return {
      entityId: l.id,
      audit: [{ entity: "core.cares_listing", entityId: l.id, before: { status: "published" }, after: { status: "withdrawn" } }],
      events: [listingEvent("closed", l, "withdrawn")],
    };
  },
};

// ---- hand-overs ----------------------------------------------------------------------------------------------------
/** The claim behind an offer's accepted allocation, through the offerer's definer read (its tenant is not this one). */
async function inboundClaim(c: Queryable, listingId: string, claimTenant: string, claimId: string) {
  return first<{ status: string; buyer_public_name: string | null; lines: Array<{ offer_line_id: string; qty_milli: number; unit_price_minor: number }> }>(c,
    `SELECT status, buyer_public_name, lines FROM core.cares_inbound_claims($1) WHERE claim_tenant_id = $2 AND claim_id = $3`, [listingId, claimTenant, claimId]);
}

/** What was handed over (handed_at stamped by core). Σ per listing line ≤ the approved line (`qty_exceeds_listed`; the
 *  line trigger is the backstop, MB001). The hand-over that completes every line closes the listing — header, lines,
 *  then the close (0028: closed only by a hand-over with a line recorded in this transaction). Stock leaves through
 *  inventory.cares_handover. An offer's hand-over names the accepted allocation and waits on the claim lock, so it is
 *  judged before or after the buyer's receive, never during it; it is all-or-nothing (orchestrator ruling 2-B, v1):
 *  every line at exactly its accepted qty, else `handover_must_be_complete`. App-level only: 0028's triggers admit a
 *  partial one. */
export const handoverRecord: CommandHandler = {
  type: "cares.handover.record.v1",
  async run(c, cmd) {
    const p = parse(CaresHandoverRecordV1, cmd.payload);
    const l = await lockListing(c, p.listing_id);
    if (l.kind === "donation" ? l.status !== "published" : l.status !== "allocated") throw new ApiError("illegal_transition");
    if (l.kind === "donation" && p.allocation_id !== null) throw invalid();
    let accepted: Array<{ offer_line_id: string; qty_milli: number }> | null = null;
    if (l.kind === "offer") {
      const a = await first<{ claim_tenant_id: string; claim_id: string }>(c,
        `SELECT claim_tenant_id, claim_id FROM core.cares_allocation WHERE id = $1 AND listing_id = $2 AND verdict = 'accepted'`, [p.allocation_id, l.id]);
      if (!a) throw invalid();
      await claimLock(c, a.claim_tenant_id, a.claim_id);
      const claim = await inboundClaim(c, l.id, a.claim_tenant_id, a.claim_id);
      if (claim?.status === "received") throw conflict("claim_received");
      if (claim?.status !== "requested") throw conflict("offer_closed");
      accepted = claim.lines;
    }
    const lines = (await c.query<{ id: string; qty: string; handed: string }>(
      `SELECT ll.id, ll.qty_milli::text AS qty,
              (SELECT coalesce(sum(hl.qty_milli), 0) FROM core.cares_handover_line hl
                 JOIN core.cares_handover h ON h.tenant_id = hl.tenant_id AND h.id = hl.handover_id AND h.status = 'recorded'
                WHERE hl.listing_line_id = ll.id)::text AS handed
         FROM core.cares_listing_line ll WHERE ll.listing_id = $1`, [l.id])).rows;
    const asked = p.lines.map((x) => x.listing_line_id);
    if (new Set(asked).size !== asked.length || asked.some((id) => !lines.some((x) => x.id === id))) throw invalid();
    for (const x of p.lines) {
      const line = lines.find((y) => y.id === x.listing_line_id)!;
      if (Number(line.handed) + x.qty_milli > Number(line.qty)) throw conflict("qty_exceeds_listed");
    }
    if (accepted && (p.lines.length !== accepted.length
      || !accepted.every((a) => p.lines.some((x) => x.listing_line_id === a.offer_line_id && x.qty_milli === a.qty_milli)))) {
      throw conflict("handover_must_be_complete");
    }

    const ins = await c.query(
      `INSERT INTO core.cares_handover (tenant_id, id, listing_id, outlet_id, allocation_id, recorded_by) VALUES (${T}, $1, $2, $3, $4, ${ME}) ON CONFLICT DO NOTHING`,
      [p.handover_id, l.id, l.outlet_id, p.allocation_id]);
    if (ins.rowCount !== 1) throw new ApiError("conflict");
    for (const x of p.lines) {
      await c.query(`INSERT INTO core.cares_handover_line (tenant_id, id, handover_id, listing_line_id, qty_milli) VALUES (${T}, $1, $2, $3, $4)`,
        [uuidv7(), p.handover_id, x.listing_line_id, x.qty_milli]);
    }
    const audit: AuditEntry[] = [{ entity: "core.cares_handover", entityId: p.handover_id, after: { listing_id: l.id, allocation_id: p.allocation_id, lines: p.lines.length } }];
    const events: EventDraft[] = [{ type: "munim.cares.handover.recorded.v1", subject: p.handover_id, aggregateType: "cares_handover",
      data: { handover_id: p.handover_id, listing_id: l.id, outlet_id: l.outlet_id, kind: l.kind } }];
    const done = lines.every((y) => Number(y.handed) + (p.lines.find((x) => x.listing_line_id === y.id)?.qty_milli ?? 0) === Number(y.qty));
    if (done) {
      await c.query(`UPDATE core.cares_listing SET status = 'closed' WHERE id = $1`, [l.id]);
      audit.push({ entity: "core.cares_listing", entityId: l.id, before: { status: l.status }, after: { status: "closed" } });
      events.push(listingEvent("closed", l, "closed"));
    }
    const stock = await deriveCaresHandover(c, p.handover_id);
    return { entityId: p.handover_id, audit, events: [...events, ...stock.events] };
  },
};

/** A donation's hand-over: recorded → voided with a reason; its stock comes back (inventory.cares_handover_void). The
 *  listing is not reopened (no editing: void, then publish again). An offer's hand-over is final in v1 (orchestrator
 *  ruling 2-B): `offer_handover_final`, whether or not the buyer has received it. */
export const handoverVoid: CommandHandler = {
  type: "cares.handover.void.v1",
  async run(c, cmd) {
    const p = parse(CaresHandoverVoidV1, cmd.payload);
    const h = await first<{ listing_id: string }>(c, `SELECT listing_id FROM core.cares_handover WHERE id = $1`, [p.handover_id]);
    if (!h) throw new ApiError("not_found");
    const l = await lockListing(c, h.listing_id);
    if (l.kind === "offer") throw conflict("offer_handover_final");
    const upd = await c.query(`UPDATE core.cares_handover SET status = 'voided', voided_by = ${ME}, void_reason_code = $2 WHERE id = $1 AND status = 'recorded'`,
      [p.handover_id, p.reason_code]);
    if (upd.rowCount !== 1) throw new ApiError("illegal_transition");
    const stock = await reverseCaresHandover(c, p.handover_id);
    return {
      entityId: p.handover_id,
      audit: [{ entity: "core.cares_handover", entityId: p.handover_id, before: { status: "recorded" }, after: { status: "voided", reason_code: p.reason_code } }],
      events: [{ type: "munim.cares.handover.voided.v1", subject: p.handover_id, aggregateType: "cares_handover",
        data: { handover_id: p.handover_id, listing_id: l.id, outlet_id: l.outlet_id, kind: l.kind } }, ...stock.events],
    };
  },
};

// ---- B2B claims (record only: money is "Recorded, never processed") -------------------------------------------------
/** Buyer. Every line of the offer at the offered qty, price and expiry, read from core.cares_market_offers in this
 *  transaction (all-or-nothing); the buyer only maps each offer line to an own ingredient whose base unit is the line's
 *  unit (else the receive could never post: stock moves in base units). total_minor is re-derived here (rule 9). */
export const claimCreate: CommandHandler = {
  type: "cares.claim.create.v1",
  async run(c, cmd) {
    const p = parse(CaresClaimCreateV1, cmd.payload);
    const cares = await caresOn(c);
    const outlet = await optedIn(c, p.outlet_id);
    if (!cares.offers_enabled || !outlet.b2b_enabled) throw conflict("offer_not_enabled");
    const offer = await first<{ city_code: string; lines: Array<{ offer_line_id: string; qty_milli: number; unit: string; expires_on: string | null; unit_price_minor: number; currency: string }> }>(c,
      `SELECT city_code, lines FROM core.cares_market_offers($1) WHERE offer_tenant_id = $2`, [p.offer_listing_id, p.offer_tenant_id]);
    if (!offer) throw conflict("offer_closed");
    if (offer.city_code !== outlet.city_code) throw invalid("cares_city_mismatch");
    const asked = p.lines.map((l) => l.offer_line_id);
    if (new Set(asked).size !== asked.length || asked.length !== offer.lines.length || offer.lines.some((o) => !asked.includes(o.offer_line_id))) throw invalid();
    const currency = (await first<{ cur: string }>(c, `SELECT base_currency AS cur FROM core.tenant WHERE tenant_id = ${T}`))!.cur;
    if (offer.lines.some((o) => o.currency !== currency)) throw new ApiError("currency_mismatch");
    for (const l of p.lines) {
      const ing = await first<{ base_unit: string }>(c, `SELECT base_unit FROM core.ingredient WHERE id = $1`, [l.ingredient_id]);
      if (!ing) throw new ApiError("not_found");
      if (ing.base_unit !== offer.lines.find((o) => o.offer_line_id === l.offer_line_id)!.unit) throw new ApiError("bad_request", "unit_mismatch");
    }
    const ins = await c.query(
      `INSERT INTO core.cares_claim (tenant_id, id, outlet_id, offer_tenant_id, offer_listing_id, total_minor, currency, created_by)
       VALUES (${T}, $1, $2, $3, $4, $5, $6, ${ME}) ON CONFLICT DO NOTHING`,
      [p.claim_id, p.outlet_id, p.offer_tenant_id, p.offer_listing_id, claimTotal(offer.lines), currency]);
    if (ins.rowCount !== 1) throw new ApiError("conflict");
    for (const l of p.lines) {
      const o = offer.lines.find((x) => x.offer_line_id === l.offer_line_id)!;
      await c.query(
        `INSERT INTO core.cares_claim_line (tenant_id, id, claim_id, offer_line_id, ingredient_id, qty_milli, unit, unit_price_minor, expires_on)
         VALUES (${T}, $1, $2, $3, $4, $5, $6, $7, $8)`, [uuidv7(), p.claim_id, o.offer_line_id, l.ingredient_id, o.qty_milli, o.unit, o.unit_price_minor, o.expires_on]);
    }
    return {
      entityId: p.claim_id,
      audit: [{ entity: "core.cares_claim", entityId: p.claim_id, after: { offer_tenant_id: p.offer_tenant_id, offer_listing_id: p.offer_listing_id, lines: p.lines.length } }],
      events: [{ type: "munim.cares.claim.created.v1", subject: p.claim_id, aggregateType: "cares_claim", data: { claim_id: p.claim_id, outlet_id: p.outlet_id } }],
    };
  },
};

/** The buyer's own claim, read under the claim lock (taken first: the key is this tenant's and the payload's id). */
async function ownClaim(c: Queryable, claimId: string) {
  await claimLock(c, (await first<{ t: string }>(c, `SELECT current_setting('app.tenant_id') AS t`))!.t, claimId);
  const claim = await first<{ status: string }>(c, `SELECT status FROM core.cares_claim WHERE id = $1`, [claimId]);
  if (!claim) throw new ApiError("not_found");
  if (claim.status !== "requested") throw new ApiError("illegal_transition");
  return (await first<{ verdict: "accepted" | "declined" | "none"; allocation_id: string | null; lines: Array<{ offer_line_id: string; handed_qty_milli: number }> }>(c,
    `SELECT verdict, allocation_id, lines FROM core.cares_claim_outcome($1)`, [claimId]))!;
}

async function claimMove(c: Queryable, claimId: string, to: "cancelled" | "closed") {
  await c.query(`UPDATE core.cares_claim SET status = $2 WHERE id = $1`, [claimId, to]);
  return { entityId: claimId, audit: [{ entity: "core.cares_claim", entityId: claimId, before: { status: "requested" }, after: { status: to } }] };
}

/** Before any verdict only (`claim_decided` once the offerer decided). */
export const claimCancel: CommandHandler = {
  type: "cares.claim.cancel.v1",
  async run(c, cmd) {
    const p = parse(CaresClaimCancelV1, cmd.payload);
    if ((await ownClaim(c, p.claim_id)).verdict !== "none") throw conflict("claim_decided");
    return claimMove(c, p.claim_id, "cancelled");
  },
};

/** Only when the outcome is declined (declined, withdrawn, or allocated to another claim). */
export const claimClose: CommandHandler = {
  type: "cares.claim.close.v1",
  async run(c, cmd) {
    const p = parse(CaresClaimCloseV1, cmd.payload);
    const o = await ownClaim(c, p.claim_id);
    if (o.verdict === "accepted") throw conflict("claim_decided");
    if (o.verdict !== "declined") throw new ApiError("illegal_transition");
    return claimMove(c, p.claim_id, "closed");
  },
};

/** Offerer. The listing row is locked first (two accepts: one wins, the other reads `allocated` → `offer_closed`), then
 *  the claim lock, so a buyer's cancel is judged wholly before or after. One verdict per claim; accept allocates the offer. */
export const claimDecide: CommandHandler = {
  type: "cares.claim.decide.v1",
  async run(c, cmd) {
    const p = parse(CaresClaimDecideV1, cmd.payload);
    const l = await lockListing(c, p.listing_id);
    await claimLock(c, p.claim_tenant_id, p.claim_id);
    if (l.kind !== "offer") throw invalid();
    if (await first(c, `SELECT 1 FROM core.cares_allocation WHERE claim_tenant_id = $1 AND claim_id = $2`, [p.claim_tenant_id, p.claim_id])) throw conflict("claim_decided");
    const claim = await inboundClaim(c, l.id, p.claim_tenant_id, p.claim_id);
    if (!claim) throw new ApiError("not_found");
    if (claim.status !== "requested") throw new ApiError("illegal_transition");
    if (p.verdict === "accepted" && l.status !== "published") throw conflict("offer_closed");
    // All-or-nothing: the claim is every offer line at the offered qty and price.
    const offered = (await c.query<{ id: string; qty: string; price: string | null; currency: string | null }>(
      `SELECT id, qty_milli::text AS qty, unit_price_minor::text AS price, currency FROM core.cares_listing_line WHERE listing_id = $1`, [l.id])).rows;
    const same = claim.lines.length === offered.length
      && offered.every((o) => claim.lines.some((x) => x.offer_line_id === o.id && x.qty_milli === Number(o.qty) && x.unit_price_minor === Number(o.price)));
    if (!same) throw new ApiError("conflict");
    const ins = await c.query(
      `INSERT INTO core.cares_allocation (tenant_id, id, listing_id, outlet_id, claim_tenant_id, claim_id, buyer_public_name, verdict, total_minor, currency, decided_by)
       VALUES (${T}, $1, $2, $3, $4, $5, $6, $7, $8, $9, ${ME}) ON CONFLICT DO NOTHING`,
      [p.allocation_id, l.id, l.outlet_id, p.claim_tenant_id, p.claim_id, claim.buyer_public_name, p.verdict, claimTotal(claim.lines), offered[0]!.currency]);
    if (ins.rowCount !== 1) throw new ApiError("conflict");
    const audit: AuditEntry[] = [{ entity: "core.cares_allocation", entityId: p.allocation_id, after: { listing_id: l.id, claim_id: p.claim_id, verdict: p.verdict } }];
    if (p.verdict === "accepted") {
      await c.query(`UPDATE core.cares_listing SET status = 'allocated' WHERE id = $1`, [l.id]);
      audit.push({ entity: "core.cares_listing", entityId: l.id, before: { status: "published" }, after: { status: "allocated" } });
    }
    return {
      entityId: p.allocation_id,
      audit,
      events: [{ type: "munim.cares.claim.decided.v1", subject: p.claim_id, aggregateType: "cares_allocation",
        data: { claim_id: p.claim_id, listing_id: l.id, outlet_id: l.outlet_id, verdict: p.verdict } }],
    };
  },
};

/** Buyer. Accepted and handed over: the claim takes the offerer's accepted allocation and each line the quantity the
 *  offerer handed over (core.cares_claim_outcome, this transaction; the triggers re-check both), then the stock comes in
 *  through inventory.cares_claim_receive. Under the claim lock, so the offerer's hand-over is judged wholly before or after. */
export const claimReceive: CommandHandler = {
  type: "cares.claim.receive.v1",
  async run(c, cmd) {
    const p = parse(CaresClaimReceiveV1, cmd.payload);
    const o = await ownClaim(c, p.claim_id);
    if (o.verdict !== "accepted" || !o.lines.some((x) => x.handed_qty_milli > 0)) throw new ApiError("illegal_transition");
    await c.query(`UPDATE core.cares_claim SET status = 'received', allocation_id = $2 WHERE id = $1`, [p.claim_id, o.allocation_id]);
    for (const x of o.lines) {
      await c.query(`UPDATE core.cares_claim_line SET received_qty_milli = $3 WHERE claim_id = $1 AND offer_line_id = $2`, [p.claim_id, x.offer_line_id, x.handed_qty_milli]);
    }
    const stock = await deriveCaresReceive(c, p.claim_id);
    return {
      entityId: p.claim_id,
      audit: [{ entity: "core.cares_claim", entityId: p.claim_id, before: { status: "requested" }, after: { status: "received", allocation_id: o.allocation_id } }],
      events: stock.events,
    };
  },
};

export const HANDLERS = [profileSet, listingPublish, listingWithdraw, handoverRecord, handoverVoid, claimCreate, claimCancel, claimClose, claimDecide, claimReceive];
