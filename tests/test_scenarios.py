from datetime import date

import numpy as np
from fastapi.testclient import TestClient

from api.ephemeris import AnalyticEphemeris, Sky, time_grid
from api.main import app
from api.scenarios import best_dates, nearby

client = TestClient(app)


def _sky(sun_up: np.ndarray, earth_up: np.ndarray) -> Sky:
    """A fake series: bodies at 10° when 'up', -10° when not, always due north."""
    z = np.zeros(len(sun_up))
    return Sky(np.where(sun_up, 10.0, -10.0), z, np.where(earth_up, 10.0, -10.0), z, "test sky")


def test_best_dates_finds_the_sunny_stretch():
    days, mission = 20, 5
    n = (days + mission + 1) * 24
    hours = np.arange(n)
    sun = (hours >= 10 * 24) & (hours < 16 * 24)              # sunny for days 10-15 only
    earth = np.ones(n, bool)
    times = time_grid(date(2027, 1, 1), days + mission + 1, 1)
    out = best_dates(_sky(sun, earth), [0.0] * 360, times, date(2027, 1, 1), days, mission, "sun")
    best = out["best"][0]
    assert best["date"] == "2027-01-11" and best["sun_pct"] == 100.0 and best["earth_pct"] == 100.0
    assert best["sun_up_at_touchdown"] and best["hours_to_sunset"] == 6 * 24          # sunny days 10-15 inclusive
    assert len(out["daily"]) == days
    picked = [np.datetime64(b["date"]) for b in out["best"]]
    assert all(abs((a - b).astype(int)) >= 2 for i, a in enumerate(picked) for b in picked[i + 1:])


def test_best_dates_priority_changes_the_answer():
    days, mission = 10, 2
    n = (days + mission + 1) * 24
    h = np.arange(n)
    sun = h < 4 * 24                                          # Sun early in the span
    earth = h >= 6 * 24                                       # Earth late
    times = time_grid(date(2027, 1, 1), days + mission + 1, 1)
    sky = _sky(sun, earth)
    early = best_dates(sky, None, times, date(2027, 1, 1), days, mission, "sun")["best"][0]["date"]
    late = best_dates(sky, None, times, date(2027, 1, 1), days, mission, "comms")["best"][0]["date"]
    assert early < late


class Ridge:
    """Flat ground with a 400 m wall 1.5 km east of the origin."""
    source = "test ridge"
    resolution_m = 200.0

    def heights(self, lat, lon):
        lat, lon = np.asarray(lat, float), np.asarray(lon, float)
        e = np.radians(lon) * 1_737_400 * np.cos(np.radians(lat))
        return np.where(e > 1500, 400.0, 0.0) + 0 * lat


def test_nearby_shows_the_wall_blocking_the_east():
    lat, lon = -85.0, 0.0
    sky = AnalyticEphemeris().sky(lat, lon, time_grid(date(2027, 3, 1), 29.5, 1), 0)
    out = nearby(Ridge(), lat, lon, sky, radius_m=1000.0, n=5)
    sun = np.array(out["sun_pct"])
    assert sun.shape == (5, 5)
    assert out["spread"]["sun_pct"][0] <= out["centre"]["sun_pct"] <= out["spread"]["sun_pct"][1]
    assert out["best_sun"]["slope_deg"] <= 10 and out["best_sun"]["distance_m"] <= 1500
    assert abs(out["lat"][2][2] - lat) < 1e-4                 # centre cell is the site itself


def test_site_dates_endpoint_validates_priority():
    r = client.get("/site/dates", params={"lat": -85, "lon": 0, "priority": "cheapest"})
    assert r.status_code == 422
