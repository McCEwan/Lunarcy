// Lunar Planner frontend. Plain JS modules, no build step.
// Remember: globe.gl uses `lng`, the API uses `lon`. Convert only in evaluateSite()
// (and when reading /sites, which uses `lon`).

import { horizonsUrl, moontrekUrl, quickmapUrl } from './links.js';
import { open3dView } from './site3d.js';
import { startIntroEarth } from './intro_earth.js';

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
  landers: [],       // GET /landers
  catalog: [],       // GET /sites (notable landing sites)
  layers: {},        // web/assets/moontrek/layers.json
  sites: [],         // comparison list: { id, lat, lng, name, catalog, lander, payload, landingDate, landingTime, result }
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

// ---- Stat colours: good (green) / warn (yellow) / bad (red) ------------------------
// Tied to the evaluator's pass/fail thresholds (api/evaluator.py) and the lander's limits:
// green = passes with margin, yellow = close to the limit, red = fails or poor.
const realTemps = (r) => r.sources.some((s) => /Diviner/.test(s));

// Daytime high vs the lander's rated limit (an estimate in landers.json; 400 K if none chosen).
function tempRating(r, lander) {
  const t = r.site.temp_range_k;
  if (!t || !realTemps(r)) return { level: 'none', why: 'Not rated: no real temperature data here' };
  const limit = lander?.max_surface_temp_k ?? 400;
  const level = t[1] <= limit - 30 ? 'good' : t[1] <= limit ? 'warn' : 'bad';
  return {
    level,
    why: `Diviner daytime high vs ${lander ? lander.name + "'s" : 'a typical'} rated ${limit} K (estimated): ` +
      `green ≤${limit - 30} K, yellow up to ${limit} K, red above. Night lows near ${t[0].toFixed(0)} K need heaters/survival mode.`,
  };
}

function rateStats(site, r) {
  const s = r.site;
  const lander = state.landers.find((l) => l.id === site.lander);
  const kind = r.period?.kind ?? 'lunar_day';
  const longPeriod = kind === 'lunar_day' || (kind === 'range' && r.period.hours >= 25 * 24);
  const slopeLimit = lander?.max_slope_deg ?? 10;
  const peakSun = Math.max(...r.power_w.map((p) => p.w_m2));
  const band = (v, good, warn, higherIsBetter = true) => {
    if (v === null || v === undefined) return 'none';
    return higherIsBetter ? (v >= good ? 'good' : v >= warn ? 'warn' : 'bad')
                          : (v <= good ? 'good' : v <= warn ? 'warn' : 'bad');
  };
  let sunlight;
  if (kind === 'day') {
    sunlight = { level: band(s.sun_hours, 18, 6), why: 'Daylight in the 24 h day: green ≥18 h, yellow 6–18 h (Sun rises or sets that day), red <6 h' };
  } else if (kind === 'mission') {
    sunlight = { level: band(s.sunlight_pct, 75, 60), why: 'Over the mission: green ≥75%, yellow 60–75%, red <60% (fails the 60% check)' };
  } else if (longPeriod) {
    sunlight = { level: band(s.sunlight_pct, 45, 30), why: 'Over a month or more (the Sun is up at most ~50% of a lunar day away from the poles): green ≥45%, yellow 30–45%, red <30%' };
  } else {
    sunlight = { level: band(s.sunlight_pct, 70, 40), why: 'Over this date range: green ≥70%, yellow 40–70%, red <40%' };
  }
  return {
    sunlight,
    earth: kind === 'day'
      ? { level: band(s.earth_hours, 22.8, 19.2), why: 'Earth in view in the 24 h day: green ≥22.8 h (95%), yellow 19.2–22.8 h, red <19.2 h (80%)' }
      : { level: band(s.earth_visible_pct, 95, 80), why: 'Direct-to-Earth comms: green ≥95%, yellow 80–95%, red <80% (fails the 80% check)' },
    slope: {
      level: band(s.slope_deg, 0.7 * slopeLimit, slopeLimit, false),
      why: `${lander ? lander.name : 'Typical lander'} limit ${slopeLimit}°: green ≤${(0.7 * slopeLimit).toFixed(0)}°, yellow up to ${slopeLimit}°, red above`,
    },
    sun_m2: { level: band(peakSun, 500, 150), why: 'Peak sunlight on a flat panel: green ≥500 W/m² (Sun ≥~22°), yellow 150–500 (~6–22°), red <150 W/m²' },
    elevation: { level: 'none', why: 'Not rated: elevation alone is neither good nor bad' },
    temperature: tempRating(r, lander),
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

const globeEl = $('globe');
const globe = new Globe(globeEl)
  .globeImageUrl(FALLBACK_TEXTURE)
  .bumpImageUrl(BUMP)
  .backgroundImageUrl('https://cdn.jsdelivr.net/npm/three-globe@2.45.0/example/img/night-sky.png')
  .showAtmosphere(false)
  // User-picked sites
  .pointLat('lat')
  .pointLng('lng')
  .pointAltitude((s) => zs(s === state.current ? PIN.altitude : PIN.altitude * 0.6))
  .pointRadius((s) => zs(s === state.current ? PIN.radius : PIN.radius * 0.7))
  .pointColor((s) => (s === state.current ? PIN_COLOR : landerColor(s.lander)))
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
  .onPointClick((s) => selectSite(s))
  // Notable landing sites from /sites
  .labelLat('lat')
  .labelLng('lon')
  .labelText('name')
  .labelSize((s) => zs(s.kind === 'ice' ? (s.rating === 'known' ? 0.8 : 0.6) : s.kind === 'region' ? 1.1 : 0.9))
  .labelDotRadius((s) => zs(s.kind === 'ice' ? 0.35 : s.kind === 'region' ? 0.3 : 0.45))
  .labelResolution(2)
  .labelColor((s) => (s.kind === 'ice' ? ICE_COLORS[s.rating] : s.kind === 'region' ? (s.within_ice_range ? '#ff8a1f' : '#ffffff') : statusColor(s)))
  .labelLabel((s) => (s.kind === 'ice' ? craterTooltip(s)
    : s.kind === 'region' ? regionTooltip(s)
      : `<b>${esc(s.name)}</b><br>${esc(s.place)}<br>${esc(s.date)} · ${esc(s.status)}`))
  .onLabelClick((s) => (s.kind === 'ice' ? pickCrater(s)
    : s.kind === 'region' ? newSite(s.lat, s.lon, null, regionSiteExtra(s.index)) : pickCatalogSite(s)))
  .onGlobeClick(({ lat, lng }) => newSite(lat, lng))
  // Sun and Earth markers (real directions from Horizons, not to scale)
  .htmlLat('lat')
  .htmlLng('lng')
  .htmlAltitude('alt')
  .htmlElement((d) => skyMarker(d))
  .htmlElementVisibilityModifier((el, visible) => { el.style.opacity = visible ? '1' : '0.25'; });
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

function skyMarker(d) {
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
  if (s?.landingDate) return `${s.landingDate}T${s.landingTime ?? '00:00'}:00Z`;
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
    globe.htmlElementsData(state.revealed ? [
      { kind: 'sun', lat: sub.sub_solar.lat, lng: sub.sub_solar.lon, alt: 1.1 },
      { kind: 'earth', lat: sub.sub_earth.lat, lng: sub.sub_earth.lon, alt: 0.7 },
    ] : []);
    const when = sub.time.replace('T', ' ').replace('Z', '');
    const src = /Horizons/.test(sub.source) && !/APPROXIMATE/.test(sub.source) ? 'JPL Horizons' : 'approximate model';
    $('sky-caption').textContent = `Lit for ${when} UTC (${src}). Markers show direction only, not distance or size.`;
  } else {
    if (defaultLighting.parent && sunLight.parent !== defaultLighting.parent) defaultLighting.parent.add(sunLight);
    sunLight.position.set(0, 1, 0);
    sunLight.intensity = defaultLighting.sun;
    ambientLight.intensity = defaultLighting.ambient;
    globe.htmlElementsData([]);
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
  globe.pointAltitude((s) => zs(s === state.current ? PIN.altitude : PIN.altitude * 0.6))
    .pointRadius((s) => zs(s === state.current ? PIN.radius : PIN.radius * 0.7))
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
  likely: 'Likely cold trap: floor permanently shadowed and below 110 K',
  possible: 'Possible: only one of permanent shadow / below 110 K',
  unlikely: 'Unlikely: sunlit floor and warmer than 110 K',
};

function craterTooltip(c) {
  const ev = c.evidence ? `<br><i>${esc(c.evidence.summary)}</i><br><span class="muted">${esc(c.evidence.citation)}</span>` : '';
  return `<b>${esc(c.name)}</b> · ${c.diameter_km} km wide, ~${(c.depth_m / 1000).toFixed(1)} km deep<br>` +
    `${esc(ICE_RATING_TEXT[c.rating])}<br>` +
    `Floor ${c.floor_shadowed ? 'never sees the Sun' : 'gets some sunlight'} · coldest max ${fmt(c.coldest_tmax_k, 0, ' K')}${ev}`;
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
  if (site.lander) body.lander_id = site.lander;
  if (site.payload !== null && site.payload !== '') body.payload_kg = Number(site.payload);
  if (site.landingDate && site.landingTime) body.landing_time = `${site.landingDate}T${site.landingTime}:00Z`;
  else if (site.landingDate) body.landing_date = site.landingDate;
  body.terrain_level = site.terrainLevel ?? 'global';
  if (!mission) {
    body.period_start = state.period.start;
    if (state.period.mode === 'range' && state.period.end) body.period_end = state.period.end;
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
    } else if (res.status === 404) {
      showError('That lander no longer exists. Refreshing the list.');
      await loadLanders();
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

async function loadLanders() {
  state.landers = await (await fetch('/landers')).json();
  const select = $('lander-select');
  select.innerHTML = '<option value="">Choose a lander</option>' +
    state.landers.map((l) => `<option value="${esc(l.id)}">${esc(l.name)} (${esc(l.operator)})</option>`).join('');
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
    name: catalog?.name ?? extra.name ?? null, catalog, info: extra.info ?? null,
    lander: catalog?.lander_id ?? null, payload: null, landingDate: null, landingTime: null,
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
    // Re-evaluate any sites already open over the new period.
    const todo = [...new Set([state.current, ...state.sites].filter(Boolean))];
    await Promise.all(todo.map(async (s) => { const r = await evaluateSite(s); if (r) s.result = r; }));
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
  $('search-summary').innerHTML =
    `<p><b>${esc(c.period_start)} → ${esc(c.period_end)}</b> · ${esc(c.region_label)}</p>` +
    (c.goal_label ? `<p>Goal: <b>${esc(c.goal_label)}</b> · within ${c.max_ice_km} km of an ice candidate</p>` : '') +
    `<p>Needs ≥${c.min_sun_pct}% daylight · ≥${c.min_earth_pct}% Earth in view · ≥${c.min_avg_w_m2} W/m² average panel sunlight · slope ≤${c.max_slope_deg}°</p>` +
    (s.ice ? `<p class="muted">Ice candidates: ${s.ice.counts.known_craters} craters with published ice evidence, ` +
      `${s.ice.counts.likely_craters} more likely cold traps, ${s.ice.counts.likely_cells.toLocaleString()} grid cells both permanently shadowed and below ${s.ice.ice_stable_k} K.</p>` : '') +
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
    <li data-region="${i}" class="${r.passes_with_terrain ? '' : 'dim'}"
        title="${r.passes_with_terrain ? 'Best spot in this region' : 'Fails once local terrain is counted'}">
      <b>${fmtLat(r.lat)}, ${fmtLon(r.lon)}</b>
      <span class="muted">· ${r.area_km2.toLocaleString()} km²</span>
      <button class="add secondary" data-add-region="${i}" title="Add to comparison">+ Compare</button>
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
    </li>`).join('');
}

function regionTooltip(r) {
  const ice = r.ice_km !== undefined ? ` · 🧊 ${r.ice_km} km to ice` : '';
  return `<b>Search result ${esc(r.name)}</b> · ${r.area_km2.toLocaleString()} km²<br>` +
    `☀️ ${r.sun_pct}% · 🌍 ${r.earth_pct}% · ⚡ ${r.avg_w_m2} W/m² · ⛰ ${r.slope_deg}°${ice}<br><span class="muted">Click to open</span>`;
}

function regionSiteExtra(i) {
  const r = state.search.regions[i];
  const ice = r.nearest_ice_crater ? ` · ${r.nearest_ice_crater.distance_km} km from ${r.nearest_ice_crater.name}` : '';
  return { name: `Search result #${i + 1}`, info: `Best spot of a ${r.area_km2.toLocaleString()} km² region from the site finder${ice}` };
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

async function onLanderChange() {
  const site = state.current;
  if (!site) return;
  site.lander = $('lander-select').value || null;
  site.landingDate = null;
  site.landingTime = null;
  const result = await evaluateSite(site);
  if (result) site.result = result;
  render();
}

async function onEvaluate() {
  const site = state.current;
  if (!site) return;
  site.payload = $('payload-input').value;
  site.landingDate = $('date-input').value || null;
  site.landingTime = site.landingDate ? ($('time-input').value || null) : null;
  const result = await evaluateSite(site);
  if (result) site.result = result;
  render();
  updateGlobeSky();
}

async function onOpen3d(initialT = 0) {
  const site = state.current;
  if (!site?.result) return;
  const landed = Boolean(site.lander && site.landingDate);
  // With a landing chosen, the timelapse plays the mission; otherwise the analysis period.
  const result = landed ? (await evaluateSite(site, { mission: true })) : site.result;
  if (!result) return;
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
  // Re-evaluate every site we're showing so the comparison stays like-for-like.
  const todo = [...new Set([state.current, ...state.sites].filter(Boolean))];
  await Promise.all(todo.map(async (s) => {
    const r = await evaluateSite(s);
    if (r) s.result = r;
  }));
  render();
}

function onAddToComparison() {
  const site = state.current;
  if (site && !state.sites.includes(site)) state.sites.push(site);
  refreshPoints();
  render();
}

// ---- Rendering -----------------------------------------------------------------

function landerColor(id) {
  return state.landers.find((l) => l.id === id)?.color ?? '#7cc4ff';
}

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
  $('mission-section').hidden = !r;
  renderCompareList();
  if (!site) return;

  // Site header, metadata and external tool links (work before /evaluate returns).
  const c = site.catalog;
  $('site-title').innerHTML = `${esc(site.name ?? 'Custom site')} <span class="muted">${fmtLat(site.lat)}, ${fmtLon(site.lng)}</span>`;
  $('site-meta').innerHTML = c
    ? `${esc(c.agency)} · ${esc(c.date)} · ${esc(c.status)} · ${esc(c.place)}` +
      (c.note ? `<br><span class="muted">${esc(c.note)}</span>` : '')
    : site.info ? `<span class="muted">${esc(site.info)}</span>` : '';
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
    $('result-section').hidden = true;
    $('view3d-btn').disabled = true;
    $('compare-btn').disabled = true;
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
  const temp = s.temp_range_k ? `${s.temp_range_k[0].toFixed(0)}–${s.temp_range_k[1].toFixed(0)} K` : '—';
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
  ];
  $('site-tiles').innerHTML = tiles
    .map(([k, v, sub, rt]) => `<div class="tile ${rt.level}" title="${esc(rt.why)}">` +
      `<div class="k">${k}</div><div class="v">${esc(v)}</div>${sub}</div>`)
    .join('') + (s.slope_deg === null ? '<p class="small muted">No terrain data here.</p>' : '');
  $('compare-btn').disabled = state.sites.includes(site);
  $('compare-btn').textContent = state.sites.includes(site) ? 'In comparison ✓' : 'Add to comparison';

  // Mission inputs
  $('lander-select').value = site.lander ?? '';
  $('payload-input').value = site.payload ?? '';
  $('date-input').value = site.landingDate ?? '';
  $('time-input').value = site.landingTime ?? '';
  $('date-input').min = new Date().toISOString().slice(0, 10);
  $('date-input').max = MAX_DATE;
  $('evaluate-btn').disabled = !site.lander;
  $('view3d-btn').disabled = false;
  $('view3d-btn').textContent = site.lander && site.landingDate
    ? 'Open 3D view · timelapse from landing'
    : 'Open 3D view';

  const lander = state.landers.find((l) => l.id === site.lander);
  $('lander-facts').innerHTML = lander
    ? `${lander.payload_capacity_kg} kg payload · ${lander.max_slope_deg}° max slope · ` +
      `${lander.mission_days}-day mission · ${lander.transit_days}-day transit` +
      (lander.estimated_fields.length ? `<br>Estimated: ${esc(lander.estimated_fields.join(', '))}` : '')
    : '';

  // Landing windows (TODO frontend: replace with the timeline strip)
  if (r.windows) {
    $('windows').innerHTML = r.windows.length
      ? 'Valid landing windows (click to use the suggested landing time):<br>' + r.windows
          .map((w) => {
            const t = w.start_time.slice(11, 16);
            return `<button class="window-btn" data-date="${w.start}" data-time="${t}" ` +
              `title="Earliest landing ${w.start_time.replace('T', ' ')} UTC, latest ${w.end_time.replace('T', ' ')} UTC">` +
              `${w.start} ${t} UTC → ${w.end}</button>`;
          })
          .join('')
      : 'No valid landing windows in the next few months.';
  } else if (!site.landingDate) {
    $('windows').innerHTML = '';
  }

  // Verdict
  const hasChecks = r.checks.length > 0;
  $('result-section').hidden = !hasChecks;
  if (hasChecks) {
    const verdict = $('verdict');
    verdict.textContent = r.pass ? 'PASS' : 'FAIL';
    verdict.className = 'badge ' + (r.pass ? 'pass' : 'fail');
    $('launch').textContent = r.launch_estimate ? `Estimated launch: ${r.launch_estimate}` : '';
    $('checks').innerHTML = r.checks
      .map((ch) => `<li class="${ch.pass ? 'ok' : ''}"><b>${esc(ch.name)}</b>: ${esc(ch.detail)}</li>`)
      .join('');
  }

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
  if (!has) { $('compare-period').textContent = ''; return; }
  const day = state.period.mode === 'day';
  const withResult = state.sites.find((s) => s.result);
  $('compare-period').textContent = withResult ? `Period: ${periodText(withResult.result.period)}` : '';

  const cols = state.sites.map((s) => ({ s, r: s.result, rt: s.result ? rateStats(s, s.result) : null }));
  $('compare-table').querySelector('thead').innerHTML = '<tr><th></th>' + cols.map(({ s }) => {
    const name = s.name ?? `${fmtLat(s.lat)}, ${fmtLon(s.lng)}`;
    return `<th class="site-head ${s === state.current ? 'active' : ''}" data-id="${s.id}"
      style="border-top-color:${landerColor(s.lander)}" title="Open this site">
      ${esc(name)} <button class="remove" data-remove="${s.id}" title="Remove from comparison">×</button></th>`;
  }).join('') + '</tr>';

  const cell = (col, html, rating) => {
    const active = col.s === state.current ? ' active-col' : '';
    if (!col.r) return `<td class="muted${active}">…</td>`;
    return rating
      ? `<td class="${rating.level}${active}" title="${esc(rating.why)}">${html}</td>`
      : `<td class="${active.trim()}">${html}</td>`;
  };
  const rows = [
    ['Where', (c) => cell(c, `${fmtLat(c.s.lat)}<br>${fmtLon(c.s.lng)}`)],
    ['Verdict', (c) => cell(c, c.r?.pass === true ? '<span class="badge pass">PASS</span>'
      : c.r?.pass === false ? '<span class="badge fail">FAIL</span>' : '<span class="muted">no lander</span>')],
    [day ? 'Daylight (of 24 h)' : 'Sunlight', (c) => cell(c,
      day ? `${c.r?.site.sun_hours.toFixed(1)} h` : fmt(c.r?.site.sunlight_pct, 0, '%'), c.rt?.sunlight)],
    [day ? 'Earth in view (of 24 h)' : 'Earth in view', (c) => cell(c,
      day ? `${c.r?.site.earth_hours.toFixed(1)} h` : fmt(c.r?.site.earth_visible_pct, 0, '%'), c.rt?.earth)],
    ['Avg sun on panel', (c) => cell(c, c.r ? fmt(c.r.power_w.reduce((a, p) => a + p.w_m2, 0) / c.r.power_w.length, 0, ' W/m²') : '')],
    ['Peak sun on panel', (c) => cell(c, c.r ? fmt(Math.max(...c.r.power_w.map((p) => p.w_m2)), 0, ' W/m²') : '', c.rt?.sun_m2)],
    ['Slope', (c) => cell(c, fmt(c.r?.site.slope_deg, 1, '°'), c.rt?.slope)],
    ['Elevation', (c) => cell(c, fmt(c.r?.site.elevation_m, 0, ' m'))],
    ['Temperature', (c) => cell(c, c.r?.site.temp_range_k
      ? `${c.r.site.temp_range_k[0].toFixed(0)}–${c.r.site.temp_range_k[1].toFixed(0)} K` : '—', c.rt?.temperature)],
    ['Lander', (c) => cell(c, esc(state.landers.find((l) => l.id === c.s.lander)?.name ?? '—'))],
    ['Landing', (c) => cell(c, c.s.landingDate ? `${c.s.landingDate}<br>${c.s.landingTime ?? '00:00'} UTC` : '—')],
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

$('lander-select').addEventListener('change', onLanderChange);
$('evaluate-btn').addEventListener('click', onEvaluate);
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
$('windows').addEventListener('click', (e) => {
  const date = e.target.dataset?.date;
  if (date) {
    $('date-input').value = date;
    $('time-input').value = e.target.dataset.time ?? '';
  }
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
$('show-ice').addEventListener('change', onShowIce);
$('region-list').addEventListener('click', async (e) => {
  const addIdx = e.target.dataset?.addRegion;
  if (addIdx !== undefined) {
    e.stopPropagation();
    const r = state.search.regions[Number(addIdx)];
    e.target.disabled = true;
    e.target.textContent = 'Adding…';
    const site = await newSite(r.lat, r.lon, null, regionSiteExtra(Number(addIdx)), { background: true });
    if (!state.sites.includes(site)) state.sites.push(site);
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
  startIntro();
})();

$('intro').addEventListener('click', leaveIntro);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !$('intro').hidden) { e.preventDefault(); leaveIntro(); }
});

loadLayers();
loadLanders().then(() => { refreshPoints(); return loadCatalog(); });
updateGlobeSky();
