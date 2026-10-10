// Module wiring. The cross-module seams (W2-LANE-BRIEF) are injected here by T-034 (or a gate): none is
// imported from another module's directory, so this module builds and tests before the others land. A seam that
// is not wired makes the route refuse with `unavailable` — never a guess.
import type { CommandEnvelope } from "@munim/contracts";
import type { OrdersPreviewRequest, OrdersPreviewResponse } from "@munim/contracts/orders";
type PreviewRequest = ReturnType<typeof OrdersPreviewRequest.parse>;
type PreviewResponse = ReturnType<typeof OrdersPreviewResponse.parse>;
import type { Context } from "hono";
import type { CommandContext, ExecuteResult } from "../../commit/index.ts";
import type { AppEnv } from "../../lib/types.ts";
import { ApiError } from "../../lib/errors.ts";
import type { Queryable } from "../../runtoken/index.ts";

/** One entry of T-021's `itemsForSale` (catalogue/menu.ts `MenuEntry`, read from the source): an item, or one of
 *  its active variants, with the price row in force for the outlet and channel kind. Only the fields storefront
 *  serves are named here. */
export interface SaleEntry {
  item_id: string;
  variant_id: string | null;
  kind: "dish" | "sku" | "combo";
  name_key: string;
  variant_name_key: string | null;
  category: string;
  price_minor: number;
  currency: string;
  available: boolean;
  option_groups: Array<{
    option_group_id: string;
    name_key: string;
    min_select: number;
    max_select: number;
    required: boolean;
    options: Array<{ option_id: string; name_key: string; price_delta_minor: number }>;
  }>;
}

export interface Seams {
  /** T-021 catalogue. */
  itemsForSale(tx: Queryable, outlet_id: string, channel_kind: string): Promise<SaleEntry[]>;
  /** T-022 orders: core's one pricing function; writes nothing. */
  previewOrder(ctx: CommandContext, request: PreviewRequest): Promise<PreviewResponse>;
  /** T-022 orders: place under executeCommand (the caller's `ctx.tx` may be an outer transaction). The order's
   *  `guest_access_hash` (sha256 bytes of the one-time token) must be stored on the order row it inserts —
   *  SEAM GAP: the brief's `placeOrder(ctx, command)` has no parameter for it, so it is the third argument. */
  placeOrder(ctx: CommandContext, command: CommandEnvelope, opts: { guest_access_hash: Buffer | null }): Promise<ExecuteResult>;
  /** T-035 accounts (accounts/index.ts): first sign-in at this merchant creates the profile by the customer's own
   *  customers.account.link.v1 in its OWN committed transaction, so it is called before the placement
   *  transaction. Returns the profile's customer_id. */
  ensureProfile(c: Context<AppEnv>, seed: { name: string; phone: string | null }): Promise<string>;
  /** T-028 customers: derived loyalty reversal on cancel, inside the cancel transaction. Optional. */
  loyaltyReverseFor?(tx: Queryable, order_id: string): Promise<void>;
}

export interface StorefrontConfig {
  /** The module's only clock, so deal windows and change windows are deterministic in gates. */
  clock: () => Date;
  seams: Partial<Seams>;
}

// Held on globalThis: the router is loaded by file URL (loadRouters) and a gate imports this module by path.
const KEY = Symbol.for("munim.storefront.config");
const g = globalThis as { [KEY]?: StorefrontConfig };
const state: StorefrontConfig = (g[KEY] ??= { clock: () => new Date(), seams: {} });

export function configureStorefront(patch: Partial<StorefrontConfig>): void {
  if (patch.clock) state.clock = patch.clock;
  if (patch.seams) state.seams = { ...state.seams, ...patch.seams };
}
export function resetStorefront(): void {
  state.clock = () => new Date();
  state.seams = {};
}
export const now = () => state.clock();

export function seam<K extends keyof Seams>(name: K): NonNullable<Seams[K]> {
  const s = state.seams[name];
  if (!s) throw new ApiError("unavailable");
  return s as NonNullable<Seams[K]>;
}
export const optionalSeam = <K extends "loyaltyReverseFor">(name: K) => state.seams[name];
