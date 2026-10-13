// Storefront plumbing (T-063): the keyed client, the guest-token and cart stores in localStorage, and the typed reading of
// a refusal. Browser code calls the same-origin proxy (/api/v1/…); with X-Munim-Storefront-Key present the proxy adds no
// member credential. The key rides as a header only; the guest token is never put in a URL (kit 10 §1).
import { createMunimClient, uuidv7, type MunimClient, type Schemas } from "@munim/sdk";
import { API_BASE } from "../api.ts";

export type Menu = Schemas["StorefrontMenuResponse"];
export type MenuItem = Menu["items"][number];
export type Outlet = Schemas["StorefrontOutletsResponse"]["outlets"][number];
export type Preview = Schemas["StorefrontPreviewResponse"];
export type PickupWindow = Schemas["StorefrontPickupWindowsResponse"]["windows"][number];
export type OrderView = Schemas["StorefrontOrderView"];
export type CaresItem = Schemas["V1StorefrontCares"]["items"][number];

export const storefrontClient = (storeKey: string): MunimClient => createMunimClient({ baseUrl: API_BASE, storefrontKey: storeKey });
export const trackingClient = (storeKey: string, guestToken: string): MunimClient =>
  createMunimClient({ baseUrl: API_BASE, storefrontKey: storeKey, guestToken });

// ---- guest token: persisted BEFORE anything renders (it is returned once; a replay returns null).
const guestKey = (orderId: string) => `munim.guest.${orderId}`;
export const saveGuestToken = (orderId: string, token: string) => localStorage.setItem(guestKey(orderId), token);
export const readGuestToken = (orderId: string): string | null => localStorage.getItem(guestKey(orderId));

// ---- cart. Ids only: names and prices are never stored, they come from the menu and the preview.
export type CartLine = { lineId: string; itemId: string; variantId: string | null; optionIds: string[]; qtyMilli: number };
/** Ids and keys of ONE checkout attempt. A retry after S-off resends them unchanged; any change makes a new attempt. */
export type Attempt = { sig: string; orderId: string; orderCmd: string; orderKey: string; guestCmd: string; guestKey: string; consentAt: string };
export type Cart = { outletId: string | null; lines: CartLine[]; windowId: string | null; coupons: string[]; attempt: Attempt | null };
export const EMPTY_CART: Cart = { outletId: null, lines: [], windowId: null, coupons: [], attempt: null };

const cartKey = (storeKey: string) => `munim.cart.${storeKey}`;
export function loadCart(storeKey: string): Cart {
  try {
    const raw = JSON.parse(localStorage.getItem(cartKey(storeKey)) ?? "null") as Partial<Cart> | null;
    return raw && Array.isArray(raw.lines) ? { ...EMPTY_CART, ...raw } : EMPTY_CART;
  } catch {
    return EMPTY_CART;
  }
}
export const saveCart = (storeKey: string, cart: Cart) => localStorage.setItem(cartKey(storeKey), JSON.stringify(cart));

export const newLine = (itemId: string, variantId: string | null, optionIds: string[]): CartLine =>
  ({ lineId: uuidv7(), itemId, variantId, optionIds, qtyMilli: 1000 });
export const newAttempt = (sig: string): Attempt => ({
  sig, orderId: uuidv7(), orderCmd: uuidv7(), orderKey: uuidv7(), guestCmd: uuidv7(), guestKey: uuidv7(), consentAt: new Date().toISOString(),
});

// ---- refusals. Core's 409/422 body is { error: { code, message, reason_code }, params? }; a preview refusal is a 200 entry.
export type RefusalParams = {
  line_no?: number; item_id?: string; variant_id?: string | null; deal_id?: string; code?: string; min_spend_minor?: number; shortfall_minor?: number;
  old_total_minor?: number; new_total_minor?: number; currency?: string;
};
export type Refusal = { status: number; code: string | null; reason: string | null; params: RefusalParams; retryAfter: number | null };

export function readRefusal(response: Response, body: unknown): Refusal {
  const b = (body ?? {}) as { error?: { code?: unknown; reason_code?: unknown }; params?: RefusalParams };
  const ra = Number(response.headers.get("Retry-After"));
  return {
    status: response.status,
    code: typeof b.error?.code === "string" ? b.error.code : null,
    reason: typeof b.error?.reason_code === "string" ? b.error.reason_code : null,
    params: b.params ?? {},
    retryAfter: Number.isFinite(ra) && ra > 0 ? Math.min(ra, 60) : null,
  };
}

export const isOffline = (e: unknown) => e instanceof TypeError;
