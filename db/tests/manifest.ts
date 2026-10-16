// The migration manifest: a HAND-WRITTEN list of what 0001–0035 must create. Gates compare the live catalog
// against this list in both directions; never derive these from the catalog itself.
// Update it in the same change as any migration that adds a table.

/** Applied on embedded Postgres (every gate). */
export const MIGRATIONS = [
  "0001_roles_schemas",
  "0002_platform",
  "0003_core_foundation",
  "0004_catalogue_orders_customer",
  "0005_inventory_store_purchasing",
  "0006_approvals_extras",
  "0007_w1_riders",
  "0008_finance",
  "0009_documents_imports",
  "0010_people",
  "0011_customers_growth",
  "0012_compliance_goals_intel",
  "0014_w1_fix_cycle_1",
  "0015_w2_fix",
  "0016_w2_fix_cycle_1",
  "0017_w2_fix_cycle_2",
  "0018_history_imports",
  "0019_mc1a_templates_outlet_rls",
  "0020_mc23_threads_policy_investigations",
  "0021_mc1bc_pack_templates_history_kinds",
  "0022_mc1d_guard_binding_f8_asof",
  "0023_mc1e_template_versions",
  "0024_w32_review_fixes",
  "0025_w3_close",
  "0026_w3_founder_decisions",
  "0027_t098_auto_ceiling_downgrade",
  "0028_cares",
  "0029_storefront_display",
  "0030_display_order",
  "0031_tick_ledger",
  "0032_rfq_authority",
  "0033_forecast_per_outlet",
  "0034_t128_storefront_page_campaign_sent",
  "0035_r71_consented_audience",
] as const;
/** `-- requires: vector`: skipped loudly on embedded Postgres (no pgvector), applied where it exists. */
export const SKIPPED_HERE = [{ name: "0013_embeddings", missing: ["vector"] }];
export const MIGRATION_FILES = [...MIGRATIONS.slice(0, 12), "0013_embeddings", ...MIGRATIONS.slice(12)];

/** book / operational for core tables (R29); null outside core. */
type Tag = "book" | "operational" | null;
/** tenant: has tenant_id → forced RLS. outlet: outlet-scoped policy on `outlet_id`. */
interface T {
  tag: Tag;
  tenant: boolean;
  outlet: boolean;
}
const book = (outlet = false): T => ({ tag: "book", tenant: true, outlet });
const op = (outlet = false): T => ({ tag: "operational", tenant: true, outlet });
const global: T = { tag: "operational", tenant: false, outlet: false };
const plain = (tenant = false, outlet = false): T => ({ tag: null, tenant, outlet });

export const TABLES: Record<string, T> = {
  // 0001 (runner bootstrap, owned by 0001)
  "munim_meta.schema_migrations": plain(),
  // 0002
  "platform.country_pack": plain(),
  "platform.plan": plain(),
  "platform.feature_flag": plain(),
  "platform.llm_budget": plain(true),
  "platform.model_role": plain(),
  "platform.operator": plain(),
  "platform.config_draft": plain(),
  "platform.platform_audit": plain(),
  // 0003
  "core.tenant": book(),
  "core.outlet": book(),
  "core.brand": book(),
  "core.channel": book(),
  "core.member": book(),
  "core.membership": book(),
  "core.device": op(true),
  "core.outlet_calendar": book(true),
  "core.business_policy": book(true), // outlet RLS since 0019 (R1-m9)
  "core.command_authority": global,
  "core.derivation_rule": global,
  "core.command_log": op(),
  "core.draft": op(), // outlet_ids overlap policy, tested separately
  "core.decision": op(),
  "core.audit_log": op(),
  "core.outbox": op(),
  "intel.run": plain(true),
  "evidence.snapshot_template": plain(),
  "evidence.snapshot": plain(true),
  // 0004
  "core.customer": book(),
  "core.ingredient": book(),
  "core.item": book(),
  "core.variant": book(),
  "core.option_group": book(),
  "core.option": book(),
  "core.option_ingredient_delta": book(),
  "core.recipe_version": book(),
  "core.recipe_line": book(),
  "core.price": book(true), // outlet RLS since 0019 (R1-m9)
  "core.deal": book(),
  "core.coupon": book(),
  "core.item_availability": op(true),
  "core.pickup_window": op(true),
  "core.order_status_transition": global,
  "core.ticket_counter": op(true), // outlet RLS since 0019 (R1-m9)
  "core.invoice_counter": op(),
  "core.order": book(true),
  "core.order_line": book(true),
  "core.order_event": book(true),
  "core.tender": book(true),
  "core.void": book(true),
  "core.refund": book(true),
  "core.shift": book(true),
  "core.kitchen_ticket": op(true),
  "core.coupon_use": book(),
  "core.prep_time": op(true),
  "core.prep_list": book(true),
  "core.prep_list_line": book(),
  // 0005
  "core.supplier": book(),
  "core.batch": book(true),
  "core.expired_sale_override": book(true),
  "core.stock_movement": book(true),
  "core.stock_count": book(true),
  "core.stock_count_line": book(),
  "core.reorder_level": book(true),
  "core.waste_log": book(true),
  "core.supplier_price": book(),
  "core.purchase_order": book(),
  "core.po_line": book(),
  "core.goods_received": book(true),
  "core.grn_line": book(),
  "core.supplier_invoice": book(),
  "core.supplier_invoice_line": book(),
  "core.transfer": book(), // either-end outlet policy, tested separately
  "core.transfer_line": book(),
  "core.supplier_return": book(true),
  "core.supplier_return_line": book(),
  "core.sale_return": book(true),
  // 0007
  "core.storefront_key": op(),
  // 0008
  "core.account": book(),
  "core.channel_terms": book(),
  "core.journal_entry": book(true), // outlet RLS since 0019 (R1-m9)
  "core.posting": book(),
  "core.period_close": book(true), // outlet RLS since 0019 (R1-m9)
  "core.settlement": book(true), // outlet RLS since 0019 (R1-m9)
  "core.settlement_line": book(),
  "core.bank_line": book(true), // outlet RLS since 0019 (R1-m9)
  "core.dispute": book(),
  "core.dispute_line": book(),
  "core.reconciliation_break": book(true), // book since 0014 (#22); outlet RLS since 0019 (R1-m9)
  "core.budget": book(true), // outlet RLS since 0019 (R1-m9)
  "core.expense": book(true), // outlet RLS since 0019 (R1-m9)
  "core.payable": book(),
  "core.receivable": book(),
  "core.tax_return_draft": book(true), // outlet RLS since 0019 (R1-m9)
  // 0009
  "core.document": op(),
  "core.import_format": op(),
  "core.import_run": op(),
  "core.import_staging": op(),
  "core.import_quarantine": op(),
  "core.conversation": op(true), // outlet RLS since 0019 (R1-m9)
  "core.message": op(),
  // 0010
  "core.staff": book(true), // outlet RLS since 0019 (R1-m9)
  "core.roster": book(true), // outlet RLS since 0019 (R1-m9)
  "core.roster_shift": book(true),
  "core.attendance": book(true),
  "core.payroll_draft": book(true), // outlet RLS since 0019 (R1-m9)
  "core.payroll_draft_line": book(),
  "core.advance": book(),
  "core.tip_pool": book(true), // outlet RLS since 0019 (R1-m9)
  "core.tip_pool_share": book(),
  "core.training_record": book(),
  "core.hiring_candidate": book(true), // outlet RLS since 0019 (R1-m9)
  // 0011
  "core.loyalty_entry": book(), // customer own-rows policy, tested separately
  "core.campaign": book(),
  "core.reservation": book(true), // outlet RLS since 0019 (R1-m9)
  "core.review": book(true), // outlet RLS since 0019 (R1-m9)
  "core.bulk_order": book(true), // outlet RLS since 0019 (R1-m9)
  // 0012
  "core.licence": book(true), // outlet RLS since 0015 (A3; outlet_id NULL = tenant-wide)
  "core.checklist": book(true),
  "core.checklist_run": book(true),
  "core.asset": book(true),
  "core.temp_log": book(true),
  "core.amc": book(), // visible through its asset (0015 A3), tested separately
  "core.maintenance": book(), // visible through its asset (0015 A3), tested separately
  "core.goal": book(true),
  "core.task": book(true),
  "core.market_signal": op(true), // outlet RLS since 0019 (R1-m9)
  "core.viability_case": book(), // book since 0014 (#22)
  "intel.entity": plain(true),
  "intel.alias": plain(true),
  "intel.chunk": plain(true),
  "intel.claim": plain(true),
  "intel.edge": plain(true),
  "intel.wiki_page": plain(true),
  "intel.wiki_version": plain(true),
  "intel.forecast_run": plain(true),
  "intel.forecast_point": plain(true, true),
  "intel.finding": plain(true), // outlet_ids overlap policy, tested separately
  "intel.answer": plain(true),
  "intel.trace_event": plain(true),
  "intel.supplier_quote": plain(true),
  "intel.intel_spend": plain(true),
  "intel.outcome": plain(true),
  "intel.event_claim": plain(true),
  "intel.watch_state": plain(true),
  // 0014
  "core.book_scope": global,
  "core.book_status_transition": global,
  // 0020 (M-C23): threads (F9), AI policy books (F10, F11 O-2), investigations (ADR-014 §7.2, F10), the standing grant (F11 O-1)
  "core.ai_thread": op(), // intel.run's scope form on outlet_scope, tested separately
  "core.ai_thread_turn": op(), // through its thread
  "core.ai_policy": book(),
  "core.ai_budget_cap": book(),
  "core.investigation": op(), // intel.run's scope form on outlet_scope
  "core.investigation_step": op(), // through its investigation
  "core.investigation_grant": op(), // intel.run's scope form on outlet_scope
  // 0028 (ADR-015 §1): Munim Cares — operator tables (enablement per tenant, as llm_budget) and nine books
  "platform.cares_city": plain(),
  "platform.cares_recipient": plain(),
  "platform.cares_enablement": plain(true),
  "platform.network_snapshot": plain(),
  "core.cares_profile": book(),
  "core.cares_outlet": book(true),
  "core.cares_listing": book(true),
  "core.cares_listing_line": book(), // through its listing (PARENT_SCOPED)
  "core.cares_handover": book(true),
  "core.cares_handover_line": book(), // through its hand-over (PARENT_SCOPED)
  "core.cares_claim": book(true),
  "core.cares_claim_line": book(), // through its claim (PARENT_SCOPED)
  "core.cares_allocation": book(true),
  // 0031 (T-117): the tick ledger — which core-worker job ran for which tick slot (service state, no tenant)
  "core.tick_claim": global,
  // 0034 (T-128): the storefront page — saved versions and publish events, tenant-level books
  "core.storefront_page_version": book(),
  "core.storefront_page_publish": book(),
};

export const OUR_SCHEMAS = ["core", "evidence", "intel", "platform", "intel_ro", "munim_meta"];

const names = Object.keys(TABLES);
export const ALL_TABLES = names;
export const CORE_TABLES = names.filter((n) => n.startsWith("core."));
export const BOOK_TABLES = names.filter((n) => TABLES[n]!.tag === "book");
export const TENANT_TABLES = names.filter((n) => TABLES[n]!.tenant);
export const OUTLET_TABLES = names.filter((n) => TABLES[n]!.outlet);

/** Hand counts, so a mistake in the object above also shows up as a count mismatch. */
/** fk: foreign-key constraints in core/evidence/intel/platform, counted from the migration TEXT (never the catalog or
 *  ontology.json): REFERENCES clauses per file 0002 2, 0003 26, 0004 59, 0005 59, 0007 2, 0008 49, 0009 24, 0010 25, 0011 15,
 *  0012 80, 0014 1, 0015 3, 0016 1 (= 346 through 0019), minus 1 dropped by 0014 (expired_sale_override → order_line, re-added
 *  as its 1) = 345; 0020 adds 20 (ai_thread 2, ai_thread_turn 3, ai_policy 1, ai_budget_cap 1, investigation 3,
 *  investigation_grant 4, investigation_step 5, intel.run.grant_id 1) = 365; 0024 adds 1 (intel.supplier_quote.source_chunk_id
 *  → intel.chunk) = 366; 0028 adds 29 (cares_recipient 1, cares_enablement 2, network_snapshot 3, cares_profile 1, cares_outlet 2,
 *  cares_listing 3, cares_listing_line 4, cares_handover 3 + the allocation FK added after, cares_handover_line 2, cares_claim 2,
 *  cares_claim_line 2, cares_allocation 2, task.cares_listing_id 1) = 395; 0034 adds 5 (storefront_page_version 2,
 *  storefront_page_publish 3) = 400. */
export const EXPECTED_COUNTS = { all: 170, core: 137, book: 105, tenant: 152, outlet: 59, fk: 400 };

/** F4 (0014): the restrictive customer_scope policy class per tenant table; every other tenant table is
 *  "deny". "open" tables carry no customer_scope policy (placement writes them). */
export const CUSTOMER_OWN = ["core.customer", "core.order", "core.loyalty_entry", "core.reservation", "core.bulk_order"];
export const CUSTOMER_VIA_ORDER = ["core.order_line", "core.order_event", "core.coupon_use", "core.tender", "core.refund",
  "core.void", "core.sale_return", "core.kitchen_ticket"];
export const CUSTOMER_PUBLIC = ["core.tenant", "core.outlet", "core.brand", "core.channel", "core.item", "core.variant",
  "core.option_group", "core.option", "core.price", "core.deal", "core.item_availability", "core.outlet_calendar",
  "core.prep_time", "core.recipe_version", "core.storefront_page_publish"];
export const CUSTOMER_CODE = ["core.coupon"];
/** 0034: a shopper reads a storefront page version only once a publish row names it. */
export const CUSTOMER_PUBLISHED = ["core.storefront_page_version"];
export const CUSTOMER_OPEN = ["core.ticket_counter", "core.pickup_window"];

/** Tables a pack-scoped tenant may legitimately leave empty (AU: payroll_scope = 'roster_only'). */
export const PACK_SCOPED_TABLES: Record<string, string[]> = { AU: ["core.payroll_draft", "core.payroll_draft_line"] };

/** EXACTLY the tables munim_svc may INSERT into (03-architecture §1.3; M-B adds documents/imports and the
 *  intel tables written by core-api's internal routes, R25). */
export const SVC_INSERT_TABLES = [
  "core.document", "core.draft", "core.import_quarantine", "core.import_run", "core.import_staging", "core.investigation_step",
  "core.outbox", "core.tick_claim", "evidence.snapshot",
  "intel.alias", "intel.answer", "intel.chunk", "intel.claim", "intel.edge", "intel.entity", "intel.event_claim",
  "intel.finding", "intel.forecast_point", "intel.forecast_run", "intel.intel_spend", "intel.outcome", "intel.run",
  "intel.supplier_quote", "intel.trace_event", "intel.watch_state", "intel.wiki_page", "intel.wiki_version",
];

/** intel_ro views (02-schema §5), owned by munim_view_owner; finding_recent's exact column list. */
export const INTEL_RO_VIEWS = [
  "intel_ro.chunk_search", "intel_ro.claim_search", "intel_ro.entity_alias", "intel_ro.finding_recent",
  "intel_ro.ingredient_names", "intel_ro.investigation_current", "intel_ro.item_names", "intel_ro.outlet_names", "intel_ro.supplier_names",
  "intel_ro.trace_recent", "intel_ro.wiki_current",
];
export const FINDING_RECENT_COLUMNS = ["id", "pack", "type", "severity", "status", "dedupe_key"];
/** 0020: investigation_current exposes ids, text and jsonb only (no steps_done / max_steps). */
export const INVESTIGATION_CURRENT_COLUMNS = ["id", "playbook_id", "params", "mode", "status", "stop_reason", "checklist", "updated_at"];

/** The legal order transitions, written out by hand from 02-schema §2.4. */
export const ORDER_STATUSES = ["placed", "accepted", "rejected", "preparing", "ready", "completed", "cancelled"];
export const LEGAL_ORDER_TRANSITIONS = [
  "placed>accepted",
  "placed>rejected",
  "accepted>preparing",
  "preparing>ready",
  "ready>completed",
  "placed>cancelled",
  "accepted>cancelled",
];

/** SECURITY DEFINER / munim_crosstenant-owned objects (03-architecture §1.2). */
export const CROSSTENANT_OBJECTS = [
  "core.active_tenants",
  // 0028 (ADR-015 §1.5): the five Cares reads.
  "core.cares_claim_outcome", "core.cares_inbound_claims", "core.cares_market_offers", "core.cares_network_impact", "core.cares_network_listings",
  "core.customer_claim_guest_token", "core.customer_claim_verified_email_guests",
  "core.customer_erase_merged_guests", "core.memberships_for_sub",
  "core.outbox_claim",
  "core.tenant_for_storefront_key",
  "platform.tenant_registry",
];

/** Snapshot templates and their per-column numeric-source allow-list (02-schema §3, R40 C5). 0019 adds the fourteen of
 *  M-C1a (catalogue §3, finance §3, ADR-014 §7.3); tests/template-spec.ts parses those from the docs on its own. */
export const TEMPLATES = [
  "catalogue.cost_drift", "catalogue.deal_cost", "catalogue.dish_margin", "catalogue.menu_matrix", "catalogue.recipe_current",
  "catalogue.sku_price_check",
  "finance.close_status", "finance.gst_check", "finance.margin_bridge", "finance.missing_payouts", "finance.pnl",
  "finance.settlement_vs_orders", "finance.tender_vs_bank", "finance.unapproved_deductions",
  "intel.agent_track_record", "intel.ai_budget_left", "intel.investigation_cost_estimate",
  "inventory.below_reorder", "platform.spend_by_tenant",
  // 0021 (M-C1bc): the remaining packs' §3 tables, typed by hand from the pack docs (template-spec.ts parses the same docs).
  "compliance.asset_costs", "compliance.energy_per_order", "compliance.licence_calendar", "compliance.log_coverage", "compliance.temp_excursions",
  "customers.churn_segments", "customers.consented_audience", "customers.coupon_current", "customers.coupon_daily", "customers.coupon_leakage",
  "customers.review_trend", "customers.staff_coupon_use",
  "forecast.accuracy", "forecast.freshness", "forecast.points", "forecast.sales_history", "forecast.slot_profile",
  "inventory.dead_stock", "inventory.expiry_risk", "inventory.shortfall", "inventory.shrinkage", "inventory.waste_week",
  "kitchen.prep_need", "kitchen.remakes_overprep", "kitchen.ticket_coverage", "kitchen.ticket_drift", "kitchen.ticket_times",
  "market.competitor_gap", "market.goal_baseline", "market.goal_progress", "market.signal_uplift", "market.upcoming", "market.viability",
  "people.advances_open", "people.attendance_coverage", "people.labour_pct", "people.labour_vs_demand", "people.overtime_drift",
  "people.payroll_lines",
  "purchasing.deal_inputs", "purchasing.invoice_duplicates", "purchasing.invoice_vs_po", "purchasing.price_creep", "purchasing.quote_compare",
  // 0022 (M-C1d): two non-pack templates, and version 2 (a nullable as_of) of the fourteen that read "today".
  "finance.gst_summary", "inventory.count_variance", "inventory.counts", "market.goals", "purchasing.invoices", "catalogue.dish_margin@2",
  "catalogue.cost_drift@2", "catalogue.recipe_current@2", "compliance.energy_per_order@2", "forecast.slot_profile@2",
  "inventory.dead_stock@2", "inventory.expiry_risk@2", "inventory.shortfall@2", "market.competitor_gap@2", "market.goal_baseline@2",
  "market.goal_progress@2", "market.signal_uplift@2", "market.upcoming@2", "people.advances_open@2", "purchasing.deal_inputs@2",
  // 0023 (M-C1e): version 2 of nine templates the pack lanes asked for (Σ rows first, requested columns, an outlet filter).
  "finance.settlement_vs_orders@2", "finance.missing_payouts@2", "finance.tender_vs_bank@2", "finance.gst_check@2",
  "customers.coupon_current@2", "compliance.licence_calendar@2", "compliance.log_coverage@2", "people.overtime_drift@2",
  "kitchen.ticket_times@2",
  // 0024 (R-A F5): settlement_vs_orders v3, core-api reconcileSettlement's lines (matched orders only) and default thresholds.
  "finance.settlement_vs_orders@3",
  // 0025 (R-D 4): investigation_cost_estimate v2, per remaining step (one step judges every evaluable item in one call).
  "intel.investigation_cost_estimate@2",
  // 0026 (R47 D6, D3): labour_vs_demand v2 (per outlet, excess at the extra staff's rate, Σ rows), deal_inputs v3 (shop SKU margin).
  "people.labour_vs_demand@2", "purchasing.deal_inputs@3",
  // 0028 (ADR-015 §1.6): the Cares templates (four member, one operator).
  "cares.impact", "cares.listings", "cares.pickup_crew", "cares.recipient_match", "platform.cares_network_impact",
  // 0033 (T-127): the latest forecast run per outlet, a new version of the six readers of one tenant-wide latest run.
  "kitchen.prep_need@2", "forecast.points@2", "inventory.shortfall@3", "inventory.expiry_risk@3", "purchasing.deal_inputs@4", "market.upcoming@3",
  // 0035 (R71): consented_audience v2, "Send me offers" ({marketing}) counts as email consent only.
  "customers.consented_audience@2",
].sort();
/** 0019 O2: child tables with no outlet column, visible exactly when their parent row is (policy tenant_via_parent).
 *  Not core.posting: it stays tenant-only (0019 header: the parent policy made large imports quadratic); templates read
 *  postings through their journal entry (tests/templates.test.ts). */
export const PARENT_SCOPED: Record<string, { parent: string; fk: string }> = {
  "core.message": { parent: "core.conversation", fk: "conversation_id" },
  "core.payroll_draft_line": { parent: "core.payroll_draft", fk: "payroll_draft_id" },
  "core.settlement_line": { parent: "core.settlement", fk: "settlement_id" },
  "core.tip_pool_share": { parent: "core.tip_pool", fk: "tip_pool_id" },
  // 0028: the Cares lines.
  "core.cares_listing_line": { parent: "core.cares_listing", fk: "listing_id" },
  "core.cares_handover_line": { parent: "core.cares_handover", fk: "handover_id" },
  "core.cares_claim_line": { parent: "core.cares_claim", fk: "claim_id" },
};
/** 0019 O1: outlet-scoped tables whose outlet_id may be NULL (a tenant-wide row, visible to every member). */
export const OUTLET_NULLABLE = [
  "core.bank_line", "core.budget", "core.business_policy", "core.checklist", "core.conversation", "core.expense", "core.goal",
  "core.journal_entry", "core.licence", "core.market_signal", "core.period_close", "core.reconciliation_break", "core.settlement",
  "core.task", "core.tax_return_draft",
];
/** 0020: tables carrying intel.run's scope policy (tenant_run_scope) on their `outlet_scope` text[] (review M7: visible
 *  when the caller's scope covers the row's; a '{*}' row only to an all-outlet owner/advisor/judge or a service context). */
export const RUN_SCOPED = ["core.ai_thread", "core.investigation", "core.investigation_grant", "intel.run"];
/** 0020: children of RUN_SCOPED parents, visible (and inserted) exactly when their parent is (policy tenant_via_parent). */
export const RUN_SCOPED_CHILDREN: Record<string, { parent: string; fk: string }> = {
  "core.ai_thread_turn": { parent: "core.ai_thread", fk: "thread_id" },
  "core.investigation_step": { parent: "core.investigation", fk: "investigation_id" },
};
/** Allowed intel numeric sources, column-level (R40 C5): deterministic forecast points, simulated quote
 *  terms, spend, and ROW COUNTS of intel.answer / intel.outcome. Never finding.confidence_bp or any other
 *  intel-supplied value. Widened by hand in M-B (forecast intervals, quote terms used by D-1 templates). */
export const INTEL_NUMERIC_ALLOW = [
  "intel.forecast_point.qty_milli",
  "intel.forecast_point.lo_qty_milli",
  "intel.forecast_point.hi_qty_milli",
  "intel.supplier_quote.unit_price_minor",
  "intel.supplier_quote.qty_milli",
  "intel.supplier_quote.min_order_qty_milli",
  "intel.supplier_quote.payment_days",
  "intel.supplier_quote.round",
  "intel.intel_spend.amount_minor",
  "count:intel.answer",
  "count:intel.outcome",
  // 0020, widened by hand: specialist abstains (intel.agent_track_record, R40 C5 names trace_event abstain counts) and the
  // operator's monthly AI limit (intel.ai_budget_left, F11 O-2: a platform ledger row, not an intel value).
  "count:intel.trace_event",
  "platform.llm_budget.limit_minor",
  // 0021, widened by hand: forecast.freshness counts a run's points per outlet and forecast.accuracy counts its days
  // (row counts of the forecast service's output, never a model-typed value; R25).
  "count:intel.forecast_point",
  // 0028 (ADR-015 §1.6), widened by hand: the operator's simulated-recipient directory (platform-trusted rows, never a model
  // value) — location for cares.recipient_match distance_m, capacities for the capacity fit, and (beyond the ADR's four,
  // lane m-d deviation) the receiving hours that overlap_min is computed from.
  "platform.cares_recipient.lat_e6",
  "platform.cares_recipient.lng_e6",
  "platform.cares_recipient.capacity_kg_per_day",
  "platform.cares_recipient.capacity_portions_per_day",
  "platform.cares_recipient.receiving_from",
  "platform.cares_recipient.receiving_to",
];
