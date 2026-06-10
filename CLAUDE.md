# Tuscany Ride (E:\Roadgame)

A free 3D indoor cycling game. Connects to FTMS smart trainers over Web Bluetooth,
simulates a ride through a Tuscan landscape, and exports rides as Garmin-compatible
.FIT files. No subscription, no multiplayer - by design.

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

- `src/main.ts` - orchestrator: renderer, mode state machine (menu / riding / editor), UI wiring, main loop.
- `src/types.ts` - shared types (`MapData`, `Telemetry`, `RideSample`...).
- `src/world/` - world generation. **Build order matters**: `Terrain(map)` -> `Road(map, terrain)`
  (spline + smoothed/grade-limited elevation) -> `terrain.setRoad(samples)` (terrain conforms to road
  corridor via spatial hash) -> meshes + `buildScenery` (procedural vegetation/town from seed, then
  manual `map.scenery` items; all instanced). `World.rebuild()` regenerates everything in place.
  - `mapData.ts` - default "Toscana Classica" map, localStorage persistence, JSON validation.
  - `models.ts` - low-poly merged geometries (vertex colors, one shared material). Use `mergeAll`,
    never raw `mergeGeometries` (indexed/non-indexed mismatch returns null - was a real bug).
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

**2026-06-10** - v0.1 complete and verified:
- [x] Project scaffolded, Node installed via winget
- [x] Tuscany world: terrain biome patchwork, sea west of coastX, procedural town with church/campanile, vineyards/olives/cypresses, 4.5 km road loop
- [x] FTMS + CPS fallback + HR + demo mode
- [x] Physics, HUD with elevation profile, ride recording
- [x] FIT export (all 20 smoke tests pass, incl. CRC + message-stream walk)
- [x] Garmin upload script
- [x] World builder (road editing, object placement, town move, seed/hilliness, save/load)
- [x] Headless screenshot verified: world renders (fixed mergeGeometries null bug)
- [ ] Real-hardware FTMS test pending (needs the user's trainer)
- [ ] Possible later: workout mode (ERG), more maps, sound, gamepad steering
