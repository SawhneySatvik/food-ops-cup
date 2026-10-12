// Per-action declarations the transform needs and the contracts do not carry: which uuid leaves are new-entity ids
// the tool layer mints (ADR-014 §5.5), which are snapshot / finding ids, and which the tool layer fills. Read off each
// pack's §6 table: a `create` / `schedule` / `draft` / `adjust` / `close` / `set` command whose row is new mints its own
// id; `deal.end` and `coupon.set` ("tightens a leaking coupon") act on an existing row. Pointers use `*` for array
// elements. The generator fails if a pointer names no uuid leaf, so a contract rename cannot silently drop one.
import type { LeafOverrides } from "./transform.ts";

/** ADR-014 §5.1: `imports.*` drafts are produced only by the import workflows (R28). */
// purchasing.invoice.record.v1 is a workflow draftable (DECISIONS 11 Oct, W3.2): emitted by ingestion code, never a model tool.
// catalogue.coupon.set.v1 and customers.campaign.create.v1 have no model path until pack §6's executable tightening and a
// finding-scoped audience land (R-B S1-B, S1-D); a member still sets coupons and creates campaigns directly.
export const NOT_AGENT_EXPOSED = [
  "imports.format.approve.v1", "imports.run.commit.v1", "purchasing.invoice.record.v1", "catalogue.coupon.set.v1", "customers.campaign.create.v1",
  // ADR-015: Cares listing drafts are emitted by deterministic mapping code (expiry_risk), never a model tool; cooked lines
  // only through the owner's own command.
  "cares.listing.publish.v1",
] as const;

export const ACTION_LEAVES: Record<string, LeafOverrides> = {
  "catalogue.price.set.v1": { minted: ["/price_id"] },
  "catalogue.recipe.version.create.v1": { minted: ["/recipe_version_id"] },
  "catalogue.deal.end.v1": {},
  "catalogue.coupon.set.v1": {},
  "compliance.maintenance.schedule.v1": { minted: ["/maintenance_id"] },
  "customers.campaign.create.v1": { minted: ["/campaign_id"], snapshot: ["/segment_snapshot_id"] },
  "finance.dispute.draft.v1": { minted: ["/dispute_id"] },
  "finance.journal.adjust.v1": { minted: ["/journal_entry_id"] },
  "finance.period.close.v1": { minted: ["/period_close_id"] },
  "goals.goal.create.v1": { minted: ["/goal_id"], snapshot: ["/basis_snapshot_id"] },
  // cares_listing_id is set by the people overstaffed_slot mapping (ADR-015 §4), never by a model: the propose tool sends null.
  "goals.task.create.v1": { minted: ["/task_id"], finding: ["/finding_id"], fixed: ["/cares_listing_id"] },
  "cares.listing.publish.v1": { minted: ["/listing_id", "/lines/*/line_id"] },
  "inventory.reorder_level.set.v1": {},
  "inventory.transfer.create.v1": { minted: ["/transfer_id"] },
  "kitchen.prep_list.create.v1": { minted: ["/prep_list_id"] },
  "kitchen.prep_time.set.v1": {},
  "people.payroll_draft.create.v1": { minted: ["/payroll_draft_id"] },
  "people.roster.create.v1": { minted: ["/roster_id", "/shifts/*/roster_shift_id"] },
  "purchasing.invoice.dispute.v1": { minted: ["/dispute_id"] },
  // negotiation_run_id is set by the negotiation workflow (T-055), never by a model; until then the tool sends null.
  "purchasing.po.create.v1": { minted: ["/po_id"], fixed: ["/negotiation_run_id"] },
  "purchasing.supplier_return.create.v1": { minted: ["/supplier_return_id"] },
  "imports.format.approve.v1": {},
  "imports.run.commit.v1": {},
  "purchasing.invoice.record.v1": { minted: ["/supplier_invoice_id", "/lines/*/line_id"] },
};

/** Arguments a propose tool takes besides the payload fields (names a payload may not use). */
export const PROPOSE_EXTRA: Record<string, Record<string, unknown>> = {
  based_on: {
    type: "array",
    description: "Handles of the snapshot cells this proposal assumes, e.g. S1.r0.<column>; re-checked when a person approves.",
    items: { type: "string" },
    minItems: 1,
    maxItems: 50,
  },
  finding: { type: ["string", "null"], description: "Handle of the finding this proposal answers, e.g. F1, or null." },
};

/** Arguments a read tool takes besides the template params. */
export const READ_EXTRA: Record<string, Record<string, unknown>> = {
  page: { type: "integer", description: "Page of rows to show, 0 first (50 rows a page). Re-reads the stored snapshot; past page 2, narrow the parameters instead." },
};
