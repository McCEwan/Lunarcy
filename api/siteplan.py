"""Site plan around a chosen landing site: where to put a solar array and a comms hub,
the drivable route between them, and the way to the nearest ice candidate.

    plan_site(heights, lat, lon, sky, ice=None) -> dict    (GET /site/plan)

1. Routing grid. A local tangent-plane grid ±ROUTE_HALF_M around the site (east/north,
   row 0 = north, the same frame as api/patch.terrain_patch and the 3D view), sampled from
   the active height source at about half its resolution. The Moon's curvature drop is
   removed so slopes are local.
2. Reachability. Dijkstra from the landing site over 8-neighbour steps. A step steeper than
   DRIVE_MAX_SLOPE_DEG, or onto ground that steep in any direction, is impassable (NASA: VIPER
   "can generally drive on slopes up to 15°"); otherwise it costs its 3D length × (1 + 2·(slope/limit)²), so gentle ground is preferred.
3. Solar / comms spots. Reachable cells within SEARCH_RADIUS_M whose own slope is
   ≤ SPOT_MAX_SLOPE_DEG. Each gets a terrain skyline seen from the top of a MAST_M mast
   (coarse first, then a fine 1° skyline for the best few). The Sun and Earth directions come
   from the site's own Horizons series: across a few km they are practically the same, only
   the skyline changes. Solar = most hours with the Sun above the skyline; comms = most hours
   with Earth above it. Ties go to the spot that is the shorter drive from the lander.
4. Route. The cheapest drivable path between the solar and comms spots.
5. Ice. The nearest ice target from api/ice.py (a "likely" cold-trap cell or the floor of a
   crater with published evidence or a "likely" rating). If it lies inside the grid, the
   route goes to the reachable point nearest to it (crater floors are usually too steep to
   drive into) and the remaining gap is reported; otherwise only the straight distance.

Accuracy follows the terrain: with the ~30 m detailed LOLA patch the route is meaningful;
on the ~237 m global grid it's a rough estimate (labelled so in the response).
"""

from __future__ import annotations

import heapq
import math
import time

import numpy as np

from .finder import compute_skylines
from .lola import destination

MOON_R_M = 1_737_400.0
ROUTE_HALF_M = 10_000.0          # routing grid: ±10 km, the same 20 km as the 3D view's terrain
SEARCH_RADIUS_M = 5_000.0        # solar / comms candidates within this distance of the lander
CANDIDATE_SPACING_M = 250.0
SPOT_MAX_SLOPE_DEG = 10.0        # where an array or antenna can stand
DRIVE_MAX_SLOPE_DEG = 15.0       # NASA VIPER: "can generally drive on slopes up to 15°"
DRIVE_SLOPE_SOURCE = ("Drivable slope limit 15°: NASA VIPER mission page "
                      "(science.nasa.gov/mission/viper), \"can generally drive on slopes up to 15 degrees\"")
MAST_M = 10.0                    # solar array / antenna mast height
REFINE_TOP = 8
# Comms tower: Earth-in-view % at the comms spot for each height.
TOWER_HEIGHTS_M = (2, 5, 10, 15, 20, 30, 50, 75, 100, 150, 200, 300, 500)
REALISTIC_TOWER_MAX_M = 20.0     # ESTIMATE: roughly the tallest mast a small lander could deploy
TOWER_REFERENCE = ("Tall lunar towers are still concepts: Honeybee Robotics' LUNARSABER for DARPA LunA-10 "
                   "is a self-deploying tower of about 100 m, possibly scaled to about 200 m")
TOWER_CONCEPT_MAX_M = 200.0


def _local_grid(lat: float, lon: float, spacing: float, half: float = ROUTE_HALF_M):
    k = int(round(half / spacing))
    axis = np.arange(-k, k + 1) * spacing
    E, N = np.meshgrid(axis, axis[::-1])                         # row 0 = north edge
    plat, plon = destination(np.full(E.shape, lat), np.full(E.shape, lon),
                             np.degrees(np.arctan2(E, N)), np.hypot(E, N))
    return E, N, plat, plon


def local_en(lat0: float, lon0: float, lat: float, lon: float) -> tuple[float, float, float]:
    """East/north offsets (m) and great-circle distance from (lat0, lon0) to (lat, lon)."""
    la1, lo1, la2, lo2 = map(math.radians, (lat0, lon0, lat, lon))
    d = 2 * math.asin(math.sqrt(math.sin((la2 - la1) / 2) ** 2
                                + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2))
    brg = math.atan2(math.sin(lo2 - lo1) * math.cos(la2),
                     math.cos(la1) * math.sin(la2) - math.sin(la1) * math.cos(la2) * math.cos(lo2 - lo1))
    dist = d * MOON_R_M
    return dist * math.sin(brg), dist * math.cos(brg), dist


def _dijkstra(h: np.ndarray, spacing: float, start: int, goal: int | None = None,
              slope: np.ndarray | None = None):
    """Cheapest drivable paths from `start` over the height grid h (8 neighbours).
    A cell whose ground slope (any direction) is over the limit can't be entered: driving
    across a steep hillside tips the rover even if the step itself is level.
    Returns (cost, prev) as flat arrays; cost = inf where unreachable."""
    nr, nc = h.shape
    flat = h.ravel().tolist()
    blocked = ((slope > DRIVE_MAX_SLOPE_DEG).ravel().tolist() if slope is not None
               else [False] * (nr * nc))
    cost = [math.inf] * (nr * nc)
    prev = [-1] * (nr * nc)
    tan_max = math.tan(math.radians(DRIVE_MAX_SLOPE_DEG))
    steps = [(dr, dc, spacing * math.hypot(dr, dc)) for dr in (-1, 0, 1) for dc in (-1, 0, 1) if dr or dc]
    cost[start] = 0.0
    heap = [(0.0, start)]
    while heap:
        c, u = heapq.heappop(heap)
        if c > cost[u]:
            continue
        if u == goal:
            break
        r, col = divmod(u, nc)
        hu = flat[u]
        for dr, dc, d in steps:
            rr, cc = r + dr, col + dc
            if not (0 <= rr < nr and 0 <= cc < nc):
                continue
            v = rr * nc + cc
            if blocked[v]:
                continue
            dh = flat[v] - hu
            if dh != dh or abs(dh) > d * tan_max:                  # NaN or too steep
                continue
            t = abs(dh) / d / tan_max                              # slope as a fraction of the limit
            nc_ = c + math.hypot(d, dh) * (1 + 2 * t * t)
            if nc_ < cost[v]:
                cost[v] = nc_
                prev[v] = u
                heapq.heappush(heap, (nc_, v))
    return np.array(cost), np.array(prev)


def _path(prev: np.ndarray, start: int, goal: int) -> list[int]:
    out = [goal]
    while out[-1] != start:
        p = int(prev[out[-1]])
        if p < 0:
            return []
        out.append(p)
    return out[::-1]


def _path_stats(idx: list[int], E, N, h, plat, plon) -> dict:
    e, n, z = E.ravel()[idx], N.ravel()[idx], h.ravel()[idx]
    seg = np.hypot(np.hypot(np.diff(e), np.diff(n)), np.diff(z))
    run = np.hypot(np.diff(e), np.diff(n))
    slopes = np.degrees(np.arctan2(np.abs(np.diff(z)), np.maximum(run, 1e-6)))
    return {
        "points": [[round(float(a), 1), round(float(b), 1)] for a, b in zip(e, n)],      # east, north (m)
        "latlon": [[round(float(a), 5), round(float(b), 5)] for a, b in
                   zip(plat.ravel()[idx], plon.ravel()[idx])],
        "drive_m": round(float(seg.sum())),
        "straight_m": round(float(math.hypot(e[-1] - e[0], n[-1] - n[0]))),
        "max_slope_deg": round(float(slopes.max()), 1) if slopes.size else 0.0,
    }


def _visible_pct(sky_el: np.ndarray, az_step: float, body_az: np.ndarray, body_el: np.ndarray) -> np.ndarray:
    """% of samples with the body above each candidate's skyline. sky_el: (C, naz)."""
    naz = sky_el.shape[1]
    idx = np.rint((np.asarray(body_az) % 360.0) / az_step).astype(int) % naz      # (T,)
    return 100.0 * (np.asarray(body_el)[None, :] > sky_el[:, idx]).mean(axis=1)


def plan_site(heights, lat: float, lon: float, sky, ice=None, *, level: str = "global") -> dict:
    """See the module docstring. `sky` is an ephemeris.Sky for the site over the period."""
    t0 = time.time()
    res = float(getattr(heights, "resolution_m", 100.0))
    spacing = max(res / 2.0, 50.0)
    E, N, plat, plon = _local_grid(lat, lon, spacing)
    h_abs = heights.heights(plat, plon)
    h = h_abs - (E ** 2 + N ** 2) / (2 * MOON_R_M)              # local heights, curvature removed
    nr, nc = h.shape
    centre = (nr // 2) * nc + nc // 2
    gy, gx = np.gradient(h, spacing)
    slope = np.degrees(np.arctan(np.hypot(gx, gy)))

    cost, prev = _dijkstra(h, spacing, centre, slope=slope)
    reach = np.isfinite(cost).reshape(h.shape)

    # Candidates: reachable, gentle, within the search radius, on a ~250 m lattice.
    stride = max(1, int(round(CANDIDATE_SPACING_M / spacing)))
    lattice = np.zeros_like(reach)
    lattice[::stride, ::stride] = True
    cand = np.flatnonzero((lattice & reach & (slope <= SPOT_MAX_SLOPE_DEG)
                           & (np.hypot(E, N) <= SEARCH_RADIUS_M)).ravel())
    cand = np.union1d(cand, [centre])                            # the landing spot itself is a candidate
    clat, clon = plat.ravel()[cand], plon.ravel()[cand]

    sun_az, sun_el, earth_az, earth_el = sky.sun_az, sky.sun_el, sky.earth_az, sky.earth_el
    coarse = compute_skylines(heights, clat, clon, az_step=4.0, samples=100, radius_m=100_000.0, observer_m=MAST_M)
    sun_c = _visible_pct(coarse, 4.0, sun_az, sun_el)
    earth_c = _visible_pct(coarse, 4.0, earth_az, earth_el)
    drive_km = np.array([_drive_len(prev, centre, int(i), E, N, h) for i in cand]) / 1000.0

    def pick(pct_coarse: np.ndarray, body_az, body_el) -> tuple[int, float]:
        top = np.argsort(-(pct_coarse - 0.3 * drive_km))[:REFINE_TOP]
        fine = compute_skylines(heights, clat[top], clon[top], az_step=1.0, samples=250,
                                radius_m=150_000.0, observer_m=MAST_M)
        pct = _visible_pct(fine, 1.0, body_az, body_el)
        best = int(np.argmax(pct - 0.3 * drive_km[top]))
        return int(top[best]), float(pct[best])

    i_sun, sun_pct = pick(sun_c, sun_az, sun_el)
    i_earth, earth_pct = pick(earth_c, earth_az, earth_el)
    # For the explanation: the same measure at the lander itself (fine skyline, same mast).
    at_lander = compute_skylines(heights, np.array([lat]), np.array([lon]), az_step=1.0, samples=250,
                                 radius_m=150_000.0, observer_m=MAST_M)
    lander_sun = float(_visible_pct(at_lander, 1.0, sun_az, sun_el)[0])
    lander_earth = float(_visible_pct(at_lander, 1.0, earth_az, earth_el)[0])

    def spot(i: int, key: str, pct: float) -> dict:
        g = int(cand[i])
        return {"lat": round(float(plat.ravel()[g]), 5), "lon": round(float(plon.ravel()[g]), 5),
                "east_m": round(float(E.ravel()[g]), 1), "north_m": round(float(N.ravel()[g]), 1),
                "elevation_m": round(float(h_abs.ravel()[g]), 1), key: round(pct, 1),
                "slope_deg": round(float(slope.ravel()[g]), 1),
                "drive_from_lander_m": round(float(drive_km[i] * 1000)), "mast_m": MAST_M}

    solar, comms = spot(i_sun, "sunlight_pct", sun_pct), spot(i_earth, "earth_pct", earth_pct)
    solar["why"] = {"candidates": int(len(cand)), "lander_pct": round(lander_sun, 1), "refined": REFINE_TOP}
    comms["why"] = {"candidates": int(len(cand)), "lander_pct": round(lander_earth, 1), "refined": REFINE_TOP}
    comms["tower"] = _tower(heights, comms["lat"], comms["lon"], earth_az, earth_el)
    g_sun, g_earth = int(cand[i_sun]), int(cand[i_earth])
    route = None
    if g_sun == g_earth:
        route = {"points": [], "latlon": [], "drive_m": 0, "straight_m": 0, "max_slope_deg": 0.0, "same_spot": True}
    else:
        _, prev2 = _dijkstra(h, spacing, g_sun, goal=g_earth, slope=slope)
        idx = _path(prev2, g_sun, g_earth)
        if idx:
            route = _path_stats(idx, E, N, h, plat, plon)

    ice_out = _ice_leg(ice, lat, lon, E, N, h, plat, plon, reach, prev, centre, spacing) if ice is not None else None

    rough = level != "detailed"
    notes = [f"Spots: within {SEARCH_RADIUS_M / 1000:g} km of the lander, slope ≤{SPOT_MAX_SLOPE_DEG:g}°, "
             f"skyline seen from a {MAST_M:g} m mast; Sun/Earth from the site's own series.",
             f"Routes avoid steps steeper than {DRIVE_MAX_SLOPE_DEG:g}° and prefer gentle ground."]
    if rough:
        notes.append(f"Global terrain (~{res:.0f} m): routes and spots are a ROUGH ESTIMATE.")
    return {
        "site": {"lat": lat, "lon": lon, "elevation_m": round(float(h_abs.ravel()[centre]), 1)},
        "grid": {"spacing_m": round(spacing, 1), "half_size_m": ROUTE_HALF_M, "level": level,
                 "resolution_m": round(res, 1), "rough": rough,
                 "reachable_km2": round(float(reach.sum()) * spacing ** 2 / 1e6, 1)},
        "solar": solar,
        "comms": comms,
        "route": route,
        "ice": ice_out,
        "notes": notes,
        "sources": [heights.source, sky.source, DRIVE_SLOPE_SOURCE] + (ice.sources() if ice is not None else []),
        "seconds": round(time.time() - t0, 1),
    }


def _tower(heights, lat: float, lon: float, earth_az, earth_el) -> dict:
    """Earth-in-view % vs tower height at the comms spot. Ideal = the lowest height within 1
    percentage point of the best up to 500 m; realistic = the best up to REALISTIC_TOWER_MAX_M."""
    curve = []
    for hm in TOWER_HEIGHTS_M:
        sky = compute_skylines(heights, np.array([lat]), np.array([lon]), az_step=1.0, samples=250,
                               radius_m=150_000.0, observer_m=float(hm))
        curve.append({"height_m": hm, "earth_pct": round(float(_visible_pct(sky, 1.0, earth_az, earth_el)[0]), 1)})
    best = max(c["earth_pct"] for c in curve)
    ideal = next(c for c in curve if c["earth_pct"] >= best - 1.0)
    real = max((c for c in curve if c["height_m"] <= REALISTIC_TOWER_MAX_M), key=lambda c: (c["earth_pct"], -c["height_m"]))
    real = next(c for c in curve if c["height_m"] <= REALISTIC_TOWER_MAX_M and c["earth_pct"] >= real["earth_pct"])
    return {"curve": curve,
            "ideal_m": ideal["height_m"], "ideal_earth_pct": ideal["earth_pct"],
            "realistic_m": real["height_m"], "realistic_earth_pct": real["earth_pct"],
            "realistic_basis": f"ESTIMATE: best within {REALISTIC_TOWER_MAX_M:g} m, about the tallest mast a small lander could deploy",
            "beyond_concepts": ideal["height_m"] > TOWER_CONCEPT_MAX_M,
            "reference": TOWER_REFERENCE}


def _drive_len(prev: np.ndarray, start: int, goal: int, E, N, h) -> float:
    if goal == start:
        return 0.0
    idx = _path(prev, start, goal)
    if not idx:
        return math.inf
    e, n, z = E.ravel()[idx], N.ravel()[idx], h.ravel()[idx]
    return float(np.hypot(np.hypot(np.diff(e), np.diff(n)), np.diff(z)).sum())


def _ice_leg(ice, lat, lon, E, N, h, plat, plon, reach, prev, centre, spacing) -> dict | None:
    tgt = ice.nearest_target(lat, lon)
    if tgt is None:
        return None
    e, n, dist = local_en(lat, lon, tgt["lat"], tgt["lon"])
    out = {**tgt, "east_m": round(e, 1), "north_m": round(n, 1), "distance_m": round(dist),
           "bearing_deg": round(math.degrees(math.atan2(e, n)) % 360, 1),
           "in_view": bool(abs(e) <= ROUTE_HALF_M and abs(n) <= ROUTE_HALF_M), "route": None}
    if out["in_view"]:
        # Drive to the reachable point closest to the ice (often the crater rim).
        d2 = np.where(reach, (E - e) ** 2 + (N - n) ** 2, np.inf).ravel()
        g = int(np.argmin(d2))
        idx = _path(prev, centre, g) if g != centre else [centre]
        if len(idx) > 1:
            out["route"] = _path_stats(idx, E, N, h, plat, plon)
            out["route"]["gap_to_ice_m"] = round(float(math.sqrt(d2[g])))
    return out
