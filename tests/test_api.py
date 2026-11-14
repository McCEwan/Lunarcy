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
