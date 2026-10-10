"""The two forecasters, on a list of floats where None = unavailable (closed or unknown day)."""
from __future__ import annotations

W = (0.4, 0.3, 0.2, 0.1)  # weights for y(d-7), y(d-14), y(d-21), y(d-28)
L_MIN, L_MAX = 0.8, 1.25
WEIGHTED_PARAMS = {"weights_bp": [4000, 3000, 2000, 1000], "level_window_days": 7, "level_clip_bp": [8000, 12500]}  # ints: no float text in output
NAIVE_PARAMS = {"season_days": 7, "fallback_lags": 4}


def naive_at(v: list, i: int):
    """y(i-7); if that day was closed/unknown, the nearest earlier same weekday (up to 4 weeks back)."""
    for k in range(1, 5):
        j = i - 7 * k
        if j >= 0 and v[j] is not None:
            return v[j]
    return None


def weighted_at(v: list, i: int):
    """Sum_k w_k y(i-7k) over the available k, weights renormalised to the available ones."""
    num = den = 0.0
    for k, w in enumerate(W, start=1):
        j = i - 7 * k
        if j >= 0 and v[j] is not None:
            num += w * v[j]
            den += w
    return num / den if den else None


def level(v: list, origin: int) -> float:
    """L = last-7-day actual / last-7-day fitted (open days only), clipped. Fitted uses only days <= j-7."""
    act = fit = 0.0
    for j in range(max(0, origin - 6), origin + 1):
        if v[j] is None:
            continue
        f = weighted_at(v, j)
        if f is None:
            continue
        act += v[j]
        fit += f
    if fit <= 0:
        return 1.0
    return min(L_MAX, max(L_MIN, act / fit))


def _fallback(v: list, origin: int) -> float:
    xs = [x for x in v[max(0, origin - 27): origin + 1] if x is not None]
    return sum(xs) / len(xs) if xs else 0.0


def forecast(v: list, origin: int, horizon: int, method: str) -> list[float]:
    """Forecast days origin+1..origin+horizon from v[:origin+1]; beyond 7 days it recurses on its own output."""
    ext = list(v[: origin + 1])
    lv = level(ext, origin) if method == "weighted_seasonal_v1" else 1.0
    fb = _fallback(ext, origin)
    out = []
    for _ in range(horizon):
        i = len(ext)
        base = weighted_at(ext, i) if method == "weighted_seasonal_v1" else naive_at(ext, i)
        y = fb if base is None else base * lv
        out.append(y)
        ext.append(y)
    return out
