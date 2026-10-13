"use client";
// POS session context: what the layout loaded once per navigation. Tenant and scope come from the session and core, never
// from the URL. Outlets here are only those with a registered POS device (the device numbers the bill).
import { createContext, useContext, type ReactNode } from "react";
import type { FormatSpec } from "@munim/ui";

export interface PosOutlet { id: string; name: string; tz: string; deviceId: string; invoiceSeries: string | null }
export interface PosSession {
  tenant: { name: string; isDemo: boolean };
  member: { name: string };
  country: string;
  outlets: PosOutlet[];
  /** The counter channel id; null when the business has none (then nothing can be sold). */
  counterChannelId: string | null;
  initialOutletId: string | null;
}

const Ctx = createContext<PosSession | null>(null);
export const PosProvider = ({ session, children }: { session: PosSession; children: ReactNode }) => <Ctx.Provider value={session}>{children}</Ctx.Provider>;
export function usePos(): PosSession {
  const v = useContext(Ctx);
  if (!v) throw new Error("usePos outside the POS layout");
  return v;
}
export const formatSpec = (s: PosSession, outletId: string | null): FormatSpec => ({
  country: s.country,
  tz: s.outlets.find((o) => o.id === outletId)?.tz ?? s.outlets[0]?.tz ?? "UTC",
});
