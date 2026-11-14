import os

import numpy as np
import pytest

from api import ephemeris
from api.ephemeris import (
    FALLBACK_SOURCE, HORIZONS_SOURCE, AnalyticEphemeris, HorizonsEphemeris, parse_horizons_azel,
)

# Trimmed real Horizons output: Sun from Apollo 11 (CENTER='coord@301'), QUANTITIES='4', CSV.
SAMPLE = """
 Date__(UT)__HR:MN, , ,Azi_(a-app), Elev_(a-app),
*************************************************
$$SOE
 2027-Mar-01 00:00, ,i, 270.999944,   -27.947183,
 2027-Mar-01 06:00,*,i, 271.072468,   -30.990707,
 2027-Mar-01 12:00, ,i, 271.151646,   -34.034556,
$$EOE
"""


def test_parse_horizons_azel():
    az, el = parse_horizons_azel(SAMPLE)
    assert az == [270.999944, 271.072468, 271.151646]
    assert el == [-27.947183, -30.990707, -34.034556]


def test_horizons_falls_back_when_offline(monkeypatch, tmp_path):
    def boom(*a, **k):
        raise OSError("no network")
    eph = HorizonsEphemeris(cache_dir=tmp_path)
    monkeypatch.setattr(eph, "_fetch", boom)
    times = ephemeris.time_grid(np.datetime64("2027-03-01"), 2)
    sky = eph.sky(0.67, 23.47, times)
    assert sky.source == FALLBACK_SOURCE
    assert len(sky.sun_el) == len(times)


def test_horizons_caches_to_disk(monkeypatch, tmp_path):
    calls = []

    def fake_fetch(body, lat, lon, start, step_min, n):
        calls.append(body)
        return [0.0] * n, [float(body == "10")] * n

    eph = HorizonsEphemeris(cache_dir=tmp_path)
    monkeypatch.setattr(eph, "_fetch", fake_fetch)
    times = ephemeris.time_grid(np.datetime64("2027-03-01"), 1)
    first = eph.sky(10, 20, times)
    assert first.source == HORIZONS_SOURCE and first.sun_el[0] == 1.0 and first.earth_el[0] == 0.0
    assert sorted(calls) == ["10", "399"]

    fresh = HorizonsEphemeris(cache_dir=tmp_path)       # new instance: memory cache empty
    monkeypatch.setattr(fresh, "_fetch", lambda *a: pytest.fail("should come from disk cache"))
    assert fresh.sky(10, 20, times).sun_el[0] == 1.0


def test_analytic_azimuth_points_east_at_sunrise():
    eph = AnalyticEphemeris()
    times = ephemeris.time_grid(np.datetime64("2027-03-01"), 30)
    sky = eph.sky(0, 0, times)
    rising = np.flatnonzero((sky.sun_el[:-1] <= 0) & (sky.sun_el[1:] > 0))
    assert len(rising)
    assert 60 < sky.sun_az[rising[0] + 1] < 120   # Sun rises in the east


@pytest.mark.skipif(not os.environ.get("RUN_LIVE"), reason="set RUN_LIVE=1 to call JPL Horizons")
def test_horizons_live_matches_known_value(tmp_path):
    # Value checked by hand against Horizons on 2026-11-14: Sun from Apollo 11 at 2027-03-01 00:00.
    eph = HorizonsEphemeris(cache_dir=tmp_path)
    times = ephemeris.time_grid(np.datetime64("2027-03-01"), 1)
    sky = eph.sky(0.67, 23.47, times)
    assert sky.source == HORIZONS_SOURCE
    assert sky.sun_el[0] == pytest.approx(-27.947, abs=0.05)


@pytest.mark.skipif(not os.environ.get("RUN_LIVE"), reason="set RUN_LIVE=1 to call JPL Horizons")
def test_horizons_apollo_11_landing_sun_angle(tmp_path):
    # Eagle landed 1969-07-20 20:17 UTC with the Sun roughly 10-11° above the eastern horizon.
    eph = HorizonsEphemeris(cache_dir=tmp_path)
    times = np.datetime64("1969-07-20T20:00") + np.arange(2) * np.timedelta64(1, "h")
    sky = eph.sky(0.6741, 23.4730, times)
    assert 9 < sky.sun_el[0] < 12.5
    assert 60 < sky.sun_az[0] < 120
