"""The core: evaluate a landing site, optionally for a lander and a landing date.

`evaluate()` does no file or network I/O itself. The caller (api/main.py)
passes in terrain, lander data and an ephemeris provider. The production
provider (Horizons) fetches over the network; tests pass the offline one.
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta

import numpy as np

from . import ephemeris
from .terrain import TerrainSample

# ---- Config: tune these ----------------------------------------------------
STEP_HOURS = 1.0
LUNAR_DAY_DAYS = 29.53            # series length for site-only requests
WINDOW_SEARCH_DAYS = 120          # how far ahead to look for landing windows
MIN_SUNLIGHT_PCT = 60.0           # over the mission
MIN_EARTH_VISIBLE_PCT = 80.0      # over the mission
MIN_TOUCHDOWN_SUN_EL_DEG = 2.0    # Sun must be up when the lander arrives
SOLAR_CONSTANT_W_M2 = 1361.0
REFERENCE_PANEL_M2 = 1.0          # used for power_w when no lander is chosen
REFERENCE_PANEL_EFF = 0.30
# -----------------------------------------------------------------------------


def evaluate(
    lat: float,
    lon: float,
    *,
    terrain: TerrainSample | None,
    search_start: date,
    ephem,
    lander: dict | None = None,
    payload_kg: float | None = None,
    landing_date: date | None = None,
    landing_time: datetime | None = None,
    sources: list[str] | None = None,
) -> dict:
    """Return a dict shaped like the /evaluate response in docs/ARCHITECTURE.md.

    `ephem` is any object with `sky(lat, lon, times) -> ephemeris.Sky`.
    `landing_time` (naive UTC, hour precision) wins over `landing_date` (00:00 UTC).
    """
    # The landing moment, if one was chosen.
    landing: datetime | None = landing_time or (
        datetime.combine(landing_date, time()) if landing_date else None
    )

    # Which stretch of time the sky/power/comms series cover.
    series_start = landing or search_start
    if lander and landing:
        series_days = lander["mission_days"]
    else:
        series_days = LUNAR_DAY_DAYS

    times = ephemeris.time_grid(series_start, series_days, STEP_HOURS)
    sky = ephem.sky(lat, lon, times)
    sun_el, earth_el = sky.sun_el, sky.earth_el
    used_sources = [sky.source]

    if lander:
        area, eff = lander["solar_array_m2"], lander["solar_efficiency"]
    else:
        area, eff = REFERENCE_PANEL_M2, REFERENCE_PANEL_EFF
    power = _power_w(sun_el, area, eff)

    sunlight_pct = _pct(sun_el > 0)
    earth_pct = _pct(earth_el > 0)

    checks: list[dict] = []
    windows = None
    launch_estimate = None

    if lander:
        site_checks = _site_checks(terrain, lander, payload_kg)
        checks.extend(site_checks)
        if landing:
            checks.extend(_date_checks(sun_el, earth_el, lander))
            launch_estimate = landing.date() - timedelta(days=lander["transit_days"])
        else:
            site_ok = all(c["pass"] for c in site_checks)
            # Earliest possible landing is a launch today plus the transit time.
            earliest_landing = search_start + timedelta(days=lander["transit_days"])
            windows = []
            if site_ok:
                windows, window_source = _find_windows(lat, lon, lander, earliest_landing, ephem)
                used_sources.append(window_source)
            if windows:
                launch_estimate = windows[0]["start"] - timedelta(days=lander["transit_days"])

    labels = [_iso(t) for t in times]
    return {
        "site": {
            "slope_deg": terrain.slope_deg if terrain else None,
            "elevation_m": terrain.elevation_m if terrain else None,
            "temp_range_k": _temp_range(terrain),
            "sunlight_pct": sunlight_pct,
            "earth_visible_pct": earth_pct,
        },
        "sky": [
            {
                "t": t,
                "sun_el": round(float(se), 2), "sun_az": round(float(sa), 1),
                "earth_el": round(float(ee), 2), "earth_az": round(float(ea), 1),
            }
            for t, se, sa, ee, ea in zip(labels, sun_el, sky.sun_az, earth_el, sky.earth_az)
        ],
        "events": {
            "sunrise": _first_crossing(sun_el, labels, rising=True),
            "sunset": _first_crossing(sun_el, labels, rising=False),
            "earthrise": _first_crossing(earth_el, labels, rising=True),
            "earthset": _first_crossing(earth_el, labels, rising=False),
        },
        "power_w": [{"t": t, "w": round(float(w), 1)} for t, w in zip(labels, power)],
        "comms": [{"t": t, "visible": bool(e > 0)} for t, e in zip(labels, earth_el)],
        "windows": windows,
        "launch_estimate": launch_estimate,
        "checks": checks,
        "pass": all(c["pass"] for c in checks) if checks else None,
        "sources": list(dict.fromkeys(used_sources + (sources or []))),
    }


# ---- Checks -----------------------------------------------------------------

def _site_checks(terrain: TerrainSample | None, lander: dict, payload_kg: float | None) -> list[dict]:
    name = lander["name"]
    checks = []

    slope = terrain.slope_deg if terrain else None
    limit = lander["max_slope_deg"]
    if slope is None:
        checks.append(_check("slope", False, "No terrain data here, so slope can't be checked"))
    else:
        ok = slope <= limit
        word = "under" if ok else "over"
        checks.append(_check("slope", ok, f"{slope:.1f}° is {word} {name}'s {limit:g}° limit"))

    tmax = terrain.tmax_k if terrain else None
    rated = lander["max_surface_temp_k"]
    if tmax is None:
        checks.append(_check("temperature", False, "No temperature data here"))
    else:
        ok = tmax <= rated
        verdict = "within" if ok else "above"
        checks.append(_check(
            "temperature", ok,
            f"Daytime high of {tmax:.0f} K is {verdict} {name}'s rated {rated:g} K",
        ))

    cap = lander["payload_capacity_kg"]
    if payload_kg is None:
        checks.append(_check("payload", True, f"No payload entered ({cap:g} kg capacity)"))
    else:
        checks.append(_check("payload", payload_kg <= cap, f"{payload_kg:g} kg of {cap:g} kg capacity"))

    return checks


def _date_checks(sun_el: np.ndarray, earth_el: np.ndarray, lander: dict) -> list[dict]:
    sun_pct = _pct(sun_el > 0)
    touchdown_el = float(sun_el[0])
    if touchdown_el < MIN_TOUCHDOWN_SUN_EL_DEG:
        sun_check = _check(
            "sunlight", False,
            f"Sun is {touchdown_el:.1f}° above the horizon at touchdown, "
            f"needs at least {MIN_TOUCHDOWN_SUN_EL_DEG:g}°",
        )
    else:
        ok = sun_pct >= MIN_SUNLIGHT_PCT
        sun_check = _check(
            "sunlight", ok,
            f"{sun_pct:.0f}% sun over the {lander['mission_days']:g}-day mission "
            f"(needs {MIN_SUNLIGHT_PCT:g}%)",
        )

    earth_pct = _pct(earth_el > 0)
    comms_check = _check(
        "comms", earth_pct >= MIN_EARTH_VISIBLE_PCT,
        f"Earth visible {earth_pct:.0f}% of the mission (needs {MIN_EARTH_VISIBLE_PCT:g}%)",
    )
    return [sun_check, comms_check]


def _check(name: str, ok: bool, detail: str) -> dict:
    return {"name": name, "pass": bool(ok), "detail": detail}


# ---- Landing windows ----------------------------------------------------------

def _find_windows(lat: float, lon: float, lander: dict, search_start: date, ephem) -> tuple[list[dict], str]:
    """Runs of landing hours in the search range that pass the time-dependent checks.

    Every hourly step is a candidate touchdown, so each window's `start_time` is the
    earliest hour a landing works: the suggested landing time.
    """
    mission_steps = int(round(lander["mission_days"] * 24 / STEP_HOURS))
    steps_per_day = int(round(24 / STEP_HOURS))
    times = ephemeris.time_grid(search_start, WINDOW_SEARCH_DAYS + lander["mission_days"], STEP_HOURS)
    sky = ephem.sky(lat, lon, times)
    sun_el, earth_el = sky.sun_el, sky.earth_el
    starts = np.arange(WINDOW_SEARCH_DAYS * steps_per_day)

    # Percent of each mission-length slice with the body up, via cumulative sums.
    def slice_pct(mask: np.ndarray) -> np.ndarray:
        c = np.concatenate([[0], np.cumsum(mask)])
        return 100.0 * (c[starts + mission_steps] - c[starts]) / mission_steps

    ok = (
        (sun_el[starts] >= MIN_TOUCHDOWN_SUN_EL_DEG)
        & (slice_pct(sun_el > 0) >= MIN_SUNLIGHT_PCT)
        & (slice_pct(earth_el > 0) >= MIN_EARTH_VISIBLE_PCT)
    )
    return _runs_to_windows(ok, times), sky.source


def _runs_to_windows(ok: np.ndarray, times: np.ndarray) -> list[dict]:
    windows, run_start = [], None
    for i, good in enumerate(list(ok) + [False]):
        if good and run_start is None:
            run_start = i
        elif not good and run_start is not None:
            first, last = times[run_start], times[i - 1]
            windows.append({
                "start": first.astype("datetime64[D]").item(),
                "end": last.astype("datetime64[D]").item(),
                "start_time": _iso(first),
                "end_time": _iso(last),
            })
            run_start = None
    return windows


# ---- Helpers ------------------------------------------------------------------

def _power_w(sun_el_deg: np.ndarray, area_m2: float, eff: float) -> np.ndarray:
    # Flat panel, no terrain shadowing (see docs/ARCHITECTURE.md).
    return np.clip(SOLAR_CONSTANT_W_M2 * np.sin(np.radians(sun_el_deg)) * area_m2 * eff, 0, None)


def _first_crossing(el: np.ndarray, labels: list[str], rising: bool) -> str | None:
    """Time of the first horizon crossing in the series (rise or set), or None."""
    up = el > 0
    change = (~up[:-1] & up[1:]) if rising else (up[:-1] & ~up[1:])
    idx = np.flatnonzero(change)
    return labels[idx[0] + 1] if len(idx) else None


def _pct(mask: np.ndarray) -> float:
    return round(100.0 * float(np.mean(mask)), 1)


def _temp_range(terrain: TerrainSample | None) -> list[float] | None:
    if terrain is None or terrain.tmin_k is None or terrain.tmax_k is None:
        return None
    return [terrain.tmin_k, terrain.tmax_k]


def _iso(t: np.datetime64) -> str:
    return str(t.astype("datetime64[m]")) + "Z"
