"""Site terrain stats: elevation and slope from real LOLA heights, plus temperature.

- Elevation and slope come from a *height source* (see api/lola.py): the LOLA
  global grid (~474 m) or a detailed LOLA patch (~30 m) once fetched. Slope is
  measured across the source's own pixel size, so it's a terrain-scale slope,
  not a boulder-scale one; the slope check says which baseline it used.
- Temperature min/max are still PLACEHOLDER grids (data/tmin_k.npy, tmax_k.npy
  from scripts/build_grids.py) until Diviner data is added.

Temperature grid convention (shared with scripts/build_grids.py):
  equirectangular float32, shape (n_lat, n_lon), NaN marks a hole;
  row 0 = latitude -90, last row = +90; column 0 = longitude -180, last = +180.
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
    def __init__(self, temps: dict[str, np.ndarray] | None, temp_source: str | None = None):
        self.temps = temps
        self.temp_source = temp_source

    @property
    def loaded(self) -> bool:
        return self.temps is not None

    @property
    def source(self) -> str | None:
        return self.temp_source

    @classmethod
    def load(cls, data_dir: Path) -> "Terrain":
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
            tmin = _bilinear(self.temps["tmin_k"], lat, lon)
            tmax = _bilinear(self.temps["tmax_k"], lat, lon)
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
