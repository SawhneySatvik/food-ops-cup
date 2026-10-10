from __future__ import annotations

import json
from dataclasses import asdict
from datetime import date, timedelta

from . import methods
from .model import (NAIVE, WEIGHTED, ForecastPoint, MethodResult, Metrics, Series, SeriesForecast)

HOLDOUT = 28
HORIZON = 7
MIN_HISTORY = 28            # forecast.md §2: fewer days -> no points
MIN_BACKTEST = HOLDOUT + 28  # a holdout needs a full 4 weeks of training before its first origin
PARAMS = {NAIVE: methods.NAIVE_PARAMS, WEIGHTED: methods.WEIGHTED_PARAMS}


def _values(s: Series) -> list:
    return [None if c else float(q) for q, c in zip(s.qty_milli, s.closed)]


def _backtest(v: list, method: str):
    """4 weekly origins, 7-day horizon over the last 28 days. Returns (Metrics, signed residuals y-yhat)."""
    t = len(v)
    abs_err = actual = signed = 0.0
    resid: list[int] = []
    for m in range(HOLDOUT // HORIZON):
        origin = t - HOLDOUT + HORIZON * m - 1
        pred = methods.forecast(v, origin, HORIZON, method)
        for h, p in enumerate(pred, start=1):
            y = v[origin + h]
            if y is None:
                continue
            abs_err += abs(y - p)
            signed += p - y
            actual += y
            resid.append(round(y - p))
    diffs = [abs(v[i] - v[i - 7]) for i in range(7, t - HOLDOUT) if v[i] is not None and v[i - 7] is not None]
    scale = sum(diffs) / len(diffs) if diffs else 0.0
    mase = round(1000 * (abs_err / len(resid)) / scale) if resid and scale > 0 else None
    met = Metrics(
        wape_bp=round(10000 * abs_err / actual) if actual > 0 else None,
        bias_bp=round(10000 * signed / actual) if actual > 0 else None,
        mase_milli=mase, abs_err_milli=round(abs_err), actual_milli=round(actual), days=len(resid))
    return met, sorted(resid)


def _result(s: Series, v: list, method: str, backtest: bool) -> MethodResult:
    met, resid = _backtest(v, method) if backtest else (None, [])
    pred = methods.forecast(v, len(v) - 1, HORIZON, method)
    pts = []
    for h, p in enumerate(pred, start=1):
        q = max(0, round(p))
        if resid:
            lo = max(0, min(q, q + resid[(len(resid) - 1) * 10 // 100]))
            hi = max(q, q + resid[((len(resid) - 1) * 90 + 99) // 100])
        else:
            lo = hi = None
        pts.append(ForecastPoint(s.start + timedelta(days=len(v) - 1 + h), q, lo, hi))
    return MethodResult(method, PARAMS[method], met, tuple(pts))


def forecast_series(s: Series, default: str = "auto") -> SeriesForecast:
    """default="auto": serve WEIGHTED only if its backtest WAPE is strictly below naive's, else naive.
    default=NAIVE: always serve naive (the ship_default fallback). Both methods' points are always emitted."""
    v = _values(s)
    through = s.start + timedelta(days=len(v) - 1)
    base = dict(outlet_id=s.outlet_id, item_id=s.item_id, trained_through=through, horizon_days=HORIZON)
    if len(v) < MIN_HISTORY:
        return SeriesForecast(**base, holdout_days=0, status="insufficient_history", served=None,
                              served_reason="-", methods=())
    bt = len(v) >= MIN_BACKTEST
    res = tuple(_result(s, v, m, bt) for m in (NAIVE, WEIGHTED))
    if not bt:
        served, why = NAIVE, "no_backtest"
    elif default == NAIVE:
        served, why = NAIVE, "default_naive"
    else:
        n, w = res[0].metrics.wape_bp, res[1].metrics.wape_bp
        beats = n is not None and w is not None and w < n
        served, why = (WEIGHTED, "beats_naive") if beats else (NAIVE, "naive_not_beaten")
    return SeriesForecast(**base, holdout_days=HOLDOUT if bt else 0, status="ok", served=served,
                          served_reason=why, methods=res)


def ship_default(worlds: dict[str, list[SeriesForecast]]) -> tuple[str, dict[str, dict]]:
    """N5 gate (BOARD T-052): WEIGHTED is the default only if its pooled WAPE beats naive's on >= 2 worlds,
    else prints FAIL and ships naive. Pooled = sum|err| / sum actual over every backtested series."""
    report: dict[str, dict] = {}
    wins = 0
    for name in sorted(worlds):
        agg = {NAIVE: [0, 0], WEIGHTED: [0, 0]}
        for f in worlds[name]:
            for m in f.methods:
                if m.metrics:
                    agg[m.method][0] += m.metrics.abs_err_milli
                    agg[m.method][1] += m.metrics.actual_milli
        wape = {k: (round(10000 * a / d) if d else None) for k, (a, d) in agg.items()}
        win = wape[NAIVE] is not None and wape[WEIGHTED] is not None and wape[WEIGHTED] < wape[NAIVE]
        wins += win
        report[name] = {"naive_wape_bp": wape[NAIVE], "weighted_wape_bp": wape[WEIGHTED], "weighted_wins": win}
    if wins >= 2:
        return WEIGHTED, report
    print(f"FAIL: {WEIGHTED} beat {NAIVE} on {wins}/{len(worlds)} worlds (need >= 2); shipping {NAIVE}")
    return NAIVE, report


def _enc(o):
    if isinstance(o, date):
        return o.isoformat()
    raise TypeError(type(o))


def serialise(fs: list[SeriesForecast]) -> bytes:
    """Canonical bytes: sorted keys, no whitespace, ints and strings only."""
    return json.dumps([asdict(f) for f in fs], sort_keys=True, separators=(",", ":"), default=_enc).encode()
