"use client";
// Small client hooks shared by the pages: online state, the per-outlet cart, countdowns and the debounced preview.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { munim } from "./munim";
import type { MunimError } from "./munim/client";
import { ASAP, previewRequest, type Cart } from "./munim/checkout";
import { loadCart, saveCart } from "./munim/storage";
import type { Schemas } from "./munim/types";

type Menu = Schemas["StorefrontMenuResponse"];
type Preview = Schemas["StorefrontPreviewResponse"];

const subscribeOnline = (cb: () => void) => {
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  return () => {
    window.removeEventListener("online", cb);
    window.removeEventListener("offline", cb);
  };
};
/** navigator.onLine, live (true on the server). */
export const useOnline = (): boolean => useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);

const emptyCart = (outletId: string): Cart => ({ outletId, lines: [], slot: ASAP, couponCodes: [] });

/** The cart for one outlet, kept in localStorage (ids and counts only). `ready` is false until it has been read. */
export function useCart(outletId: string) {
  const [cart, setCartState] = useState<Cart>(() => emptyCart(outletId));
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const saved = loadCart(outletId);
    // Carts saved before notes existed get note: null.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage is only readable after hydration
    setCartState(saved ? { ...saved, lines: saved.lines.map((l) => ({ ...l, note: l.note ?? null })) } : emptyCart(outletId));
    setReady(true);
  }, [outletId]);
  const setCart = useCallback((next: Cart | ((c: Cart) => Cart)) => {
    setCartState((prev) => {
      const value = typeof next === "function" ? next(prev) : next;
      saveCart(value);
      return value;
    });
  }, []);
  return { cart, setCart, ready };
}

/** Seconds left until `untilMs` (a Date.now() value); calls onDone once when it reaches zero. The clock is read
 *  only in timers, never during render (prerendering forbids unstable values). */
export function useCountdown(untilMs: number | null, onDone?: () => void): number {
  const [left, setLeft] = useState(0);
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  });
  useEffect(() => {
    if (untilMs === null) return;
    const tick = () => {
      const ms = untilMs - Date.now();
      setLeft(Math.max(0, Math.ceil(ms / 1000)));
      if (ms <= 0) {
        clearInterval(t);
        done.current?.();
      }
    };
    const first = setTimeout(tick, 0);
    const t = setInterval(tick, 250);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [untilMs]);
  return untilMs === null ? 0 : left;
}

export interface PreviewState {
  preview: Preview | null;
  loading: boolean;
  error: MunimError | null;
}

/** Re-prices the cart 300 ms after each change; responses older than the latest request are ignored. */
export function usePreview(cart: Cart, menu: Menu | null, enabled: boolean, bump = 0): PreviewState {
  const [state, setState] = useState<PreviewState>({ preview: null, loading: false, error: null });
  const seq = useRef(0);
  const key = JSON.stringify([cart.outletId, cart.lines.map((l) => [l.itemId, l.variantId, l.optionIds, l.qty]), cart.slot, cart.couponCodes, bump]);
  useEffect(() => {
    if (!enabled || !menu || cart.lines.length === 0) {
      seq.current++;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing the preview when the cart empties
      setState({ preview: null, loading: false, error: null });
      return;
    }
    const mine = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    const t = setTimeout(async () => {
      const r = await munim.previewOrder(previewRequest(cart, menu));
      if (mine !== seq.current) return;
      setState(r.ok ? { preview: r.data, loading: false, error: null } : { preview: null, loading: false, error: r.error });
    }, 300);
    return () => clearTimeout(t);
    // `key` captures every input that changes the price.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, menu]);
  return state;
}
