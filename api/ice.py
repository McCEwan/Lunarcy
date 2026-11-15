"""Where water ice could survive: the "Check for ice in deep craters" mission goal.

Water ice is stable at the lunar surface for billions of years where the yearly maximum
temperature stays below about 110 K (Paige et al. 2010, Science 330, 479). On the Moon
that means permanently shadowed crater floors near the poles: the Sun never clears the
crater rim. Three real data sets answer "is this crater deep enough?":

1. Permanent shadow (LOLA terrain). The Sun's declination relative to the lunar equator
   never exceeds the 1.54° tilt of the equator to the ecliptic. So at a given latitude the
   highest the Sun can ever reach at each azimuth is fixed geometry (`max_sun_elevation`).
   A point is permanently shadowed if its terrain skyline is above the Sun's top limb at
   every azimuth. The grid uses the precomputed finder skylines (scripts/build_skylines.py);
   each named crater gets its own 1° skyline from its deepest floor point.
2. Cold traps (Diviner). The measured multi-year maximum temperature per 0.5° cell
   (scripts/fetch_diviner.py). ≤110 K = surface ice stable.
3. Named craters (USGS Gazetteer, api/data/polar_craters.json), with depth from LOLA
   (rim median minus floor minimum) and published ice evidence for a few (each cited).

Ratings: "known" = published ice evidence; "likely" = floor permanently shadowed and a cell
inside the crater ≤110 K; "possible" = only one of the two; "unlikely" = neither.

Limits: 0.5° cells (~15 km) and the ~237 m LOLA grid miss small cold traps (many are under
1 km), and the Diviner maxima are averages over each cell. Ice can also be buried, which
none of this sees.
"""

from __future__ import annotations

import json
import logging
import math
import time
from pathlib import Path

import numpy as np

from .finder import MOON_R_KM, RES_DEG, Skylines, compute_skylines, grid, unit
from .lola import destination

log = logging.getLogger(__name__)

OBLIQUITY_DEG = 1.54          # lunar equator vs ecliptic: the Sun's declination range
SUN_RADIUS_DEG = 0.27         # the Sun's disc must be fully below the rim
ICE_STABLE_K = 110.0          # Paige et al. 2010
POLAR_LAT = 70.0              # cold traps only exist poleward of this
RATINGS = ("known", "likely", "possible", "unlikely")
CRATERS_PATH = Path(__file__).resolve().parent / "data" / "polar_craters.json"


def max_sun_elevation(lat_deg: float, naz: int, dec_steps: int = 9, hour_step: float = 0.25) -> np.ndarray:
    """The highest the Sun's centre ever gets at each azimuth bin (0 = north, clockwise),
    over every season and lunar precession phase. -inf where the Sun never goes."""
    phi = math.radians(lat_deg)
    dec = np.radians(np.linspace(-OBLIQUITY_DEG, OBLIQUITY_DEG, dec_steps))[:, None]
    h = np.radians(np.arange(0.0, 360.0, hour_step))[None, :]
    sin_el = math.sin(phi) * np.sin(dec) + math.cos(phi) * np.cos(dec) * np.cos(h)
    az = np.degrees(np.arctan2(-np.sin(h) * np.cos(dec),
                               np.sin(dec) * math.cos(phi) - np.cos(dec) * math.sin(phi) * np.cos(h))) % 360.0
    el = np.degrees(np.arcsin(np.clip(sin_el, -1, 1)))
    out = np.full(naz, -np.inf)
    idx = np.rint(az / (360.0 / naz)).astype(int) % naz
    np.maximum.at(out, idx.ravel(), el.ravel())
    return out


def shadow_margin(sky: np.ndarray, lat_deg: float) -> float:
    """Degrees by which the skyline clears the Sun's top limb at its worst azimuth.
    > 0 = permanently shadowed."""
    sun = max_sun_elevation(lat_deg, sky.shape[-1])
    reach = np.isfinite(sun)
    return float(np.min(sky[reach] - (sun[reach] + SUN_RADIUS_DEG)))


def great_circle_km(lat1, lon1, lat2, lon2):
    a = unit(np.asarray(lat1, float), np.asarray(lon1, float))
    b = unit(np.asarray(lat2, float), np.asarray(lon2, float))
    return MOON_R_KM * np.arccos(np.clip(np.sum(a * b, axis=-1), -1.0, 1.0))


class IceMap:
    """Cold-trap grid + rated named craters. Built once (a few seconds) and reused."""

    def __init__(self, heights, skylines: Skylines | None, terrain, res: float = RES_DEG,
                 craters_path: Path = CRATERS_PATH):
        t0 = time.time()
        self.res = res
        lats, lons = grid(res)
        self.LA, self.LO = np.meshgrid(lats, lons, indexing="ij")
        polar = np.abs(self.LA) >= POLAR_LAT

        # Diviner: measured maximum temperature per cell (if it matches this grid)
        tmax = None
        if terrain is not None and terrain.real and terrain.temps["tmax_k"].shape == self.LA.shape:
            tmax = terrain.temps["tmax_k"]
        self.tmax = tmax
        self.cold = (tmax <= ICE_STABLE_K) & polar if tmax is not None else np.zeros_like(polar)

        # LOLA: permanent shadow at each polar cell from the precomputed skylines
        self.psr = np.zeros_like(polar)
        self.has_shadow_grid = bool(skylines and skylines.loaded and skylines.res == res)
        if self.has_shadow_grid:
            naz = skylines.sky.shape[1]
            for r in np.flatnonzero(polar.any(axis=1)):
                sun = max_sun_elevation(float(lats[r]), naz)
                reach = np.isfinite(sun)
                idx = skylines.index[r]
                ok = idx >= 0
                sky = skylines.sky[idx[ok]][:, reach]
                self.psr[r, ok] = np.all(sky > sun[reach] + SUN_RADIUS_DEG, axis=1)

        # 2 = likely (shadowed and cold), 1 = possible (one of the two), 0 = no
        self.classes = np.where(self.psr & self.cold, 2, np.where(self.psr | self.cold, 1, 0)).astype(np.uint8)

        meta = json.loads(craters_path.read_text(encoding="utf-8"))
        self.crater_source = meta["source"]
        self.craters = [self._rate(c, heights) for c in meta["craters"]]
        self.heights_source = getattr(heights, "source", "")
        self.temp_source = terrain.source if tmax is not None else None
        self.skyline_source = skylines.source if self.has_shadow_grid else None

        # Targets for "distance to ice": likely cells + floors of known/likely craters
        tl, to = self.LA[self.classes == 2], self.LO[self.classes == 2]
        good = [c for c in self.craters if c["rating"] in ("known", "likely")]
        self.target_lat = np.concatenate([tl, [c["floor_lat"] for c in good]])
        self.target_lon = np.concatenate([to, [c["floor_lon"] for c in good]])
        self.seconds = round(time.time() - t0, 1)
        log.info("Ice map: %d likely + %d possible cells, %d craters rated (%s known, %s likely) in %.1f s",
                 int((self.classes == 2).sum()), int((self.classes == 1).sum()), len(self.craters),
                 sum(c["rating"] == "known" for c in self.craters),
                 sum(c["rating"] == "likely" for c in self.craters), self.seconds)

    # ---- craters -----------------------------------------------------------------------

    def _rate(self, c: dict, heights) -> dict:
        R = c["diameter_km"] * 500.0                                   # radius, m
        brg = np.arange(0.0, 360.0, 5.0)
        frac = np.linspace(0.0, 1.4, 29)
        B, F = np.meshgrid(brg, frac, indexing="ij")                    # (72, 29)
        plat, plon = destination(np.full(B.shape, c["lat"]), np.full(B.shape, c["lon"]), B, F * R)
        h = heights.heights(plat, plon)
        inner = F <= 0.6
        k = np.argmin(np.where(inner, h, np.inf))
        floor_h = float(h.ravel()[k])
        floor_lat, floor_lon = float(plat.ravel()[k]), float(plon.ravel()[k])
        rim = np.where((F >= 0.7) & (F <= 1.3), h, -np.inf).max(axis=1)
        depth = float(np.median(rim) - floor_h)

        sky = compute_skylines(heights, np.array([floor_lat]), np.array([floor_lon]),
                               az_step=1.0, samples=200)[0]
        margin = shadow_margin(sky, floor_lat)
        shadowed = margin > 0

        coldest = None
        if self.tmax is not None:
            inside = great_circle_km(self.LA, self.LO, c["lat"], c["lon"]) <= R / 1000.0
            r0 = min(int((c["lat"] + 90.0) // self.res), inside.shape[0] - 1)
            c0 = int((c["lon"] + 180.0) // self.res) % inside.shape[1]
            inside[r0, c0] = True                                        # always the cell it sits in
            vals = self.tmax[inside]
            vals = vals[np.isfinite(vals)]
            if vals.size:
                coldest = round(float(vals.min()), 1)
        cold = coldest is not None and coldest <= ICE_STABLE_K

        if c.get("evidence"):
            rating = "known"
        elif shadowed and cold:
            rating = "likely"
        elif shadowed or cold:
            rating = "possible"
        else:
            rating = "unlikely"
        return {**c, "floor_lat": round(floor_lat, 3), "floor_lon": round(floor_lon, 3),
                "depth_m": round(depth), "depth_to_diameter": round(depth / (2 * R), 3),
                "floor_shadowed": bool(shadowed), "shadow_margin_deg": round(margin, 2),
                "coldest_tmax_k": coldest, "rating": rating}

    # ---- distances (finder) ------------------------------------------------------------

    def distance_km(self, lat, lon, chunk: int = 20000) -> np.ndarray:
        """Distance from each point to the nearest ice target (inf if there are none)."""
        lat, lon = np.ravel(lat), np.ravel(lon)
        out = np.full(lat.shape, np.inf, np.float32)
        if not self.target_lat.size:
            return out
        T = unit(self.target_lat, self.target_lon).astype(np.float32)
        for i in range(0, lat.size, chunk):
            P = unit(lat[i:i + chunk], lon[i:i + chunk]).astype(np.float32)
            best = np.max(P @ T.T, axis=1)
            out[i:i + chunk] = MOON_R_KM * np.arccos(np.clip(best, -1.0, 1.0))
        return out

    def nearest_target(self, lat: float, lon: float) -> dict | None:
        """The nearest ice target (likely cell or known/likely crater floor), described."""
        if not self.target_lat.size:
            return None
        d = great_circle_km(lat, lon, self.target_lat, self.target_lon)
        i = int(np.argmin(d))
        tlat, tlon = float(self.target_lat[i]), float(self.target_lon[i])
        # The crater this target lies in: its floor point, or a known/likely crater within its rim.
        good = [c for c in self.craters if c["rating"] in ("known", "likely")]
        crater = next((c for c in good if abs(c["floor_lat"] - tlat) < 1e-6 and abs(c["floor_lon"] - tlon) < 1e-6), None)
        if crater is None:
            inside = [c for c in good
                      if float(great_circle_km(tlat, tlon, c["lat"], c["lon"])) <= c["diameter_km"] / 2]
            crater = min(inside, key=lambda c: c["diameter_km"], default=None)
        if crater and crater.get("evidence"):
            basis = f"Published ice evidence in {crater['name']}: {crater['evidence']['summary']} ({crater['evidence']['citation']})"
        elif crater:
            basis = (f"{crater['name']} floor: permanently shadowed (LOLA) and ≤{ICE_STABLE_K - 273.15:.0f} °C (Diviner); "
                     "ice could survive here, not a detection")
        else:
            basis = (f"Cold-trap cell: permanently shadowed (LOLA) and ≤{ICE_STABLE_K - 273.15:.0f} °C (Diviner); "
                     "ice could survive here, not a detection")
        return {"lat": round(tlat, 4), "lon": round(tlon, 4), "distance_km": round(float(d[i]), 2),
                "name": crater["name"] if crater else None,
                "rating": crater["rating"] if crater else "likely", "basis": basis}

    def nearest_crater(self, lat: float, lon: float) -> dict | None:
        good = [c for c in self.craters if c["rating"] in ("known", "likely")]
        if not good:
            return None
        d = great_circle_km(lat, lon, [c["floor_lat"] for c in good], [c["floor_lon"] for c in good])
        i = int(np.argmin(d))
        return {"name": good[i]["name"], "rating": good[i]["rating"], "distance_km": round(float(d[i]), 1)}

    # ---- API ---------------------------------------------------------------------------

    def sources(self) -> list[str]:
        out = [self.crater_source, f"Crater depth and floor shadow from {self.heights_source}"]
        if self.temp_source:
            out.append(f"Cold traps (max ≤{ICE_STABLE_K - 273.15:.0f} °C) from {self.temp_source}")
        if self.skyline_source:
            out.append(f"Permanent shadow from {self.skyline_source}")
        cites = sorted({c["evidence"]["citation"] for c in self.craters if c.get("evidence")})
        if cites:
            out.append("Published ice evidence: " + "; ".join(cites))
        return out

    def to_dict(self) -> dict:
        import base64
        return {
            "grid": {"res_deg": self.res, "nlat": int(self.LA.shape[0]), "nlon": int(self.LA.shape[1]),
                     "lat0": float(self.LA[0, 0]), "lon0": float(self.LO[0, 0]),
                     "classes_b64": base64.b64encode(self.classes.tobytes()).decode()},
            "counts": {"likely_cells": int((self.classes == 2).sum()),
                       "possible_cells": int((self.classes == 1).sum()),
                       **{f"{r}_craters": sum(c["rating"] == r for c in self.craters) for r in RATINGS}},
            "has_shadow_grid": self.has_shadow_grid,
            "has_temperature": self.tmax is not None,
            "ice_stable_k": ICE_STABLE_K,
            "craters": self.craters,
            "sources": self.sources(),
        }
