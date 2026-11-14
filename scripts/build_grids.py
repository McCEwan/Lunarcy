"""Build the terrain grids that api/terrain.py loads at startup.

PLACEHOLDER: this writes SYNTHETIC grids (smooth made-up terrain) in the right
format, so the app runs end to end before the real data is in.

TODO (backend): replace `synthetic_grids()` with real data:
  - elevation_m, slope_deg: LRO LOLA global DEM / slope products (NASA PDS)
  - tmin_k, tmax_k: LRO Diviner global min/max surface temperature (NASA PDS)
Download into data/raw/ (gitignored), resample to the grid below, keep NaN for holes.

Grid convention (must match api/terrain.py):
  equirectangular float32, shape (n_lat, n_lon); row 0 = lat -90, last row = +90;
  column 0 = lon -180, last column = +180.

Usage:  python scripts/build_grids.py [--res 0.5]
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

DATA_DIR = Path(__file__).resolve().parent.parent / "data"


def synthetic_grids(res_deg: float) -> tuple[dict[str, np.ndarray], str]:
    lat = np.linspace(-90, 90, int(round(180 / res_deg)) + 1)
    lon = np.linspace(-180, 180, int(round(360 / res_deg)) + 1)
    la, lo = np.meshgrid(np.radians(lat), np.radians(lon), indexing="ij")

    rng = np.random.default_rng(42)
    elevation = np.zeros_like(la)
    for _ in range(12):
        k_lat, k_lon = rng.integers(1, 9, size=2)
        phase = rng.uniform(0, 2 * np.pi, size=2)
        amp = rng.uniform(300, 1500)
        elevation += amp * np.sin(k_lat * la + phase[0]) * np.cos(k_lon * lo + phase[1])

    # Slope from the elevation gradient, rescaled to a plausible 0-25° range
    # (a coarse grid can't resolve real slopes; the real build should use LOLA slope).
    dy, dx = np.gradient(elevation)
    slope = np.hypot(dx, dy * np.maximum(np.cos(la), 0.05))
    slope = 25.0 * slope / slope.max()

    # Hot at the equator, cold at the poles; nights are cold everywhere.
    coslat = np.clip(np.cos(la), 0, 1)
    tmax = 120 + 270 * coslat ** 0.5
    tmin = 40 + 60 * coslat

    grids = {
        "elevation_m": elevation,
        "slope_deg": slope,
        "tmin_k": tmin,
        "tmax_k": tmax,
    }
    return {k: v.astype(np.float32) for k, v in grids.items()}, \
        "PLACEHOLDER terrain: synthetic grids, not LOLA/Diviner yet"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--res", type=float, default=0.5, help="grid resolution in degrees")
    args = parser.parse_args()

    grids, source = synthetic_grids(args.res)
    DATA_DIR.mkdir(exist_ok=True)
    for name, grid in grids.items():
        np.save(DATA_DIR / f"{name}.npy", grid)
        print(f"wrote data/{name}.npy  shape={grid.shape}")
    (DATA_DIR / "meta.json").write_text(json.dumps({"source": source, "res_deg": args.res}, indent=2))
    print(f"wrote data/meta.json  ({source})")


if __name__ == "__main__":
    main()
