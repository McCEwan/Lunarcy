import base64
import json
from datetime import date

import numpy as np
from fastapi.testclient import TestClient

from api import finder, ice
from api.ephemeris import AnalyticEphemeris
from api.main import app

client = TestClient(app)


class Flat:
    source = "flat test terrain"
    resolution_m = 240.0

    def heights(self, lat, lon):
        return np.zeros(np.broadcast(np.asarray(lat), np.asarray(lon)).shape)


class Crater(Flat):
    """A 20 km wide, 4 km deep bowl centred on the south pole."""
    source = "polar crater test terrain"

    def heights(self, lat, lon):
        dist_km = (90.0 + np.asarray(lat, float)) * 30.3 + 0 * np.asarray(lon, float)
        return np.where(dist_km < 10.0, -4000.0 * (1 - (dist_km / 10.0) ** 2), 0.0)


def test_sun_never_exceeds_the_obliquity_at_the_pole():
    sun = ice.max_sun_elevation(-90.0, 90)
    assert np.all(np.isfinite(sun)) and np.allclose(sun, ice.OBLIQUITY_DEG, atol=0.05)


def test_sun_stays_on_the_equator_side_at_mid_latitudes():
    sun = ice.max_sun_elevation(-70.0, 360)                 # southern hemisphere: the Sun is north
    assert 20.5 < sun[0] < 21.6                              # 90 - 70 + 1.54
    assert sun[180] < -18                                    # due south only at night, far below the horizon


def test_flat_pole_is_lit_but_a_deep_polar_crater_floor_is_shadowed():
    for terrain, shadowed in ((Flat(), False), (Crater(), True)):
        sky = finder.compute_skylines(terrain, np.array([-89.99]), np.array([0.0]), az_step=1.0, samples=200)[0]
        assert (ice.shadow_margin(sky, -89.99) > 0) == shadowed


def _ice_map(tmp_path, craters, cold_cell=None):
    path = tmp_path / "craters.json"
    path.write_text(json.dumps({"source": "test gazetteer", "craters": craters}))

    class Temps:
        real = True
        source = "test Diviner"
        temps = {"tmax_k": np.full((36, 72), 250.0)}
    if cold_cell:
        Temps.temps["tmax_k"][cold_cell] = 80.0
    return ice.IceMap(Crater(), None, Temps(), res=5.0, craters_path=path)


def test_crater_rating_uses_shadow_temperature_and_evidence(tmp_path):
    craters = [
        {"name": "Pole Bowl", "lat": -90.0, "lon": 0.0, "diameter_km": 20.0},
        {"name": "Cited", "lat": -80.0, "lon": 10.0, "diameter_km": 20.0,
         "evidence": {"kind": "direct", "summary": "test", "citation": "Someone 2020"}},
        {"name": "Flat Spot", "lat": -75.0, "lon": 100.0, "diameter_km": 20.0},
    ]
    m = _ice_map(tmp_path, craters, cold_cell=(0, 36))      # the cell holding (90°S, 0°E) is cold
    by = {c["name"]: c for c in m.craters}
    assert by["Pole Bowl"]["floor_shadowed"] and by["Pole Bowl"]["rating"] == "likely"
    assert 3500 < by["Pole Bowl"]["depth_m"] < 4100
    assert by["Cited"]["rating"] == "known"
    assert by["Flat Spot"]["rating"] == "unlikely" and not by["Flat Spot"]["floor_shadowed"]
    assert m.classes[0, 36] == 1                             # cold, but no skyline grid for shadow
    assert any("Someone 2020" in s for s in m.sources())


def test_distance_to_ice_and_finder_filter(tmp_path):
    m = _ice_map(tmp_path, [{"name": "Pole Bowl", "lat": -90.0, "lon": 0.0, "diameter_km": 20.0}],
                 cold_cell=(0, 36))
    d = m.distance_km(np.array([-90.0, -80.0, 0.0]), np.array([0.0, 0.0, 0.0]))
    assert d[0] < 1 and 290 < d[1] < 320 and d[2] > 2500    # ~30.3 km per degree
    crit = finder.Criteria(date(2027, 3, 1), date(2027, 3, 14), region="south",
                           goal="ice_craters", max_ice_km=400, max_slope_deg=90)
    out = finder.find_regions(crit, AnalyticEphemeris(), Flat(), None, res=5.0, ice=m)
    assert out["ice"]["craters"][0]["name"] == "Pole Bowl"
    assert out["criteria"]["goal_label"] == "Check for ice in deep craters"
    regs = out["regions"]
    assert regs and regs[0]["within_ice_range"] and regs[0]["nearest_ice_crater"]["name"] == "Pole Bowl"
    assert all((r["ice_km"] <= 400) == r["within_ice_range"] for r in regs)
    in_range = [r for r in regs if r["within_ice_range"]]
    assert in_range and all(r["lat"] < -75 for r in in_range)   # ice range: within 400 km of the pole
    cls = np.frombuffer(base64.b64decode(out["grid"]["classes_b64"]), np.uint8)
    assert (cls == 3).sum() == out["counts"]["ice_range_cells"] > 0
    assert (cls == 2).any()                                 # suitable but too far from ice: green


def test_polar_crater_file_is_sourced_and_cited():
    meta = json.loads(ice.CRATERS_PATH.read_text(encoding="utf-8"))
    assert "USGS" in meta["source"]
    names = {c["name"]: c for c in meta["craters"]}
    for n in ("Shackleton", "Cabeus", "Haworth", "Hermite"):
        assert n in names
    assert all(abs(c["lat"]) >= 75 and -180 <= c["lon"] <= 180 for c in meta["craters"])
    assert all(c["evidence"]["citation"] for c in meta["craters"] if "evidence" in c)


def test_find_request_accepts_the_ice_goal_only():
    body = {"period_start": "2027-03-01", "period_end": "2027-03-02", "goal": "mine_helium"}
    assert client.post("/find", json=body).status_code == 422
