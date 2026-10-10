import sys
from datetime import date, timedelta
from fractions import Fraction

import pytest

from munim_intel.forecast import NAIVE, WEIGHTED, Series, forecast_series, serialise, ship_default
from munim_intel.forecast import engine
from . import synth


def mk(vals, closed=None, start=date(2026, 1, 5)):
    return Series("o", "i", start, tuple(vals), tuple(closed or [False] * len(vals)))


def pts(f, method):
    return [p.qty_milli for p in next(m for m in f.methods if m.method == method).points]


# ---------- hand-computed fixtures ----------
def test_naive_three_week_toy_hand_values():
    wk = lambda b: [b + 10 * k for k in range(7)]  # Mon..Sun
    s = mk(wk(10) + wk(11) + wk(12))                # 21 days -> too short for forecast_series; use the method
    from munim_intel.forecast import methods
    v = [float(x) for x in s.qty_milli]
    got = methods.forecast(v, 20, 7, NAIVE)
    assert got == [12, 22, 32, 42, 52, 62, 72]      # hand: next week repeats week 3


def test_naive_closed_day_falls_back_one_week_further():
    from munim_intel.forecast import methods
    wk = lambda b: [b + 10 * k for k in range(7)]
    v = [float(x) for x in wk(10) + wk(11) + wk(12)]
    v[14] = None  # Monday of week 3 closed (value 12 ignored)
    assert methods.forecast(v, 20, 1, NAIVE) == [11.0]  # Monday week 2


def test_weighted_hand_value_level_shift():
    # weeks 1-4 flat 100.000, week 5 flat 120.000. Every day: base = .4*120+.3*100+.2*100+.1*100 = 108;
    # fitted for week 5 = 100 each day (weeks 4..1 all 100) -> L = 120/100 = 1.2 (inside [0.8,1.25]); 108*1.2 = 129.6
    s = mk([100000] * 28 + [120000] * 7)
    f = forecast_series(s)
    assert f.status == "ok" and f.served == NAIVE and f.served_reason == "no_backtest"  # 35 d < 56 d
    assert pts(f, WEIGHTED) == [129600] * 7
    assert pts(f, NAIVE) == [120000] * 7


def ref_weighted(vals, closed, origin, h):
    """Independent reference: exact Fractions, history grouped per weekday, most recent first."""
    W = [Fraction(2, 5), Fraction(3, 10), Fraction(1, 5), Fraction(1, 10)]
    def hist(i):  # open same-weekday values before day i, as {k: value}
        return {k: Fraction(vals[i - 7 * k]) for k in range(1, 5) if i - 7 * k >= 0 and not closed[i - 7 * k]}
    def base(i):
        hh = hist(i)
        return sum(W[k - 1] * x for k, x in hh.items()) / sum(W[k - 1] for k in hh)
    act = fit = Fraction(0)
    for j in range(origin - 6, origin + 1):
        if not closed[j] and hist(j):
            act += vals[j]; fit += base(j)
    L = min(Fraction(5, 4), max(Fraction(4, 5), act / fit))
    return base(origin + h) * L  # h <= 7 so history of origin+h is all <= origin


def test_weighted_matches_independent_reference():
    import random
    rng = random.Random(5)
    vals = [round(1000 * (50 + 8 * (i % 7)) * rng.uniform(0.7, 1.3)) for i in range(70)]
    closed = [False] * 70
    closed[40] = closed[64] = True
    f = forecast_series(mk(vals, closed))
    origin = 69
    for h, got in enumerate(pts(f, WEIGHTED), start=1):
        assert abs(got - round(ref_weighted(vals, closed, origin, h))) <= 1, h


# ---------- closed days ----------
def test_closed_day_is_not_demand_zero():
    P = [30, 32, 35, 40, 55, 70, 60]
    vals = [1000 * P[i % 7] for i in range(84)]
    base = forecast_series(mk(vals))
    k = 84 - 4  # a closure in the last week (origin is day 83)
    closed = [i == k for i in range(84)]
    v_closed = list(vals); v_closed[k] = 0
    ok = forecast_series(mk(v_closed, closed))
    bad = forecast_series(mk(v_closed))          # same zero, but not flagged closed
    for m in (NAIVE, WEIGHTED):
        a, b, c = pts(base, m), pts(ok, m), pts(bad, m)
        assert b == a, m                          # closure flagged: forecast unchanged
    # control: the unflagged zero must visibly drag the weighted forecast (else this test proves nothing)
    assert sum(pts(bad, WEIGHTED)) < 0.9 * sum(pts(base, WEIGHTED))
    assert min(pts(bad, NAIVE)) == 0 and min(pts(ok, NAIVE)) > 0


# ---------- synthetic worlds ----------
def run_worlds():
    return {n: [forecast_series(s) for s in synth.world(n)] for n in synth.WORLDS}


def test_method_beats_naive_on_at_least_two_worlds(capsys):
    default, report = ship_default(run_worlds())
    for n, r in report.items():
        print(f"WORLD {n}: naive_wape_bp={r['naive_wape_bp']} weighted_wape_bp={r['weighted_wape_bp']} wins={r['weighted_wins']}")
    assert sum(r["weighted_wins"] for r in report.values()) >= 2
    assert default == WEIGHTED


def test_ship_default_prints_fail_and_ships_naive(capsys):
    from munim_intel.forecast import MethodResult, Metrics, SeriesForecast
    def fake(nv, wv):
        mk_m = lambda m, e: MethodResult(m, {}, Metrics(None, None, None, e, 1000, 28), ())
        return [SeriesForecast("o", "i", date(2026, 1, 1), 7, 28, "ok", NAIVE, "-", (mk_m(NAIVE, nv), mk_m(WEIGHTED, wv)))]
    worlds = {"a": fake(100, 200), "b": fake(100, 200), "c": fake(100, 50), "d": fake(100, 100)}  # 1 win (tie is not a win)
    default, rep = ship_default(worlds)
    assert default == NAIVE
    assert "FAIL" in capsys.readouterr().out
    worlds["d"] = fake(100, 50)
    assert ship_default(worlds)[0] == WEIGHTED


def test_naive_default_serves_naive_everywhere():
    for s in synth.world("cloud_kitchen")[:4]:
        f = forecast_series(s, default=NAIVE)
        assert f.served == NAIVE and f.served_reason == "default_naive"
        assert len(f.methods) == 2  # both methods still emitted for live accuracy


def test_choice_is_per_series_and_only_on_strict_win():
    for s in synth.world("store")[:6]:
        f = forecast_series(s)
        n, w = (m.metrics.wape_bp for m in f.methods)
        assert f.served == (WEIGHTED if w < n else NAIVE)


# ---------- shape / refusals ----------
def test_insufficient_history_gives_no_points():
    f = forecast_series(mk([1000] * 27))
    assert f.status == "insufficient_history" and f.methods == () and f.served is None


def test_points_dates_intervals_and_metrics_present():
    f = forecast_series(synth.world("au_outlet")[0])
    assert f.holdout_days == 28 and f.trained_through == synth.START + timedelta(days=181)
    for m in f.methods:
        assert m.metrics.days == 28 and m.metrics.wape_bp > 0 and m.metrics.mase_milli > 0 and m.params
        assert [p.business_on for p in m.points] == [f.trained_through + timedelta(days=h) for h in range(1, 8)]
        assert all(0 <= p.lo_qty_milli <= p.qty_milli <= p.hi_qty_milli for p in m.points)
        assert any(p.hi_qty_milli > p.lo_qty_milli for p in m.points)


# ---------- determinism ----------
def test_two_runs_are_byte_identical():
    a = serialise([f for fs in run_worlds().values() for f in fs])
    b = serialise([f for fs in run_worlds().values() for f in fs])
    assert a == b and len(a) > 10000
    assert b"." not in a  # integers and ISO dates only: nothing float-formatted
