import base64
from datetime import date

import numpy as np
import pytest
from fastapi.testclient import TestClient

from api import ephemeris, finder
from api.ephemeris import AnalyticEphemeris
from api.main import app
from api.patch import SyntheticHeights

EPHEM = AnalyticEphemeris()
client = TestClient(app)


def sub_for(days, start=date(2027, 3, 1)):
    return EPHEM.subpoint_series(ephemeris.time_grid(start, days, 1))


def test_label_regions_wraps_longitude():
    m = np.zeros((4, 8), bool)
    m[1, 0] = m[1, 7] = True            # neighbours across the ±180° seam
    m[3, 3] = True
    labels, n = finder.label_regions(m)
    assert n == 2 and labels[1, 0] == labels[1, 7] != labels[3, 3]


def test_screen_basic_geometry():
    s, E = finder.sky_vectors(sub_for(29))
    sun, earth, watts = finder.screen_cells(np.array([0.0, 0.0]), np.array([0.0, 180.0]), s, E)
    assert earth[0] == 100.0 and earth[1] == 0.0                 # near side vs far side
    assert 40 < sun[0] < 60 and 40 < sun[1] < 60                 # about half a lunar day each
    assert 200 < watts[0] < 500                                  # mean of 1361·sin(el) over day and night


def test_skyline_wall_blocks_sun_and_earth():
    s, E = finder.sky_vectors(sub_for(29))
    naz = int(360 / finder.SKY_AZ_STEP)
    wall = np.full((1, naz), 60.0, np.float32)
    sun, earth, watts = finder.screen_cells(np.array([0.0]), np.array([60.0]), s, E, wall)
    open_sun, open_earth, _ = finder.screen_cells(np.array([0.0]), np.array([60.0]), s, E)
    assert sun[0] < open_sun[0] and earth[0] == 0.0 < open_earth[0]


def test_compute_skylines_flat_is_near_zero():
    class Flat:
        source = "flat"

        def heights(self, lat, lon):
            return np.zeros(np.broadcast(np.asarray(lat), np.asarray(lon)).shape)
    sk = finder.compute_skylines(Flat(), np.array([10.0, -80.0]), np.array([20.0, 5.0]), samples=40)
    assert sk.shape == (2, 90) and np.all(np.abs(sk) < 0.2)


def test_find_regions_end_to_end_on_a_coarse_grid():
    crit = finder.Criteria(date(2027, 3, 1), date(2027, 3, 14), min_sun_pct=40, min_earth_pct=80,
                           min_avg_w_m2=50, max_slope_deg=30, region="nearside")
    out = finder.find_regions(crit, EPHEM, SyntheticHeights(), None, res=4.0)
    g = out["grid"]
    classes = np.frombuffer(base64.b64decode(g["classes_b64"]), np.uint8).reshape(g["nlat"], g["nlon"])
    assert classes.shape == (45, 90)
    assert out["counts"]["meeting_cells"] == int((classes == 2).sum()) > 0
    lons = np.arange(-180 + 2, 180, 4.0)
    assert np.all(classes[:, np.abs(lons) > 90] == 255)          # far side excluded by the region
    for r in out["regions"]:
        assert abs(r["lon"]) <= 90 and r["terrain_checked"]
        if r["passes_with_terrain"]:
            assert r["sun_pct"] >= 40 and r["earth_pct"] >= 80 and r["avg_w_m2"] >= 50


def test_impossible_requirements_find_nothing():
    crit = finder.Criteria(date(2027, 3, 1), date(2027, 3, 31), min_sun_pct=99, min_earth_pct=99)
    out = finder.find_regions(crit, EPHEM, SyntheticHeights(), None, res=4.0)
    assert out["counts"]["meeting_cells"] == 0 and out["regions"] == []


@pytest.mark.parametrize("bad", [
    {"period_start": "2027-03-10", "period_end": "2027-03-01"},
    {"period_start": "2027-03-01", "period_end": "2027-03-10", "region": "mars"},
    {"period_start": "2027-03-01", "period_end": "2027-03-10", "min_sun_pct": 150},
])
def test_find_validation(bad):
    assert client.post("/find", json=bad).status_code == 422
