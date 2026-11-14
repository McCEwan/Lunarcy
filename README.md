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
python scripts/fetch_lola.py       # once: 531 MB NASA LOLA global elevation into data/lola/
python scripts/build_grids.py      # once: placeholder temperature grids
uvicorn api.main:app --reload
```

Then open http://localhost:8000. Run the tests with `python -m pytest`, or with `RUN_LIVE=1` to also call Horizons. No internet? Start with `EPHEMERIS=analytic`.

The Moon Trek textures are already in `web/assets/moontrek/`. Rebuild them with `python scripts/fetch_moontrek_layers.py`.

## Status: what's real and what's a placeholder

| Piece | Status |
|---|---|
| API contract, validation, error codes | Done (matches the design doc) |
| Sun/Earth positions (`api/ephemeris.py`) | **Real:** JPL Horizons, cached, with the site's LOLA elevation as its altitude. Falls back to a labelled approximation offline. |
| Elevation and slope (`api/lola.py`) | **Real:** NASA LOLA. Global estimate from LDEM_64 (~474 m) everywhere; detailed ~30 m on demand ("Get detailed terrain"). |
| Terrain blocking the Sun/Earth | **Real:** skyline from LOLA applies to sunlight %, power, comms, windows and rise/set times (flat-horizon values shown alongside). |
| Globe day/night + Sun/Earth markers | **Real** directions from Horizons sub-solar/sub-Earth points (markers not to scale). |
| Temperature | **Placeholder** until Diviner data is added (`scripts/build_grids.py`). |
| Notable landing sites (`api/data/sites.json`) | **Real** for past landings (cited). Planned CLPS sites are **approximate regions**. |
| Globe textures | **Real:** NASA Moon Trek layers |
| Lander specs (`api/data/landers.json`) | Partly real. Unpublished values are listed in `estimated_fields`. |
| Frontend (`web/`) | Working: globe, layers, site catalog, links, stats, lander, windows with suggested landing hour, checks, comparison. Charts still TODO. |
| 3D site view + timelapse (`web/site3d.js`) | Working, on **real** LOLA terrain (global or detailed) with Sun/Earth from Horizons. Moon and Earth surfaces are generic textures by design. |

## Splitting the work

The `/evaluate` contract is the boundary, and the frontend never depends on how the numbers are calculated.

- **Backend:** Diviner temperatures → pre-download detailed terrain for the listed sites (instant demo) → tune the checks → more landers.
- **Frontend:** sky chart (az/el) → timeline of valid windows → power and comms charts → lander model on the globe.

Work on a branch, keep PRs small, update the design doc if you change the contract, and add an entry to `docs/AI_USAGE.md` after each AI-assisted session.
