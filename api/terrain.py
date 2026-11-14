"""Site terrain stats: elevation and slope from real LOLA heights, plus temperature.

- Elevation and slope come from a *height source* (see api/lola.py): the LOLA
  global grid (~474 m) or a detailed LOLA patch (~30 m) once fetched. Slope is
  measured across the source's own pixel size, so it's a terrain-scale slope,
  not a boulder-scale one; the slope check says which baseline it used.
- Temperature min/max come from real NASA LRO Diviner measurements
  (~/LunarPlannerData/diviner_tbol_minmax.npz, built by scripts/fetch_diviner.py):
  0.5° cells, the hottest and coldest of 96 local-time bins of bolometric temperature.
  If that file is missing, the labelled PLACEHOLDER grids from scripts/build_grids.py
  (data/tmin_k.npy, tmax_k.npy) are used instead.

Grid conventions:
  Diviner (cell-centred): shape (360, 720); row 0 = 89.75°S, column 0 = 179.75°W.
  Placeholder (node grid): shape (n_lat, n_lon); row 0 = -90, last row = +90;
  column 0 = -180, last column = +180.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .lola import destination

TEMP_FIELDS = ("tmin_k", "tmax_k")


@dataclass(frozen=True)
class TerrainSample:
    elevation_m: float | None
    slope_deg: float | None
    tmin_k: float | None
    tmax_k: float | None
    slope_baseline_m: float | None = None
    heights_source: str | None = None


class Terrain:
    def __init__(self, temps: dict[str, np.ndarray] | None, temp_source: str | None = None,
                 cell_centred: bool = False):
        self.temps = temps
        self.temp_source = temp_source
        self.cell_centred = cell_centred

    @property
    def loaded(self) -> bool:
        return self.temps is not None

    @property
    def real(self) -> bool:
        return self.loaded and not (self.temp_source or "").startswith("PLACEHOLDER")

    @property
    def source(self) -> str | None:
        return self.temp_source

    @classmethod
    def load(cls, data_dir: Path, diviner_path: Path | None = None) -> "Terrain":
        if diviner_path and diviner_path.exists():
            z = np.load(diviner_path)
            return cls({f: z[f] for f in TEMP_FIELDS}, str(z["source"]), cell_centred=True)
        paths = {f: data_dir / f"{f}.npy" for f in TEMP_FIELDS}
        if not all(p.exists() for p in paths.values()):
            return cls(None)
        temps = {f: np.load(p) for f, p in paths.items()}
        meta_path = data_dir / "meta.json"
        source = json.loads(meta_path.read_text())["source"] if meta_path.exists() else None
        return cls(temps, source)

    def sample(self, lat: float, lon: float, heights=None) -> TerrainSample:
        """Stats at a site. `heights` is a height source; without one, elevation/slope are None."""
        elevation = slope = baseline = None
        if heights is not None:
            elevation = round(float(heights.heights(np.array(lat), np.array(lon))), 1)
            slope, baseline = site_slope(heights, lat, lon)
        tmin = tmax = None
        if self.temps is not None:
            look = _cell_bilinear if self.cell_centred else _bilinear
            tmin = look(self.temps["tmin_k"], lat, lon)
            tmax = look(self.temps["tmax_k"], lat, lon)
        return TerrainSample(
            elevation, slope, tmin, tmax,
            slope_baseline_m=baseline,
            heights_source=getattr(heights, "source", None),
        )


def site_slope(heights, lat: float, lon: float) -> tuple[float, float]:
    """Slope (deg) from central differences across one pixel of the height source."""
    b = max(float(getattr(heights, "resolution_m", 100.0)), 20.0)
    bearings = np.array([90.0, 270.0, 0.0, 180.0])
    plat, plon = destination(lat, lon, bearings, np.full(4, b))
    he, hw, hn, hs = heights.heights(plat, plon)
    dzdx = (he - hw) / (2 * b)
    dzdy = (hn - hs) / (2 * b)
    return round(float(np.degrees(np.arctan(np.hypot(dzdx, dzdy)))), 2), 2 * b


def _cell_bilinear(grid: np.ndarray, lat: float, lon: float) -> float | None:
    """Bilinear on a cell-centred global grid (row 0 = southernmost cells), longitude
    wrapping. Cells without data (NaN) are skipped by weighting the valid neighbours."""
    n_lat, n_lon = grid.shape
    res = 180.0 / n_lat
    y = np.clip((lat + 90.0) / res - 0.5, 0, n_lat - 1)
    x = (lon + 180.0) / res - 0.5
    y0 = int(min(np.floor(y), n_lat - 2))
    x0 = int(np.floor(x))
    fy, fx = y - y0, x - x0
    vals, wts = [], []
    for dy, wy in ((0, 1 - fy), (1, fy)):
        for dx, wx in ((0, 1 - fx), (1, fx)):
            v = grid[y0 + dy, (x0 + dx) % n_lon]
            if np.isfinite(v) and wy * wx > 0:
                vals.append(float(v))
                wts.append(wy * wx)
    if not wts:
        return None
    return round(float(np.dot(vals, wts) / sum(wts)), 2)


def _bilinear(grid: np.ndarray, lat: float, lon: float) -> float | None:
    n_lat, n_lon = grid.shape
    y = (lat + 90.0) / 180.0 * (n_lat - 1)
    x = (lon + 180.0) / 360.0 * (n_lon - 1)
    y0 = int(np.clip(np.floor(y), 0, n_lat - 2))
    x0 = int(np.clip(np.floor(x), 0, n_lon - 2))
    fy, fx = y - y0, x - x0
    cell = grid[y0 : y0 + 2, x0 : x0 + 2]
    value = (
        cell[0, 0] * (1 - fy) * (1 - fx)
        + cell[0, 1] * (1 - fy) * fx
        + cell[1, 0] * fy * (1 - fx)
        + cell[1, 1] * fy * fx
    )
    return None if np.isnan(value) else round(float(value), 2)
