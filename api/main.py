"""FastAPI app: /evaluate, /landers, /sites, /health, plus the static frontend."""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles

from .ephemeris import AnalyticEphemeris, HorizonsEphemeris
from .evaluator import evaluate
from .models import EvaluateRequest, EvaluateResponse
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
        sources=sources,
    )


def _field_error(field: str, msg: str) -> None:
    """Raise a 422 shaped like FastAPI's own validation errors."""
    raise HTTPException(422, detail=[{"loc": ["body", field], "msg": msg, "type": "value_error"}])


# Mounted last so the API routes above take priority.
app.mount("/", StaticFiles(directory=ROOT / "web", html=True), name="web")
