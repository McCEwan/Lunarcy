"""Download NASA Moon Trek map layers and stitch them into globe textures.

Moon Trek (https://trek.nasa.gov/moon/) serves global lunar maps as WMTS tiles in
an equirectangular projection, the same layout globe.gl expects for a texture.
This script reads each layer's WMTSCapabilities.xml, downloads every tile at one
zoom level, and writes a single image to web/assets/moontrek/<key>.jpg.

Run once (needs internet):  python scripts/fetch_moontrek_layers.py
"""

from __future__ import annotations

import io
import json
import sys
import urllib.request
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from PIL import Image

OUT_DIR = Path(__file__).resolve().parent.parent / "web" / "assets" / "moontrek"
BASE = "https://trek.nasa.gov/tiles/Moon/EQ/{layer}/1.0.0/WMTSCapabilities.xml"

# key -> (Moon Trek layer id, zoom level to stitch, label shown in the app)
LAYERS = {
    "wac": ("LRO_WAC_Mosaic_Global_303ppd_v02", 3, "LRO WAC global mosaic (imagery)"),
    "elevation": ("LRO_LOLA_ClrShade_Global_128ppd_v04", 3, "LRO LOLA color-shaded elevation"),
    "slope": ("LRO_LOLA_ClrSlope_Global_16ppd", 2, "LRO LOLA colorized slope"),
    "temperature": ("diviner_Clrtbol_max", 0, "LRO Diviner maximum bolometric temperature"),
}

NS = {
    "wmts": "http://www.opengis.net/wmts/1.0",
    "ows": "http://www.opengis.net/ows/1.1",
}


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "lunar-planner-hackathon"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def tile_info(layer_id: str, level: int) -> tuple[str, int, int, int]:
    """Return (url template with style/matrix set filled in, cols, rows, tile size)."""
    root = ET.fromstring(fetch(BASE.format(layer=layer_id)))
    layer = root.find(".//wmts:Contents/wmts:Layer", NS)
    template = layer.find("wmts:ResourceURL", NS).get("template")
    style = layer.find("wmts:Style/ows:Identifier", NS).text
    matrix_set = layer.find("wmts:TileMatrixSetLink/wmts:TileMatrixSet", NS).text
    tms = next(
        s for s in root.findall(".//wmts:Contents/wmts:TileMatrixSet", NS)
        if s.find("ows:Identifier", NS).text == matrix_set
    )
    matrices = {m.find("ows:Identifier", NS).text: m for m in tms.findall("wmts:TileMatrix", NS)}
    m = matrices[str(min(level, max(int(k) for k in matrices)))]
    cols = int(float(m.find("wmts:MatrixWidth", NS).text))
    rows = int(float(m.find("wmts:MatrixHeight", NS).text))
    size = int(m.find("wmts:TileWidth", NS).text)
    template = (
        template.replace("{Style}", style)
        .replace("{TileMatrixSet}", matrix_set)
        .replace("{TileMatrix}", m.find("ows:Identifier", NS).text)
        .replace("1.0.0//", "1.0.0/")
    )
    return template, cols, rows, size


def stitch(layer_id: str, level: int) -> Image.Image:
    template, cols, rows, size = tile_info(layer_id, level)
    canvas = Image.new("RGB", (cols * size, rows * size))

    def get(rc):
        r, c = rc
        url = template.replace("{TileRow}", str(r)).replace("{TileCol}", str(c))
        try:
            return r, c, Image.open(io.BytesIO(fetch(url))).convert("RGB")
        except Exception as exc:  # a missing tile means no data there
            print(f"  missing tile r{r} c{c}: {exc}", file=sys.stderr)
            return r, c, None

    with ThreadPoolExecutor(max_workers=8) as pool:
        for r, c, tile in pool.map(get, [(r, c) for r in range(rows) for c in range(cols)]):
            if tile is not None:
                canvas.paste(tile, (c * size, r * size))
    return canvas


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    manifest = {}
    for key, (layer_id, level, label) in LAYERS.items():
        print(f"{key}: {layer_id} (level {level})")
        img = stitch(layer_id, level)
        path = OUT_DIR / f"{key}.jpg"
        img.save(path, quality=85, optimize=True)
        print(f"  wrote {path.relative_to(OUT_DIR.parent.parent)}  {img.size[0]}x{img.size[1]}  "
              f"{path.stat().st_size / 1e6:.1f} MB")
        manifest[key] = {
            "file": f"assets/moontrek/{key}.jpg",
            "label": label,
            "layer_id": layer_id,
            "source": f"NASA Moon Trek: {layer_id}",
        }
    (OUT_DIR / "layers.json").write_text(json.dumps(manifest, indent=2))
    print("wrote web/assets/moontrek/layers.json")


if __name__ == "__main__":
    main()
