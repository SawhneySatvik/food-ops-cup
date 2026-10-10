from __future__ import annotations

from dataclasses import dataclass
from datetime import date

NAIVE = "seasonal_naive"
WEIGHTED = "weighted_seasonal_v1"


@dataclass(frozen=True)
class Series:
    """Daily units for one (outlet, item); item_id None = the outlet's 'other' series.
    Contiguous business dates in the outlet's zone. A closed day's qty is ignored: closed is not demand 0."""
    outlet_id: str
    item_id: str | None
    start: date
    qty_milli: tuple[int, ...]
    closed: tuple[bool, ...]

    def __post_init__(self) -> None:
        if len(self.qty_milli) != len(self.closed):
            raise ValueError("qty_milli and closed differ in length")


@dataclass(frozen=True)
class Metrics:
    """All integers so serialisation is byte-stable. Errors are over holdout days the outlet was open."""
    wape_bp: int | None
    bias_bp: int | None
    mase_milli: int | None  # MAE / mean |y(t)-y(t-7)| on the pre-holdout history; None if scale is 0
    abs_err_milli: int      # numerator of WAPE, kept so worlds can be aggregated exactly
    actual_milli: int       # denominator of WAPE
    days: int


@dataclass(frozen=True)
class ForecastPoint:
    business_on: date
    qty_milli: int
    lo_qty_milli: int | None  # p10/p90 of this method's holdout residuals; None without a backtest
    hi_qty_milli: int | None


@dataclass(frozen=True)
class MethodResult:
    method: str
    params: dict
    metrics: Metrics | None  # None when history is too short to backtest
    points: tuple[ForecastPoint, ...]


@dataclass(frozen=True)
class SeriesForecast:
    outlet_id: str
    item_id: str | None
    trained_through: date
    horizon_days: int
    holdout_days: int
    status: str            # "ok" | "insufficient_history" (no points, reason_code per forecast.md §7)
    served: str | None     # method served for this series
    served_reason: str     # why: "beats_naive" | "naive_not_beaten" | "default_naive" | "no_backtest" | "-"
    methods: tuple[MethodResult, ...]
