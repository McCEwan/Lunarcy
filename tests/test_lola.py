import os
from pathlib import Path

import numpy as np
import pytest

from api import lola
from api.lola import (
    DetailedHeights, DetailPatch, DetailStore, LolaGlobalHeights, cyl_tile_name, destination,
    local_en, parse_multipart_byteranges, polar_pixel,
)

DATA = Path(__file__).parent.parent / "data"


def tiny_global(tmp_path, ppd=1):
    """A fake LDEM: height (DN*0.5 m) = 100 * longitude-column index, so it varies east-west."""
    lines, samples = 180 * ppd, 360 * ppd
    dn = (np.arange(samples)[None, :] * 200 + np.zeros((lines, 1))).astype("<i2")
    path = tmp_path / "fake.img"
    dn.tofile(path)
    return LolaGlobalHeights(path, lines=lines, samples=samples, ppd=ppd)


def test_global_reader_bilinear_and_wrap(tmp_path):
    g = tiny_global(tmp_path)
    # column c is centred on longitude c + 0.5 (degrees east, 0-360)
    assert g.heights(0.0, 10.5) == pytest.approx(1000.0)
    assert g.heights(0.0, 11.0) == pytest.approx(1050.0)            # halfway between columns
    assert g.heights(0.0, -349.5) == pytest.approx(1000.0)          # -349.5 == 10.5 E
    assert g.heights(0.0, 359.9) == pytest.approx(g.heights(0.0, -0.1))


def test_cylindrical_tile_names_match_pds():
    assert cyl_tile_name(0, 0) == "ldem_1024_00n_15n_000_030.img"
    assert cyl_tile_name(-15, 330) == "ldem_1024_15s_00s_330_360.img"
    assert cyl_tile_name(-90, 120) == "ldem_1024_90s_75s_120_150.img"
    assert cyl_tile_name(75, 30) == "ldem_1024_75n_90n_030_060.img"


def test_polar_pixel_orientation():
    line, samp = polar_pixel(-90.0, 0.0, south=True)
    assert (line, samp) == (pytest.approx(lola.POLAR_OFFSET), pytest.approx(lola.POLAR_OFFSET))
    # South polar map: longitude 0 points to the top (smaller line), 90 E to the right.
    line0, samp0 = polar_pixel(-85.0, 0.0, south=True)
    line90, samp90 = polar_pixel(-85.0, 90.0, south=True)
    assert line0 < lola.POLAR_OFFSET and samp0 == pytest.approx(lola.POLAR_OFFSET)
    assert samp90 > lola.POLAR_OFFSET and line90 == pytest.approx(lola.POLAR_OFFSET)


def test_local_en_inverts_destination():
    lat, lon = destination(-80.0, 1.0, 30.0, 12_000.0)
    e, n = local_en(-80.0, 1.0, lat, lon)
    assert e == pytest.approx(12_000 * np.sin(np.radians(30)), abs=0.5)
    assert n == pytest.approx(12_000 * np.cos(np.radians(30)), abs=0.5)


def test_multipart_parser_handles_merged_ranges():
    ctype = "multipart/byteranges; boundary=XYZ"
    body = (b"\r\n--XYZ\r\nContent-Type: application/octet-stream\r\nContent-Range: bytes 0-3/100\r\n\r\n"
            b"ABCD\r\n--XYZ\r\nContent-Range: bytes 10-11/100\r\n\r\nEF\r\n--XYZ--\r\n")
    parts = parse_multipart_byteranges(body, ctype)
    assert parts == [(0, b"ABCD"), (10, b"EF")]
    assert lola._extract(parts, 1, 2) == b"BC"         # a range inside a merged part


def flat_patch(lat, lon, height=500.0):
    grid = np.full((11, 11), height, dtype=np.float32)
    return DetailPatch(lat, lon, half_m=1000.0, spacing_m=200.0, grid=grid, product="TEST")


def test_detailed_heights_uses_patch_near_site_and_base_beyond(tmp_path):
    base = tiny_global(tmp_path)
    det = DetailedHeights(base, flat_patch(0.0, 10.5))
    near = destination(0.0, 10.5, 45.0, 500.0)
    far = destination(0.0, 10.5, 90.0, 5_000.0)
    assert det.heights(*near) == pytest.approx(500.0)
    assert det.heights(*far) == pytest.approx(base.heights(*far))
    assert "TEST" in det.source and det.resolution_m == 200.0


def test_detail_store_fetches_once_then_caches(tmp_path):
    calls = []

    def fake_fetch(lat, lon):
        calls.append((lat, lon))
        return flat_patch(lat, lon)

    store = DetailStore(tmp_path, fetcher=fake_fetch)
    p1, cached1 = store.get(-80.13, 1.44)
    p2, cached2 = DetailStore(tmp_path, fetcher=fake_fetch).get(-80.13, 1.44)   # fresh store: from disk
    assert (cached1, cached2) == (False, True) and len(calls) == 1
    assert np.array_equal(p1.grid, p2.grid)


@pytest.mark.skipif(not (DATA / "lola" / "ldem_64.img").exists(), reason="run scripts/fetch_lola.py")
def test_real_ldem64_matches_published_im1_elevation():
    # NASA's LRO release puts Odysseus (IM-1) at about 2,579 m; one LDEM_64 pixel is ~474 m.
    g = LolaGlobalHeights.load(DATA)
    assert g.heights(-80.13, 1.44) == pytest.approx(2579, abs=80)
    assert g.heights(0.6741, 23.473) == pytest.approx(-1925, abs=80)     # Apollo 11


@pytest.mark.skipif(not os.environ.get("RUN_LIVE"), reason="set RUN_LIVE=1 to download from NASA PDS")
def test_live_polar_and_cylindrical_products_agree(monkeypatch):
    polar = lola.fetch_detail_patch(-80.13, 1.44, half_m=3000)
    monkeypatch.setattr(lola, "POLAR_SWITCH_DEG", 99.0)
    cyl = lola.fetch_detail_patch(-80.13, 1.44, half_m=3000)
    assert polar.product.startswith("LDEM_75S") and cyl.product == "LDEM_1024 tiles"
    assert np.corrcoef(polar.grid.ravel(), cyl.grid.ravel())[0, 1] > 0.99
    assert abs(float(np.mean(polar.grid - cyl.grid))) < 20
