"""FastAPI app: /evaluate, /landers, /sites, /health, plus the static frontend."""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles

from .ephemeris import AnalyticEphemeris, HorizonsEphemeris
from .evaluator import evaluate
from .models import EvaluateRequest, EvaluateResponse
from .patch import SyntheticHeights, horizon_profile, terrain_patch
from .terrain import Terrain

logging.basicConfig(level=logging.INFO)

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "api" / "data"

LANDERS: list[dict] = json.loads((DATA / "landers.json").read_text(encoding="utf-8"))
LANDERS_BY_ID = {lander["id"]: lander for lander in LANDERS}
SITES: list[dict] = json.loads((DATA / "sites.json").read_text(encoding="utf-8"))
TERRAIN = Terrain.load(ROOT / "data")

# EPHEMERIS=analytic forces the offline model (tests, or a demo with no internet).
EPHEMERIS_MODE = os.environ.get("EPHEMERIS", "horizons").lower()
EPHEM = (
    AnalyticEphemeris()
    if EPHEMERIS_MODE == "analytic"
    else HorizonsEphemeris(cache_dir=ROOT / "data" / "horizons_cache")
)

# Heights for the 3D view and horizon profiles. Swap in a LOLA-backed source with
# the same `heights(lat, lon)` / `source` interface when the real data is ready.
HEIGHTS = SyntheticHeights()

app = FastAPI(title="Lunar Planner")


@app.get("/health")
def health() -> dict:
    return {
        "status": "ok",
        "terrain_loaded": TERRAIN.loaded,
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


@app.get("/terrain/patch")
def get_terrain_patch(
    lat: float = Query(ge=-90, le=90),
    lon: float = Query(ge=-180, le=180),
    size_km: float = Query(20.0, ge=1, le=100),
    n: int = Query(256, ge=16, le=512),
) -> dict:
    """n×n local height grid around a site, for the 3D view."""
    return terrain_patch(HEIGHTS, lat, lon, size_km * 1000, n)


@app.get("/terrain/horizon")
def get_terrain_horizon(
    lat: float = Query(ge=-90, le=90),
    lon: float = Query(ge=-180, le=180),
    radius_km: float = Query(150.0, ge=5, le=400),
) -> dict:
    """Skyline elevation angle per degree of azimuth (clockwise from north)."""
    return horizon_profile(HEIGHTS, lat, lon, radius_km * 1000)


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

    sources = []
    if TERRAIN.source:
        sources.append(TERRAIN.source)
    if lander:
        sources.extend(lander["sources"])

    return evaluate(
        req.lat,
        req.lon,
        terrain=TERRAIN.sample(req.lat, req.lon),
        search_start=datetime.now(timezone.utc).date(),
        ephem=EPHEM,
        lander=lander,
        payload_kg=req.payload_kg,
        landing_date=req.landing_date,
        landing_time=req.landing_time,
        sources=sources,
    )


def _field_error(field: str, msg: str) -> None:
    """Raise a 422 shaped like FastAPI's own validation errors."""
    raise HTTPException(422, detail=[{"loc": ["body", field], "msg": msg, "type": "value_error"}])


# Mounted last so the API routes above take priority.
app.mount("/", StaticFiles(directory=ROOT / "web", html=True), name="web")
