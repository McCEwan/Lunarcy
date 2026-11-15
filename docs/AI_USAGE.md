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

### 2026-11-15 · Session 10: pitch deck (branch `docs/pitch-deck`)

- **Who:** _[team member name]_
- **Tool:** Claude Code (Opus 5.5), cloud session, PowerPoint skill (pptxgenjs)
- **Prompted with:** a maximum 7-slide PowerPoint that tells the story of a scientist looking for signs of water on the Moon and why water matters.
- **What the AI did:** read the README and architecture doc, ran the app offline (`EPHEMERIS=analytic`, no LOLA/Diviner data downloaded) to take screenshots, and built `Lunarcy_pitch.pptx`: 7 slides around a fictional persona (Dr. Amara Rao), with speaker notes. Also sketched (no code) a design for solar-panel/comms-hub placement, a drivable route and the nearest ice.
- **Checks the AI ran on its own output:** the deck passes the skill's file validator; every slide was rendered to an image and checked for overflow and overlap.
- **What a human checked:** _[fill in]_
- **Still unverified / known limits:** the screenshots came from a run on PLACEHOLDER terrain and approximate ephemeris; slide 7's results screenshot should be retaken with real data. "~10 s" comes from the README; "weeks → minutes" is a storytelling claim, not measured. Science facts (below −200 °C in shadowed craters, uses of water) are general knowledge and were not cited on the slides.

### 2026-11-15 · Session 11: pitch deck redesign (branch `docs/pitch-deck`)

- **Who:** _[team member name]_
- **Tool:** Claude Code (Opus 5.5), cloud session, PowerPoint skill (pptxgenjs), web search
- **Prompted with:** a black, white and sun-orange colour scheme, and slides that cover impact, creativity, relevance to the NASA challenge, validity of the data and our shortcomings, Toronto/Canadian impact (the Canadian lunar utility rover), prompts that lead the judges to questions, and the art and design choices.
- **What the AI did:** rebuilt `Lunarcy_pitch.pptx` as 7 slides with the new palette, an "Ask us" prompt on each content slide, a real-vs-shortcomings slide, an impact slide on CSA's Lunar Utility Vehicle, and a design-and-questions closing slide, with speaker notes.
- **Checks the AI ran on its own output:** file validator passes; every slide rendered and checked for overflow. The rover facts were checked by web search (CSA news release, July 2025: studies awarded to Canadensys Aerospace, MDA Space with the U of T Institute for Aerospace Studies, and Mission Control).
- **What a human checked:** _[fill in]_
- **Follow-up (same session):** slides 3–7 reorganised into Relevance, Impact, Creativity, Validity, then Toronto/Canadian impact with the low-colour design choices; slides 1–2 unchanged.
- **Still unverified / known limits:** "Lunarcy could help Ontario's rover teams" is a pitch claim; no rover team has been contacted. The screenshots still come from a PLACEHOLDER-terrain run.

### 2026-11-15 · Session 12: slide titles and real-data screenshots (branch `docs/pitch-deck`)

- **Who:** _[team member name]_
- **Tool:** Claude Code (Opus 5.5), cloud session, PowerPoint skill, Playwright
- **Prompted with:** title slides 3–6 Relevance, Impact, Creativity and Validity; use the challenge page for the Relevance slide; update the screenshots of Lunarcy.
- **What the AI did:** set the four one-word titles with a short orange tagline; downloaded LOLA LDEM_64 and built the Diviner grids in the cloud session; ran the app on JPL Horizons, LOLA (including ~30 m detailed terrain) and Diviner, and retook the screenshots (Impact: search result #1 with its stats; Creativity: standing at the site facing the Sun in the 3D view).
- **Checks the AI ran on its own output:** the site panel showed real sources (Horizons, LOLA ~474 m global and ~30 m detail, Diviner 84–317 K); deck passes the validator; changed slides rendered and checked.
- **What a human checked:** _[fill in]_
- **Still unverified / known limits:** the challenge page (spaceappschallenge.org) could not be read from the cloud session (TLS certificate rejected by the proxy), so the Relevance slide is not yet checked against the challenge text. Slide 6 says global terrain is ~237 m (LDEM_128); the screenshots used LDEM_64 (~474 m).

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
