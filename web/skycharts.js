// Sky & horizon panel for the Site tab: where the Sun and Earth are relative to the real
// terrain horizon, and when they are in view. Plain SVG, no chart library.
//
//   - Time slider + readout: Sun/Earth elevation and azimuth, in view or not, time to the
//     next sunset / Earthset (or rise), sunlight on a flat panel.
//   - Horizon panorama: 360° of the NASA LOLA skyline seen from the site, with the paths the
//     Sun and Earth trace over the period and their positions at the slider's time.
//   - Elevation chart: Sun and Earth elevation over time, with the terrain horizon in their
//     direction (dashed): above the dashed line = in view.
//   - Windows: bars for Sun in view, Earth in view, and both (power + direct comms at once).
//   - Power: sunlight on a flat panel (W/m²) over time.
// Every view shares one time cursor; drag on any chart to move it.

const SUN = '#ffd23f';
const EARTH = '#6fb6ff';
const BOTH = '#7be0a0';
const NS = 'http://www.w3.org/2000/svg';

export function skylineAt(skyline, az) {
  if (!skyline?.length) return 0;
  const n = skyline.length, step = 360 / n;
  const x = (((az % 360) + 360) % 360) / step;
  const i = Math.floor(x) % n, f = x - Math.floor(x);
  return skyline[i] * (1 - f) + skyline[(i + 1) % n] * f;
}

const fmtDeg = (v) => `${v >= 0 ? '' : '−'}${Math.abs(v).toFixed(1)}°`;
const fmtUtc = (iso) => iso.replace('T', ' ').replace('Z', ' UTC');
const fmtDur = (h) => (h < 48 ? `${h} h` : `${(h / 24).toFixed(1)} days`);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function el(tag, attrs = {}, parent = null) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

export class SkyPanel {
  /**
   * @param {HTMLElement} root
   * @param {object} opts  { large: bool, onTime(i), onEnlarge() }
   */
  constructor(root, opts = {}) {
    this.root = root;
    this.opts = opts;
    this.t = 0;
    this.ro = new ResizeObserver(() => this.draw());
    this.ro.observe(root);
  }

  set(result, skyline, t = null) {
    this.r = result;
    this.series = result?.sky ?? [];
    this.power = result?.power_w ?? [];
    this.skyline = skyline;
    if (t !== null) this.t = t;
    else {
      const now = Date.now();
      const i = this.series.findIndex((s) => Date.parse(s.t) > now);
      this.t = i > 0 ? i - 1 : 0;      // "now" if it's inside the period, else the start
    }
    this.t = Math.min(this.t, Math.max(this.series.length - 1, 0));
    this.build();
  }

  setTime(i, fromUser = false) {
    this.t = Math.max(0, Math.min(this.series.length - 1, Math.round(i)));
    const slider = this.root.querySelector('.sky-slider');
    if (slider) slider.value = String(this.t);
    this.updateCursor();
    if (fromUser) this.opts.onTime?.(this.t);
  }

  destroy() { this.ro.disconnect(); }

  build() {
    const n = this.series.length;
    if (!n) { this.root.innerHTML = ''; return; }
    const tip = 'The Sun and Earth seen from this site. The grey band is the real horizon traced from NASA LOLA terrain ' +
      '(crater rims and mountains up to 150 km away); the Moon has no atmosphere, so a body counts as in view only when it ' +
      'is above that terrain line, with no twilight or refraction. Positions come from JPL Horizons, which includes the ' +
      'Moon\'s libration (its wobble, which moves Earth around a small patch of sky). Drag the slider or any chart to move in time.';
    // Small (sidebar): one column. Large (full view window): a dashboard grid (see style.css).
    this.root.classList.toggle('large', !!this.opts.large);
    const legend = `<div class="sky-legend"><span><i style="background:${SUN}"></i>Sun</span><span><i style="background:${EARTH}"></i>Earth</span>` +
      `<span><i class="terr"></i>Terrain horizon (NASA LOLA)</span><span><i style="background:${BOTH}"></i>Both in view</span></div>`;
    this.root.innerHTML = `
      <div class="sky-head" style="grid-area:head">
        <b>Sky &amp; horizon</b> <span class="info-i" data-tip="${esc(tip)}" tabindex="0">i</span>
        <span class="sky-actions">
          <button type="button" class="chip" data-act="csv" title="Download this timeline as CSV">CSV</button>
          ${this.opts.large ? '' : `<button type="button" class="expand-btn" data-act="enlarge" title="Open the charts full size in their own window">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5h4v4M13.5 2.5 8.5 7.5M6.5 13.5h-4v-4M2.5 13.5l5-5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Expand charts</button>`}
        </span>
      </div>
      <div class="sky-time" style="grid-area:slider">
        <input class="sky-slider" type="range" min="0" max="${n - 1}" step="1" value="${this.t}" aria-label="Time">
      </div>
      <div class="sky-block" style="grid-area:readout"><div class="sky-readout"></div>${this.opts.large ? legend : ''}</div>
      <div class="sky-block" style="grid-area:pano">
        <div class="sky-cap">Horizon panorama <span class="muted">· the sky all the way round · paths over the period · vertical scale stretched</span></div>
        <svg class="sky-svg pano"></svg>
      </div>
      <div class="sky-block" style="grid-area:elev">
        <div class="sky-cap">Elevation over time <span class="muted">· dashed = terrain horizon in that direction</span></div>
        <svg class="sky-svg elev"></svg>
      </div>
      <div class="sky-block" style="grid-area:bars">
        <div class="sky-cap">In view <span class="muted">· power and direct-comms windows</span></div>
        <svg class="sky-svg bars"></svg>
      </div>
      <div class="sky-block" style="grid-area:power">
        <div class="sky-cap">Sunlight on a flat panel <span class="muted">· W/m²</span></div>
        <svg class="sky-svg power"></svg>
      </div>`;
    this.root.querySelector('.sky-slider').addEventListener('input', (e) => this.setTime(Number(e.target.value), true));
    this.root.querySelectorAll('[data-act="enlarge"]').forEach((b) => b.addEventListener('click', () => this.opts.onEnlarge?.()));
    if (!this.opts.large) this.root.querySelector('.pano').addEventListener('click', () => this.opts.onEnlarge?.());
    this.root.querySelector('[data-act="csv"]').addEventListener('click', () => this.downloadCsv());
    this.draw();
  }

  draw() {
    if (!this.series?.length || !this.root.querySelector('.pano')) return;
    const w = (cls) => Math.max(240, this.root.querySelector(`.${cls}`).parentElement.clientWidth);
    const big = this.opts.large;
    this.cursors = [];
    this.drawPano(w('pano'), big ? 300 : 130);
    this.drawElev(w('elev'), big ? 330 : 110);
    this.drawBars(w('bars'), big ? 96 : 50);
    this.drawPower(w('power'), big ? 172 : 64);
    this.updateCursor();
  }

  // ---- shared time axis ------------------------------------------------------------
  tx(i, W) { const pad = 34; return pad + (i / Math.max(this.series.length - 1, 1)) * (W - pad - 6); }
  ti(x, W) { const pad = 34; return ((x - pad) / (W - pad - 6)) * (this.series.length - 1); }

  timeAxis(svg, W, y) {
    const n = this.series.length;
    const days = n / 24;
    const ticks = days <= 1.5 ? 4 : Math.min(6, Math.max(3, Math.round(W / 110)));
    for (let k = 0; k <= ticks; k++) {
      const i = Math.round((k / ticks) * (n - 1));
      const t = this.series[i].t;
      const label = days <= 1.5 ? t.slice(11, 16) : t.slice(5, 10);
      const x = this.tx(i, W);
      el('line', { x1: x, x2: x, y1: y, y2: y + 3, class: 'ax' }, svg);
      const tx = el('text', { x, y: y + 13, class: 'axt', 'text-anchor': k === 0 ? 'start' : k === ticks ? 'end' : 'middle' }, svg);
      tx.textContent = label;
    }
  }

  scrub(svg, W) {
    const set = (ev) => {
      const b = svg.getBoundingClientRect();
      this.setTime(this.ti(((ev.clientX - b.left) / b.width) * W, W), true);
    };
    svg.addEventListener('pointerdown', (ev) => { svg.setPointerCapture(ev.pointerId); set(ev); });
    svg.addEventListener('pointermove', (ev) => { if (ev.buttons) set(ev); });
  }

  cursorLine(svg, H, W) {
    const c = el('line', { y1: 0, y2: H, class: 'cursor' }, svg);
    (this.cursors ??= []).push({ c, W });
  }

  // ---- horizon panorama ----------------------------------------------------------------
  drawPano(W, H) {
    const svg = this.root.querySelector('.pano');
    svg.innerHTML = '';
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('height', H);
    const s = this.series, sky = this.skyline ?? new Array(360).fill(0);
    // Centre the strip on Earth's average direction (so it isn't split at the edges).
    let cx = 0, cy = 0;
    s.forEach((p) => { cx += Math.sin(p.earth_az * Math.PI / 180); cy += Math.cos(p.earth_az * Math.PI / 180); });
    const centre = Math.hypot(cx, cy) > 1e-6 ? (Math.atan2(cx, cy) * 180 / Math.PI + 360) % 360 : 180;
    this.panoCentre = centre;
    const hi = Math.min(90, Math.max(2, ...sky, ...s.map((p) => Math.max(p.sun_el, p.earth_el))) + 1.5);
    const lo = Math.min(-2, ...sky) - 0.8;
    const padL = 34, top = 6, bot = H - 18;
    const X = (az) => padL + ((((az - centre + 540) % 360)) / 360) * (W - padL - 6);
    const Y = (e) => bot - ((e - lo) / (hi - lo)) * (bot - top);
    this.panoXY = { X, Y };
    // sky gradient + elevation grid
    el('rect', { x: padL, y: top, width: W - padL - 6, height: bot - top, class: 'pano-sky' }, svg);
    const step = (hi - lo) > 40 ? 15 : (hi - lo) > 12 ? 5 : (hi - lo) > 5 ? 2 : 1;
    for (let e = Math.ceil(lo / step) * step; e <= hi; e += step) {
      el('line', { x1: padL, x2: W - 6, y1: Y(e), y2: Y(e), class: e === 0 ? 'grid0' : 'grid' }, svg);
      el('text', { x: padL - 4, y: Y(e) + 3, class: 'axt', 'text-anchor': 'end' }, svg).textContent = `${e}°`;
    }
    // terrain skyline (filled), in screen order from the left edge
    const ordered = [];
    for (let k = 0; k <= 360; k++) {
      const az = centre - 180 + k;
      ordered.push([padL + (k / 360) * (W - padL - 6), Y(skylineAt(sky, az))]);
    }
    el('polygon', {
      points: `${padL},${bot} ` + ordered.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ') + ` ${W - 6},${bot}`,
      class: 'pano-terrain',
    }, svg);
    // compass labels
    for (const [az, name] of [[0, 'N'], [90, 'E'], [180, 'S'], [270, 'W']]) {
      const x = X(az);
      el('line', { x1: x, x2: x, y1: bot, y2: bot + 3, class: 'ax' }, svg);
      el('text', { x, y: bot + 13, class: 'axt strong', 'text-anchor': 'middle' }, svg).textContent = name;
    }
    // paths over the period: solid where in view, faint where hidden
    const path = (az, elv, vis, color) => {
      let seg = [], segVis = null, prevX = null;
      const flush = () => {
        if (seg.length > 1) el('polyline', { points: seg.join(' '), class: 'pano-path', stroke: color, 'stroke-opacity': segVis ? 0.95 : 0.25 }, svg);
        seg = [];
      };
      for (let i = 0; i < s.length; i++) {
        const x = X(az(s[i])), y = Y(elv(s[i])), v = vis(s[i]);
        if (prevX !== null && (Math.abs(x - prevX) > (W - padL) / 2 || v !== segVis)) {
          if (v !== segVis && Math.abs(x - prevX) <= (W - padL) / 2) seg.push(`${x.toFixed(1)},${y.toFixed(1)}`);
          flush();
        }
        segVis = v;
        seg.push(`${x.toFixed(1)},${y.toFixed(1)}`);
        prevX = x;
      }
      flush();
    };
    path((p) => p.sun_az, (p) => p.sun_el, (p) => p.sun_visible, SUN);
    path((p) => p.earth_az, (p) => p.earth_el, (p) => p.earth_visible, EARTH);
    // live markers
    this.sunDot = el('circle', { r: 6, class: 'dot-sun' }, svg);
    this.earthDot = el('circle', { r: 5, class: 'dot-earth' }, svg);
  }

  // ---- elevation chart --------------------------------------------------------------------
  drawElev(W, H) {
    const svg = this.root.querySelector('.elev');
    svg.innerHTML = '';
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('height', H);
    const s = this.series, sky = this.skyline;
    const vals = s.flatMap((p) => [p.sun_el, p.earth_el]);
    const hi = Math.min(90, Math.max(...vals, 1) + 1), lo = Math.max(-90, Math.min(...vals, -1) - 1);
    const top = 6, bot = H - 18;
    const Y = (e) => bot - ((e - lo) / (hi - lo)) * (bot - top);
    const step = (hi - lo) > 60 ? 30 : (hi - lo) > 20 ? 10 : (hi - lo) > 8 ? 2 : 1;
    for (let e = Math.ceil(lo / step) * step; e <= hi; e += step) {
      el('line', { x1: 34, x2: W - 6, y1: Y(e), y2: Y(e), class: e === 0 ? 'grid0' : 'grid' }, svg);
      el('text', { x: 30, y: Y(e) + 3, class: 'axt', 'text-anchor': 'end' }, svg).textContent = `${e}°`;
    }
    const line = (f, color, dash) => el('polyline', {
      points: s.map((p, i) => `${this.tx(i, W).toFixed(1)},${Y(Math.max(lo, Math.min(hi, f(p)))).toFixed(1)}`).join(' '),
      fill: 'none', stroke: color, 'stroke-width': dash ? 1 : 1.6, 'stroke-dasharray': dash ? '3 3' : '', 'stroke-opacity': dash ? 0.6 : 1,
    }, svg);
    line((p) => skylineAt(sky, p.sun_az), SUN, true);
    line((p) => skylineAt(sky, p.earth_az), EARTH, true);
    line((p) => p.sun_el, SUN);
    line((p) => p.earth_el, EARTH);
    this.timeAxis(svg, W, bot);
    this.cursorLine(svg, bot, W);
    this.scrub(svg, W);
  }

  // ---- in-view bars ------------------------------------------------------------------
  drawBars(W, H) {
    const svg = this.root.querySelector('.bars');
    svg.innerHTML = '';
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('height', H);
    const s = this.series;
    const rows = [['Sun', (p) => p.sun_visible, SUN], ['Earth', (p) => p.earth_visible, EARTH], ['Both', (p) => p.sun_visible && p.earth_visible, BOTH]];
    const rh = (H - 4) / rows.length;
    rows.forEach(([name, f, color], k) => {
      const y = 2 + k * rh;
      el('rect', { x: 34, y: y + 2, width: W - 40, height: rh - 5, class: 'bar-bg' }, svg);
      el('text', { x: 30, y: y + rh / 2 + 3, class: 'axt', 'text-anchor': 'end' }, svg).textContent = name;
      let start = null;
      for (let i = 0; i <= s.length; i++) {
        const v = i < s.length && f(s[i]);
        if (v && start === null) start = i;
        if (!v && start !== null) {
          const x0 = this.tx(start, W), x1 = this.tx(Math.min(i, s.length - 1), W);
          el('rect', { x: x0, y: y + 2, width: Math.max(1, x1 - x0), height: rh - 5, fill: color, 'fill-opacity': 0.85 }, svg);
          start = null;
        }
      }
    });
    this.cursorLine(svg, H, W);
    this.scrub(svg, W);
  }

  // ---- power ----------------------------------------------------------------------------
  drawPower(W, H) {
    const svg = this.root.querySelector('.power');
    svg.innerHTML = '';
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('height', H);
    const p = this.power;
    if (!p.length) return;
    const peak = Math.max(...p.map((q) => q.w_m2), 1);
    const top = 6, bot = H - 18;
    const Y = (v) => bot - (v / peak) * (bot - top);
    el('polygon', {
      points: `34,${bot} ` + p.map((q, i) => `${this.tx(i, W).toFixed(1)},${Y(q.w_m2).toFixed(1)}`).join(' ') + ` ${this.tx(p.length - 1, W)},${bot}`,
      fill: SUN, 'fill-opacity': 0.25, stroke: SUN, 'stroke-width': 1.2,
    }, svg);
    el('text', { x: 30, y: top + 8, class: 'axt', 'text-anchor': 'end' }, svg).textContent = `${Math.round(peak)}`;
    el('text', { x: 30, y: bot, class: 'axt', 'text-anchor': 'end' }, svg).textContent = '0';
    this.timeAxis(svg, W, bot);
    this.cursorLine(svg, bot, W);
    this.scrub(svg, W);
  }

  // ---- cursor + readout -------------------------------------------------------------------
  updateCursor() {
    const s = this.series;
    if (!s?.length) return;
    const i = this.t, p = s[i];
    for (const { c, W } of this.cursors ?? []) {
      const x = this.tx(i, W);
      c.setAttribute('x1', x); c.setAttribute('x2', x);
    }
    this.cursors = (this.cursors ?? []).filter(({ c }) => c.isConnected);
    if (this.panoXY && this.sunDot?.isConnected) {
      const { X, Y } = this.panoXY;
      this.sunDot.setAttribute('cx', X(p.sun_az)); this.sunDot.setAttribute('cy', Y(p.sun_el));
      this.sunDot.classList.toggle('hidden', !p.sun_visible);
      this.earthDot.setAttribute('cx', X(p.earth_az)); this.earthDot.setAttribute('cy', Y(p.earth_el));
      this.earthDot.classList.toggle('hidden', !p.earth_visible);
    }
    const next = (f, want) => {
      for (let k = i + 1; k < s.length; k++) if (Boolean(f(s[k])) === want) return k - i;
      return null;
    };
    const state = (name, elv, az, vis, f) => {
      const where = vis ? 'in view' : elv > 0 ? 'behind terrain' : 'below the horizon';
      const change = vis ? next(f, false) : next(f, true);
      const verb = vis ? (name === 'Sun' ? 'sets' : 'sets') : 'appears';
      const when = change === null ? (vis ? 'stays up for the rest of the period' : 'stays hidden for the rest of the period') : `${verb} in ${fmtDur(change)}`;
      return `<div><span class="sw" style="background:${name === 'Sun' ? SUN : EARTH}"></span><b>${name}</b> ${fmtDeg(elv)} up · az ${az.toFixed(0)}° · ` +
        `<span class="${vis ? 'ok' : 'warn'}">${where}</span> · ${when}</div>`;
    };
    const w = this.power[i]?.w_m2 ?? 0;
    this.root.querySelector('.sky-readout').innerHTML =
      `<div class="muted">${fmtUtc(p.t)}</div>` +
      state('Sun', p.sun_el, p.sun_az, p.sun_visible, (q) => q.sun_visible) +
      state('Earth', p.earth_el, p.earth_az, p.earth_visible, (q) => q.earth_visible) +
      `<div class="muted">Flat panel: ${Math.round(w)} W/m² · ${p.sun_visible && p.earth_visible ? 'power and direct comms both available' : p.sun_visible ? 'power, but no direct comms' : p.earth_visible ? 'comms, but no sunlight (battery)' : 'no sunlight and no direct comms'}</div>`;
  }

  downloadCsv() {
    const rows = [['time_utc', 'sun_el_deg', 'sun_az_deg', 'sun_in_view', 'earth_el_deg', 'earth_az_deg', 'earth_in_view', 'terrain_horizon_sun_deg', 'terrain_horizon_earth_deg', 'flat_panel_w_m2']];
    this.series.forEach((p, i) => rows.push([p.t, p.sun_el, p.sun_az, p.sun_visible, p.earth_el, p.earth_az, p.earth_visible,
      skylineAt(this.skyline, p.sun_az).toFixed(2), skylineAt(this.skyline, p.earth_az).toFixed(2), this.power[i]?.w_m2 ?? '']));
    downloadText(`lunarcy-timeline-${this.series[0].t.slice(0, 10)}.csv`, rows.map((r) => r.join(',')).join('\n'));
  }
}

export function downloadText(name, text, type = 'text/csv') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
