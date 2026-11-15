#!/usr/bin/env bash
# Start Lunarcy on a server (Azure App Service, a VM, Docker...).
# On first start it downloads the NASA data it needs, then serves the app.
#
#   LUNAR_DATA_DIR  where the big data goes (default /home/data, persistent on App Service)
#   LOLA_PPD        64 (531 MB, ~474 m) or 128 (2.1 GB, ~237 m); default 64
#   PORT            port to listen on (App Service sets it; default 8000)
set -u
cd "$(dirname "$0")"
export LUNAR_DATA_DIR="${LUNAR_DATA_DIR:-/home/data}"
PPD="${LOLA_PPD:-64}"
mkdir -p "$LUNAR_DATA_DIR"

retry() {  # retry a download a few times; the scripts resume or skip finished parts
  for i in 1 2 3; do "$@" && return 0; echo "attempt $i failed: $*" >&2; sleep 5; done
  return 1
}

if [ ! -f "$LUNAR_DATA_DIR/lola/ldem_${PPD}.img" ]; then
  echo "Downloading NASA LOLA LDEM_${PPD}..."
  retry python scripts/fetch_lola.py --ppd "$PPD" || echo "LOLA download failed; the app will use labelled placeholder terrain" >&2
fi
if [ ! -f "$LUNAR_DATA_DIR/diviner_tbol_minmax.npz" ]; then
  echo "Building Diviner temperature grids..."
  retry python scripts/fetch_diviner.py || echo "Diviner build failed; the app will use labelled placeholder temperatures" >&2
fi

exec python -m uvicorn api.main:app --host 0.0.0.0 --port "${PORT:-8000}"
