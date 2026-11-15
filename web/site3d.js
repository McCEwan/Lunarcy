// 3D view of a landing site: local terrain, the Sun and Earth at their real
// positions (JPL Horizons az/el from /evaluate), and a timelapse across the
// mission. three.js is loaded from a CDN through the import map in index.html.
//
// Coordinates: 1 unit = 1 metre. three.js is y-up, so
//   x = east, y = up, z = -north   and a body at azimuth az (clockwise from
//   north) and elevation el sits in the direction
//   (sin az · cos el, sin el, -cos az · cos el).

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const MOON_R = 1737400;          // metres
const SKY_D = 80000;             // distance at which sky objects are drawn
const SUN_RADIUS_DEG = 0.2665;   // true angular radius of the Sun
const EARTH_RADIUS_DEG = 0.95;   // true angular radius of Earth seen from the Moon
const PATCH_KM = 20;
const PATCH_N = 257;             // odd, so there is a vertex exactly at the site
const D2R = Math.PI / 180;

export function dirFromAzEl(az, el) {
  const a = az * D2R, e = el * D2R;
  return new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e));
}

let active = null;   // only one 3D view at a time

/**
 * Open the 3D view.
 * @param {object} opts
 * @param {string} opts.title       e.g. "IM-1 Odysseus"
 * @param {number} opts.lat, opts.lon
 * @param {object} opts.result      the /evaluate response for this site
 * @param {boolean} opts.landed     true when the series starts at a chosen landing time
 */
export async function open3dView(opts) {
  if (active) active.close();
  active = new SiteView(opts);
  window.__lunar3d = active;   // handy for debugging in the browser console
  await active.init();
}

class SiteView {
  constructor({ title, lat, lon, result, landed, level = 'global', initialT = 0, onPlan = null }) {
    Object.assign(this, { title, lat, lon, result, landed, level, onPlan });
    this.series = result.sky;
    this.sunPerM2 = result.power_w.map((p) => p.w_m2);   // sunlight on a flat panel, W/m²
    this.t = Math.min(initialT, this.series.length - 1);   // fractional index into the hourly series
    this.playing = false;
    this.speed = 6;             // simulated hours per real second
    this.exaggeration = 1;      // true scale, always
    this.sunScale = 6;          // Sun and Earth drawn larger than life so they're easy to see
    this.earthScale = 3;
    this.view = 'overview';
    this.el = document.getElementById('view3d');
    this.disposers = [];
  }

  // ---- Setup -------------------------------------------------------------------

  async init() {
    this.el.hidden = false;
    document.getElementById('v3d-title').textContent = this.title;
    document.getElementById('v3d-sub').textContent =
      `${fmtLat(this.lat)}, ${fmtLon(this.lon)} · ${this.landed ? 'timelapse from landing to mission end' : 'timelapse over the next lunar day'}`;
    this.setNote('Loading terrain…');
    const detailed = this.level === 'detailed';
    document.getElementById('v3d-level').innerHTML = detailed
      ? '<span class="badge pass">Detailed terrain</span>'
      : '<span class="badge level">Global estimate</span>';

    const q = `lat=${this.lat}&lon=${this.lon}&level=${this.level}`;
    const n = detailed ? 2 * PATCH_N - 1 : PATCH_N;   // ~39 m vertices for detailed data
    const [patch, horizon] = await Promise.all([
      fetch(`/terrain/patch?${q}&size_km=${PATCH_KM}&n=${n}`).then((r) => r.json()),
      fetch(`/terrain/horizon?${q}`).then((r) => r.json()),
    ]);
    if (active !== this) return;  // closed while loading
    this.patch = patch;
    this.skyline = horizon.elevation_deg;

    this.buildRenderer();
    this.buildTerrain();
    this.buildSkylineOccluder();
    this.buildSky();
    this.bindControls();
    this.setView('overview');

    const skySource = this.result.sources.find((s) => /ephemeris|Horizons/i.test(s)) ?? '';
    this.setNote(
      `Sun & Earth: ${skySource || 'see Sources'}. ` +
      `Terrain: ${patch.source}. ` +
      'Moon and Earth surfaces are generic textures; the Sun and Earth are drawn 6× and 3× their true size so they are easy to see.'
    );

    this.update();
    this.loop();
    this.loadPlan();       // solar array, comms hub, routes, ice: drawn when it arrives
  }

  // ---- Site plan (GET /site/plan, api/siteplan.py) --------------------------------------

  async loadPlan() {
    const p = this.result.period;
    const q = new URLSearchParams({ lat: this.lat, lon: this.lon, level: this.level });
    if (p?.start) {
      q.set('start', p.start.slice(0, 10));
      // Placement needs at least half a month of Sun and Earth motion; shorter periods use a lunar day.
      if ((Date.parse(p.end) - Date.parse(p.start)) / 864e5 >= 14) {
        q.set('end', new Date(Date.parse(p.end) - 864e5).toISOString().slice(0, 10));
      }
    }
    this.renderPlanPanel(null, 'Planning the solar array, comms hub and routes…');
    try {
      const res = await fetch(`/site/plan?${q}`);
      const plan = await res.json();
      if (!res.ok) throw new Error(typeof plan.detail === 'string' ? plan.detail : `HTTP ${res.status}`);
      if (active !== this) return;
      this.plan = plan;
      this.buildPlan(plan);
      this.renderPlanPanel(plan);
      this.onPlan?.(plan);
    } catch (err) {
      if (active === this) this.renderPlanPanel(null, `Site plan failed: ${err.message}`);
    }
  }

  // Terrain height (scene y) at local east/north metres: bilinear on the patch, with curvature.
  heightAt(e, n) {
    const { n: N, size_m: size } = this.patch;
    const sp = size / (N - 1);
    const fx = Math.min(Math.max((e + size / 2) / sp, 0), N - 1.001);
    const fy = Math.min(Math.max((size / 2 - n) / sp, 0), N - 1.001);
    const c0 = Math.floor(fx), r0 = Math.floor(fy), tx = fx - c0, ty = fy - r0;
    const H = (r, c) => this.baseHeights[r * N + c];
    const h = (H(r0, c0) * (1 - tx) + H(r0, c0 + 1) * tx) * (1 - ty) + (H(r0 + 1, c0) * (1 - tx) + H(r0 + 1, c0 + 1) * tx) * ty;
    return h * this.exaggeration - (e * e + n * n) / (2 * MOON_R);
  }

  buildPlan(plan) {
    const g = new THREE.Group();
    this.planGroup = g;
    this.scene.add(g);
    const half = this.patch.size_m / 2;
    const v = (e, n, lift) => new THREE.Vector3(e, this.heightAt(e, n) + lift, -n);
    const fmtKm = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

    const marker = (e, n, color, label, poleH) => {
      const m = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(28, 28, poleH, 10), new THREE.MeshBasicMaterial({ color }));
      pole.position.y = poleH / 2;
      const cap = new THREE.Mesh(new THREE.SphereGeometry(90, 16, 12), new THREE.MeshBasicMaterial({ color }));
      cap.position.y = poleH;
      const tag = textSprite(label, color, 520);
      tag.position.y = poleH + 380;
      m.add(pole, cap, tag);
      m.position.copy(v(e, n, 0));
      g.add(m);
    };
    // A route as a tube draped over the terrain (lifted so it doesn't sink between samples).
    const tube = (pts, color, radius = 22) => {
      if (pts.length < 2) return null;
      const curve = new THREE.CatmullRomCurve3(pts.map(([e, n]) => v(e, n, 14)));
      const mesh = new THREE.Mesh(
        new THREE.TubeGeometry(curve, Math.min(pts.length * 6, 1200), radius, 8, false),
        new THREE.MeshBasicMaterial({ color }),
      );
      g.add(mesh);
      return curve;
    };
    // A dashed straight line on the ground (for "as the crow flies" legs).
    const dashed = (e0, n0, e1, n1, color) => {
      const steps = Math.max(2, Math.ceil(Math.hypot(e1 - e0, n1 - n0) / 80));
      const pts = Array.from({ length: steps + 1 }, (_, i) => {
        const t = i / steps;
        return v(e0 + (e1 - e0) * t, n0 + (n1 - n0) * t, 30);
      });
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineDashedMaterial({ color, dashSize: 260, gapSize: 160 }));
      line.computeLineDistances();
      g.add(line);
    };
    const label = (pos, text, color, size = 420) => {
      const t = textSprite(text, color, size);
      t.position.copy(pos).add(new THREE.Vector3(0, 320, 0));
      g.add(t);
    };

    const { solar, comms, route, ice } = plan;
    const same = route?.same_spot;
    marker(solar.east_m, solar.north_m, '#ffd23f', same ? `Solar + comms${comms.tower ? ` · tower ${comms.tower.realistic_m} m (ideal ${comms.tower.ideal_m} m)` : ''}` : 'Solar array', 1500);
    const tw = comms.tower;
    const towerTxt = tw ? ` · tower ${tw.realistic_m} m (ideal ${tw.ideal_m} m)` : '';
    if (!same) marker(comms.east_m, comms.north_m, '#c39bff', `Comms hub${towerTxt}`, 2300);
    if (route && route.points.length > 1) {
      const curve = tube(route.points, '#ffffff');
      label(curve.getPoint(0.5), `${fmtKm(route.drive_m)} drive`, '#ffffff');
    }

    if (ice) {
      const iceName = ice.name ? `${ice.name}` : 'Ice candidate';
      if (ice.in_view) {
        let fromE = 0, fromN = 0;
        if (ice.route?.points.length > 1) {
          const curve = tube(ice.route.points, '#7fd0ff', 18);
          label(curve.getPoint(0.5), `${fmtKm(ice.route.drive_m)}`, '#7fd0ff', 380);
          [fromE, fromN] = ice.route.points.at(-1);
        }
        dashed(fromE, fromN, ice.east_m, ice.north_m, 0x7fd0ff);
        marker(ice.east_m, ice.north_m, '#7fd0ff', `${iceName} · ${fmtKm(ice.distance_m)}`, 700);
      } else {
        // Off the 20 km patch: a dashed line to the edge, an arrow, and the distance.
        const b = ice.bearing_deg * D2R, dx = Math.sin(b), dy = Math.cos(b);
        const L = (half * 0.96) / Math.max(Math.abs(dx), Math.abs(dy));
        dashed(0, 0, dx * L, dy * L, 0x7fd0ff);
        const tip = v(dx * L, dy * L, 60);
        const arrow = new THREE.Mesh(new THREE.ConeGeometry(160, 480, 16), new THREE.MeshBasicMaterial({ color: 0x7fd0ff }));
        arrow.position.copy(tip);
        arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(dx, 0, -dy));
        g.add(arrow);
        label(tip, `${iceName} → ${fmtKm(ice.distance_m)}`, '#7fd0ff', 480);
      }
    }
    g.visible = this.view === 'overview' && document.getElementById('v3d-plan-toggle').classList.contains('on');
  }

  renderPlanPanel(plan, message = '') {
    const el = document.getElementById('v3d-plan');
    el.hidden = !document.getElementById('v3d-plan-toggle').classList.contains('on');
    if (!plan) { el.innerHTML = `<h3>Site plan</h3><div class="small muted">${message}</div>`; return; }
    const km = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);
    const compass = (deg) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(deg / 45) % 8];
    const attr = (t) => String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const info = (tip) => ` <span class="info-i" data-tip="${attr(tip)}" tabindex="0">i</span>`;
    const { solar, comms, route, ice, grid } = plan;
    const fromLander = (s) => (s.drive_from_lander_m ? `${km(s.drive_from_lander_m)} drive from the lander` : 'at the lander');
    const days = plan.period ? `${plan.period.days} days from ${plan.period.start.slice(0, 10)}` : 'the period';
    const rough = grid.rough ? ` On the ~${Math.round(grid.resolution_m)} m global terrain this is a rough estimate.` : '';

    // Why each recommendation was made.
    const pickWhy = (s, body, pct, what) =>
      `Why here: we looked at ${s.why?.candidates ?? 'all'} spots within 5 km where the ground is no steeper than 10° ` +
      `and a rover can drive to (ground ≤15° all the way). For each we traced the real terrain skyline (NASA LOLA, out to 150 km) as seen from the top of a ` +
      `${s.mast_m} m mast, and counted the hours the ${body} is above it over ${days} (JPL Horizons positions). ` +
      `This spot ${what} ${pct}% of the time` +
      (s.why ? `, against ${s.why.lander_pct}% at the lander itself.` : '.') +
      ` Close calls go to the shorter drive (0.3 points per km).${rough}`;
    const solarWhy = pickWhy(solar, 'Sun', solar.sunlight_pct, 'is in sunlight');
    const commsWhy = pickWhy(comms, 'Earth', comms.earth_pct, 'can see Earth') +
      ' Seeing Earth means direct radio contact without a relay satellite.';
    const routeWhy = route?.same_spot
      ? 'The best solar and comms spots are the same place, so one mast can carry both.'
      : route
        ? `Why this path: it is the cheapest safe drive between the two spots. Ground steeper than 15° in any direction ` +
          `is off-limits (NASA's VIPER rover "can generally drive on slopes up to 15°"; driving across a steeper hillside ` +
          `risks tipping), and each step costs more the steeper it is, so gentle ground wins. The drive is ` +
          `${km(route.drive_m)} against ${km(route.straight_m)} in a straight line; the difference is the detour around ` +
          `steeper ground. Its steepest step is ${route.max_slope_deg}°.${rough}`
        : 'No path connects the two spots without crossing ground steeper than 15°.';
    const towerWhy = comms.tower
      ? `Why these heights: a taller antenna sees over nearby rims, so we repeated the Earth count at the comms spot for ` +
        `towers from 2 m to 500 m. Ideal = the lowest tower that gets within 1 point of the best result ` +
        `(${comms.tower.ideal_m} m → ${comms.tower.ideal_earth_pct}%). Realistic = the best up to 20 m, our estimate of ` +
        `what a small lander could deploy (${comms.tower.realistic_m} m → ${comms.tower.realistic_earth_pct}%). ` +
        `${comms.tower.reference}.`
      : '';
    let iceRow = '<div class="row k-ice">No ice candidate found</div>';
    if (ice) {
      const what = ice.name ? `<b>${ice.name}</b> (${ice.rating === 'known' ? 'published ice evidence' : 'likely cold trap'})` : '<b>a cold-trap cell</b>';
      const drive = ice.route
        ? `<br>Drive ${km(ice.route.drive_m)} to within ${km(ice.route.gap_to_ice_m)} of it (the rest is too steep at ≤15°).`
        : ice.in_view ? '<br>No drivable way in at ≤15° from here.' : '<br>Beyond the 20 km terrain patch (arrow at the edge; full line on the globe).';
      const iceWhy = `Why this target: water ice can last only where the surface never gets warmer than about −163 °C, ` +
        `which on the Moon means crater floors the Sun never reaches. Our ice map marks those from NASA LOLA terrain ` +
        `(the Sun can never rise above the rim) and LRO Diviner temperatures, plus craters where ice has actually been ` +
        `reported. This is the nearest of them to the lander. ${ice.basis}. The drive stops where ground gets steeper ` +
        `than 15°; crater walls usually are.`;
      iceRow = `<div class="row"><span class="k-ice">Nearest ice:</span>${info(iceWhy)} ${what}, ${km(ice.distance_m)} ${compass(ice.bearing_deg)} as the crow flies.${drive}</div>`;
    }
    el.innerHTML = `<h3>Site plan</h3>
      <div class="row"><span class="k-solar">Solar array:</span>${info(solarWhy)} <b>${solar.sunlight_pct}%</b> sunlight · ${fromLander(solar)} · slope ${solar.slope_deg}°</div>
      <div class="row"><span class="k-comms">Comms hub:</span>${info(commsWhy)} <b>${comms.earth_pct}%</b> Earth in view · ${fromLander(comms)} · slope ${comms.slope_deg}°</div>
      <div class="row"><span class="k-route">Route between them:</span>${info(routeWhy)} ${route
        ? (route.same_spot ? 'same spot: one mast does both.' : `<b>${km(route.drive_m)}</b> drive (${km(route.straight_m)} straight), steepest ${route.max_slope_deg}°`)
        : '<span class="rough">no drivable route at ≤15°</span>'}</div>
      ${comms.tower ? `<div class="row"><span class="k-comms">Comms tower:</span>${info(towerWhy)}
        realistic <b>${comms.tower.realistic_m} m</b> → ${comms.tower.realistic_earth_pct}% Earth in view ·
        ideal <b>${comms.tower.ideal_m} m</b> → ${comms.tower.ideal_earth_pct}%${comms.tower.beyond_concepts ? ' <span class="rough">(taller than current tower concepts, ~100–200 m)</span>' : ''}</div>` : ''}
      ${iceRow}
      <div class="small muted">Hover <span class="info-i">i</span> for why each was chosen.</div>
      ${grid.rough ? `<div class="small rough">Global terrain (~${Math.round(grid.resolution_m)} m): spots and routes are a rough estimate.</div>` : ''}`;
  }


  buildRenderer() {
    const host = document.getElementById('v3d-canvas');
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);   // no atmosphere: black sky
    this.camera = new THREE.PerspectiveCamera(60, 1, 10, 400000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = host;
      this.renderer.setSize(w, h);
      this.camera.aspect = w / Math.max(h, 1);
      this.camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(host);
    resize();
    this.disposers.push(() => ro.disconnect());
  }

  buildTerrain() {
    const { n, size_m: size, heights, center_height_m: h0 } = this.patch;
    const geo = new THREE.PlaneGeometry(size, size, n - 1, n - 1);
    geo.rotateX(-Math.PI / 2);     // plane row 0 (top) → north edge (−z)
    this.baseHeights = heights.map((h) => (h === null ? h0 : h) - h0);
    this.terrainGeo = geo;
    this.applyHeights();

    const mat = new THREE.MeshStandardMaterial({
      color: 0x9b9b9b, roughness: 1, metalness: 0, map: noiseTexture(),
    });
    this.terrain = new THREE.Mesh(geo, mat);
    this.terrain.castShadow = true;
    this.terrain.receiveShadow = true;
    this.scene.add(this.terrain);

    // Landing-site marker (hidden in ground view).
    this.marker = new THREE.Group();
    const pin = new THREE.Mesh(
      new THREE.CylinderGeometry(25, 25, 400, 12),
      new THREE.MeshBasicMaterial({ color: 0xff8c42 }),
    );
    pin.position.y = 200;
    const tag = textSprite('Landing site', '#ffb37a', 620);
    tag.position.y = 650;
    this.marker.add(pin, tag);
    this.scene.add(this.marker);

    // Sunlight: a directional light that follows the Sun's direction.
    this.sunLight = new THREE.DirectionalLight(0xffffff, 3);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(4096, 4096);
    const s = this.sunLight.shadow.camera;
    s.left = s.bottom = -size * 0.8;          // covers the patch and the skyline occluder ring
    s.right = s.top = size * 0.8;
    s.near = 1;
    s.far = 200000;
    this.sunLight.shadow.bias = -0.0003;
    this.sunLight.shadow.normalBias = 20;
    this.scene.add(this.sunLight, this.sunLight.target);

    // Earthshine: faint fill light that grows with Earth's lit fraction.
    this.ambient = new THREE.AmbientLight(0xbfd4ff, 0.03);
    this.scene.add(this.ambient);
  }

  applyHeights() {
    const pos = this.terrainGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const drop = (x * x + z * z) / (2 * MOON_R);          // curvature of the Moon
      pos.setY(i, this.baseHeights[i] * this.exaggeration - drop);
    }
    pos.needsUpdate = true;
    this.terrainGeo.computeVertexNormals();
    this.terrainGeo.computeBoundingSphere();
  }

  // Terrain beyond the 20 km patch (distant mountains, crater rims) still blocks the Sun.
  // An invisible ring just outside the patch, as tall as the real skyline seen from the
  // site in each direction, casts those shadows: exact at the landing site, approximate
  // elsewhere on the patch.
  buildSkylineOccluder() {
    const R = this.patch.size_m * 0.73;      // just beyond the patch corners
    const bottom = -8000;
    const pos = [];
    for (let i = 0; i < 360; i++) {
      const a0 = i * D2R, a1 = (i + 1) * D2R;
      const top0 = 2 + R * Math.tan(Math.min(this.skyline[i], 80) * D2R);
      const top1 = 2 + R * Math.tan(Math.min(this.skyline[(i + 1) % 360], 80) * D2R);
      const p = (a, y) => [R * Math.sin(a), y, -R * Math.cos(a)];
      pos.push(...p(a0, bottom), ...p(a1, bottom), ...p(a1, top1));
      pos.push(...p(a0, bottom), ...p(a1, top1), ...p(a0, top0));
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.occluder = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      colorWrite: false, depthWrite: false, side: THREE.DoubleSide,   // shadows only, never drawn
    }));
    this.occluder.castShadow = true;
    this.scene.add(this.occluder);
  }

  buildSky() {
    // Everything in skyGroup is "at infinity": it follows the camera so angles stay true.
    this.skyGroup = new THREE.Group();
    this.scene.add(this.skyGroup);

    this.sun = new THREE.Mesh(
      new THREE.SphereGeometry(1, 32, 16),
      new THREE.MeshBasicMaterial({ color: 0xfff4d6 }),
    );
    this.sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture(), color: 0xffe9b0, transparent: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.skyGroup.add(this.sun, this.sunGlow);

    // Earth: plain blue sphere; its lit side faces the Sun, so the phase is real geometry.
    this.earthMat = new THREE.ShaderMaterial({
      uniforms: { sunDir: { value: new THREE.Vector3(0, 1, 0) }, base: { value: new THREE.Color(0x3d7fd9) } },
      vertexShader: `
        varying vec3 vN;
        void main() {
          vN = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 sunDir; uniform vec3 base; varying vec3 vN;
        void main() {
          float lit = max(dot(normalize(vN), sunDir), 0.0);
          gl_FragColor = vec4(base * (0.06 + 1.1 * lit), 1.0);
        }`,
    });
    this.earth = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), this.earthMat);
    this.skyGroup.add(this.earth);

    // Skyline from the horizon profile, plus the flat 0° horizon and compass labels.
    const R = SKY_D * 0.9;
    const skyPts = this.skyline.map((el, i) => dirFromAzEl(i, el).multiplyScalar(R));
    this.skyGroup.add(new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(skyPts),
      new THREE.LineBasicMaterial({ color: 0x5ee1ff, transparent: true, opacity: 0.8 }),
    ));
    const flatPts = Array.from({ length: 360 }, (_, i) => dirFromAzEl(i, 0).multiplyScalar(R));
    this.skyGroup.add(new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(flatPts),
      new THREE.LineBasicMaterial({ color: 0x445066, transparent: true, opacity: 0.6 }),
    ));
    for (const [label, az] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]]) {
      const sp = textSprite(label, '#cfd8ea', 3500);
      sp.position.copy(dirFromAzEl(az, 2.5).multiplyScalar(R));
      this.skyGroup.add(sp);
    }
  }

  // ---- Controls ------------------------------------------------------------------

  bindControls() {
    const $ = (id) => document.getElementById(id);
    const scrub = $('v3d-scrub');
    scrub.max = String(this.series.length - 1);
    scrub.value = String(this.t);   // reopening at a new terrain level keeps the moment

    const on = (el, ev, fn) => { el.addEventListener(ev, fn); this.disposers.push(() => el.removeEventListener(ev, fn)); };
    on($('v3d-play'), 'click', () => this.togglePlay());
    on($('v3d-speed'), 'change', (e) => { this.speed = Number(e.target.value); });
    on(scrub, 'input', (e) => { this.t = Number(e.target.value); this.update(); });
    on($('v3d-close'), 'click', () => this.close());
    on($('v3d-views'), 'click', (e) => { const v = e.target.dataset?.view; if (v) this.setView(v); });
    on($('v3d-plan-toggle'), 'click', (e) => {
      const on = !e.currentTarget.classList.contains('on');
      e.currentTarget.classList.toggle('on', on);
      if (this.planGroup) this.planGroup.visible = on && this.view === 'overview';
      document.getElementById('v3d-plan').hidden = !on;
    });
    on(document, 'keydown', (e) => {
      if (this.el.hidden) return;
      if (e.key === 'Escape') this.close();
      if (e.key === ' ' && e.target === document.body) { e.preventDefault(); this.togglePlay(); }
    });
    $('v3d-speed').value = String(this.speed);
  }

  togglePlay() {
    if (this.t >= this.series.length - 1) this.t = 0;   // replay from the start
    this.playing = !this.playing;
    document.getElementById('v3d-play').textContent = this.playing ? '❚❚ Pause' : '▶ Play';
    this.lastFrame = performance.now();
  }

  setView(view) {
    this.view = view;
    document.querySelectorAll('#v3d-views [data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
    const size = this.patch.size_m;
    this.marker.visible = view === 'overview';
    // The plan's tall markers only make sense from above.
    if (this.planGroup) this.planGroup.visible = view === 'overview' && document.getElementById('v3d-plan-toggle').classList.contains('on');
    if (view === 'overview') {
      this.camera.near = 10;
      this.camera.position.set(size * 0.55, size * 0.4, size * 0.55);   // above the south-east corner
      this.controls.target.set(0, 0, 0);
      this.controls.minDistance = 300;
      this.controls.maxDistance = size * 3;
    } else {
      // Stand at the lander (2 m up) and look toward the Sun or Earth.
      const s = this.sample();
      const az = view === 'sun' ? s.sunAz : s.earthAz;
      const el = Math.max(view === 'sun' ? s.sunEl : s.earthEl, 0);
      this.camera.near = 0.5;
      this.camera.position.set(0, 2, 0);
      this.controls.target.copy(dirFromAzEl(az, Math.min(el, 30))).add(this.camera.position);
      this.controls.minDistance = 0.5;
      this.controls.maxDistance = 2;
    }
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  // ---- Per-frame -----------------------------------------------------------------

  loop() {
    this.raf = requestAnimationFrame(() => this.loop());
    const now = performance.now();
    if (this.playing) {
      const dt = (now - (this.lastFrame ?? now)) / 1000;
      this.t = Math.min(this.t + dt * this.speed, this.series.length - 1);
      if (this.t >= this.series.length - 1) this.togglePlay();
      document.getElementById('v3d-scrub').value = String(this.t);
      this.update();
    }
    this.lastFrame = now;
    this.controls.update();
    this.skyGroup.position.copy(this.camera.position);
    this.renderer.render(this.scene, this.camera);
  }

  sample() {
    const s = this.series, t = this.t;
    const i = Math.min(Math.floor(t), s.length - 2), f = t - i;
    const lerp = (k) => s[i][k] + (s[i + 1][k] - s[i][k]) * f;
    const lerpAz = (k) => {
      let d = s[i + 1][k] - s[i][k];
      if (d > 180) d -= 360; if (d < -180) d += 360;
      return (s[i][k] + d * f + 360) % 360;
    };
    return {
      sunEl: lerp('sun_el'), sunAz: lerpAz('sun_az'),
      earthEl: lerp('earth_el'), earthAz: lerpAz('earth_az'),
      sunPerM2: this.sunPerM2[i] + (this.sunPerM2[i + 1] - this.sunPerM2[i]) * f,
      timeMs: Date.parse(s[0].t) + t * 3600e3,
    };
  }

  skylineAt(az) {
    const a = ((az % 360) + 360) % 360, i = Math.floor(a), f = a - i;
    const k = this.skyline;
    return k[i % 360] + (k[(i + 1) % 360] - k[i % 360]) * f;
  }

  update() {
    const s = this.sample();
    const sunDir = dirFromAzEl(s.sunAz, s.sunEl);
    const earthDir = dirFromAzEl(s.earthAz, s.earthEl);
    const scale = this.sunScale;

    // Sun
    const sunR = SKY_D * Math.tan(SUN_RADIUS_DEG * D2R) * scale;
    this.sun.position.copy(sunDir).multiplyScalar(SKY_D);
    this.sun.scale.setScalar(sunR);
    this.sunGlow.position.copy(this.sun.position);
    this.sunGlow.scale.setScalar(sunR * 10);
    this.sun.visible = this.sunGlow.visible = s.sunEl > -2;

    // Light: off once the Sun's centre is below the flat horizon; terrain shadows do the rest.
    this.sunLight.position.copy(sunDir).multiplyScalar(60000);
    this.sunLight.intensity = s.sunEl > -SUN_RADIUS_DEG ? 3 : 0;

    // Earth and its phase (fraction of the disc lit, as seen from the Moon)
    const earthR = SKY_D * Math.tan(EARTH_RADIUS_DEG * D2R) * this.earthScale;
    this.earth.position.copy(earthDir).multiplyScalar(SKY_D);
    this.earth.scale.setScalar(earthR);
    this.earthMat.uniforms.sunDir.value.copy(sunDir);
    this.earth.visible = s.earthEl > -2;
    const earthLit = (1 - sunDir.dot(earthDir)) / 2;
    // Baseline light so the surface stays readable at night: a cool, dim fill (plus
    // earthshine when Earth is up and lit). Daytime keeps a small fill so the
    // Sun's shadows still dominate.
    const night = s.sunEl <= 0 || this.sunLight.intensity === 0;
    this.ambient.intensity = (night ? 0.55 : 0.12) + (s.earthEl > 0 ? 0.25 * earthLit : 0);
    this.ambient.color.set(night ? 0x8fa8d8 : 0xbfd4ff);

    this.renderHud(s, earthLit);
  }

  renderHud(s, earthLit) {
    const sunBlocked = s.sunEl > 0 && s.sunEl < this.skylineAt(s.sunAz);
    const earthBlocked = s.earthEl > 0 && s.earthEl < this.skylineAt(s.earthAz);
    const sunUp = s.sunEl > 0 && !sunBlocked;
    const earthUp = s.earthEl > 0 && !earthBlocked;
    const tHours = this.t;
    const days = Math.floor(tHours / 24), hours = Math.floor(tHours % 24);
    const when = new Date(s.timeMs).toISOString().slice(0, 16).replace('T', ' ');

    const next = (key, rising) => {
      const ser = this.series;
      for (let i = Math.ceil(this.t); i < ser.length; i++) {
        const up = ser[i][key] > 0;
        if (rising ? up && ser[i - 1]?.[key] <= 0 : !up && ser[i - 1]?.[key] > 0) return i - this.t;
      }
      return null;
    };
    const inText = (h) => (h === null ? 'not in this period' : h < 48 ? `in ${h.toFixed(0)} h` : `in ${(h / 24).toFixed(1)} d`);
    const sunEvent = s.sunEl > 0 ? `sets ${inText(next('sun_el', false))}` : `rises ${inText(next('sun_el', true))}`;
    const earthEvent = s.earthEl > 0 ? `sets ${inText(next('earth_el', false))}` : `rises ${inText(next('earth_el', true))}`;

    document.getElementById('v3d-time').textContent = `${when} UTC`;
    document.getElementById('v3d-hud').innerHTML = `
      <div class="big">${when} UTC</div>
      <div class="muted">${this.landed ? 'T+' : 'Start +'}${days} d ${hours} h${this.landed ? ' since landing' : ''}</div>
      <hr>
      <div>Sun <b>${s.sunEl.toFixed(1)}°</b> el · ${s.sunAz.toFixed(0)}° az ${sunBlocked ? '<span class="warn">behind terrain</span>' : ''}</div>
      <div class="muted">${sunEvent}</div>
      <div>Earth <b>${s.earthEl.toFixed(1)}°</b> el · ${s.earthAz.toFixed(0)}° az ${earthBlocked ? '<span class="warn">behind terrain</span>' : ''}</div>
      <div class="muted">${earthEvent} · ${(earthLit * 100).toFixed(0)}% lit</div>
      <hr>
      <div>Sunlight on panel <b>${sunBlocked ? 0 : s.sunPerM2.toFixed(0)} W/m²</b>${sunBlocked ? ' <span class="muted">(terrain shadow)</span>' : ''}</div>
      <div>Direct-to-Earth comms <b class="${earthUp ? 'ok' : 'warn'}">${earthUp ? 'available' : 'none'}</b></div>
      <div>${sunUp ? 'Daylight' : 'Dark'}</div>`;
  }

  setNote(text) {
    document.getElementById('v3d-note').textContent = text;
  }

  close() {
    cancelAnimationFrame(this.raf);
    this.disposers.forEach((d) => d());
    if (this.renderer) {
      this.scene.traverse((o) => {
        o.geometry?.dispose();
        const m = o.material;
        (Array.isArray(m) ? m : m ? [m] : []).forEach((mm) => { mm.map?.dispose(); mm.dispose(); });
      });
      this.renderer.dispose();
      this.renderer.domElement.remove();
    }
    this.el.hidden = true;
    document.getElementById('v3d-plan').hidden = true;
    document.getElementById('v3d-play').textContent = '▶ Play';
    if (active === this) active = null;
  }
}

// ---- Small helpers ------------------------------------------------------------------

function fmtLat(lat) { return `${Math.abs(lat).toFixed(2)}°${lat < 0 ? 'S' : 'N'}`; }
function fmtLon(lon) { return `${Math.abs(lon).toFixed(2)}°${lon < 0 ? 'W' : 'E'}`; }

// Generic grey regolith-ish noise, tiled across the terrain.
function noiseTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const img = g.createImageData(256, 256);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 150 + Math.random() * 60;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(60, 60);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,240,1)');
  grad.addColorStop(0.15, 'rgba(255,240,200,0.5)');
  grad.addColorStop(1, 'rgba(255,220,150,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

function textSprite(text, color, height) {
  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  g.font = 'bold 64px system-ui, sans-serif';
  c.width = Math.ceil(g.measureText(text).width) + 16;
  c.height = 80;
  g.font = 'bold 64px system-ui, sans-serif';
  g.fillStyle = color;
  g.textBaseline = 'middle';
  g.fillText(text, 8, 42);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthWrite: false }));
  sp.scale.set(height * (c.width / c.height), height, 1);
  return sp;
}
