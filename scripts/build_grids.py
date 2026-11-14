"""Build the PLACEHOLDER surface-temperature grids that api/terrain.py loads.

Elevation and slope are now real (NASA LOLA, see scripts/fetch_lola.py and
api/lola.py). Only temperature is still synthetic here.

TODO: replace `synthetic_temperature()` with LRO Diviner global min/max surface
temperature (PDS Geosciences Node / Diviner "global cumulative products").
Download into data/raw/ (gitignored), resample to the grid below, NaN for holes.

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


def synthetic_temperature(res_deg: float) -> tuple[dict[str, np.ndarray], str]:
    lat = np.linspace(-90, 90, int(round(180 / res_deg)) + 1)
    lon = np.linspace(-180, 180, int(round(360 / res_deg)) + 1)
    la, _ = np.meshgrid(np.radians(lat), np.radians(lon), indexing="ij")
    # Hot at the equator, cold at the poles; nights are cold everywhere.
    coslat = np.clip(np.cos(la), 0, 1)
    grids = {"tmin_k": 40 + 60 * coslat, "tmax_k": 120 + 270 * coslat ** 0.5}
    return ({k: v.astype(np.float32) for k, v in grids.items()},
            "PLACEHOLDER temperature: synthetic min/max grids, not Diviner yet")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--res", type=float, default=0.5, help="grid resolution in degrees")
    args = parser.parse_args()

    grids, source = synthetic_temperature(args.res)
    DATA_DIR.mkdir(exist_ok=True)
    for name, grid in grids.items():
        np.save(DATA_DIR / f"{name}.npy", grid)
        print(f"wrote data/{name}.npy  shape={grid.shape}")
    (DATA_DIR / "meta.json").write_text(json.dumps({"source": source, "res_deg": args.res}, indent=2))
    print(f"wrote data/meta.json  ({source})")
    print("For real elevation and slope, run: python scripts/fetch_lola.py")


if __name__ == "__main__":
    main()
