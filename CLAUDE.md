# Tuscany Ride (E:\Roadgame)

A free 3D indoor cycling game. Connects to FTMS smart trainers over Web Bluetooth,
simulates a ride through a Tuscan landscape, and exports rides as Garmin-compatible
.FIT files. No subscription, no multiplayer - by design (NPC riders/traffic are local).

Repo: https://github.com/sanjoesan/tuscany-ride - every push to `main` auto-deploys
to **https://sanjoesan.github.io/tuscany-ride/** via GitHub Actions (Pages, workflow
mode). User may later want Steam - keep it offline-capable and self-contained.

**Rules for working in this repo**
- Never use the word "Zwift" anywhere (code, comments, docs, chat). Say "commercial indoor cycling apps" instead.
- Work autonomously; the user wants results + a report, not permission questions.
- Update this file with every iteration (status section below).

## Commands

```
npm run dev        # dev server (Web Bluetooth works on localhost)
npm run build      # tsc --noEmit + vite build -> dist/
npm run upload     # upload newest Downloads\*.fit to Garmin Connect (tools/upload-garmin.mjs)
npx tsx tools/smoketest.ts   # headless tests: terrain/road/physics/FIT encoder
```

Node may not be on PATH in fresh shells: prefix with `$env:Path = "C:\Program Files\nodejs;$env:Path"`.
Game requires Chrome or Edge (Web Bluetooth). Dev-screenshot helpers: open
`http://localhost:5173/#noui` (hide UI) or `#autoride` (auto-start demo ride).

## Architecture

Vite + TypeScript + Three.js. No game engine; everything is hand-rolled.

- `src/main.ts` - orchestrator: renderer (ACES, PCFSoft shadows), mode state machine
  (menu / riding / editor), route picker, deferred world boot behind #loading, UI wiring, main loop.
- `src/types.ts` - shared types (`MapData` = seed/size/towns/nodes/edges/scenery, `Telemetry`...).
- `src/world/` - world generation. **Build order matters**: `Terrain(map)` -> `RoadNetwork(map, terrain)`
  (per-edge spline samples; node heights relaxed downward so nothing exceeds 10 %; junction pads) ->
  `terrain.setRoad(network.allSamples)` (terrain conforms to corridors via spatial hash) ->
  `generateRoutes` -> meshes + `buildScenery`. `World.rebuild()` regenerates in place;
  `world.quality = "fast"` lowers texture/mesh res for live editor rebuilds.
  - `network.ts` - seeded towns + junction nodes + Gabriel-graph edges (planar -> real crossings),
    guaranteed coastal "lungomare" chain for flat routes.
  - `routes.ts` - ~50 named circuits via random walk + Dijkstra home; every 3rd route is flat-biased
    (starts at harbour town, avoids edges with >5.5 % grade). Stats: km, gain, max %, ETA.
  - `road.ts` - `RoadNetwork` (edge sampling, grade limit 10 %, asphalt texture, junction pads),
    `SampledPath.at(dist)` shared by `Route`.
  - `terrain.ts` - heightfield (flat coastal plain < coastX+650, hills inland), painted 3072px albedo
    (field patchwork, vineyard rows, plow furrows, grass verges near roads), detail normal map.
  - `mapData.ts` - "Toscana Grande" from seed, localStorage (`roadgame.map.v2`), JSON validation.
  - `models.ts` - merged low-poly geometries (vertex colors + shared detail-normal-map material).
    Use `mergeAll`, never raw `mergeGeometries` (indexed/non-indexed mismatch returns null - real bug).
  - `scenery.ts` - environment (Sky shader + PMREM ambient, sun shadows that follow the camera -
    **must call shadow.camera.updateProjectionMatrix()**, Water sea), towns with street-lining houses,
    olives/cypresses/pines with per-instance color jitter, 60k instanced grass tufts near roads.
- `src/game/npc.ts` - NPC riders on routes, cars/trucks driving the network (right-hand traffic,
  junction turns), pedestrians wandering towns. Rebuilt via `npcs.build()` after every map change.
- `src/bluetooth/` - `ftms.ts` (FTMS trainer: Indoor Bike Data parse, control point grade writes
  throttled to 2 Hz; CPS power-meter fallback), `heartRate.ts`, `virtualTrainer.ts` (demo mode, arrow keys).
- `src/sim/physics.ts` - power -> speed ODE (gravity/rolling/aero). Validated: 200 W flat = ~34 km/h.
- `src/game/` - `ride.ts` (RideController: moves rider along road, chase/front/side cameras via C key,
  sends grade x difficulty to trainer), `rider.ts` (procedural cyclist with pedaling animation), `hud.ts`.
- `src/fit/` - `fitEncoder.ts` (dependency-free FIT writer, CRC16), `recorder.ts` (1 Hz samples,
  stats, download; game xz -> real GPS near Castiglione della Pescaia so Garmin shows a map).
- `src/editor/editor.ts` - world builder: works on a deep copy, rebuilds world live (debounced),
  tools select/road/place/town, OrbitControls, JSON export/import.
- `tools/upload-garmin.mjs` - unofficial Garmin Connect upload (GARMIN_EMAIL/GARMIN_PASSWORD env
  or .garmin.json - never commit that file).

## Status (update each iteration)

**2026-06-12 (31)** - v0.8f "cypress avenue" (the postcard Tuscan road):
- [x] A grand cypress avenue (in buildScenery): picks the longest inland "main" road (mid past
      coastX+700) and lines BOTH sides with tall cypresses every ~9 m, set back `half+4`, avoiding
      towns/roads/river. Taller scale (1.3-1.7) for grandeur. Reuses `put("cypress")` so they merge
      into the existing cypress InstancedMesh - no new draw calls/models.
- [x] Pairs with the golden hills for the classic Tuscany postcard look.
- [x] Build clean (tsc+vite), all 31 smoke tests pass.
- [ ] Next: confirm yellow with user; villa at the avenue's end; Piaggio Ape three-wheeler; cicadas

**2026-06-12 (30)** - v0.8e "Vespas + much yellower terrain" (loop + user feedback):
- [x] USER FEEDBACK "Terrain sollte noch viel mehr gelb sein": pushed the golden tint hard -
      `GOLDEN_TINT` now 0.93/0.80/0.30 and `GOLDEN_STRENGTH` 0.24 (was 0.10); summer palette bumped
      bright yellow-gold (wheat 0.92/0.79/0.26, pasture 0.84/0.71/0.28, golden plow/scrub/verge).
      Olives/vines kept green for contrast. Easy single knobs (GOLDEN_TINT/STRENGTH) to dial further.
- [x] Vespa scooters (`buildVespa` in npc.ts): floorboard, leg-shield, rounded cowl, seat, handlebar
      + headlight, two single-track wheels, and a seated helmeted rider leaning to the bars (period
      wear/skin palettes). Same `{object, wheels}` contract; traffic mix now ~20% trucks, rest
      ~48% bubble cars / ~26% Vespas / ~26% saloons.
- [x] Build clean (tsc+vite), all 31 smoke tests pass.
- [ ] Next: confirm yellow strength with user (dial GOLDEN_STRENGTH); self-host fonts; period vans

**2026-06-12 (29)** - v0.8d "bubble cars" (period traffic for the 60s theme):
- [x] `buildBubbleCar` in npc.ts: a rounded 1960s bubble car (Fiat 500/600 era) - short body with
      domed nose/tail, glass band + body-colour roof dome, round chrome-ringed headlamps, chrome
      bumpers, four small wheels. Period pastel palette (BUBBLE_COLORS). Same `{object, wheels}`
      contract + wheel orientation as the other vehicles, so traffic/overtake/rolling logic is unchanged.
- [x] Traffic mix retuned: ~22% trucks, of the rest ~62% bubble cars / ~38% saloons - the little
      cinquecenti now dominate the roads.
- [x] Build clean (tsc+vite), all 31 smoke tests pass.
- [ ] Next: Vespa scooters (with a seated rider); tune gold/light from feedback; self-host fonts

**2026-06-12 (28)** - v0.8c "golden-hour light" (extends the golden look into the lighting):
- [x] Warmed `applySun` daytime light: sun colour now lerps `0xffc183 -> 0xffe9c6` (warm golden-hour
      all day instead of near-white at noon); fog/haze `0xe7cda8 -> 0xdcd3bd` (warm horizon, not cool
      blue); water sun-glint matched to `0xffe9c6`. Night branch untouched; cycle mode inherits it.
- [x] Build clean (tsc+vite), all 31 smoke tests pass. (Pure light-colour tweak; headless capture
      still unavailable - awaiting user's eye to dial warmth up/down.)
- [ ] Next: tune gold+light strength from feedback; period vehicles (Vespa/bubble-car); self-host fonts

**2026-06-12 (27)** - v0.8b "golden Tuscany" (user request: terrain warmer/more golden):
- [x] Reworked `SEASON_PALETTES` toward warm gold/sienna - summer most (ripe-gold wheat 0.88/0.71/0.31,
      sun-dried golden pasture, terracotta plow/sienna vine-earth, warm sage olive). Olives/vines/
      riverbanks kept green for the classic gold-vs-green Tuscan contrast. Spring/autumn/winter
      nudged warmer too.
- [x] Added a `GOLDEN_TINT` cohesion pass: every farmland pixel `out.lerp(GOLDEN_TINT, 0.1)` after
      the field branch (water/river/beach/town untouched - they return earlier).
- [x] Roadside grass tufts dried toward straw (`rgb(g*0.68, g*0.92, g*0.38)`) so the verge sits in
      the golden fields.
- [x] Build clean (tsc+vite), all 31 smoke tests pass. (Headless screenshot capture unavailable in
      this env - change is pure colour data, zero render risk; awaiting user's eye on intensity.)
- [ ] Next: tune gold strength from user feedback; warm the sun/ambient for golden-hour; period vehicles

**2026-06-12 (26)** - v0.8a "enamel roadside ads" (loop mode; extends the 60s theme into the world):
- [x] Vintage enamel billboards (`buildBillboards` in scenery.ts): up to 14 hoardings along long
      main roads, set back and facing the carriageway, on two timber posts. Six invented period
      Italian brands (no real trademarks): VERMUT ROSSI, PNEUMATICI VOLPE, CAFFE AURORA, APERITIVO
      SOLE, OLIO SAN LORENZO, MOTO FALCO - canvas enamel panels (double border, Bodoni brand +
      italic subtitle) in the v0.8 palette. Avoids towns/sea/roads/river via blocked/inTown; the
      ad panel is the +Z face of a thin Box (material array), back/edges plain enamel. Textures cached.
- [x] Build clean (tsc+vite), all 31 smoke tests pass.
- [ ] Next: period vehicles (Vespa/bubble-car) in traffic; self-host fonts; palette tuning from feedback

**2026-06-12 (25)** - v0.8 "Italia, anni '60" - full UI restyle (user request):
- [x] 1960s Italian look across the whole UI (`src/styles.css` rewritten): Bodoni (Didone) display
      type + Jost (Futura-like) geometric UI type, warm Mediterranean palette via CSS vars (aged
      ivory paper, Campari red, ochre, olive, petrol teal, espresso). Menu = vintage travel-poster
      card with a thin tricolore top rule + Bodoni red title; buttons flat enamel; tracked uppercase
      labels.
- [x] HUD reimagined as an ivory 1960s instrument cluster (Fiat 500 / Veglia Borletti): cream panel,
      Bodoni tabular numerals, red "speedo" big-metric, espresso labels. Turn arrows, summary tiles,
      editor panel and toast all re-skinned to the palette.
- [x] Diagrams as vintage printed charts: both elevation profiles (menu + live HUD) recoloured -
      petrol descent / olive / ochre / terracotta / Campari-red climbs - on parchment, with ink
      labels and an espresso-outlined red marker. Grade HUD colour + perf overlay + editor town
      labels re-tinted to match.
- [x] Fonts: Google Fonts (Bodoni Moda + Jost) with system Bodoni/Futura/serif fallbacks, so it
      stays offline-CAPABLE (graceful degrade) though no longer fully self-contained for fonts -
      flagged for the user; can self-host woff2 later for full offline fidelity.
- [x] Build clean (tsc+vite), all 31 smoke tests pass. (Headless screenshot capture unavailable in
      this env; CSS keeps every original selector/class so JS toggles are unaffected.)
- [ ] Next: self-host the woff2 fonts for true offline; tune palette from user feedback; resume features

**2026-06-12 (24)** - v0.7r "gradient-coloured live profile" (loop mode, 5-min autonomous loop):
- [x] The in-ride HUD elevation profile (already had a "you are here" marker) is now gradient-
      coloured by grade like the menu preview (blue descent / green / amber / orange / red >9%),
      and the stretch already ridden is dimmed to 0.3 alpha so progress reads at a glance.
      `Hud.setPath` now also stores per-sample grade; `drawProfile` paints 2px columns + the marker.
- [x] Discovered the live profile already existed (read first) - enhanced it rather than duplicating.
- [x] Build clean (tsc+vite), all 31 smoke tests pass.
- [ ] Next: grade % callouts on the strip, climb-ahead warning, cloud shadows (needs GPU verify)

**2026-06-12 (23)** - v0.7q "elevation profile preview" (loop mode, 5-min autonomous loop):
- [x] Route elevation profile in the menu: a `<canvas id="route-profile">` under the route info,
      drawn by `drawRouteProfile` in main.ts from `route.samples` (dist/y/grade). Per-pixel column
      bars from the baseline to the altitude, coloured by gradient (blue descent / green easy /
      amber rolling / orange steep / red >9%), with min/max altitude labels. Range floored at 20 m
      so flat coastal routes don't look like a wild zigzag. Hidden for Free ride.
- [x] Real cycling-app UX (not more 3D): you can see a route's shape & difficulty before starting.
- [x] Build clean (tsc+vite), all 31 smoke tests pass. (Headless screenshot still flaky here; the
      profile is pure 2D-canvas drawing from already-tested route data, tsc-validated.)
- [ ] Next: live elevation/grade HUD during the ride with a "you are here" marker; cloud shadows

**2026-06-12 (22)** - v0.7p "ducks on the river" (loop mode, 5-min autonomous loop):
- [x] Duck family (`River.buildDucks`): a low-poly mallard drake leading 4 ducklings in a line,
      plus a white duck and another mallard, on a calm mid-course reach above the tidal mouth and
      clear of towns. Each duck (body/tail/neck/head/beak) is tagged `userData.bob`, so World's
      existing bobber animation rocks them - zero new per-frame code. Oriented to the flow.
- [x] Deferred cloud shadows on purpose: the good approach is shader injection into the terrain
      material (sample a scrolling shadow tex by world XZ so it conforms to hills) - but that can
      black-screen the terrain if it miscompiles and can't be verified headless. Needs real-GPU
      verification before shipping in the autonomous loop.
- [x] Build clean (tsc+vite), all 31 smoke tests pass.
- [ ] Next: cloud shadows (with GPU verify), perf pass from user fps, swans, river reeds/dragonflies

**2026-06-12 (21)** - v0.7o "the bells, the bells" (loop mode, 5-min autonomous loop):
- [x] Bell toll sound (`AmbientAudio.bellToll`): a struck church bell synthesised from inharmonic
      partials (hum/prime/tierce/quint/nominal...) with fast attacks and long, partial-dependent
      decays - the minor-third tierce gives the brooding bell colour. Web Audio, no samples.
- [x] Carillon controller (`main.ts`): the bell rings out in peals (~8-13 s) every ~2.5-5.7 min,
      daytime only. During a peal it OVERRIDES the bell's idle World sway with a hard swing
      (`BELL_W`) and strikes the tone at each swing extreme - sound and motion synced. Runs after
      `world.update` so it wins; re-acquires the named "bell" object after every rebuild; bellToll
      is a no-op until audio has started (first ride) or when muted.
- [x] Idle sway reduced (amp 0.32 -> 0.08) so the bell just hangs between peals.
- [x] Build clean (tsc+vite), all 31 smoke tests pass.
- [ ] Next: cloud shadows, perf pass from user fps, hourly chime count, market-day crowds

**2026-06-12 (20)** - v0.7n "the campanile" (loop mode, 5-min autonomous loop):
- [x] Bell tower (`buildCampanile` in scenery.ts): a square stone shaft + belfry stage with four
      dark arched openings + pyramidal cap + a small clock face, placed just off the piazza of the
      biggest town (`towns.reduce` by radius). Stands on `terrain.height`.
- [x] Swinging bell: a bronze bell hung in the belfry on a pivot tagged `userData.swing =
      {axis,amp,speed,phase}`. New pendulum primitive in World - collected per rebuild beside the
      spinners and rocked each frame (`rotation[axis] = amp*sin(t*speed+phase)`) in `World.update`.
- [x] Build clean (tsc+vite), all 31 smoke tests pass.
- [ ] Next: bell TOLL sound synced to the swing (AmbientAudio), cloud shadows, perf pass from fps

**2026-06-12 (19)** - v0.7m "watermill on the river" (loop mode, 5-min autonomous loop):
- [x] Watermill (`River.buildWatermill`, beside buildBridges): stone mill house on the bank + a
      paddle wheel (hub, rim torus, 8 spokes + 8 floats) that dips ~1 m into the water and turns.
      Placed at a mid-course river sample above the tidal mouth and clear of towns; house/roof/wheel
      all oriented to the flow (yaw from `dirX/dirZ`, axle along the bank normal).
- [x] Reuses the spinner system from v0.7l: wheel pivot tagged `userData.spin = {axis:"x", speed}`,
      rotated each frame by `World.update`. Wired into `world.rebuild` after the bridges.
- [x] Build clean (tsc+vite), all 31 smoke tests pass (incl. river checks).
- [ ] Next: real perf pass from user fps, cloud shadows, church bells, watermill sluice/foam

**2026-06-12 (18)** - v0.7l "the windmill" (loop mode, 5-min autonomous loop):
- [x] Inland windmill (`buildWindmill` in scenery.ts): a stone tower (taper + timber cap + windows)
      placed on the highest of 40 seeded inland candidates that clear roads/towns/river (`blocked`/
      `inTown`), seeded off `map.seed` so it's stable per map. Four cloth-and-spar sails on a pivot.
- [x] Generic spinner system: pivot tagged `userData.spin = {axis,speed}`; World collects spinners
      per rebuild (alongside bobbers/beacons) and rotates them each frame in `World.update`. Sails
      turn about the axle (X) in the Y-Z plane; the windmill faces a random way per map.
- [x] Build clean (tsc+vite), all 31 smoke tests pass.
- [ ] Next: real perf pass from user fps, watermill on the river, cloud shadows, church bells

**2026-06-12 (17)** - v0.7k "perf overlay + cloud material share" (loop mode, 5-min autonomous loop):
- [x] Perf overlay (toggle `P`, or boot with `#stats`): a small top-left monospace HUD built in
      `main.ts` showing fps, frame ms, draw calls, k-triangles and live geometry/texture counts
      (from `renderer.info`, read right after `renderer.render`). Lets the USER profile on real
      hardware and report back numbers (headless swiftshader fps isn't representative). The geo/tex
      counts also surface any leak across season/time/editor rebuilds.
- [x] Small optimisation: all 16 clouds now share ONE `SpriteMaterial` (was 16); opacity is set once
      per frame instead of per-sprite.
- [x] Build clean (tsc+vite), all 31 smoke tests pass. (Headless Chrome screenshot capture is
      flaky in this env - overlay is plain DOM + `renderer.info`, tsc-validated.)
- [ ] Next: use the user's reported fps to target a real perf pass; cloud shadows; church bells

**2026-06-12 (16)** - v0.7j "fireflies" (loop mode, 5-min autonomous loop):
- [x] Fireflies at dusk (`Environment.buildFireflies`): 240 additive warm-green glow points in 6
      swarms over the flat coastal plain (fixed low y, so no terrain coupling needed). Each drifts on
      its own slow Lissajous and blinks on its own phase; `update` rewrites the position + color
      buffers each frame and fades the whole cloud in with `starBase` (hidden by day). Soft round
      star sprite, `fog:true` so far swarms melt into the haze.
- [x] Build clean (tsc+vite), all 31 smoke tests pass.
- [ ] Next: perf pass, cloud shadows, church-bell tolls, seasonal gating for fireflies

**2026-06-12 (15)** - v0.7i "the lighthouse" (loop mode, 5-min autonomous loop):
- [x] Harbour lighthouse (`buildLighthouse` in scenery.ts): a red-banded white tower on a rocky
      outcrop at the shore by `towns[0]` (coastX+18, 150 m north of the pier), tapered cylinder +
      gallery ring + lantern cage + glowing lamp (shared NIGHT_GLOW material, lights at dusk) + cone
      roof. Placed at `max(0, terrain.height)` so it stands at the waterline.
- [x] Sweeping beam: two opposite additive cones on a pivot tagged `userData.beacon`. World collects
      beacons per rebuild (like the bobbers) and in `World.update` spins the pivot every frame, fading
      the beam in only after dark via the new `Environment.nightAmount` getter (= starBase); a slow
      sine makes it pulse. Beams `visible=false` by day (no overdraw).
- [x] Build clean (tsc+vite), all 31 smoke tests pass.
- [ ] Next: perf pass, cloud shadows, church-bell tolls, more creative ideas

**2026-06-12 (14)** - v0.7h "drifting clouds" (loop mode, 5-min autonomous loop):
- [x] Daytime clouds (`Environment.buildClouds`): 16 cumulus Sprites (soft puff texture - overlapping
      white lobes drawn with `lighter` compositing, flattish base), scattered over the map at
      y=560-1080, drifting slowly east and wrapping across `±map.size`. `fog:true` so distant ones
      melt into the haze; opacity thins to ~0.27 at night (`0.9 * (1 - 0.7*starBase)`).
- [x] Verified the night sky renders without errors via a headless Chrome boot-shot (#time=night):
      world boots, sunset-glow sky/sea/town/road all present, no runtime crash from the recent
      sky features. (Stars/moon sit above the menu camera's horizon framing; best judged live.)
- [x] Build clean (tsc+vite), all 31 smoke tests pass.
- [ ] Next: perf pass, church-bell tolls on the hour, cloud shadows, more creative ideas

**2026-06-12 (13)** - v0.7g "moon & shooting stars" (loop mode, 5-min autonomous loop):
- [x] Moon disc (`Environment.buildMoon`): a Sprite hung in the exact moonlight direction (el 42,
      az 70 - same vector `applySun` lights the night with), so the visible moon and the shadows
      agree. Pale halo + bright disc + faint maria (canvas texture); `fog:false`, re-centred on the
      camera each frame at R=8500 (just in front of the stars). Fades in with `starBase`.
- [x] Shooting stars (`Environment.buildMeteor`): one reusable additive Line that streaks a tangent
      path across the upper dome over 0.8 s (sin fade in/out), then waits 8-34 s before the next.
      Only fires when it's properly dark (`starBase > 0.5`); anchored to the camera so it reads as sky.
- [x] Build clean (tsc+vite), all 31 smoke tests pass.
- [ ] Next: perf pass, church-bell tolls on the hour, drifting clouds, more creative ideas

**2026-06-12 (12)** - v0.7f "starry night" (loop mode, 5-min autonomous loop):
- [x] Night starfield (`Environment.buildStars`): 1400-point upper-hemisphere dome (R=9000), soft
      radial star sprite, additive blending, mostly white with a few bluish/warm tints. `fog:false`
      so the night fog doesn't swallow it; `depthWrite:false`; `frustumCulled:false` because it's
      re-centred on the camera every frame (acts as an infinite backdrop). Best seen at `#time=night`.
- [x] Fades with the sun: `applySun` sets `starBase = clamp((5 - elDeg)/10)` (out by dawn, full at
      night) and `update` twinkles overall opacity + hides the dome entirely in daylight. Works in
      the 8-min day/night cycle and the fixed time-of-day presets.
- [x] Build clean (tsc+vite), all 31 smoke tests pass.
- [ ] Next: shooting stars + a moon disc, perf pass, church-bell tolls, more creative ideas

**2026-06-12 (11)** - v0.7e "the sea gets louder" (loop mode, 5-min autonomous loop):
- [x] Positional ambient mix: each audio layer is now source -> filter -> swing (LFO wobble) ->
      level (scene control) -> master. `AmbientAudio.setScene(coastDist, speedKmh)` rides the level
      nodes: surf swells near the waterline and fades ~1.2 km inland (smoothstep), wind rises with
      ground speed. Smoothed with `setTargetAtTime`; the LFO wobble scales with the layer so it
      never clips to zero. `main.ts` feeds it the rider's `coastX` distance + km/h ~5x a second.
- [x] Build clean (tsc+vite), all 31 smoke tests pass.
- [ ] Next: perf pass, church-bell tolls on the hour, distant-thunder weather, more creative ideas

**2026-06-12 (10)** - v0.7d "ambient sound" (loop mode, 5-min autonomous loop):
- [x] Procedural soundscape (`src/audio/ambient.ts`, `AmbientAudio`): wind (band-passed leaky-noise
      loop, slow breathing LFO), a rolling sea swell (low-passed noise, ~9 s swell LFO) and sparse
      birdsong (scheduled sine warbles, quiet after dusk). All Web Audio - no sound files, stays
      offline/self-contained. AudioContext is created lazily inside `start()` so importing the
      module never touches the audio API (headless tools/smoketests stay safe).
- [x] Wired in `main.ts`: `ambient.start()` fires from the Start-Ride click (the required user
      gesture for autoplay); `M` toggles mute (persisted in `roadgame.muted`, works in any mode);
      birds gate on `world.environment.isNight` each frame; one-time "press M to mute" hint toast.
      All audio calls are wrapped in try/catch - sound can never break the ride.
- [x] Build clean (tsc+vite), all 31 smoke tests pass.
- [ ] Next: perf pass, dynamic sea/wind volume by proximity to coast, more creative ideas

**2026-06-12 (9)** - v0.7c "boats under sail" (loop mode, 5-min autonomous loop):
- [x] Fishing boats sailing the bay: 2 boats motor slow offshore ellipses (`Environment.buildSeaBoats`),
      always seaward of `coastX`. Low-poly hull+bow cone+deck+cabin+mast (same palette as the moored
      harbour boats). Heading follows the ellipse tangent (bow = local +X -> `y = atan2(-vz, vx)`),
      gentle bob + roll. Lives in Environment, so they survive map rebuilds.
- [x] Foam bow wakes: a flat trapezoid trailing each stern (local -X), fanning out astern, with a
      canvas wake texture - two bright diverging lines + churn, tapering from strong at the hull to
      nothing at the tail. `depthWrite:false`, `renderOrder:3`, opacity pulses and dims at night.
- [x] Build clean (tsc+vite), all 31 smoke tests pass.
- [ ] Next: ambient audio?, perf pass, more creative ideas

**2026-06-12 (8)** - v0.7b "surf on the shoreline" (loop mode, 5-min autonomous loop):
- [x] Animated shoreline foam: a lacy white surf band runs the full coast at the waterline
      (`Environment.buildShoreFoam`). Canvas-generated foam texture - alpha peaks across the
      waterline (U) and breaks into wave streaks along-shore (V, tiles seamlessly via a circular
      noise sample). One transparent plane (`depthWrite:false`, `renderOrder:2`) just above the
      sea (y=0.08). Per-frame in `Environment.update`: texture V-offset scrolls north, the strip
      washes in/out (`coastX+18 +- sin`), opacity gently pulses and dims at night (0.78 -> 0.3).
      Lives in Environment (persists across map rebuilds, like the water/birds/balloons).
- [x] Build clean (tsc+vite), all 31 smoke tests pass.
- [ ] Next: ambient audio?, perf pass, boat wakes behind moving boats, more creative ideas

**2026-06-11 (7)** - v0.7 "sunflowers, balloons & life on the water" (loop mode):
- [x] Sunflower fields (spring/summer): rectangular row-patches scattered across wheat/plowed
      fields, low-poly stalk+leaves+head model (one InstancedMesh, vertex colors), whole field
      faces the morning sun (east). Capped at 5000 plants; no shadows (perf, like grass tufts).
      `buildSunflowers` in scenery.ts, avoids roads/river/towns.
- [x] Hot-air balloons: 3 drifting over the valley (Environment, animated like the birds).
      Striped teardrop envelope (LatheGeometry, alternating-gore vertex colors), basket + ropes;
      slow wide-circle drift + thermal bob + gentle yaw sway. `buildBalloons` + update loop.
- [x] Boats & buoys bob on the swell: harbour boats/buoys tagged `userData.bob`; World collects
      them once per rebuild and animates Y (+ roll for boats) in World.update. Survives map rebuilds.
- [x] Build clean (tsc+vite), all 31 smoke tests pass, Chrome boot-render verified (no runtime
      errors - all three features are on the boot/render path).
- [ ] Next: ambient audio?, perf pass, boat wakes/foam at shore, more creative ideas

**2026-06-10 (6)** - v0.6 "living Tuscany" (loop mode active - user said keep building autonomously):
- [x] River: seeded course hills->sea avoiding towns (MapData.river), strictly downhill water
      profile, terrain carves the bed (cuts under roads), lush green banks + pebble bed painted,
      water ribbon mesh; stone bridges auto-built where roads cross (deck/parapets/abutments)
- [x] Italian signage: white town-entry plates (name, both travel directions, right side) +
      blue junction signposts (nearest towns + km via Dijkstra; plates angled along their exit)
- [x] Harbour at towns[0]: stone pier + platform, bollards, glowing lamp, 7 colorful fishing
      boats, buoys
- [x] Sheep flocks + cattle on pastures (instanced, blocked from roads/river/towns)
- [x] Hay bales on wheat stubble (summer/autumn only)
- [x] Telegraph poles + sagging wires along main roads (left side, instanced + LineSegments)
- [x] Scenery placement now also avoids the river (riverBlocked in blocked())
- [x] 31 smoke tests pass (4 new river checks); Chrome-verified: town streets look alive
- [x] (6b) Birds (3 flocks circling, flapping), horizon hill silhouette ring (flat over the sea),
      dev hash #lookat=x,z for close-up orbits. Bridge close-up verified - river water needed
      side:DoubleSide (same winding bug as the road once had) + diffuse blue Lambert.
- [ ] Next: ambient audio?, sunflower fields, boat bobbing, perf pass, more creative ideas

**2026-06-10 (5)** - v0.5 free roam + real network:
- [x] Free-ride mode (route picker entry "-1"): turn at junctions with arrow chooser UI
      (HUD #turn-ui, default = straightest exit), keyboard arrows + U/Backspace u-turn,
      gamepad (stick turn, B u-turn, Y camera, RT = demo power). VirtualTrainer keys now ↑/↓ & +/-.
- [x] Network v2: 48 nodes / 87 edges / 63 km. Edge kinds: "main" (town-to-town Dijkstra backbone,
      7 m, markings) vs "lane" (4.4 m, unmarked, worn edges). Per-sample half-width drives ribbon,
      terrain corridor and textures. Junction pads sized by widest road.
- [x] Town street grids: 1-5 inner nodes per town by size, lanes to the piazza + ring links
      (min piazza degree 5). Towns differ in size (harbour 170-220 m).
- [x] Night glow: window panes/lantern glass are separate glow geometries (BuiltModel.glow) drawn
      with NIGHT_GLOW_MATERIAL; Environment fades emissive in below 14° sun elevation (dusk+night).
- [x] More lone houses/farmsteads along country roads; vehicles prefer main roads, drive centered
      and slower on lanes.
- [x] Dev hashes: route=-1 (free ride), stopAtTurn (halt at first junction chooser). Chrome now
      used for headless shots (user request; Edge broke itself mid-update once).
- [x] Verified via Chrome screenshots: lane roads render narrow/unmarked, junction chooser shows,
      free ride accumulates km. All 27 smoke tests pass.

**2026-06-10 (3)** - v0.3 pushed & deployed:
- [x] FIXED (was top user complaint): roads no longer sink under terrain on hills - corridor is
      fully flattened >= one terrain-grid cell each side (Terrain.flatHalf), carved 0.3 m below,
      ribbon lifted 0.12 m, mesh up to 560 segs. Verified at 10 % grade.
- [x] First-person view (C key cycles chase -> fpv -> front -> side; pedaling bob, rider hidden)
- [x] Day/night: Environment class, presets morning/noon/afternoon/sunset/night + 8-min cycle
      (sky-PMREM ambient refreshed, throttled 4 s in cycle mode); moonlight at night
- [x] Seasons (spring/summer/autumn/winter): SEASON_PALETTES repaint fields/verges/grass; autumn
      = red vineyards. Season change = full rebuild behind the loading overlay.
- [x] Variety: 5 randomized house variants (windows/shutters/chimneys) + 4 per tree type;
      stucco texture on buildings, foliage speckle on trees, jersey texture (cached per color),
      car paint texture + head/taillights
- [x] Editor: town tool = click name-labeled town to select, click ground to move; pan 3x faster
- [x] Dev hashes: #route=N, #time=night, #season=autumn (plus #autoride=S, #noui, cam2)
- [x] Bike lights: front/rear lamps on all bikes (emissive, bright at night), player gets a real
      SpotLight headlight beam; works in fpv via Rider.setBodyVisible (headlight stays on)
- [x] v0.4: right-hand traffic actually right (the old "right" vector was left!); cars/trucks slow
      behind riders, pull left across the centerline to overtake, merge back (lane logic measured
      from road centerline). Bigger towns (harbour 170-220 m) with piazza cobbles, fountains,
      statues, market stalls (striped awnings, 3 variants), benches, street lamps. Articulated
      pedestrians (swinging arms/legs, dresses, hats, skin tones). Spawn margins fixed so houses/
      trees never overlap the asphalt. New scenery types available in the editor.
- [ ] Watch list: night maybe still dark (bumped moon 0.55), headless sea renders grey (check real GPU)

**2026-06-10 (2)** - v0.2 pushed & deployed:
- [x] Repo + GitHub Pages auto-deploy (user account "sanjoesan"); Electron/.exe dropped on user request
- [x] Realism pass: ACES tonemapping, Sky+PMREM ambient, sun shadows, Water sea, painted terrain
      textures, textured asphalt with markings, organic trees, grass verges + 60k grass tufts
- [x] 6x6 km world, road NETWORK with junctions, 5 named towns with streets through them
- [x] 50 routes (12-55 km, 17 flat / 33 hilly, 0-10 % grades), route picker with stats
- [x] NPC riders, cars/trucks, pedestrians; custom jersey/bike colors; right-hand lane riding
- [x] All 25 smoke tests pass; user play-tested v0.1 with demo mode successfully ("works fine")
- [ ] User-reported watch list: houses still simple (no per-face textures), sea looks grey in
      headless shots (verify on real GPU), editor rebuilds are slow (~5 s fast quality)
- [ ] Real-hardware FTMS test pending (needs the user's trainer)
- [ ] Ideas later: ERG workout mode, sound, gamepad steering, Steam packaging

**2026-06-10 (1)** - v0.1: scaffold, FTMS+CPS+HR+demo, physics, HUD, FIT export + Garmin upload
script, single-loop world, world builder, all smoke tests green.
