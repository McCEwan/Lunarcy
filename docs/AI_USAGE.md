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

### 2026-11-14 · Session 4: real LOLA terrain (two levels), Horizons refinement, Sun & Earth on the globe

- **Who:** _[team member name]_
- **Tool:** Claude Code (Opus 5.5), desktop app, including its built-in browser
- **Prompted with:** "two-level estimate with the real elevation method, the detailed terrain button, the Horizons refinement, and Sun and Earth models in both levels". The AI asked four design questions first. Answers: globe + 3D view; LDEM_64 for the global level; replace the synthetic elevation/slope too (temperature stays a placeholder); make all numbers terrain-aware, with flat values alongside.
- **What the AI did:**
  - Checked what NASA PDS actually provides (file list, sizes, and that the server supports HTTP range and multi-range requests) before designing anything. It also confirmed by checking all 1,096 layers that Moon Trek's tile service has no numeric elevation layer, and that Horizons doesn't provide terrain.
  - `scripts/fetch_lola.py` (resumable LDEM_64 download) and `api/lola.py`: a memory-mapped global grid plus on-demand ~30 m patches that read only the needed bytes from 0.5–2 GB files (LDEM_1024 tiles, or LDEM_75S/N_30M near the poles), cached on disk.
  - Real elevation and slope in `terrain.py`; terrain skylines from LOLA applied to sunlight %, power, comms, landing windows and rise/set times; the site's LOLA elevation sent to Horizons as its altitude; a new `/sky/subpoints` query (Horizons sub-solar and sub-Earth points) so the globe is lit by the real Sun with Sun and Earth markers.
  - 3D view: real terrain at either level, its own detail button, and an invisible "skyline occluder" ring so distant mountains cast shadows on the 20 km patch.
  - Fixed two frontend issues found while testing: browsers reusing stale JS files (the server now sends `Cache-Control: no-cache`), and CSS overriding the `hidden` attribute on buttons.
- **Checks the AI ran on its own output:**
  - LDEM_64 at IM-1: 2,602 m, against NASA's published ~2,579 m. Apollo 11: −1,926 m (known ≈ −1.9 km).
  - Detailed patches vs the global grid: correlation 0.997–0.999, mean difference under 3 m. The south-pole map and the regular tiles agree at IM-1 (2,594 vs 2,595 m), confirming the undocumented polar orientation.
  - IM-1 detailed slope is 13.3° over 60 m, which fails Nova-C's 10° limit (published site slope ≈ 12°; Odysseus tipped over). The global grid alone gave 9.3°.
  - Shackleton crater floor: 0% sunlight and 0% Earth with terrain, against 100% sun on a flat horizon (a known permanently shadowed region). Shackleton rim ridge: 99.7% sunlight.
  - In 3D, a fake distant 30° skyline darkens the sunlit site (brightness 65.8 → 2.6), so the occluder works. The globe's lit hemisphere matches the Horizons sub-solar point.
  - The Horizons altitude refinement was measured honestly: it changes Sun/Earth angles by under 0.001°. Elevation matters through the skyline, e.g. a high rim sees over the curve of the Moon (Earth 47% vs 40% flat).
  - Tests: 59 offline, plus 17 live tests against NASA PDS and Horizons (`RUN_LIVE=1`).
- **What a human checked:** _[fill in]_
- **Still unverified / known limits:**
  - Temperature is still a placeholder (Diviner not added).
  - Slopes are terrain-scale (60 m or ~950 m baselines), not boulder-scale.
  - The Sun is treated as a point, so partial shadowing at a rim isn't modelled. The 3D occluder is exact only at the landing site itself.
  - The first detailed fetch needs internet and takes 3–7 s per site. Planned-site coordinates are approximate, so their "detailed" terrain is of the approximate point.
  - **Overlap with teammate:** at the user's request, `terrain.py` and `build_grids.py` were changed, the files the teammate was working in. Needs a conversation before merging.

### 2026-11-14 · Session 5: panel sunlight per m², colour-coded stats, compared-sites panel, LDEM_128

- **Who:** _[team member name]_
- **Tool:** Claude Code (Opus 5.5), desktop app, including its built-in browser
- **Prompted with:** a list of UI and data changes: power per m², enlarged Sun/Earth by default, replace the 2× relief option, red/yellow/green stats with a legend, the compared sites on the left, and a higher-resolution map. The AI asked clarifying questions in two rounds. Decisions: show *sunlight arriving on the panel* per m²; remove the 2× stretch entirely (no dropdown); keep the global map as the default (30 m stays on the button); download LDEM_128; keep the globe image; store the big data outside OneDrive.
- **What the AI did:**
  - Told the user the real sizes before downloading: 30 m LOLA for the whole Moon is ~136 GB (not practical); LDEM_128 is 2.1 GB, LDEM_256 8.5 GB, LDEM_512 34 GB. It also flagged that globe.gl's zoomable-map support uses web-map tiles that stop at ±85° latitude (no poles).
  - Spotted that the project is in OneDrive, so a 2.1 GB download would also upload to the cloud (free plans have 5 GB). Moved big data to `~/LunarPlannerData` (`api/paths.py`, override with `LUNAR_DATA_DIR`) and downloaded LDEM_128 there.
  - Added `w_m2` (sunlight on a flat panel per m²) to `/evaluate` and showed it instead of watts in the tiles, summaries and 3D readout.
  - Made the 3D view always true-scale vertically (removed 2× relief) and drew the Sun and Earth 6× and 3× true size, said on screen.
  - Added colour-coded stat tiles (`rateStats()` in `web/app.js`), with thresholds tied to the evaluator's pass/fail limits and the lander's slope limit, hover explanations, and a legend. Placeholder temperature and elevation are deliberately not rated.
  - Added a semi-transparent compared-sites panel on the left: click to fly to a site and expand its summary, × to remove.
- **Checks the AI ran on its own output:**
  - In the browser: added IM-1 and Apollo 11, clicked between them, and the globe moved and the summary switched. IM-1's slope (9.3° against Nova-C's 10°) and lunar-day sunlight (45%) showed yellow; Apollo 11's showed green.
  - 3D readout of 174 W/m² with the Sun at 7.4°, matching 1,361 × sin(7.4°) ≈ 175.
  - LDEM_128 vs LDEM_64 at IM-1: elevation 2,595 m (published ~2,579 m; LDEM_64 gave 2,602 m), and global-level slope 12.4° (published ~12°; LDEM_64 gave 9.3°). Shackleton's floor is still 0% sunlit.
  - Tests: 61 passing offline, plus 18 live, including new ones for `w_m2` and choosing the sharpest LOLA grid.
- **What a human checked:** _[fill in]_
- **Still unverified / known limits:**
  - The colour thresholds are the team's judgement calls (documented in `docs/ARCHITECTURE.md`), not NASA standards.
  - Panel sunlight assumes a flat, upward-facing panel. Real landers often use vertical or tilted panels at the poles, which catch far more of a low Sun.
  - Teammates must set up `~/LunarPlannerData` themselves (`python scripts/fetch_lola.py`).
- **Follow-up (same session):** the user noticed the poles looked flat on the globe. The AI measured it: the real-Sun lighting from Session 4 (fill light 0.45) cut fine crater detail near 80°S from 16.9 to 9.3, because the Sun is always within ~1.5° of the polar horizon. It raised the fill light to 1.8 and lowered the Sun to 2.3. In a test, similar settings brought pole detail back to ~17–19, and day and night are still visibly different (checked by screenshot). The Moon Trek image itself is genuinely smeared within ~5° of the pole; lighting can't fix that.

### 2026-11-14 · Session 6: analysis period (single day / date range) and comparison table

- **Who:** _[team member name]_
- **Tool:** Claude Code (Opus 5.5), desktop app, including its built-in browser
- **Prompted with:** "have the data be based on a certain day … a single day, or a range … if the user selects the day option the sunlight % is presented as hours of darkness/daylight in that 24 hr period, same with Earth" and "make the comparison UI fill in like a chart, values as headers, sites as rows". This followed the user's question about which period "30%" referred to; the app didn't say.
- **What the AI did:**
  - `/evaluate` takes `period_start`/`period_end` and returns a `period` block plus `sun_hours`/`earth_hours` (and flat-horizon versions). Hours interpolate the rise/set moment within the hour. Mission pass/fail checks still use the mission window when a different period is chosen.
  - Frontend: a global "Analysis period" picker (single day by default, today), hours out of 24 in day mode, "Stats for …" labels, a Sun/Earth status that describes the start of the period when it isn't "now", and period-aware colour thresholds.
  - Comparison: the left panel became a table (sites × values), re-evaluated together whenever the period changes, with clickable rows that fly the globe to the site.
- **Checks the AI ran on its own output:**
  - On 2026-11-14 (near new Moon), Chang'e 4 on the far side shows 24 h of daylight and 0 h of Earth, while near-side Apollo 11 and IM-1 show 0 h of daylight. That's consistent with the lunar phase.
  - Over the 30-day range, Apollo 11 and Chang'e 4 both show ~49% sunlight (half a lunar day, as expected), and IM-1 31% (polar terrain).
  - Tests: 66 passing, including period validation, hours interpolation, and mission checks staying unchanged when the analysis period differs.
- **What a human checked:** _[fill in]_
- **Still unverified / known limits:**
  - Hours come from hourly samples with linear interpolation of the crossing, so they're accurate to roughly ±0.1–0.2 h for a low Sun.
  - Long ranges (up to 366 days) make one Horizons request of up to ~8,800 rows per body the first time.

### 2026-11-14 · Session 7: landing-site finder, landing page, tabbed panel (branch `feature/site-finder`)

- **Who:** _[team member name]_
- **Tool:** Claude Code (Opus 5.5), desktop app, including its built-in browser
- **Prompted with:** a feasibility question ("search the Moon for regions meeting sunlight/Earth/power needs"), then: build it on a branch, add a landing page for the mission requirements, de-duplicate the right panel and move the comparison into a right-side tab, add arrows to hide panels, and make the comparison more vertical.
- **What the AI did:**
  - `api/finder.py` + `POST /find`. One Horizons query of sub-solar/sub-Earth points and Earth distance for the period, then Sun/Earth elevation for all 259,200 cells of a 0.5° grid by vector maths (Earth parallax included). Then daylight %, Earth %, mean panel sunlight and LOLA slope per cell; connected regions; a terrain re-check of the top regions.
  - `scripts/build_skylines.py`: precomputes LOLA terrain skylines for every cell (all CPU cores, ~10–15 min), so the global screen counts crater rims and peaks everywhere.
  - Frontend: a landing page with the requirements form; a globe heatmap (green/yellow/dimmed); a right panel with tabs (Search, Site, Compare, Sites) and a compact period bar; collapse arrows on the right panel, the map-layer box and the legend; a vertical comparison table (values × sites); duplicate lines removed (terrain line merged, altitude moved to a tooltip, coordinates in the title).
- **Checks the AI ran on its own output:**
  - Without terrain, a south-pole search for ≥60% daylight over a month finds nothing, which is correct for a smooth sphere (the Sun is up at most ~50% of a month). That shows why skylines are needed.
  - The finder agrees with the full per-site evaluation at the same spot: 570.1 vs 570 W/m² mean panel sunlight, 99.2% vs 99% daylight.
  - With skylines for all 259,200 cells loaded, results are terrain-aware everywhere. Searches take 12–25 s; the AI cut the original ~40 s by only computing the Sun/Earth azimuth where the body is between a cell's lowest and highest skyline point (results unchanged).
  - Even with terrain, ≥60% daylight over January 2027 finds no south-polar cell. The best-lit polar ridges are ~1 km wide, far smaller than a 15 km cell, and the slope limit excludes rims. This is a stated limitation, not a bug.
  - Smooth-Moon search ~9 s. In the browser: the landing page, search results, heatmap, opening a result, "+ Compare", the vertical comparison and all collapse arrows work.
  - Tests: 75 passing (finder geometry, skyline blocking, region wrap-around, end-to-end on a coarse grid, validation).
- **What a human checked:** _[fill in]_
- **Still unverified / known limits:**
  - 0.5° cells (~15 km) average away small features, notably the ~1 km near-permanently-lit polar ridges. Use "Get detailed terrain" on a result for the 30 m check.
  - Skylines are 4° azimuth steps from the ~237 m global grid, and the Sun is treated as a point.
  - Big regions are summarised by their best cell; "area" is the whole connected region.

### 2026-11-14 · Session 8: real surface temperatures from LRO Diviner

- **Who:** _[team member name]_
- **Tool:** Claude Code (Opus 5.5), desktop app
- **Prompted with:** "the teammate is no longer creating data for this; this is what you should be doing; please finish with the file". The one remaining placeholder was temperature (`build_grids.py`), which had been the teammate's task.
- **What the AI did:**
  - Found NASA's Diviner Global Cumulative Products on PDS: 18 fixed-width tables, 0.5° cells × 96 local-time bins, bolometric temperature in K. Wrote `scripts/fetch_diviner.py`, which streams each 156 MB band, keeps only each cell's coldest and hottest bin (night low, day high) and discards the rest. Result: a ~2 MB file in `~/LunarPlannerData/`.
  - `api/terrain.py` uses the Diviner grid (cell-centred bilinear, longitude wrap, skips cells without data), with the placeholder kept only as a labelled fallback. The site tile, comparison table and colour rating now treat temperature as real data, rated against the lander's (estimated) limit.
- **Checks the AI ran on its own output:**
  - Apollo 11's cell reads 95 K at night and 396 K at noon, matching the familiar lunar equatorial range of roughly 100 K to 390 K. Band maxima run from ~400 K at the equator down to ~50–320 K at 80–90°S, as expected for the poles.
  - Tests for the cell-centred lookup, the longitude seam, missing cells and source preference (79+ passing).
- **What a human checked:** _[fill in]_
- **Still unverified / known limits:**
  - 0.5° cells (~15 km) blur small cold traps inside polar craters.
  - The values are multi-year averages per local time, not a specific date.
  - The lander temperature limits in `landers.json` are still estimates.

### 2026-11-15 · Session 9: opening sequence and visual polish (branch `feature/intro-ui`)

- **Who:** _[team member name]_
- **Tool:** Claude Code (Opus 5.5), desktop app, including its built-in browser
- **Prompted with:** an intro with the title fading in and "Press Enter to continue"; a zoomed-in Moon behind the landing page, then a zoom-out with the menus fading in; a baseline night light in the 3D view; more translucent menus; a more saturated yellow in the heatmap. The user corrected the title to "Lunarcy" mid-task; the AI had used the spelling "Lunacy" from the request.
- **What the AI did:** added the intro overlay (CSS fade/blur animation, Enter or click to continue), an auto-rotating close-up camera behind the landing page, and a 1.6 s zoom-out with a 1 s menu fade (`revealApp()` in `web/app.js`). Labels and Sun/Earth markers stay hidden until then. Made the globe full-screen behind translucent, blurred panels. Saturated the yellow heatmap colour. Added a baseline night light in `web/site3d.js`.
- **Checks the AI ran on its own output:** in the browser at desktop size: the intro, Enter, the landing page over the close-up, the search, the zoom-out and the menu fade all work. It tuned the close-up framing after the first attempts filled the screen or showed the whole Moon. 3D night brightness at Chang'e 4 went from 2 to 24 (daylight is 67), so the surface is visible but still dark. It fixed the Earth marker drawing over the panel.
- **What a human checked:** _[fill in]_
- **Still unverified / known limits:** the opening animation was only checked at desktop size; on phones the panel covers the lower half of the screen.

### 2026-11-15 · Session 10: macOS local setup and Horizons SSL fix

- **Who:** _[team member name]_
- **Tool:** Claude Code (Opus 5.5), desktop app
- **Prompted with:** "can you help me get the local host running with the code as is now", then "Yes, fix it" for the Horizons certificate error.
- **What the AI did:** created `.venv` and installed requirements on macOS; changed `.claude/launch.json` from the Windows interpreter path to `.venv/bin/python`. Found that every Horizons call failed with `CERTIFICATE_VERIFY_FAILED` because the python.org macOS Python has no root certificates, so the app was quietly using the APPROXIMATE analytic ephemeris. Added `certifi` to `requirements.txt` and a global HTTPS opener using certifi's CA bundle in `api/__init__.py`. It also covers `api/lola.py` and the fetch scripts that import `api`.
- **Checks the AI ran on its own output:** inspected the server's certificate chain with openssl (genuine Entrust/Sectigo chain, no proxy). After the restart, `/sky/subpoints` reports the Horizons source and the server logs no fallback warning. `python -m pytest`: 78 passed, 4 skipped.
- **What a human checked:** _[fill in]_
- **Follow-up (same session):** downloaded LOLA LDEM_128 (2,123 MB) with `scripts/fetch_lola.py` to `~/LunarPlannerData/lola/`. After a restart `/health` reports the LDEM_128 source, the Apollo 11 skyline comes from real terrain, and pytest gives 79 passed, 3 skipped (one LOLA test no longer skips).
- **Second follow-up:** built the Diviner temperature grids with `scripts/fetch_diviner.py` (2.7 min, 100% of cells have data, 1.6 MB file). `/health` now reports `temperature_loaded: true`. Apollo 11 reads 95 K / 395 K, matching the earlier session; the Shackleton rim reads 80 K / 252 K.
- **Third follow-up:** built the finder skylines with `scripts/build_skylines.py` (2.0 min, 48 MB, 259,200 cells). A south-pole `/find` query for December 2026 (≥60% Sun, ≥50% Earth) now reports `precomputed_skylines: true` in 6.9 s and returns 3 regions. The top one, near 85.25°S 36.75°E, still passes after its terrain re-check (79.6% Sun, 66.4% Earth).
- **Still unverified / known limits:** the finder regions were not compared against published polar illumination studies. `scripts/fetch_moontrek_layers.py` does not import `api`, so it does not get the fix (its images are already in the repo).

### 2026-11-15 · Session 11: "Check for ice in deep craters" goal; 3D view cleanup

- **Who:** _[team member name]_
- **Tool:** Claude Code (Opus 5.5), desktop app, including its built-in browser
- **Prompted with:** remove "Get detailed terrain" from the 3D view; the south pole goal is to check deep craters for ice, so build a list of ice deposits if possible, otherwise map craters deep enough to hold ice, add them to the heatmap, and add a mission-goal selector whose only option is "Check for ice in deep craters".
- **What the AI did:**
  - Removed the 3D view's "Get detailed terrain" chip (`web/site3d.js`, `web/index.html`, `web/app.js`). The Site tab's button stays. The AI told the user that the button fetches ~30 m LOLA data, about 8× finer than the 237 m global grid, which is the opposite of what the request assumed.
  - `scripts/fetch_polar_craters.py` → `api/data/polar_craters.json`: 205 IAU-named craters poleward of 75° (≥8 km) from the USGS Gazetteer. Published ice evidence, each with a citation: Cabeus (LCROSS, Colaprete 2010), Shackleton (Zuber 2012), Haworth/Faustini/Shoemaker (LAMP, Hayne 2015).
  - `api/ice.py`: permanent shadow from LOLA skylines against the Sun's highest possible path (±1.54° declination), Diviner cold traps (≤110 K, Paige 2010), and per-crater depth, floor shadow and coldest cell. Craters are rated known / likely / possible / unlikely.
  - `GET /ice`; `/find` accepts `goal: "ice_craters"` and `max_ice_km`. Cells must lie within that distance of an ice target, and each region reports `ice_km` and its nearest rated crater.
  - Frontend: a Mission goal select (one option) and a distance field; the search area now defaults to the south pole. Ice candidates are drawn in blue on the heatmap, known and likely craters are labelled on the globe with tooltips, and clicking a label opens the crater floor. The results show the ice distance.
  - Updated `docs/ARCHITECTURE.md`, `CLAUDE.md` and `README.md`.
- **Checks the AI ran on its own output:**
  - Crater temperatures match the literature: Haworth 51 K, Shoemaker 65 K, Faustini 72 K, Hermite 86 K, Shackleton 91 K, Cabeus 108 K. All have permanently shadowed floors.
  - New tests in `tests/test_ice.py` (Sun geometry at the pole and at 70°S, flat pole lit vs deep polar bowl shadowed, ratings, distances, finder filter, the crater file's sources). The suite gives 86 passed, 3 skipped.
  - In the browser, a south-pole search for December 2026 (≥50 % Sun, ≥50 % Earth, ≥50 W/m², ≤10°, ≤50 km to ice) found 18 regions in 7.6 s. 17 crater labels showed, the 3D view opened without the button, and the console showed no errors.
  - Found and fixed a bug where the distance field's `step="5"` with `min="1"` made the default of 50 invalid, which silently blocked the form.
- **What a human checked:** _[fill in]_
- **Still unverified / known limits:**
  - The ice map was not checked visually on screen (the browser pane was hidden), only through page state.
  - 0.5° cells and the 237 m grid miss sub-km cold traps. "Possible" craters are often warm cells with a small shadowed foot of wall.
  - Evidence summaries come from the cited papers' abstracts and secondary sources, not a full reading.
  - Not compared with published PSR maps (e.g. Mazarico et al. 2011).

### 2026-11-15 · Session 12: start screen, skip-ice option, clearer heatmap, zoom-scaled pins

- **Who:** _[team member name]_
- **Tool:** Claude Code (Opus 5.5), desktop app, including its built-in browser
- **Prompted with:** an option to skip the ice check; clearer heatmaps with outlines around the most suitable areas; a smaller click pin that scales with zoom, applied to the existing pins too; a screen before the landing page with two simple buttons (explore, or enter mission requirements).
- **What the AI did:** added the start screen (`#choice`: "Explore the Moon" / "Plan a mission"), with "← Back" on the requirements form. Added the goal option "No specific goal (skip the ice check)", which hides and disables the ice distance field. Rewrote `applyHeatmap()`: crisp cells with stronger colours, outlines (bright on a dark halo) around areas that meet everything and around likely ice cells, rank labels #1–#10 for the top regions with tooltips and click-to-open. Pins and labels now scale with camera altitude (the user pin starts at 0.45° instead of 0.8°).
- **Checks the AI ran on its own output:** in the browser, checked through page state: the intro leads to the start screen; Plan, Back and Explore go where they should; with no goal the form is valid and the ice field is hidden. An ice search showed rank labels #1–#10 and 17 crater labels. Zooming to altitude 0.2 shrank the pin from 0.42° to 0.04° across, including during fly-to animations. The console showed no errors. A screenshot showed the first outline version drawing white wedges near the pole (north–south edges widened by 1/cos(lat) grew wider than the cells), so the AI capped them at 40 % of a cell; the wedges were gone in the next screenshot.
- **What a human checked:** _[fill in]_
- **Still unverified / known limits:** the browser pane was hidden, so the screenshots were low-resolution and the heatmap's readability wasn't judged closely. Outlines are drawn into the 4096 px globe texture, so they go soft when zoomed far in.

### 2026-11-15 · Session 13: visible pin, three-colour smooth heatmap, grand type, shadow-reveal intro

- **Who:** _[team member name]_
- **Tool:** Claude Code (Opus 5.5), desktop app, including its built-in browser
- **Prompted with:** the user pin was too small and needed a colour that contrasts with the grey surface; the heatmap was blocky at the pole and should be three colours (yellow marginal, green suitable without ice in range, light blue suitable with ice in range); a font with a sense of grandeur on the intro and landing pages; an intro where the Moon's shadow reveals it.
- **What the AI did:**
  - Pin: hot magenta (`#ff2bd6`), 2.5× the radius, taller, with a pulsing ring (globe.gl rings). Still scales with zoom.
  - Finder (`api/finder.py`): class 3 = suitable and within `max_ice_km` of ice, class 2 = suitable (previously cells beyond the ice range were dropped). Regions are grouped per class, ice-range regions first; added `within_ice_range`, `ice_range_cells` and `ice_range_area_km2`. Test updated.
  - Heatmap: every cell is drawn as a 9 km disc on the ground (an ellipse widened by 1/cos(lat), wrapped across the seam, with polar caps filled). This gives smooth round areas with white outlines. The legend was rewritten. A first version that smoothed (averaged) the grid was replaced because it erased isolated single suitable cells, which are many of the best spots.
  - Type: Cinzel for the titles, Cormorant Garamond for the subtitles (Google Fonts). Intro: the light starts behind the Moon and swings round to the viewer over 5.6 s, following the rotating camera, with the title retimed to fade in as the light arrives. The body now starts in intro mode so the menus don't flash before the script loads.
- **Checks the AI ran on its own output:** pytest gives 86 passed, 3 skipped. In the browser, an ice search for December 2026 found 967 suitable cells, 24 of them within 50 km of ice; result #1 is in range. Screenshots showed smooth blue, green and yellow areas with outlines near 81.5°S and no polar wedges, and the heatmap renders in 0.17 s (0.74 s for the averaging version). Intro screenshots at 1 s, 3.5 s and 7.5 s showed the Moon going from dark to lit with the Cinzel title. The magenta pin is visible from the whole-Moon view. The console showed no errors. The AI also found that the running server needed a restart to pick up the finder change.
- **What a human checked:** _[fill in]_
- **Still unverified / known limits:** the browser pane was hidden, so the screenshots were low-resolution. Discs make small areas look like round 18 km blobs, a display choice that is coarser than the data near the pole. The reveal lighting's direction is chosen for looks, not the real Sun (the real Sun takes over once the app opens). Fonts need internet; without it they fall back to Georgia.

### 2026-11-15 · Session 14: Earth beside the Moon in the intro

- **Who:** _[team member name]_
- **Tool:** Claude Code (Opus 5.5), desktop app, including its built-in browser
- **Prompted with:** put the Earth in view on the left of the intro screen, with the Moon black at first and revealed as it comes out of shadow while the title appears at the same time.
- **What the AI did:** added `web/intro_earth.js`, a small separate three.js canvas with a rotating, tilted Earth: day/night shader with city lights, a thin atmosphere rim, NASA Blue Marble textures from the three-globe examples on jsDelivr (not stored in the repo). The Moon's intro view zoomed out to altitude 1.35 and shifted right, with the canvas 38vw oversized while shifted so the starfield reaches the left edge. The Moon now starts fully black (no fill light), and the title's opacity and blur are driven by the same clock as the light, so they happen together. On reveal, the Earth fades out and is disposed, and the globe returns to screen size.
- **Checks the AI ran on its own output:** browser screenshots at 1.2 s showed a lit Earth on the left, a black Moon and a faint title; at 3.5–7.5 s the Moon was lit with the full title. Found and fixed a starless strip at the left edge from shifting the canvas. After Enter → Explore, the Earth canvas was removed and the globe was back to window width, with no console errors. The "Multiple instances of Three.js" warning already appeared before this change (the 3D site view also imports three); it is harmless.
- **What a human checked:** _[fill in]_
- **Still unverified / known limits:** the browser pane was hidden, so only the first screenshot rendered at full size. Earth's size and position are artistic (seen from the Moon it is about 2° across), and its lighting direction is chosen for looks. The textures need internet.

### 2026-11-15 · Session 15: site plan (solar array, comms hub, routes, nearest ice)

- **Who:** _[team member name]_
- **Tool:** Claude Code (Opus 5.5), desktop app, including its built-in browser
- **Prompted with:** a pasted design: when a landing site is selected, add to the 3D map the best place for a comms hub and a solar panel, a line with the drivable distance between them, and a line to the nearest ice deposit with its distance.
- **What the AI did:**
  - `api/siteplan.py` + `GET /site/plan` (separate from `/evaluate`, so its contract is unchanged): routing grid, Dijkstra with a 15° drivable limit (cited to NASA's VIPER page), mast skylines for candidate spots (coarse then fine), Sun/Earth from the site's own Horizons series, a solar ↔ comms route, and a leg toward the nearest ice target (`IceMap.nearest_target`, named after the crater it lies in).
  - 3D view (`web/site3d.js`): masts and labels, route tubes draped on the terrain with distances, a dashed ice line (or an edge arrow when the ice is beyond 20 km), a "Site plan" panel and toggle. The globe gets the routes and a dashed great-circle line to the ice.
  - `tests/test_siteplan.py` (5 tests); docs updated.
- **Checks the AI ran on its own output:** found and fixed a routing bug. Only the step's own grade was checked, so routes could zigzag across 30° hillsides; near Shackleton the whole 400 km² counted as drivable, and with the per-cell ground-slope limit it is 226 km². Sanity checks: a rim site near Shackleton gets 91–100 % Sun on a 10 m mast, a spot on Cabeus's floor 3.7 %. The nearest ice from the rim is Shackleton at 14.1 km, with its citation. pytest gives 91 passed, 3 skipped. In the browser: the plan panel, 7 3D objects and 2 globe paths, no console errors; a close-up screenshot showed the masts, labels and the 572 m drive line.
- **What a human checked:** _[fill in]_
- **Still unverified / known limits:** on the global grid (~237 m) spots and routes are rough. The 15° limit is VIPER's typical value, not a hard spec, and VIPER was cancelled in 2024. The ice target is a 0.5° cell centre or a crater floor point, not an exact deposit. Detailed (~30 m) terrain was tested through the API only (Shackleton rim: 2.4 s on the server, 50 m routing grid, 218 km² reachable), not in the browser. The browser pane was hidden, so the screenshots were low-resolution.

### 2026-11-15 · Session 16: monochrome menus, comms tower heights, UI cleanup

- **Who:** _[team member name]_
- **Tool:** Claude Code (Opus 5.5), desktop app, including its built-in browser
- **Prompted with:** remove the emojis in the 3D view; remove the "Get detailed terrain" button in the global view; open the right panel after a mission search; frosted black/grey/white menus instead of blue; show an ideal and a realistic comms tower height in the 3D view; make the ice-range result pins contrast with the blue heatmap.
- **What the AI did:** removed the emojis from the 3D view's labels, HUD, plan panel and toggle. Removed the Site tab's detailed-terrain button and its code; the API still supports detailed terrain. `setPanelCollapsed(false)` runs after a search. The colour tokens are now neutral, with frosted glass (16 px blur) on the panel, overlays, landing and choice cards and the 3D HUD and plan panel; primary buttons and active tabs are white. `api/siteplan.py` adds `comms.tower`: Earth-in-view % for towers of 2–500 m, the ideal height, and a realistic height (best up to 20 m, labelled an estimate) with a note on the LUNARSABER tower concept. The 3D comms label and the plan panel show both. Ice-range rank labels are now orange (`#ff8a1f`), the rest white; the legend was updated.
- **Checks the AI ran on its own output:** tower curves at three sites: Shackleton rim 10 m → 49.9 % (ideal 10 m); Cabeus floor flat at 38 % until 500 m → 41.7 % (flagged beyond concepts); an open site 100 % at 2 m. A test checks that a taller tower never sees less. pytest gives 91 passed, 3 skipped. In the browser: with the panel collapsed beforehand, it was open after the search; all 10 rank labels were orange; the 3D view text had no emoji; the plan panel showed the tower row; no console errors.
- **What a human checked:** _[fill in]_
- **Still unverified / known limits:** the 20 m "realistic" tower is an estimate, not a spec. The LUNARSABER reference (~100 m, scalable to ~200 m) was checked against press coverage (Space.com, Universe Today), not a primary Honeybee or DARPA document. The monochrome theme was not reviewed at full resolution (the pane was hidden).

### 2026-11-15 · Session 17: start screen without emojis, matte Moon, front-lit Earth

- **Who:** _[team member name]_
- **Tool:** Claude Code (Opus 5.5), desktop app, including its built-in browser
- **Prompted with:** remove the emojis on the start screen; make the Moon less reflective in the opening (it's matte in reality); light the Earth from the camera side instead of from behind.
- **What the AI did:** removed the two emoji icons from the start-screen buttons. Set globe.gl's Moon material (MeshPhongMaterial) to no specular highlight (`specular` black, `shininess` 0); this applies everywhere, not just the intro. Moved the intro Earth's sunlight to over the viewer's shoulder, so the side facing the camera is lit.
- **Checks the AI ran on its own output:** in the browser the material read back as `shininess` 0 and specular `000000`; an intro screenshot showed a matte Moon with no highlight and the Earth's lit face toward the viewer; the start screen text had no emoji; no console errors.
- **What a human checked:** _[fill in]_
- **Follow-up:** the user reported the Earth still looked unlit. The cause was the custom Earth shader skipping three.js's output colour conversion (`#include <colorspace_fragment>`), so the sRGB textures rendered far too dark. Added it and centred the light on the camera side; a screenshot then showed a fully lit day side.
- **Still unverified / known limits:** checked in browser screenshots only.

### 2026-11-15 · Session 18: pole markers, explanation tooltips, Celsius, no lander UI, filled stat tiles

- **Who:** _[team member name]_
- **Tool:** Claude Code (Opus 5.5), desktop app, including its built-in browser
- **Prompted with:** add markers above the north and south poles in our style; add tooltips explaining why the analysis chose each location; show temperatures in Celsius; remove the lander section and its pass/fail; fill each stat box in proportion to its viability.
- **What the AI did:**
  - N/S pole markers on the globe's html layer (Cinzel letters in frosted rings, "NORTH POLE"/"SOUTH POLE").
  - A shared floating tooltip for any `data-tip` element (hover or keyboard focus). It explains: each stat tile (what it measures, colour thresholds, what the fill means); each search result (every requirement against the user's thresholds, the tightest margin, ice range and nearest rated crater, the ranking rule, the terrain check); how the search works; and each site-plan row (candidates compared and the lander's own value, the route rule, the tower method, the ice target's basis). `/site/plan` gained `solar.why`/`comms.why` (candidate count and the value at the lander).
  - Celsius everywhere in the UI, including the ice texts in `api/ice.py` (≤−163 °C); the API numbers stay in kelvin.
  - Removed the Mission section (lander, payload, landing date and windows) and the Verdict section, the compare rows for verdict, lander and landing, and the lander list loading. Compare pins are now a neutral white. Ratings use a typical 10° slope and a 127 °C (400 K) limit, labelled as estimates.
  - Stat tiles are filled from the left by viability in their rating colour.
- **Checks the AI ran on its own output:** pytest gives 91 passed, 3 skipped. In the browser after an ice search: both pole markers present; result #1's explanation lists its four margins, "tightest requirement is daylight", 19.6 km to ice, the ranking and the terrain check. Site tiles read e.g. Sunlight 58 % (good, 58 % fill), Temperature −203 °C to −9 °C, Peak sunlight 221 W/m² (warn, 16 %); the tooltip opened on hover; the Mission and Verdict sections are gone. The 3D plan had five explanation icons. No console errors. The AI fixed one wording error: the spot explanation had mixed up the 10° spot limit and the 15° drive limit.
- **What a human checked:** _[fill in]_
- **Still unverified / known limits:** the temperature fill (gentleness of the day–night swing out of 400 °C) and the slope fill (empty at 20°) are design choices, not standards. The pole markers and tooltips were not judged at full resolution (the browser pane was hidden).

### 2026-11-15 · Session 19: home-plate pole badges

- **Who:** _[team member name]_
- **Tool:** Claude Code (Opus 5.5), desktop app, including its built-in browser
- **Prompted with:** drop the "North Pole"/"South Pole" labels and keep N and S, in an icon pointing to the pole, shaped like home plate.
- **What the AI did:** replaced the round markers with a pentagon (home plate) badge: a white edge and a dark frosted fill (two clip-path layers), the Cinzel letter inside, and the point toward the pole (down for N, up for S). Removed the text labels; the full name is kept as a hover title.
- **Checks the AI ran on its own output:** measured in the browser against `globe.getScreenCoords`. The first version's tip was 11 px off, because globe.gl's inline transform overrides a marker's own transform; the offset now sits on the inner badge, and both tips line up with the poles (x exact, y within 5 px, the marker's small lift). No console errors.
- **What a human checked:** _[fill in]_
- **Still unverified / known limits:** the shape was checked by measurement, not seen at full resolution (the browser pane was hidden).

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
