import { packFor } from "@munim/ui";
import { redirect } from "next/navigation";
import { KdsBoard, type KdsOutlet } from "../../lib/kds/board.tsx";
import { serverClient } from "../../lib/core.ts";
import { getSession, tokenSource } from "../../lib/session/index.ts";
import "./kds.css";

export const dynamic = "force-dynamic";
export const metadata = { title: "Munim KDS" };

// The KDS is its own screen (no console chrome). Which outlets this member may see is not exposed by any member route
// (managers cannot read /v1/members), so each outlet is probed: the board answers 404 outside the token's scope (GAP).
export default async function KdsPage({ searchParams }: { searchParams: Promise<{ outlet?: string }> }) {
  const s = await getSession();
  if (!s || !s.tenantId) redirect(tokenSource.signInPath);
  const api = serverClient(s.token, s.tenantId);
  const [tenant, outlets] = await Promise.all([api.GET("/v1/tenant"), api.GET("/v1/outlets")]);
  if (!tenant.data || !outlets.data) redirect(tokenSource.signInPath);
  const probed = await Promise.all(outlets.data.outlets.filter((o) => o.kind !== "store").map(async (o) => {
    const { response } = await api.GET("/v1/kitchen/board", { params: { query: { outlet: o.id } } });
    return response.ok ? o : null;
  }));
  const visible: KdsOutlet[] = probed.flatMap((o) => (o ? [{ id: o.id, name: o.name, tz: o.tz }] : []));
  const wanted = (await searchParams).outlet ?? s.outletId;
  const outletId = visible.find((o) => o.id === wanted)?.id ?? visible[0]?.id ?? null;
  return <KdsBoard outlets={visible} outletId={outletId} country={tenant.data.country_code} fallbackTz={packFor(tenant.data.country_code).default_timezone} />;
}
