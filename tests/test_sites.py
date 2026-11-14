import json
from pathlib import Path

from fastapi.testclient import TestClient

from api.main import LANDERS_BY_ID, app

SITES = json.loads((Path(__file__).parent.parent / "api" / "data" / "sites.json").read_text(encoding="utf-8"))
client = TestClient(app)


def test_sites_are_well_formed():
    ids = set()
    for s in SITES:
        for key in ("id", "name", "program", "agency", "status", "date", "lat", "lon", "precision", "place", "source"):
            assert key in s, f"{s.get('id')} missing {key}"
        assert -90 <= s["lat"] <= 90 and -180 <= s["lon"] <= 180, s["id"]
        assert s["status"] in {"landed", "landed-tipped", "planned"}, s["id"]
        assert s["precision"] in {"point", "region"}, s["id"]
        assert s["source"].startswith("https://"), s["id"]
        assert s["id"] not in ids, f"duplicate id {s['id']}"
        ids.add(s["id"])
        if "lander_id" in s:
            assert s["lander_id"] in LANDERS_BY_ID, s["id"]


def test_planned_sites_are_marked_approximate_or_cited():
    for s in SITES:
        if s["status"] == "planned":
            assert s["precision"] == "region" and s.get("note"), s["id"]


def test_catalog_covers_apollo_and_clps():
    programs = {s["program"] for s in SITES}
    assert {"Apollo", "CLPS"} <= programs
    assert any(s["status"] == "planned" for s in SITES)


def test_sites_endpoint():
    r = client.get("/sites")
    assert r.status_code == 200 and len(r.json()) == len(SITES)


def test_apollo_11_is_where_lroc_says():
    a11 = next(s for s in SITES if s["id"] == "apollo-11")
    assert abs(a11["lat"] - 0.674) < 0.01 and abs(a11["lon"] - 23.473) < 0.01
