// Country packs (R21, R30, 02-schema §1). A business picks its country at onboarding; that one choice
// drives currency, tax, receipts, formats, time zones, aggregator formats, compliance templates, the
// chart of accounts, payroll scope, surcharge and printed-price rules. Packs are versioned DATA: the
// canonical documents are packages/contracts/packs/<CODE>.json, seeded into platform.country_pack by the
// migrator; core-domain reads them — no country logic in code paths.
// `_unverified` lists facts in a document that were not confirmed against a primary source.
import { z } from "zod";
import AU_DOC from "../../packs/AU.json" with { type: "json" };
import IN_DOC from "../../packs/IN.json" with { type: "json" };
import { BasisPoints, CountryCode, CurrencyCode, IanaZone, IsoDate, MinorAmount, Slug } from "../shared/primitives.ts";
import type { Route } from "../shared/routes.ts";

const Unverified = z.array(z.string().min(1)).min(1).optional();
const Label = z.string().min(1).max(300);

const TaxComponent = z.strictObject({ code: z.string().regex(/^[A-Z]{2,6}$/), rate_bp: BasisPoints });

const TaxClass = z.strictObject({
  code: Slug,
  label: Label,
  rate_bp: BasisPoints,
  /** Splits of rate_bp printed on the bill (e.g. CGST + SGST); they sum to rate_bp. */
  components: z.array(TaxComponent),
  input_tax_credit: z.boolean(),
  /** `service` = restaurant service; `goods` = items sold by a shop, chosen per item (catalogue tax_class); `any` = both. */
  supply: z.enum(["service", "goods", "any"]),
  applies_to: Label,
  _unverified: Unverified,
});

const TaxId = z.strictObject({
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  label: Label,
  /** Format check only (no checksum). */
  pattern: z.string().min(1),
  holder: z.enum(["business", "outlet"]),
  required: z.boolean(),
  /** Printed on every bill / receipt. */
  on_receipt: z.boolean(),
  /** The `invoice.required_fields` slug this id satisfies on a receipt (explicit link, W1 fix #4); null when
   *  it is not printed. Set exactly when `on_receipt`. */
  receipt_field: Slug.nullable(),
  _unverified: Unverified,
});

const Aggregator = z.strictObject({
  code: Slug,
  display_name: Label,
  /** Import format id for the order / payout statement parser (R28 mapping drafts per format). */
  import_format: Slug,
  /** How the aggregator's orders enter the merchant's own tax liability:
   *  `merchant_collects` — the merchant's taxable supply; `operator_collects_excluded` — the operator
   *  pays the tax, so the orders are excluded from the merchant's own output-tax liability. */
  tax_treatment: z.enum(["merchant_collects", "operator_collects_excluded"]),
  legal_basis: Label.nullable(),
  _unverified: Unverified,
});

const Account = z.strictObject({
  code: z.string().regex(/^[0-9]{4}$/),
  name: Label,
  type: z.enum(["asset", "liability", "equity", "income", "expense"]),
});

const ComplianceTemplate = z.strictObject({
  code: Slug,
  label: Label,
  recurrence: z.enum(["monthly", "quarterly", "annual", "on_change"]),
  /** Day of the month after the period end the item falls due; null when not a dated filing. */
  due_day_after_period: z.int().min(1).max(31).nullable(),
  _unverified: Unverified,
});

/** Detector threshold map entry. Keys name the compared column and comparison (`<column>_gte`, `_lt`, …)
 *  or a window (`window_days`, `lead_days`, …); values are integers in the column's unit (`*_minor` in
 *  the pack currency's minor unit, `*_bp`, `*_milli`, `*_sec`, `*_min`, `*_days`, counts). */
const ThresholdName = z.string().regex(/^[a-z][a-z0-9_]*$/);
const Detector = z.strictObject({
  thresholds: z.record(ThresholdName, z.int()),
  /** Provenance; every value is INFERENCE until an owner policy or eval fixes it. */
  _notes: z.array(z.string().min(1)).min(1),
});

const LicenceKind = z.strictObject({
  code: Slug,
  label: Label,
  holder: z.enum(["business", "outlet"]),
  /** Which outlet kinds need it. */
  outlet_kinds: z.array(z.enum(["restaurant", "cloud_kitchen", "store"])).min(1),
  _unverified: Unverified,
});

export const CountryPack = z
  .strictObject({
    code: CountryCode,
    version: z.int().min(1),
    effective_from: IsoDate,
    name: Label,
    locale: z.string().regex(/^[a-z]{2}-[A-Z]{2}$/),
    currency: z.strictObject({
      code: CurrencyCode,
      /** Digits after the decimal point; amounts are stored as integers in this unit. */
      minor_unit: z.int().min(0).max(4),
      symbol: z.string().min(1).max(4),
    }),
    fy_start_month: z.int().min(1).max(12),
    timezones: z.array(IanaZone).min(1),
    default_timezone: IanaZone,
    formats: z.strictObject({
      /** indian = 12,34,56,789 (lakh / crore); thousands = 123,456,789 */
      number_grouping: z.enum(["indian", "thousands"]),
      decimal_separator: z.string().length(1),
      group_separator: z.string().length(1),
      /** Unicode date pattern for display. */
      date: z.string().min(1).max(20),
      /** Magnitude words and their digit-free suffixes as the renderer prints them (e.g. lakh → L). */
      magnitude_words: z.array(z.strictObject({ word: z.string().min(1), suffix: z.string().min(1), exponent: z.int().min(1) })),
    }),
    tax: z.strictObject({
      regime: z.string().regex(/^[a-z_]+$/),
      /** inclusive: the shelf / menu price contains tax; exclusive: tax is added on the bill. */
      price_display: z.enum(["inclusive", "exclusive"]),
      rounding: z.literal("half_up_per_line"),
      /** Class used when an item names none (the restaurant-service class). */
      default_class: Slug,
      classes: z.array(TaxClass).min(1),
      _unverified: Unverified,
    }),
    tax_ids: z.array(TaxId),
    invoice: z.strictObject({
      /** Words printed as the document title. */
      title: Label,
      every_receipt_is_tax_invoice: z.boolean(),
      required_fields: z.array(Slug).min(1),
      /** Above this amount (minor units, tax inclusive) the buyer's identity must be on the invoice;
       *  null when the pack has no such rule. */
      buyer_identity_above_minor: MinorAmount.positive().nullable(),
      _unverified: Unverified,
    }),
    /** Printed maximum retail price on packaged goods. `sale_above_mrp_refused`: core refuses a sale line
     *  priced above the item's MRP. */
    printed_price: z.strictObject({
      rule: z.enum(["none", "sale_above_mrp_refused"]),
      applies_to: Label.nullable(),
      _unverified: Unverified,
    }),
    aggregators: z.array(Aggregator),
    /** drafts: payroll runs are drafted for approval; roster_only: rosters and shifts, no payroll. */
    payroll_scope: z.enum(["drafts", "roster_only"]),
    surcharges: z.strictObject({
      /** not_applicable: the pack models no surcharge rule; prohibited: core refuses a card surcharge line. */
      card_surcharge: z.enum(["not_applicable", "allowed", "prohibited"]),
      _unverified: Unverified,
    }),
    compliance_calendar: z.array(ComplianceTemplate),
    /** Licences the compliance calendar tracks (validity, renewal). */
    licence_kinds: z.array(LicenceKind).min(1),
    /** R40 C7: whether `inventory.expired_sale.override.v1` exists at all. Default false (food safety). */
    expired_sale_override: z.boolean(),
    /** R40 C6: channels for order-status messages. Only the in-app tracker until the founder decides on
     *  email / SMS. WhatsApp is banned (R5) and not representable. */
    status_channels: z.array(z.enum(["in_app", "email", "sms"])).min(1),
    /** Cash rounding increment in minor units (ruling #59): cash due is rounded to it, the difference is
     *  recorded on the tender as `rounding_minor`, and shift expected cash uses the rounded amount. 1 = none. */
    cash_rounding_minor: z.int().min(1),
    /** G-13 (T-099): how a storefront order can be paid at the counter, as the storefront shows it. Optional: v1–v3 packs
     *  have none (the storefront then shows null); every v4 pack lists them (packs.test). Recorded, never processed. */
    pay_at_counter_methods: z.array(z.enum(["cash", "card", "upi"])).min(1).optional(),
    /** Monthly-impact severity ladder for findings (docs/plan/packs header "L"), pack minor units. */
    severity_ladder: z.strictObject({
      critical_minor_gte: MinorAmount.positive(),
      high_minor_gte: MinorAmount.positive(),
      medium_minor_gte: MinorAmount.positive(),
      _notes: z.array(z.string().min(1)).min(1),
    }),
    /** `detectors.<detector_id>` thresholds (docs/plan/packs/*.md §4), pack currency for money. */
    detectors: z.record(z.string().regex(/^[a-z][a-z_]*\.[a-z][a-z0-9_]*$/), Detector),
    chart_of_accounts: z.array(Account).min(1),
    /** Munim Cares operating values (ADR-015 §6). Optional: v1–v3 packs have none, and a pack without it means Cares is
     *  off (`cares_not_available`). Operating limits only — no legal text, no compliance claim. */
    cares: z
      .strictObject({
        food_kinds: z.array(z.enum(["cooked", "raw", "packaged"])).min(1),
        /** Whether businesses may share surplus with each other (the B2B offers). */
        offers_enabled: z.boolean(),
        /** A cooked pickup must start within this many minutes of the listing's approval. */
        cooked_max_hold_min: z.int().positive(),
        /** A line's expires_on must be at least this many days after the pickup date. */
        min_days_left_at_pickup: z.int().min(0),
        /** Provenance; every value is INFERENCE. */
        _notes: z.array(z.string().min(1)).min(1),
      })
      .optional(),
    _unverified: Unverified,
  })
  .superRefine((p, ctx) => {
    // Cross-field invariants (not expressible in JSON Schema; enforced wherever the zod schema is used).
    if (!p.timezones.includes(p.default_timezone)) ctx.addIssue({ code: "custom", path: ["default_timezone"], message: "not in timezones" });
    const classes = p.tax.classes.map((c) => c.code);
    if (!classes.includes(p.tax.default_class)) ctx.addIssue({ code: "custom", path: ["tax", "default_class"], message: "not a tax class" });
    if (new Set(classes).size !== classes.length) ctx.addIssue({ code: "custom", path: ["tax", "classes"], message: "duplicate tax class code" });
    p.tax.classes.forEach((c, i) => {
      const sum = c.components.reduce((a, x) => a + x.rate_bp, 0);
      if (sum !== c.rate_bp) ctx.addIssue({ code: "custom", path: ["tax", "classes", i, "components"], message: "components do not sum to rate_bp" });
    });
    const accounts = p.chart_of_accounts.map((a) => a.code);
    if (new Set(accounts).size !== accounts.length) ctx.addIssue({ code: "custom", path: ["chart_of_accounts"], message: "duplicate account code" });
    if (!p.status_channels.includes("in_app")) ctx.addIssue({ code: "custom", path: ["status_channels"], message: "the in-app tracker is always a channel" });
    const l = p.severity_ladder;
    if (!(l.critical_minor_gte > l.high_minor_gte && l.high_minor_gte > l.medium_minor_gte))
      ctx.addIssue({ code: "custom", path: ["severity_ladder"], message: "critical > high > medium" });
    p.tax_ids.forEach((t, i) => {
      if (t.on_receipt !== (t.receipt_field !== null))
        ctx.addIssue({ code: "custom", path: ["tax_ids", i, "receipt_field"], message: "receipt_field is set exactly when on_receipt" });
      if (t.receipt_field !== null && !p.invoice.required_fields.includes(t.receipt_field))
        ctx.addIssue({ code: "custom", path: ["tax_ids", i, "receipt_field"], message: "receipt_field must be one of invoice.required_fields" });
    });
    if (p.pay_at_counter_methods && new Set(p.pay_at_counter_methods).size !== p.pay_at_counter_methods.length)
      ctx.addIssue({ code: "custom", path: ["pay_at_counter_methods"], message: "duplicate method" });
    if (p.cares && new Set(p.cares.food_kinds).size !== p.cares.food_kinds.length) ctx.addIssue({ code: "custom", path: ["cares", "food_kinds"], message: "duplicate food kind" });
    const licences = p.licence_kinds.map((k) => k.code);
    if (new Set(licences).size !== licences.length) ctx.addIssue({ code: "custom", path: ["licence_kinds"], message: "duplicate licence kind" });
    if ((p.printed_price.rule === "none") !== (p.printed_price.applies_to === null))
      ctx.addIssue({ code: "custom", path: ["printed_price", "applies_to"], message: "applies_to is set exactly when a rule applies" });
  });
export type CountryPack = z.infer<typeof CountryPack>;

/** The canonical pack documents, validated at load (an invalid pack fails every importer, incl. gen). */
export const PACKS: Readonly<Record<"IN" | "AU", CountryPack>> = {
  IN: CountryPack.parse(IN_DOC),
  AU: CountryPack.parse(AU_DOC),
};
export const PACK_CODES = Object.keys(PACKS) as Array<keyof typeof PACKS>;

export const SCHEMAS = { "country-pack": CountryPack };
export const ROUTES: readonly Route[] = [];
