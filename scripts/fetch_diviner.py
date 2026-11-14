"""Build real surface-temperature grids from NASA LRO Diviner measurements.

Source: Diviner Global Cumulative Products (GCP), PDS Geosciences Node,
https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_diviner_derived1/data_derived_gcp/
Eighteen 10°-latitude bands, each a fixed-width ASCII table: for every 0.5° cell and
every 0.25 h of local time (96 bins), the average brightness temperature measured by
Diviner over the mission, per channel plus the bolometric temperature `tbol` (K).

For each cell we keep:
    tmax_k = the hottest local-time bin (daytime maximum)
    tmin_k = the coldest local-time bin (night-time minimum)
using `tbol` and ignoring -9999 (no data). Each band (~156 MB) is streamed, reduced
and discarded, so only the result is stored (~2 MB):
    ~/LunarPlannerData/diviner_tbol_minmax.npz   (see api/paths.py)

Total download ~2.8 GB; resumable per band (finished bands are cached as small .npy).

Usage:  python scripts/fetch_diviner.py [--workers 3]
"""

from __future__ import annotations

import argparse
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from api.paths import big_data_dir  # noqa: E402

BASE = "https://pds-geosciences.wustl.edu/lro/urn-nasa-pds-lro_diviner_derived1/data_derived_gcp/"
RES = 0.5
NLAT, NLON, NLT = 360, 720, 96
ROW_BYTES = 113
COLS = ["clon", "clat", "ltim", "t3", "t4", "t5", "t6", "t7", "t8", "t9", "tbol"]
FIELD = 10                       # characters per numeric column (after the comma)


def band_name(south: int) -> str:
    north = south + 10
    if south >= 0:
        return f"global_cumul_avg_cyl_{south:02d}n{north:02d}n_002.tab"
    if north <= 0:
        return f"global_cumul_avg_cyl_{abs(south):02d}s{abs(north):02d}s_002.tab"
    raise ValueError(south)


def column_slices(header: bytes):
    """Byte ranges of each column, from the header line's comma positions."""
    commas = [i for i, ch in enumerate(header) if ch == ord(",")]
    starts = [0] + [c + 1 for c in commas]
    ends = commas + [len(header.rstrip(b"\r\n"))]
    return dict(zip(COLS, zip(starts, ends)))


def process_band(south: int, cache: Path) -> np.ndarray:
    """(tmin, tmax) for the 20 latitude rows of one band, shape (2, 20, 720)."""
    out_path = cache / f"band_{south:+03d}.npy"
    if out_path.exists():
        return np.load(out_path)
    url = BASE + band_name(south)
    req = urllib.request.Request(url, headers={"User-Agent": "lunar-planner-hackathon"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=300) as resp:
        raw = resp.read()
    header, body = raw[:ROW_BYTES], raw[ROW_BYTES:]
    sl = column_slices(header)
    rows = np.frombuffer(body[: (len(body) // ROW_BYTES) * ROW_BYTES], dtype=f"S{ROW_BYTES}")
    chars = rows.view(np.uint8).reshape(-1, ROW_BYTES)

    def col(name):
        a, b = sl[name]
        return np.array(chars[:, a:b].copy().view(f"S{b - a}").ravel(), dtype=float)

    lon, lat, ltim, tbol = col("clon"), col("clat"), col("ltim"), col("tbol")
    tbol[tbol < 0] = np.nan                       # -9999 = no data
    i = np.rint((lat + 90 - RES / 2) / RES).astype(int) - (south + 90) * 2
    j = np.rint((lon + 180 - RES / 2) / RES).astype(int)
    k = np.clip(np.floor(ltim / 0.25).astype(int), 0, NLT - 1)   # 0.25 h local-time bins
    grid = np.full((20, NLON, NLT), np.nan, np.float32)
    grid[i, j, k] = tbol
    with np.errstate(all="ignore"):
        res = np.stack([np.nanmin(grid, axis=2), np.nanmax(grid, axis=2)])
    np.save(out_path, res)
    print(f"  band {south:+03d}..{south + 10:+03d}: {len(raw) / 1e6:.0f} MB in {time.time() - t0:.0f} s, "
          f"tmax {np.nanmin(res[1]):.0f}-{np.nanmax(res[1]):.0f} K", flush=True)
    return res


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--workers", type=int, default=3)
    a = p.parse_args()
    cache = big_data_dir() / "diviner_bands"
    cache.mkdir(parents=True, exist_ok=True)
    souths = list(range(-90, 90, 10))
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=a.workers) as pool:
        bands = dict(zip(souths, pool.map(lambda s: process_band(s, cache), souths)))
    tmin = np.concatenate([bands[s][0] for s in souths]).astype(np.float32)   # row 0 = south
    tmax = np.concatenate([bands[s][1] for s in souths]).astype(np.float32)
    out = big_data_dir() / "diviner_tbol_minmax.npz"
    np.savez_compressed(out, tmin_k=tmin, tmax_k=tmax, res=RES,
                        source="NASA LRO Diviner global cumulative bolometric temperature (0.5°), PDS Geosciences Node")
    have = np.isfinite(tmax).mean() * 100
    print(f"wrote {out}  ({have:.1f}% of cells have data) in {(time.time() - t0) / 60:.1f} min")


if __name__ == "__main__":
    main()
