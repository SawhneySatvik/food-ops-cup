"""The W3 question registry (ADR-014 §4.3). Two questions only; each answer set is a fixed tuple in this file.

`route.intent` picks the path, not the packs (ADR §6.5, review cut). `@Specialist` addressing is resolved by
deterministic alias matching in the Manager (T-082b), not here; an addressed question still has one of the six intents.
`map.columns` is one question per import kind: its options are that kind's Munim fields (hand-copied from core-api
`modules/imports/formats.ts` FIELDS — tests/decide check they match) plus `ignore`. Renames only (R28): no units here.
"""

from __future__ import annotations

from munim_intel.decide.port import DecisionQuestion

ROUTE_INTENT = DecisionQuestion(
    key="route.intent",
    version=1,
    kind="choice",
    options=("lookup", "explain", "investigate", "draft_request", "certification_request", "out_of_scope"),
    instructions=(
        "You route a restaurant or shop owner's question inside a back-office system. Pick the one path that fits.\n"
        "lookup: read back figures or a list that already exist (sales, stock, who is on shift).\n"
        "explain: say why something happened or what a finding means, in one pass.\n"
        "investigate: dig into a cause step by step across several areas or periods.\n"
        "draft_request: asks the system to prepare a change or action for a person to approve "
        "(order stock, set a price, make a roster, dispute a payout).\n"
        "certification_request: asks the system to certify, guarantee, attest or sign off that books, "
        "tax or compliance are correct.\n"
        "out_of_scope: not about this business, its data or its operations.\n"
        "A leading @Name addresses a team member; route by what is asked, not by who is addressed."
    ),
    egress=frozenset({"question", "outlet_kinds", "country"}),
    threshold_bp=6_000,
    # §4.3: below threshold the orchestrator treats the question as `explain` and loads a skill (R8 default).
    fallback="explain",
    value_patterns={"outlet_kinds": "restaurant|cloud_kitchen|store", "country": "[A-Z]{2}"},
    # T-059 measured the approved Gemini ids rejecting logprobs (400), so without this every ask routed to `explain`.
    # Every path is bounded and fails safe on a wrong pick: a draft still needs an @specialist (`specialist_needed`)
    # and a person's approval, certification abstains, fan-out branches are read-only (manager/paths.py).
    use_unscored=True,
)

#: core-api `modules/imports/formats.ts` FIELDS, in file order (the field names only; types and required-ness stay in core).
IMPORT_FIELDS: dict[str, tuple[str, ...]] = {
    "payout_statement": (
        "channel_code",
        "payout_ref",
        "period_from",
        "period_to",
        "paid_on",
        "outlet",
        "order_ref",
        "order_date",
        "line_kind",
        "gross",
        "commission",
        "ad_fee",
        "promo_share",
        "tax_withheld",
        "net",
        "currency",
    ),
    "bank_statement": ("txn_date", "reference", "narration", "mode", "payee_vpa", "amount", "account", "outlet", "currency"),
    "tally_export": ("voucher_date", "voucher_type", "voucher_no", "ledger", "party", "amount", "tax", "narration", "outlet", "currency"),
    "pos_export": ("bill_no", "bill_date", "outlet", "order_type", "payment_mode", "subtotal", "discount", "tax", "total", "currency"),
    "market_signal": ("on_date", "kind", "label", "outlet", "value", "unit", "source"),
    "pos_bills": (
        "bill_no",
        "bill_date",
        "bill_time",
        "outlet",
        "channel",
        "brand",
        "order_type",
        "customer_phone",
        "bill_status",
        "item_code",
        "variant_code",
        "qty",
        "unit_price",
        "tax_class",
        "line_discount",
        "line_total",
        "void_reason",
        "cash",
        "card",
        "upi",
        "refund",
        "refund_mode",
        "refund_reason",
        "refund_date",
        "currency",
    ),
    "waste_log": ("waste_date", "waste_time", "outlet", "ingredient", "qty", "unit", "reason", "note"),
    "shift_log": (
        "shift_no",
        "shift_date",
        "outlet",
        "opened_at",
        "closed_at",
        "opened_by",
        "closed_by",
        "float",
        "counted_cash",
        "cash_tenders",
    ),
    "stock_count": ("count_no", "count_date", "count_time", "outlet", "counted_by", "ingredient", "qty", "unit", "batch"),
}


def _map_columns(kind: str, fields: tuple[str, ...]) -> DecisionQuestion:
    return DecisionQuestion(
        key="map.columns",
        version=1,
        kind="choice",
        options=(*fields, "ignore"),
        instructions=(
            f"A {kind.replace('_', ' ')} file is being imported. Pick the field that the column named in `header` is a "
            "plain rename of, judging only by the header text and the other headers in `headers`. Pick ignore when no "
            "field fits or the column would need any calculation."
        ),
        egress=frozenset({"header", "headers"}),
        threshold_bp=7_000,
        # §4.3: below threshold the field is left unmapped in the imports.format.approve.v1 draft; a person maps it.
        fallback=None,
        variant=kind,
    )


MAP_COLUMNS: dict[str, DecisionQuestion] = {kind: _map_columns(kind, fields) for kind, fields in IMPORT_FIELDS.items()}

#: Every question the decision model may be asked. Reflected over by tests/decide (§4.4).
QUESTIONS: tuple[DecisionQuestion, ...] = (ROUTE_INTENT, *MAP_COLUMNS.values())
