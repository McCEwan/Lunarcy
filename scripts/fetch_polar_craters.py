"""Build api/data/polar_craters.json: named polar craters, for the "ice in deep craters" goal.

Source: USGS Gazetteer of Planetary Nomenclature (IAU-approved names), the Moon
centre-points shapefile. Only the .dbf table is read (no GIS libraries needed).
Kept: craters (AA) and satellite craters (SF) poleward of MIN_ABS_LAT, at least
MIN_DIAMETER_KM across.

Published ice evidence for a few craters is added from EVIDENCE below. Each entry
cites its paper. Everything else about a crater (depth, permanent shadow, coldest
temperature) is computed at run time from LOLA and Diviner by api/ice.py, not here.

    python scripts/fetch_polar_craters.py
"""

from __future__ import annotations

import io
import json
import struct
import sys
import urllib.request
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import api  # noqa: E402,F401  (HTTPS certificates, see api/__init__.py)

URL = "https://planetarynames.wr.usgs.gov/shapefiles/MOON_nomenclature_center_pts.zip"
SOURCE = "USGS Gazetteer of Planetary Nomenclature (IAU), planetarynames.wr.usgs.gov"
OUT = Path(__file__).resolve().parent.parent / "api" / "data" / "polar_craters.json"
MIN_ABS_LAT = 75.0
MIN_DIAMETER_KM = 8.0

# Published evidence of water ice. Keep each claim to what the cited paper says.
EVIDENCE = {
    "Cabeus": {
        "kind": "direct",
        "summary": "LCROSS impact (Oct 2009) threw up a plume containing water ice and vapour, about 5.6 % by mass.",
        "citation": "Colaprete et al. 2010, Science 330, 463-468",
    },
    "Shackleton": {
        "kind": "indirect",
        "summary": "Floor unusually bright at 1064 nm (LOLA), consistent with some surface ice.",
        "citation": "Zuber et al. 2012, Nature 486, 378-381",
    },
    "Haworth": {
        "kind": "indirect",
        "summary": "LRO LAMP far-UV ratios consistent with surface water frost; strongest of Haworth, Faustini, Shoemaker.",
        "citation": "Hayne et al. 2015, Icarus 255, 58-69",
    },
    "Faustini": {
        "kind": "indirect",
        "summary": "LRO LAMP far-UV ratios consistent with surface water frost.",
        "citation": "Hayne et al. 2015, Icarus 255, 58-69",
    },
    "Shoemaker": {
        "kind": "indirect",
        "summary": "LRO LAMP far-UV ratios consistent with surface water frost.",
        "citation": "Hayne et al. 2015, Icarus 255, 58-69",
    },
}


def read_dbf(data: bytes):
    n, header_len, rec_len = struct.unpack("<4xIHH20x", data[:32])
    fields, pos = [], 32
    while data[pos] != 0x0D:
        d = data[pos:pos + 32]
        fields.append((d[:11].split(b"\0")[0].decode(), d[16]))
        pos += 32
    for i in range(n):
        rec = data[header_len + i * rec_len: header_len + (i + 1) * rec_len]
        row, p = {}, 1
        for name, length in fields:
            row[name] = rec[p:p + length].decode("utf-8", "replace").strip()
            p += length
        yield row


def main() -> None:
    print(f"Downloading {URL} …")
    req = urllib.request.Request(URL, headers={"User-Agent": "lunar-planner-hackathon"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        z = zipfile.ZipFile(io.BytesIO(resp.read()))
    dbf = next(n for n in z.namelist() if n.lower().endswith(".dbf"))
    craters = []
    for row in read_dbf(z.read(dbf)):
        if row["code"] not in ("AA", "SF") or not row["approval"].startswith("Adopted"):
            continue
        lat, d = float(row["center_lat"]), float(row["diameter"])
        if abs(lat) < MIN_ABS_LAT or d < MIN_DIAMETER_KM:
            continue
        lon = (float(row["center_lon"]) + 180.0) % 360.0 - 180.0
        entry = {"name": row["name"], "lat": round(lat, 3), "lon": round(lon, 3),
                 "diameter_km": round(d, 1), "link": row["link"]}
        if row["name"] in EVIDENCE:
            entry["evidence"] = EVIDENCE[row["name"]]
        craters.append(entry)
    craters.sort(key=lambda c: (c["lat"] > 0, -c["diameter_km"]))
    missing = set(EVIDENCE) - {c["name"] for c in craters}
    if missing:
        raise SystemExit(f"Evidence craters not found in the gazetteer: {missing}")
    OUT.write_text(json.dumps({"source": SOURCE, "url": URL, "min_abs_lat": MIN_ABS_LAT,
                               "min_diameter_km": MIN_DIAMETER_KM, "craters": craters}, indent=1) + "\n",
                   encoding="utf-8")
    south = sum(c["lat"] < 0 for c in craters)
    print(f"wrote {OUT} ({len(craters)} craters: {south} south, {len(craters) - south} north)")


if __name__ == "__main__":
    main()
