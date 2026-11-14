"""FastAPI app: /evaluate, /landers, /sites, /terrain/*, /sky/*, /health, plus the frontend."""

from __future__ import annotations

import json
import logging
import os
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles

from .ephemeris import AnalyticEphemeris, HorizonsEphemeris
from .evaluator import evaluate
from .lola import DetailedHeights, DetailStore, LolaGlobalHeights
from .models import EvaluateRequest, EvaluateResponse
from .patch import SyntheticHeights, horizon_profile, terrain_patch
from .paths import PROJECT_DATA, lola_detail_dir, lola_dir
from .terrain import Terrain

logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "api" / "data"

LANDERS: list[dict] = json.loads((DATA / "landers.json").read_text(encoding="utf-8"))
LANDERS_BY_ID = {lander["id"]: lander for lander in LANDERS}
SITES: list[dict] = json.loads((DATA / "sites.json").read_text(encoding="utf-8"))
TERRAIN = Terrain.load(ROOT / "data")           # temperature grids (placeholder)

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
