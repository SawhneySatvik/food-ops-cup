"""`customers.coupon_cap_evasion` (packs/customers-growth.md §4, §5; plant G1; answer key RG-G1).

Template `customers.coupon_leakage`, one row per coupon over the last `window_days` business days. A use beyond the
coupon's per-customer cap by one phone number, counted across every customer record that carries that number, is cap
evasion. The detector fires when `cap_evasion_minor` ≥ `cap_evasion_minor_gte` (IN ₹500, AU A$10). Severity is L on that
amount.

The template is tenant-level and takes no `outlet_id`, so a sweep mints the same rows once per outlet. The dedupe key is
the pack's `<coupon>:<month>`, with no outlet in it, so those copies merge into one finding.

Draft (pack §6): `catalogue.coupon.set.v1` from a follow-up `customers.coupon_current` **v2** snapshot (0023 C1): the
coupon's identity, scope and validity as recorded; `value_minor` / `value_bp` / `per_customer_cap` / `global_cap` /
`min_spend_minor` are refs to its own cells (kept; a null cell stays null), `requires_customer` = true (the tightening).
The draft targets the coupon's own outlets (`outlet_ids` cell, a JSON array; `[]` = every outlet, so an owner approves),
not the outlet whose sweep found it. A coupon the follow-up cannot read (no row, or an unreadable outlet list) gets no draft.
"""

from __future__ import annotations

import json
import re
from datetime import timedelta

from munim_intel.detect import DetectorSpec, Ladder, OutletFrame, Row, Severity, Thresholds, Window, num, register
from munim_intel.mapping import Detection, FollowUp, Proposal

_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
#: The coupon_current cells the draft keeps by ref (pack §6), each nullable except the minimum spend.
KEPT = ("value_minor", "value_bp", "per_customer_cap", "global_cap", "min_spend_minor")

COUPON = FollowUp("coupon", "customers.coupon_current", lambda d: {"coupon_id": str(d.row["coupon_id"])})


def windows(outlet: OutletFrame, t: Thresholds) -> list[Window]:
    start = outlet.business_date - timedelta(days=t["window_days"] - 1)
    return [Window({"from": start.isoformat(), "to": outlet.business_date.isoformat()}, outlet.business_date.isoformat()[:7])]


def fires(row: Row, t: Thresholds) -> bool:
    amount = num(row, "cap_evasion_minor")
    return isinstance(row.get("coupon_id"), str) and amount is not None and amount >= t["cap_evasion_minor_gte"]


def severity(row: Row, _: Thresholds, ladder: Ladder) -> Severity:
    return ladder.of(num(row, "cap_evasion_minor") or 0)


def dedupe(row: Row, w: Window) -> str:
    return f"{row['coupon_id']}:{w.key}"


def tighten(d: Detection) -> Proposal | None:
    m = d.follow.get("coupon")
    if m is None or len(m.rows) != 1:
        return None
    r = m.rows[0]
    try:
        outlets = json.loads(str(r.get("outlet_ids")))
    except json.JSONDecodeError:
        return None
    if not isinstance(outlets, list) or not all(isinstance(o, str) and _UUID.match(o) for o in outlets):
        return None
    refs = {c: m.ref(0, c) if num(r, c) is not None else None for c in KEPT}
    return Proposal(
        command_type="catalogue.coupon.set.v1",
        payload={
            "coupon_id": str(d.row["coupon_id"]),
            "code": r.get("code"),
            "kind": r.get("kind"),
            **refs,
            "currency": d.currency,
            "requires_customer": True,
            "outlet_ids": sorted(outlets),
            "valid_from": r.get("valid_from"),
            "valid_to": r.get("valid_to"),
            "active": r.get("active"),
        },
        based_on=[d.ref("cap_evasion_minor"), *(v for v in refs.values() if v is not None)],
        targets=[str(d.row["coupon_id"])],
        outlet_ids=sorted(outlets),
    )


SPEC = register(
    DetectorSpec(
        id="customers.coupon_cap_evasion",
        pack="customers",
        template="customers.coupon_leakage",
        finding_type="customers.coupon_cap_evasion",
        impact_column="cap_evasion_minor",
        windows=windows,
        fires=fires,
        severity=severity,
        dedupe=dedupe,
        narration=(
            "This coupon was used beyond its per-customer cap by phone numbers shared across several customer records: "
            "{cap_evasion_uses} extra uses gave away {cap_evasion_minor} in discounts."
        ),
        mapping=tighten,
        follow_ups=(COUPON,),
    )
)
