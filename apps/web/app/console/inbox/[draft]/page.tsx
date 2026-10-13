// /console/inbox/[draft] — C2 draft detail. The server half resolves who is signing in as a member id: an edited value
// must carry `typed_by` = the approver's own member id (contracts shared/draft.ts), and only GET /v1/members (owner) maps
// the session to it. A manager gets 403 there, so Edit stays hidden for them (gap reported: no route returns the
// caller's own member id). Tenant and scope come from the session, never from the URL.
import { serverClient } from "../../../../lib/core.ts";
import "../../../../lib/console-home/console-home.css";
import { DraftDetail, type Me } from "../../../../lib/console-home/draft-detail.tsx";
import { getSession } from "../../../../lib/session/index.ts";

export const dynamic = "force-dynamic";

export default async function DraftPage({ params }: { params: Promise<{ draft: string }> }) {
  const { draft } = await params;
  const s = await getSession();
  const members = s ? (await serverClient(s.token, s.tenantId).GET("/v1/members")).data?.members ?? [] : [];
  const mine = members.find((m) => m.email === s?.email);
  const me: Me = { id: mine?.id ?? null, name: mine?.name ?? s?.email ?? "" };
  const names = Object.fromEntries(members.flatMap((m) => (m.name ? [[m.id, m.name]] : [])));
  return <DraftDetail draftId={draft} me={me} names={names} />;
}
