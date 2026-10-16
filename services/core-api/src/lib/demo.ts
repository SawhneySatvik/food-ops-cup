// R67 (founder, 16 Oct 2026, T-128): the one place core decides what only a demo business may do with customer campaigns.
// A demo business (core.tenant.is_demo, set only by the platform operator: tenancy.provision.v1 / demo.session.start.v1) holds
// synthetic customers only, so there:
//   - the customers specialist's win-back campaign draft is admitted without a marketing-consent audience: its audience is the
//     at-risk count of the finding's own churn segment (campaignAudienceScoped, read by internal/drafts.ts);
//   - the owner may record a queued campaign as "Sent (simulated)" — no message ever leaves Munim (customers/campaign-sent.ts).
// On every other business the 11 Oct ruling (R-B S1-D) stands: intel campaign drafts are refused (campaign_audience_unscoped)
// and no command records a campaign as sent.
import { parseRef } from "@munim/contracts";
import type { Queryable } from "../runtoken/index.ts";

/** The business in the transaction's context (app.tenant_id) is a demo business. Read inside the caller's transaction. */
export async function isDemoTenant(c: Queryable): Promise<boolean> {
  const r = await c.query<{ is_demo: boolean }>(`SELECT is_demo FROM core.tenant WHERE tenant_id = current_setting('app.tenant_id')::uuid`);
  return r.rows[0]?.is_demo === true;
}

/** A campaign draft's audience is admitted only when all hold: a demo business; one target outlet; `audience_count` is the
 *  `at_risk_count` cell of the Σ row (customer_id null) of a `customers.churn_segments` snapshot minted for that outlet; and
 *  `segment_snapshot_id` is that same snapshot — so the campaign names the finding's at-risk customers and nobody else. */
export async function campaignAudienceScoped(c: Queryable, draft: { outlet_ids: readonly string[]; payload: unknown }): Promise<boolean> {
  if (!(await isDemoTenant(c))) return false;
  const p = draft.payload as { audience_count?: unknown; segment_snapshot_id?: unknown } | null;
  const ref = typeof p?.audience_count === "string" ? parseRef(p.audience_count) : null;
  if (ref?.kind !== "snap" || draft.outlet_ids.length !== 1) return false;
  const at = ref as { snapshot_id: string; row: number; column: string };
  if (at.column !== "at_risk_count" || at.snapshot_id !== p?.segment_snapshot_id) return false;
  const s = await c.query<{ template_id: string; outlet: string | null; row: Record<string, unknown> | null }>(
    `SELECT template_id, params ->> 'outlet_id' AS outlet, rows -> $2::int AS row FROM evidence.snapshot WHERE id = $1`, [at.snapshot_id, at.row]);
  const x = s.rows[0];
  return x?.template_id === "customers.churn_segments" && x.outlet === draft.outlet_ids[0] && x.row !== null && "customer_id" in x.row && x.row.customer_id === null;
}
