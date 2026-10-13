// lib/munim/storage.ts: from 01-api-client.md
// Browser storage for the guest token, the cart and the checkout attempt. Every call survives blocked storage
// (Safari private mode): it then returns null / does nothing.
import type { Attempt, Cart } from "./checkout";

function get(store: "local" | "session", key: string): string | null {
  try {
    return (store === "local" ? localStorage : sessionStorage).getItem(key);
  } catch {
    return null;
  }
}
function set(store: "local" | "session", key: string, value: string | null): boolean {
  try {
    const s = store === "local" ? localStorage : sessionStorage;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export const saveGuestToken = (orderId: string, token: string): boolean => set("local", `munim.guest.${orderId}`, token);
export const loadGuestToken = (orderId: string): string | null => get("local", `munim.guest.${orderId}`);

export const saveCart = (cart: Cart): boolean => set("local", `munim.cart.${cart.outletId}`, JSON.stringify(cart));
export function loadCart(outletId: string): Cart | null {
  const raw = get("local", `munim.cart.${outletId}`);
  try {
    return raw ? (JSON.parse(raw) as Cart) : null;
  } catch {
    return null;
  }
}
export const clearCart = (outletId: string): boolean => set("local", `munim.cart.${outletId}`, null);

export const saveAttempt = (outletId: string, a: Attempt): boolean => set("session", `munim.attempt.${outletId}`, JSON.stringify(a));
export function loadAttempt(outletId: string): Attempt | null {
  const raw = get("session", `munim.attempt.${outletId}`);
  try {
    return raw ? (JSON.parse(raw) as Attempt) : null;
  } catch {
    return null;
  }
}
export const clearAttempt = (outletId: string): boolean => set("session", `munim.attempt.${outletId}`, null);
