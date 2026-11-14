"""Real lunar elevation from NASA's LRO LOLA instrument, at two levels.

Both levels are *height sources* (the interface api/patch.py uses):

    heights(lat_deg, lon_deg) -> metres above the 1737.4 km reference sphere
    source: str          # cited in the UI
    resolution_m: float  # pixel size, used e.g. as the slope baseline

1. Global estimate: `LolaGlobalHeights` memory-maps LDEM_128 (128 px/deg, ~237 m;
   LDEM_64 also works), downloaded once by scripts/fetch_lola.py into
   ~/LunarPlannerData/lola (see api/paths.py). Instant for any point on the Moon.

2. Detailed: `fetch_detail_patch()` pulls ~30 m LOLA data for a 30 x 30 km area
   around a site straight from NASA's archive, using HTTP range requests so only
   the few MB needed are transferred (the source files are 0.5-2 GB). Results are
   cached in ~/LunarPlannerData/lola_detail/. `DetailedHeights` then uses that patch near the
   site and the global grid everywhere else (e.g. for distant mountains).
   - |lat| <= 76: LDEM_1024 simple-cylindrical tiles (15 x 30 degree tiles, ~30 m)
   - |lat| >  76: LDEM_75S_30M / LDEM_75N_30M polar stereographic (30 m)

All LOLA LDEM files store 16-bit little-endian integers; height = DN * 0.5 m.
Source: PDS Geosciences Node, LRO LOLA Gridded Data Records.
"""

from __future__ import annotations

import logging
import re
import threading
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import numpy as np

log = logging.getLogger(__name__)

MOON_R_M = 1_737_400.0
PDS_GDR = "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/"
SCALE_M = 0.5                      # metres per DN in every LOLA LDEM product
DETAIL_HALF_M = 15_000.0           # detailed patch covers +-15 km around the site
DETAIL_SPACING_M = 30.0
POLAR_SWITCH_DEG = 76.0
RANGES_PER_REQUEST = 100           # Apache allows up to 200 ranges per request
USER_AGENT = "lunar-planner-hackathon"


# ---- Level 1: global grid -----------------------------------------------------------

class LolaGlobalHeights:
    """A global LOLA LDEM (simple cylindrical, 0-360 E, 90N at row 0), memory-mapped from disk."""

    GRIDS = (128, 64)   # preferred first: LDEM_128 (~237 m, 2.1 GB), then LDEM_64 (~474 m, 531 MB)

    def __init__(self, img_path: Path, lines: int = 11520, samples: int = 23040, ppd: float = 64.0):
        self.dn = np.memmap(img_path, dtype="<i2", mode="r", shape=(lines, samples))
        self.ppd = ppd
        self.resolution_m = 2 * np.pi * MOON_R_M / 360.0 / ppd
        name = f"LDEM_{int(ppd)}" if ppd in self.GRIDS else "LDEM"
        self.source = (f"NASA LRO LOLA {name} global elevation (~{self.resolution_m:.0f} m/pixel), "
                       "PDS Geosciences Node")

    @classmethod
    def load(cls, *dirs: Path) -> "LolaGlobalHeights | None":
        """The sharpest complete LDEM found in the given folders (searched in order)."""
        for ppd in cls.GRIDS:
            lines, samples = 180 * ppd, 360 * ppd
            for d in dirs:
                path = d / f"ldem_{ppd}.img"
                if path.exists() and path.stat().st_size == lines * samples * 2:
                    return cls(path, lines, samples, float(ppd))
        return None

    def heights(self, lat_deg, lon_deg) -> np.ndarray:
        lat = np.asarray(lat_deg, dtype=float)
        lon = np.asarray(lon_deg, dtype=float)
        row = (90.0 - lat) * self.ppd - 0.5
        col = (lon % 360.0) * self.ppd - 0.5
        return _bilinear(self.dn, row, col, wrap_cols=True) * SCALE_M


# ---- Level 2: detailed patches ------------------------------------------------------

@dataclass
class DetailPatch:
    center_lat: float
    center_lon: float
    half_m: float
    spacing_m: float
    grid: np.ndarray          # (n, n) float32 metres; row 0 = north edge, col 0 = west edge
    product: str

    def save(self, path: Path) -> None:
        np.savez_compressed(
            path, grid=self.grid,
            meta=np.array([self.center_lat, self.center_lon, self.half_m, self.spacing_m]),
            product=np.array(self.product),
        )

    @classmethod
    def open(cls, path: Path) -> "DetailPatch":
        z = np.load(path)
        lat, lon, half, spacing = z["meta"]
        return cls(float(lat), float(lon), float(half), float(spacing), z["grid"], str(z["product"]))


class DetailedHeights:
    """A detailed LOLA patch near the site, falling back to a coarser source elsewhere."""

    def __init__(self, base, patch: DetailPatch):
        self.base = base
        self.patch = patch
        self.resolution_m = patch.spacing_m
        self.source = (
            f"NASA LRO LOLA {patch.product} (~{patch.spacing_m:.0f} m) within "
            f"{patch.half_m / 1000:.0f} km of the site; {base.source} beyond"
        )

    def heights(self, lat_deg, lon_deg) -> np.ndarray:
        lat, lon = np.broadcast_arrays(np.asarray(lat_deg, float), np.asarray(lon_deg, float))
        h = np.array(self.base.heights(lat, lon), dtype=float, copy=True)
        p = self.patch
        e, n = local_en(p.center_lat, p.center_lon, lat, lon)
        inside = (np.abs(e) < p.half_m) & (np.abs(n) < p.half_m)
        if np.any(inside):
            col = (e[inside] + p.half_m) / p.spacing_m
            row = (p.half_m - n[inside]) / p.spacing_m
            h[inside] = _bilinear(p.grid, row, col)
        return h


class DetailStore:
    """Fetches detailed patches on demand and caches them on disk (one per site)."""

    def __init__(self, cache_dir: Path, fetcher=None):
        self.cache_dir = cache_dir
        self.fetcher = fetcher or fetch_detail_patch
        self._locks: dict[str, threading.Lock] = {}
        self._mem: dict[str, DetailPatch] = {}
        self._guard = threading.Lock()

    @staticmethod
    def key(lat: float, lon: float) -> str:
        return f"{lat:+.4f}_{lon:+.4f}"

    def cached(self, lat: float, lon: float) -> DetailPatch | None:
        k = self.key(lat, lon)
        if k in self._mem:
            return self._mem[k]
        path = self.cache_dir / f"{k}.npz"
        if path.exists():
            self._mem[k] = DetailPatch.open(path)
            return self._mem[k]
        return None

    def get(self, lat: float, lon: float) -> tuple[DetailPatch, bool]:
        """Return (patch, was_cached). Downloads if needed (a few seconds)."""
        k = self.key(lat, lon)
        with self._guard:
            lock = self._locks.setdefault(k, threading.Lock())
        with lock:                              # don't fetch the same site twice at once
            hit = self.cached(lat, lon)
            if hit is not None:
                return hit, True
            patch = self.fetcher(lat, lon)
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            patch.save(self.cache_dir / f"{k}.npz")
            self._mem[k] = patch
            return patch, False


def fetch_detail_patch(lat: float, lon: float, half_m: float = DETAIL_HALF_M,
                       spacing_m: float = DETAIL_SPACING_M) -> DetailPatch:
    """Build a local north-up grid of real LOLA heights around (lat, lon) from NASA's archive."""
    t0 = time.time()
    n = int(round(2 * half_m / spacing_m)) + 1
    axis = np.linspace(-half_m, half_m, n)
    e, nn = np.meshgrid(axis, axis[::-1])                       # row 0 = north
    plat, plon = destination(lat, lon, np.degrees(np.arctan2(e, nn)), np.hypot(e, nn))
    if abs(lat) > POLAR_SWITCH_DEG:
        grid, product = _sample_polar(lat, plat, plon)
    else:
        grid, product = _sample_cylindrical(lon, plat, plon)
    log.info("Fetched detailed LOLA %s for (%.4f, %.4f) in %.1f s", product, lat, lon, time.time() - t0)
    return DetailPatch(lat, lon, half_m, spacing_m, grid.astype(np.float32), product)


# -- cylindrical LDEM_1024 tiles --

CYL_PPD = 1024
CYL_COLS = 360 * CYL_PPD
CYL_TILE_LAT, CYL_TILE_LON = 15, 30


def cyl_tile_name(south: int, west: int) -> str:
    north = south + CYL_TILE_LAT
    hemi = "n" if south >= 0 else "s"
    lat_part = f"{abs(south):02d}{hemi}_{abs(north):02d}{hemi}" if hemi == "n" else f"{abs(south):02d}s_{abs(north):02d}s"
    return f"ldem_1024_{lat_part}_{west:03d}_{west + CYL_TILE_LON:03d}.img"


def _sample_cylindrical(center_lon: float, plat: np.ndarray, plon: np.ndarray) -> tuple[np.ndarray, str]:
    # Continuous global pixel coordinates (pixel centres on integers), longitude unwrapped
    # around the site so the window never straddles the 0/360 seam awkwardly.
    c360 = center_lon % 360.0
    lon_unwrapped = ((plon % 360.0) - c360 + 180.0) % 360.0 - 180.0 + c360
    row_g = (90.0 - plat) * CYL_PPD - 0.5
    col_g = lon_unwrapped * CYL_PPD - 0.5
    r0, r1 = int(np.floor(row_g.min())) - 1, int(np.ceil(row_g.max())) + 1
    c0, c1 = int(np.floor(col_g.min())) - 1, int(np.ceil(col_g.max())) + 1
    r0, r1 = max(r0, 0), min(r1, 180 * CYL_PPD - 1)
    window = np.zeros((r1 - r0 + 1, c1 - c0 + 1), dtype=np.int16)

    jobs = []   # (url, record_bytes, tile_rows, tile_cols, window_rows, window_cols)
    for tile_r_start in range((r0 // (CYL_TILE_LAT * CYL_PPD)) * CYL_TILE_LAT * CYL_PPD, r1 + 1, CYL_TILE_LAT * CYL_PPD):
        north = 90 - tile_r_start // CYL_PPD
        south = north - CYL_TILE_LAT
        tr0 = max(r0, tile_r_start) - tile_r_start
        tr1 = min(r1, tile_r_start + CYL_TILE_LAT * CYL_PPD - 1) - tile_r_start
        col = c0
        while col <= c1:                                       # split columns by tile (and seam)
            gcol = col % CYL_COLS
            west = (gcol // (CYL_TILE_LON * CYL_PPD)) * CYL_TILE_LON
            tile_c_start = west * CYL_PPD
            seg_end = min(c1, col + (tile_c_start + CYL_TILE_LON * CYL_PPD - 1 - gcol))
            tc0 = gcol - tile_c_start
            tc1 = tc0 + (seg_end - col)
            url = PDS_GDR + "cylindrical/img/" + cyl_tile_name(south, west)
            jobs.append((url, CYL_TILE_LON * CYL_PPD * 2, (tr0, tr1), (tc0, tc1),
                         (tile_r_start + tr0 - r0, tile_r_start + tr1 - r0), (col - c0, seg_end - c0)))
            col = seg_end + 1

    for url, rec, (tr0, tr1), (tc0, tc1), (wr0, wr1), (wc0, wc1) in jobs:
        window[wr0:wr1 + 1, wc0:wc1 + 1] = read_window(url, rec, tr0, tr1, tc0, tc1)

    grid = _bilinear(window, row_g - r0, col_g - c0) * SCALE_M
    return grid, "LDEM_1024 tiles"


# -- polar stereographic LDEM_75S_30M / LDEM_75N_30M --

POLAR_N = 30496
POLAR_SCALE_M = 30.0
POLAR_OFFSET = 15247.5


def polar_pixel(lat, lon, south: bool):
    """(line, sample) in the LOLA polar stereographic grids (0-based, continuous)."""
    la, lo = np.radians(lat), np.radians(lon)
    rho = 2 * MOON_R_M * np.tan(np.pi / 4 - np.abs(la) / 2)
    x = rho * np.sin(lo)
    y = rho * np.cos(lo) * (1 if south else -1)
    return POLAR_OFFSET - y / POLAR_SCALE_M, POLAR_OFFSET + x / POLAR_SCALE_M


def _sample_polar(center_lat: float, plat: np.ndarray, plon: np.ndarray) -> tuple[np.ndarray, str]:
    south = center_lat < 0
    name = "ldem_75s_30m.img" if south else "ldem_75n_30m.img"
    line, samp = polar_pixel(plat, plon, south)
    r0, r1 = max(int(np.floor(line.min())) - 1, 0), min(int(np.ceil(line.max())) + 1, POLAR_N - 1)
    c0, c1 = max(int(np.floor(samp.min())) - 1, 0), min(int(np.ceil(samp.max())) + 1, POLAR_N - 1)
    window = read_window(PDS_GDR + "polar/img/" + name, POLAR_N * 2, r0, r1, c0, c1)
    grid = _bilinear(window, line - r0, samp - c0) * SCALE_M
    return grid, name.replace(".img", "").upper()


# -- HTTP range reading --

def read_window(url: str, record_bytes: int, r0: int, r1: int, c0: int, c1: int) -> np.ndarray:
    """Rows r0..r1, columns c0..c1 (inclusive) of a headerless int16 image, via range requests."""
    ranges = [(r * record_bytes + c0 * 2, r * record_bytes + c1 * 2 + 1) for r in range(r0, r1 + 1)]
    chunks = [ranges[i:i + RANGES_PER_REQUEST] for i in range(0, len(ranges), RANGES_PER_REQUEST)]
    with ThreadPoolExecutor(max_workers=4) as pool:
        parts = [p for got in pool.map(lambda ch: fetch_ranges(url, ch), chunks) for p in got]
    out = np.empty((r1 - r0 + 1, c1 - c0 + 1), dtype="<i2")
    for i, (a, b) in enumerate(ranges):
        out[i] = np.frombuffer(_extract(parts, a, b), dtype="<i2")
    return out


def fetch_ranges(url: str, ranges: list[tuple[int, int]], retries: int = 3) -> list[tuple[int, bytes]]:
    """GET several byte ranges in one request. Returns [(start_offset, bytes)]."""
    header = "bytes=" + ",".join(f"{a}-{b}" for a, b in ranges)
    req = urllib.request.Request(url, headers={"Range": header, "User-Agent": USER_AGENT})
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                if resp.status != 206:
                    raise RuntimeError(f"server ignored the Range header (HTTP {resp.status})")
                ctype = resp.headers.get("Content-Type", "")
                body = resp.read()
                if "multipart/byteranges" in ctype:
                    return parse_multipart_byteranges(body, ctype)
                start = int(re.search(r"bytes (\d+)-", resp.headers["Content-Range"]).group(1))
                return [(start, body)]
        except Exception:
            if attempt == retries - 1:
                raise
            time.sleep(1.5 * (attempt + 1))
    raise AssertionError("unreachable")


def parse_multipart_byteranges(body: bytes, content_type: str) -> list[tuple[int, bytes]]:
    boundary = re.search(r"boundary=\"?([^\";]+)\"?", content_type).group(1).encode()
    delim = b"--" + boundary
    parts, pos = [], 0
    while True:
        pos = body.find(delim, pos)
        if pos < 0 or body[pos + len(delim):pos + len(delim) + 2] == b"--":
            return parts
        hdr_end = body.find(b"\r\n\r\n", pos)
        headers = body[pos:hdr_end].decode("latin-1")
        a, b = map(int, re.search(r"bytes (\d+)-(\d+)", headers, re.I).groups())
        start = hdr_end + 4
        parts.append((a, body[start:start + (b - a + 1)]))
        pos = start + (b - a + 1)


def _extract(parts: list[tuple[int, bytes]], a: int, b: int) -> bytes:
    for start, data in parts:          # the server may merge neighbouring ranges into one part
        if start <= a and b < start + len(data):
            return data[a - start:b - start + 1]
    raise RuntimeError(f"byte range {a}-{b} missing from server response")


# ---- Geometry helpers --------------------------------------------------------------------

def destination(lat_deg, lon_deg, bearing_deg, dist_m):
    """Great-circle destination from a start point, bearing (from north) and distance."""
    la1, lo1 = np.radians(lat_deg), np.radians(lon_deg)
    b = np.radians(bearing_deg)
    d = np.asarray(dist_m) / MOON_R_M
    la2 = np.arcsin(np.sin(la1) * np.cos(d) + np.cos(la1) * np.sin(d) * np.cos(b))
    lo2 = lo1 + np.arctan2(np.sin(b) * np.sin(d) * np.cos(la1), np.cos(d) - np.sin(la1) * np.sin(la2))
    return np.degrees(la2), (np.degrees(lo2) + 180.0) % 360.0 - 180.0


def local_en(lat0, lon0, lat, lon):
    """East/north metres of (lat, lon) from (lat0, lon0): the inverse of `destination`."""
    la1, lo1 = np.radians(lat0), np.radians(lon0)
    la2, lo2 = np.radians(lat), np.radians(lon)
    dlo = lo2 - lo1
    cosc = np.clip(np.sin(la1) * np.sin(la2) + np.cos(la1) * np.cos(la2) * np.cos(dlo), -1, 1)
    d = np.arccos(cosc) * MOON_R_M
    b = np.arctan2(np.sin(dlo) * np.cos(la2), np.cos(la1) * np.sin(la2) - np.sin(la1) * np.cos(la2) * np.cos(dlo))
    return d * np.sin(b), d * np.cos(b)


def _bilinear(grid: np.ndarray, row, col, wrap_cols: bool = False) -> np.ndarray:
    row = np.asarray(row, dtype=float)
    col = np.asarray(col, dtype=float)
    nr, nc = grid.shape
    row = np.clip(row, 0, nr - 1)
    r0 = np.minimum(np.floor(row).astype(int), nr - 2)
    fr = row - r0
    if wrap_cols:
        c0f = np.floor(col)
        fc = col - c0f
        c0 = c0f.astype(int) % nc
        c1 = (c0 + 1) % nc
    else:
        col = np.clip(col, 0, nc - 1)
        c0 = np.minimum(np.floor(col).astype(int), nc - 2)
        fc = col - c0
        c1 = c0 + 1
    g = lambda r, c: np.asarray(grid[r, c], dtype=float)  # noqa: E731
    return (g(r0, c0) * (1 - fr) * (1 - fc) + g(r0, c1) * (1 - fr) * fc
            + g(r0 + 1, c0) * fr * (1 - fc) + g(r0 + 1, c1) * fr * fc)
