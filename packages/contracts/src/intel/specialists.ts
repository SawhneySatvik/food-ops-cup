// The specialist registry (ledger R45 F8, ADR-014 §3.2). Data, not behaviour: who is on the team, which
// desk they sit at, how a person addresses them (`@finance`, F9), and what each one owns. Tests check it
// against independent sources (the F8 hand list, the pack md tables, MANIFEST.d `proposal.*` lines).
// A specialist's id is its pack (BOARD F8 table, ADR §3.2); the long pack-file forms are aliases. Names and desk blurbs are i18n keys; the copy
// ships with each specialist's own ticket (T-044…T-051).
import { z } from "zod";
import { Slug } from "../shared/primitives.ts";

const Alias = z.string().regex(/^[a-z][a-z_]*$/); // bare lower-case token after the `@`; core matches case-insensitively

export const SpecialistEntry = z.strictObject({
  id: Slug,
  kind: z.enum(["specialist", "manager", "service"]),
  name_key: z.string().min(1),
  /** Art-direction floor plan desk (ART-DIRECTION §3); null for the Forecast service, which has no desk. */
  desk_key: z.string().min(1).nullable(),
  aliases: z.array(Alias),
  /** Detector ids from the pack md §4 table. */
  detectors: z.array(Slug),
  /** Agent-exposed snapshot templates (pack §3 minus input-only and review-only, ADR-014 §5.1). */
  templates: z.array(Slug),
  /** Draftable command types this specialist may propose (ADR-014 §3.2 "Can propose"). */
  draftables: z.array(Slug),
  /** Workflow draftables (DECISIONS 11 Oct, W3.2): drafts deterministic intel code emits for this specialist — never a
   *  model tool (NOT_AGENT_EXPOSED, no `propose_*`). core's internal drafts route admits them for this pack only; one may
   *  cite no snapshot cell (`based_on` []) only when every numeric leaf is a document span or a quote row. */
  workflow_draftables: z.array(Slug),
});

export const SpecialistRegistry = z.strictObject({ specialists: z.array(SpecialistEntry) });

const e = (
  id: string,
  desk: string | null,
  aliases: string[],
  detectors: string[],
  templates: string[],
  draftables: string[],
  kind: "specialist" | "manager" | "service" = "specialist",
  workflow_draftables: string[] = [],
) => ({ id, kind, name_key: `specialist.${id}.name`, desk_key: desk, aliases, detectors, templates, draftables, workflow_draftables });

export const SPECIALIST_REGISTRY: z.infer<typeof SpecialistRegistry> = {
  specialists: [
    e("manager", "desk.reception", ["manager"], [], [], [], "manager"),
    e(
      "catalogue",
      "desk.catalogue",
      ["catalogue", "menu", "pricing", "menu_pricing"],
      ["catalogue.negative_margin", "catalogue.cost_drift", "catalogue.recipe_waste_gap", "catalogue.deal_loss", "catalogue.above_mrp", "catalogue.below_cost"],
      ["catalogue.dish_margin", "catalogue.menu_matrix", "catalogue.cost_drift", "catalogue.deal_cost", "catalogue.sku_price_check", "catalogue.recipe_current"],
      ["catalogue.price.set.v1", "catalogue.recipe.version.create.v1", "catalogue.deal.end.v1"],
    ),
    e(
      "kitchen",
      "desk.kitchen",
      ["kitchen", "chef"],
      ["kitchen.ticket_drift", "kitchen.remakes", "kitchen.overprep", "kitchen.prep_time_gap"],
      ["kitchen.ticket_times", "kitchen.ticket_drift", "kitchen.remakes_overprep", "kitchen.prep_need", "kitchen.ticket_coverage"],
      ["kitchen.prep_time.set.v1", "kitchen.prep_list.create.v1"],
    ),
    e(
      "inventory_purchasing",
      "desk.purchasing",
      ["inventory", "purchasing", "stock", "inventory_purchasing"],
      [
        "inventory.shortfall", "inventory.waste_spike", "inventory.expiry_risk", "inventory.shrinkage", "inventory.dead_stock",
        "purchasing.price_creep", "purchasing.overbilled", "purchasing.near_duplicate_invoice",
      ],
      [
        "inventory.below_reorder", "inventory.shortfall", "inventory.waste_week", "inventory.expiry_risk", "inventory.shrinkage", "inventory.dead_stock",
        "purchasing.price_creep", "purchasing.invoice_vs_po", "purchasing.quote_compare",
        // 0022: lists the detectors drive from (purchasing.invoices, inventory.counts) and the count variance read.
        "purchasing.invoices", "inventory.counts", "inventory.count_variance",
      ],
      [
        "purchasing.po.create.v1", "purchasing.invoice.dispute.v1", "purchasing.supplier_return.create.v1",
        "inventory.reorder_level.set.v1", "inventory.transfer.create.v1",
      ],
      "specialist",
      // Ingestion's supplier-invoice draft (T-056). The negotiation's PO (T-055) is purchasing.po.create.v1, already a
      // propose draftable above, so it is not repeated here. ADR-015: the expiry_risk Cares donation listing.
      ["purchasing.invoice.record.v1", "cares.listing.publish.v1"],
    ),
    e(
      "finance",
      "desk.finance",
      ["finance", "accounts", "accounting"],
      ["finance.unapproved_ad_fee", "finance.short_payout", "finance.missing_payout", "finance.tender_gap", "finance.gst_mismatch"],
      ["finance.unapproved_deductions", "finance.settlement_vs_orders", "finance.missing_payouts", "finance.tender_vs_bank", "finance.pnl", "finance.gst_check", "finance.close_status", "finance.margin_bridge", "finance.gst_summary"],
      ["finance.dispute.draft.v1", "finance.journal.adjust.v1", "finance.period.close.v1"],
    ),
    e(
      "people",
      "desk.people",
      ["people", "staff", "hr"],
      ["people.overtime_drift", "people.overstaffed_slot", "people.labour_pct_high", "people.advance_unrecovered"],
      ["people.labour_vs_demand", "people.overtime_drift", "people.labour_pct", "people.attendance_coverage", "people.advances_open", "people.payroll_lines"],
      ["people.roster.create.v1", "people.payroll_draft.create.v1"],
      "specialist",
      // ADR-015: the overstaffed_slot pack-and-hand-over task. Compliance and market propose the same command as a tool;
      // people's is drafted by deterministic mapping code only.
      ["goals.task.create.v1"],
    ),
    e(
      "customers",
      "desk.customers",
      ["customers", "growth", "customers_growth"],
      ["customers.coupon_cap_evasion", "customers.staff_applied_coupon", "customers.coupon_spike", "customers.regulars_lapsing", "customers.rating_drop"],
      ["customers.coupon_leakage", "customers.staff_coupon_use", "customers.coupon_daily", "customers.churn_segments", "customers.review_trend", "customers.consented_audience", "customers.coupon_current"],
      // No model-path draftables (R-B S1-B, S1-D): coupon.set and campaign.create are not agent-exposed.
      [],
      "specialist",
      // R67 (founder, 16 Oct): the regulars_lapsing win-back campaign, drafted by mapping code only. Core admits it on a demo
      // business only (internal/drafts.ts); everywhere else the S1-D refusal stands.
      ["customers.campaign.create.v1"],
    ),
    e(
      "compliance",
      "desk.compliance",
      ["compliance", "assets", "compliance_assets"],
      ["compliance.licence_expiring", "compliance.missed_logs", "compliance.temp_excursion", "compliance.amc_waste", "compliance.maintenance_overdue", "compliance.energy_drift"],
      ["compliance.licence_calendar", "compliance.log_coverage", "compliance.temp_excursions", "compliance.asset_costs", "compliance.energy_per_order"],
      ["goals.task.create.v1", "compliance.maintenance.schedule.v1"],
    ),
    e(
      "market",
      "desk.market",
      ["market", "strategy", "market_strategy"],
      ["market.event_ahead", "market.competitor_undercut", "market.goal_off_track"],
      ["market.signal_uplift", "market.upcoming", "market.competitor_gap", "market.viability", "market.goal_progress", "market.goal_baseline", "market.goals", "cares.listings", "cares.impact"],
      ["goals.goal.create.v1", "goals.task.create.v1"],
    ),
    // A shared service, not a team member: no desk, no alias, proposes nothing (pack forecast §6 drafts
    // belong to the specialists that own those commands). Its sales_history/slot_profile templates are
    // input-only (ADR-014 §5.1) so they are not agent-exposed.
    e(
      "forecast",
      null,
      [],
      ["forecast.accuracy_drift", "forecast.bias", "forecast.stale"],
      ["forecast.points", "forecast.accuracy", "forecast.freshness"],
      [],
      "service",
    ),
  ],
};
