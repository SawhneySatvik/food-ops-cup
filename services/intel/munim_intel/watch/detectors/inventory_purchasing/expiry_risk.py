"""`inventory.expiry_risk` (packs/inventory-purchasing.md §4, §5, §6; plant I4; answer key ST-I4).

Template `inventory.expiry_risk` per outlet, `days` = the larger of the pack's two horizons (7): batches expiring from
today on that still hold stock, with the forecast use before expiry (FEFO) taken off. Fires when `days_to_expiry` ≤
`days_to_expiry_lte` (3), or ≤ `sku_days_to_expiry_lte` (7) for a shop SKU, and `at_risk_minor` ≥ `at_risk_minor_gte`
(₹500 / A$10). Severity L on `at_risk_minor`. Dedupe `<outlet>:<batch>`.

Draft (ADR-015 §4): where Munim Cares is on for the outlet (`cares_active`), a `cares.listing.publish.v1` donation to
the top `cares.recipient_match` row, by code — the model never proposes it. Nowhere else: the pack's transfer and
supplier-return drafts stay unbuilt (a later mapping would choose between them). "Today" is the database's now() in the
outlet's zone.
"""

from __future__ import annotations

from typing import Any

from munim_intel.detect import DetectorSpec, Ladder, OutletFrame, Row, Severity, Thresholds, Window, num, register
from munim_intel.mapping import Abstain, Detection, FollowUp, Proposal

LISTING = "cares.listing.publish.v1"


def windows(outlet: OutletFrame, t: Thresholds) -> list[Window]:
    days = max(t["days_to_expiry_lte"], t["sku_days_to_expiry_lte"])
    return [Window({"outlet_id": outlet.id, "days": days, "as_of": outlet.business_date.isoformat()}, outlet.id)]


def fires(row: Row, t: Thresholds) -> bool:
    left, at_risk = num(row, "days_to_expiry"), num(row, "at_risk_minor")
    if not isinstance(row.get("batch_id"), str) or left is None or at_risk is None:
        return False
    horizon = t["sku_days_to_expiry_lte"] if row.get("is_sku") is True else t["days_to_expiry_lte"]
    return left <= horizon and at_risk >= t["at_risk_minor_gte"]


def severity(row: Row, _: Thresholds, ladder: Ladder) -> Severity:
    return ladder.of(num(row, "at_risk_minor") or 0)


def dedupe(row: Row, w: Window) -> str:
    return f"{w.params['outlet_id']}:{row['batch_id']}"


def match_params(d: Detection) -> dict[str, Any] | None:
    """The recipient match for this batch's at-risk quantity, or None (no mint at all) when Cares is off for the outlet
    or the row lacks what the match needs. A packaged SKU needs a recipient that takes packaged food, else raw."""
    r = d.row
    qty, unit = num(r, "at_risk_qty_milli"), r.get("unit")
    if not d.outlet.cares_active or qty is None or qty < 1 or not isinstance(unit, str):
        return None
    expires = r.get("expiry_on")
    sku = r.get("is_sku") is True
    return {
        "outlet_id": d.outlet.id,
        "needs_cooked": False,
        "needs_raw": not sku,
        "needs_packaged": sku,
        "qty_milli": qty,
        "unit": unit,
        "expires_on": expires if isinstance(expires, str) else None,
    }


FOLLOW_MATCH = FollowUp("match", "cares.recipient_match", match_params)


def donate(d: Detection) -> Proposal | Abstain | None:
    """Row 0 of the match is the rank-1 recipient (the template orders; there is no rank column). Numbers are refs
    (`qty_milli`); ids and the date strings the contract keeps as strings are the match row's own cell values, each also
    in `based_on`, so a changed match or batch makes the draft stale."""
    m = d.follow.get("match")
    if m is None:
        return None
    if not m.rows:
        return Abstain("no_eligible_recipient")
    top = m.rows[0]
    r = d.row
    cells = [top.get(c) for c in ("recipient_id", "pickup_from", "pickup_to", "pickup_on")]
    batch, ingredient, unit, expires = (r.get(c) for c in ("batch_id", "ingredient_id", "unit", "expiry_on"))
    if not all(isinstance(c, str) for c in (*cells, batch, ingredient, unit, expires)):
        return Abstain("no_eligible_recipient")
    recipient, pickup_from, pickup_to, pickup_on = cells
    return Proposal(
        command_type=LISTING,
        payload={
            "outlet_id": d.outlet.id,
            "kind": "donation",
            "recipient_id": recipient,
            "pickup_from": pickup_from,
            "pickup_to": pickup_to,
            "lines": [
                {
                    "food_kind": "raw" if r.get("is_sku") is not True else "packaged",
                    "item_id": None,
                    "ingredient_id": ingredient,
                    "batch_id": batch,
                    "qty_milli": d.ref("at_risk_qty_milli"),
                    "unit": unit,
                    "expires_on": expires,
                    "unit_price_minor": None,
                    "currency": None,
                }
            ],
        },
        based_on=[
            d.ref("at_risk_qty_milli"),
            d.ref("expiry_on"),
            *(m.ref(0, c) for c in ("recipient_id", "pickup_from", "pickup_to", "pickup_on")),
        ],
        targets=[str(batch), str(pickup_on)],
        minted=["listing_id", "lines/0/line_id"],
    )


SPEC = register(
    DetectorSpec(
        id="inventory.expiry_risk",
        thresholds=("at_risk_minor_gte", "days_to_expiry_lte", "sku_days_to_expiry_lte"),
        pack="inventory_purchasing",
        template="inventory.expiry_risk",
        finding_type="inventory.expiry_risk",
        impact_column="at_risk_minor",
        windows=windows,
        fires=fires,
        severity=severity,
        dedupe=dedupe,
        narration=(
            "A batch expires on {expiry_on} with {remaining_qty_milli} still in stock and only {use_before_expiry_qty_milli} "
            "expected to be used before then: {at_risk_qty_milli} worth {at_risk_minor} is at risk of being thrown away."
        ),
        mapping=donate,
        follow_ups=(FOLLOW_MATCH,),
    )
)
