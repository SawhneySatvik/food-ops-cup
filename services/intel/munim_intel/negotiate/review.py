"""Deterministic deal review and the PO draft (pack inventory-purchasing §6; 04 §6 steps 5–6; ledger R45 F4, R16).

One `purchasing.deal_inputs` snapshot (version 3, migration 0026) per final quote (minted by core), plus the negotiation's
`purchasing.quote_compare`. Five rules, each `pass | fail(code, refs) | cannot_verify(code, refs)`; a quote passes when all
five pass:

  1 budget    quote_total_minor > budget_left_minor             → fail budget_exceeded; no budget → cannot_verify budget_missing
  2 margin    margin_at_quote_bp < margin_floor_bp              → fail margin_below_floor; skipped (a pass coded
              `not_applicable`, citing the cell) when `margin_rule_applies` is false — ledger R47 D3: an item no recipe
              uses is margined on its own selling price (v3's `margin_at_quote_bp`), and one with no selling price either
              (packaging) is judged on need, budget and minimum order alone
  3 minimum   quote_compare.min_order_qty_milli > use_in_shelf_life_qty_milli, or > the quote's own qty_milli (the
              PO's quantity: an order below the supplier's minimum)  → fail moq_exceeds_need
  4 overlap   open_commit_qty_milli ≥ need_qty_milli            → fail open_commitment_overlap
  5 payment   quote_payment_days < min_payment_days             → fail payment_terms_worse

A NULL margin where the rule applies is `cannot_verify cost_price_missing`; a NULL floor or minimum payment term
(no business policy row) is `cannot_verify missing_ref` — the pack names no code for a missing policy (reported). A need
of 0 (no forecast use of the item at the run's outlets — packaging used by no recipe, or no forecast) is `cannot_verify
missing_ref` for the overlap rule: "open commitments cover a need of nothing" is not evidence of overlap (R-C F7).

The best passing quote (lowest unit price, then supplier id) becomes ONE `purchasing.po.create.v1` draft emitted here, by
code — never through `propose_*`, so the run's taint does not stop it and no model chose a number in it: quantity and
price are canonical refs to the `quote_compare` cells, `based_on` the shortfall cell and the budget-left cell. A named
person approves it before anything changes (R16). No passing quote → no draft.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal

from munim_intel.mapping import snap_ref, uuid7_ms
from munim_intel.tools.generated import uuid7

Verdict = Literal["pass", "fail", "cannot_verify"]
COMMAND = "purchasing.po.create.v1"
PACK = "inventory_purchasing"
RULES = ("budget", "margin", "minimum", "overlap", "payment")


@dataclass(frozen=True)
class Check:
    rule: str
    verdict: Verdict
    reason_code: str | None
    refs: tuple[str, ...]


@dataclass(frozen=True)
class Reviewed:
    quote_id: str
    supplier_id: str
    #: The quote's row in `quote_compare` and the deal_inputs snapshot id.
    row: int
    deal_inputs_id: str
    checks: tuple[Check, ...]

    @property
    def passed(self) -> bool:
        return all(c.verdict == "pass" for c in self.checks)

    @property
    def refused(self) -> Check | None:
        return next((c for c in self.checks if c.verdict != "pass"), None)


def review_quote(compare: Mapping[str, Any], row: int, inputs: Mapping[str, Any]) -> Reviewed:
    """`compare` / `inputs`: the two core Snapshot bodies (inputs has one row)."""
    q = compare["rows"][row]
    d = inputs["rows"][0]
    cs, ds = compare["snapshot_id"], inputs["snapshot_id"]

    def c(col: str) -> str:
        return snap_ref(cs, row, col)

    def i(col: str) -> str:
        return snap_ref(ds, 0, col)

    def check(rule: str, refs: Sequence[str], missing: str | None, failed: bool, code: str) -> Check:
        if missing is not None:
            return Check(rule, "cannot_verify", missing, tuple(refs))
        return Check(rule, "fail", code, tuple(refs)) if failed else Check(rule, "pass", None, tuple(refs))

    total, left = d["quote_total_minor"], d["budget_left_minor"]
    margin, floor = d["margin_at_quote_bp"], d["margin_floor_bp"]
    margin_rule = (
        check(
            "margin",
            [i("margin_at_quote_bp"), i("margin_floor_bp")],
            "cost_price_missing" if margin is None else "missing_ref" if floor is None else None,
            margin is not None and floor is not None and margin < floor,
            "margin_below_floor",
        )
        if d["margin_rule_applies"]
        else Check("margin", "pass", "not_applicable", (i("margin_rule_applies"),))
    )
    moq, shelf = q["min_order_qty_milli"], d["use_in_shelf_life_qty_milli"]
    open_qty, need = d["open_commit_qty_milli"], d["need_qty_milli"]
    days, min_days = d["quote_payment_days"], d["min_payment_days"]
    checks = (
        check(
            "budget",
            [i("quote_total_minor"), i("budget_left_minor")],
            "budget_missing" if left is None else None,
            left is not None and total > left,
            "budget_exceeded",
        ),
        margin_rule,
        check(
            "minimum",
            [c("min_order_qty_milli"), i("use_in_shelf_life_qty_milli"), c("qty_milli")],
            None,
            moq > shelf or moq > q["qty_milli"],
            "moq_exceeds_need",
        ),
        check(
            "overlap",
            [i("open_commit_qty_milli"), i("need_qty_milli")],
            "missing_ref" if need == 0 else None,
            open_qty >= need,
            "open_commitment_overlap",
        ),
        check(
            "payment",
            [i("quote_payment_days"), i("min_payment_days")],
            "missing_ref" if min_days is None else None,
            min_days is not None and days < min_days,
            "payment_terms_worse",
        ),
    )
    return Reviewed(str(q["quote_id"]), str(q["supplier_id"]), row, ds, checks)


def best(reviewed: Sequence[Reviewed], compare: Mapping[str, Any]) -> Reviewed | None:
    passing = [r for r in reviewed if r.passed]
    return min(passing, key=lambda r: (compare["rows"][r.row]["unit_price_minor"], r.supplier_id), default=None)


@dataclass(frozen=True)
class PoRequest:
    """What the PO draft needs that the quotes do not hold (all from the RFQ the negotiation started from)."""

    run_id: str
    ingredient_id: str
    unit: str
    currency: str
    outlet_ids: tuple[str, ...]
    expected_on: str | None
    #: Canonical ref of the shortfall cell the RFQ quantity came from.
    shortfall_ref: str
    shortfall_snapshot_id: str
    #: Canonical ref of the last-price cell the policy's target and walk-away were computed from.
    reference_ref: str
    reference_snapshot_id: str
    finding_id: str | None


def po_draft(win: Reviewed, compare: Mapping[str, Any], req: PoRequest) -> dict[str, Any]:
    """The `internal.drafts.request` body (validated by the caller against the generated model)."""
    did = uuid7(uuid7_ms(req.run_id), "\0".join([req.run_id, COMMAND, win.supplier_id]))
    cs = compare["snapshot_id"]
    return {
        "draft_id": did,
        "pack": PACK,
        "command_type": COMMAND,
        "payload": {
            "po_id": uuid7(uuid7_ms(did), f"{did}/po_id"),
            "supplier_id": win.supplier_id,
            "outlet_ids": list(req.outlet_ids),
            "currency": req.currency,
            "expected_on": req.expected_on,
            "negotiation_run_id": req.run_id,
            "lines": [
                {
                    "ingredient_id": req.ingredient_id,
                    "qty_milli": snap_ref(cs, win.row, "qty_milli"),
                    "unit": req.unit,
                    "unit_price_minor": snap_ref(cs, win.row, "unit_price_minor"),
                }
            ],
        },
        "outlet_ids": list(req.outlet_ids),
        "finding_id": req.finding_id,
        "evidence": [f"snap:{cs}", f"snap:{win.deal_inputs_id}", f"snap:{req.shortfall_snapshot_id}", f"snap:{req.reference_snapshot_id}"],
        # A workflow draft (DECISIONS 11 Oct, "W3.2 ruling — workflow draftables"): posted by this code from a run the
        # supplier replies tainted; based_on = the shortfall, the last price the bounds came from, the budget left and the
        # quote cells approval re-checks.
        "based_on": [
            req.shortfall_ref,
            req.reference_ref,
            snap_ref(win.deal_inputs_id, 0, "budget_left_minor"),
            snap_ref(cs, win.row, "unit_price_minor"),
            snap_ref(cs, win.row, "qty_milli"),
        ],
    }
