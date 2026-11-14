import numpy as np
import pytest

from api.terrain import Terrain, _cell_bilinear


def test_cell_bilinear_centres_and_wrap():
    g = np.zeros((360, 720), np.float32)
    g[:, 0] = 100.0                       # first column of cells: 180W..179.5W, centre 179.75W
    assert _cell_bilinear(g, 0.25, -179.75) == pytest.approx(100.0)
    # Halfway across the ±180° seam: between the last column (179.75E, 0) and the first (100).
    assert _cell_bilinear(g, 0.25, 180.0) == pytest.approx(50.0)
    assert _cell_bilinear(g, 0.25, -180.0) == pytest.approx(50.0)


def test_cell_bilinear_skips_missing_cells():
    g = np.full((360, 720), 200.0, np.float32)
    g[180, 360] = np.nan
    assert _cell_bilinear(g, 0.25, 0.25) is None                   # exactly at the empty cell's centre
    assert _cell_bilinear(g, 0.4, 0.4) == pytest.approx(200.0)     # off-centre: neighbours fill the gap
    g[:] = np.nan
    assert _cell_bilinear(g, 0.0, 0.0) is None


def test_diviner_file_is_preferred(tmp_path):
    tmin = np.full((360, 720), 90.0, np.float32)
    tmax = np.full((360, 720), 390.0, np.float32)
    np.savez(tmp_path / "div.npz", tmin_k=tmin, tmax_k=tmax, res=0.5, source="NASA LRO Diviner test")
    t = Terrain.load(tmp_path / "nothing_here", tmp_path / "div.npz")
    s = t.sample(10.0, 20.0)
    assert (s.tmin_k, s.tmax_k) == (90.0, 390.0) and t.real and "Diviner" in t.source


def test_placeholder_is_labelled_not_real(tmp_path):
    np.save(tmp_path / "tmin_k.npy", np.zeros((3, 5), np.float32))
    np.save(tmp_path / "tmax_k.npy", np.ones((3, 5), np.float32))
    (tmp_path / "meta.json").write_text('{"source": "PLACEHOLDER temperature: test"}')
    t = Terrain.load(tmp_path, tmp_path / "missing.npz")
    assert t.loaded and not t.real
