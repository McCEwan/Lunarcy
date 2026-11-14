"""Sun and Earth positions (azimuth and elevation) seen from a point on the Moon.

Two providers share one interface, `provider.sky(lat, lon, times) -> Sky`:

- HorizonsEphemeris (default): asks NASA/JPL Horizons for the apparent azimuth
  and elevation of the Sun (10) and Earth (399) from a lunar surface site
  (CENTER='coord@301'). Results are cached on disk, so each site/time range is
  only fetched once. If Horizons can't be reached, it falls back to the analytic
  model and says so in `Sky.source`.
- AnalyticEphemeris: a rough offline approximation (circular orbits, sinusoidal
  libration). It is good enough for tests and offline demos, but it can be off by
  several degrees (more than 10° for Earth), so it is labelled as approximate.

Horizons API docs: https://ssd-api.jpl.nasa.gov/doc/horizons.html
"""

from __future__ import annotations

import hashlib
import json
import logging
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path

import numpy as np

log = logging.getLogger(__name__)

HORIZONS_URL = "https://ssd.jpl.nasa.gov/api/horizons.api"
HORIZONS_SOURCE = "NASA/JPL Horizons System (Sun and Earth apparent az/el from the lunar surface)"
ANALYTIC_SOURCE = "APPROXIMATE ephemeris: offline analytic model (Horizons not used)"
FALLBACK_SOURCE = "APPROXIMATE ephemeris: Horizons was unreachable, so an offline analytic model was used"

SUN, EARTH = "10", "399"


@dataclass(frozen=True)
class Sky:
    sun_el: np.ndarray
    sun_az: np.ndarray
    earth_el: np.ndarray
    earth_az: np.ndarray
    source: str


def time_grid(start: date | datetime, days: float, step_hours: float = 1.0) -> np.ndarray:
    """Evenly spaced UTC timestamps (numpy datetime64[s]) starting at `start`."""
    n = int(round(days * 24 / step_hours))
    step = np.timedelta64(int(step_hours * 3600), "s")
    return np.datetime64(start, "s") + np.arange(n) * step


# ---- Horizons ------------------------------------------------------------------

class HorizonsEphemeris:
    def __init__(self, cache_dir: Path | None = None, timeout_s: float = 30.0, fallback=None):
        self.cache_dir = cache_dir
        self.timeout_s = timeout_s
        self.fallback = fallback or AnalyticEphemeris()
        self._memory: dict[str, dict] = {}
        if cache_dir:
            cache_dir.mkdir(parents=True, exist_ok=True)

    def sky(self, lat: float, lon: float, times: np.ndarray) -> Sky:
        lat, lon = round(float(lat), 3), round(float(lon), 3)
        try:
            data = self._cached_or_fetch(lat, lon, times)
        except Exception as exc:  # network down, Horizons error, bad parse...
            log.warning("Horizons failed (%s); using analytic fallback", exc)
            s = self.fallback.sky(lat, lon, times)
            return Sky(s.sun_el, s.sun_az, s.earth_el, s.earth_az, FALLBACK_SOURCE)
        return Sky(
            np.asarray(data["sun_el"]), np.asarray(data["sun_az"]),
            np.asarray(data["earth_el"]), np.asarray(data["earth_az"]),
            HORIZONS_SOURCE,
        )

    def _cached_or_fetch(self, lat: float, lon: float, times: np.ndarray) -> dict:
        start, step_min, n = _grid_params(times)
        key = hashlib.sha1(f"{lat},{lon},{start},{step_min},{n}".encode()).hexdigest()[:16]
        if key in self._memory:
            return self._memory[key]
        path = self.cache_dir / f"{key}.json" if self.cache_dir else None
        if path and path.exists():
            data = json.loads(path.read_text())
        else:
            with ThreadPoolExecutor(max_workers=2) as pool:
                sun_f = pool.submit(self._fetch, SUN, lat, lon, start, step_min, n)
                earth_f = pool.submit(self._fetch, EARTH, lat, lon, start, step_min, n)
                (sun_az, sun_el), (earth_az, earth_el) = sun_f.result(), earth_f.result()
            data = {"sun_el": sun_el, "sun_az": sun_az, "earth_el": earth_el, "earth_az": earth_az}
            if path:
                path.write_text(json.dumps(data))
        self._memory[key] = data
        return data

    def _fetch(self, body: str, lat: float, lon: float, start: np.datetime64, step_min: int, n: int):
        stop = start + np.timedelta64(step_min * (n - 1), "m")
        params = horizons_params(body, lat, lon, start, stop, step_min)
        url = HORIZONS_URL + "?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers={"User-Agent": "lunar-planner-hackathon"})
        with urllib.request.urlopen(req, timeout=self.timeout_s) as resp:
            payload = json.load(resp)
        if "error" in payload:
            raise RuntimeError(payload["error"])
        az, el = parse_horizons_azel(payload["result"])
        if len(el) != n:
            raise RuntimeError(f"Horizons returned {len(el)} rows, expected {n}")
        return [round(x, 3) for x in az], [round(x, 3) for x in el]


def horizons_params(body: str, lat: float, lon: float, start, stop, step_min: int, fmt: str = "json") -> dict:
    """Query parameters for a Horizons observer table of apparent az/el from the Moon."""
    return {
        "format": fmt,
        "COMMAND": f"'{body}'",
        "OBJ_DATA": "'NO'",
        "MAKE_EPHEM": "'YES'",
        "EPHEM_TYPE": "'OBSERVER'",
        "CENTER": "'coord@301'",           # 301 = the Moon
        "COORD_TYPE": "'GEODETIC'",
        "SITE_COORD": f"'{lon},{lat},0'",   # east longitude, latitude, altitude (km)
        "START_TIME": f"'{_fmt_time(start)}'",
        "STOP_TIME": f"'{_fmt_time(stop)}'",
        "STEP_SIZE": f"'{step_min}m'",
        "QUANTITIES": "'4'",                 # apparent azimuth and elevation
        "ANG_FORMAT": "'DEG'",
        "CSV_FORMAT": "'YES'",
    }


def parse_horizons_azel(result: str) -> tuple[list[float], list[float]]:
    """Pull (azimuth, elevation) columns out of a Horizons CSV observer table."""
    body = result[result.index("$$SOE") + 5 : result.index("$$EOE")]
    az, el = [], []
    for line in body.strip().splitlines():
        fields = [f.strip() for f in line.split(",")]
        numbers = [float(f) for f in fields[1:] if _is_number(f)]
        az.append(numbers[-2])
        el.append(numbers[-1])
    return az, el


def _is_number(s: str) -> bool:
    try:
        float(s)
        return True
    except ValueError:
        return False


def _grid_params(times: np.ndarray) -> tuple[np.datetime64, int, int]:
    times = times.astype("datetime64[m]")
    step_min = int((times[1] - times[0]) / np.timedelta64(1, "m")) if len(times) > 1 else 60
    return times[0], step_min, len(times)


def _fmt_time(t) -> str:
    return str(np.datetime64(t, "m")).replace("T", " ")


# ---- Analytic approximation (offline fallback) ------------------------------------

SYNODIC_DAYS = 29.530589      # new moon to new moon
ANOMALISTIC_DAYS = 27.554550  # drives libration in longitude
DRACONIC_DAYS = 27.212221     # drives libration in latitude
ECLIPSE_YEAR_DAYS = 346.62    # drives the Sun's selenographic latitude
NEW_MOON_EPOCH = np.datetime64("2000-01-06T18:14:00", "s")
J2000 = np.datetime64("2000-01-01T12:00:00", "s")


class AnalyticEphemeris:
    def sky(self, lat: float, lon: float, times: np.ndarray) -> Sky:
        d_sun = (times - NEW_MOON_EPOCH) / np.timedelta64(1, "D")
        phase = (d_sun / SYNODIC_DAYS) % 1.0
        # New moon: Sun over the far side (180°). Full moon: over the near side (0°).
        sub_sun_lon = 180.0 - 360.0 * phase
        sub_sun_lat = 1.54 * np.sin(2 * np.pi * d_sun / ECLIPSE_YEAR_DAYS)

        d = (times - J2000) / np.timedelta64(1, "D")
        sub_earth_lon = 7.9 * np.sin(2 * np.pi * d / ANOMALISTIC_DAYS)
        sub_earth_lat = 6.7 * np.sin(2 * np.pi * d / DRACONIC_DAYS)

        sun_az, sun_el = _azel(lat, lon, sub_sun_lat, sub_sun_lon)
        earth_az, earth_el = _azel(lat, lon, sub_earth_lat, sub_earth_lon)
        return Sky(sun_el, sun_az, earth_el, earth_az, ANALYTIC_SOURCE)


def _unit(lat_deg, lon_deg) -> np.ndarray:
    lat, lon = np.radians(lat_deg), np.radians(lon_deg)
    return np.stack([np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)], axis=-1)


def _azel(lat: float, lon: float, body_lat, body_lon) -> tuple[np.ndarray, np.ndarray]:
    """Azimuth (from north, through east) and elevation of a very distant body."""
    up = _unit(lat, lon)
    la, lo = np.radians(lat), np.radians(lon)
    east = np.array([-np.sin(lo), np.cos(lo), 0.0])
    north = np.array([-np.sin(la) * np.cos(lo), -np.sin(la) * np.sin(lo), np.cos(la)])
    b = _unit(body_lat, body_lon)
    el = np.degrees(np.arcsin(np.clip(b @ up, -1.0, 1.0)))
    az = np.degrees(np.arctan2(b @ east, b @ north)) % 360.0
    return az, el
