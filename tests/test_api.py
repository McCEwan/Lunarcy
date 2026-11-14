from fastapi.testclient import TestClient

from api.main import app

client = TestClient(app)


def test_health():
    r = client.get("/health")
    assert r.status_code == 200 and r.json()["status"] == "ok"


def test_landers_have_required_fields():
    landers = client.get("/landers").json()
    assert landers
    for l in landers:
        for key in ("id", "name", "payload_capacity_kg", "max_slope_deg", "mission_days",
                    "transit_days", "solar_array_m2", "solar_efficiency", "sources"):
            assert key in l, f"{l.get('id')} missing {key}"


def test_site_only():
    r = client.post("/evaluate", json={"lat": -85.2, "lon": 31.0})
    assert r.status_code == 200
    body = r.json()
    assert set(body) >= {"site", "sky", "power_w", "comms", "windows", "launch_estimate", "checks", "pass", "sources"}
    assert body["pass"] is None


def test_lander_without_date_returns_windows():
    r = client.post("/evaluate", json={"lat": 0, "lon": -10, "lander_id": "blue-ghost"})
    assert r.status_code == 200
    assert isinstance(r.json()["windows"], list)


def test_full_request_uses_pass_key():
    r = client.post("/evaluate", json={
        "lat": 0, "lon": -10, "lander_id": "blue-ghost", "payload_kg": 90, "landing_date": "2027-03-14",
    })
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body["pass"], bool)
    assert all("pass" in c for c in body["checks"])


def test_landing_time_starts_the_series_at_that_hour():
    r = client.post("/evaluate", json={
        "lat": 0, "lon": -10, "lander_id": "blue-ghost", "landing_time": "2027-03-14T07:30:00Z",
    })
    assert r.status_code == 200
    body = r.json()
    assert body["sky"][0]["t"] == "2027-03-14T07:00Z"     # rounded down to the hour
    assert len(body["sky"]) == 14 * 24                     # Blue Ghost's 14-day mission


def test_windows_carry_suggested_landing_times():
    r = client.post("/evaluate", json={"lat": 0, "lon": -10, "lander_id": "blue-ghost"})
    for w in r.json()["windows"]:
        assert w["start_time"].endswith("Z") and w["start_time"][:10] == w["start"]


def test_evaluate_reports_terrain_level_and_altitude():
    body = client.post("/evaluate", json={"lat": -80.13, "lon": 1.44}).json()
    t = body["terrain"]
    assert t["level"] == "global"
    assert isinstance(t["site_elevation_m"], float) and t["site_elevation_m"] == body["site"]["elevation_m"]
    assert {"sun_visible", "earth_visible"} <= set(body["sky"][0])
    assert "sunlight_pct_flat" in body["site"]


def test_detailed_level_uses_fetched_patch(monkeypatch):
    import numpy as np

    from api import main
    from api.lola import DetailPatch

    def fake_fetch(lat, lon):
        return DetailPatch(lat, lon, 1000.0, 200.0, np.full((11, 11), 1234.0, np.float32), "TEST")

    monkeypatch.setattr(main, "DETAIL", main.DetailStore(main.ROOT / "data" / "_test_detail", fetcher=fake_fetch))
    monkeypatch.setattr(main, "_detailed_sources", {})
    try:
        d = client.post("/terrain/detail", params={"lat": 12.5, "lon": -33.25}).json()
        assert d["level"] == "detailed" and d["product"] == "TEST" and d["cached"] is False
        body = client.post("/evaluate", json={"lat": 12.5, "lon": -33.25, "terrain_level": "detailed"}).json()
        assert body["terrain"]["level"] == "detailed" and body["site"]["elevation_m"] == 1234.0
        assert body["terrain"]["detailed_cached"] is True
        patch = client.get("/terrain/patch", params={"lat": 12.5, "lon": -33.25, "level": "detailed", "n": 16})
        assert patch.json()["level"] == "detailed"
    finally:
        import shutil
        shutil.rmtree(main.ROOT / "data" / "_test_detail", ignore_errors=True)


def test_sky_subpoints():
    r = client.get("/sky/subpoints", params={"time": "2027-03-14T07:00:00Z"})
    assert r.status_code == 200
    body = r.json()
    assert -2 < body["sub_solar"]["lat"] < 2 and -10 < body["sub_earth"]["lat"] < 10
    assert body["time"] == "2027-03-14T07:00Z"


def test_bad_terrain_level_is_422():
    assert client.post("/evaluate", json={"lat": 0, "lon": 0, "terrain_level": "ultra"}).status_code == 422


def test_bad_latitude_is_422():
    assert client.post("/evaluate", json={"lat": 95, "lon": 0}).status_code == 422


def test_date_out_of_range_is_422():
    r = client.post("/evaluate", json={"lat": 0, "lon": 0, "landing_date": "2099-01-01"})
    assert r.status_code == 422


def test_payload_over_capacity_is_422():
    r = client.post("/evaluate", json={"lat": 0, "lon": 0, "lander_id": "blue-ghost", "payload_kg": 9999})
    assert r.status_code == 422
    assert r.json()["detail"][0]["loc"] == ["body", "payload_kg"]


def test_unknown_lander_is_404():
    r = client.post("/evaluate", json={"lat": 0, "lon": 0, "lander_id": "nope"})
    assert r.status_code == 404


def test_frontend_is_served():
    r = client.get("/")
    assert r.status_code == 200 and "globe.gl" in r.text
