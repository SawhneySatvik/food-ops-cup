"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api.ts";
import { settle, type MenuEntry } from "./logic.ts";

export type MenuState = { status: "load" } | { status: "ok"; entries: MenuEntry[] } | { status: "deny" } | { status: "err" } | { status: "off" };

/** The counter menu for one outlet: the price rows in force now, options, sold-out flags. A 404/403 means the outlet is
 *  outside the member's scope (core hides it), shown as S-deny. */
export function useMenu(outletId: string | null): { menu: MenuState; reload: () => void } {
  const [menu, setMenu] = useState<MenuState>({ status: "load" });
  const [n, setN] = useState(0);
  const reload = useCallback(() => setN((x) => x + 1), []);
  useEffect(() => {
    if (!outletId) return;
    let live = true;
    setMenu({ status: "load" });
    void settle(() => api.GET("/v1/catalogue/menu", { params: { query: { outlet: outletId, channel_kind: "counter" } } })).then((r) => {
      if (!live) return;
      const res = r as { data?: { entries: MenuEntry[] }; response?: Response };
      if (res.data) setMenu({ status: "ok", entries: res.data.entries });
      else if (!res.response) setMenu({ status: "off" });
      else setMenu({ status: res.response.status === 404 || res.response.status === 403 ? "deny" : "err" });
    });
    return () => { live = false; };
  }, [outletId, n]);
  return { menu, reload };
}
