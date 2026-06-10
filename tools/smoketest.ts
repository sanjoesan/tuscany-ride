/**
 * Headless smoke test: world generation, physics and FIT encoding.
 * Run with: npx tsx tools/smoketest.ts
 */
import { defaultMap } from "../src/world/mapData";
import { Terrain } from "../src/world/terrain";
import { Road } from "../src/world/road";
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
const road = new Road(map, terrain);
terrain.setRoad(road.samples);

check("road has samples", road.samples.length > 200, `${road.samples.length} samples`);
check("road loop length plausible", road.totalLength > 3000 && road.totalLength < 12000, `${(road.totalLength / 1000).toFixed(2)} km`);

const maxGrade = Math.max(...road.samples.map((s) => Math.abs(s.grade)));
check("grade limited to ~11%", maxGrade <= 0.125, `max ${(maxGrade * 100).toFixed(1)}%`);

// elevation continuity around the loop seam
const a = road.at(road.totalLength - 0.5);
const b = road.at(0.5);
check("loop seam continuous", a.pos.distanceTo(b.pos) < 5, `${a.pos.distanceTo(b.pos).toFixed(2)} m gap`);

// road conforming: terrain height directly under road == road height
let worstDelta = 0;
for (let i = 0; i < road.samples.length; i += 25) {
  const s = road.samples[i];
  const d = Math.abs(terrain.height(s.x, s.z) - s.y);
  worstDelta = Math.max(worstDelta, d);
}
check("terrain conforms to road", worstDelta < 1.0, `worst delta ${worstDelta.toFixed(2)} m`);

// sea exists west of the coast
check("sea floor below waterline", terrain.height(map.coastX - 300, 0) < 0);
check("land above waterline", terrain.height(map.coastX + 400, 0) > 0.5);

// elevation range sane
const minY = Math.min(...road.samples.map((s) => s.y));
const maxY = Math.max(...road.samples.map((s) => s.y));
check("road elevation range sane", minY > -5 && maxY < 300, `${minY.toFixed(0)}..${maxY.toFixed(0)} m`);

// ---------- physics ----------
const phys = new BikePhysics();
phys.massKg = 84;
for (let i = 0; i < 600; i++) phys.step(200, 0, 0.1); // 60 s at 200 W on the flat
check("200W flat -> ~32-36 km/h", phys.kmh > 30 && phys.kmh < 38, `${phys.kmh.toFixed(1)} km/h`);

const phys2 = new BikePhysics();
phys2.massKg = 84;
for (let i = 0; i < 1200; i++) phys2.step(200, 0.08, 0.1); // 8% climb
check("200W on 8% -> ~9-13 km/h", phys2.kmh > 8 && phys2.kmh < 14, `${phys2.kmh.toFixed(1)} km/h`);

const phys3 = new BikePhysics();
phys3.massKg = 84;
phys3.v = 5;
for (let i = 0; i < 1200; i++) phys3.step(0, -0.06, 0.1); // coasting down -6%
check("coasting downhill accelerates", phys3.kmh > 40, `${phys3.kmh.toFixed(1)} km/h`);

// ---------- GPS mapping ----------
const gps = gameToGps(0, 0);
check("GPS anchor in Tuscany", gps.lat > 42 && gps.lat < 44 && gps.lon > 10 && gps.lon < 12, `${gps.lat.toFixed(3)}, ${gps.lon.toFixed(3)}`);

// ---------- FIT encoding ----------
const rec = new RideRecorder();
rec.start();
const t0 = Date.now();
// synthesize 120 s of riding
let dist = 0;
for (let i = 0; i < 120; i++) {
  const speed = 9 + Math.sin(i / 10) * 2;
  dist += speed;
  const at = road.at(dist);
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

// verify the file CRC the same way Garmin does
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

// walk all records to make sure the message stream is well-formed
let pos = 14;
let defs = new Map<number, number>(); // local type -> data record size
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
check("FIT contains all records", records === 120 + 6, `${records}`); // 120 records + file_id + 2 events + lap + session + activity

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
