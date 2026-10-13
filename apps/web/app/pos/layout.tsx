import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { PosProvider, type PosSession } from "../../lib/pos/context.tsx";
import { serverClient } from "../../lib/core.ts";
import { getSession, tokenSource } from "../../lib/session/index.ts";
import { PosChrome } from "./chrome.tsx";
import "./pos.css";

export const dynamic = "force-dynamic";

// The POS shell. Core lists every outlet to a manager but 404s the menu of those outside their scope (T-060 gap: no
// route returns the caller's own outlet_ids), so the counter's outlets are the ones with a registered POS device —
// core scopes /v1/devices to the caller. Tenant and scope come from the session, never from the URL.
export default async function PosLayout({ children }: { children: ReactNode }) {
  const s = await getSession();
  if (!s || !s.tenantId) redirect(tokenSource.signInPath);
  const api = serverClient(s.token, s.tenantId);
  const [tenant, outlets, devices, channels] = await Promise.all([
    api.GET("/v1/tenant"), api.GET("/v1/outlets"), api.GET("/v1/devices"), api.GET("/v1/channels"),
  ]);
  if (!tenant.data || !outlets.data) redirect(tokenSource.signInPath);

  const posOutlets = outlets.data.outlets.flatMap((o) => {
    const d = devices.data?.devices.find((x) => x.outlet_id === o.id && x.kind === "pos");
    return d ? [{ id: o.id, name: o.name, tz: o.tz, deviceId: d.id, invoiceSeries: d.invoice_series }] : [];
  });
  const session: PosSession = {
    tenant: { name: tenant.data.name, isDemo: tenant.data.is_demo },
    member: { name: s.email ?? "" },
    country: tenant.data.country_code,
    outlets: posOutlets,
    counterChannelId: channels.data?.channels.find((c) => c.kind === "counter" && c.active)?.id ?? null,
    initialOutletId: posOutlets.find((o) => o.id === s.outletId)?.id ?? posOutlets[0]?.id ?? null,
  };
  return (
    <PosProvider session={session}>
      <PosChrome />
      <main className="pos-main" id="main">{children}</main>
    </PosProvider>
  );
}
