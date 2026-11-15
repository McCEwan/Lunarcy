# Lunar Planner

NASA Space Apps 2026: [Lunar Landing Site Navigator](https://www.spaceappschallenge.org/2026/challenges/lunar-landing-site-navigator/).

Lunarcy lets mission planners, educators and the public compare lunar landing sites and dates quickly. Pick a spot on a 3D Moon (click, choose a notable landing site, or type coordinates), or describe your mission and search the whole Moon. For any site and dates you get the Sun and Earth against the real terrain horizon (a 360° panorama, elevation and in-view timelines, time to sunset and Earthset), power and direct-to-Earth comms metrics, the best landing dates if the schedule slips, how much moving a few km would help, and a 3D view with a solar array, comms tower and route plan. Comparison columns are a site *and* its dates. A Learn tab explains why the lunar poles are so hard. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and [docs/AI_USAGE.md](docs/AI_USAGE.md) for how AI was used.

## Built on NASA tools

- **[JPL Horizons](https://ssd.jpl.nasa.gov/horizons/):** Sun and Earth azimuth/elevation from any point on the Moon.
- **[Moon Trek](https://trek.nasa.gov/moon/):** globe textures (LRO WAC imagery, LOLA elevation and slope, Diviner temperature) and per-site links.
- **[LROC QuickMap](https://quickmap.lroc.im-ldi.com/):** per-site links into high-resolution imagery and analysis tools.

## Setup

Requires Python 3.11+.

```bash
python -m venv .venv
.venv\Scripts\activate            # Windows (macOS/Linux: source .venv/bin/activate)
pip install -r requirements.txt
python scripts/fetch_lola.py       # once: 2.1 GB NASA LOLA global elevation into ~/LunarPlannerData/
python scripts/fetch_diviner.py    # once (~5 min, streams 2.8 GB, keeps 2 MB): real Diviner temperatures
python scripts/build_skylines.py   # once, optional (~10-15 min): terrain skylines for the site finder
uvicorn api.main:app --reload
```

Then open http://localhost:8000. Run the tests with `python -m pytest`, or with `RUN_LIVE=1` to also call Horizons. No internet? Start with `EPHEMERIS=analytic`.

The Moon Trek textures are already in `web/assets/moontrek/`. Rebuild them with `python scripts/fetch_moontrek_layers.py`.

## Status: what's real and what's a placeholder

| Piece | Status |
|---|---|
| API contract, validation, error codes | Done (matches the design doc) |
| Sun/Earth positions (`api/ephemeris.py`) | **Real:** JPL Horizons, cached, with the site's LOLA elevation as its altitude. Falls back to a labelled approximation offline. |
| Elevation and slope (`api/lola.py`) | **Real:** NASA LOLA. Global estimate from LDEM_128 (~237 m) everywhere; detailed ~30 m through the API (`POST /terrain/detail`, `level=detailed`). |
| Terrain blocking the Sun/Earth | **Real:** skyline from LOLA applies to sunlight %, power, comms, windows and rise/set times (flat-horizon values shown alongside). |
| Globe day/night + Sun/Earth markers | **Real** directions from Horizons sub-solar/sub-Earth points (markers not to scale). |
| Temperature | **Real:** NASA LRO Diviner night low / day high per 0.5° cell (`scripts/fetch_diviner.py`). Falls back to a labelled placeholder if not downloaded. |
| Notable landing sites (`api/data/sites.json`) | **Real** for past landings (cited). Planned CLPS sites are **approximate regions**. |
| Globe textures | **Real:** NASA Moon Trek layers |
| Lander specs (`api/data/landers.json`) | Partly real. Unpublished values are listed in `estimated_fields`. |
| Frontend (`web/`) | Working: globe, layers, site catalog, links, stat tiles filled by viability with explanation tooltips, Sky & horizon panel (`web/skycharts.js`: horizon panorama, elevation, in-view windows, power, time slider, enlarge, CSV), site + date comparison with CSV export, date stepping, best dates, nearby alternatives, share links, Learn tab. |
| Scenarios (`api/scenarios.py`) | `GET /site/dates` (best touchdown hours over up to a year, scored on the next N days) and `GET /site/nearby` (sunlight and Earth for every point within ±3 km, same skyline method as the site stats). |
| Site finder (landing page, `POST /find`) | Working: whole-Moon search in ~10 s from mission requirements, with a globe heatmap and ranked regions. Terrain-aware everywhere once `build_skylines.py` has run. |
| Ice in deep craters (mission goal, `api/ice.py`) | **Real:** permanent shadow from LOLA skylines, cold traps (≤110 K) from Diviner, 205 named polar craters from the USGS Gazetteer rated for ice; published evidence (LCROSS, LOLA, LAMP) cited. Misses sub-km cold traps. |
| 3D site view + timelapse (`web/site3d.js`) | Working, on **real** LOLA terrain (global or detailed) with Sun/Earth from Horizons. Moon and Earth surfaces are generic textures by design. |

## Splitting the work

The `/evaluate` contract is the boundary, and the frontend never depends on how the numbers are calculated.

- **Backend:** pre-download detailed terrain for the listed sites (instant demo) → vertical-panel power → relay-satellite coverage for the far side.
- **Frontend:** phone layout pass → lander model on the globe → printable scenario report.

Work on a branch, keep PRs small, update the design doc if you change the contract, and add an entry to `docs/AI_USAGE.md` after each AI-assisted session.
