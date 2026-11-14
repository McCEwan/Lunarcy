"""Download the global NASA LRO LOLA elevation grid used for the "global estimate" level.

LDEM_64 is real measured elevation for the whole Moon: 64 pixels per degree
(~474 m), 16-bit integers in 0.5 m steps above the 1737.4 km reference sphere.
It's 531 MB, so this downloads once into data/lola/ and resumes if interrupted.

The detailed level does NOT need a big download: api/lola.py reads just the
few MB it needs from NASA's high-resolution files on demand.

Source: PDS Geosciences Node, LRO LOLA Gridded Data Records
https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/

Usage:  python scripts/fetch_lola.py
"""

from __future__ import annotations

import sys
import time
import urllib.request
from pathlib import Path

BASE = "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/cylindrical/img/"
FILES = ["ldem_64.lbl", "ldem_64.img"]
EXPECTED_IMG_BYTES = 11520 * 23040 * 2
OUT = Path(__file__).resolve().parent.parent / "data" / "lola"


def download(name: str) -> None:
    dest = OUT / name
    part = dest.with_suffix(dest.suffix + ".part")
    url = BASE + name
    head = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "lunar-planner-hackathon"})
    total = int(urllib.request.urlopen(head, timeout=60).headers["Content-Length"])
    if dest.exists() and dest.stat().st_size == total:
        print(f"{name}: already downloaded ({total / 1e6:.0f} MB)")
        return

    have = part.stat().st_size if part.exists() else 0
    headers = {"User-Agent": "lunar-planner-hackathon"}
    if have:
        headers["Range"] = f"bytes={have}-"
    req = urllib.request.Request(url, headers=headers)
    t0, last = time.time(), 0.0
    with urllib.request.urlopen(req, timeout=120) as resp, open(part, "ab" if have else "wb") as f:
        while chunk := resp.read(1 << 20):
            f.write(chunk)
            have += len(chunk)
            if time.time() - last > 2:
                rate = have / max(time.time() - t0, 1e-6) / 1e6
                print(f"  {name}: {have / 1e6:6.0f} / {total / 1e6:.0f} MB  ({rate:.1f} MB/s)", flush=True)
                last = time.time()
    if have != total:
        sys.exit(f"{name}: incomplete ({have} of {total} bytes). Run the script again to resume.")
    part.replace(dest)
    print(f"{name}: done ({total / 1e6:.0f} MB)")


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name in FILES:
        download(name)
    size = (OUT / "ldem_64.img").stat().st_size
    if size != EXPECTED_IMG_BYTES:
        sys.exit(f"ldem_64.img is {size} bytes, expected {EXPECTED_IMG_BYTES}")
    print("LOLA global grid ready in data/lola/. Restart the server to use it.")


if __name__ == "__main__":
    main()
