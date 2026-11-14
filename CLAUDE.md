# Lunar Planner

Read `docs/ARCHITECTURE.md` first. It is the source of truth for the design and the `/evaluate` contract.

## Layout

- `api/main.py`: FastAPI app. Validates the request, looks up terrain and the lander, then calls the evaluator. It also serves `web/`.
- `api/evaluator.py`: `evaluate(...)`. It does no file or network I/O itself; the ephemeris provider is passed in. Thresholds live at the top.
- `api/ephemeris.py`: Sun and Earth azimuth/elevation from a lunar lat/lon. `HorizonsEphemeris` (JPL Horizons API, disk-cached in `data/horizons_cache/`) is the default. `AnalyticEphemeris` is the offline fallback and is labelled APPROXIMATE.
- `api/lola.py`: real NASA LOLA elevation at two levels. `LolaGlobalHeights` (LDEM_128 ~237 m, or LDEM_64, memory-mapped from `~/LunarPlannerData/lola/`; see `api/paths.py`) and on-demand ~30 m `DetailPatch`es fetched from NASA PDS by HTTP range requests and cached in `~/LunarPlannerData/lola_detail/`. Both are *height sources* (`heights(lat, lon)`, `source`, `resolution_m`).
- `api/terrain.py`: site stats. Elevation and slope come from the active height source; temperature min/max still come from **PLACEHOLDER** `data/t*_k.npy` grids.
- `api/patch.py`: local terrain patches and horizon profiles (skylines) built from any height source. `SyntheticHeights` is the labelled fallback when no LOLA grid is downloaded.
- `api/data/landers.json`: lander specs. Any value not taken from a published source goes in that entry's `estimated_fields`.
- `api/data/sites.json`: notable landing sites (Apollo, Luna, Chang'e, CLPS past and planned...). Every entry needs a `source`. Approximate locations get `precision: "region"` and a `note`.
- `scripts/fetch_lola.py`: one-time 2.1 GB download of LOLA LDEM_128 (resumable; `--ppd 64` for the 531 MB grid), saved outside the project in `~/LunarPlannerData/` (override with `LUNAR_DATA_DIR`). Never put big data in the repo or OneDrive.
- `scripts/build_grids.py`: writes the **PLACEHOLDER** temperature grids (to be replaced with Diviner data).
- `scripts/fetch_moontrek_layers.py`: stitches NASA Moon Trek WMTS layers into `web/assets/moontrek/*.jpg`.
- `web/`: plain HTML/JS modules with globe.gl from a CDN. No build step. `web/links.js` builds QuickMap, Moon Trek and Horizons deep links. `web/site3d.js` is the three.js 3D site view and timelapse (x = east, y = up, z = −north).
- `tests/`: pytest. Run with `python -m pytest`. Tests never call the network unless you set `RUN_LIVE=1`.
- `docs/AI_USAGE.md`: running log of how AI was used on this project.

## Rules

- The `/evaluate` response shape in `docs/ARCHITECTURE.md` is the interface between frontend and backend. If you change it, update the doc in the same PR.
- globe.gl uses `lng`; the API and `sites.json` use `lon`. Convert at the boundary in `web/app.js` only.
- Latitude runs from -90 to 90 and longitude from -180 to 180 (east positive), everywhere.
- Times are UTC ISO 8601 strings ending in `Z`.
- Keep `evaluate()` fast: vectorized NumPy at hourly steps. Horizons calls go through the cache.
- Never present placeholder or estimated data as real. Placeholder modules add a note to `sources`.
- Sun/Earth "visible" means above the terrain skyline (`evaluator.skyline_at`), not just above 0°. Keep the `_flat` comparison values.
- Elevations are metres above the 1737.4 km sphere everywhere (LOLA and Horizons share this reference).
- **AI use log:** at the end of every AI-assisted work session, append an entry to `docs/AI_USAGE.md` (date, who, tool, what the AI did, what a human checked, what is still unverified). Keep it honest and specific.

## Run

```bash
python -m venv .venv
.venv\Scripts\activate          # Windows (macOS/Linux: source .venv/bin/activate)
pip install -r requirements.txt
python scripts/fetch_lola.py
python scripts/build_grids.py
uvicorn api.main:app --reload    # http://localhost:8000
python -m pytest
```

Offline demo: set `EPHEMERIS=analytic` before starting uvicorn.
