// Deep links from any lunar lat/lon into the NASA tools the challenge recommends.
// Longitudes are east-positive, -180..180, everywhere.

const MOON_R_M = 1737400; // QuickMap's lunar radius (meters)

// LROC QuickMap (quickmap.lroc.im-ldi.com). The view is set with `prjExtent`
// (meters, in the chosen projection):
//   proj=16 equidistant cylindrical (valid below ±75°): x = R·lon, y = R·lat
//   proj=27 south-pole stereographic, proj=26 north-pole stereographic
export function quickmapUrl(lat, lon, halfWidthM = 20000) {
  const rad = Math.PI / 180;
  let proj, x, y;
  if (Math.abs(lat) < 75) {
    proj = 16;
    x = MOON_R_M * lon * rad;
    y = MOON_R_M * lat * rad;
  } else {
    const south = lat < 0;
    proj = south ? 27 : 26;
    const rho = 2 * MOON_R_M * Math.tan(((90 - Math.abs(lat)) / 2) * rad);
    x = rho * Math.sin(lon * rad);
    y = (south ? 1 : -1) * rho * Math.cos(lon * rad);
  }
  const ext = [x - halfWidthM, y - halfWidthM, x + halfWidthM, y + halfWidthM].map((v) => v.toFixed(0));
  return `https://quickmap.lroc.im-ldi.com/?prjExtent=${ext.join(',')}&proj=${proj}`;
}

// NASA Moon Trek (trek.nasa.gov/moon). The hash takes x=lon, y=lat, z=zoom.
export function moontrekUrl(lat, lon, zoom = 9) {
  const e = [lon - 0.7, lat - 0.5, lon + 0.7, lat + 0.5].map((v) => v.toFixed(4)).join(',');
  return 'https://trek.nasa.gov/moon/#v=0.1' +
    `&x=${lon.toFixed(4)}&y=${lat.toFixed(4)}&z=${zoom}` +
    '&p=urn%3Aogc%3Adef%3Acrs%3AEPSG%3A%3A104903&d=&locale=&b=moon' +
    `&e=${e}&sfz=&w=`;
}

// JPL Horizons: the raw az/el table the backend uses, as plain text, for a body
// ('10' = Sun, '399' = Earth) seen from this spot on the Moon, at the site's
// LOLA elevation (km above the 1737.4 km sphere).
export function horizonsUrl(lat, lon, body, startIso, days = 30, altKm = 0) {
  const start = new Date(startIso);
  const stop = new Date(start.getTime() + days * 86400e3);
  const fmt = (d) => d.toISOString().slice(0, 16).replace('T', ' ');
  const params = new URLSearchParams({
    format: 'text',
    COMMAND: `'${body}'`,
    OBJ_DATA: "'NO'",
    MAKE_EPHEM: "'YES'",
    EPHEM_TYPE: "'OBSERVER'",
    CENTER: "'coord@301'",
    COORD_TYPE: "'GEODETIC'",
    SITE_COORD: `'${lon.toFixed(3)},${lat.toFixed(3)},${altKm.toFixed(3)}'`,
    START_TIME: `'${fmt(start)}'`,
    STOP_TIME: `'${fmt(stop)}'`,
    STEP_SIZE: "'60m'",
    QUANTITIES: "'4'",
    ANG_FORMAT: "'DEG'",
  });
  return `https://ssd.jpl.nasa.gov/api/horizons.api?${params}`;
}
