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
