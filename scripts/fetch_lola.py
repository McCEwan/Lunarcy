"""Download the global NASA LRO LOLA elevation grid used for the "global estimate" level.

Default: LDEM_128, real measured elevation for the whole Moon at 128 pixels per degree
(~237 m), 16-bit integers in 0.5 m steps above the 1737.4 km reference sphere. 2.1 GB,
downloaded once, resumable if interrupted. (`--ppd 64` gets the older 531 MB, ~474 m grid.)

It's saved OUTSIDE the project, by default in ~/LunarPlannerData/lola/ (set LUNAR_DATA_DIR
to change it), so it stays out of git and out of OneDrive/Dropbox syncing. See api/paths.py.

The detailed level does NOT need a big download: api/lola.py reads just the few MB it
needs from NASA's high-resolution files on demand.

Source: PDS Geosciences Node, LRO LOLA Gridded Data Records
https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/

Usage:  python scripts/fetch_lola.py [--ppd 128|64]
"""

from __future__ import annotations

import argparse
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from api.paths import lola_dir  # noqa: E402

BASE = "https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/cylindrical/img/"
GRIDS = {128: (23040, 46080), 64: (11520, 23040)}   # ppd -> (lines, samples)


def download(name: str, out: Path) -> None:
    dest = out / name
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
    t0, last, start = time.time(), 0.0, have
    with urllib.request.urlopen(req, timeout=120) as resp, open(part, "ab" if have else "wb") as f:
        while chunk := resp.read(1 << 20):
            f.write(chunk)
            have += len(chunk)
            if time.time() - last > 5:
                rate = (have - start) / max(time.time() - t0, 1e-6) / 1e6
                print(f"  {name}: {have / 1e6:6.0f} / {total / 1e6:.0f} MB  ({rate:.1f} MB/s)", flush=True)
                last = time.time()
    if have != total:
        sys.exit(f"{name}: incomplete ({have} of {total} bytes). Run the script again to resume.")
    part.replace(dest)
    print(f"{name}: done ({total / 1e6:.0f} MB)")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--ppd", type=int, choices=sorted(GRIDS), default=128, help="pixels per degree")
    args = parser.parse_args()

    out = lola_dir()
    out.mkdir(parents=True, exist_ok=True)
    print(f"Saving to {out}")
    for ext in ("lbl", "img"):
        download(f"ldem_{args.ppd}.{ext}", out)
    lines, samples = GRIDS[args.ppd]
    size = (out / f"ldem_{args.ppd}.img").stat().st_size
    if size != lines * samples * 2:
        sys.exit(f"ldem_{args.ppd}.img is {size} bytes, expected {lines * samples * 2}")
    print("LOLA global grid ready. Restart the server to use it.")


if __name__ == "__main__":
    main()
