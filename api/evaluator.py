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
    period_start: date | None = None,
    period_end: date | None = None,
    skyline: list[float] | np.ndarray | None = None,
    site_alt_m: float = 0.0,
    sources: list[str] | None = None,
) -> dict:
    """Return a dict shaped like the /evaluate response in docs/ARCHITECTURE.md.

    `ephem` is any object with `sky(lat, lon, times, alt_m) -> ephemeris.Sky`.
    `landing_time` (naive UTC, hour precision) wins over `landing_date` (00:00 UTC).
    `period_start`/`period_end` (inclusive UTC dates) set the analysis period for the
    site stats and the sky/power/comms series. Without them the period is the mission
    (lander + landing chosen) or the next lunar day from `search_start`. Mission
    pass/fail checks always use the mission window, whatever the analysis period.
    `skyline` is the terrain horizon (360 elevation angles, 1° steps clockwise from
    north). With it, the Sun/Earth only count as visible above the real terrain;
    without it, above the smooth-sphere horizon. `site_alt_m` is passed to Horizons.
    """
    # The landing moment, if one was chosen.
    landing: datetime | None = landing_time or (
        datetime.combine(landing_date, time()) if landing_date else None
    )

    # Which stretch of time the sky/power/comms series (and site stats) cover.
    if period_start:
        end = period_end or period_start
        series_start, series_days = period_start, (end - period_start).days + 1
        period_kind = "day" if series_days == 1 else "range"
    elif lander and landing:
        series_start, series_days, period_kind = landing, lander["mission_days"], "mission"
    else:
        series_start, series_days, period_kind = search_start, LUNAR_DAY_DAYS, "lunar_day"

    times = ephemeris.time_grid(series_start, series_days, STEP_HOURS)
    sky = ephem.sky(lat, lon, times, alt_m=site_alt_m)
    sun_el, earth_el = sky.sun_el, sky.earth_el
    used_sources = [sky.source]

    # Terrain horizon in the direction of the Sun/Earth at each step.
    sun_sky = skyline_at(skyline, sky.sun_az)
    earth_sky = skyline_at(skyline, sky.earth_az)
    sun_vis = sun_el > sun_sky
    earth_vis = earth_el > earth_sky
    period_hours = len(times) * STEP_HOURS
    sun_h = visible_hours(sun_el - sun_sky)
    earth_h = visible_hours(earth_el - earth_sky)
    sun_h_flat = visible_hours(sun_el)
    earth_h_flat = visible_hours(earth_el)

    if lander:
        area, eff = lander["solar_array_m2"], lander["solar_efficiency"]
    else:
        area, eff = REFERENCE_PANEL_M2, REFERENCE_PANEL_EFF
    power = _power_w(sun_el, area, eff) * sun_vis
    # Sunlight arriving on a flat, upward-facing panel, per m² (before panel efficiency).
    irradiance = np.clip(SOLAR_CONSTANT_W_M2 * np.sin(np.radians(sun_el)), 0, None) * sun_vis

    checks: list[dict] = []
    windows = None
    launch_estimate = None

    if lander:
        site_checks = _site_checks(terrain, lander, payload_kg)
        checks.extend(site_checks)
        if landing:
            if period_kind == "mission":
                m_sun_margin, m_earth_vis = sun_el - sun_sky, earth_vis
            else:   # analysis period differs from the mission: check the mission window itself
                m_times = ephemeris.time_grid(landing, lander["mission_days"], STEP_HOURS)
                m_sky = ephem.sky(lat, lon, m_times, alt_m=site_alt_m)
                m_sun_margin = m_sky.sun_el - skyline_at(skyline, m_sky.sun_az)
                m_earth_vis = m_sky.earth_el > skyline_at(skyline, m_sky.earth_az)
            checks.extend(_date_checks(m_sun_margin, m_sun_margin > 0, m_earth_vis, lander, skyline is not None))
            launch_estimate = landing.date() - timedelta(days=lander["transit_days"])
        else:
            site_ok = all(c["pass"] for c in site_checks)
            # Earliest possible landing is a launch today plus the transit time.
            earliest_landing = search_start + timedelta(days=lander["transit_days"])
            windows = []
            if site_ok:
                windows, window_source = _find_windows(
                    lat, lon, lander, earliest_landing, ephem, skyline, site_alt_m)
                used_sources.append(window_source)
            if windows:
                launch_estimate = windows[0]["start"] - timedelta(days=lander["transit_days"])

    labels = [_iso(t) for t in times]
    pct = lambda h: round(100.0 * h / period_hours, 1)  # noqa: E731
    return {
        "period": {
            "kind": period_kind,                  # day | range | mission | lunar_day
            "start": labels[0],
            "end": _iso(times[-1] + np.timedelta64(int(STEP_HOURS * 3600), "s")),
            "hours": period_hours,
        },
        "site": {
            "slope_deg": terrain.slope_deg if terrain else None,
            "slope_baseline_m": terrain.slope_baseline_m if terrain else None,
            "elevation_m": terrain.elevation_m if terrain else None,
            "temp_range_k": _temp_range(terrain),
            "sunlight_pct": pct(sun_h),
            "earth_visible_pct": pct(earth_h),
            "sunlight_pct_flat": pct(sun_h_flat),          # same, ignoring terrain
            "earth_visible_pct_flat": pct(earth_h_flat),
            "sun_hours": sun_h,                            # hours of the period with the Sun visible
            "earth_hours": earth_h,
            "sun_hours_flat": sun_h_flat,
            "earth_hours_flat": earth_h_flat,
        },
        "sky": [
            {
                "t": t,
                "sun_el": round(float(se), 2), "sun_az": round(float(sa), 1),
                "earth_el": round(float(ee), 2), "earth_az": round(float(ea), 1),
                "sun_visible": bool(sv), "earth_visible": bool(ev),
            }
            for t, se, sa, ee, ea, sv, ev in zip(
                labels, sun_el, sky.sun_az, earth_el, sky.earth_az, sun_vis, earth_vis)
        ],
        "events": {
            "sunrise": _first_crossing(sun_vis, labels, rising=True),
            "sunset": _first_crossing(sun_vis, labels, rising=False),
            "earthrise": _first_crossing(earth_vis, labels, rising=True),
            "earthset": _first_crossing(earth_vis, labels, rising=False),
        },
        "power_w": [
            {"t": t, "w": round(float(w), 1), "w_m2": round(float(i), 1)}
            for t, w, i in zip(labels, power, irradiance)
        ],
        "comms": [{"t": t, "visible": bool(v)} for t, v in zip(labels, earth_vis)],
        "windows": windows,
        "launch_estimate": launch_estimate,
        "checks": checks,
        "pass": all(c["pass"] for c in checks) if checks else None,
        "sources": list(dict.fromkeys(used_sources + (sources or []))),
    }


def visible_hours(margin: np.ndarray) -> float:
    """Hours (to 0.1 h) that `margin` (elevation above the horizon, hourly) is positive.

    Each hourly sample starts a one-hour interval. When the sign changes inside an
    interval, the crossing time is interpolated linearly, so a sunrise at 06:40 counts
    as 0.33 h of that hour instead of 0 or 1.
    """
    m = np.asarray(margin, dtype=float)
    if m.size == 0:
        return 0.0
    m0, m1 = m[:-1], m[1:]
    up0, up1 = m0 > 0, m1 > 0
    with np.errstate(divide="ignore", invalid="ignore"):
        cross = np.where(up0, m0 / (m0 - m1), m1 / (m1 - m0))
    frac = np.where(up0 & up1, 1.0, np.where(~up0 & ~up1, 0.0, cross))
    intervals = float(np.sum(frac)) + (1.0 if m[-1] > 0 else 0.0)   # last sample: its sign
    return round(intervals * STEP_HOURS, 1)


def skyline_at(skyline, azimuth_deg) -> np.ndarray:
    """Terrain horizon elevation (deg) toward each azimuth; 0 when there's no skyline."""
    az = np.asarray(azimuth_deg, dtype=float)
    if skyline is None:
        return np.zeros_like(az)
    k = np.asarray(skyline, dtype=float)
    step = 360.0 / len(k)
    return np.interp(az % 360.0, np.arange(len(k) + 1) * step, np.append(k, k[0]))


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
        baseline = f" (LOLA, over {terrain.slope_baseline_m:.0f} m)" if terrain.slope_baseline_m else ""
        checks.append(_check("slope", ok, f"{slope:.1f}°{baseline} is {word} {name}'s {limit:g}° limit"))

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


def _date_checks(sun_margin: np.ndarray, sun_vis: np.ndarray, earth_vis: np.ndarray,
                 lander: dict, terrain_aware: bool) -> list[dict]:
    """`sun_margin` = Sun elevation minus the horizon toward it (terrain or flat)."""
    horizon = "terrain horizon" if terrain_aware else "horizon"
    sun_pct = _pct(sun_vis)
    touchdown = float(sun_margin[0])
    if touchdown < MIN_TOUCHDOWN_SUN_EL_DEG:
        sun_check = _check(
            "sunlight", False,
            f"Sun is {touchdown:.1f}° above the {horizon} at touchdown, "
            f"needs at least {MIN_TOUCHDOWN_SUN_EL_DEG:g}°",
        )
    else:
        ok = sun_pct >= MIN_SUNLIGHT_PCT
        sun_check = _check(
            "sunlight", ok,
            f"{sun_pct:.0f}% sun over the {lander['mission_days']:g}-day mission "
            f"(needs {MIN_SUNLIGHT_PCT:g}%)" + (", counting terrain shadow" if terrain_aware else ""),
        )

    earth_pct = _pct(earth_vis)
    comms_check = _check(
        "comms", earth_pct >= MIN_EARTH_VISIBLE_PCT,
        f"Earth visible {earth_pct:.0f}% of the mission (needs {MIN_EARTH_VISIBLE_PCT:g}%)"
        + (", counting terrain blocking" if terrain_aware else ""),
    )
    return [sun_check, comms_check]


def _check(name: str, ok: bool, detail: str) -> dict:
    return {"name": name, "pass": bool(ok), "detail": detail}


# ---- Landing windows ----------------------------------------------------------

def _find_windows(lat: float, lon: float, lander: dict, search_start: date, ephem,
                  skyline=None, site_alt_m: float = 0.0) -> tuple[list[dict], str]:
    """Runs of landing hours in the search range that pass the time-dependent checks.

    Every hourly step is a candidate touchdown, so each window's `start_time` is the
    earliest hour a landing works: the suggested landing time.
    """
    mission_steps = int(round(lander["mission_days"] * 24 / STEP_HOURS))
    steps_per_day = int(round(24 / STEP_HOURS))
    times = ephemeris.time_grid(search_start, WINDOW_SEARCH_DAYS + lander["mission_days"], STEP_HOURS)
    sky = ephem.sky(lat, lon, times, alt_m=site_alt_m)
    sun_margin = sky.sun_el - skyline_at(skyline, sky.sun_az)
    earth_margin = sky.earth_el - skyline_at(skyline, sky.earth_az)
    starts = np.arange(WINDOW_SEARCH_DAYS * steps_per_day)

    # Percent of each mission-length slice with the body visible, via cumulative sums.
    def slice_pct(mask: np.ndarray) -> np.ndarray:
        c = np.concatenate([[0], np.cumsum(mask)])
        return 100.0 * (c[starts + mission_steps] - c[starts]) / mission_steps

    ok = (
        (sun_margin[starts] >= MIN_TOUCHDOWN_SUN_EL_DEG)
        & (slice_pct(sun_margin > 0) >= MIN_SUNLIGHT_PCT)
        & (slice_pct(earth_margin > 0) >= MIN_EARTH_VISIBLE_PCT)
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
    # Flat panel. The caller zeroes it while terrain blocks the Sun.
    return np.clip(SOLAR_CONSTANT_W_M2 * np.sin(np.radians(sun_el_deg)) * area_m2 * eff, 0, None)


def _first_crossing(visible: np.ndarray, labels: list[str], rising: bool) -> str | None:
    """Time of the first rise or set (visibility change) in the series, or None."""
    up = np.asarray(visible, dtype=bool)
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
