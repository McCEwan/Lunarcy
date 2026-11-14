"""Terrain grids (elevation, slope, temperature) and bilinear lookup.

Grid convention, shared with scripts/build_grids.py:
  - equirectangular, shape (n_lat, n_lon), float32, NaN marks a hole
  - row 0 is latitude -90, the last row is +90
  - column 0 is longitude -180, the last column is +180 (same meridian as column 0)
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

FIELDS = ("elevation_m", "slope_deg", "tmin_k", "tmax_k")


@dataclass(frozen=True)
class TerrainSample:
    elevation_m: float | None
    slope_deg: float | None
    tmin_k: float | None
    tmax_k: float | None


class Terrain:
    def __init__(self, grids: dict[str, np.ndarray] | None, source: str | None = None):
        self.grids = grids
        self.source = source

    @property
    def loaded(self) -> bool:
        return self.grids is not None

    @classmethod
    def load(cls, data_dir: Path) -> "Terrain":
        paths = {f: data_dir / f"{f}.npy" for f in FIELDS}
        if not all(p.exists() for p in paths.values()):
            return cls(None)
        grids = {f: np.load(p) for f, p in paths.items()}
        meta_path = data_dir / "meta.json"
        source = json.loads(meta_path.read_text())["source"] if meta_path.exists() else None
        return cls(grids, source)

    def sample(self, lat: float, lon: float) -> TerrainSample | None:
        """Bilinear lookup. Returns None if no grids are loaded."""
        if self.grids is None:
            return None
        return TerrainSample(**{f: _bilinear(self.grids[f], lat, lon) for f in FIELDS})


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
