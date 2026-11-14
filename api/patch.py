"""Local terrain around a landing site, for the 3D view and horizon profiles.

Two products, both built from a *height source*: any object with

    heights(lat_deg: np.ndarray, lon_deg: np.ndarray) -> np.ndarray   # metres vs 1737.4 km sphere
    source: str                                                       # cited in the UI

- `terrain_patch()`: an n×n grid of heights on a local flat (tangent-plane) grid
  centred on the site. Row 0 is the north edge, column 0 the west edge.
- `horizon_profile()`: the skyline elevation angle in every direction (1° steps,
  clockwise from north, the same convention as Horizons), including the Moon's
  curvature. If the Sun's elevation is below the skyline at its azimuth, the
  site is in terrain shadow.

PLACEHOLDER: `SyntheticHeights` is made-up rolling terrain so the 3D view works
before real data exists. To use real LOLA data, write a class with the same two
members that samples the DEM (bilinear), and pass it in from api/main.py.
"""

from __future__ import annotations

from functools import lru_cache

import numpy as np

MOON_R_M = 1_737_400.0
OBSERVER_HEIGHT_M = 2.0  # roughly a lander's camera/solar-array height


# ---- Height sources --------------------------------------------------------------

class SyntheticHeights:
    """Smooth made-up terrain defined everywhere on the sphere (PLACEHOLDER)."""

    source = "PLACEHOLDER terrain: synthetic heights (LOLA LDEM_64 not downloaded; run scripts/fetch_lola.py)"
    resolution_m = 100.0

    def __init__(self, seed: int = 7, waves: int = 48):
        rng = np.random.default_rng(seed)
        wavelengths = np.geomspace(1_500.0, 120_000.0, waves)                 # metres
        dirs = rng.normal(size=(waves, 3))
        dirs /= np.linalg.norm(dirs, axis=1, keepdims=True)
        self.k = dirs * (2 * np.pi / wavelengths)[:, None]                    # wave vectors
        self.amp = 150.0 * (wavelengths / wavelengths.max()) ** 0.7           # bigger hills, longer waves
        self.phase = rng.uniform(0, 2 * np.pi, waves)

    def heights(self, lat_deg: np.ndarray, lon_deg: np.ndarray) -> np.ndarray:
        p = MOON_R_M * _unit(lat_deg, lon_deg)                                # (..., 3) metres
        return np.sin(p @ self.k.T + self.phase) @ self.amp


# ---- Products ----------------------------------------------------------------------

def terrain_patch(source, lat: float, lon: float, size_m: float = 20_000.0, n: int = 256) -> dict:
    """Heights on an n×n local grid centred on (lat, lon). See module docstring."""
    half = size_m / 2
    east = np.linspace(-half, half, n)
    north = np.linspace(half, -half, n)                                       # row 0 = north edge
    e, nn = np.meshgrid(east, north)
    plat, plon = destination(lat, lon, np.degrees(np.arctan2(e, nn)), np.hypot(e, nn))
    h = source.heights(plat, plon)
    center = float(source.heights(np.array(lat), np.array(lon)))
    return {
        "center_lat": lat,
        "center_lon": lon,
        "size_m": size_m,
        "n": n,
        "spacing_m": size_m / (n - 1),
        "projection": "local-tangent",   # flat grid; curvature NOT removed (the client applies it)
        "center_height_m": round(center, 1),
        "heights": [None if np.isnan(v) else round(float(v), 1) for v in h.ravel()],
        "source": source.source,
    }


def horizon_profile(source, lat: float, lon: float, radius_m: float = 150_000.0,
                    az_step_deg: float = 1.0, samples: int = 300) -> dict:
    """Skyline elevation angle per azimuth, accounting for terrain and curvature."""
    return _horizon_cached(source, round(lat, 4), round(lon, 4), radius_m, az_step_deg, samples)


@lru_cache(maxsize=256)
def _horizon_cached(source, lat, lon, radius_m, az_step_deg, samples) -> dict:
    az = np.arange(0.0, 360.0, az_step_deg)
    r = np.geomspace(30.0, radius_m, samples)                                 # dense near the site
    AZ, R = np.meshgrid(az, r, indexing="ij")
    plat, plon = destination(lat, lon, AZ, R)
    h = source.heights(plat, plon)
    h0 = float(source.heights(np.array(lat), np.array(lon))) + OBSERVER_HEIGHT_M
    drop = R ** 2 / (2 * MOON_R_M)                                            # curvature
    elev = np.degrees(np.arctan2(h - h0 - drop, R))
    skyline = np.nanmax(elev, axis=1)
    return {
        "azimuth_step_deg": az_step_deg,
        "elevation_deg": [round(float(v), 2) for v in skyline],
        "radius_m": radius_m,
        "observer_height_m": OBSERVER_HEIGHT_M,
        "source": source.source,
    }


# ---- Geometry ----------------------------------------------------------------------

def destination(lat_deg, lon_deg, bearing_deg, dist_m):
    """Great-circle destination from a start point, bearing (from north) and distance."""
    la1, lo1 = np.radians(lat_deg), np.radians(lon_deg)
    b = np.radians(bearing_deg)
    d = np.asarray(dist_m) / MOON_R_M
    la2 = np.arcsin(np.sin(la1) * np.cos(d) + np.cos(la1) * np.sin(d) * np.cos(b))
    lo2 = lo1 + np.arctan2(np.sin(b) * np.sin(d) * np.cos(la1), np.cos(d) - np.sin(la1) * np.sin(la2))
    lon = (np.degrees(lo2) + 180.0) % 360.0 - 180.0
    return np.degrees(la2), lon


def _unit(lat_deg, lon_deg) -> np.ndarray:
    lat, lon = np.radians(lat_deg), np.radians(lon_deg)
    return np.stack([np.cos(lat) * np.cos(lon), np.cos(lat) * np.sin(lon), np.sin(lat)], axis=-1)
