// The migration manifest: a HAND-WRITTEN list of what 0001–0017 must create. Gates compare the live catalog
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
  "core.business_policy": book(),
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
  "core.price": book(),
  "core.deal": book(),
  "core.coupon": book(),
  "core.item_availability": op(true),
  "core.pickup_window": op(true),
  "core.order_status_transition": global,
  "core.ticket_counter": op(),
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
  "core.journal_entry": book(),
  "core.posting": book(),
  "core.period_close": book(),
  "core.settlement": book(),
  "core.settlement_line": book(),
  "core.bank_line": book(),
  "core.dispute": book(),
  "core.dispute_line": book(),
  "core.reconciliation_break": book(), // book since 0014 (#22)
  "core.budget": book(),
  "core.expense": book(),
  "core.payable": book(),
  "core.receivable": book(),
  "core.tax_return_draft": book(),
  // 0009
  "core.document": op(),
  "core.import_format": op(),
  "core.import_run": op(),
  "core.import_staging": op(),
  "core.import_quarantine": op(),
  "core.conversation": op(),
  "core.message": op(),
  // 0010
  "core.staff": book(),
  "core.roster": book(),
  "core.roster_shift": book(true),
  "core.attendance": book(true),
  "core.payroll_draft": book(),
  "core.payroll_draft_line": book(),
  "core.advance": book(),
  "core.tip_pool": book(),
  "core.tip_pool_share": book(),
  "core.training_record": book(),
  "core.hiring_candidate": book(),
  // 0011
  "core.loyalty_entry": book(), // customer own-rows policy, tested separately
  "core.campaign": book(),
  "core.reservation": book(),
  "core.review": book(),
  "core.bulk_order": book(),
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
  "core.market_signal": op(),
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
};

export const OUR_SCHEMAS = ["core", "evidence", "intel", "platform", "intel_ro", "munim_meta"];

const names = Object.keys(TABLES);
export const ALL_TABLES = names;
export const CORE_TABLES = names.filter((n) => n.startsWith("core."));
export const BOOK_TABLES = names.filter((n) => TABLES[n]!.tag === "book");
export const TENANT_TABLES = names.filter((n) => TABLES[n]!.tenant);
export const OUTLET_TABLES = names.filter((n) => TABLES[n]!.outlet);

/** Hand counts, so a mistake in the object above also shows up as a count mismatch. */
export const EXPECTED_COUNTS = { all: 147, core: 118, book: 92, tenant: 133, outlet: 33 };

/** F4 (0014): the restrictive customer_scope policy class per tenant table; every other tenant table is
 *  "deny". "open" tables carry no customer_scope policy (placement writes them). */
export const CUSTOMER_OWN = ["core.customer", "core.order", "core.loyalty_entry", "core.reservation", "core.bulk_order"];
export const CUSTOMER_VIA_ORDER = ["core.order_line", "core.order_event", "core.coupon_use", "core.tender", "core.refund",
  "core.void", "core.sale_return", "core.kitchen_ticket"];
export const CUSTOMER_PUBLIC = ["core.tenant", "core.outlet", "core.brand", "core.channel", "core.item", "core.variant",
  "core.option_group", "core.option", "core.price", "core.deal", "core.item_availability", "core.outlet_calendar",
  "core.prep_time", "core.recipe_version"];
export const CUSTOMER_CODE = ["core.coupon"];
export const CUSTOMER_OPEN = ["core.ticket_counter", "core.pickup_window"];

/** Tables a pack-scoped tenant may legitimately leave empty (AU: payroll_scope = 'roster_only'). */
export const PACK_SCOPED_TABLES: Record<string, string[]> = { AU: ["core.payroll_draft", "core.payroll_draft_line"] };

/** EXACTLY the tables munim_svc may INSERT into (03-architecture §1.3; M-B adds documents/imports and the
 *  intel tables written by core-api's internal routes, R25). */
export const SVC_INSERT_TABLES = [
  "core.document", "core.draft", "core.import_quarantine", "core.import_run", "core.import_staging", "core.outbox",
  "evidence.snapshot",
  "intel.alias", "intel.answer", "intel.chunk", "intel.claim", "intel.edge", "intel.entity", "intel.event_claim",
  "intel.finding", "intel.forecast_point", "intel.forecast_run", "intel.intel_spend", "intel.outcome", "intel.run",
  "intel.supplier_quote", "intel.trace_event", "intel.watch_state", "intel.wiki_page", "intel.wiki_version",
];

/** intel_ro views (02-schema §5), owned by munim_view_owner; finding_recent's exact column list. */
export const INTEL_RO_VIEWS = [
  "intel_ro.chunk_search", "intel_ro.claim_search", "intel_ro.entity_alias", "intel_ro.finding_recent",
  "intel_ro.ingredient_names", "intel_ro.item_names", "intel_ro.outlet_names", "intel_ro.supplier_names",
  "intel_ro.trace_recent", "intel_ro.wiki_current",
];
export const FINDING_RECENT_COLUMNS = ["id", "pack", "type", "severity", "status", "dedupe_key"];

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
  "core.active_tenants", "core.customer_claim_guest_token", "core.customer_claim_verified_email_guests",
  "core.customer_erase_merged_guests", "core.memberships_for_sub",
  "core.outbox_claim",
  "core.tenant_for_storefront_key",
  "platform.tenant_registry",
];

/** Snapshot templates and their per-column numeric-source allow-list (02-schema §3, R40 C5). */
export const TEMPLATES = ["inventory.below_reorder", "platform.spend_by_tenant"];
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
];
