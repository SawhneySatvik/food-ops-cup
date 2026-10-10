"""Seeded synthetic series shaped like the four worldgen worlds (weekly seasonality, trend, closed days, noise)."""
import random
from datetime import date, timedelta

from munim_intel.forecast import Series

# name: (seed, outlets, items, base units/day, weekend lift, weekly trend, noise sd, closed weekday or None)
WORLDS = {
    "restaurant_group": (11, 3, 8, 40, 1.4, 0.004, 0.18, None),
    "cloud_kitchen": (22, 1, 10, 60, 1.25, 0.008, 0.22, None),
    "store": (33, 2, 10, 25, 1.15, 0.002, 0.20, 6),   # shut Sundays
    "au_outlet": (44, 1, 12, 30, 1.5, 0.003, 0.16, None),
}
DAYS = 182
START = date(2026, 1, 5)  # a Monday


def world(name: str, days: int = DAYS) -> list[Series]:
    seed, n_out, n_item, base, lift, trend, sd, shut = WORLDS[name]
    rng = random.Random(seed)
    out = []
    for o in range(n_out):
        for i in range(n_item):
            level = base * rng.uniform(0.3, 1.7) / (1 + i * 0.15)
            prof = [rng.uniform(0.85, 1.15) * (lift if wd >= 4 else 1.0) for wd in range(7)]
            q, c = [], []
            for d in range(days):
                wd = (START + timedelta(days=d)).weekday()
                closed = wd == shut
                mean = level * prof[wd] * (1 + trend * d / 7)
                q.append(0 if closed else max(0, round(1000 * mean * max(0.0, rng.gauss(1, sd)))))
                c.append(closed)
            out.append(Series(f"o{o}", f"i{i}", START, tuple(q), tuple(c)))
    return out
