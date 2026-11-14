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
    temperature: { level: 'none', why: 'Not rated: temperature is still placeholder data' },
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
  globe.globeImageUrl(layer.file);
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

async function newSite(lat, lng, catalog = null) {
  const site = {
    id: crypto.randomUUID(), lat, lng,
    name: catalog?.name ?? null, catalog,
    lander: catalog?.lander_id ?? null, payload: null, landingDate: null, landingTime: null,
    terrainLevel: 'global', result: null,
  };
  state.current = site;
  refreshPoints();
  render();
  updateGlobeSky();
  globe.pointOfView({ lat, lng, altitude: 1.6 }, 800);
  const result = await evaluateSite(site);
  if (result && state.current === site) {
    site.result = result;
    render();
  }
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
  $('site-coords').textContent = `${fmtLat(site.lat)}, ${fmtLon(site.lng)}`;
  const c = site.catalog;
  $('site-meta').innerHTML = c
    ? `<b>${esc(c.name)}</b> · ${esc(c.agency)} · ${esc(c.date)} · ${esc(c.status)}<br>${esc(c.place)}` +
      (c.note ? `<br><span class="muted">${esc(c.note)}</span>` : '')
    : '<span class="muted">Custom site</span>';
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
    ` · skyline up to ${t.skyline_max_deg.toFixed(1)}°</span><br>` +
    `<span class="muted">Horizons site altitude: ${t.site_elevation_m >= 0 ? '+' : ''}${t.site_elevation_m.toFixed(0)} m (from LOLA)</span>`;
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
    ['Temperature', temp, '<div class="sub">placeholder</div>', rating.temperature],
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

// Left panel: the compared sites as a table. Columns are the values, rows the sites.
// Every row uses the same analysis period, so the numbers are like-for-like.
function renderCompareList() {
  const has = state.sites.length > 0;
  $('compare-empty').hidden = has;
  $('compare-table').hidden = !has;
  if (!has) return;
  const day = state.period.mode === 'day';
  $('compare-period').textContent = state.sites[0].result ? `Period: ${periodText(state.sites[0].result.period)}` : '';
  const head = ['Site', 'Verdict', day ? 'Daylight' : 'Sunlight', day ? 'Earth in view' : 'Earth', 'Slope',
    'Peak sun on panel', 'Elevation', 'Lander · landing', 'Terrain', ''];
  $('compare-table').querySelector('thead').innerHTML = `<tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>`;
  $('compare-table').querySelector('tbody').innerHTML = state.sites.map((s) => {
    const r = s.result;
    const where = s.name ?? `${fmtLat(s.lat)}, ${fmtLon(s.lng)}`;
    const active = s === state.current ? 'active' : '';
    const lead = `<td class="site-cell" style="border-left-color:${landerColor(s.lander)}"><b>${esc(where)}</b>` +
      `<div class="muted">${fmtLat(s.lat)}, ${fmtLon(s.lng)}</div></td>`;
    const remove = `<td><button class="remove" data-remove="${s.id}" title="Remove from comparison">×</button></td>`;
    if (!r) return `<tr data-id="${s.id}" class="${active}">${lead}<td colspan="8" class="muted">calculating…</td>${remove}</tr>`;
    const rt = rateStats(s, r);
    const cell = (rating, text) => `<td class="${rating.level}" title="${esc(rating.why)}">${text}</td>`;
    const lander = state.landers.find((l) => l.id === s.lander);
    const verdict = r.pass === true ? '<span class="badge pass">PASS</span>'
      : r.pass === false ? '<span class="badge fail">FAIL</span>' : '<span class="muted">—</span>';
    const sun = day ? `${r.site.sun_hours.toFixed(1)} h` : fmt(r.site.sunlight_pct, 0, '%');
    const earth = day ? `${r.site.earth_hours.toFixed(1)} h` : fmt(r.site.earth_visible_pct, 0, '%');
    const landing = s.landingDate ? `${s.landingDate} ${s.landingTime ?? '00:00'}` : 'no landing';
    return `<tr data-id="${s.id}" class="${active}">
      ${lead}
      <td>${verdict}</td>
      ${cell(rt.sunlight, sun)}
      ${cell(rt.earth, earth)}
      ${cell(rt.slope, fmt(r.site.slope_deg, 1, '°'))}
      ${cell(rt.sun_m2, fmt(Math.max(...r.power_w.map((p) => p.w_m2)), 0, ' W/m²'))}
      <td>${fmt(r.site.elevation_m, 0, ' m')}</td>
      <td>${esc(lander?.name ?? '—')}<div class="muted">${esc(landing)}</div></td>
      <td>${r.terrain.level === 'detailed' ? 'detailed ~30 m' : `global ~${r.terrain.resolution_m.toFixed(0)} m`}</td>
      ${remove}
    </tr>`;
  }).join('');
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
  const row = e.target.closest('tr[data-id]');
  const site = row && state.sites.find((s) => s.id === row.dataset.id);
  if (site) {
    selectSite(site);
    flyTo(site);
    updateGlobeSky();
  }
});

loadLayers();
loadLanders().then(() => { refreshPoints(); return loadCatalog(); });
updateGlobeSky();
