"""Menu & Pricing draft mappings (packs/catalogue.md §6): a detection → a draftable, by code, every numeric leaf a
canonical ref to the §6 cell and a date leaf (a deal's end) a date code chose from core's business date. Proposals
only — a named person approves before a price, recipe or deal changes (R16).

Two of the three need cells the detection's own row does not hold:
  price.set from a cost drift      amount ← `dish_margin.suggested_price_minor` (another template)
  recipe.version.create            version, yield, lines ← `recipe_current` rows (another template, one row per line)
The pipeline mints that second snapshot after the finding is stored (`FOLLOW_MARGIN`, `FOLLOW_RECIPE`: W3.2 follow-up
mints) and hands it in as `Detection.follow`. The text cells come from 0022's v2 columns (`tax_class`, `channel_kind`
on dish_margin; `unit` on recipe_current); a row without them still returns None rather than take a value from
anywhere but a cell — a wrong tax class or unit would become a book change the moment someone approved it.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import timedelta
from typing import Any

from munim_intel.detect import Cell, Row, num
from munim_intel.mapping import Detection, FollowUp, Proposal, snap_ref


def tomorrow(d: Detection) -> str:
    """Pack §2: a price or recipe draft starts tomorrow or later, never back-dated (outlet business date + 1)."""
    return (d.outlet.business_date + timedelta(days=1)).isoformat()


def _text(row: Row, column: str) -> str | None:
    v = row.get(column)
    return v if isinstance(v, str) and v else None


def price_set(margin: Detection, also: Sequence[str] = ()) -> Proposal | None:
    """`catalogue.price.set.v1` for the item on a `catalogue.dish_margin` row: amount ← `suggested_price_minor`."""
    row = margin.row
    item, channel, tax_class = _text(row, "item_id"), _text(row, "channel_kind"), _text(row, "tax_class")
    if item is None or channel is None or tax_class is None or num(row, "suggested_price_minor") is None:
        return None
    amount = margin.ref("suggested_price_minor")
    return Proposal(
        command_type="catalogue.price.set.v1",
        payload={
            "item_id": item,
            "variant_id": None,
            "outlet_id": margin.outlet.id,
            "channel_kind": channel,
            "amount_minor": amount,
            "currency": margin.currency,
            "tax_class": tax_class,
            "valid_from": tomorrow(margin),
            "valid_to": None,
        },
        based_on=[amount, *also],
        targets=[item],
        minted=["price_id"],
    )


def price_for_drift(drift: Detection, margin_snapshot_id: str, margin_rows: Sequence[Mapping[str, Cell]]) -> Proposal | None:
    """C1: the drifting item's price draft, its amount from the item's row of a `catalogue.dish_margin` snapshot minted
    for the same outlet; the drift cell rides in `based_on` (approval re-checks both)."""
    item = drift.row.get("item_id")
    at = next((i for i, r in enumerate(margin_rows) if r.get("item_id") == item), None)
    if at is None:
        return None
    margin = Detection(margin_snapshot_id, at, margin_rows[at], drift.outlet, drift.currency)
    return price_set(margin, also=[drift.ref("cost_drift_minor")])


def recipe_for_gap(gap: Detection, current_snapshot_id: str, current_rows: Sequence[Mapping[str, Cell]]) -> Proposal | None:
    """C2: `catalogue.recipe.version.create.v1` from a `catalogue.recipe_current` snapshot of the gap's item: version ←
    `next_version`, yield ← `yield_qty_milli`, each line's qty ← `qty_milli` and waste ← `observed_waste_bp` (pack §6)."""
    item = _text(gap.row, "item_id")
    if item is None or not current_rows:
        return None
    lines: list[dict[str, Any]] = []
    for i, r in enumerate(current_rows):
        ingredient, unit = _text(r, "ingredient_id"), _text(r, "unit")
        if ingredient is None or unit is None or num(r, "qty_milli") is None or num(r, "observed_waste_bp") is None:
            return None
        lines.append(
            {
                "ingredient_id": ingredient,
                "qty_milli": snap_ref(current_snapshot_id, i, "qty_milli"),
                "unit": unit,
                "waste_pct_bp": snap_ref(current_snapshot_id, i, "observed_waste_bp"),
            }
        )
    if num(current_rows[0], "next_version") is None or num(current_rows[0], "yield_qty_milli") is None:
        return None
    version = snap_ref(current_snapshot_id, 0, "next_version")
    yield_ref = snap_ref(current_snapshot_id, 0, "yield_qty_milli")
    return Proposal(
        command_type="catalogue.recipe.version.create.v1",
        payload={
            "item_id": item,
            "variant_id": None,
            "version": version,
            "valid_from": tomorrow(gap),
            "valid_to": None,
            "yield_qty_milli": yield_ref,
            "lines": lines,
        },
        based_on=[gap.ref("excess_waste_minor"), version, yield_ref, *(line["waste_pct_bp"] for line in lines)],
        targets=[item],
        minted=["recipe_version_id"],
    )


def deal_end(d: Detection) -> Proposal | None:
    """C3: `catalogue.deal.end.v1` for a loss-making deal — it ends tomorrow (exclusive `valid_to`); no numeric leaf."""
    deal = _text(d.row, "deal_id")
    if deal is None:
        return None
    return Proposal(
        command_type="catalogue.deal.end.v1",
        payload={"deal_id": deal, "valid_to": tomorrow(d)},
        based_on=[d.ref("deal_loss_minor")],
        targets=[deal],
    )


#: C1: the drifting item's `dish_margin` at the same outlet, over the drift's own window (`since` … the business date),
#: channel unset (the item's current price in scope: counter first — 0022).
FOLLOW_MARGIN = FollowUp(
    "margin",
    "catalogue.dish_margin",
    lambda d: {"outlet_id": d.outlet.id, "channel_kind": None, "from": d.params["since"], "to": d.outlet.business_date.isoformat()},
)
#: C2: the gap item's current recipe at the outlet on its business date (run-frame; never core's clock).
FOLLOW_RECIPE = FollowUp(
    "recipe",
    "catalogue.recipe_current",
    lambda d: (
        {"item_id": d.row["item_id"], "outlet_id": d.outlet.id, "as_of": d.outlet.business_date.isoformat()}
        if _text(d.row, "item_id")
        else None
    ),
)


def price_draft(d: Detection) -> Proposal | None:
    m = d.follow.get("margin")
    return None if m is None else price_for_drift(d, m.snapshot_id, m.rows)


def recipe_draft(d: Detection) -> Proposal | None:
    r = d.follow.get("recipe")
    return None if r is None else recipe_for_gap(d, r.snapshot_id, r.rows)
