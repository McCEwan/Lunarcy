"""Scenario tools for "what if we land a bit later, or a bit further over?"

    best_dates(sky, skyline, start, days, mission_days, priority)   -> GET /site/dates
    nearby(heights, lat, lon, sky, radius_m, n)                      -> GET /site/nearby

Both reuse ONE Sun/Earth series for the site (JPL Horizons via the ephemeris provider).

best_dates: every hour in the search span is a candidate touchdown. For each, the share of
the next `mission_days` with the Sun above the terrain skyline, with Earth above it, and with
both at once (cumulative sums, so a year of hours costs milliseconds). Each day reports its
best hour; the top days (at least 2 days apart) are the recommendations. The score is the
mean of Sun % and Earth % ("both"), or one of them ("sun" / "comms").

nearby: a grid of points within ±radius around the site. Each gets its own terrain skyline
(NASA LOLA, 2° azimuth steps, out to 150 km) and is scored against the site's Sun/Earth
series: across a few km the Sun and Earth are in practically the same direction, only the
skyline changes. Shows how much a small move changes sunlight and Earth contact.
"""

from __future__ import annotations

import math
from datetime import date

import numpy as np

from .evaluator import skyline_at
from .finder import compute_skylines
from .lola import destination
from .patch import OBSERVER_HEIGHT_M
from .siteplan import local_en

PRIORITIES = ("both", "sun", "comms")


def best_dates(sky, skyline, times: np.ndarray, start: date, days: int, mission_days: float,
               priority: str = "both", top: int = 5) -> dict:
    """See the module docstring. `times` are the hourly samples of `sky`, starting at `start`."""
    H = int(round(mission_days * 24))
    sun_vis = sky.sun_el > skyline_at(skyline, sky.sun_az)
    earth_vis = sky.earth_el > skyline_at(skyline, sky.earth_az)
    both_vis = sun_vis & earth_vis
    n_start = days * 24                                       # candidate touchdown hours
    if len(sun_vis) < n_start + H:
        raise ValueError("sky series shorter than the search span plus the mission")

    def window_pct(v):
        c = np.concatenate([[0], np.cumsum(v.astype(np.int32))])
        return 100.0 * (c[H:H + n_start] - c[:n_start]) / H

    sun_p, earth_p, both_p = window_pct(sun_vis), window_pct(earth_vis), window_pct(both_vis)
    score = {"both": (sun_p + earth_p) / 2, "sun": sun_p, "comms": earth_p}[priority]
    # Prefer touchdowns with the Sun up and in view (a lander needs light to start working).
    score = score - np.where(sun_vis[:n_start], 0.0, 5.0)

    daily = []
    for d in range(days):
        sl = slice(d * 24, d * 24 + 24)
        i = d * 24 + int(np.argmax(score[sl]))
        # Hours of sunlight left after touchdown before the Sun next drops behind terrain.
        rest = sun_vis[i:]
        to_sunset = int(np.argmin(rest)) if not rest.all() else None
        daily.append({
            "date": str(np.datetime64(times[i], "D")),
            "time": str(np.datetime64(times[i], "m")) + "Z",
            "sun_pct": round(float(sun_p[i]), 1),
            "earth_pct": round(float(earth_p[i]), 1),
            "both_pct": round(float(both_p[i]), 1),
            "score": round(float(score[i]), 1),
            "sun_up_at_touchdown": bool(sun_vis[i]),
            "hours_to_sunset": to_sunset,
        })

    picks, taken = [], []
    for d in sorted(range(days), key=lambda k: -daily[k]["score"]):
        if all(abs(d - t) >= 2 for t in taken):
            picks.append(daily[d])
            taken.append(d)
        if len(picks) >= top:
            break
    return {
        "start": str(start), "days": days, "mission_days": mission_days, "priority": priority,
        "daily": daily, "best": picks,
        "method": ("Every hour is a candidate touchdown; each is scored on the next "
                   f"{mission_days:g} days: Sun above the terrain skyline, Earth above it, and both at once."),
        "source": sky.source,
    }


def nearby(heights, lat: float, lon: float, sky, radius_m: float = 3000.0, n: int = 9) -> dict:
    """See the module docstring."""
    axis = np.linspace(-radius_m, radius_m, n)
    E, N = np.meshgrid(axis, axis[::-1])                       # row 0 = north
    plat, plon = destination(np.full(E.shape, lat), np.full(E.shape, lon),
                             np.degrees(np.arctan2(E, N)), np.hypot(E, N))
    # The same skyline and visibility test as /evaluate (1°, 300 samples from 30 m, interpolated),
    # so the site's own square matches its stat tiles.
    sk = compute_skylines(heights, plat.ravel(), plon.ravel(), az_step=1.0, samples=300,
                          radius_m=150_000.0, observer_m=OBSERVER_HEIGHT_M, r0_m=30.0)
    sun = np.array([100.0 * (sky.sun_el > skyline_at(row, sky.sun_az)).mean() for row in sk]).reshape(E.shape)
    earth = np.array([100.0 * (sky.earth_el > skyline_at(row, sky.earth_az)).mean() for row in sk]).reshape(E.shape)
    # Local slope at each point (over ±res), so a better spot that is a cliff isn't suggested.
    b = max(float(getattr(heights, "resolution_m", 200.0)), 60.0)
    h = [heights.heights(*destination(plat, plon, np.full(E.shape, brg), np.full(E.shape, b)))
         for brg in (90.0, 270.0, 0.0, 180.0)]
    slope = np.degrees(np.arctan(np.hypot((h[0] - h[1]) / (2 * b), (h[2] - h[3]) / (2 * b))))
    c = n // 2

    def best(score):
        ok = np.where(slope <= 10.0, score, -np.inf)
        r, col = np.unravel_index(int(np.argmax(ok)), ok.shape)
        e, nn, dist = local_en(lat, lon, float(plat[r, col]), float(plon[r, col]))
        return {"lat": round(float(plat[r, col]), 5), "lon": round(float(plon[r, col]), 5),
                "sun_pct": round(float(sun[r, col]), 1), "earth_pct": round(float(earth[r, col]), 1),
                "slope_deg": round(float(slope[r, col]), 1), "distance_m": round(dist),
                "bearing_deg": round(math.degrees(math.atan2(e, nn)) % 360, 1)}

    rnd = lambda a, k=1: [[round(float(v), k) for v in row] for row in a]   # noqa: E731
    return {
        "radius_m": radius_m, "n": n, "spacing_m": round(2 * radius_m / (n - 1)),
        "lat": rnd(plat, 5), "lon": rnd(plon, 5),
        "sun_pct": rnd(sun), "earth_pct": rnd(earth), "slope_deg": rnd(slope),
        "centre": {"sun_pct": round(float(sun[c, c]), 1), "earth_pct": round(float(earth[c, c]), 1)},
        "best_sun": best(sun), "best_earth": best(earth), "best_both": best((sun + earth) / 2),
        "spread": {"sun_pct": [round(float(sun.min()), 1), round(float(sun.max()), 1)],
                   "earth_pct": [round(float(earth.min()), 1), round(float(earth.max()), 1)]},
        "method": ("Each point gets its own NASA LOLA terrain skyline (1° steps, out to 150 km) seen from 2 m, "
                   "the same method as the site's stats, scored against the site's Sun/Earth series. "
                   "Suggestions skip ground steeper than 10°."),
        "source": sky.source,
    }
