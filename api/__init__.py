"""Lunar Planner backend package."""

import ssl
import urllib.request


def _use_certifi_for_https() -> None:
    """Verify HTTPS with certifi's CA bundle when it is installed.

    The python.org macOS installer ships Python without root certificates, so
    urlopen fails with CERTIFICATE_VERIFY_FAILED (and JPL Horizons silently
    falls back to the analytic ephemeris). certifi's bundle fixes that on every OS.
    This is a global opener, so it also covers api/lola.py and the scripts.
    """
    try:
        import certifi
    except ImportError:
        return
    ctx = ssl.create_default_context(cafile=certifi.where())
    urllib.request.install_opener(urllib.request.build_opener(urllib.request.HTTPSHandler(context=ctx)))


_use_certifi_for_https()
