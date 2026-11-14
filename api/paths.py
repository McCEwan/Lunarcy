"""Where large downloaded data lives.

NASA LOLA elevation files are big (LDEM_128 is 2.1 GB), so they're kept OUTSIDE the
project folder by default. That keeps them out of git and out of cloud-synced folders
like OneDrive. Set the LUNAR_DATA_DIR environment variable to use another location.

    <LUNAR_DATA_DIR>/lola/ldem_128.img     global elevation (scripts/fetch_lola.py)
    <LUNAR_DATA_DIR>/lola_detail/*.npz     cached ~30 m detailed patches
"""

from __future__ import annotations

import os
from pathlib import Path

PROJECT_DATA = Path(__file__).resolve().parent.parent / "data"


def big_data_dir() -> Path:
    env = os.environ.get("LUNAR_DATA_DIR")
    return Path(env).expanduser() if env else Path.home() / "LunarPlannerData"


def lola_dir() -> Path:
    return big_data_dir() / "lola"


def lola_detail_dir() -> Path:
    return big_data_dir() / "lola_detail"
