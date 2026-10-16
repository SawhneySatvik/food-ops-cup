// customers.campaign.record_sent.v1 (R67, founder 16 Oct; T-128): on a demo business the owner records a queued campaign as
// "Sent (simulated)". It sends nothing — Munim has no message path (R40 C6) and no provider (F-CH open) — it moves the book row
// queued → sent under the owner's own command, with the audit entry saying so. Refused on any other business (`demo_only`,
// lib/demo.ts). This is the one file of the module that names the sent status: test/customers.nosend.ts allows it here only,
// and still scans it for every send pattern.
import { CustomersCampaignRecordSentV1 } from "@munim/contracts/customers";
import type { CommandHandler, HandlerOutput } from "../../commit/index.ts";
import { isDemoTenant } from "../../lib/demo.ts";
import { ApiError } from "../../lib/errors.ts";

export const campaignRecordSent: CommandHandler = {
  type: "customers.campaign.record_sent.v1",
  async run(c, command): Promise<HandlerOutput> {
    const p = CustomersCampaignRecordSentV1.safeParse(command.payload);
    if (!p.success) throw new ApiError("invalid_payload");
    if (!(await isDemoTenant(c))) throw new ApiError("forbidden", "demo_only");
    const id = p.data.campaign_id;
    const r = await c.query(`UPDATE core.campaign SET status = 'sent' WHERE id = $1 AND status = 'queued'`, [id]);
    if (r.rowCount === 0) {
      const exists = await c.query(`SELECT 1 FROM core.campaign WHERE id = $1`, [id]);
      throw new ApiError(exists.rows[0] ? "illegal_transition" : "not_found");
    }
    return { entityId: id, audit: [{ entity: "core.campaign", entityId: id, before: { status: "queued" }, after: { status: "sent", simulated: true } }] };
  },
};
