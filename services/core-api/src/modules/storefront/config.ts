// Module wiring. The cross-module seams (W2-LANE-BRIEF) default to their owners' real functions, imported through
// each owner's index.ts (W2 B4): orders' pricing and placement on storefront's own transaction (so guest checkout
// stays ONE transaction), catalogue's menu, accounts' first-sign-in profile. A gate may replace one with
// `configureStorefront`; the default path has no fakes.
import type { CommandEnvelope } from "@munim/contracts";
import type { OrdersPreviewRequest, OrdersPreviewResponse } from "@munim/contracts/orders";
import type { Context } from "hono";
import { type CommandContext, executeCommand, type ExecuteResult } from "../../commit/index.ts";
import type { AppEnv } from "../../lib/types.ts";
import type { Queryable } from "../../runtoken/index.ts";
import { ensureProfile } from "../accounts/index.ts";
import { itemsForSale } from "../catalogue/index.ts";
import { placeHandler, previewIn } from "../orders/index.ts";
import type { CustomerPrincipal } from "./checkout.ts";
type PreviewRequest = ReturnType<typeof OrdersPreviewRequest.parse>;
type PreviewResponse = ReturnType<typeof OrdersPreviewResponse.parse>;

/** One entry of T-021's `itemsForSale` (catalogue/menu.ts `MenuEntry`): an item, or one of its active variants,
 *  with the price row in force for the outlet and channel kind. Only the fields storefront serves are named. */
export interface SaleEntry {
  item_id: string;
  variant_id: string | null;
  kind: string;
  name_key: string;
  variant_name_key: string | null;
  category: string;
  brand_id: string | null;
  /** 0029 display text (plain text; null = not set) and diet mark. */
  display_name: string | null;
  description: string | null;
  diet: "veg" | "non_veg" | "egg" | "vegan" | null;
  variant_display_name: string | null;
  variant_description: string | null;
  price_minor: number;
  currency: string;
  available: boolean;
  option_groups: Array<{
    option_group_id: string;
    name_key: string;
    display_name: string | null;
    description: string | null;
    min_select: number;
    max_select: number;
    required: boolean;
    options: Array<{ option_id: string; name_key: string; display_name: string | null; description: string | null; price_delta_minor: number }>;
  }>;
}

export interface Seams {
  /** T-021 catalogue, judged at the storefront's clock. */
  itemsForSale(tx: Queryable, outlet_id: string, channel_kind: string, opts: { at: Date }): Promise<SaleEntry[]>;
  /** T-022 orders: core's one pricing function on the caller's transaction; writes nothing. */
  previewOrder(c: Queryable, principal: CustomerPrincipal, request: PreviewRequest): Promise<PreviewResponse>;
  /** T-022 orders: orders.place.v1 under `ctx` (storefront's transaction, after the guest's own command).
   *  `guestAccessHash` = hex sha256 of the one-time token storefront issued; null for a signed-in customer. */
  placeOrder(ctx: CommandContext, principal: CustomerPrincipal, command: CommandEnvelope, guestAccessHash: string | null): Promise<ExecuteResult>;
  /** T-035 accounts: first sign-in at this merchant creates the profile by the customer's own
   *  customers.account.link.v1 in its OWN committed transaction, so it is called before the placement
   *  transaction. Returns the profile's customer_id. */
  ensureProfile(c: Context<AppEnv>, seed: { name: string; phone: string | null }): Promise<string>;
}

const REAL: Seams = {
  itemsForSale: async (tx, outlet_id, channel_kind, opts) => (await itemsForSale(tx, outlet_id, channel_kind, opts)).entries,
  previewOrder: previewIn,
  placeOrder: (ctx, principal, command, guestAccessHash) => executeCommand(ctx, command, placeHandler(principal, guestAccessHash)),
  ensureProfile,
};

export interface StorefrontConfig {
  /** The module's only clock, so deal windows and change windows are deterministic in gates. */
  clock: () => Date;
  /** Overrides only; a seam not named here is its owner's real function. */
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

export function seam<K extends keyof Seams>(name: K): Seams[K] {
  return (state.seams[name] ?? REAL[name]) as Seams[K];
}
