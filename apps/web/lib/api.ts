// Browser-side API access. Every call goes to the same-origin proxy (/api/v1/…), which attaches the session from
// httpOnly cookies; browser code never sees a token. Storefront pages pass their key per call
// (`createMunimClient({ baseUrl: API_BASE, storefrontKey })`), and the proxy then attaches no member credential.
import { createMunimClient, uuidv7, type MunimClient } from "@munim/sdk";
import type { SnapshotSource } from "@munim/ui";
import type { Snapshot } from "@munim/contracts/shared";

export const API_BASE = "/api";

/** The member client: no token here — the proxy adds it. Call from effects and handlers, not during render. */
export const api: MunimClient = createMunimClient({ baseUrl: API_BASE });

/** One key per user intent: a retry after S-off resends the SAME key (03-arch §1.6); a new tap makes a new one. */
export const newIdempotencyKey = (): string => uuidv7();

/** GET /v1/snapshots/{id} for the Rows drawer: null on 404/403 (missing, another tenant's, wider than the viewer's
 *  scope — all "cannot verify"), throws on anything else so the drawer can offer a retry. */
export const snapshotSource: SnapshotSource = async (id) => {
  const { data, response } = await api.GET("/v1/snapshots/{id}", { params: { path: { id } } });
  if (data) return data as unknown as Snapshot;
  if (response.status === 404 || response.status === 403) return null;
  throw new Error(`snapshot ${response.status}`);
};
