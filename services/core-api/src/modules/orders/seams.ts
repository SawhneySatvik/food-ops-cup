// Cross-module seams orders calls (W2 brief "Cross-module seams"; signatures fixed there). Each resolves lazily
// from its owner's `index.ts` (lazily: the owners import orders back). A missing owner or export FAILS CLOSED with
// `unavailable` (R3-M2): a sale without its pricing, picks, consumption, loyalty, posting or tickets is refused,
// never recorded half-done. Gates may inject a seam explicitly with `setOrderSeams`. Every seam runs inside the
// caller's transaction and writes only what its seeded rule/command allows; a derivation seam sets
// app.posting_rule + app.source_ref itself and clears them before returning.
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
  /** From the verified principal, or the order's own row on a re-price (per-customer coupon caps). */
  customer_id?: string | null;
  /** A re-price of this order: its own coupon uses do not count against their caps (R2-S2-1). */
  exclude_order_id?: string;
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
  /** T-021 catalogue: a coupon's live uses (tenant-wide; uses on cancelled / rejected orders excluded). */
  couponUses(tx: Queryable, coupon_id: string, customer_id: string | null, exclude_order_id?: string): Promise<{ all: number; mine: number }>;
  pickSaleBatches(tx: Queryable, outlet_id: string, lines: PickInput): Promise<PickResult>;
  /** Rules inventory.consume_order / consume_sku (source: the order); `events` go into the caller's HandlerOutput. */
  deriveOrderConsumption(tx: Queryable, order_id: string): Promise<{ events?: EventDraft[] } | void>;
  /** Rule inventory.reverse_order_consumption (W2-R6): a cancelled / rejected order's consumed stock comes back. */
  reverseOrderConsumption(tx: Queryable, order_id: string): Promise<{ events?: EventDraft[] } | void>;
  /** Under orders.place.v1 (the customer's own command); never below zero (MB011). Returns the money value
   *  the points were redeemed for (the tenant's loyalty policy, W2-R4 — customers reads it). */
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
  couponUses: "catalogue",
  pickSaleBatches: "inventory",
  deriveOrderConsumption: "inventory",
  reverseOrderConsumption: "inventory",
  loyaltyRedeem: "customers",
  consumeExpiredOverrides: "inventory",
  loyaltyEarnFor: "customers",
  loyaltyReverseFor: "customers",
  postFor: "finance",
  createTicketsFor: "kitchen",
};

// One state per process even if this file is loaded twice (vitest imports by path, loadRouters by file URL).
const KEY = Symbol.for("munim.orders.seams");
type State = { override: Partial<OrderSeams>; real: Map<Name, unknown> };
const g = globalThis as unknown as Record<symbol, State | undefined>;
const state: State = (g[KEY] ??= { override: {}, real: new Map() });

/** Replaces seams for the process (gates; T-034 wiring). Returns the undo. */
export function setOrderSeams(s: Partial<OrderSeams>): () => void {
  const prev = state.override;
  state.override = { ...state.override, ...s };
  return () => {
    state.override = prev;
  };
}

const real = state.real;
async function resolve<K extends Name>(name: K): Promise<OrderSeams[K]> {
  const o = state.override[name];
  if (o) return o as OrderSeams[K];
  if (!real.has(name)) {
    const file = join(import.meta.dirname, "..", OWNER[name], "index.ts");
    let fn: unknown = null;
    if (existsSync(file)) {
      const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
      fn = mod[name];
    }
    real.set(name, typeof fn === "function" ? fn : null);
  }
  const fn = real.get(name);
  if (!fn) throw new ApiError("unavailable");
  return fn as OrderSeams[K];
}

export const seams: OrderSeams = {
  priceLines: async (...a) => (await resolve("priceLines"))(...a),
  couponUses: async (...a) => (await resolve("couponUses"))(...a),
  pickSaleBatches: async (...a) => (await resolve("pickSaleBatches"))(...a),
  deriveOrderConsumption: async (...a) => (await resolve("deriveOrderConsumption"))(...a),
  reverseOrderConsumption: async (...a) => (await resolve("reverseOrderConsumption"))(...a),
  loyaltyRedeem: async (...a) => (await resolve("loyaltyRedeem"))(...a),
  consumeExpiredOverrides: async (...a) => (await resolve("consumeExpiredOverrides"))(...a),
  loyaltyEarnFor: async (...a) => (await resolve("loyaltyEarnFor"))(...a),
  loyaltyReverseFor: async (...a) => (await resolve("loyaltyReverseFor"))(...a),
  postFor: async (...a) => (await resolve("postFor"))(...a),
  createTicketsFor: async (...a) => (await resolve("createTicketsFor"))(...a),
};
