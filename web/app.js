// Lunar Planner frontend. Plain JS modules, no build step.
// Remember: globe.gl uses `lng`, the API uses `lon`. Convert only in evaluateSite()
// (and when reading /sites, which uses `lon`).

import { horizonsUrl, moontrekUrl, quickmapUrl } from './links.js';
import { open3dView } from './site3d.js';

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

const globeEl = $('globe');
const globe = new Globe(globeEl)
  .globeImageUrl(FALLBACK_TEXTURE)
  .bumpImageUrl(BUMP)
  .backgroundImageUrl('https://cdn.jsdelivr.net/npm/three-globe@2.45.0/example/img/night-sky.png')
  .showAtmosphere(false)
  // User-picked sites
  .pointLat('lat')
  .pointLng('lng')
  .pointAltitude(0.02)
  .pointRadius(0.8)
  .pointColor((s) => (s === state.current ? '#ffffff' : landerColor(s.lander)))
  .pointLabel((s) => esc(s.name ?? `${fmtLat(s.lat)}, ${fmtLon(s.lng)}`))
  .onPointClick((s) => selectSite(s))
  // Notable landing sites from /sites
  .labelLat('lat')
  .labelLng('lon')
  .labelText('name')
  .labelSize(0.9)
  .labelDotRadius(0.45)
  .labelResolution(2)
  .labelColor(statusColor)
  .labelLabel((s) => `<b>${esc(s.name)}</b><br>${esc(s.place)}<br>${esc(s.date)} · ${esc(s.status)}`)
  .onLabelClick((s) => pickCatalogSite(s))
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
    globe.htmlElementsData([
      { kind: 'sun', lat: sub.sub_solar.lat, lng: sub.sub_solar.lon, alt: 1.1 },
      { kind: 'earth', lat: sub.sub_earth.lat, lng: sub.sub_earth.lon, alt: 0.7 },
    ]);
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

function resizeGlobe() {
  globe.width(globeEl.clientWidth).height(globeEl.clientHeight);
}
window.addEventListener('resize', resizeGlobe);
resizeGlobe();

function refreshPoints() {
  const points = [...state.sites];
  if (state.current && !points.includes(state.current)) points.push(state.current);
  globe.pointsData(points);
}

function refreshLabels() {
  globe.labelsData($('show-sites').checked ? state.catalog : []);
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

// "Get detailed terrain": download ~30 m LOLA around the site, then re-evaluate with it.
async function getDetailedTerrain(site = state.current) {
  if (!site || site.terrainLevel === 'detailed') return site;
  showError(null);
  $('detail-status').textContent = 'Downloading detailed LOLA terrain from NASA PDS… (a few seconds)';
  $('get-detail-btn').disabled = true;
  try {
    const res = await fetch(`/terrain/detail?lat=${site.lat}&lon=${site.lng}`, { method: 'POST' });
    const body = await res.json();
    if (!res.ok) throw new Error(body.detail ?? `HTTP ${res.status}`);
    site.terrainLevel = 'detailed';
    $('detail-status').textContent = body.cached
      ? 'Detailed terrain loaded from cache. Recalculating…'
      : `Downloaded ${body.product} in ${body.seconds} s. Recalculating…`;
    const result = await evaluateSite(site);
    if (result) site.result = result;
    $('detail-status').textContent = '';
  } catch (err) {
    $('detail-status').textContent = '';
    showError(`Detailed terrain failed: ${err.message}`);
  } finally {
    $('get-detail-btn').disabled = false;
    render();
  }
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
    remember('requirements', JSON.stringify(body));
    // The analysis period follows the mission dates, so site stats match the search.
    state.period = { mode: 'range', start: body.period_start, end: body.period_end };
    syncPeriodInputs();
    showLanding(false);
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
    `<p>Needs ≥${c.min_sun_pct}% daylight · ≥${c.min_earth_pct}% Earth in view · ≥${c.min_avg_w_m2} W/m² average panel sunlight · slope ≤${c.max_slope_deg}°</p>` +
    `<p class="muted">${n.meeting_cells.toLocaleString()} of ${n.searched_cells.toLocaleString()} grid cells (0.5°, ~15 km) meet everything, ` +
    `about ${Math.round(n.meeting_area_km2).toLocaleString()} km² in ${n.regions} regions. ${terrainNote} Took ${s.seconds} s.</p>`;
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
        ${r.passes_with_terrain ? '' : '<span class="bad">fails with terrain</span>'}
      </div>
    </li>`).join('');
}

function regionSiteExtra(i) {
  const r = state.search.regions[i];
  return { name: `Search result #${i + 1}`, info: `Best spot of a ${r.area_km2.toLocaleString()} km² region from the site finder` };
}

// Heatmap: paint the search classes over the current globe texture.
async function applyHeatmap() {
  const s = state.search;
  const base = state.layers[state.layerKey]?.file ?? FALLBACK_TEXTURE;
  if (!s || !$('show-heatmap').checked) { globe.globeImageUrl(base); return; }
  const img = await loadImage(base);
  const W = img.naturalWidth, H = img.naturalHeight;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const { nlat, nlon, classes_b64 } = s.grid;
  const cls = Uint8Array.from(atob(classes_b64), (ch) => ch.charCodeAt(0));
  const small = document.createElement('canvas'); small.width = nlon; small.height = nlat;
  const sg = small.getContext('2d');
  const data = sg.createImageData(nlon, nlat);
  // green = meets all requirements, yellow = nearly, clear = no, dimmed = outside the search area
  const colors = { 2: [76, 209, 138, 80], 1: [255, 204, 77, 70], 0: [0, 0, 0, 0], 255: [0, 0, 0, 110] };
  for (let r = 0; r < nlat; r++) {
    for (let col = 0; col < nlon; col++) {
      const v = cls[r * nlon + col];
      const k = ((nlat - 1 - r) * nlon + col) * 4;        // grid row 0 = south; image row 0 = north
      const [R, G, B, A] = colors[v] ?? colors[0];
      data.data[k] = R; data.data[k + 1] = G; data.data[k + 2] = B; data.data[k + 3] = A;
    }
  }
  sg.putImageData(data, 0, 0);
  g.imageSmoothingEnabled = true;
  g.drawImage(small, 0, 0, W, H);
  globe.globeImageUrl(c.toDataURL('image/jpeg', 0.88));
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
    // The 3D view's own "Get detailed terrain" button: fetch, re-evaluate, reopen at the same moment.
    onRequestDetail: async (t) => {
      await getDetailedTerrain(site);
      if (state.current === site && site.terrainLevel === 'detailed') onOpen3d(t);
    },
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
    $('get-detail-btn').hidden = true;
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
  $('get-detail-btn').hidden = detailed;
  $('get-detail-btn').textContent = t.detailed_cached
    ? 'Use detailed terrain (already downloaded)'
    : 'Get detailed terrain (LOLA ~30 m, a few seconds)';

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
$('get-detail-btn').addEventListener('click', () => getDetailedTerrain());
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
$('skip-landing').addEventListener('click', () => { showLanding(false); showTab(state.search ? 'search' : 'sites'); });
$('edit-req').addEventListener('click', () => showLanding(true));
$('show-heatmap').addEventListener('change', applyHeatmap);
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
    }
  } catch { /* ignore bad saved data */ }
  if (recall('panel-collapsed') === '1') setPanelCollapsed(true);
  for (const id of ['layers', 'legend']) if (recall(`collapsed-${id}`) === '1') setBoxCollapsed(id, true);
  syncPeriodInputs();
  showTab('search');
  renderSearch();
  showLanding(true);
})();

loadLayers();
loadLanders().then(() => { refreshPoints(); return loadCatalog(); });
updateGlobeSky();
