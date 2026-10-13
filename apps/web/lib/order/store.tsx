"use client";
// Per-storefront client state: which outlet, and the cart (localStorage, ids only). Outlets come from the server layout
// (it already proved the key). The cart survives a reload and an offline spell: S-off says so.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { EMPTY_CART, loadCart, newLine, readRefusal, saveCart, storefrontClient, type Cart, type Menu, type Outlet, type Refusal } from "./api.ts";

export interface StoreValue {
  storeKey: string;
  /** null = the outlets call failed (S-err). */
  outlets: Outlet[] | null;
  payMethods: readonly string[] | null;
  outlet: Outlet | null;
  ready: boolean;
  cart: Cart;
  selectOutlet: (outletId: string) => void;
  addLine: (itemId: string, variantId: string | null, optionIds: string[]) => void;
  setQty: (lineId: string, qtyMilli: number) => void;
  removeLine: (lineId: string) => void;
  setWindow: (windowId: string | null) => void;
  setCoupons: (codes: string[]) => void;
  setAttempt: (attempt: Cart["attempt"]) => void;
  clearCart: () => void;
  removeItem: (itemId: string) => void;
}

const Ctx = createContext<StoreValue | null>(null);
export function useStore(): StoreValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useStore outside /order/[key]");
  return v;
}

export function OrderProvider({ storeKey, outlets, payMethods, children }: {
  storeKey: string; outlets: Outlet[] | null; payMethods: readonly string[] | null; children: ReactNode;
}) {
  const [cart, setCart] = useState<Cart>(EMPTY_CART);
  const [ready, setReady] = useState(false);
  useEffect(() => { setCart(loadCart(storeKey)); setReady(true); }, [storeKey]);
  useEffect(() => { if (ready) saveCart(storeKey, cart); }, [storeKey, cart, ready]);

  const outlet = outlets?.find((o) => o.outlet_id === cart.outletId) ?? outlets?.[0] ?? null;
  // Any change to what would be sent starts a new attempt (kit 10 §2): the old ids must never meet a different body.
  const change = useCallback((fn: (c: Cart) => Cart) => setCart((c) => ({ ...fn(c), attempt: null })), []);

  const value = useMemo<StoreValue>(() => ({
    storeKey, outlets, payMethods, outlet, ready, cart,
    selectOutlet: (outletId) => setCart((c) => (outletId === (c.outletId ?? outlets?.[0]?.outlet_id) ? c : { ...EMPTY_CART, outletId })),
    addLine: (itemId, variantId, optionIds) => change((c) => {
      const same = c.lines.find((l) => l.itemId === itemId && l.variantId === variantId && l.optionIds.length === optionIds.length && l.optionIds.every((o) => optionIds.includes(o)));
      const outletId = c.outletId ?? outlet?.outlet_id ?? null;
      return same
        ? { ...c, outletId, lines: c.lines.map((l) => (l === same ? { ...l, qtyMilli: l.qtyMilli + 1000 } : l)) }
        : { ...c, outletId, lines: [...c.lines, newLine(itemId, variantId, optionIds)] };
    }),
    setQty: (lineId, qtyMilli) => change((c) => ({ ...c, lines: c.lines.map((l) => (l.lineId === lineId ? { ...l, qtyMilli } : l)) })),
    removeLine: (lineId) => change((c) => ({ ...c, lines: c.lines.filter((l) => l.lineId !== lineId) })),
    removeItem: (itemId) => change((c) => ({ ...c, lines: c.lines.filter((l) => l.itemId !== itemId) })),
    setWindow: (windowId) => change((c) => ({ ...c, windowId })),
    setCoupons: (coupons) => change((c) => ({ ...c, coupons })),
    setAttempt: (attempt) => setCart((c) => ({ ...c, attempt })),
    clearCart: () => setCart((c) => ({ ...EMPTY_CART, outletId: c.outletId })),
  }), [storeKey, outlets, payMethods, outlet, ready, cart, change]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export type MenuState =
  | { kind: "load" }
  | { kind: "ok"; menu: Menu }
  | { kind: "off"; menu: Menu | null }
  | { kind: "err"; refusal: Refusal | null; menu: Menu | null };

/** The outlet's menu, re-read every `everyMs` while mounted (kit 20 §5 step 2). A failed refresh keeps the last menu. */
export function useMenu(storeKey: string, outletId: string | null, everyMs: number | null): { state: MenuState; reload: () => void } {
  const [state, setState] = useState<MenuState>({ kind: "load" });
  const [tick, setTick] = useState(0);
  useEffect(() => setState({ kind: "load" }), [outletId]);
  useEffect(() => {
    if (!outletId) return;
    let live = true;
    const run = async () => {
      try {
        const { data, response, error } = await storefrontClient(storeKey).GET("/v1/storefront/outlets/{outlet_id}/menu", { params: { path: { outlet_id: outletId } } });
        if (!live) return;
        if (data) setState({ kind: "ok", menu: data });
        else setState((s) => ({ kind: "err", refusal: readRefusal(response, error), menu: "menu" in s ? s.menu : null }));
      } catch {
        if (live) setState((s) => ({ kind: "off", menu: "menu" in s ? s.menu : null }));
      }
    };
    void run();
    const timer = everyMs ? setInterval(() => void run(), everyMs) : undefined;
    return () => { live = false; if (timer) clearInterval(timer); };
  }, [storeKey, outletId, everyMs, tick]);
  return { state, reload: () => { setState({ kind: "load" }); setTick((n) => n + 1); } };
}
