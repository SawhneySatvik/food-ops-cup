"""`finance.missing_payout` (packs/finance.md §4, §5, §6; plants F4, F7; answer keys RG-F4, RG-F7).

Template `finance.missing_payouts` **version 2** (migration 0023 F2), minted per outlet as of the outlet's business
date. Version 2 puts one Σ row per channel first (`order_id` null, with `channel_id` appended), whose `days_unsettled`
is the oldest unsettled order's age; a channel with nothing unsettled has no row.

Fires on a channel's Σ row when the oldest completed order in no payout is older than the pack's `days_unsettled_gt`
(10 days): the channel is overdue. Impact: the Σ `order_total_minor` of every order of that channel in no payout — the
answer keys measure the order values (RG-F4 6 × 29,400; RG-F7 Σ order values), and pack §4 grades severity on "Σ order
totals"; pack §5 names `expected_net_minor` instead, which the dispute claims (reported). Severity L on that Σ.
Dedupe `<outlet>:<channel>:<orders>` (R-B S1-C), `<orders>` a sha256 prefix of the channel's unsettled order ids, sorted:
the finding and its draft follow the set of unsettled orders, not the calendar. The same backlog next week is the same
finding (merged, its draft recorded once); a backlog that changes (an order settled, a new one late) is a new finding
whose draft claims the new set. Pack §4's `<channel>:<iso_week>` re-raised the same orders weekly, each week a new
claim on them.
Draft (pack §6): `finance.dispute.draft.v1`, basis `missing_payout`, total ← the Σ row's `expected_net_minor`, and one
line per unsettled order of the channel, `{order_id, claimed_minor ← that order row's expected_net_minor}`, so core
holds each order in one open dispute at a time (a second draft over any of them goes stale on approval). Drafted only
when the order rows' cells add up to the Σ cell exactly (core refuses lines that do not sum to the total).
"""

from __future__ import annotations

import hashlib
from collections.abc import Sequence

from munim_intel.detect import DetectorSpec, Hit, Ladder, OutletFrame, Row, Severity, Thresholds, Window, num, register
from munim_intel.mapping import Detection, Proposal, snap_ref


def windows(outlet: OutletFrame, _: Thresholds) -> list[Window]:
    day = outlet.business_date
    return [Window({"channel_id": None, "as_of": day.isoformat(), "outlet_id": outlet.id}, day.isoformat())]


def fires(row: Row, t: Thresholds) -> bool:
    oldest = num(row, "days_unsettled")
    return row.get("order_id") is None and isinstance(row.get("channel_id"), str) and oldest is not None and oldest > t["days_unsettled_gt"]


def severity(row: Row, _: Thresholds, ladder: Ladder) -> Severity:
    return ladder.of(num(row, "order_total_minor") or 0)


def orders_of(rows: Sequence[Row], channel: object) -> list[tuple[int, Row]]:
    """The channel's order rows (index, row), in snapshot order."""
    return [(i, r) for i, r in enumerate(rows) if isinstance(r.get("order_id"), str) and r.get("channel_id") == channel]


def orders_key(rows: Sequence[Row], channel: object) -> str:
    ids = sorted(str(r["order_id"]) for _, r in orders_of(rows, channel))
    return hashlib.sha256("\n".join(ids).encode()).hexdigest()[:32]


def dedupe(row: Row, w: Window) -> str:
    """Unused by the pipeline (`select` keys every hit with its order set); the key's outlet and channel part."""
    return f"{w.params['outlet_id']}:{row['channel_id']}"


def select(rows: Sequence[Row], w: Window, t: Thresholds, ladder: Ladder) -> list[Hit]:
    return [
        Hit(i, i, severity(r, t, ladder), f"{dedupe(r, w)}:{orders_key(rows, r['channel_id'])}") for i, r in enumerate(rows) if fires(r, t)
    ]


def dispute(d: Detection) -> Proposal | None:
    channel = str(d.row["channel_id"])  # `fires` admits only Σ rows whose channel_id is a uuid string
    picked = orders_of(d.rows, channel)
    if not picked or sum(num(r, "expected_net_minor") or 0 for _, r in picked) != num(d.row, "expected_net_minor"):
        return None
    lines = [
        {"settlement_line_id": None, "order_id": r["order_id"], "claimed_minor": snap_ref(d.snapshot_id, i, "expected_net_minor")}
        for i, r in picked
    ]
    total = d.ref("expected_net_minor")
    return Proposal(
        command_type="finance.dispute.draft.v1",
        payload={
            "channel_id": channel,
            "basis": "missing_payout",
            "lines": lines,
            "total_claimed_minor": total,
            "currency": d.currency,
            "break_ids": [],
        },
        based_on=[total, *(str(x["claimed_minor"]) for x in lines)],
        targets=[channel, *sorted(str(x["order_id"]) for x in lines)],
        minted=["dispute_id"],
    )


SPEC = register(
    DetectorSpec(
        id="finance.missing_payout",
        thresholds=("days_unsettled_gt",),
        pack="finance",
        template="finance.missing_payouts",
        finding_type="reconciliation_break.missing_payout",
        impact_column="order_total_minor",
        windows=windows,
        fires=fires,
        severity=severity,
        dedupe=dedupe,
        narration=(
            "Completed orders on this channel are in no payout: {order_total_minor} in order value, the oldest unpaid for "
            "{days_unsettled} days. After its commission the channel owes {expected_net_minor} for them."
        ),
        mapping=dispute,
        select=select,
    )
)
