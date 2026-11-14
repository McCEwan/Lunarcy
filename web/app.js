// Lunar Planner frontend. Plain JS modules, no build step.
// Remember: globe.gl uses `lng`, the API uses `lon`. Convert only in evaluateSite()
// (and when reading /sites, which uses `lon`).

import { horizonsUrl, moontrekUrl, quickmapUrl } from './links.js';

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
  sites: [],         // comparison list: { id, lat, lng, name, catalog, lander, payload, landingDate, result }
  current: null,     // the site being worked on (may or may not be in `sites`)
  filter: 'all',
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v, digits = 1, unit = '') => (v === null || v === undefined ? '—' : `${Number(v).toFixed(digits)}${unit}`);
const fmtLat = (lat) => `${Math.abs(lat).toFixed(2)}°${lat < 0 ? 'S' : 'N'}`;
const fmtLon = (lon) => `${Math.abs(lon).toFixed(2)}°${lon < 0 ? 'W' : 'E'}`;
const statusColor = (s) => (s.status === 'planned' ? '#5ee1ff' : '#ffd166');

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
  .onGlobeClick(({ lat, lng }) => newSite(lat, lng));
// TODO (frontend): placeholder lander model at the active site via customLayerData.

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

async function evaluateSite(site) {
  const body = { lat: site.lat, lon: site.lng };
  if (site.lander) body.lander_id = site.lander;
  if (site.payload !== null && site.payload !== '') body.payload_kg = Number(site.payload);
  if (site.landingDate) body.landing_date = site.landingDate;

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
    lander: catalog?.lander_id ?? null, payload: null, landingDate: null, result: null,
  };
  state.current = site;
  refreshPoints();
  render();
  globe.pointOfView({ lat, lng, altitude: 1.6 }, 800);
  const result = await evaluateSite(site);
  if (result && state.current === site) {
    site.result = result;
    render();
  }
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
  const result = await evaluateSite(site);
  if (result) site.result = result;
  render();
}

async function onEvaluate() {
  const site = state.current;
  if (!site) return;
  site.payload = $('payload-input').value;
  site.landingDate = $('date-input').value || null;
  const result = await evaluateSite(site);
  if (result) site.result = result;
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

// "Sun up · sets in 3.2 days" style summary, relative to now.
function skyNow(r) {
  const now = Date.now();
  const first = r.sky[0];
  const until = (iso) => {
    if (!iso) return null;
    const h = (new Date(iso) - now) / 3600e3;
    return h < 48 ? `${h.toFixed(0)} h` : `${(h / 24).toFixed(1)} days`;
  };
  // The series starts at 00:00 UTC on the start date, so use the sample nearest to now.
  const idx = Math.max(0, Math.min(r.sky.length - 1, Math.round((now - new Date(first.t)) / 3600e3)));
  const at = r.sky[idx];
  const sunUp = at.sun_el > 0;
  const earthUp = at.earth_el > 0;
  const ev = r.events;
  const sunText = sunUp
    ? `☀️ Sun up (${at.sun_el.toFixed(1)}°)${ev.sunset ? ` · sets in ${until(ev.sunset)}` : ' all period'}`
    : `☀️ Sun down${ev.sunrise ? ` · rises in ${until(ev.sunrise)}` : ' all period'}`;
  const earthText = earthUp
    ? `🌍 Earth up (${at.earth_el.toFixed(1)}°)${ev.earthset ? ` · sets in ${until(ev.earthset)}` : ' all period'}`
    : `🌍 Earth below horizon${ev.earthrise ? ` · rises in ${until(ev.earthrise)}` : ' all period'}`;
  return `<div>${sunText}</div><div>${earthText}</div>`;
}

function render() {
  const site = state.current;
  const r = site?.result;
  $('hint').hidden = !!site;
  $('site-section').hidden = !site;
  $('mission-section').hidden = !r;
  $('compare-section').hidden = state.sites.length === 0;
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
  $('site-links').innerHTML = [
    `<a href="${quickmapUrl(site.lat, site.lng)}" target="_blank" rel="noopener">QuickMap ↗</a>`,
    `<a href="${moontrekUrl(site.lat, site.lng)}" target="_blank" rel="noopener">Moon Trek ↗</a>`,
    `<a href="${horizonsUrl(site.lat, site.lng, '10', start)}" target="_blank" rel="noopener">Horizons: Sun ↗</a>`,
    `<a href="${horizonsUrl(site.lat, site.lng, '399', start)}" target="_blank" rel="noopener">Horizons: Earth ↗</a>`,
    c ? `<a href="${esc(c.source)}" target="_blank" rel="noopener">Site source ↗</a>` : '',
  ].join('');

  if (!r) {
    $('sky-now').innerHTML = '';
    $('site-tiles').innerHTML = '';
    $('result-section').hidden = true;
    return;
  }

  // Sun and Earth right now, plus time to the next rise/set.
  $('sky-now').innerHTML = skyNow(r);

  // Site stats
  const s = r.site;
  const temp = s.temp_range_k ? `${s.temp_range_k[0].toFixed(0)}–${s.temp_range_k[1].toFixed(0)} K` : '—';
  const tiles = [
    ['Sunlight', fmt(s.sunlight_pct, 0, '%')],
    ['Earth visible', fmt(s.earth_visible_pct, 0, '%')],
    ['Slope', fmt(s.slope_deg, 1, '°')],
    ['Elevation', fmt(s.elevation_m, 0, ' m')],
    ['Temperature', temp],
    ['Peak power', fmt(Math.max(...r.power_w.map((p) => p.w)), 0, ' W')],
  ];
  $('site-tiles').innerHTML = tiles
    .map(([k, v]) => `<div class="tile"><div class="k">${k}</div><div class="v">${esc(v)}</div></div>`)
    .join('') + (s.slope_deg === null ? '<p class="small muted">No terrain data here.</p>' : '');

  // Mission inputs
  $('lander-select').value = site.lander ?? '';
  $('payload-input').value = site.payload ?? '';
  $('date-input').value = site.landingDate ?? '';
  $('date-input').min = new Date().toISOString().slice(0, 10);
  $('date-input').max = MAX_DATE;
  $('evaluate-btn').disabled = !site.lander;

  const lander = state.landers.find((l) => l.id === site.lander);
  $('lander-facts').innerHTML = lander
    ? `${lander.payload_capacity_kg} kg payload · ${lander.max_slope_deg}° max slope · ` +
      `${lander.mission_days}-day mission · ${lander.transit_days}-day transit` +
      (lander.estimated_fields.length ? `<br>Estimated: ${esc(lander.estimated_fields.join(', '))}` : '')
    : '';

  // Landing windows (TODO frontend: replace with the timeline strip)
  if (r.windows) {
    $('windows').innerHTML = r.windows.length
      ? 'Valid landing windows: ' + r.windows
          .map((w) => `<button class="window-btn" data-date="${w.start}">${w.start} → ${w.end}</button>`)
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
    $('compare-btn').disabled = state.sites.includes(site);
  }

  // Sources
  $('sources-box').hidden = r.sources.length === 0;
  $('sources').innerHTML = r.sources
    .map((src) => (src.startsWith('http') ? `<li><a href="${esc(src)}" target="_blank" rel="noopener">${esc(src)}</a></li>` : `<li>${esc(src)}</li>`))
    .join('');
}

function renderCompareList() {
  $('compare-list').innerHTML = state.sites.map((s) => {
    const name = state.landers.find((l) => l.id === s.lander)?.name ?? 'No lander';
    const verdict = s.result?.pass === true ? 'PASS' : s.result?.pass === false ? 'FAIL' : '—';
    const where = s.name ?? `${fmtLat(s.lat)}, ${fmtLon(s.lng)}`;
    return `<li data-id="${s.id}" class="${s === state.current ? 'active' : ''}" style="border-left-color:${landerColor(s.lander)}">
      <b>${esc(where)}</b> · ${esc(name)} · ${esc(s.landingDate ?? 'no date')} · ${verdict}
    </li>`;
  }).join('');
}

function showError(msg) {
  $('error').hidden = !msg;
  $('error').textContent = msg ?? '';
}

// ---- Wire up -------------------------------------------------------------------

$('lander-select').addEventListener('change', onLanderChange);
$('evaluate-btn').addEventListener('click', onEvaluate);
$('compare-btn').addEventListener('click', onAddToComparison);
$('show-sites').addEventListener('change', refreshLabels);
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
  if (date) $('date-input').value = date;
});
$('compare-list').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  const site = li && state.sites.find((s) => s.id === li.dataset.id);
  if (site) selectSite(site);
});

loadLayers();
loadLanders().then(() => { refreshPoints(); return loadCatalog(); });
