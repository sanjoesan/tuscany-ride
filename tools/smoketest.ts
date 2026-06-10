/**
 * Headless smoke test: network generation, routes, physics and FIT encoding.
 * Run with: npx tsx tools/smoketest.ts
 */
import { defaultMap } from "../src/world/mapData";
import { Terrain } from "../src/world/terrain";
import { RoadNetwork, MAX_GRADE } from "../src/world/road";
import { River } from "../src/world/river";
import { generateRoutes } from "../src/world/routes";
import { BikePhysics } from "../src/sim/physics";
import { RideRecorder, gameToGps } from "../src/fit/recorder";

let failures = 0;
function check(name: string, ok: boolean, info = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${info ? "  (" + info + ")" : ""}`);
  if (!ok) failures++;
}

// ---------- world generation ----------
const map = defaultMap();
const terrain = new Terrain(map);
const river = new River(map, terrain);
terrain.setRiver(river.samples);
const network = new RoadNetwork(map, terrain);
terrain.setRoad(network.allSamples);

// ---------- river ----------
check("river has a course", river.samples.length > 60, `${river.samples.length} samples`);
{
  let monotonic = true;
  for (let i = 1; i < river.samples.length; i++) {
    if (river.samples[i].y > river.samples[i - 1].y + 0.001) {
      monotonic = false;
      break;
    }
  }
  check("river flows downhill", monotonic);
  const mouth = river.samples[river.samples.length - 1];
  check("river reaches the sea", mouth.x < map.coastX && mouth.y <= -0.3, `mouth at x=${mouth.x.toFixed(0)}, y=${mouth.y.toFixed(1)}`);
  const clear = map.towns.every((t) =>
    river.samples.every((s) => Math.hypot(s.x - t.x, s.z - t.z) > t.radius)
  );
  check("river avoids the towns", clear);
}

check("towns generated", map.towns.length >= 4, `${map.towns.length} towns: ${map.towns.map((t) => t.name).join(", ")}`);
check("network has junctions", map.nodes.length >= map.towns.length + 8, `${map.nodes.length} nodes`);
check("network has roads", map.edges.length >= map.nodes.length, `${map.edges.length} edges, ${network.totalKm.toFixed(1)} km of road`);

// every node should be reachable (graph connected)
{
  const adj: number[][] = map.nodes.map(() => []);
  for (const e of map.edges) {
    adj[e.a].push(e.b);
    adj[e.b].push(e.a);
  }
  const seen = new Set<number>([0]);
  const stack = [0];
  while (stack.length) {
    const n = stack.pop()!;
    for (const m of adj[n]) if (!seen.has(m)) { seen.add(m); stack.push(m); }
  }
  check("road network connected", seen.size === map.nodes.length, `${seen.size}/${map.nodes.length} reachable`);
}

// road classes: main backbone + narrow lanes, and inner town streets
{
  const mains = map.edges.filter((e) => e.kind === "main").length;
  const lanes = map.edges.filter((e) => e.kind === "lane").length;
  check("main roads + lanes exist", mains >= 5 && lanes >= 10, `${mains} main, ${lanes} lanes`);
  // every town piazza should have at least 3 roads (through-roads + inner streets)
  const degree = map.nodes.map(() => 0);
  for (const e of map.edges) {
    degree[e.a]++;
    degree[e.b]++;
  }
  const minTownDegree = Math.min(...map.towns.map((_, i) => degree[i]));
  check("towns have real street junctions", minTownDegree >= 3, `min piazza degree ${minTownDegree}`);
}

// grade limit respected on every edge
{
  let maxG = 0;
  for (const p of network.paths) for (const s of p.samples) maxG = Math.max(maxG, Math.abs(s.grade));
  check("grades limited to 10%", maxG <= MAX_GRADE + 0.025, `max ${(maxG * 100).toFixed(1)}%`);
}

// edges meeting at a node share its elevation
{
  let worst = 0;
  for (const p of network.paths) {
    worst = Math.max(worst, Math.abs(p.samples[0].y - network.nodeY[p.a]));
    worst = Math.max(worst, Math.abs(p.samples[p.samples.length - 1].y - network.nodeY[p.b]));
  }
  check("junction elevations consistent", worst < 0.5, `worst ${worst.toFixed(2)} m`);
}

// terrain conforms to the roads
{
  let worst = 0;
  for (let i = 0; i < network.allSamples.length; i += 100) {
    const s = network.allSamples[i];
    worst = Math.max(worst, Math.abs(terrain.height(s.x, s.z) - s.y));
  }
  check("terrain conforms to roads", worst < 1.0, `worst delta ${worst.toFixed(2)} m`);
}

check("sea floor below waterline", terrain.height(map.coastX - 400, 0) < 0);
check("land above waterline", terrain.height(map.coastX + 500, 0) > 0.5);

// ---------- routes ----------
const routes = generateRoutes(map, network);
check("~50 routes generated", routes.length >= 45, `${routes.length} routes`);

{
  const kms = routes.map((r) => r.stats.distanceKm);
  const min = Math.min(...kms);
  const max = Math.max(...kms);
  check("route lengths span 30min-2h", min < 16 && max > 40, `${min.toFixed(1)}..${max.toFixed(1)} km`);
}
{
  const starts = new Set(routes.map((r) => r.startNode));
  check("multiple starting points", starts.size >= Math.min(4, map.towns.length), `${starts.size} different starts`);
}
{
  let ok = true;
  let info = "";
  for (const r of routes) {
    // circuit: ends where it started
    const a = r.samples[0];
    const b = r.at(r.totalLength - 0.01).pos;
    const gap = Math.hypot(a.x - b.x, a.z - b.z);
    if (gap > 25) {
      ok = false;
      info = `${r.name} gap ${gap.toFixed(0)} m`;
      break;
    }
    // continuity: no teleports between consecutive samples
    for (let i = 1; i < r.samples.length; i++) {
      const d = Math.hypot(r.samples[i].x - r.samples[i - 1].x, r.samples[i].z - r.samples[i - 1].z);
      if (d > 30) {
        ok = false;
        info = `${r.name} jump ${d.toFixed(0)} m at sample ${i}`;
        break;
      }
    }
    if (!ok) break;
  }
  check("routes are continuous circuits", ok, info);
}
{
  const flat = routes.filter((r) => r.stats.maxGradePct < 5.5).length;
  const hilly = routes.filter((r) => r.stats.maxGradePct >= 7).length;
  check("flat and hilly routes exist", flat >= 3 && hilly >= 3, `${flat} flat, ${hilly} steep (of ${routes.length})`);
}

// ---------- physics ----------
const phys = new BikePhysics();
phys.massKg = 84;
for (let i = 0; i < 600; i++) phys.step(200, 0, 0.1);
check("200W flat -> ~32-36 km/h", phys.kmh > 30 && phys.kmh < 38, `${phys.kmh.toFixed(1)} km/h`);

const phys2 = new BikePhysics();
phys2.massKg = 84;
for (let i = 0; i < 1200; i++) phys2.step(200, 0.08, 0.1);
check("200W on 8% -> ~9-13 km/h", phys2.kmh > 8 && phys2.kmh < 14, `${phys2.kmh.toFixed(1)} km/h`);

// ---------- GPS mapping ----------
const gps = gameToGps(0, 0);
check("GPS anchor in Tuscany", gps.lat > 42 && gps.lat < 44 && gps.lon > 10 && gps.lon < 12, `${gps.lat.toFixed(3)}, ${gps.lon.toFixed(3)}`);

// ---------- FIT encoding ----------
const rec = new RideRecorder();
rec.start();
const t0 = Date.now();
const route = routes[0];
let dist = 0;
for (let i = 0; i < 120; i++) {
  const speed = 9 + Math.sin(i / 10) * 2;
  dist += speed;
  const at = route.at(dist);
  const g = gameToGps(at.pos.x, at.pos.z);
  rec.samples.push({
    t: t0 + i * 1000,
    power: 180 + Math.round(Math.sin(i / 5) * 30),
    cadence: 88,
    heartRate: 140,
    speed,
    distance: dist,
    altitude: at.pos.y,
    lat: g.lat,
    lon: g.lon,
  });
}

const stats = rec.stats();
check("stats duration", Math.abs(stats.durationS - 119) < 2, `${stats.durationS.toFixed(0)} s`);
check("stats avg power", stats.avgPower > 150 && stats.avgPower < 210, `${stats.avgPower.toFixed(0)} W`);

const fit = rec.toFit();
check("FIT header size byte", fit[0] === 14);
check("FIT signature", String.fromCharCode(fit[8], fit[9], fit[10], fit[11]) === ".FIT");
const dataSize = fit[4] | (fit[5] << 8) | (fit[6] << 16) | (fit[7] << 24);
check("FIT data size matches", dataSize === fit.length - 16, `${dataSize} vs ${fit.length - 16}`);

function crc16(bytes: Uint8Array, start: number, end: number): number {
  const table = [
    0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401,
    0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400,
  ];
  let crc = 0;
  for (let i = start; i < end; i++) {
    const byte = bytes[i];
    let tmp = table[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ table[byte & 0xf];
    tmp = table[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ table[(byte >> 4) & 0xf];
  }
  return crc;
}
const fileCrc = fit[fit.length - 2] | (fit[fit.length - 1] << 8);
check("FIT file CRC valid", fileCrc === crc16(fit, 0, fit.length - 2));

let pos = 14;
const defs = new Map<number, number>();
let records = 0;
let badStream = false;
while (pos < fit.length - 2) {
  const header = fit[pos];
  if (header & 0x40) {
    const numFields = fit[pos + 5];
    let size = 0;
    for (let f = 0; f < numFields; f++) size += fit[pos + 6 + f * 3 + 1];
    defs.set(header & 0x0f, size);
    pos += 6 + numFields * 3;
  } else {
    const size = defs.get(header & 0x0f);
    if (size === undefined) {
      badStream = true;
      break;
    }
    pos += 1 + size;
    records++;
  }
}
check("FIT message stream well-formed", !badStream && pos === fit.length - 2, `${records} data messages`);
check("FIT contains all records", records === 120 + 6, `${records}`);

// route listing for the report
console.log("\nSample routes:");
for (const r of [routes[0], routes[Math.floor(routes.length / 2)], routes[routes.length - 1]]) {
  console.log(`  ${r.name}: ${r.stats.distanceKm.toFixed(1)} km, ${r.stats.gainM} m up, max ${r.stats.maxGradePct}%, ~${r.stats.estMinutes} min`);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
