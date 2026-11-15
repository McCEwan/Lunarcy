from datetime import date

import numpy as np
from fastapi.testclient import TestClient

from api import siteplan
from api.ephemeris import AnalyticEphemeris, time_grid
from api.main import app
from api.siteplan import MOON_R_M, _dijkstra, _path, local_en, plan_site

client = TestClient(app)


def test_local_en_one_km_north_and_east():
    dlat = np.degrees(1000 / MOON_R_M)
    e, n, d = local_en(-80.0, 10.0, -80.0 + dlat, 10.0)
    assert abs(e) < 1 and abs(n - 1000) < 1 and abs(d - 1000) < 1


def test_route_goes_around_a_wall_through_its_gap():
    h = np.zeros((41, 41))
    h[:, 20] = 500.0                      # a 500 m wall down the middle...
    h[35:, 20] = 0.0                      # ...with a gap at the south end
    slope = np.zeros_like(h)
    slope[:, 19:22] = 80.0
    slope[35:, 19:22] = 0.0
    start, goal = 20 * 41 + 5, 20 * 41 + 35
    cost, prev = _dijkstra(h, 100.0, start, goal=goal, slope=slope)
    idx = _path(prev, start, goal)
    assert idx and all(i // 41 >= 35 for i in idx if i % 41 == 20)   # crosses only through the gap


def test_steep_hillside_is_impassable_even_along_the_contour():
    n, spacing = 21, 100.0
    tilt = np.tan(np.radians(25))
    h = np.tile(np.arange(n) * spacing * tilt, (n, 1))     # a uniform 25° slope rising east
    slope = np.full(h.shape, 25.0)
    cost, _ = _dijkstra(h, spacing, (n // 2) * n + n // 2, slope=slope)
    assert np.isfinite(cost).sum() == 1                    # only where the lander stands


class Basin:
    """A 400 m-resolution test terrain: flat plain with a 300 m-high ridge 3 km east."""
    source = "test basin"
    resolution_m = 400.0

    def heights(self, lat, lon):
        lat, lon = np.asarray(lat, float), np.asarray(lon, float)
        e = np.radians(lon - 0.0) * MOON_R_M * np.cos(np.radians(lat))
        return 300.0 * np.exp(-((e - 3000.0) / 1500.0) ** 2)


class FakeIce:
    def nearest_target(self, lat, lon):
        return {"lat": lat - 0.1, "lon": lon, "distance_km": 3.03, "name": "Test Crater", "rating": "known",
                "basis": "test"}

    def sources(self):
        return ["test ice"]


def test_plan_site_end_to_end():
    lat, lon = -85.0, 0.0
    sky = AnalyticEphemeris().sky(lat, lon, time_grid(date(2027, 3, 1), 29.5, 1), 0)
    p = plan_site(Basin(), lat, lon, sky, FakeIce())
    for key in ("solar", "comms"):
        s = p[key]
        assert s["slope_deg"] <= siteplan.SPOT_MAX_SLOPE_DEG
        assert np.hypot(s["east_m"], s["north_m"]) <= siteplan.SEARCH_RADIUS_M + 1
    assert 0 <= p["solar"]["sunlight_pct"] <= 100 and 0 <= p["comms"]["earth_pct"] <= 100
    r = p["route"]
    assert r is not None and r["drive_m"] >= r["straight_m"] - 1 and r["max_slope_deg"] <= 15.5
    ice = p["ice"]
    assert ice["in_view"] and 2900 < ice["distance_m"] < 3100 and abs(ice["bearing_deg"] - 180) < 1
    assert ice["route"] and ice["route"]["gap_to_ice_m"] < 500
    assert p["grid"]["rough"] and any("ROUGH" in n for n in p["notes"])
    assert any("VIPER" in s for s in p["sources"])
    tw = p["comms"]["tower"]
    pct = [c["earth_pct"] for c in tw["curve"]]
    assert all(b >= a - 0.01 for a, b in zip(pct, pct[1:]))          # a taller tower never sees less
    assert tw["realistic_m"] <= siteplan.REALISTIC_TOWER_MAX_M
    assert tw["realistic_earth_pct"] <= tw["ideal_earth_pct"] + 1.0     # the ideal is within 1 point of the best
    assert "ESTIMATE" in tw["realistic_basis"]


def test_site_plan_endpoint_validates_dates():
    r = client.get("/site/plan", params={"lat": -85, "lon": 0, "start": "2027-03-10", "end": "2027-03-01"})
    assert r.status_code == 422
