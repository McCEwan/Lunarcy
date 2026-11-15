"""FastAPI app: /evaluate, /landers, /sites, /terrain/*, /sky/*, /health, plus the frontend."""

from __future__ import annotations

import json
import math
import logging
import os
import time
from datetime import date, datetime, timezone
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles

from .ephemeris import AnalyticEphemeris, HorizonsEphemeris
from .evaluator import evaluate
from .lola import DetailedHeights, DetailStore, LolaGlobalHeights
from .finder import Criteria, Skylines, find_regions
from .ice import IceMap
from .siteplan import plan_site
from .scenarios import PRIORITIES, best_dates, nearby
from . import ephemeris
from .evaluator import LUNAR_DAY_DAYS
from .models import EvaluateRequest, EvaluateResponse, FindRequest
from .patch import SyntheticHeights, horizon_profile, terrain_patch
from .paths import PROJECT_DATA, big_data_dir, lola_detail_dir, lola_dir
from .terrain import Terrain

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "api" / "data"

LANDERS: list[dict] = json.loads((DATA / "landers.json").read_text(encoding="utf-8"))
LANDERS_BY_ID = {lander["id"]: lander for lander in LANDERS}
SITES: list[dict] = json.loads((DATA / "sites.json").read_text(encoding="utf-8"))
# Surface temperature: real Diviner grids (scripts/fetch_diviner.py) if present,
# else the labelled placeholder grids in data/ (scripts/build_grids.py).
TERRAIN = Terrain.load(ROOT / "data", big_data_dir() / "diviner_tbol_minmax.npz")

# EPHEMERIS=analytic forces the offline model (tests, or a demo with no internet).
EPHEMERIS_MODE = os.environ.get("EPHEMERIS", "horizons").lower()
EPHEM = (
    AnalyticEphemeris()
    if EPHEMERIS_MODE == "analytic"
    else HorizonsEphemeris(cache_dir=ROOT / "data" / "horizons_cache")
)

# Elevation, level 1 (global estimate): the sharpest real LOLA grid downloaded by
# scripts/fetch_lola.py (LDEM_128, else LDEM_64), else the labelled synthetic placeholder.
# Big data lives outside the project (api/paths.py); data/lola is the old location.
GLOBAL_HEIGHTS = LolaGlobalHeights.load(lola_dir(), PROJECT_DATA / "lola") or SyntheticHeights()
if isinstance(GLOBAL_HEIGHTS, SyntheticHeights):
    log.warning("No LOLA grid in %s: using PLACEHOLDER synthetic terrain. Run scripts/fetch_lola.py", lola_dir())
else:
    log.info("Global elevation: %s", GLOBAL_HEIGHTS.source)

# Elevation, level 2 (detailed): ~30 m LOLA patches fetched on demand and cached on disk.
DETAIL = DetailStore(lola_detail_dir())
_detailed_sources: dict[str, DetailedHeights] = {}

app = FastAPI(title="Lunar Planner")


def heights_for(lat: float, lon: float, level: str):
    """The height source for a site at the requested terrain level."""
    if level != "detailed":
        return GLOBAL_HEIGHTS
    key = DETAIL.key(lat, lon)
    if key not in _detailed_sources:
        try:
            patch, _ = DETAIL.get(lat, lon)
        except Exception as exc:
            log.exception("Detailed LOLA fetch failed")
            raise HTTPException(502, detail=f"Couldn't download detailed LOLA terrain from NASA PDS: {exc}")
        _detailed_sources[key] = DetailedHeights(GLOBAL_HEIGHTS, patch)
    return _detailed_sources[key]


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "elevation": GLOBAL_HEIGHTS.source,
        "temperature_loaded": TERRAIN.loaded,
        "ephemeris": EPHEMERIS_MODE,
        "landers": len(LANDERS),
        "sites": len(SITES),
    }


@app.get("/landers")
def landers() -> list[dict]:
    return LANDERS


@app.get("/sites")
def sites() -> list[dict]:
    """Curated notable landing sites: Apollo, Luna, Chang'e, CLPS (past and planned), etc."""
    return SITES


@app.post("/terrain/detail")
def fetch_terrain_detail(
    lat: float = Query(ge=-90, le=90),
    lon: float = Query(ge=-180, le=180),
) -> dict:
    """Download (or reuse) the detailed ~30 m LOLA patch for a site: the 'detailed terrain' button."""
    t0 = time.time()
    try:
        patch, cached = DETAIL.get(lat, lon)
    except Exception as exc:
        log.exception("Detailed LOLA fetch failed")
        raise HTTPException(502, detail=f"Couldn't download detailed LOLA terrain from NASA PDS: {exc}")
    return {
        "level": "detailed",
        "product": patch.product,
        "spacing_m": patch.spacing_m,
        "size_m": 2 * patch.half_m,
        "cached": cached,
        "seconds": round(time.time() - t0, 1),
        "source": heights_for(lat, lon, "detailed").source,
    }


@app.get("/terrain/patch")
def get_terrain_patch(
    lat: float = Query(ge=-90, le=90),
    lon: float = Query(ge=-180, le=180),
    size_km: float = Query(20.0, ge=1, le=100),
    n: int = Query(256, ge=16, le=1025),
    level: str = Query("global", pattern="^(global|detailed)$"),
) -> dict:
    """n×n local height grid around a site, for the 3D view."""
    out = terrain_patch(heights_for(lat, lon, level), lat, lon, size_km * 1000, n)
    out["level"] = level
    return out


@app.get("/terrain/horizon")
def get_terrain_horizon(
    lat: float = Query(ge=-90, le=90),
    lon: float = Query(ge=-180, le=180),
    radius_km: float = Query(150.0, ge=5, le=400),
    level: str = Query("global", pattern="^(global|detailed)$"),
) -> dict:
    """Skyline elevation angle per degree of azimuth (clockwise from north)."""
    out = dict(horizon_profile(heights_for(lat, lon, level), lat, lon, radius_km * 1000))
    out["level"] = level
    return out


@app.get("/sky/subpoints")
def sky_subpoints(time: datetime | None = None) -> dict:
    """Where the Sun and Earth are directly overhead on the Moon (for the globe's lighting)."""
    when = time or datetime.now(timezone.utc)
    if when.tzinfo is not None:
        when = when.astimezone(timezone.utc).replace(tzinfo=None)
    return EPHEM.subpoints(np.datetime64(when, "h"))


@app.get("/sky/subpoints/series")
def sky_subpoints_series(
    start: date | None = None,
    days: float = Query(29.5, ge=1, le=60),
    step_hours: int = Query(6, ge=1, le=24),
) -> dict:
    """Sub-solar and sub-Earth points through a span, in one Horizons query: drives the
    globe's lunar-day time-lapse."""
    first = start or datetime.now(timezone.utc).date()
    times = ephemeris.time_grid(first, days, step_hours)
    sub = EPHEM.subpoint_series(times)
    wrap = lambda v: round((float(v) + 180.0) % 360.0 - 180.0, 3)   # noqa: E731
    return {
        "times": [str(np.datetime64(t, "m")) + "Z" for t in times],
        "sun": [[round(float(a), 3), wrap(b)] for a, b in zip(sub["sun_lat"], sub["sun_lon"])],
        "earth": [[round(float(a), 3), wrap(b)] for a, b in zip(sub["earth_lat"], sub["earth_lon"])],
        "source": sub["source"],
    }


_skylines: Skylines | None = None


def finder_skylines() -> Skylines:
    """Precomputed skylines (scripts/build_skylines.py), loaded on first use, reloaded if
    the file appears later."""
    global _skylines
    if _skylines is None or not _skylines.loaded:
        _skylines = Skylines(big_data_dir() / "finder_skylines_0.5.npz")
    return _skylines


_ice_map: IceMap | None = None


def ice_map() -> IceMap:
    """Cold traps and rated polar craters (api/ice.py), built on first use (~5-10 s)."""
    global _ice_map
    if _ice_map is None:
        _ice_map = IceMap(GLOBAL_HEIGHTS, finder_skylines(), TERRAIN)
    return _ice_map


@app.get("/ice")
def ice() -> dict:
    """Where water ice could survive: cold-trap grid and rated named polar craters."""
    out = ice_map().to_dict()
    if isinstance(GLOBAL_HEIGHTS, SyntheticHeights) or not TERRAIN.real:
        out["sources"].append("PLACEHOLDER: synthetic terrain or placeholder temperatures in use; "
                              "crater depths, shadows and cold traps are not real")
    return out


def _site_sky(lat: float, lon: float, start: date | None, end: date | None, level: str = "global",
              default_days: float = LUNAR_DAY_DAYS):
    """The site's height source and one hourly Sun/Earth series (start..end inclusive, or
    `default_days` from start/today). Shared by the /site/* endpoints."""
    if end and start and end < start:
        raise HTTPException(422, detail="end must not be before start")
    first = start or datetime.now(timezone.utc).date()
    days = (end - first).days + 1 if end else default_days
    heights = heights_for(lat, lon, level)
    site_alt = float(heights.heights(np.array(lat), np.array(lon)))
    times = ephemeris.time_grid(first, days, 1.0)
    return first, days, heights, EPHEM.sky(lat, lon, times, alt_m=site_alt), times


@app.get("/site/dates")
def site_dates(
    lat: float = Query(ge=-90, le=90),
    lon: float = Query(ge=-180, le=180),
    start: date | None = None,
    days: int = Query(60, ge=1, le=366),
    mission_days: float = Query(14, ge=1, le=60),
    priority: str = Query("both", pattern="^(both|sun|comms)$"),
) -> dict:
    """Best touchdown dates at one site: every hour over `days` from `start` is scored on the
    following `mission_days` (Sun, Earth and both above the real terrain skyline)."""
    first = start or datetime.now(timezone.utc).date()
    span = days + math.ceil(mission_days) + 1
    _, _, heights, sky, times = _site_sky(lat, lon, first, None, "global", default_days=span)
    skyline = horizon_profile(heights, lat, lon)["elevation_deg"]
    out = best_dates(sky, skyline, times, first, days, mission_days, priority)
    out["sources"] = [sky.source, heights.source]
    return out


@app.get("/site/nearby")
def site_nearby(
    lat: float = Query(ge=-90, le=90),
    lon: float = Query(ge=-180, le=180),
    start: date | None = None,
    end: date | None = None,
    radius_km: float = Query(3.0, ge=0.5, le=15),
) -> dict:
    """How sunlight and Earth contact change within a few km of a site (same dates)."""
    first, days, heights, sky, _ = _site_sky(lat, lon, start, end, "global")
    out = nearby(heights, lat, lon, sky, radius_m=radius_km * 1000)
    out["period"] = {"start": f"{first}T00:00Z", "days": round(days, 2)}
    out["sources"] = [sky.source, heights.source]
    return out


@app.get("/site/plan")
def site_plan(
    lat: float = Query(ge=-90, le=90),
    lon: float = Query(ge=-180, le=180),
    start: date | None = None,
    end: date | None = None,
    level: str = Query("global", pattern="^(global|detailed)$"),
) -> dict:
    """Solar array and comms hub spots near a landing site, the drivable route between them,
    and the way to the nearest ice candidate (api/siteplan.py). Period: start..end (UTC dates,
    inclusive), default the next lunar day."""
    first, days, heights, sky, _ = _site_sky(lat, lon, start, end, level)
    try:
        ice_src = ice_map()
    except Exception:
        log.exception("Ice map unavailable for the site plan")
        ice_src = None
    out = plan_site(heights, lat, lon, sky, ice_src, level=level)
    out["period"] = {"start": f"{first}T00:00Z", "days": round(days, 2)}
    if isinstance(heights, SyntheticHeights) or (ice_src is not None and not TERRAIN.real):
        out["sources"].append("PLACEHOLDER data in use: the plan is not based on real terrain/temperatures")
    return out


@app.post("/find")
def find(req: FindRequest) -> dict:
    """Search the whole Moon for regions meeting the mission requirements (api/finder.py)."""
    crit = Criteria(req.period_start, req.period_end, req.min_sun_pct, req.min_earth_pct,
                    req.min_avg_w_m2, req.max_slope_deg, req.region, req.goal, req.max_ice_km)
    return find_regions(crit, EPHEM, GLOBAL_HEIGHTS, finder_skylines(),
                        ice=ice_map() if req.goal == "ice_craters" else None)


@app.post("/evaluate", response_model=EvaluateResponse, response_model_by_alias=True)
def evaluate_site(req: EvaluateRequest) -> dict:
    lander = None
    if req.lander_id is not None:
        lander = LANDERS_BY_ID.get(req.lander_id)
        if lander is None:
            raise HTTPException(404, detail=f"Unknown lander '{req.lander_id}'")

    if req.payload_kg is not None:
        if lander is None:
            _field_error("payload_kg", "needs a lander_id")
        cap = lander["payload_capacity_kg"]
        if req.payload_kg > cap:
            _field_error("payload_kg", f"{lander['name']} carries at most {cap:g} kg")

    heights = heights_for(req.lat, req.lon, req.terrain_level)
    site = TERRAIN.sample(req.lat, req.lon, heights)
    skyline = horizon_profile(heights, req.lat, req.lon)["elevation_deg"]
    site_alt = site.elevation_m or 0.0

    sources = [heights.source]
    if TERRAIN.source:
        sources.append(TERRAIN.source)
    if lander:
        sources.extend(lander["sources"])

    result = evaluate(
        req.lat,
        req.lon,
        terrain=site,
        search_start=datetime.now(timezone.utc).date(),
        ephem=EPHEM,
        lander=lander,
        payload_kg=req.payload_kg,
        landing_date=req.landing_date,
        landing_time=req.landing_time,
        period_start=req.period_start,
        period_end=req.period_end,
        skyline=skyline,
        site_alt_m=site_alt,
        sources=sources,
    )
    result["terrain"] = {
        "level": req.terrain_level,
        "heights_source": heights.source,
        "resolution_m": float(heights.resolution_m),
        "site_elevation_m": site_alt,
        "skyline_max_deg": float(max(skyline)),
        "detailed_cached": DETAIL.cached(req.lat, req.lon) is not None,
    }
    return result


def _field_error(field: str, msg: str) -> None:
    """Raise a 422 shaped like FastAPI's own validation errors."""
    raise HTTPException(422, detail=[{"loc": ["body", field], "msg": msg, "type": "value_error"}])


class RevalidatingStaticFiles(StaticFiles):
    """Static files that browsers must re-check before reuse, so edits show up on a normal
    reload (cheap: unchanged files answer 304 Not Modified)."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache"
        return response


# Mounted last so the API routes above take priority.
app.mount("/", RevalidatingStaticFiles(directory=ROOT / "web", html=True), name="web")
