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
