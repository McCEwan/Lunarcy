// Lunar Planner frontend. Plain JS modules, no build step.
// Remember: globe.gl uses `lng`, the API uses `lon`. Convert only in evaluateSite()
// (and when reading /sites, which uses `lon`).

import { horizonsUrl, moontrekUrl, quickmapUrl } from './links.js';
import { open3dView } from './site3d.js';
import { startIntroEarth } from './intro_earth.js';
import { SkyPanel, downloadText } from './skycharts.js';

const MAX_DATE = '2050-12-31';
const FALLBACK_TEXTURE = 'https://cdn.jsdelivr.net/gh/vasturiano/globe.gl@v2.46.2/example/moon-landing-sites/lunar_surface.jpg';
const BUMP = 'https://cdn.jsdelivr.net/gh/vasturiano/globe.gl@v2.46.2/example/moon-landing-sites/lunar_bumpmap.jpg';

const SITE_FILTERS = {
  all: { label: 'All', test: () => true },
  apollo: { label: 'Apollo', test: (s) => s.program === 'Apollo' },
  clps: { label: 'CLPS (past)', test: (s) => s.program === 'CLPS' && s.status !== 'planned' },
  planned: { label: 'Planned', test: (s) => s.status === 'planned' },
  intl: { label: 'Other nations', test: (s) => !['NASA'].includes(s.agency) && s.program !== 'CLPS' },
};

const state = {
  catalog: [],       // GET /sites (notable landing sites)
  layers: {},        // web/assets/moontrek/layers.json
  sites: [],         // comparison list: { id, lat, lng, name, catalog, result }
  current: null,     // the site being worked on (may or may not be in `sites`)
  filter: 'all',
  ice: null,         // GET /ice (or the `ice` block of a goal search): cold-trap grid + rated craters
  // Analysis period for every site's stats (and the comparison table): one UTC day or a range.
  period: { mode: 'day', start: new Date().toISOString().slice(0, 10), end: null },
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v, digits = 1, unit = '') => (v === null || v === undefined ? '—' : `${Number(v).toFixed(digits)}${unit}`);
const fmtLat = (lat) => `${Math.abs(lat).toFixed(2)}°${lat < 0 ? 'S' : 'N'}`;
const fmtLon = (lon) => `${Math.abs(lon).toFixed(2)}°${lon < 0 ? 'W' : 'E'}`;
const statusColor = (s) => (s.status === 'planned' ? '#5ee1ff' : '#ffd166');

// ---- Stat colours and fill ---------------------------------------------------------
// Each stat gets a colour (good / warn / bad: green, yellow, red) and a viability fill (0–1):
// the tile is filled from the left by that fraction in its colour. `why` explains both.
const realTemps = (r) => r.sources.some((s) => /Diviner/.test(s));
const toC = (k) => k - 273.15;
const fmtC = (k, digits = 0) => `${toC(k).toFixed(digits).replace('-', '−')} °C`;
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const SLOPE_LIMIT_DEG = 10;          // typical lander touchdown limit
const HOT_LIMIT_K = 400;             // typical rated surface-temperature limit (estimate)

function tempRating(r) {
  const t = r.site.temp_range_k;
  if (!t || !realTemps(r)) return { level: 'none', fill: 0, why: 'Not rated: no real temperature data here.' };
  const level = t[1] <= HOT_LIMIT_K - 30 ? 'good' : t[1] <= HOT_LIMIT_K ? 'warn' : 'bad';
  const swing = t[1] - t[0];
  return {
    level,
    fill: clamp01(1 - swing / 400),
    why: `Colour: the Diviner daytime high (${fmtC(t[1])}) against a typical hardware limit of ${fmtC(HOT_LIMIT_K)} ` +
      `(an estimate): green up to ${fmtC(HOT_LIMIT_K - 30)}, yellow up to ${fmtC(HOT_LIMIT_K)}, red above. ` +
      `Fill: how gentle the day–night swing is (${swing.toFixed(0)} °C here; a full bar would be no swing, an empty one 400 °C). ` +
      `The night low of ${fmtC(t[0])} needs heaters or a survival mode.`,
  };
}

function rateStats(site, r) {
  const s = r.site;
  const kind = r.period?.kind ?? 'lunar_day';
  const longPeriod = kind === 'lunar_day' || (kind === 'range' && r.period.hours >= 25 * 24);
  const peakSun = Math.max(...r.power_w.map((p) => p.w_m2));
  const band = (v, good, warn, higherIsBetter = true) => {
    if (v === null || v === undefined) return 'none';
    return higherIsBetter ? (v >= good ? 'good' : v >= warn ? 'warn' : 'bad')
                          : (v <= good ? 'good' : v <= warn ? 'warn' : 'bad');
  };
  const pctFill = (p) => clamp01((p ?? 0) / 100);
  let sunlight;
  if (kind === 'day') {
    sunlight = { level: band(s.sun_hours, 18, 6), fill: clamp01(s.sun_hours / 24),
      why: 'Hours the Sun is above the real terrain skyline in this 24 h day. Green ≥18 h, yellow 6–18 h (the Sun rises or sets that day), red <6 h. Fill = share of the day in sunlight.' };
  } else if (longPeriod) {
    sunlight = { level: band(s.sunlight_pct, 45, 30), fill: pctFill(s.sunlight_pct),
      why: 'Share of the period with the Sun above the real terrain skyline (crater rims and mountains counted). Away from the poles the Sun is up at most ~50% of a lunar month, so green ≥45%, yellow 30–45%, red <30%. Fill = that share.' };
  } else {
    sunlight = { level: band(s.sunlight_pct, 70, 40), fill: pctFill(s.sunlight_pct),
      why: 'Share of this date range with the Sun above the real terrain skyline. Green ≥70%, yellow 40–70%, red <40%. Fill = that share.' };
  }
  return {
    sunlight,
    earth: kind === 'day'
      ? { level: band(s.earth_hours, 22.8, 19.2), fill: clamp01(s.earth_hours / 24),
          why: 'Hours Earth is above the terrain skyline in this 24 h day, i.e. direct radio contact is possible. Green ≥22.8 h (95%), yellow 19.2–22.8 h, red <19.2 h. Fill = share of the day.' }
      : { level: band(s.earth_visible_pct, 95, 80), fill: pctFill(s.earth_visible_pct),
          why: 'Share of the period Earth is above the terrain skyline, i.e. direct-to-Earth radio without a relay satellite. Green ≥95%, yellow 80–95%, red <80%. Fill = that share.' },
    slope: {
      level: band(s.slope_deg, 0.7 * SLOPE_LIMIT_DEG, SLOPE_LIMIT_DEG, false),
      fill: s.slope_deg === null ? 0 : clamp01(1 - s.slope_deg / (2 * SLOPE_LIMIT_DEG)),
      why: `Ground slope from NASA LOLA over the shown distance. Landers typically need ≤${SLOPE_LIMIT_DEG}°: green ≤${(0.7 * SLOPE_LIMIT_DEG).toFixed(0)}°, yellow up to ${SLOPE_LIMIT_DEG}°, red above. Fill = how flat it is (full at 0°, empty at ${2 * SLOPE_LIMIT_DEG}°).`,
    },
    sun_m2: { level: band(peakSun, 500, 150), fill: clamp01(peakSun / 1361),
      why: 'Strongest sunlight on a flat, upward-facing panel in the period. Green ≥500 W/m² (Sun ≥~22° up), yellow 150–500, red <150. Fill = share of the full 1,361 W/m² (Sun straight overhead). Near the poles the Sun stays low, so tilted or vertical panels do much better than this.' },
    sun_el: (() => {
      const maxEl = Math.max(...r.sky.map((p) => p.sun_el));
      return {
        level: band(maxEl, 20, 5), fill: clamp01(Math.sin(Math.max(maxEl, 0) * Math.PI / 180)),
        why: `How high the Sun gets over the period (${maxEl.toFixed(1)}° at most). A flat solar panel collects sunlight in ` +
          'proportion to sin(elevation): at 1.5°, the most the Sun ever reaches at the poles, that is under 3% of overhead Sun, ' +
          'so polar missions use vertical panels that face the low Sun instead. Green ≥20°, yellow 5–20°, red <5°. ' +
          'Fill = sin(highest elevation), the share of overhead sunlight a flat panel gets at its best.',
      };
    })(),
    elevation: { level: 'none', fill: 0, why: 'Height above the Moon\'s 1,737.4 km reference sphere (NASA LOLA). Not rated: elevation alone is neither good nor bad, though high rims often see more Sun and Earth.' },
    temperature: tempRating(r),
  };
}

// ---- Globe -------------------------------------------------------------------

// Pins and labels keep a constant on-screen size: their sizes (in degrees on the globe) are
// multiplied by zoomScale, which follows the camera altitude (1 at the whole-Moon view).
const ZOOM_REF_ALTITUDE = 2.4;
let zoomScale = 1;
const zs = (v) => v * zoomScale;
// The selected site: hot magenta, which nothing on the grey Moon or in the heatmap uses.
const PIN_COLOR = '#ff2bd6';
const PIN = { radius: 1.1, altitude: 0.03, ring: 3.2 };   // degrees / globe radii at the whole-Moon view
// Hover beacon: a thin beam straight up from the hovered site, 1.1 Moon radii long, so it
// sticks out past the Moon's edge even when the site is on the far side.
const BEACON_ALT = 1.1;
const pinAlt = (s) => (s.beacon ? BEACON_ALT : zs(s === state.current ? PIN.altitude : PIN.altitude * 0.6));
const pinRadius = (s) => (s.beacon ? zs(0.28) : zs(s === state.current ? PIN.radius : PIN.radius * 0.7));

const globeEl = $('globe');
const globe = new Globe(globeEl)
  .globeImageUrl(FALLBACK_TEXTURE)
  .bumpImageUrl(BUMP)
  .backgroundImageUrl('https://cdn.jsdelivr.net/npm/three-globe@2.45.0/example/img/night-sky.png')
  .showAtmosphere(false)
  // User-picked sites
  .pointLat('lat')
  .pointLng('lng')
  .pointAltitude(pinAlt)
  .pointRadius(pinRadius)
  .pointColor((s) => (s.beacon ? 'rgba(255, 255, 255, 0.9)' : s === state.current ? PIN_COLOR : COMPARE_PIN))
  .pointResolution(16)
  .onPointHover((s) => setHover(s && !s.beacon ? { lat: s.lat, lng: s.lng, name: s.name ?? 'Selected site' } : s?.beacon ? state.hover : null))
  // A pulsing ring around the selected site so it's easy to find
  .ringLat('lat')
  .ringLng('lng')
  .ringColor(() => (t) => `rgba(255, 43, 214, ${Math.max(0, 1 - t) * 0.9})`)
  .ringMaxRadius(() => zs(PIN.ring))
  .ringPropagationSpeed(() => zs(PIN.ring * 1.4))
  .ringRepeatPeriod(900)
  // Site plan on the globe: drivable routes (solid) and the line to the nearest ice (dashed)
  .pathPoints('coords')
  .pathPointLat((p) => p[0])
  .pathPointLng((p) => p[1])
  .pathPointAlt(0.002)
  .pathColor('color')
  .pathStroke('stroke')
  .pathDashLength('dash')
  .pathDashGap('gap')
  .pathDashAnimateTime(0)
  .pathLabel('label')
  .pointLabel((s) => esc(s.name ?? `${fmtLat(s.lat)}, ${fmtLon(s.lng)}`))
  .onPointClick((s) => { if (!s.beacon) selectSite(s); })
  // Notable landing sites from /sites
  .labelLat('lat')
  .labelLng('lon')
  .labelText('name')
  .labelSize((s) => zs((isHovered(s) ? 1.5 : 1) * (s.kind === 'ice' ? (s.rating === 'known' ? 0.8 : 0.6) : s.kind === 'region' ? 1.1 : 0.9)))
  .labelDotRadius((s) => zs(s.kind === 'ice' ? 0.35 : s.kind === 'region' ? 0.3 : 0.45))
  .labelResolution(2)
  .labelColor((s) => (isHovered(s) ? '#ffffff' : s.kind === 'ice' ? ICE_COLORS[s.rating] : s.kind === 'region' ? (s.within_ice_range ? '#ff8a1f' : '#ffffff') : statusColor(s)))
  .labelLabel((s) => (s.kind === 'ice' ? craterTooltip(s)
    : s.kind === 'region' ? regionTooltip(s)
      : `<b>${esc(s.name)}</b><br>${esc(s.place)}<br>${esc(s.date)} · ${esc(s.status)}`))
  .onLabelClick((s) => (s.kind === 'ice' ? pickCrater(s)
    : s.kind === 'region' ? newSite(s.lat, s.lon, null, regionSiteExtra(s.index)) : pickCatalogSite(s)))
  .onLabelHover((s) => setHover(s ? { lat: s.lat, lng: s.lon, name: s.kind === 'region' ? `Search result ${s.name}` : s.name } : null))
  .onGlobeClick(({ lat, lng }) => newSite(lat, lng))
  // Sun and Earth markers (real directions from Horizons, not to scale)
  .htmlLat('lat')
  .htmlLng('lng')
  .htmlAltitude('alt')
  .htmlElement((d) => skyMarker(d))
  .htmlElementVisibilityModifier((el, visible) => {
    // The hover beacon's tag always shows; it says so when the site is behind the Moon.
    if (el.classList.contains('beacon-tag')) { el.style.opacity = '1'; el.classList.toggle('behind', !visible); return; }
    el.style.opacity = visible ? '1' : '0.25';
  });
// TODO (frontend): placeholder lander model at the active site via customLayerData.

// ---- Sun & Earth on the globe ----------------------------------------------------
// Horizons tells us where on the Moon the Sun and Earth are directly overhead
// (sub-solar / sub-Earth points). The globe is lit from the sub-solar direction,
// so day and night are real for the chosen time, and markers float above both points.

window.__globe = globe;   // handy for debugging in the browser console
const [ambientLight, sunLight] = globe.lights();
// The Moon's regolith is matte: no specular highlight (globe.gl's default Phong material is shiny).
{
  const m = globe.globeMaterial();
  m.specular?.set?.(0x000000);
  m.shininess = 0;
  m.needsUpdate = true;
}
const defaultLighting = { ambient: ambientLight.intensity, sun: sunLight.intensity, parent: null };

// North and south pole markers: a Cinzel letter in a home-plate-shaped badge whose point
// touches the pole (the badge sits above the North Pole and below the South Pole on screen).
const POLE_MARKERS = [
  { kind: 'pole', pole: 'N', name: 'North Pole', lat: 90, lng: 0, alt: 0.02 },
  { kind: 'pole', pole: 'S', name: 'South Pole', lat: -90, lng: 0, alt: 0.02 },
];
const poleData = () => (state.revealed ? POLE_MARKERS : []);

// Everything on the html layer: pole badges, Sun/Earth markers, and the hover beacon's name tag.
function refreshHtml() {
  const tag = state.hover && state.revealed
    ? [{ kind: 'beacon', lat: state.hover.lat, lng: state.hover.lng, alt: BEACON_ALT + 0.04, name: state.hover.name }]
    : [];
  globe.htmlElementsData([...poleData(), ...(state.skyMarkers ?? []), ...tag]);
}

function skyMarker(d) {
  if (d.kind === 'beacon') {
    const el = document.createElement('div');
    el.className = 'beacon-tag';
    el.textContent = d.name;
    return el;
  }
  if (d.kind === 'pole') {
    const el = document.createElement('div');
    el.className = `pole-marker ${d.pole === 'N' ? 'north' : 'south'}`;
    el.title = d.name;
    el.innerHTML = `<span class="pole-badge"><span class="pole-letter">${d.pole}</span></span>`;
    return el;
  }
  const el = document.createElement('div');
  el.className = `sky-marker ${d.kind}`;
  el.innerHTML = d.kind === 'sun'
    ? '<span class="glyph">☀️</span><span class="tag">Sun</span>'
    : '<span class="glyph">🌍</span><span class="tag">Earth</span>';
  el.title = d.kind === 'sun'
    ? `Sun is overhead at ${fmtLat(d.lat)}, ${fmtLon(d.lng)}`
    : `Earth is overhead at ${fmtLat(d.lat)}, ${fmtLon(d.lng)}`;
  return el;
}

function skyTime() {
  const s = state.current;
  return null;   // now
}

async function updateGlobeSky() {
  const t = skyTime();
  try {
    const res = await fetch(t ? `/sky/subpoints?time=${encodeURIComponent(t)}` : '/sky/subpoints');
    if (!res.ok) return;
    state.subpoints = await res.json();
  } catch {
    return;
  }
  applyGlobeSky();
}

function applyGlobeSky() {
  if (state.introLight) return;          // the opening shadow reveal owns the lights until the app shows
  const sub = state.subpoints;
  const real = $('real-sun').checked && sub;
  if (real) {
    // Detach the default camera-following light and point it from the sub-solar direction.
    if (!defaultLighting.parent) defaultLighting.parent = sunLight.parent;
    if (sunLight.parent !== globe.scene()) globe.scene().add(sunLight);
    const p = globe.getCoords(sub.sub_solar.lat, sub.sub_solar.lon, 20);
    sunLight.position.set(p.x, p.y, p.z);
    // The Sun is always within ~1.5° of the horizon at the poles, so with weak fill light
    // the polar craters sink into a few dark tones. Strong fill keeps the (photo's own)
    // crater detail readable; the direct Sun still makes day and night clearly different.
    sunLight.intensity = 2.3;
    ambientLight.intensity = 1.8;
    state.skyMarkers = state.revealed ? [
      { kind: 'sun', lat: sub.sub_solar.lat, lng: sub.sub_solar.lon, alt: 1.1 },
      { kind: 'earth', lat: sub.sub_earth.lat, lng: sub.sub_earth.lon, alt: 0.7 },
    ] : [];
    refreshHtml();
    const when = sub.time.replace('T', ' ').replace('Z', '');
    const src = /Horizons/.test(sub.source) && !/APPROXIMATE/.test(sub.source) ? 'JPL Horizons' : 'approximate model';
    $('sky-caption').textContent = `Lit for ${when} UTC (${src}). Markers show direction only, not distance or size.`;
  } else {
    if (defaultLighting.parent && sunLight.parent !== defaultLighting.parent) defaultLighting.parent.add(sunLight);
    sunLight.position.set(0, 1, 0);
    sunLight.intensity = defaultLighting.sun;
    ambientLight.intensity = defaultLighting.ambient;
    state.skyMarkers = [];
    refreshHtml();
    $('sky-caption').textContent = 'Even lighting, so every side of the Moon is easy to see.';
  }
}

// Re-size pins and labels when the zoom changes by more than ~8% (cheap: a few dozen objects).
function onCameraChange() {
  const alt = globe.pointOfView().altitude;
  const k = Math.min(1, Math.max(0.02, alt / ZOOM_REF_ALTITUDE));
  if (Math.abs(k - zoomScale) / zoomScale < 0.08) return;
  zoomScale = k;
  // New accessor functions make globe.gl rebuild the objects at the new size.
  globe.pointAltitude(pinAlt)
    .pointRadius(pinRadius)
    .ringMaxRadius(() => zs(PIN.ring)).ringPropagationSpeed(() => zs(PIN.ring * 1.4));
  globe.ringsData([...globe.ringsData()]);
  globe.labelSize(globe.labelSize()).labelDotRadius(globe.labelDotRadius());
  globe.labelsData([...globe.labelsData()]);
  globe.pointsData([...globe.pointsData()]);
}
globe.controls().addEventListener('change', onCameraChange);
if (typeof globe.onZoom === 'function') globe.onZoom(onCameraChange);   // also fires during fly-to animations

function resizeGlobe() {
  globe.width(globeEl.clientWidth).height(globeEl.clientHeight);
}
window.addEventListener('resize', resizeGlobe);
resizeGlobe();

// ---- Hover beacon -------------------------------------------------------------------------
// Hovering a site anywhere (globe label or pin, Sites list, search results, comparison) shows a
// white beam rising from it into space, its name at the top, and enlarges its label.
const isHovered = (s) => !!state.hover && Math.abs(s.lat - state.hover.lat) < 1e-6 && Math.abs((s.lon ?? s.lng) - state.hover.lng) < 1e-6;
function setHover(h) {
  const same = (a, b) => (!a && !b) || (a && b && a.lat === b.lat && a.lng === b.lng);
  if (same(h, state.hover)) return;
  state.hover = h;
  refreshPoints();
  refreshHtml();
  globe.labelsData([...globe.labelsData()]);
}

// Draw a site plan (GET /site/plan, via the 3D view) on the globe for the selected site.
function showPlanOnGlobe(site, plan) {
  state.planSite = site;
  const paths = [];
  if (plan.route?.latlon?.length > 1) {
    paths.push({ coords: plan.route.latlon, color: '#ffffff', stroke: 1.2, dash: 1, gap: 0,
      label: `Drivable route solar ↔ comms: ${(plan.route.drive_m / 1000).toFixed(1)} km` });
  }
  if (plan.ice) {
    if (plan.ice.route?.latlon?.length > 1) {
      paths.push({ coords: plan.ice.route.latlon, color: '#7fd0ff', stroke: 1.2, dash: 1, gap: 0,
        label: `Drivable route toward ${plan.ice.name ?? 'ice'}: ${(plan.ice.route.drive_m / 1000).toFixed(1)} km` });
    }
    paths.push({ coords: greatCircle(site.lat, site.lng, plan.ice.lat, plan.ice.lon), color: '#7fd0ff', stroke: 1,
      dash: 0.02, gap: 0.012,
      label: `Nearest ice: ${plan.ice.name ?? 'cold-trap cell'}, ${(plan.ice.distance_m / 1000).toFixed(1)} km (straight line)` });
  }
  globe.pathsData(paths);
}

// Points along the great circle between two lat/lon points (for the globe's paths layer).
function greatCircle(lat1, lon1, lat2, lon2, n = 64) {
  const u = (la, lo) => [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
  const r = Math.PI / 180;
  const a = u(lat1 * r, lon1 * r), b = u(lat2 * r, lon2 * r);
  const w = Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
  if (w < 1e-9) return [[lat1, lon1], [lat2, lon2]];
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n, s1 = Math.sin((1 - t) * w) / Math.sin(w), s2 = Math.sin(t * w) / Math.sin(w);
    const p = a.map((x, k) => s1 * x + s2 * b[k]);
    return [Math.asin(p[2]) / r, Math.atan2(p[1], p[0]) / r];
  });
}

function refreshPoints() {
  if (state.planSite && state.planSite !== state.current) { state.planSite = null; globe.pathsData([]); }
  const points = [...state.sites];
  if (state.current && !points.includes(state.current)) points.push(state.current);
  if (state.hover && state.revealed) points.push({ beacon: true, lat: state.hover.lat, lng: state.hover.lng, name: state.hover.name });
  globe.pointsData(points);
  globe.ringsData(state.current ? [state.current] : []);
}

function refreshLabels() {
  // Hidden during the opening sequence so only the Moon and the title show.
  const show = $('show-sites').checked && state.revealed;
  const craters = $('show-ice').checked && state.revealed && state.ice
    ? state.ice.craters.filter((c) => c.rating === 'known' || c.rating === 'likely')
      .map((c) => ({ ...c, kind: 'ice' }))
    : [];
  const ranks = state.revealed && state.search && $('show-heatmap').checked
    ? state.search.regions.filter((r) => r.passes_with_terrain).slice(0, 10)
      .map((r) => ({ ...r, kind: 'region', name: `#${state.search.regions.indexOf(r) + 1}`, index: state.search.regions.indexOf(r) }))
    : [];
  globe.labelsData([...(show ? state.catalog : []), ...craters, ...ranks]);
}

// ---- Ice in deep craters (GET /ice, api/ice.py) ------------------------------------------

const ICE_COLORS = { known: '#4da3ff', likely: '#a9cfff', possible: '#cfd8e3', unlikely: '#8a94a3' };
const ICE_RATING_TEXT = {
  known: 'Published ice evidence',
  likely: 'Likely cold trap: floor permanently shadowed and below −163 °C',
  possible: 'Possible: only one of permanent shadow / below −163 °C',
  unlikely: 'Unlikely: sunlit floor and warmer than −163 °C',
};

function craterTooltip(c) {
  const ev = c.evidence ? `<br><i>${esc(c.evidence.summary)}</i><br><span class="muted">${esc(c.evidence.citation)}</span>` : '';
  return `<b>${esc(c.name)}</b> · ${c.diameter_km} km wide, ~${(c.depth_m / 1000).toFixed(1)} km deep<br>` +
    `${esc(ICE_RATING_TEXT[c.rating])}<br>` +
    `Floor ${c.floor_shadowed ? 'never sees the Sun' : 'gets some sunlight'} · coldest daytime max ${c.coldest_tmax_k === null ? '—' : fmtC(c.coldest_tmax_k)}${ev}`;
}

function pickCrater(c) {
  const info = `${ICE_RATING_TEXT[c.rating]}. ${c.diameter_km} km wide, ~${(c.depth_m / 1000).toFixed(1)} km deep. ` +
    (c.evidence ? `${c.evidence.summary} (${c.evidence.citation})` : '');
  // Open the crater's deepest floor point: the spot that would hold ice.
  newSite(c.floor_lat, c.floor_lon, null, { name: `${c.name} (crater floor)`, info });
}

async function loadIce() {
  if (state.ice) return state.ice;
  $('sky-caption').textContent = 'Rating polar craters for ice… (first time takes ~10 s)';
  try {
    state.ice = await (await fetch('/ice')).json();
  } finally {
    $('sky-caption').textContent = '';
  }
  return state.ice;
}

async function onShowIce() {
  if ($('show-ice').checked) await loadIce();
  refreshLabels();
}

// ---- Map layers (NASA Moon Trek) ---------------------------------------------

async function loadLayers() {
  try {
    state.layers = await (await fetch('assets/moontrek/layers.json')).json();
  } catch {
    state.layers = {}; // not built yet: keep the fallback texture
  }
  const keys = Object.keys(state.layers);
  $('layer-buttons').innerHTML = keys
    .map((k) => `<button class="chip" data-layer="${k}" title="${esc(state.layers[k].source)}">${esc(shortLayerName(k))}</button>`)
    .join('') || '<p class="small muted">Run scripts/fetch_moontrek_layers.py to add Moon Trek layers.</p>';
  if (keys.includes('wac')) setLayer('wac');
}

function shortLayerName(key) {
  return { wac: 'Imagery', elevation: 'Elevation', slope: 'Slope', temperature: 'Max temp' }[key] ?? key;
}

function setLayer(key) {
  const layer = state.layers[key];
  if (!layer) return;
  state.layerKey = key;
  if (state.search && $('show-heatmap').checked) applyHeatmap();
  else globe.globeImageUrl(layer.file);
  // The bump map only reads well over imagery; colored data layers look muddy with it.
  globe.bumpImageUrl(key === 'wac' ? BUMP : null);
  document.querySelectorAll('#layer-buttons .chip').forEach((b) => b.classList.toggle('on', b.dataset.layer === key));
}

// ---- API ---------------------------------------------------------------------

// `mission: true` asks for the series over the mission (landing → mission end) instead of
// the analysis period; the 3D timelapse uses that when a landing has been chosen.
async function evaluateSite(site, { mission = false } = {}) {
  const body = { lat: site.lat, lon: site.lng };
  body.terrain_level = site.terrainLevel ?? 'global';
  if (!mission) {
    const per = site.period ?? state.period;      // comparison columns keep their own dates
    body.period_start = per.start;
    if (per.mode === 'range' && per.end) body.period_end = per.end;
  }

  showError(null);
  $('loading').hidden = false;
  try {
    const res = await fetch('/evaluate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json();

    if (res.status === 422) {
      const { detail } = await res.json();
      const msgs = Array.isArray(detail) ? detail.map((d) => `${d.loc.at(-1)}: ${d.msg}`) : [String(detail)];
      showError(msgs.join(' · '));
    } else if (res.status === 502) {
      const { detail } = await res.json();
      showError(String(detail));
    } else {
      showError('Evaluation failed, try again.');
    }
    return null;
  } finally {
    $('loading').hidden = true;
  }
}


async function loadCatalog() {
  state.catalog = await (await fetch('/sites')).json();
  $('site-filters').innerHTML = Object.entries(SITE_FILTERS)
    .map(([k, f]) => `<button class="chip" data-filter="${k}">${f.label}</button>`).join('');
  renderCatalog();
  refreshLabels();
}

// ---- Flow ----------------------------------------------------------------------

// `extra`: { name, info } for sites that aren't from the catalog (e.g. search results).
// `background: true` creates and evaluates the site without switching to it.
async function newSite(lat, lng, catalog = null, extra = {}, { background = false } = {}) {
  const site = {
    id: crypto.randomUUID(), lat, lng,
    name: catalog?.name ?? extra.name ?? null, catalog, info: extra.info ?? null, why: extra.why ?? null,
    lander: null,
    terrainLevel: 'global', result: null,
  };
  if (!background) {
    state.current = site;
    refreshPoints();
    render();
    updateGlobeSky();
    showTab('site');
    globe.pointOfView({ lat, lng, altitude: 1.6 }, 800);
  }
  const result = await evaluateSite(site);
  if (result) site.result = result;
  if (result && (state.current === site || background)) render();
  return site;
}


function pickCatalogSite(s) {
  newSite(s.lat, s.lon, s);
}

function selectSite(site) {
  state.current = site;
  if (site.period) { state.period = { ...site.period }; syncPeriodInputs(); }
  refreshPoints();
  render();
  showTab('site');
}

// ---- Tabs and collapsible panels -------------------------------------------------------

function showTab(name) {
  state.tab = name;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === name));
  document.querySelectorAll('.tab-body').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
}

function remember(key, value) {
  try { localStorage.setItem(`lunar-${key}`, value); } catch { /* storage unavailable */ }
}
function recall(key) {
  try { return localStorage.getItem(`lunar-${key}`); } catch { return null; }
}

function setPanelCollapsed(collapsed) {
  document.body.classList.toggle('panel-collapsed', collapsed);
  $('panel-toggle').textContent = collapsed ? '◀' : '▶';
  $('panel-toggle').title = collapsed ? 'Show panel' : 'Hide panel';
  remember('panel-collapsed', collapsed ? '1' : '0');
  setTimeout(resizeGlobe, 220);   // after the slide animation
}

function setBoxCollapsed(id, collapsed) {
  $(id).classList.toggle('collapsed', collapsed);
  remember(`collapsed-${id}`, collapsed ? '1' : '0');
}

// ---- Landing page + site finder ---------------------------------------------------------

function showLanding(show = true) {
  $('landing').hidden = !show;
  if (show) $('req-sun').focus();
  else if (!state.revealed) revealApp();
}

// ---- Opening sequence -------------------------------------------------------------------
// 1. Intro: close-up of the Moon slowly turning, "Lunarcy" fades in, "Press Enter to continue".
// 2. Landing page over the close-up (about a quarter of the Moon in view).
// 3. After the requirements (or "Skip"): zoom out to the whole Moon; the menus fade in.

const CLOSE_VIEW = { lat: -18, lng: 25, altitude: 1.35 };   // the Moon fills the height, shifted right (CSS) so the Earth fits on the left
const FULL_VIEW_ALTITUDE = 2.4;

// Opening shadow reveal: the Moon starts as a thin crescent and the shadow sweeps off it as the
// light swings from behind the Moon round to the viewer (like a phase from crescent to full).
// The light follows the slowly turning camera until the app is revealed.
// The Moon starts fully black beside a lit Earth; the title fades in on the same clock.
const REVEAL_DELAY_MS = 600;
const REVEAL_MS = 5000;
function startShadowReveal() {
  state.introLight = true;
  if (!defaultLighting.parent) defaultLighting.parent = sunLight.parent;
  globe.scene().add(sunLight);
  ambientLight.intensity = 0;
  sunLight.intensity = 3.4;
  const title = document.querySelector('.intro-title');
  const t0 = performance.now() + REVEAL_DELAY_MS;
  const step = (now) => {
    if (!state.introLight) return;
    const f = Math.min(1, Math.max(0, (now - t0) / REVEAL_MS));
    const e = f < 0.5 ? 4 * f * f * f : 1 - Math.pow(-2 * f + 2, 3) / 2;      // ease in-out
    const theta = ((180 - 158 * e) * Math.PI) / 180;    // angle between viewer and light, seen from the Moon
    ambientLight.intensity = 0.06 * e;                   // faint earthshine fills in as it lights up
    title.style.opacity = String(e);
    title.style.filter = `blur(${(12 * (1 - e)).toFixed(2)}px)`;
    const cam = globe.camera().position;
    const len = Math.hypot(cam.x, cam.y, cam.z) || 1;
    const v = [cam.x / len, cam.y / len, cam.z / len];
    // A direction perpendicular to the view, roughly "to the right": v × world-up, normalised.
    let side = [-v[2], 0, v[0]];
    const sl = Math.hypot(...side) || 1;
    side = side.map((x) => x / sl);
    const d = v.map((x, i) => x * Math.cos(theta) + side[i] * Math.sin(theta));
    sunLight.position.set(d[0] * 200, d[1] * 200 + 30, d[2] * 200);
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function endShadowReveal() {
  if (!state.introLight) return;
  state.introLight = false;
  applyGlobeSky();
}

function startIntro() {
  try { state.stopEarth = startIntroEarth($('intro-earth')); } catch (err) { console.warn('Intro Earth unavailable', err); }
  startShadowReveal();
  document.body.classList.add('intro-mode');
  globe.pointOfView(CLOSE_VIEW, 0);
  globe.controls().autoRotate = true;
  globe.controls().autoRotateSpeed = 0.25;
  $('intro').hidden = false;
  $('intro').focus();
}

function leaveIntro() {
  const intro = $('intro');
  if (intro.hidden || intro.classList.contains('leaving')) return;
  intro.classList.add('leaving');
  setTimeout(() => { intro.hidden = true; showChoice(true); }, 650);
}

// Start screen: "Explore the Moon" (straight to the app) or "Plan a mission" (requirements form).
function showChoice(show = true) {
  $('choice').hidden = !show;
  if (show) $('choice-plan').focus();
}

// The ice distance and its explanation only apply to the ice goal.
function syncGoalFields() {
  const ice = $('req-goal').value === 'ice_craters';
  $('ice-km-wrap').hidden = !ice;
  $('ice-note').hidden = !ice;
  $('req-ice-km').disabled = !ice;     // a hidden field must not block the form
}

function chooseExplore() {
  showChoice(false);
  showLanding(false);
  showTab(state.search ? 'search' : 'sites');
}

function choosePlan() {
  showChoice(false);
  showLanding(true);
}

function revealApp() {
  state.revealed = true;
  endShadowReveal();
  setTimeout(() => { state.stopEarth?.(); state.stopEarth = null; }, 1300);   // after the Earth fades out
  setTimeout(() => { document.body.classList.remove('globe-wide'); resizeGlobe(); }, 1700);  // after the slide back
  globe.controls().autoRotate = false;
  const pov = globe.pointOfView();
  globe.pointOfView({ lat: pov.lat, lng: pov.lng, altitude: FULL_VIEW_ALTITUDE }, 1600);
  document.body.classList.remove('intro-mode');   // menus fade in (CSS, 1 s)
  setTimeout(refreshLabels, 600);
  setTimeout(applyGlobeSky, 0);
}

async function onFind(e) {
  e.preventDefault();
  const body = {
    period_start: $('req-start').value,
    period_end: $('req-end').value,
    min_sun_pct: Number($('req-sun').value || 0),
    min_earth_pct: Number($('req-earth').value || 0),
    min_avg_w_m2: Number($('req-power').value || 0),
    max_slope_deg: Number($('req-slope').value || 90),
    region: $('req-region').value,
    goal: $('req-goal').value || null,      // '' = no goal: skip the ice check
    max_ice_km: Number($('req-ice-km').value || 50),
  };
  $('req-submit').disabled = true;
  $('req-status').className = 'small muted';
  $('req-status').textContent = 'Searching the whole Moon… (about 10–30 s; the first search for a new period asks JPL Horizons)';
  try {
    const res = await fetch('/find', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const out = await res.json();
    if (!res.ok) {
      const d = out.detail;
      throw new Error(Array.isArray(d) ? d.map((x) => x.msg).join(' · ') : String(d));
    }
    state.search = out;
    if (out.ice) { state.ice = out.ice; $('show-ice').checked = true; }
    else $('show-ice').checked = false;          // no goal: the ice check was skipped
    refreshLabels();
    remember('requirements', JSON.stringify(body));
    // The analysis period follows the mission dates, so site stats match the search.
    state.period = { mode: 'range', start: body.period_start, end: body.period_end };
    syncPeriodInputs();
    showLanding(false);
    setPanelCollapsed(false);            // results are in the right panel: always open it
    $('req-status').textContent = '';
    renderSearch();
    showTab('search');
    $('heatmap-toggle-wrap').hidden = false;
    $('show-heatmap').checked = true;
    applyHeatmap();
    // Re-evaluate the open site over the new period (comparison columns keep their own dates).
    await reevaluateCurrent();
    render();
  } catch (err) {
    $('req-status').className = 'small error';
    $('req-status').textContent = `Search failed: ${err.message}`;
  } finally {
    $('req-submit').disabled = false;
  }
}

function syncPeriodInputs() {
  const p = state.period;
  document.querySelector(`input[name="period-mode"][value="${p.mode}"]`).checked = true;
  $('period-start').value = p.start;
  $('period-end').value = p.end ?? '';
  $('period-end-wrap').hidden = p.mode !== 'range';
}

function renderSearch() {
  const s = state.search;
  $('search-empty').hidden = !!s;
  if (!s) { $('search-summary').innerHTML = ''; $('region-list').innerHTML = ''; return; }
  const c = s.criteria;
  const n = s.counts;
  const terrainNote = s.terrain.precomputed_skylines
    ? 'Terrain (LOLA skylines) counted everywhere.'
    : `Smooth-Moon screen; the top ${s.terrain.checked_in_stage2} regions were re-checked with LOLA terrain.`;
  const howTip = 'How the search works: every 0.5° cell of the Moon (about 15 km, 259,200 cells) is scored over your dates. ' +
    'JPL Horizons gives where the Sun and Earth are in the sky; each cell has a terrain skyline traced from NASA LOLA, so crater rims ' +
    'and mountains block them as they really would. A cell "meets" your mission if it clears every threshold; "marginal" if it is within ' +
    '85% of each. Touching cells are grouped into regions, and each region is shown by its best cell.' +
    (s.ice ? ' With the ice goal, suitable cells within your distance of an ice candidate (a permanently shadowed crater floor ' +
      'below −163 °C, or a crater with published ice evidence) are marked light blue and ranked first.' : '');
  $('search-summary').innerHTML =
    `<p><b>${esc(c.period_start)} → ${esc(c.period_end)}</b> · ${esc(c.region_label)} <span class="info-i" data-tip="${esc(howTip)}" tabindex="0">i</span></p>` +
    (c.goal_label ? `<p>Goal: <b>${esc(c.goal_label)}</b> · within ${c.max_ice_km} km of an ice candidate</p>` : '') +
    `<p>Needs ≥${c.min_sun_pct}% daylight · ≥${c.min_earth_pct}% Earth in view · ≥${c.min_avg_w_m2} W/m² average panel sunlight · slope ≤${c.max_slope_deg}°</p>` +
    (s.ice ? `<p class="muted">Ice candidates: ${s.ice.counts.known_craters} craters with published ice evidence, ` +
      `${s.ice.counts.likely_craters} more likely cold traps, ${s.ice.counts.likely_cells.toLocaleString()} grid cells both permanently shadowed and below ${fmtC(s.ice.ice_stable_k)}.</p>` : '') +
    `<p class="muted">${n.meeting_cells.toLocaleString()} of ${n.searched_cells.toLocaleString()} grid cells (0.5°, ~15 km) meet everything, ` +
    `about ${Math.round(n.meeting_area_km2).toLocaleString()} km² in ${n.regions} regions` +
    (s.ice ? `; ${n.ice_range_cells.toLocaleString()} of them (~${Math.round(n.ice_range_area_km2).toLocaleString()} km², light blue on the globe) are within ${c.max_ice_km} km of ice` : '') +
    `. ${terrainNote} Took ${s.seconds} s.</p>`;
  if (!s.regions.length) {
    $('region-list').innerHTML = `<li class="dim">No region meets all the requirements. Try loosening the one that's hardest:
      outside the polar peaks, daylight above ~50% of a month isn't possible.</li>`;
    return;
  }
  const lvl = (v, min) => (v >= min ? 'good' : v >= 0.85 * min ? 'warn' : 'bad');
  $('region-list').innerHTML = s.regions.map((r, i) => `
    <li data-region="${i}" class="${r.passes_with_terrain ? '' : 'dim'}">
      <div class="r-head">
        <span class="r-title"><b>${fmtLat(r.lat)}, ${fmtLon(r.lon)}</b> <span class="muted">· ${r.area_km2.toLocaleString()} km²</span></span>
        <button class="add secondary" data-add-region="${i}" title="Add to comparison">+ Compare</button>
      </div>
      <div class="stats">
        <span class="${lvl(r.sun_pct, c.min_sun_pct)}">☀️ ${r.sun_pct}%</span>
        <span class="${lvl(r.earth_pct, c.min_earth_pct)}">🌍 ${r.earth_pct}%</span>
        <span class="${lvl(r.avg_w_m2, c.min_avg_w_m2)}">⚡ ${r.avg_w_m2} W/m²</span>
        <span class="${r.slope_deg <= c.max_slope_deg ? 'good' : 'bad'}">⛰ ${r.slope_deg}°</span>
        ${r.ice_km !== undefined ? `<span class="${r.within_ice_range ? 'ice-ok' : 'bad'}" title="Distance to the nearest ice candidate">🧊 ${r.ice_km} km${r.within_ice_range ? '' : ' (out of range)'}</span>` : ''}
        ${r.passes_with_terrain ? '' : '<span class="bad">fails with terrain</span>'}
      </div>
      ${r.nearest_ice_crater ? `<div class="small muted">Nearest rated crater: <b>${esc(r.nearest_ice_crater.name)}</b>
        (${r.nearest_ice_crater.rating === 'known' ? 'published ice evidence' : 'likely cold trap'}), ${r.nearest_ice_crater.distance_km} km</div>` : ''}
      <button type="button" class="why-link" data-why="${i}" aria-expanded="false">Why this site?</button>
      <div class="why-text" hidden>${whyList(regionWhy(r, i, s))}</div>
    </li>`).join('');
}

// An explanation as a lead sentence plus a bullet list (one bullet per further sentence).
function whyList(text) {
  const [head, ...rest] = text.split(/(?<=\.) /);
  return `<p>${esc(head)}</p><ul>${rest.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>`;
}

// Why a search result was recommended, and why it ranks where it does.
function regionWhy(r, i, s) {
  const c = s.criteria;
  const margins = [
    ['daylight', (r.sun_pct - c.min_sun_pct) / Math.max(100 - c.min_sun_pct, 1), `${r.sun_pct}% (needs ≥${c.min_sun_pct}%)`],
    ['Earth in view', (r.earth_pct - c.min_earth_pct) / Math.max(100 - c.min_earth_pct, 1), `${r.earth_pct}% (needs ≥${c.min_earth_pct}%)`],
    ['panel sunlight', Math.min((r.avg_w_m2 - c.min_avg_w_m2) / Math.max(c.min_avg_w_m2, 50), 1), `${r.avg_w_m2} W/m² (needs ≥${c.min_avg_w_m2})`],
    ['slope', (c.max_slope_deg - r.slope_deg) / Math.max(c.max_slope_deg, 1), `${r.slope_deg}° (needs ≤${c.max_slope_deg}°)`],
  ];
  const tight = margins.reduce((a, b) => (b[1] < a[1] ? b : a));
  const parts = [
    `Why #${i + 1}: its best spot meets every requirement over ${c.period_start} → ${c.period_end}: ` +
      margins.map(([name, , txt]) => `${name} ${txt}`).join(', ') + '.',
    `Its tightest requirement is ${tight[0]}, at ${Math.round(100 * Math.max(tight[1], 0))}% of the way from "just meets it" to ideal.`,
  ];
  if (r.ice_km !== undefined) {
    parts.push(r.within_ice_range
      ? `It is ${r.ice_km} km from the nearest ice candidate (your limit is ${c.max_ice_km} km), so it is in the light-blue group, which ranks first.`
      : `The nearest ice candidate is ${r.ice_km} km away, beyond your ${c.max_ice_km} km limit, so it ranks after every ice-range region.`);
    if (r.nearest_ice_crater) {
      parts.push(`Nearest rated crater: ${r.nearest_ice_crater.name} (${r.nearest_ice_crater.rating === 'known' ? 'published ice evidence' : 'likely cold trap'}), ${r.nearest_ice_crater.distance_km} km.`);
    }
  }
  parts.push('Ranking: ' + (r.ice_km !== undefined ? 'ice-range regions first, then ' : '') +
    `the tightest margin, then area (${r.area_km2.toLocaleString()} km² here).`);
  parts.push(r.passes_with_terrain
    ? 'Checked against the real terrain skyline (NASA LOLA): still passes with crater rims and mountains counted.'
    : 'Fails once the local terrain skyline is counted (rims block the Sun or Earth), so it is dimmed.');
  return parts.join(' ');
}

function regionTooltip(r) {
  const ice = r.ice_km !== undefined ? ` · 🧊 ${r.ice_km} km to ice` : '';
  return `<b>Search result ${esc(r.name)}</b> · ${r.area_km2.toLocaleString()} km²<br>` +
    `☀️ ${r.sun_pct}% · 🌍 ${r.earth_pct}% · ⚡ ${r.avg_w_m2} W/m² · ⛰ ${r.slope_deg}°${ice}<br><span class="muted">Click to open</span>`;
}

function regionSiteExtra(i) {
  const r = state.search.regions[i];
  const ice = r.nearest_ice_crater ? ` · ${r.nearest_ice_crater.distance_km} km from ${r.nearest_ice_crater.name}` : '';
  return { name: `Search result #${i + 1}`, info: `Best spot of a ${r.area_km2.toLocaleString()} km² region from the site finder${ice}`,
    why: regionWhy(r, i, state.search) };
}

// Heatmap: three colours over the current globe texture.
//   light blue = meets every requirement and is within the set range of ice (class 3)
//   green      = meets every requirement, no ice within range (class 2)
//   yellow     = marginal: within 85% of every threshold (class 1)
// Each cell is drawn as a disc HEAT_DISC_KM in radius on the ground (an ellipse stretched by
// 1/cos(lat) on the map), so areas come out round and smooth even at the poles, where 0.5°
// cells are thin wedges, and a single suitable cell still shows. A white outline runs around
// every suitable area (blue or green): the same discs drawn a little larger underneath.
const HEAT = {
  ice: 'rgb(120, 205, 255)',
  suitable: 'rgb(50, 220, 110)',
  marginal: 'rgb(255, 205, 0)',
  outline: '#ffffff',
};
const HEAT_DISC_KM = 9;
const HEAT_OUTLINE_KM = 3.5;

async function applyHeatmap() {
  const s = $('show-heatmap').checked ? state.search : null;
  const base = state.layers[state.layerKey]?.file ?? FALLBACK_TEXTURE;
  if (!s) { globe.globeImageUrl(base); return; }
  const img = await loadImage(base);
  const W = Math.max(img.naturalWidth, 4096), H = W / 2;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0, W, H);

  const { nlat, nlon, res_deg: res, lat0, lon0 } = s.grid;
  const cls = Uint8Array.from(atob(s.grid.classes_b64), (ch) => ch.charCodeAt(0));
  const cellsOf = (test) => {
    const out = [];
    for (let i = 0; i < cls.length; i++) if (test(cls[i])) out.push([lat0 + Math.floor(i / nlon) * res, lon0 + (i % nlon) * res]);
    return out;
  };

  // Outside the search area: darken (big uniform areas, so plain cells are fine here).
  const small = document.createElement('canvas'); small.width = nlon; small.height = nlat;
  const sg = small.getContext('2d');
  const data = sg.createImageData(nlon, nlat);
  for (let i = 0; i < cls.length; i++) {
    if (cls[i] !== 255) continue;
    const r = Math.floor(i / nlon), col = i % nlon;
    data.data[((nlat - 1 - r) * nlon + col) * 4 + 3] = 120;
  }
  sg.putImageData(data, 0, 0);
  g.imageSmoothingEnabled = true;
  g.drawImage(small, 0, 0, W, H);

  // Marginal (yellow), then the suitable layer (outline, green, blue) on top.
  const layer = () => { const l = document.createElement('canvas'); l.width = W; l.height = H; return l; };
  const marginal = layer();
  drawDiscs(marginal.getContext('2d'), cellsOf((v) => v === 1), HEAT_DISC_KM, HEAT.marginal, W, H);
  g.globalAlpha = 0.5; g.drawImage(marginal, 0, 0);
  const suit = layer(), sc = suit.getContext('2d');
  drawDiscs(sc, cellsOf((v) => v === 2 || v === 3), HEAT_DISC_KM + HEAT_OUTLINE_KM, HEAT.outline, W, H);
  drawDiscs(sc, cellsOf((v) => v === 2), HEAT_DISC_KM, HEAT.suitable, W, H);
  drawDiscs(sc, cellsOf((v) => v === 3), HEAT_DISC_KM, HEAT.ice, W, H);
  g.globalAlpha = 0.72; g.drawImage(suit, 0, 0);
  g.globalAlpha = 1;
  globe.globeImageUrl(c.toDataURL('image/jpeg', 0.9));
}

// Fill a disc of radius_km around each [lat, lon] on an equirectangular canvas. On the map a
// disc is an ellipse widened by 1/cos(lat); copies are drawn across the ±180° seam, and a disc
// that reaches a pole fills the whole cap beyond it.
function drawDiscs(g, cells, radiusKm, color, W, H) {
  const kmPerDeg = (1737.4 * Math.PI) / 180;
  const pxPerDegY = H / 180, pxPerDegX = W / 360;
  g.fillStyle = color;
  g.beginPath();
  for (const [lat, lon] of cells) {
    const rDeg = radiusKm / kmPerDeg;
    const x = (lon + 180) * pxPerDegX, y = (90 - lat) * pxPerDegY;
    const ry = rDeg * pxPerDegY;
    const cos = Math.cos((lat * Math.PI) / 180);
    const rx = Math.min((rDeg / Math.max(cos, 1e-3)) * pxPerDegX, W / 2);
    for (const dx of [0, -W, W]) {
      if (x + dx + rx < 0 || x + dx - rx > W) continue;
      g.moveTo(x + dx + rx, y);
      g.ellipse(x + dx, y, rx, ry, 0, 0, 2 * Math.PI);
    }
    if (90 - Math.abs(lat) < rDeg) {                          // the disc covers the pole
      const yPole = lat < 0 ? H : 0;
      g.rect(0, Math.min(y, yPole), W, Math.abs(yPole - y));
    }
  }
  g.fill('nonzero');
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => resolve(im);
    im.onerror = reject;
    im.src = src;
  });
}

async function onOpen3d(initialT = 0) {
  const site = state.current;
  if (!site?.result) return;
  const landed = false;              // the app no longer picks a lander or landing time
  const result = site.result;
  open3dView({
    title: site.name ?? 'Custom site',
    lat: site.lat,
    lon: site.lng,
    result,
    landed,
    level: site.terrainLevel ?? 'global',
    initialT,
    onPlan: (plan) => { if (state.current === site) showPlanOnGlobe(site, plan); },
  });
}

// ---- Analysis period ----------------------------------------------------------------

// Human text for a response's `period` block.
function periodText(p) {
  const d = (iso) => iso.slice(0, 10);
  const lastDay = new Date(Date.parse(p.end) - 1).toISOString().slice(0, 10);
  if (p.kind === 'day') return `${d(p.start)} (24 h, UTC)`;
  if (p.kind === 'mission') return `the mission, ${p.start.replace('T', ' ').replace('Z', '')} UTC + ${(p.hours / 24).toFixed(0)} days`;
  if (p.kind === 'lunar_day') return `the next lunar day from ${d(p.start)}`;
  return `${d(p.start)} → ${lastDay} (${(p.hours / 24).toFixed(0)} days, UTC)`;
}

async function onPeriodChange() {
  const mode = document.querySelector('input[name="period-mode"]:checked').value;
  const start = $('period-start').value;
  let end = $('period-end').value;
  $('period-end-wrap').hidden = mode !== 'range';
  if (!start) return;
  if (mode === 'range') {
    if (!end || end < start) { end = start; $('period-end').value = start; }
  }
  state.period = { mode, start, end: mode === 'range' ? end : null };
  await reevaluateCurrent();
  render();
}

// The open site follows the Period bar. If it is a comparison column, a copy is opened instead,
// so the column keeps its own dates ("Add to comparison" then adds the new dates as a new column).
async function reevaluateCurrent() {
  let site = state.current;
  if (!site) return;
  if (state.sites.includes(site)) {
    site = { ...site, id: crypto.randomUUID(), period: null, result: null };
    state.current = site;
    refreshPoints();
  } else {
    site.period = null;
  }
  const r = await evaluateSite(site);
  if (r) site.result = r;
}

// Step the dates by a number of days (keeps a range's length).
function shiftPeriod(days) {
  const add = (iso) => new Date(Date.parse(iso) + days * 864e5).toISOString().slice(0, 10);
  const p = state.period;
  $('period-start').value = add(p.start);
  if (p.mode === 'range' && p.end) $('period-end').value = add(p.end);
  onPeriodChange();
}

const periodKey = (p) => `${p.mode}:${p.start}:${p.end ?? ''}`;
const scenarioKey = (s, p) => `${s.lat.toFixed(4)},${s.lng.toFixed(4)}|${periodKey(p)}`;
const inComparison = (site) => state.sites.some((c) => scenarioKey(c, c.period ?? state.period) === scenarioKey(site, site.period ?? state.period));
const periodShort = (p) => (p.mode === 'range' && p.end && p.end !== p.start ? `${p.start} → ${p.end}` : `${p.start} (1 day)`);

// "Add to comparison": a column is a site AND its dates, so the same site can be compared
// against itself on other dates.
function onAddToComparison() {
  const site = state.current;
  if (!site?.result || inComparison(site)) return;
  const col = { ...site, id: crypto.randomUUID(), period: { ...(site.period ?? state.period) } };
  state.sites.push(col);
  state.current = col;
  refreshPoints();
  render();
}

// ---- Sky & horizon panel, best dates, nearby alternatives, sharing ----------------------

const skyPanel = new SkyPanel($('sky-panel'), {
  onEnlarge: () => openSkyModal(),
  onTime: (i) => { if (bigSky) bigSky.setTime(i); },
});
let bigSky = null;

async function skylineFor(site) {
  if (site.skyline) return site.skyline;
  try {
    const q = new URLSearchParams({ lat: site.lat, lon: site.lng, level: site.terrainLevel ?? 'global' });
    site.skyline = (await (await fetch(`/terrain/horizon?${q}`)).json()).elevation_deg;
  } catch { site.skyline = null; }
  return site.skyline;
}

// Called by render(): keep the sky panel and the insight boxes in step with the open site.
async function updateInsights(site, r) {
  if (!r) { $('sky-panel').innerHTML = ''; skyPanel.r = null; return; }
  if (skyPanel.r !== r) {
    const skyline = await skylineFor(site);
    if (state.current !== site || site.result !== r) return;     // moved on while loading
    skyPanel.set(r, skyline);
  }
  const key = `${site.lat},${site.lng}|${periodKey(site.period ?? state.period)}`;
  if (state.nearbyKey !== key) {
    state.nearbyKey = key;
    $('nearby-out').innerHTML = '<span class="muted">Open to check every point within 3 km for the same dates (a few seconds).</span>';
    if ($('nearby-box').open) loadNearby();
  }
  if (state.datesKey !== `${site.lat},${site.lng}`) {
    state.datesKey = `${site.lat},${site.lng}`;
    $('dates-out').innerHTML = '';
  }
}

function openSkyModal() {
  const site = state.current;
  if (!site?.result) return;
  $('sky-modal').hidden = false;
  $('sky-modal-title').textContent = `${site.name ?? 'Custom site'} · ${fmtLat(site.lat)}, ${fmtLon(site.lng)} · ${periodText(site.result.period)}`;
  bigSky?.destroy();
  bigSky = new SkyPanel($('sky-panel-big'), { large: true, onTime: (i) => skyPanel.setTime(i) });
  bigSky.set(site.result, site.skyline, skyPanel.t);
}
function closeSkyModal() {
  $('sky-modal').hidden = true;
  bigSky?.destroy();
  bigSky = null;
  $('sky-panel-big').innerHTML = '';
}

// Best landing dates at the open site (GET /site/dates).
async function onFindDates() {
  const site = state.current;
  if (!site) return;
  const mission = Math.min(60, Math.max(1, Number($('dates-mission').value) || 14));
  const days = Math.min(366, Math.max(7, Number($('dates-days').value) || 60));
  const start = (site.period ?? state.period).start;
  const q = new URLSearchParams({ lat: site.lat, lon: site.lng, start, days, mission_days: mission, priority: $('dates-priority').value });
  $('dates-btn').disabled = true;
  $('dates-out').innerHTML = '<span class="muted">Scoring every hour as a touchdown time… (the first search for a new span asks JPL Horizons)</span>';
  try {
    const res = await fetch(`/site/dates?${q}`);
    const out = await res.json();
    if (!res.ok) throw new Error(typeof out.detail === 'string' ? out.detail : `HTTP ${res.status}`);
    if (state.current !== site) return;
    renderDates(out);
  } catch (err) {
    $('dates-out').innerHTML = `<span class="error">Date search failed: ${esc(err.message)}</span>`;
  } finally {
    $('dates-btn').disabled = false;
  }
}

function renderDates(out) {
  const scoreName = { both: 'average of Sun % and Earth %', sun: 'Sun %', comms: 'Earth %' }[out.priority];
  const col = (v) => (v >= 75 ? 'rgba(76,209,138,.85)' : v >= 50 ? 'rgba(255,204,77,.85)' : 'rgba(255,107,107,.75)');
  const why = `${out.method} Score = ${scoreName}; a touchdown with the Sun behind terrain loses 5 points, because a ` +
    'lander needs light to start up. Each bar is one day at its best hour; taller is better. Click a bar or a pick to load those dates.';
  const strip = out.daily.map((d) => `<span data-date="${d.date}" style="height:${Math.max(4, d.score)}%;background:${col(d.score)}"
      data-tip="${d.date}: best touchdown ${d.time.slice(11, 16)} UTC · Sun ${d.sun_pct}% · Earth ${d.earth_pct}% · both ${d.both_pct}% over ${out.mission_days} days"></span>`).join('');
  const picks = out.best.map((d, i) => `<li data-date="${d.date}">
      <b>#${i + 1} ${d.date}</b> ${d.time.slice(11, 16)} UTC · Sun ${d.sun_pct}% · Earth ${d.earth_pct}% · both ${d.both_pct}%
      <span class="muted">· ${d.sun_up_at_touchdown ? (d.hours_to_sunset === null ? 'Sun stays up all mission' : `Sun sets after ${d.hours_to_sunset < 48 ? d.hours_to_sunset + ' h' : (d.hours_to_sunset / 24).toFixed(1) + ' days'}`) : 'lands in darkness'}</span></li>`).join('');
  state.datesMission = out.mission_days;
  $('dates-out').innerHTML = `
    <div class="muted" style="margin-top:6px">Each day's best touchdown over the next ${out.days} days, for a ${out.mission_days}-day mission
      <span class="info-i" data-tip="${esc(why)}" tabindex="0">i</span></div>
    <div class="date-strip">${strip}</div>
    <div class="date-axis"><span>${out.daily[0].date}</span><span>${out.daily.at(-1).date}</span></div>
    <ol class="date-picks">${picks}</ol>`;
}

function applyDates(dateIso) {
  const days = Math.max(1, Math.round(state.datesMission ?? 14));
  const end = new Date(Date.parse(dateIso) + (days - 1) * 864e5).toISOString().slice(0, 10);
  document.querySelector('input[name="period-mode"][value="range"]').checked = true;
  $('period-start').value = dateIso;
  $('period-end').value = end;
  onPeriodChange();
}

// Nearby alternatives: every point within 3 km, same dates (GET /site/nearby).
async function loadNearby() {
  const site = state.current;
  if (!site) return;
  const per = site.period ?? state.period;
  const q = new URLSearchParams({ lat: site.lat, lon: site.lng, start: per.start });
  if (per.mode === 'range' && per.end && per.end !== per.start) q.set('end', per.end);   // one day → a lunar day
  const key = state.nearbyKey;
  $('nearby-out').innerHTML = '<span class="muted">Tracing a terrain skyline for 81 points around the site…</span>';
  try {
    const res = await fetch(`/site/nearby?${q}`);
    const out = await res.json();
    if (!res.ok) throw new Error(typeof out.detail === 'string' ? out.detail : `HTTP ${res.status}`);
    if (state.nearbyKey !== key) return;
    renderNearby(out);
  } catch (err) {
    $('nearby-out').innerHTML = `<span class="error">Nearby check failed: ${esc(err.message)}</span>`;
  }
}

function renderNearby(out) {
  const compass = (deg) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];
  const km = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);
  const c = (out.n - 1) / 2;
  const grid = (key, rgb, label) => {
    const cells = [];
    for (let r = 0; r < out.n; r++) {
      for (let k = 0; k < out.n; k++) {
        const v = out[key][r][k];
        const de = (k - c) * out.spacing_m, dn = (c - r) * out.spacing_m;
        const where = r === c && k === c ? 'the site itself' : `${km(Math.hypot(de, dn))} ${compass((Math.atan2(de, dn) * 180 / Math.PI + 360) % 360)}`;
        const best = key === 'sun_pct' ? out.best_sun : out.best_earth;
        const isBest = Math.abs(out.lat[r][k] - best.lat) < 1e-5 && Math.abs(out.lon[r][k] - best.lon) < 1e-5;
        cells.push(`<span class="${r === c && k === c ? 'centre' : isBest ? 'best' : ''}" data-lat="${out.lat[r][k]}" data-lon="${out.lon[r][k]}"
          style="background:rgba(${rgb},${(0.08 + 0.92 * v / 100).toFixed(2)})"
          data-tip="${where}: Sun ${out.sun_pct[r][k]}% · Earth ${out.earth_pct[r][k]}% · slope ${out.slope_deg[r][k]}°. Click to open."></span>`);
      }
    }
    return `<figure><figcaption>${label}</figcaption><div class="nearby-grid" style="grid-template-columns:repeat(${out.n},1fr)">${cells.join('')}</div></figure>`;
  };
  const b = out.best_both;
  const why = `${out.method} The magenta square is the site; white marks the best point for each measure.`;
  $('nearby-out').innerHTML = `
    <div>Within ${out.radius_m / 1000} km, sunlight ranges <b>${out.spread.sun_pct[0]}–${out.spread.sun_pct[1]}%</b> and
      Earth in view <b>${out.spread.earth_pct[0]}–${out.spread.earth_pct[1]}%</b> (site: ${out.centre.sun_pct}% / ${out.centre.earth_pct}%).
      <span class="info-i" data-tip="${esc(why)}" tabindex="0">i</span></div>
    <div class="nearby-grids">${grid('sun_pct', '255,210,63', 'Sunlight %')}${grid('earth_pct', '111,182,255', 'Earth in view %')}</div>
    <div>${b.distance_m < 1 ? '<b>This site is already the best spot within 3 km</b> for Sun and Earth together.'
      : `Best for both: <b>${km(b.distance_m)} ${compass(b.bearing_deg)}</b> · Sun ${b.sun_pct}% · Earth ${b.earth_pct}% · slope ${b.slope_deg}°
      <button type="button" class="chip" id="nearby-go" data-lat="${b.lat}" data-lon="${b.lon}">Open it</button>`}</div>
    <div class="muted">${out.n}×${out.n} points, ${out.spacing_m} m apart. North is up. Click any square to open that spot.</div>`;
}

// Share: the site and its dates in the address (#lat=..&lon=..&from=..&to=..&name=..).
function shareUrl(site) {
  const per = site.period ?? state.period;
  const p = new URLSearchParams({ lat: site.lat.toFixed(5), lon: site.lng.toFixed(5), from: per.start });
  if (per.mode === 'range' && per.end) p.set('to', per.end);
  if (site.name) p.set('name', site.name);
  return `${location.origin}${location.pathname}#${p}`;
}
async function onShare() {
  const site = state.current;
  if (!site) return;
  const url = shareUrl(site);
  history.replaceState(null, '', url);
  try { await navigator.clipboard.writeText(url); $('share-btn').textContent = 'Link copied ✓'; }
  catch { $('share-btn').textContent = 'Link is in the address bar ✓'; }
  setTimeout(() => { $('share-btn').textContent = 'Copy a link to this site and dates'; }, 2500);
}
function readShare() {
  const p = new URLSearchParams(location.hash.slice(1));
  const lat = Number(p.get('lat')), lon = Number(p.get('lon'));
  if (!p.has('lat') || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const okDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d ?? '');
  return { lat, lon, from: okDate(p.get('from')) ? p.get('from') : null, to: okDate(p.get('to')) ? p.get('to') : null, name: p.get('name') };
}
function openShared(sh) {
  $('intro').hidden = true;
  if (sh.from) {
    state.period = sh.to && sh.to >= sh.from ? { mode: 'range', start: sh.from, end: sh.to } : { mode: 'day', start: sh.from, end: null };
  }
  syncPeriodInputs();
  revealApp();
  setPanelCollapsed(false);            // a shared link is about the site: show its panel
  newSite(sh.lat, sh.lon, null, sh.name ? { name: sh.name } : {});
}

// Compare tab: export as CSV, and re-run every column for the Period bar's dates.
function exportCompareCsv() {
  const rows = [...$('compare-table').querySelectorAll('tr')].map((tr) => [...tr.children].map((c) => {
    const t = c.cloneNode(true);
    t.querySelectorAll('button').forEach((b) => b.remove());
    t.querySelectorAll('br').forEach((br) => br.replaceWith(' '));
    return `"${t.textContent.trim().replace(/\s+/g, ' ').replace(/"/g, '""')}"`;
  }).join(','));
  downloadText('lunarcy-comparison.csv', rows.join('\n'));
}
async function syncCompareDates() {
  await Promise.all(state.sites.map(async (col) => {
    col.period = { ...state.period };
    col.result = null;
    renderCompareList();
    const r = await evaluateSite(col);
    if (r) col.result = r;
  }));
  // Drop duplicates the sync may have created (same site, now same dates).
  const seen = new Set();
  state.sites = state.sites.filter((c) => { const k = scenarioKey(c, c.period); if (seen.has(k)) return false; seen.add(k); return true; });
  refreshPoints();
  render();
}

// ---- Rendering -----------------------------------------------------------------

const COMPARE_PIN = '#e6e6e6';      // sites in the comparison list (the selected one is magenta)

function renderCatalog() {
  const test = SITE_FILTERS[state.filter].test;
  document.querySelectorAll('#site-filters .chip').forEach((b) => b.classList.toggle('on', b.dataset.filter === state.filter));
  $('site-list').innerHTML = state.catalog.filter(test).map((s) => `
    <li data-site="${esc(s.id)}">
      <span class="dot" style="background:${statusColor(s)}"></span>
      <b>${esc(s.name)}</b> <span class="muted">${esc(s.date)}</span><br>
      <span class="small muted">${esc(s.place)} · ${fmtLat(s.lat)}, ${fmtLon(s.lon)}${s.precision === 'region' ? ' (approx.)' : ''}</span>
    </li>`).join('');
}

// Sun/Earth status: "right now" if now falls in the analysis period, otherwise at its start,
// with the next rise/set inside the period.
function skyNow(r) {
  const now = Date.now();
  const start = Date.parse(r.period.start), end = Date.parse(r.period.end);
  const live = now >= start && now < end;
  const ref = live ? now : start;
  const when = (iso) => {
    if (!iso) return null;
    if (live) {
      const h = (Date.parse(iso) - now) / 3600e3;
      return `in ${h < 48 ? `${h.toFixed(0)} h` : `${(h / 24).toFixed(1)} days`}`;
    }
    return `at ${iso.replace('T', ' ').replace('Z', '')} UTC`;
  };
  const idx = Math.max(0, Math.min(r.sky.length - 1, Math.round((ref - start) / 3600e3)));
  const at = r.sky[idx];
  const ev = r.events;   // first rise/set in the period; already accounts for terrain
  const status = (name, el, visible) => (visible
    ? `${name} up (${el.toFixed(1)}°)`
    : el > 0 ? `${name} behind terrain (${el.toFixed(1)}° up, but below the skyline)` : `${name} below the horizon`);
  const rest = ' all period';
  const sunText = `☀️ ${status('Sun', at.sun_el, at.sun_visible)}` + (at.sun_visible
    ? (ev.sunset ? ` · sets ${when(ev.sunset)}` : rest)
    : (ev.sunrise ? ` · appears ${when(ev.sunrise)}` : rest));
  const earthText = `🌍 ${status('Earth', at.earth_el, at.earth_visible)}` + (at.earth_visible
    ? (ev.earthset ? ` · sets ${when(ev.earthset)}` : rest)
    : (ev.earthrise ? ` · appears ${when(ev.earthrise)}` : rest));
  const head = live ? '' : `<div class="muted small">At the start of the period (${r.period.start.replace('T', ' ').replace('Z', '')} UTC):</div>`;
  return `${head}<div>${sunText}</div><div>${earthText}</div>`;
}

function render() {
  const site = state.current;
  const r = site?.result;
  $('hint').hidden = !!site;
  $('site-section').hidden = !site;
  renderCompareList();
  if (!site) return;

  // Site header, metadata and external tool links (work before /evaluate returns).
  const c = site.catalog;
  $('site-title').innerHTML = `${esc(site.name ?? 'Custom site')} <span class="muted">${fmtLat(site.lat)}, ${fmtLon(site.lng)}</span>`;
  $('site-meta').innerHTML = c
    ? `${esc(c.agency)} · ${esc(c.date)} · ${esc(c.status)} · ${esc(c.place)}` +
      (c.note ? `<br><span class="muted">${esc(c.note)}</span>` : '')
    : site.info ? `<span class="muted">${esc(site.info)}</span>` : '';
  // Why the finder recommended this site (search results): the same reasoning as the list's "i".
  $('site-why').hidden = !site.why;
  if (site.why) $('site-why').innerHTML = `<summary>Why this site was recommended</summary>${whyList(site.why)}`;
  const start = r?.sky?.[0]?.t ?? new Date().toISOString();
  const altKm = (r?.terrain?.site_elevation_m ?? 0) / 1000;
  $('site-links').innerHTML = [
    `<a href="${quickmapUrl(site.lat, site.lng)}" target="_blank" rel="noopener">QuickMap ↗</a>`,
    `<a href="${moontrekUrl(site.lat, site.lng)}" target="_blank" rel="noopener">Moon Trek ↗</a>`,
    `<a href="${horizonsUrl(site.lat, site.lng, '10', start, 30, altKm)}" target="_blank" rel="noopener">Horizons: Sun ↗</a>`,
    `<a href="${horizonsUrl(site.lat, site.lng, '399', start, 30, altKm)}" target="_blank" rel="noopener">Horizons: Earth ↗</a>`,
    c ? `<a href="${esc(c.source)}" target="_blank" rel="noopener">Site source ↗</a>` : '',
  ].join('');

  if (!r) {
    $('sky-now').innerHTML = '';
    $('site-tiles').innerHTML = '';
    $('site-terrain').innerHTML = '';
    $('view3d-btn').disabled = true;
    $('compare-btn').disabled = true;
    updateInsights(site, null);
    return;
  }

  // Terrain level, its source, and the elevation Horizons was given.
  const t = r.terrain;
  const detailed = t.level === 'detailed';
  const placeholder = /PLACEHOLDER/.test(t.heights_source);
  $('site-terrain').innerHTML =
    `<span class="badge ${detailed ? 'pass' : 'level'}">${detailed ? 'Detailed terrain' : 'Global estimate'}</span> ` +
    `<span class="muted">${placeholder ? 'PLACEHOLDER terrain' : `NASA LOLA, ~${t.resolution_m.toFixed(0)} m pixels`}` +
    ` · skyline up to ${t.skyline_max_deg.toFixed(1)}°</span>`;
  $('site-terrain').title = `Horizons is given the site's LOLA elevation (${t.site_elevation_m.toFixed(0)} m) as its altitude.`;

  // Sun and Earth right now, plus time to the next rise/set.
  $('sky-now').innerHTML = skyNow(r);

  // Site stats (terrain-aware, with the smooth-horizon value for comparison)
  const s = r.site;
  const temp = s.temp_range_k ? `${fmtC(s.temp_range_k[0])} to ${fmtC(s.temp_range_k[1])}` : '—';
  const vsFlat = (v, flat) => (Math.abs(v - flat) >= 0.5 ? `<div class="sub">flat horizon: ${flat.toFixed(0)}%</div>` : '');
  const vsFlatH = (v, flat) => (Math.abs(v - flat) >= 0.1 ? ` · flat horizon: ${flat.toFixed(1)} h` : '');
  const rating = rateStats(site, r);
  const peakSun = Math.max(...r.power_w.map((p) => p.w_m2));
  const day = r.period.kind === 'day';
  const H = r.period.hours;
  const sunTile = day
    ? ['Daylight (24 h)', `${s.sun_hours.toFixed(1)} h`, `<div class="sub">${(H - s.sun_hours).toFixed(1)} h dark${vsFlatH(s.sun_hours, s.sun_hours_flat)}</div>`, rating.sunlight]
    : ['Sunlight', fmt(s.sunlight_pct, 0, '%'), `<div class="sub">${s.sun_hours.toFixed(0)} of ${H} h</div>` + vsFlat(s.sunlight_pct, s.sunlight_pct_flat), rating.sunlight];
  const earthTile = day
    ? ['Earth in view (24 h)', `${s.earth_hours.toFixed(1)} h`, `<div class="sub">${(H - s.earth_hours).toFixed(1)} h out of view${vsFlatH(s.earth_hours, s.earth_hours_flat)}</div>`, rating.earth]
    : ['Earth visible', fmt(s.earth_visible_pct, 0, '%'), `<div class="sub">${s.earth_hours.toFixed(0)} of ${H} h</div>` + vsFlat(s.earth_visible_pct, s.earth_visible_pct_flat), rating.earth];
  $('site-period').textContent = `Stats for ${periodText(r.period)}`;
  const tiles = [
    sunTile,
    earthTile,
    ['Slope', fmt(s.slope_deg, 1, '°'), s.slope_baseline_m ? `<div class="sub">over ${s.slope_baseline_m.toFixed(0)} m</div>` : '', rating.slope],
    ['Elevation', fmt(s.elevation_m, 0, ' m'), '', rating.elevation],
    ['Temperature', temp, `<div class="sub">${realTemps(r) ? 'night low – day high (Diviner)' : 'placeholder'}</div>`, rating.temperature],
    ['Peak sunlight on panel', fmt(peakSun, 0, ' W/m²'), '<div class="sub">flat panel, per m²</div>', rating.sun_m2],
    (() => {
      const up = r.sky.filter((p) => p.sun_visible);
      const avg = up.length ? up.reduce((a, p) => a + p.sun_el, 0) / up.length : null;
      const maxEl = Math.max(...r.sky.map((p) => p.sun_el));
      return ['Sun elevation', `max ${maxEl.toFixed(1)}°`,
        `<div class="sub">${avg === null ? 'never in view' : `avg ${avg.toFixed(1)}° while in view`}</div>`, rating.sun_el];
    })(),
  ];
  $('site-tiles').innerHTML = tiles
    .map(([k, v, sub, rt]) => `<div class="tile ${rt.level}" style="--fill:${(100 * (rt.fill ?? 0)).toFixed(0)}%" ` +
      `data-tip="${esc(rt.why)}" tabindex="0"><div class="k">${k} <span class="info-i" aria-hidden="true">i</span></div>` +
      `<div class="v">${esc(v)}</div>${sub}</div>`)
    .join('') + (s.slope_deg === null ? '<p class="small muted">No terrain data here.</p>' : '');
  $('compare-btn').disabled = inComparison(site);
  $('compare-btn').textContent = inComparison(site) ? 'In comparison ✓' : 'Add these dates to comparison';

  $('view3d-btn').disabled = false;
  updateInsights(site, r);

  // Sources
  $('sources-box').hidden = r.sources.length === 0;
  $('sources').innerHTML = r.sources
    .map((src) => (src.startsWith('http') ? `<li><a href="${esc(src)}" target="_blank" rel="noopener">${esc(src)}</a></li>` : `<li>${esc(src)}</li>`))
    .join('');
}

// Compare tab: a vertical table. Rows are the values, columns are the sites, so it fits
// the side panel. Every site uses the same analysis period, so the numbers are like-for-like.
function renderCompareList() {
  const has = state.sites.length > 0;
  $('compare-count').textContent = has ? `(${state.sites.length})` : '';
  $('compare-empty').hidden = has;
  $('compare-table').hidden = !has;
  $('compare-actions').hidden = !has;
  if (!has) { $('compare-period').textContent = ''; return; }
  $('compare-period').textContent = 'Each column is a site and its own dates. Add the same site on other dates to see how a schedule slip changes it.';

  const cols = state.sites.map((s) => ({ s, r: s.result, rt: s.result ? rateStats(s, s.result) : null }));
  $('compare-table').querySelector('thead').innerHTML = '<tr><th></th>' + cols.map(({ s }) => {
    const name = s.name ?? `${fmtLat(s.lat)}, ${fmtLon(s.lng)}`;
    return `<th class="site-head ${s === state.current ? 'active' : ''}" data-id="${s.id}"
      style="border-top-color:${COMPARE_PIN}" title="Open this site">
      ${esc(name)} <button class="remove" data-remove="${s.id}" title="Remove from comparison">×</button></th>`;
  }).join('') + '</tr>';

  const cell = (col, html, rating) => {
    const active = col.s === state.current ? ' active-col' : '';
    if (!col.r) return `<td class="muted${active}">…</td>`;
    return rating
      ? `<td class="${rating.level}${active}" data-tip="${esc(rating.why)}">${html}</td>`
      : `<td class="${active.trim()}">${html}</td>`;
  };
  const rows = [
    ['Where', (c) => cell(c, `${fmtLat(c.s.lat)}<br>${fmtLon(c.s.lng)}`)],
    ['Dates', (c) => cell(c, c.s.period ? periodShort(c.s.period).replace(' → ', '<br>→ ') : '—')],
    ['Sunlight', (c) => cell(c, fmt(c.r?.site.sunlight_pct, 0, '%'), c.rt?.sunlight)],
    ['Earth in view', (c) => cell(c, fmt(c.r?.site.earth_visible_pct, 0, '%'), c.rt?.earth)],
    ['Sun max elevation', (c) => cell(c, c.r ? `${Math.max(...c.r.sky.map((p) => p.sun_el)).toFixed(1)}°` : '', c.rt?.sun_el)],
    ['Avg sun on panel', (c) => cell(c, c.r ? fmt(c.r.power_w.reduce((a, p) => a + p.w_m2, 0) / c.r.power_w.length, 0, ' W/m²') : '')],
    ['Peak sun on panel', (c) => cell(c, c.r ? fmt(Math.max(...c.r.power_w.map((p) => p.w_m2)), 0, ' W/m²') : '', c.rt?.sun_m2)],
    ['Slope', (c) => cell(c, fmt(c.r?.site.slope_deg, 1, '°'), c.rt?.slope)],
    ['Elevation', (c) => cell(c, fmt(c.r?.site.elevation_m, 0, ' m'))],
    ['Temperature', (c) => cell(c, c.r?.site.temp_range_k
      ? `${fmtC(c.r.site.temp_range_k[0])}<br>to ${fmtC(c.r.site.temp_range_k[1])}` : '—', c.rt?.temperature)],
    ['Terrain', (c) => cell(c, c.r?.terrain.level === 'detailed' ? 'detailed ~30 m' : `global ~${c.r?.terrain.resolution_m.toFixed(0)} m`)],
  ];
  $('compare-table').querySelector('tbody').innerHTML = rows
    .map(([label, fn]) => `<tr><th>${label}</th>${cols.map(fn).join('')}</tr>`).join('');
}

function flyTo(site) {
  globe.pointOfView({ lat: site.lat, lng: site.lng, altitude: 1.6 }, 800);
}

function showError(msg) {
  $('error').hidden = !msg;
  $('error').textContent = msg ?? '';
}

// ---- Wire up -------------------------------------------------------------------

$('compare-btn').addEventListener('click', onAddToComparison);
$('view3d-btn').addEventListener('click', () => onOpen3d());
$('show-sites').addEventListener('change', refreshLabels);
$('real-sun').addEventListener('change', applyGlobeSky);
$('period-start').value = state.period.start;
document.querySelectorAll('input[name="period-mode"]').forEach((el) => el.addEventListener('change', onPeriodChange));
$('period-start').addEventListener('change', onPeriodChange);
$('period-end').addEventListener('change', onPeriodChange);
$('layer-buttons').addEventListener('click', (e) => {
  const key = e.target.dataset?.layer;
  if (key) setLayer(key);
});
$('site-filters').addEventListener('click', (e) => {
  const key = e.target.dataset?.filter;
  if (key) { state.filter = key; renderCatalog(); }
});
$('site-list').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-site]');
  const s = li && state.catalog.find((x) => x.id === li.dataset.site);
  if (s) pickCatalogSite(s);
});
$('coord-form').addEventListener('submit', (e) => {
  e.preventDefault();
  newSite(Number($('coord-lat').value), Number($('coord-lon').value));
});
$('compare-table').addEventListener('click', (e) => {
  const removeId = e.target.dataset?.remove;
  if (removeId) {
    state.sites = state.sites.filter((s) => s.id !== removeId);
    refreshPoints();
    render();
    return;
  }
  const head = e.target.closest('th[data-id]');
  const site = head && state.sites.find((s) => s.id === head.dataset.id);
  if (site) {
    selectSite(site);
    flyTo(site);
    updateGlobeSky();
  }
});

// Tabs, panel arrow, collapsible boxes
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
$('panel-toggle').addEventListener('click', () => setPanelCollapsed(!document.body.classList.contains('panel-collapsed')));
document.querySelectorAll('.collapse-btn').forEach((b) => b.addEventListener('click', () => {
  setBoxCollapsed(b.dataset.collapse, !$(b.dataset.collapse).classList.contains('collapsed'));
}));

// Landing page and search results
$('req-form').addEventListener('submit', onFind);
$('skip-landing').addEventListener('click', chooseExplore);
$('choice-explore').addEventListener('click', chooseExplore);
$('req-goal').addEventListener('change', syncGoalFields);
$('choice-plan').addEventListener('click', choosePlan);
// Before the app is revealed "Back" returns to the start screen; afterwards it just closes the form.
$('back-to-choice').addEventListener('click', () => {
  if (state.revealed) showLanding(false);
  else { $('landing').hidden = true; showChoice(true); }
});
$('edit-req').addEventListener('click', () => showLanding(true));
$('show-heatmap').addEventListener('change', () => { applyHeatmap(); refreshLabels(); });
$('period-step').addEventListener('click', (e) => { const d = Number(e.target.dataset?.shift); if (d) shiftPeriod(d); });
$('dates-btn').addEventListener('click', onFindDates);
$('dates-out').addEventListener('click', (e) => { const d = e.target.closest('[data-date]')?.dataset.date; if (d) applyDates(d); });
$('nearby-box').addEventListener('toggle', () => { if ($('nearby-box').open && !$('nearby-out').querySelector('.nearby-grids')) loadNearby(); });
$('nearby-out').addEventListener('click', (e) => {
  const cell = e.target.closest('[data-lat]');
  if (cell) newSite(Number(cell.dataset.lat), Number(cell.dataset.lon), null, { name: 'Nearby alternative', info: `Within 3 km of ${state.current?.name ?? 'the previous site'}` });
});
$('share-btn').addEventListener('click', onShare);
// Hovering a site in the panel lights its beacon on the globe.
const hoverFromPanel = (e) => {
  const li = e.target.closest('#site-list li[data-site], #region-list li[data-region], #compare-table th[data-id]');
  if (!li) { setHover(null); return; }
  if (li.dataset.site) {
    const c = state.catalog.find((x) => x.id === li.dataset.site);
    if (c) setHover({ lat: c.lat, lng: c.lon, name: c.name });
  } else if (li.dataset.region !== undefined) {
    const r = state.search?.regions[Number(li.dataset.region)];
    if (r) setHover({ lat: r.lat, lng: r.lon, name: `Search result #${Number(li.dataset.region) + 1}` });
  } else {
    const col = state.sites.find((x) => x.id === li.dataset.id);
    if (col) setHover({ lat: col.lat, lng: col.lng, name: col.name ?? 'Compared site' });
  }
};
$('panel').addEventListener('mouseover', hoverFromPanel);
$('panel').addEventListener('mouseleave', () => setHover(null));
$('compare-csv').addEventListener('click', exportCompareCsv);
$('compare-sync').addEventListener('click', syncCompareDates);
$('sky-modal-close').addEventListener('click', closeSkyModal);
$('sky-modal').addEventListener('click', (e) => { if (e.target === $('sky-modal')) closeSkyModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('sky-modal').hidden) closeSkyModal(); });
$('choice-learn').addEventListener('click', () => { chooseExplore(); showTab('learn'); setPanelCollapsed(false); });
$('show-ice').addEventListener('change', onShowIce);
$('region-list').addEventListener('click', async (e) => {
  const why = e.target.closest('.why-link');
  if (why) {                                   // expand / collapse the explanation, don't open the site
    e.stopPropagation();
    const box = why.nextElementSibling;
    box.hidden = !box.hidden;
    why.setAttribute('aria-expanded', String(!box.hidden));
    why.textContent = box.hidden ? 'Why this site?' : 'Hide explanation';
    return;
  }
  if (e.target.closest('.why-text')) return;   // reading the explanation shouldn't open the site
  const addIdx = e.target.dataset?.addRegion;
  if (addIdx !== undefined) {
    e.stopPropagation();
    const r = state.search.regions[Number(addIdx)];
    e.target.disabled = true;
    e.target.textContent = 'Adding…';
    const site = await newSite(r.lat, r.lon, null, regionSiteExtra(Number(addIdx)), { background: true });
    site.period = { ...state.period };
    if (!inComparison(site)) state.sites.push(site);
    refreshPoints();
    render();
    e.target.textContent = 'In comparison ✓';
    return;
  }
  const li = e.target.closest('li[data-region]');
  if (!li) return;
  const i = Number(li.dataset.region);
  const r = state.search.regions[i];
  newSite(r.lat, r.lon, null, regionSiteExtra(i));
});

// Initial state: requirement defaults (or the last search), collapsed boxes, landing page.
(function init() {
  const today = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  $('req-start').value = iso(new Date(today.getTime() + 30 * 86400e3));
  $('req-end').value = iso(new Date(today.getTime() + 44 * 86400e3));
  try {
    const last = JSON.parse(recall('requirements') ?? 'null');
    if (last) {
      $('req-start').value = last.period_start; $('req-end').value = last.period_end;
      $('req-sun').value = last.min_sun_pct; $('req-earth').value = last.min_earth_pct;
      $('req-power').value = last.min_avg_w_m2; $('req-slope').value = last.max_slope_deg;
      $('req-region').value = last.region;
      if (last.max_ice_km) $('req-ice-km').value = last.max_ice_km;
      if ('goal' in last) $('req-goal').value = last.goal ?? '';
    }
  } catch { /* ignore bad saved data */ }
  syncGoalFields();
  if (recall('panel-collapsed') === '1') setPanelCollapsed(true);
  for (const id of ['layers', 'legend']) if (recall(`collapsed-${id}`) === '1') setBoxCollapsed(id, true);
  syncPeriodInputs();
  showTab('search');
  renderSearch();
  const shared = readShare();
  if (shared) openShared(shared);
  else startIntro();
})();

$('intro').addEventListener('click', leaveIntro);

// ---- Explanation tooltips: any element with data-tip shows it on hover or keyboard focus ----
const tipEl = document.createElement('div');
tipEl.id = 'tip';
tipEl.setAttribute('role', 'tooltip');
document.body.appendChild(tipEl);
function showTip(el) {
  tipEl.textContent = el.dataset.tip;
  tipEl.classList.add('on');
  const r = el.getBoundingClientRect(), t = tipEl.getBoundingClientRect();
  let x = Math.min(Math.max(8, r.left + r.width / 2 - t.width / 2), innerWidth - t.width - 8);
  let y = r.bottom + 8;
  if (y + t.height > innerHeight - 8) y = Math.max(8, r.top - t.height - 8);
  tipEl.style.left = `${x}px`;
  tipEl.style.top = `${y}px`;
}
const hideTip = () => tipEl.classList.remove('on');
for (const [on, off] of [['mouseover', 'mouseout'], ['focusin', 'focusout']]) {
  document.addEventListener(on, (e) => { const el = e.target.closest?.('[data-tip]'); if (el) showTip(el); });
  document.addEventListener(off, (e) => { if (e.target.closest?.('[data-tip]')) hideTip(); });
}
document.addEventListener('scroll', hideTip, true);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !$('intro').hidden) { e.preventDefault(); leaveIntro(); }
});

loadLayers();
loadCatalog();
updateGlobeSky();
