"""Precompute terrain skylines for the site finder (one per 0.5° grid cell).

For every cell centre: the elevation of the LOLA terrain horizon in each direction
(every 4° of azimuth, out to 150 km, curvature included). With these, the finder's
global screen counts the Sun and Earth only when they're above the real skyline: crater
floors in shadow, peaks and rims that see more.

Uses the global LOLA grid from scripts/fetch_lola.py. Runs on all CPU cores; about
10-15 minutes for the whole Moon. Output (~47 MB) goes next to the LOLA data:
~/LunarPlannerData/finder_skylines_0.5.npz

Usage:  python scripts/build_skylines.py [--min-abs-lat 0] [--workers 4]
"""

from __future__ import annotations

import argparse
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from api.finder import RES_DEG, SKY_AZ_STEP, compute_skylines, grid  # noqa: E402
from api.lola import LolaGlobalHeights  # noqa: E402
from api.paths import big_data_dir, lola_dir  # noqa: E402

_heights = None


def _work(args):
    global _heights
    if _heights is None:
        _heights = LolaGlobalHeights.load(lola_dir())
    lats, lons = args
    return compute_skylines(_heights, lats, lons, az_step=SKY_AZ_STEP).astype(np.float16)


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--min-abs-lat", type=float, default=0.0, help="only cells at or beyond this |latitude|")
    p.add_argument("--workers", type=int, default=4)
    a = p.parse_args()

    heights = LolaGlobalHeights.load(lola_dir())
    if heights is None:
        sys.exit("No LOLA grid found. Run scripts/fetch_lola.py first.")
    lats, lons = grid(RES_DEG)
    LA, LO = np.meshgrid(lats, lons, indexing="ij")
    # Poles first: that's where terrain matters most.
    rows = sorted(range(len(lats)), key=lambda r: -abs(lats[r]))
    rows = [r for r in rows if abs(lats[r]) >= a.min_abs_lat]
    index = np.full(LA.shape, -1, np.int32)
    sky = np.empty((len(rows) * len(lons), int(360 / SKY_AZ_STEP)), np.float16)

    t0, done = time.time(), 0
    jobs = [(LA[r], LO[r]) for r in rows]
    with ProcessPoolExecutor(max_workers=a.workers) as pool:
        for k, (r, result) in enumerate(zip(rows, pool.map(_work, jobs, chunksize=2))):
            index[r] = np.arange(k * len(lons), (k + 1) * len(lons))
            sky[k * len(lons):(k + 1) * len(lons)] = result
            done += 1
            if done % 20 == 0 or done == len(rows):
                el = time.time() - t0
                print(f"  {done}/{len(rows)} latitude rows ({lats[r]:+.2f}°)  {el / 60:.1f} min elapsed, "
                      f"~{el / done * (len(rows) - done) / 60:.1f} min left", flush=True)

    out = big_data_dir() / f"finder_skylines_{RES_DEG}.npz"
    out.parent.mkdir(parents=True, exist_ok=True)
    np.savez(out, res=RES_DEG, az_step=SKY_AZ_STEP, index=index, sky=sky,
             source=f"Terrain skylines from {heights.source}, 4° azimuth, 150 km radius")
    print(f"wrote {out} ({out.stat().st_size / 1e6:.0f} MB) in {(time.time() - t0) / 60:.1f} min")


if __name__ == "__main__":
    main()
