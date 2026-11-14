from datetime import date, datetime, timedelta

import pytest

from api import evaluator
from api.ephemeris import AnalyticEphemeris
from api.terrain import TerrainSample

START = date(2027, 3, 1)
EPHEM = AnalyticEphemeris()
FLAT = TerrainSample(elevation_m=-1000.0, slope_deg=3.0, tmin_k=95.0, tmax_k=380.0)
STEEP = TerrainSample(elevation_m=-1000.0, slope_deg=25.0, tmin_k=95.0, tmax_k=380.0)
LANDER = {
    "name": "Test Lander",
    "payload_capacity_kg": 150,
    "solar_array_m2": 2.0,
    "solar_efficiency": 0.3,
    "max_slope_deg": 10,
    "max_surface_temp_k": 400,
    "mission_days": 14,
    "transit_days": 46,
}


def check(result, name):
    return next(c for c in result["checks"] if c["name"] == name)


def test_site_only_has_series_and_no_verdict():
    r = evaluator.evaluate(0, 0, terrain=FLAT, search_start=START, ephem=EPHEM)
    assert len(r["sky"]) == len(r["power_w"]) == len(r["comms"]) > 700  # ~one lunar day hourly
    assert r["checks"] == [] and r["pass"] is None and r["windows"] is None


def test_equator_sees_sun_about_half_the_time():
    r = evaluator.evaluate(0, 0, terrain=FLAT, search_start=START, ephem=EPHEM)
    assert 40 <= r["site"]["sunlight_pct"] <= 60


def test_near_side_center_always_sees_earth():
    r = evaluator.evaluate(0, 0, terrain=FLAT, search_start=START, ephem=EPHEM)
    assert r["site"]["earth_visible_pct"] == 100.0


def test_far_side_never_sees_earth():
    r = evaluator.evaluate(0, 180, terrain=FLAT, search_start=START, ephem=EPHEM)
    assert r["site"]["earth_visible_pct"] == 0.0


def test_power_is_zero_at_night():
    r = evaluator.evaluate(0, 0, terrain=FLAT, search_start=START, ephem=EPHEM)
    for sky, power in zip(r["sky"], r["power_w"]):
        if sky["sun_el"] <= 0:
            assert power["w"] == 0 and power["w_m2"] == 0


def test_sunlight_per_m2_on_a_flat_panel():
    import math
    r = evaluator.evaluate(0, 0, terrain=FLAT, search_start=START, ephem=EPHEM)
    for sky, power in zip(r["sky"], r["power_w"]):
        if sky["sun_visible"]:
            assert power["w_m2"] == pytest.approx(1361 * math.sin(math.radians(sky["sun_el"])), abs=0.2)
    assert max(p["w_m2"] for p in r["power_w"]) <= 1361


def test_steep_slope_fails_slope_check():
    r = evaluator.evaluate(0, 0, terrain=STEEP, search_start=START, ephem=EPHEM, lander=LANDER)
    assert check(r, "slope")["pass"] is False
    assert r["pass"] is False
    assert r["windows"] == []  # site can never pass, so no dates are valid


def test_flat_near_side_site_has_windows():
    r = evaluator.evaluate(0, -10, terrain=FLAT, search_start=START, ephem=EPHEM, lander=LANDER)
    assert r["windows"], "expected at least one landing window"
    assert r["launch_estimate"] is not None
    assert r["launch_estimate"] >= START, "launch can't be in the past"


def _hour(iso: str) -> datetime:
    return datetime.fromisoformat(iso.rstrip("Z"))


def test_landing_at_suggested_time_passes():
    windows = evaluator.evaluate(0, -10, terrain=FLAT, search_start=START, ephem=EPHEM, lander=LANDER)["windows"]
    r = evaluator.evaluate(
        0, -10, terrain=FLAT, search_start=START, ephem=EPHEM, lander=LANDER,
        payload_kg=90, landing_time=_hour(windows[0]["start_time"]),
    )
    assert r["pass"] is True, r["checks"]
    assert {c["name"] for c in r["checks"]} == {"slope", "temperature", "payload", "sunlight", "comms"}
    assert r["sky"][0]["t"] == windows[0]["start_time"]          # timelapse starts at landing
    assert len(r["sky"]) == LANDER["mission_days"] * 24           # ...and spans the mission


def test_suggested_time_is_the_first_hour_that_works():
    windows = evaluator.evaluate(0, -10, terrain=FLAT, search_start=START, ephem=EPHEM, lander=LANDER)["windows"]
    # windows[0] can open at the very first hour searched; windows[1] opens mid-range.
    w = windows[1]
    start = _hour(w["start_time"])
    before = evaluator.evaluate(
        0, -10, terrain=FLAT, search_start=START, ephem=EPHEM, lander=LANDER,
        landing_time=start - timedelta(hours=1),
    )
    assert before["pass"] is False
    assert w["start"] == start.date()
    assert _hour(w["end_time"]) >= start


def test_events_and_azimuths_are_reported():
    r = evaluator.evaluate(0, 0, terrain=FLAT, search_start=START, ephem=EPHEM)
    assert {"sun_az", "earth_az"} <= set(r["sky"][0])
    ev = r["events"]
    assert ev["sunrise"] and ev["sunset"]                 # equator: both within a lunar day
    assert ev["earthrise"] is None and ev["earthset"] is None  # near side: Earth never sets


def test_sources_name_the_ephemeris():
    r = evaluator.evaluate(0, 0, terrain=FLAT, search_start=START, ephem=EPHEM)
    assert any("ephemeris" in s.lower() for s in r["sources"])


def test_crater_rim_to_the_east_delays_sunrise_and_cuts_sunlight():
    # A crater floor: the rim stands 12° high toward the east (az 45-135), 0° elsewhere.
    skyline = [12.0 if 45 <= az <= 135 else 0.0 for az in range(360)]
    flat = evaluator.evaluate(0, 0, terrain=FLAT, search_start=START, ephem=EPHEM)
    crater = evaluator.evaluate(0, 0, terrain=FLAT, search_start=START, ephem=EPHEM, skyline=skyline)
    assert crater["site"]["sunlight_pct"] < flat["site"]["sunlight_pct"]
    assert crater["site"]["sunlight_pct_flat"] == flat["site"]["sunlight_pct"]
    assert crater["events"]["sunrise"] > flat["events"]["sunrise"]          # Sun clears the rim later
    for p, w in zip(crater["sky"], crater["power_w"]):
        if p["sun_el"] > 0 and not p["sun_visible"]:
            assert w["w"] == 0                                                  # no power in rim shadow
            assert p["sun_el"] < 12 and 45 <= p["sun_az"] <= 135


def test_wall_all_around_blocks_earth_and_comms():
    # At 70°E Earth hangs ~20° above the western horizon, so a 40° wall hides it.
    skyline = [40.0] * 360
    r = evaluator.evaluate(0, 70, terrain=FLAT, search_start=START, ephem=EPHEM, skyline=skyline)
    assert r["site"]["earth_visible_pct"] == 0.0 and r["site"]["earth_visible_pct_flat"] == 100.0
    assert not any(c["visible"] for c in r["comms"])


def test_terrain_shadow_can_remove_landing_windows():
    skyline = [40.0] * 360          # a deep pit: the Sun only clears the walls around midday
    flat = evaluator.evaluate(0, -10, terrain=FLAT, search_start=START, ephem=EPHEM, lander=LANDER)
    walled = evaluator.evaluate(0, -10, terrain=FLAT, search_start=START, ephem=EPHEM, lander=LANDER,
                                skyline=skyline)
    assert flat["windows"] and walled["windows"] == []


def test_skyline_at_interpolates_and_wraps():
    k = [0.0] * 360
    k[359], k[0], k[1] = 10.0, 20.0, 30.0
    assert evaluator.skyline_at(k, [0.0, 0.5, 359.5])[0] == 20.0
    assert evaluator.skyline_at(k, [0.5])[0] == pytest.approx(25.0)
    assert evaluator.skyline_at(k, [359.5])[0] == pytest.approx(15.0)
    assert evaluator.skyline_at(None, [10.0])[0] == 0.0


def test_missing_terrain_still_returns_sky_stats():
    r = evaluator.evaluate(0, 0, terrain=None, search_start=START, ephem=EPHEM)
    assert r["site"]["slope_deg"] is None and r["site"]["temp_range_k"] is None
    assert r["site"]["earth_visible_pct"] == 100.0
