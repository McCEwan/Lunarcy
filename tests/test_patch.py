import numpy as np
import pytest
from fastapi.testclient import TestClient

from api.main import app
from api.patch import MOON_R_M, OBSERVER_HEIGHT_M, SyntheticHeights, destination, horizon_profile, terrain_patch

client = TestClient(app)


class Flat:
    source = "flat test terrain"

    def heights(self, lat, lon):
        return np.zeros(np.broadcast(lat, lon).shape)


class RidgeToTheEast:
    """A 2 km-high wall 10–12 km east of (0, 0); flat elsewhere."""
    source = "ridge test terrain"

    def heights(self, lat, lon):
        lat, lon = np.broadcast_arrays(np.asarray(lat, float), np.asarray(lon, float))
        east_m = np.radians(lon) * MOON_R_M
        wall = (east_m > 10_000) & (east_m < 12_000) & (np.abs(lat) < 2)
        return np.where(wall, 2_000.0, 0.0)


def test_destination_round_trip():
    lat, lon = destination(0.0, 0.0, 90.0, 30_323.0)  # ~1° east along the equator
    assert lat == pytest.approx(0.0, abs=1e-9) and lon == pytest.approx(1.0, abs=1e-3)


def test_flat_horizon_is_just_below_zero():
    # From 2 m up on a smooth sphere the horizon dips by sqrt(2h/R) ≈ 0.08°.
    prof = horizon_profile(Flat(), 0.0, 0.0)
    el = np.array(prof["elevation_deg"])
    assert len(el) == 360
    expected = -np.degrees(np.sqrt(2 * OBSERVER_HEIGHT_M / MOON_R_M))
    assert np.all(np.abs(el - expected) < 0.05)


def test_ridge_raises_the_eastern_horizon_only():
    el = np.array(horizon_profile(RidgeToTheEast(), 0.0, 0.0)["elevation_deg"])
    # atan(2000 m / 10 km) ≈ 11°
    assert 9 < el[90] < 12
    assert el[270] < 0.1 and el[0] < 0.1 and el[180] < 0.1


def test_patch_orientation_rows_north_columns_east():
    p = terrain_patch(RidgeToTheEast(), 0.0, 0.0, size_m=30_000, n=31)   # 1 km spacing
    h = np.array(p["heights"]).reshape(31, 31)
    # The wall sits 10-12 km east, i.e. columns 25-27 (centre column is 15).
    assert h[15, 26] == 2000.0 and h[15, 4] == 0.0
    assert p["spacing_m"] == pytest.approx(1000.0)


def test_synthetic_heights_are_smooth_and_bounded():
    s = SyntheticHeights()
    lat, lon = destination(-80.13, 1.44, 45.0, np.linspace(0, 2_000, 50))
    h = s.heights(lat, lon)
    assert np.all(np.abs(h) < 10_000)
    assert np.max(np.abs(np.diff(h))) < 200          # no cliffs between 40 m steps


def test_patch_endpoint():
    r = client.get("/terrain/patch", params={"lat": -80.13, "lon": 1.44, "size_km": 10, "n": 64})
    assert r.status_code == 200
    body = r.json()
    assert len(body["heights"]) == 64 * 64 and "PLACEHOLDER" in body["source"]


def test_horizon_endpoint():
    r = client.get("/terrain/horizon", params={"lat": -80.13, "lon": 1.44})
    assert r.status_code == 200 and len(r.json()["elevation_deg"]) == 360


def test_patch_rejects_bad_lat():
    assert client.get("/terrain/patch", params={"lat": 95, "lon": 0}).status_code == 422
