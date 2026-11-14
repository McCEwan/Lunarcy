# AI Use Log

A running record of how we used AI tools on Lunar Planner: what the AI did, what we checked ourselves, and what is still unverified. **Add an entry at the end of every AI-assisted session.** The template is at the bottom.

## Tools

| Tool | Used for |
|---|---|
| Claude Code (Claude Opus 5.5), Claude desktop app | Planning, writing code and docs, running tests, research, driving a browser to check the app and NASA tools |

## How we use AI

- AI-written code goes through the same review as ours: we read the diff before it's merged.
- Facts the app shows (coordinates, dates, lander specs) need a cited source. AI-found sources are opened and checked by a person before demo day.
- Placeholder or estimated data is labelled in the app and in the data files. AI must not present it as real.
- When AI and a NASA tool disagree, the NASA tool wins.

---

## Log

### 2026-11-14 · Session 1: project setup and skeleton

- **Who:** _[team member name]_
- **Tool:** Claude Code (Opus 5.5), desktop app
- **Prompted with:** our `ARCHITECTURE.md` design doc; asked where to start and for a starter repo.
- **What the AI did:**
  - Recommended the workflow: a shared GitHub repo, a frontend/backend split at the `/evaluate` contract, and a `CLAUDE.md` so both teammates' Claude sessions share context.
  - Wrote the skeleton: FastAPI app (`/evaluate`, `/landers`, `/health`), evaluator, terrain lookup, synthetic terrain-grid script, `landers.json` (Blue Ghost, Nova-C), globe.gl frontend, and 19 pytest tests.
  - Ran the tests and clicked through the app in a browser. That turned up a bug (estimated launch dates in the past, because the window search ignored transit time), which it fixed and covered with a test.
- **What a human checked:** _[fill in: e.g. read the code, ran the app locally]_
- **Still unverified / known limits:**
  - Lander values in `estimated_fields` (solar array area and efficiency, max slope, max temperature) are AI estimates, not published specs.
  - Terrain grids are synthetic.
  - The first ephemeris was a rough analytic placeholder. It was replaced with Horizons in session 2.

### 2026-11-14 · Session 2: JPL Horizons, Moon Trek, QuickMap, notable landing sites

- **Who:** _[team member name]_
- **Tool:** Claude Code (Opus 5.5), desktop app, including its built-in browser and web search
- **Prompted with:** "add previous landing sites (Apollo, future CLPS); use Moon Trek, QuickMap and Horizons (mentor's suggestion); keep a running AI-use document". Also the challenge's Resources page.
- **What the AI did:**
  - Read the challenge's Details and Resources pages to pick features: a curated site list, custom coordinates, and time to sunset/Earthset.
  - **Horizons:** tested the API from a lunar surface site (`CENTER='coord@301'`). Compared it with the old placeholder model, which was up to 14° off for Earth elevation. Made Horizons the default ephemeris, with a disk cache and a labelled offline fallback. Added azimuths and sunrise/sunset/Earthrise/Earthset times to the API.
  - **Moon Trek:** found the WMTS tile service and its layer list. Wrote `scripts/fetch_moontrek_layers.py` to stitch four global layers (WAC imagery, LOLA elevation, LOLA slope, Diviner max temperature) into globe textures, and added a layer switcher.
  - **QuickMap:** QuickMap has no documented link format, so the AI worked it out by experiment. It found the projection IDs (16 cylindrical, 26/27 polar) and the `prjExtent` units, then confirmed each projection by opening a generated link and reading QuickMap's cursor coordinates (IM-1: asked for 80.13°S 1.44°E, got 80.16°S 1.39°E; asked for 82°N 60°E, got 81.99°N 60.05°E).
  - **Landing sites:** compiled `api/data/sites.json` (24 sites) from Wikipedia's *List of artificial objects on the Moon* (LROC-derived coordinates), NASA's LRO image release for IM-1, LROC pages for Blue Ghost M1 and IM-2, and The Planetary Society's CLPS page for planned missions.
  - Added tests: Horizons parsing, cache and fallback; site data checks; and two live Horizons checks (`RUN_LIVE=1`).
- **Checks the AI ran on its own output:**
  - Horizons gives the Sun about 10.6° above the eastern horizon at Apollo 11's landing (1969-07-20 20:00 UTC). That's consistent with the roughly 10.8° NASA reported for the landing.
  - Horizons gives the Sun 3° up in the east at Blue Ghost M1's touchdown, which fits a planned early-morning landing.
  - The stitched Moon Trek layers line up with each other (maria at the same longitudes, far-side highlands at the edges).
- **What a human checked:** _[fill in]_
- **Still unverified / known limits:**
  - **Planned CLPS sites are approximate** (`precision: "region"`). Griffin-1, IM-3 and the Firefly Gruithuisen mission have no published landing coordinates, so the points are at the named feature. Launch years come from late-2026 web sources and change often.
  - **IM-2's coordinates are its published target**; Athena came down about 250 m away.
  - Wikipedia rate-limited the AI partway through, so SLIM and Chang'e 3 coordinates come from those missions' own Wikipedia pages and were not cross-checked against LROC.
  - Blue Ghost Mission 2 isn't in the list because no site has been published (only "far side").
  - Elevations are against the smooth-sphere horizon. Crater rims and mountains aren't modeled, which matters most at the south pole.

### 2026-11-14 · Session 3: 3D landing-site view and timelapse

- **Who:** _[team member name]_
- **Tool:** Claude Code (Opus 5.5), desktop app, including its built-in browser
- **Prompted with:** feasibility questions first (no code), then "start on" the scene/timelapse, precise landing hour, terrain patch and horizon profile steps. Real data wherever possible; generic textures are fine for the Moon and Earth.
- **What the AI did:**
  - Backend: landing windows are now searched hourly, each with a suggested landing hour (`start_time`). `/evaluate` accepts `landing_time`, so the series runs from touchdown to mission end. Added `api/patch.py` with `/terrain/patch` and `/terrain/horizon`. They're built on a pluggable height source so real LOLA data can drop in, with a clearly labelled synthetic placeholder for now.
  - Frontend: `web/site3d.js` (three.js) has a terrain mesh with curvature, sunlight and shadows from the Horizons Sun direction, the Sun and Earth at true angular size, Earth's phase from the geometry, the skyline ring, compass labels, overview and "stand at the lander" views, and a timelapse with a live readout (power, comms, time to sunset/Earthset, "behind terrain").
  - Tests: hourly windows (the suggested hour passes, the hour before fails), `landing_time` handling, patch orientation (row 0 = north), and horizon correctness against analytic cases (flat ground gives the expected −0.08° dip; a 2 km ridge 10 km east gives about 11°, in the east only).
- **Checks the AI ran on its own output:**
  - In the browser: the Sun rises at azimuth 95° (east) and sets at 267° (west) at Chandrayaan-3. Daylight lasts about 15.3 days. Sunlight switches off after sunset.
  - Earth's phase is about 80% lit at local sunrise and 30% at sunset, consistent with Moon-phase geometry.
  - The ground view at IM-1 shows the Sun about 9° above the north-east horizon, with N to the left, as expected for azimuth 41°.
  - Toned the placeholder hills down after the first version produced unrealistic 19–25° skylines.
- **What a human checked:** _[fill in]_
- **Still unverified / known limits:**
  - **Terrain in the 3D view and the skyline are synthetic placeholders**, so "behind terrain" moments aren't real yet. They become real when a LOLA height source replaces `SyntheticHeights`.
  - The `/evaluate` sunlight and Earth-visibility percentages still ignore terrain (only the 3D readout uses the skyline). They can be wired to the horizon profile once the terrain is real.
  - The Sun is modelled as a point for lighting (the light switches at the Sun's centre), so partial-disc sunrise and sunset are approximate.

---

## Entry template

```markdown
### YYYY-MM-DD · Session N: short title

- **Who:**
- **Tool:**
- **Prompted with:**
- **What the AI did:**
- **Checks the AI ran on its own output:**
- **What a human checked:**
- **Still unverified / known limits:**
```
