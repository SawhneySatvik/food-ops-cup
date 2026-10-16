// Refusal / abstention reason codes (03-architecture §1.7, 04-agent-framework §4, docs/plan/packs/*.md,
// docs/plan/screens/00-README.md §4, R40). core-api composes the shown text from i18n by code
// ("Cannot verify: …"); intel never writes reason text. Append-only: codes are never renamed or removed.
import { z } from "zod";

/** Envelope / validator abstentions (W1). */
export const CORE_REASON_CODES = [
  "number_grammar",
  "unresolved_ref",
  "cross_tenant_ref",
  "quote_mismatch",
  "missing_ref",
  "settlements_missing",
  "recipe_missing",
  "stale_draft",
  "authority_denied",
] as const;

/** Pack refusals: the evidence a pack needs is missing or a deal-review rule failed (D-1 pack specs). */
export const PACK_REASON_CODES = [
  "cost_price_missing",
  "ticket_times_missing",
  "count_missing",
  "expiry_missing",
  "budget_exceeded",
  "budget_missing",
  "margin_below_floor",
  "moq_exceeds_need",
  "open_commitment_overlap",
  "payment_terms_worse",
  "consent_record_missing",
  "bank_lines_missing",
  "attendance_missing",
  "payroll_out_of_scope",
  "no_marketing_consent",
  "not_a_certificate",
  "log_coverage_missing",
  "signal_source_missing",
  "insufficient_history",
  "forecast_stale",
] as const;

/** Storefront refusals shown to a customer (T-032). */
export const STOREFRONT_REASON_CODES = [
  "window_full",
  "outlet_paused",
  "item_sold_out",
  "deal_rejudged",
  "coupon_invalid",
  "coupon_cap_reached",
  "coupon_min_spend",
  "change_window_closed",
  // Appended (R3-M8): a coupon outside its dates / its outlet or customer scope, told apart from an unknown one.
  "coupon_expired",
  "coupon_out_of_scope",
] as const;

/** Book-rule refusals from core commands (R40 C1, C7; period close; platform model kill switch). */
export const COMMAND_REASON_CODES = ["price_above_mrp", "expired_batch", "period_closed", "model_blocked", "preview_total_changed"] as const;

/** Country-pack rule refusals raised by core-domain's pack engine (W1 fix #56) and the recipe unit rule
 *  (#50: a recipe or option-delta line's unit must equal the ingredient's base unit). */
export const PACK_RULE_REASON_CODES = ["buyer_identity_required", "tax_id_missing", "unknown_tax_class", "unknown_channel", "unit_mismatch"] as const;

/** W2 refusals (B13): a pack rule that does not apply, an unavailable item, a missing reason on a void/refund, a
 *  deal edited in the cart or re-judged at a new time, a repeated supplier invoice number, a guest asked to
 *  change an order online (W2-R2: guests call the outlet), a cancel with money still held, a re-time after a payment,
 *  and a cash amount below the pack's smallest step. */
export const W2_REASON_CODES = ["not_applicable", "item_unavailable", "reason_required", "deal_changed", "duplicate_invoice", "guest_cannot_change", "refund_first", "order_tendered", "cash_below_rounding"] as const;

/** W3 (ADR-014 §5.5, §14 C5): core refuses an intel draft whose fingerprint a person rejected within 30 days.
 *  T-090 (F10, F11 O-2): an investigation mode above the role's ceiling; an owner's AI cap above the operator's monthly
 *  limit, or set while the operator has no limit for this month in the business currency.
 *  W3.2 (i-2): a task draft whose outlet has no manager to assign it to — the mapping abstains, it never guesses.
 *  W3.2 review (R-B S1-D): core refuses an intel campaign draft while the audience template does not filter to the
 *  finding's segment (DECISIONS 11 Oct: an approved campaign must never reach customers outside the finding). */
export const W3_REASON_CODES = ["recently_rejected", "mode_above_ceiling", "cap_above_platform_budget", "platform_budget_missing", "assignee_missing",
  "campaign_audience_unscoped", "specialist_needed"] as const;

/** Munim Cares (ADR-015 §1.3): setup, listing, B2B offer and public-route refusals. */
export const CARES_REASON_CODES = [
  "cares_not_available", "cares_not_enabled", "cares_not_opted_in", "cares_city_mismatch",
  "recipient_ineligible", "listing_expired", "qty_exceeds_on_hand", "qty_exceeds_listed", "cooked_hold_exceeded", "line_expired",
  "no_eligible_recipient", "no_rostered_staff",
  "offer_not_enabled", "offer_closed", "claim_decided", "claim_received",
  "rate_limited",
  // Fix cycle W1 (orchestrator ruling 2-B): an offer's hand-over is all-or-nothing and final in v1.
  "handover_must_be_complete", "offer_handover_final",
] as const;

/** T-099 (docs/kit/gaps.md G-12): a storefront order's `promised_at` that is not inside the pickup window it names. */
export const STOREFRONT_T099_REASON_CODES = ["pickup_time_outside_window"] as const;

/** T-128 (R66, R67): a storefront theme whose colours do not reach 4.5:1; a page save on top of a version that is no longer
 *  the newest; a command that only a demo business takes (recording a campaign as sent, simulated); a command an onboarded
 *  demo business refuses so it keeps working for everyone (R64 X-2, core-api lib/demo-guard.ts). */
export const T128_REASON_CODES = ["theme_contrast", "page_version_stale", "demo_only", "demo_protected"] as const;

export const REASON_CODES = [
  ...CORE_REASON_CODES,
  ...PACK_REASON_CODES,
  ...STOREFRONT_REASON_CODES,
  ...COMMAND_REASON_CODES,
  ...PACK_RULE_REASON_CODES,
  ...W2_REASON_CODES,
  ...W3_REASON_CODES,
  ...CARES_REASON_CODES,
  ...STOREFRONT_T099_REASON_CODES,
  ...T128_REASON_CODES,
] as const;
export const ReasonCode = z.enum(REASON_CODES);
export type ReasonCode = z.infer<typeof ReasonCode>;
