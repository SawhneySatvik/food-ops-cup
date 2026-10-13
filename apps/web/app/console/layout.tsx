import { packFor } from "@munim/ui";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { aiEnabled } from "../../lib/ai.ts";
import { ConsoleChrome } from "../../lib/console/chrome.tsx";
import { ConsoleProvider, type ConsoleSession, type Role } from "../../lib/console/context.tsx";
import { serverClient } from "../../lib/core.ts";
import { getSession, tokenSource } from "../../lib/session/index.ts";
import "./console.css";

export const dynamic = "force-dynamic";

// The console shell: loads the business, the member's scope and the inbox list once per navigation; pages under
// /console read them from useConsole(). Tenant and scope come from the session, never from the URL.
export default async function ConsoleLayout({ children }: { children: ReactNode }) {
  const s = await getSession();
  if (!s || !s.tenantId) redirect(tokenSource.signInPath);
  const api = serverClient(s.token, s.tenantId);
  const [tenant, outlets, mine, members, inbox, ai] = await Promise.all([
    api.GET("/v1/tenant"),
    api.GET("/v1/outlets"),
    api.GET("/v1/me/tenants"),
    api.GET("/v1/members"),
    api.GET("/v1/inbox", { params: { query: { limit: 50 } } }),
    aiEnabled(),
  ]);
  if (!tenant.data || !outlets.data) redirect(tokenSource.signInPath);

  const role = (mine.data?.tenants.find((x) => x.tenant_id === s.tenantId)?.role ?? "staff") as Role;
  const me = members.data?.members.find((m) => m.email === s.email);
  // The switch offers only outlets known to be in the member's scope: an owner's empty outlet_ids is the whole
  // business. Managers cannot read /v1/members (403) and /v1/outlets lists every outlet, so with no own row the switch
  // fails closed to "All outlets" alone — core still narrows every read to the token's real scope. (GAP, reported: no
  // member route returns the caller's own outlet_ids.)
  const scopeIds = role === "owner" ? [] : me ? me.outlet_ids : null;
  const inScope = scopeIds === null ? [] : outlets.data.outlets.filter((o) => scopeIds.length === 0 || scopeIds.includes(o.id));
  const outletId = inScope.some((o) => o.id === s.outletId) ? s.outletId : null;
  const pack = packFor(tenant.data.country_code);
  const tz = inScope.find((o) => o.id === outletId)?.tz ?? tenant.data.home_tz ?? pack.default_timezone;

  const session: ConsoleSession = {
    tenant: { id: tenant.data.tenant_id, name: tenant.data.name, isDemo: tenant.data.is_demo },
    member: { name: me?.name ?? s.email ?? "", role },
    format: { country: tenant.data.country_code, tz },
    outlets: inScope,
    outletId,
    inbox: inbox.data ? { items: inbox.data.items, nextCursor: inbox.data.next_cursor } : null,
    aiEnabled: ai,
  };
  return (
    <ConsoleProvider session={session}>
      <ConsoleChrome />
      <main className="console-main" id="main">{children}</main>
    </ConsoleProvider>
  );
}
