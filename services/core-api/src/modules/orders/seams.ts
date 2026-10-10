// Cross-module seams orders calls (W2 brief "Cross-module seams"; signatures fixed there). Each resolves lazily
// from its owner's `index.ts` when that module has landed and exports the function; until then a stand-in
// serves (pricing and redemption refuse with `unavailable`; derivations record the call and write nothing).
// T-034 (W2 integration) wires the real ones; gates replace them with `setOrderSeams` fakes that write real,
// guarded rows. Every seam runs inside the caller's transaction and writes only what its seeded rule/command
// allows; a derivation seam sets app.posting_rule + app.source_ref itself and clears them before returning.
import type { ReasonCode } from "@munim/contracts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AuditEntry, EventDraft } from "../../commit/index.ts";
import { ApiError } from "../../lib/errors.ts";
import type { Queryable } from "../../runtoken/index.ts";

export type Refusal = { line_no: number | null; reason_code: ReasonCode };

/** T-021 catalogue — the one pricing function (catalogue/pricing.ts; the fields orders reads). `at` = the
 *  instant deals are judged at (promised time, else now). */
export type PriceLinesInput = {
  outlet_id: string;
  channel_kind: string;
  at: string;
  lines: Array<{ item_id: string; variant_id: string | null; option_ids: string[]; qty_milli: number }>;
  coupon_codes?: string[];
  /** From the verified principal only (per-customer coupon caps). */
  customer_id?: string | null;
};
export type PricedLine = {
  line_no: number;
  item_id: string;
  variant_id: string | null;
  option_ids: string[];
  qty_milli: number;
  /** ⟨cite:row:core.price:…⟩ etc. */
  price_ref: string;
  option_refs: string[];
  deal_refs: string[];
  coupon_refs: string[];
  /** The price row's amount per unit (before options). */
  unit_price_minor: number;
  /** Σ selected options' price_delta_minor, per unit. */
  options_minor: number;
  line_discount_minor: number;
  tax_class: string;
  tax_minor: number;
};
export type PriceLinesResult = {
  lines: PricedLine[];
  refusals: Refusal[];
  /** Each coupon applied and the discount it gave (core writes core.coupon_use from these at placement). */
  coupons: Array<{ coupon_id: string; code: string; discount_minor: number }>;
};

/** T-024 inventory — FEFO batch picks for a sale (expiry, overrides, binding MRP); writes nothing. */
export type PickInput = Array<{ line_no: number; line_id: string; item_id: string; qty_milli: number }>;
export type SalePick = {
  line_no: number | null;
  line_id: string;
  ingredient_id?: string;
  /** null = an unbatched draw. */
  batch_id: string | null;
  qty_milli: number;
  expired: boolean;
  /** The unused override of this cart line that covers an expired draw. */
  override_id: string | null;
  /** The line's binding MRP (the sold batch's, else the item's). */
  mrp_minor: number | null;
};
export type PickResult = { picks: SalePick[]; refusals: Array<{ line_id?: string; line_no?: number | null; reason_code: ReasonCode }> };

/** T-023 kitchen. */
export type TicketsResult = { applicable: boolean; events: EventDraft[]; audit: AuditEntry[] };

export interface OrderSeams {
  priceLines(tx: Queryable, input: PriceLinesInput): Promise<PriceLinesResult>;
  pickSaleBatches(tx: Queryable, outlet_id: string, lines: PickInput): Promise<PickResult>;
  /** Rules inventory.consume_order / consume_sku (source: the order); `events` go into the caller's HandlerOutput. */
  deriveOrderConsumption(tx: Queryable, order_id: string): Promise<{ events?: EventDraft[] } | void>;
  /** Under orders.place.v1 (the customer's own command); never below zero (MB011). Returns the money value
   *  the points were redeemed for (INFERENCE: the points→money rate is T-028's). */
  loyaltyRedeem(tx: Queryable, order_id: string, points: number): Promise<{ entry_id: string; value_minor: number }>;
  /** T-024: after the order lines exist, marks used (once) the expired-sale overrides the FEFO pick draws on
   *  (0014 #49; only where the pack allows overrides). */
  consumeExpiredOverrides(tx: Queryable, order_id: string): Promise<string[]>;
  loyaltyEarnFor(tx: Queryable, order_id: string): Promise<unknown>;
  loyaltyReverseFor(tx: Queryable, order_id: string): Promise<unknown>;
  postFor(tx: Queryable, rule_id: string, source_ref: string): Promise<unknown>;
  createTicketsFor(tx: Queryable, order_id: string): Promise<TicketsResult>;
}

type Name = keyof OrderSeams;
const OWNER: Record<Name, string> = {
  priceLines: "catalogue",
  pickSaleBatches: "inventory",
  deriveOrderConsumption: "inventory",
  loyaltyRedeem: "customers",
  consumeExpiredOverrides: "inventory",
  loyaltyEarnFor: "customers",
  loyaltyReverseFor: "customers",
  postFor: "finance",
  createTicketsFor: "kitchen",
};

// One state per process even if this file is loaded twice (vitest imports by path, loadRouters by file URL).
const KEY = Symbol.for("munim.orders.seams");
type State = { override: Partial<OrderSeams>; real: Map<Name, unknown>; calls: Array<{ seam: Name; ref: string }> };
const g = globalThis as unknown as Record<symbol, State | undefined>;
const state: State = (g[KEY] ??= { override: {}, real: new Map(), calls: [] });

/** Calls served by a stand-in (the owner has not landed). Ids and rule names only. */
export const standInCalls = state.calls;
const record = (seam: Name, ref: string) => standInCalls.push({ seam, ref });

const STAND_IN: OrderSeams = {
  async priceLines() {
    throw new ApiError("unavailable");
  },
  async pickSaleBatches(_tx, outlet_id) {
    record("pickSaleBatches", outlet_id);
    return { picks: [], refusals: [] };
  },
  async deriveOrderConsumption(_tx, order_id) {
    record("deriveOrderConsumption", order_id);
  },
  async loyaltyRedeem() {
    throw new ApiError("unavailable");
  },
  async consumeExpiredOverrides(_tx, order_id) {
    record("consumeExpiredOverrides", order_id);
    return [];
  },
  async loyaltyEarnFor(_tx, order_id) {
    record("loyaltyEarnFor", order_id);
  },
  async loyaltyReverseFor(_tx, order_id) {
    record("loyaltyReverseFor", order_id);
  },
  async postFor(_tx, rule_id, source_ref) {
    record("postFor", `${rule_id} ${source_ref}`);
  },
  async createTicketsFor(_tx, order_id) {
    record("createTicketsFor", order_id);
    return { applicable: false, events: [], audit: [] };
  },
};

/** Replaces seams for the process (gates; T-034 wiring). Returns the undo. */
export function setOrderSeams(s: Partial<OrderSeams>): () => void {
  const prev = state.override;
  state.override = { ...state.override, ...s };
  return () => {
    state.override = prev;
  };
}

/** Where an owner's landed function differs from the shape orders reads. customers.loyaltyRedeem returns
 *  {entry_id, points}; the money value of the points is that module's LOYALTY.pointValueMinor (INFERENCE rate,
 *  owned by T-028). */
const ADAPT: Partial<Record<Name, (mod: Record<string, unknown>) => unknown>> = {
  loyaltyRedeem: (mod) => {
    const redeem = mod.loyaltyRedeem as ((tx: Queryable, id: string, pts: number) => Promise<{ entry_id: string }>) | undefined;
    const rate = (mod.LOYALTY as { pointValueMinor?: unknown } | undefined)?.pointValueMinor;
    if (typeof redeem !== "function" || typeof rate !== "number") return null;
    return async (tx: Queryable, id: string, pts: number) => ({ entry_id: (await redeem(tx, id, pts)).entry_id, value_minor: pts * rate });
  },
};

const real = state.real;
async function resolve<K extends Name>(name: K): Promise<OrderSeams[K]> {
  const o = state.override[name];
  if (o) return o as OrderSeams[K];
  if (!real.has(name)) {
    const file = join(import.meta.dirname, "..", OWNER[name], "index.ts");
    let fn: unknown = null;
    if (existsSync(file)) {
      const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
      fn = ADAPT[name]?.(mod) ?? mod[name];
    }
    real.set(name, typeof fn === "function" ? fn : null);
  }
  return (real.get(name) ?? STAND_IN[name]) as OrderSeams[K];
}

export const seams: OrderSeams = {
  priceLines: async (...a) => (await resolve("priceLines"))(...a),
  pickSaleBatches: async (...a) => (await resolve("pickSaleBatches"))(...a),
  deriveOrderConsumption: async (...a) => (await resolve("deriveOrderConsumption"))(...a),
  loyaltyRedeem: async (...a) => (await resolve("loyaltyRedeem"))(...a),
  consumeExpiredOverrides: async (...a) => (await resolve("consumeExpiredOverrides"))(...a),
  loyaltyEarnFor: async (...a) => (await resolve("loyaltyEarnFor"))(...a),
  loyaltyReverseFor: async (...a) => (await resolve("loyaltyReverseFor"))(...a),
  postFor: async (...a) => (await resolve("postFor"))(...a),
  createTicketsFor: async (...a) => (await resolve("createTicketsFor"))(...a),
};
