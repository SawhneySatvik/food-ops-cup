"""NegotiationPolicy (ledger R45 F4; 04 §6 step 2; pack inventory-purchasing §6): the rules that bound every move.

Each decision round, for each supplier still open, the rules compute the **allowed move set** and the **default move**;
the counter price is the rule's (best rival, pack §6), never a model's. A chooser's answer outside the set — or none at
all (budget, error) — becomes the default. Prices are basis points of the RFQ's reference price (the tenant's last
supplier price), rounded half-up in integers. The target and walk-away are the owner's (ledger R47 D7: business policy,
served by core's run-frame, which applies the 9500 / 11000 default when the owner set none) — never an intel constant.

  accept   allowed when the supplier's latest price ≤ walk-away
  counter  allowed while the supplier has had fewer than `max_counters` counters, the run can still pay to read the
           replies (`affordable`: a run-level budget stop must not leave countered suppliers unread), and a counter
           price exists: the lowest latest price of a rival still in play, if below this supplier's; else the target, if below
  walk     always allowed
  default  counter if allowed, else accept if allowed, else walk
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

from munim_intel.contracts_gen.models import InternalRunFrameResponse

Move = Literal["accept", "counter", "walk"]
MOVES: tuple[Move, ...] = ("accept", "counter", "walk")


def bp_of(reference_minor: int, bp: int) -> int:
    return (reference_minor * bp + 5_000) // 10_000


@dataclass(frozen=True)
class NegotiationPolicy:
    #: The owner's bounds, basis points of the reference price: aim at the target, never pay above the walk-away.
    target_bp: int
    walk_away_bp: int
    #: Pack §6: ≤ 2 counter rounds. With the RFQ round, a supplier quotes at most 3 times (quote `round` 1..3).
    max_counters: int = 2

    def __post_init__(self) -> None:
        # intel.supplier_quote CHECK (round BETWEEN 1 AND 3): the RFQ round plus at most two counters.
        if not 0 <= self.max_counters <= 2:
            raise ValueError("max_counters must be 0..2: a supplier quotes in rounds 1..3")

    @property
    def decision_rounds(self) -> int:
        return self.max_counters + 1


def policy_from(frame: InternalRunFrameResponse) -> NegotiationPolicy:
    """The run's business's policy: the owner's bounds as core served them on the run-frame (R47 D7)."""
    return NegotiationPolicy(target_bp=frame.negotiation.target_bp, walk_away_bp=frame.negotiation.walkaway_bp)


@dataclass(frozen=True)
class Options:
    allowed: tuple[Move, ...]
    default: Move
    #: The rule's counter price (minor units per unit), when `counter` is allowed.
    counter_minor: int | None
    walk_away_minor: int


def options(
    policy: NegotiationPolicy, reference_minor: int, own_minor: int, rivals_minor: Sequence[int], counters: int, *, affordable: bool = True
) -> Options:
    walk_away = bp_of(reference_minor, policy.walk_away_bp)
    target = bp_of(reference_minor, policy.target_bp)
    best = min(rivals_minor, default=None)
    counter = best if best is not None and best < own_minor else target if target < own_minor else None
    allowed: list[Move] = []
    if own_minor <= walk_away:
        allowed.append("accept")
    if counters < policy.max_counters and affordable and counter is not None:
        allowed.append("counter")
    else:
        counter = None
    allowed.append("walk")
    default: Move = "counter" if "counter" in allowed else "accept" if "accept" in allowed else "walk"
    return Options(tuple(allowed), default, counter, walk_away)


def resolve(o: Options, choice: object) -> tuple[Move, bool]:
    """(the move to make, whether the choice was in the allowed set). Python re-validates every choice (F4)."""
    for m in o.allowed:
        if choice == m:
            return m, True
    return o.default, False
