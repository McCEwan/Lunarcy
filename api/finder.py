"""Landing-site finder: search the whole Moon for regions that meet mission requirements.

Two stages (see docs/ARCHITECTURE.md, "Site finder"):

1. Global screen. One Horizons query gives the sub-solar and sub-Earth points (and
   Earth's distance) through the period. From those, the Sun's and Earth's elevation
   over *every* cell of a 0.5° grid (~260,000 cells) follows from vector maths:
       sin(el_sun)   = n · s                         (s: unit vector to the sub-solar point)
       sin(el_earth) = (n · E - R) / |E - R n|        (E: Earth position, km; parallax included)
   Where precomputed terrain skylines exist (scripts/build_skylines.py), the Sun/Earth
   only count when above the skyline at their azimuth; elsewhere the smooth horizon.
   Slope comes from the LOLA global grid.

2. Regions + terrain check. Passing cells are grouped into connected regions. The best
   cell of each top region gets a full LOLA skyline (if it didn't have one) and is
   re-scored, so regions that only pass on a smooth Moon are caught.
"""

from __future__ import annotations

import base64
import logging
import math
import time
from collections import deque
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path

import numpy as np

from . import ephemeris
from .lola import destination

log = logging.getLogger(__name__)

MOON_R_KM = 1737.4
MOON_R_M = MOON_R_KM * 1000
SOLAR_CONSTANT = 1361.0
RES_DEG = 0.5
MAX_SAMPLES = 1000           # time samples per search (step grows for long periods)
SKY_AZ_STEP = 4.0            # precomputed skyline azimuth step (degrees)
NEAR_FRACTION = 0.85         # "nearly meets": every criterion within 85% of its threshold
TOP_REGIONS = 25
REGIONS = {
    "all": "Whole Moon",
    "south": "South polar region (below 60°S)",
    "north": "North polar region (above 60°N)",
    "nearside": "Near side (facing Earth)",
    "farside": "Far side",
}


@dataclass
class Criteria:
    period_start: date
    period_end: date
    min_sun_pct: float = 0.0
    min_earth_pct: float = 0.0
    min_avg_w_m2: float = 0.0
    max_slope_deg: float = 90.0
    region: str = "all"
    goal: str | None = None          # "ice_craters": also require an ice candidate nearby (api/ice.py)
    max_ice_km: float = 50.0


GOALS = {"ice_craters": "Check for ice in deep craters"}


# ---- Grid -------------------------------------------------------------------------------

def grid(res: float = RES_DEG):
    """Cell centres: row 0 = southernmost, column 0 = westernmost (-180)."""
    lats = np.arange(-90 + res / 2, 90, res)
    lons = np.arange(-180 + res / 2, 180, res)
    return lats, lons


def unit(lat_deg, lon_deg) -> np.ndarray:
    la, lo = np.radians(lat_deg), np.radians(lon_deg)
    return np.stack([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)], axis=-1)


def east_north(lat_deg, lon_deg):
    la, lo = np.radians(lat_deg), np.radians(lon_deg)
    east = np.stack([-np.sin(lo), np.cos(lo), np.zeros_like(lo)], axis=-1)
    north = np.stack([-np.sin(la) * np.cos(lo), -np.sin(la) * np.sin(lo), np.cos(la)], axis=-1)
    return east, north


def region_mask(lat2d, lon2d, region: str) -> np.ndarray:
    if region == "south":
        return lat2d <= -60
    if region == "north":
        return lat2d >= 60
    if region == "nearside":
        return np.abs(lon2d) <= 90
    if region == "farside":
        return np.abs(lon2d) > 90
    return np.ones_like(lat2d, dtype=bool)


# ---- Terrain: slope grid and skylines ---------------------------------------------------

_slope_cache: dict[tuple, np.ndarray] = {}


def slope_grid(heights, res: float = RES_DEG) -> np.ndarray:
    """Slope (deg) at every cell centre, across one source pixel each way (same method as
    the site panel). Cached per height source."""
    key = (id(heights), res)
    if key not in _slope_cache:
        lats, lons = grid(res)
        LA, LO = np.meshgrid(lats, lons, indexing="ij")
        b = max(float(getattr(heights, "resolution_m", 500.0)), 20.0)
        out = np.empty(LA.shape, dtype=np.float32)
        for r in range(0, LA.shape[0], 30):                      # in bands to bound memory
            la, lo = LA[r:r + 30], LO[r:r + 30]
            h = [heights.heights(*destination(la, lo, np.full(la.shape, brg), np.full(la.shape, b)))
                 for brg in (90.0, 270.0, 0.0, 180.0)]
            dzdx, dzdy = (h[0] - h[1]) / (2 * b), (h[2] - h[3]) / (2 * b)
            out[r:r + 30] = np.degrees(np.arctan(np.hypot(dzdx, dzdy)))
        _slope_cache[key] = out
    return _slope_cache[key]


def compute_skylines(heights, lats, lons, az_step: float = SKY_AZ_STEP, samples: int = 120,
                     radius_m: float = 150_000.0, observer_m: float = 2.0, r0_m: float = 60.0) -> np.ndarray:
    """Terrain horizon elevation (deg) for many sites at once: shape (N, 360/az_step).
    With az_step=1, samples=300, r0_m=30 it matches api/patch.horizon_profile (the /evaluate skyline)."""
    lats, lons = np.atleast_1d(lats), np.atleast_1d(lons)
    az = np.arange(0.0, 360.0, az_step)
    r = np.geomspace(r0_m, radius_m, samples)
    drop = r ** 2 / (2 * MOON_R_M)
    out = np.empty((len(lats), len(az)), dtype=np.float32)
    batch = max(1, 400_000 // (len(az) * samples))
    for i in range(0, len(lats), batch):
        la, lo = lats[i:i + batch], lons[i:i + batch]
        A, R = np.meshgrid(az, r, indexing="ij")                   # (naz, ns)
        LA = np.broadcast_to(la[:, None, None], (len(la),) + A.shape)
        LO = np.broadcast_to(lo[:, None, None], (len(la),) + A.shape)
        plat, plon = destination(LA, LO, np.broadcast_to(A, LA.shape), np.broadcast_to(R, LA.shape))
        h = heights.heights(plat, plon)
        h0 = heights.heights(la, lo) + observer_m
        elev = np.degrees(np.arctan2(h - h0[:, None, None] - drop, R))
        out[i:i + batch] = np.nanmax(elev, axis=2)
    return out


class Skylines:
    """Precomputed terrain skylines for grid cells (scripts/build_skylines.py)."""

    def __init__(self, path: Path | None):
        self.rows = None
        if path and path.exists():
            z = np.load(path)
            self.res = float(z["res"])
            self.index = z["index"]            # (nlat, nlon) int32: row into `sky`, -1 = none
            self.sky = z["sky"].astype(np.float32)
            self.az_step = float(z["az_step"])
            self.source = str(z["source"])
            self.rows = int((self.index >= 0).sum())

    @property
    def loaded(self) -> bool:
        return self.rows is not None


# ---- Stage 1: global screen ---------------------------------------------------------------

def sky_vectors(sub: dict):
    s = unit(np.asarray(sub["sun_lat"]), np.asarray(sub["sun_lon"]))                   # (T,3)
    e = unit(np.asarray(sub["earth_lat"]), np.asarray(sub["earth_lon"]))
    E = e * np.asarray(sub["earth_km"])[:, None]                                       # km
    return s.astype(np.float32), E.astype(np.float32)


def screen_cells(lat, lon, s, E, sky=None, az_step=SKY_AZ_STEP):
    """Sunlight %, Earth-visible % and mean flat-panel sunlight (W/m²) for cells (vectors)."""
    n = unit(lat, lon).astype(np.float32)                                            # (C,3)
    sin_sun = n @ s.T                                                                # (C,T)
    dotE = n @ E.T
    D2 = np.sum(E * E, axis=1)[None, :]
    sin_earth = (dotE - MOON_R_KM) / np.sqrt(D2 - 2 * MOON_R_KM * dotE + MOON_R_KM ** 2)
    if sky is not None:
        east, north = east_north(lat, lon)
        east, north = east.astype(np.float32), north.astype(np.float32)
        naz = sky.shape[1]
        sin_sky = np.sin(np.radians(sky)).astype(np.float32)
        lo, hi = sin_sky.min(axis=1), sin_sky.max(axis=1)

        def above(sin_el, vec):
            # Above the highest skyline point: visible. Below the lowest: not. Only the
            # samples in between need the body's azimuth (the expensive part).
            vis = sin_el > hi[:, None]
            ci, ti = np.nonzero((sin_el > lo[:, None]) & ~vis)
            if ci.size:
                e = np.einsum("ij,ij->i", east[ci], vec[ti])
                n = np.einsum("ij,ij->i", north[ci], vec[ti])
                idx = np.rint((np.degrees(np.arctan2(e, n)) % 360) / az_step).astype(int) % naz
                vis[ci, ti] = sin_el[ci, ti] > sin_sky[ci, idx]
            return vis
        sun_vis = above(sin_sun, s)
        earth_vis = above(sin_earth, E)
    else:
        sun_vis = sin_sun > 0
        earth_vis = sin_earth > 0
    irr = SOLAR_CONSTANT * np.clip(sin_sun, 0, None) * sun_vis
    return (100.0 * sun_vis.mean(axis=1), 100.0 * earth_vis.mean(axis=1), irr.mean(axis=1))


def screen_grid(sub: dict, skylines: Skylines | None, res: float = RES_DEG, chunk: int = 3000):
    lats, lons = grid(res)
    LA, LO = np.meshgrid(lats, lons, indexing="ij")
    s, E = sky_vectors(sub)
    sun = np.zeros(LA.shape, np.float32)
    earth = np.zeros(LA.shape, np.float32)
    watts = np.zeros(LA.shape, np.float32)
    terrain = np.zeros(LA.shape, bool)
    flat_lat, flat_lon = LA.ravel(), LO.ravel()
    idx_all = (skylines.index.ravel() if skylines and skylines.loaded and skylines.res == res
               else np.full(flat_lat.shape, -1))
    for with_sky in (True, False):
        cells = np.flatnonzero(idx_all >= 0) if with_sky else np.flatnonzero(idx_all < 0)
        for i in range(0, len(cells), chunk):
            c = cells[i:i + chunk]
            sky = skylines.sky[idx_all[c]] if with_sky else None
            a, b, w = screen_cells(flat_lat[c], flat_lon[c], s, E, sky,
                                   skylines.az_step if with_sky else SKY_AZ_STEP)
            sun.ravel()[c], earth.ravel()[c], watts.ravel()[c] = a, b, w
            terrain.ravel()[c] = with_sky
    return LA, LO, sun, earth, watts, terrain


# ---- Stage 2: regions + terrain check ------------------------------------------------------

def label_regions(mask: np.ndarray) -> tuple[np.ndarray, int]:
    """Connected components (4-neighbour, longitude wraps). -1 = not in a region."""
    nlat, nlon = mask.shape
    labels = np.full(mask.shape, -1, np.int32)
    n = 0
    for start in zip(*np.nonzero(mask)):
        if labels[start] >= 0:
            continue
        q = deque([start])
        labels[start] = n
        while q:
            r, c = q.popleft()
            for rr, cc in ((r + 1, c), (r - 1, c), (r, (c + 1) % nlon), (r, (c - 1) % nlon)):
                if 0 <= rr < nlat and mask[rr, cc] and labels[rr, cc] < 0:
                    labels[rr, cc] = n
                    q.append((rr, cc))
        n += 1
    return labels, n


def score(sun, earth, watts, slope, c: Criteria, ice_km=None):
    """The weakest margin above the requirements (0 = just meets them, 1 = ideal)."""
    m_sun = (sun - c.min_sun_pct) / max(100 - c.min_sun_pct, 1)
    m_earth = (earth - c.min_earth_pct) / max(100 - c.min_earth_pct, 1)
    m_w = (watts - c.min_avg_w_m2) / max(c.min_avg_w_m2, 50.0)
    m_slope = (c.max_slope_deg - slope) / max(c.max_slope_deg, 1)
    out = np.minimum(np.minimum(m_sun, m_earth), np.minimum(np.minimum(m_w, 1.0), m_slope))
    if ice_km is not None:
        out = np.minimum(out, (c.max_ice_km - ice_km) / max(c.max_ice_km, 1))
    return out


def find_regions(crit: Criteria, ephem, heights, skylines: Skylines | None, res: float = RES_DEG,
                 ice=None) -> dict:
    """`ice` is an api.ice.IceMap, needed when crit.goal == "ice_craters"."""
    t0 = time.time()
    days = (crit.period_end - crit.period_start).days + 1
    hours = days * 24
    step_h = max(1, math.ceil(hours / MAX_SAMPLES))
    times = ephemeris.time_grid(crit.period_start, days, step_h)
    sub = ephem.subpoint_series(times)

    LA, LO, sun, earth, watts, terrain = screen_grid(sub, skylines, res)
    slope = slope_grid(heights, res)
    inside = region_mask(LA, LO, crit.region)

    # Suitable = every landing requirement. With the ice goal, suitable cells within
    # max_ice_km of an ice candidate are the best class ("ice"); the rest stay "suitable".
    meets = ((sun >= crit.min_sun_pct) & (earth >= crit.min_earth_pct)
             & (watts >= crit.min_avg_w_m2) & (slope <= crit.max_slope_deg) & inside)
    near = (~meets & inside
            & (sun >= NEAR_FRACTION * crit.min_sun_pct) & (earth >= NEAR_FRACTION * crit.min_earth_pct)
            & (watts >= NEAR_FRACTION * crit.min_avg_w_m2) & (slope <= crit.max_slope_deg / NEAR_FRACTION))
    want_ice = crit.goal == "ice_craters" and ice is not None
    ice_km = ice.distance_km(LA, LO).reshape(LA.shape) if want_ice else None
    with_ice = meets & (ice_km <= crit.max_ice_km) if want_ice else np.zeros_like(meets)
    sc = score(sun, earth, watts, slope, crit)

    # Regions: connected ice-range cells first, then the other suitable cells.
    cell_km2 = (MOON_R_KM ** 2 * math.radians(res) ** 2) * np.cos(np.radians(LA))
    regions, n = [], 0
    for mask, in_range in ((with_ice, True), (meets & ~with_ice, False)):
        labels, m = label_regions(mask)
        for k in range(m):
            cells = np.flatnonzero(labels.ravel() == k)
            best = cells[np.argmax(sc.ravel()[cells])]
            regions.append({"k": n + k, "cells": cells, "best": best, "ice": in_range,
                            "score": float(sc.ravel()[best]), "area": float(cell_km2.ravel()[cells].sum())})
        n += m
    regions.sort(key=lambda r: (r["ice"], r["score"], r["area"]), reverse=True)

    # Stage 2: give the best cell of each top region a full terrain skyline and re-check it.
    s_vec, E_vec = sky_vectors(sub)
    out, checked = [], 0
    for r in regions:
        if len(out) >= TOP_REGIONS:
            break
        b = r["best"]
        lat, lon = float(LA.ravel()[b]), float(LO.ravel()[b])
        stats = (float(sun.ravel()[b]), float(earth.ravel()[b]), float(watts.ravel()[b]))
        terrain_checked = bool(terrain.ravel()[b])
        if not terrain_checked and checked < 60:
            sky = compute_skylines(heights, np.array([lat]), np.array([lon]), az_step=2.0, samples=200)
            a, e_, w = screen_cells(np.array([lat]), np.array([lon]), s_vec, E_vec, sky, 2.0)
            stats, terrain_checked, checked = (float(a[0]), float(e_[0]), float(w[0])), True, checked + 1
        sun_b, earth_b, w_b = stats
        ok = sun_b >= crit.min_sun_pct and earth_b >= crit.min_earth_pct and w_b >= crit.min_avg_w_m2
        ice_b = float(ice_km.ravel()[b]) if want_ice else None
        extra = ({"ice_km": round(ice_b, 1), "within_ice_range": r["ice"],
                  "nearest_ice_crater": ice.nearest_crater(lat, lon)} if want_ice else {})
        out.append({
            "id": f"r{r['k']}",
            "lat": round(lat, 3), "lon": round(lon, 3),
            "area_km2": round(r["area"]),
            "cells": int(len(r["cells"])),
            "sun_pct": round(sun_b, 1), "earth_pct": round(earth_b, 1),
            "avg_w_m2": round(w_b, 1), "slope_deg": round(float(slope.ravel()[b]), 1),
            "score": round(float(score(np.float32(sun_b), np.float32(earth_b), np.float32(w_b),
                                       slope.ravel()[b], crit)), 3),
            "terrain_checked": terrain_checked,
            "passes_with_terrain": bool(ok),
            **extra,
        })
    out.sort(key=lambda r: (r["passes_with_terrain"], r.get("within_ice_range", False), r["score"], r["area_km2"]),
             reverse=True)

    classes = np.full(LA.shape, 255, np.uint8)            # 255 = outside the search region
    classes[inside] = 0
    classes[near] = 1
    classes[meets] = 2
    classes[with_ice] = 3                                  # suitable and within max_ice_km of ice
    return {
        "criteria": {
            "period_start": crit.period_start.isoformat(), "period_end": crit.period_end.isoformat(),
            "min_sun_pct": crit.min_sun_pct, "min_earth_pct": crit.min_earth_pct,
            "min_avg_w_m2": crit.min_avg_w_m2, "max_slope_deg": crit.max_slope_deg,
            "region": crit.region, "region_label": REGIONS.get(crit.region, crit.region),
            "goal": crit.goal, "goal_label": GOALS.get(crit.goal) if crit.goal else None,
            "max_ice_km": crit.max_ice_km if crit.goal == "ice_craters" else None,
        },
        "period": {"start": f"{crit.period_start}T00:00Z",
                   "end": f"{crit.period_end + timedelta(days=1)}T00:00Z",
                   "hours": hours, "step_hours": step_h},
        "grid": {"res_deg": res, "nlat": int(LA.shape[0]), "nlon": int(LA.shape[1]),
                 "lat0": float(LA[0, 0]), "lon0": float(LO[0, 0]),
                 "classes_b64": base64.b64encode(classes.tobytes()).decode()},
        "counts": {"meeting_cells": int(meets.sum()), "near_cells": int(near.sum()),
                   "searched_cells": int(inside.sum()), "regions": int(n),
                   "meeting_area_km2": round(float(cell_km2[meets].sum())),
                   "ice_range_cells": int(with_ice.sum()),
                   "ice_range_area_km2": round(float(cell_km2[with_ice].sum()))},
        "regions": out,
        "terrain": {"precomputed_skylines": bool(skylines and skylines.loaded),
                    "skyline_cells": int(skylines.rows) if skylines and skylines.loaded else 0,
                    "checked_in_stage2": checked},
        "sources": ([sub["source"], heights.source] + ([skylines.source] if skylines and skylines.loaded else [])
                    + (ice.sources() if want_ice else [])),
        "ice": ice.to_dict() if want_ice else None,
        "seconds": round(time.time() - t0, 1),
    }
