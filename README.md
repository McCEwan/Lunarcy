# Lunar Planner

NASA Space Apps 2026: [Lunar Landing Site Navigator](https://www.spaceappschallenge.org/2026/challenges/lunar-landing-site-navigator/).

Pick a spot on a 3D Moon (click, choose a notable landing site, or type coordinates), choose a CLPS lander and a landing date, and get a pass/fail verdict with Sun and Earth visibility, power and comms. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and [docs/AI_USAGE.md](docs/AI_USAGE.md) for how AI was used.

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
python scripts/build_grids.py      # once: writes data/*.npy
uvicorn api.main:app --reload
```

Then open http://localhost:8000. Run the tests with `python -m pytest`, or with `RUN_LIVE=1` to also call Horizons. No internet? Start with `EPHEMERIS=analytic`.

The Moon Trek textures are already in `web/assets/moontrek/`. Rebuild them with `python scripts/fetch_moontrek_layers.py`.

## Status: what's real and what's a placeholder

| Piece | Status |
|---|---|
| API contract, validation, error codes | Done (matches the design doc) |
| Sun/Earth positions (`api/ephemeris.py`) | **Real:** JPL Horizons, cached. Falls back to a labelled approximation offline. |
| Notable landing sites (`api/data/sites.json`) | **Real** for past landings (cited). Planned CLPS sites are **approximate regions**. |
| Globe textures | **Real:** NASA Moon Trek layers |
| Terrain grids (`scripts/build_grids.py`) | **Placeholder:** synthetic. Replace with LOLA and Diviner. |
| Terrain horizon (crater rims, mountains) | Not modeled yet. Horizon is the smooth-sphere horizon. |
| Lander specs (`api/data/landers.json`) | Partly real. Unpublished values are listed in `estimated_fields`. |
| Frontend (`web/`) | Working: globe, layers, site catalog, links, stats, lander, windows, checks, comparison. Charts still TODO. |

## Splitting the work

The `/evaluate` contract is the boundary, and the frontend never depends on how the numbers are calculated.

- **Backend:** real LOLA and Diviner grids → terrain horizon masks for the south pole → tune the checks → more landers.
- **Frontend:** sky chart (az/el) → timeline of valid windows → power and comms charts → lander model on the globe.

Work on a branch, keep PRs small, update the design doc if you change the contract, and add an entry to `docs/AI_USAGE.md` after each AI-assisted session.
