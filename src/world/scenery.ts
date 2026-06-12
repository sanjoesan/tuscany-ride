import * as THREE from "three";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import { Water } from "three/examples/jsm/objects/Water.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { MapData, SceneryType, TownData } from "../types";
import { Terrain, smoothstep } from "./terrain";
import type { RoadNetwork } from "./road";
import { mulberry32, Noise2D } from "./noise";
import { buildModel, modelMaterial, NIGHT_GLOW_MATERIAL, BUILDING_MATERIAL } from "./models";

interface Placement {
  x: number;
  z: number;
  rot: number;
  scale: number;
}

/**
 * Populates the world: procedural vegetation/vineyards derived from the seed,
 * a generated Italian town, plus the manually placed items from the map.
 */
export function buildScenery(map: MapData, terrain: Terrain, network: RoadNetwork): THREE.Group {
  const group = new THREE.Group();
  group.name = "scenery";
  const rand = mulberry32(map.seed * 31 + 7);
  const half = map.size / 2 - 30;

  const buckets = new Map<SceneryType, Placement[]>();
  const put = (type: SceneryType, p: Placement) => {
    let arr = buckets.get(type);
    if (!arr) {
      arr = [];
      buckets.set(type, arr);
    }
    arr.push(p);
  };

  const riverBlocked = (x: number, z: number, margin = 6): boolean => {
    const nr = terrain.nearestRiver(x, z, margin + 14);
    return nr !== null && nr.dist < nr.sample.half + margin;
  };
  const blocked = (x: number, z: number, margin = 9): boolean => {
    const near = terrain.nearestRoad(x, z, margin);
    if (near !== null && near.dist < margin) return true;
    return riverBlocked(x, z, Math.min(margin, 8));
  };
  const inTown = (x: number, z: number, extra = 0): boolean =>
    map.towns.some((t) => Math.hypot(x - t.x, z - t.z) < t.radius + extra);

  // ---------- countryside grid ----------
  const step = 13;
  for (let x = -half; x < half; x += step) {
    for (let z = -half; z < half; z += step) {
      const jx = x + (rand() - 0.5) * step * 0.8;
      const jz = z + (rand() - 0.5) * step * 0.8;
      if (jx < map.coastX + 50 || inTown(jx, jz, 14) || blocked(jx, jz)) continue;
      const kind = terrain.fieldKind(jx, jz);
      const r = rand();
      if (kind === "olive") {
        if (r < 0.5) put("olive", { x: jx, z: jz, rot: rand() * 6.28, scale: 0.8 + rand() * 0.5 });
      } else if (kind === "vineyard") {
        // rows are painted into the ground texture; the odd olive at field edges
        if (r < 0.015) put("olive", { x: jx, z: jz, rot: rand() * 6.28, scale: 0.9 });
      } else if (kind === "pasture") {
        if (r < 0.025) put("pine", { x: jx, z: jz, rot: rand() * 6.28, scale: 0.8 + rand() * 0.6 });
        else if (r < 0.04) put("olive", { x: jx, z: jz, rot: rand() * 6.28, scale: 0.9 });
      } else if (kind === "wheat" || kind === "plowed") {
        if (r < 0.008) put("cypress", { x: jx, z: jz, rot: rand() * 6.28, scale: 0.9 + rand() * 0.5 });
      }
    }
  }

  // ---------- cypress alleys + roadside trees ----------
  const samples = terrain.getRoadSamples();
  for (let i = 0; i < samples.length; i += 6) {
    const s = samples[i];
    if (s.x < map.coastX + 60) continue;
    if (inTown(s.x, s.z, 6)) continue;
    const r = rand();
    if (r < 0.45) {
      const side = r < 0.225 ? 1 : -1;
      const nx = -s.dirZ * side;
      const nz = s.dirX * side;
      const off = 6 + rand() * 2;
      const px = s.x + nx * off;
      const pz = s.z + nz * off;
      if (!inTown(px, pz, 4) && !blocked(px, pz, 5)) {
        put("cypress", { x: px, z: pz, rot: rand() * 6.28, scale: 0.85 + rand() * 0.5 });
      }
    }
  }

  // ---------- beach pines ----------
  for (let z = -half; z < half; z += 26) {
    if (rand() < 0.5) {
      const x = map.coastX + 65 + rand() * 70;
      if (!blocked(x, z) && !inTown(x, z, 10)) {
        put("pine", { x, z, rot: rand() * 6.28, scale: 0.9 + rand() * 0.6 });
      }
    }
  }

  // ---------- scattered farms ----------
  const farmCount = Math.round(map.size / 240);
  for (let f = 0; f < farmCount; f++) {
    const x = map.coastX + 250 + rand() * (half - map.coastX - 350);
    const z = -half + 100 + rand() * (2 * half - 200);
    if (blocked(x, z, 16) || inTown(x, z, 60)) continue;
    const rot = rand() * 6.28;
    put(rand() < 0.5 ? "villa" : "barn", { x, z, rot, scale: 1 });
    for (let c = 0; c < 4; c++) {
      const cxp = x + Math.cos(rot) * (10 + c * 4);
      const czp = z + Math.sin(rot) * (10 + c * 4);
      if (!blocked(cxp, czp, 5)) put("cypress", { x: cxp, z: czp, rot: 0, scale: 1 + rand() * 0.3 });
    }
  }

  // ---------- lone houses and small farmsteads along the country roads ----------
  const allSamples = terrain.getRoadSamples();
  for (let i = 0; i < allSamples.length; i += 26) {
    const s = allSamples[i];
    if (s.x < map.coastX + 80 || inTown(s.x, s.z, 30)) continue;
    if (rand() > 0.3) continue;
    const side = rand() < 0.5 ? 1 : -1;
    const off = 14 + rand() * 8;
    const hx = s.x - s.dirZ * off * side;
    const hz = s.z + s.dirX * off * side;
    if (blocked(hx, hz, 11)) continue;
    const r = rand();
    const type: SceneryType = r < 0.55 ? "house" : r < 0.8 ? "villa" : "barn";
    // face the road
    const rot = Math.atan2(s.dirX * side, s.dirZ * side) + Math.PI;
    put(type, { x: hx, z: hz, rot, scale: 0.9 + rand() * 0.2 });
    if (rand() < 0.6) {
      const cx2 = hx + (rand() - 0.5) * 18;
      const cz2 = hz + (rand() - 0.5) * 18;
      if (!blocked(cx2, cz2, 5)) put(rand() < 0.5 ? "cypress" : "olive", { x: cx2, z: cz2, rot: rand() * 6.28, scale: 1 });
    }
  }

  // ---------- towns ----------
  for (const town of map.towns) {
    buildTown(town, terrain, rand, put, blocked);
  }

  // ---------- streets: houses + lamps lining the roads inside towns ----------
  const roadSamples = terrain.getRoadSamples();
  for (let i = 0; i < roadSamples.length; i += 4) {
    const s = roadSamples[i];
    const town = map.towns.find((t) => Math.hypot(s.x - t.x, s.z - t.z) < t.radius);
    if (!town) continue;
    // keep the piazza in front of the church free
    if (Math.hypot(s.x - town.x, s.z - town.z) < 26) continue;
    for (const side of [1, -1]) {
      if (rand() > 0.62) continue;
      const nx = -s.dirZ * side;
      const nz = s.dirX * side;
      // house depth can reach ~5.5 m from its center: keep fronts off the asphalt
      const off = 11.5 + rand() * 2.5;
      const hx = s.x + nx * off;
      const hz = s.z + nz * off;
      if (blocked(hx, hz, 9.5)) continue;
      // face the street
      const rot = Math.atan2(-nz, -nx) + Math.PI / 2;
      put("house", { x: hx, z: hz, rot, scale: 0.8 + rand() * 0.2 });
    }
    // street lamps every ~24 m, alternating sides
    if (i % 20 === 0) {
      const side = (i / 20) % 2 === 0 ? 1 : -1;
      const lx = s.x - s.dirZ * 5.4 * side;
      const lz = s.z + s.dirX * 5.4 * side;
      if (!blocked(lx, lz, 4.6)) put("lamp", { x: lx, z: lz, rot: 0, scale: 1 });
    }
  }

  // ---------- manual scenery from the world builder ----------
  for (const it of map.scenery) {
    put(it.type, { x: it.x, z: it.z, rot: it.rot, scale: it.scale });
  }

  // ---------- bake into instanced meshes ----------
  // several geometry variants per type (the builders randomize proportions),
  // so streets and groves are not armies of clones
  const dummy = new THREE.Object3D();
  const VEGETATION: SceneryType[] = ["cypress", "pine", "olive"];
  const BUILDINGS: SceneryType[] = ["house", "villa", "barn"];
  const jitterColor = new THREE.Color();
  for (const [type, list] of buckets) {
    const vegetate = VEGETATION.includes(type);
    const building = BUILDINGS.includes(type);
    const variants = type === "house" ? 5 : vegetate ? 4 : type === "stall" ? 3 : 1;
    for (let v = 0; v < variants; v++) {
      const sub = list.filter((_, i) => i % variants === v);
      if (sub.length === 0) continue;
      const model = buildModel(type);
      const inst = new THREE.InstancedMesh(model.geo, modelMaterial(type), sub.length);
      inst.name = `inst-${type}-${v}`;
      const glowInst = model.glow
        ? new THREE.InstancedMesh(model.glow, NIGHT_GLOW_MATERIAL, sub.length)
        : null;
      sub.forEach((p, i) => {
        dummy.position.set(p.x, terrain.height(p.x, p.z) - 0.1, p.z);
        dummy.rotation.set(0, p.rot, 0);
        dummy.scale.setScalar(p.scale);
        dummy.updateMatrix();
        inst.setMatrixAt(i, dummy.matrix);
        glowInst?.setMatrixAt(i, dummy.matrix);
        // natural variation so no two plants / houses look identical
        if (vegetate) {
          const b = 0.72 + rand() * 0.36;
          jitterColor.setRGB(b * (0.92 + rand() * 0.16), b, b * (0.88 + rand() * 0.14));
          inst.setColorAt(i, jitterColor);
        } else if (building) {
          const b = 0.86 + rand() * 0.2;
          jitterColor.setRGB(b, b * (0.96 + rand() * 0.07), b * (0.9 + rand() * 0.1));
          inst.setColorAt(i, jitterColor);
        }
      });
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      inst.castShadow = true;
      inst.receiveShadow = true;
      group.add(inst);
      if (glowInst) group.add(glowInst);
    }
  }
  // ---------- grass tufts near the roads ----------
  const grass = buildGrass(map, terrain, rand);
  if (grass) group.add(grass);

  // ---------- life & infrastructure ----------
  group.add(buildSigns(map, terrain, network));
  group.add(buildBillboards(map, terrain, network, rand, blocked, inTown));
  group.add(buildHarbour(map, terrain, rand));
  group.add(buildLighthouse(map, terrain));
  group.add(buildWindmill(map, terrain, blocked, inTown));
  group.add(buildCampanile(map, terrain));
  group.add(buildAnimals(map, terrain, rand, blocked, inTown));
  group.add(buildHayBales(map, terrain, rand, blocked, inTown));
  group.add(buildSunflowers(map, terrain, rand, blocked, inTown));
  group.add(buildTelegraphPoles(terrain, network, rand));

  return group;
}

// ====================================================================
// signs: town entry plates + junction direction signposts
// ====================================================================

const signTexCache = new Map<string, THREE.CanvasTexture>();

function signTexture(text: string, kind: "town" | "dir"): THREE.CanvasTexture {
  const key = `${kind}:${text}`;
  const cached = signTexCache.get(key);
  if (cached) return cached;
  const W = 256;
  const H = 64;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  if (kind === "town") {
    ctx.fillStyle = "#f4f2ec";
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "#1a1a1a";
    ctx.lineWidth = 6;
    ctx.strokeRect(4, 4, W - 8, H - 8);
    ctx.fillStyle = "#1a1a1a";
    ctx.font = "bold 30px system-ui, sans-serif";
  } else {
    ctx.fillStyle = "#2a5d8f"; // blue italian direction sign
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "#f4f2ec";
    ctx.lineWidth = 4;
    ctx.strokeRect(3, 3, W - 6, H - 6);
    ctx.fillStyle = "#f4f2ec";
    ctx.font = "bold 26px system-ui, sans-serif";
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text.toUpperCase(), W / 2, H / 2 + 1);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  signTexCache.set(key, tex);
  return tex;
}

const POLE_MAT = new THREE.MeshStandardMaterial({ color: 0x707880, roughness: 0.6, metalness: 0.7 });

// ---- vintage enamel roadside advertising (invented 1960s Italian brands) ----
const BILLBOARDS: { bg: string; ink: string; brand: string; sub: string; accent: string }[] = [
  { bg: "#c0392b", ink: "#f6efdd", brand: "VERMUT ROSSI", sub: "l'aperitivo d'Italia", accent: "#e0b53a" },
  { bg: "#1f5a5a", ink: "#f6efdd", brand: "PNEUMATICI VOLPE", sub: "la strada sicura", accent: "#e0b53a" },
  { bg: "#ead9b6", ink: "#2c211a", brand: "CAFFE AURORA", sub: "il vero espresso", accent: "#c0392b" },
  { bg: "#d99a2b", ink: "#2c211a", brand: "APERITIVO SOLE", sub: "con gusto!", accent: "#c0392b" },
  { bg: "#2c211a", ink: "#f6efdd", brand: "OLIO SAN LORENZO", sub: "extra vergine", accent: "#9bb05a" },
  { bg: "#6e7a45", ink: "#f6efdd", brand: "MOTO FALCO", sub: "velocita e stile", accent: "#e0b53a" },
];

const billboardTexCache = new Map<number, THREE.CanvasTexture>();

function billboardTexture(i: number): THREE.CanvasTexture {
  const cached = billboardTexCache.get(i);
  if (cached) return cached;
  const d = BILLBOARDS[i % BILLBOARDS.length];
  const W = 512;
  const H = 320;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = d.bg;
  ctx.fillRect(0, 0, W, H);
  // enamel double border
  ctx.strokeStyle = d.ink;
  ctx.lineWidth = 14;
  ctx.strokeRect(11, 11, W - 22, H - 22);
  ctx.strokeStyle = d.accent;
  ctx.lineWidth = 4;
  ctx.strokeRect(28, 28, W - 56, H - 56);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // brand, wrapped onto two lines if it has multiple words
  ctx.fillStyle = d.ink;
  const words = d.brand.split(" ");
  const lines = words.length > 1 ? [words.slice(0, -1).join(" "), words[words.length - 1]] : words;
  ctx.font = "700 60px 'Bodoni Moda', Georgia, 'Times New Roman', serif";
  const ly = lines.length > 1 ? [H * 0.36, H * 0.55] : [H * 0.45];
  lines.forEach((ln, k) => ctx.fillText(ln, W / 2, ly[k]));
  // subtitle, italic
  ctx.fillStyle = d.accent;
  ctx.font = "italic 28px 'Bodoni Moda', Georgia, serif";
  ctx.fillText(d.sub, W / 2, H * 0.76);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  billboardTexCache.set(i, tex);
  return tex;
}

const BILLBOARD_EDGE = new THREE.MeshStandardMaterial({ color: 0x3a342c, roughness: 0.85 });
const BILLBOARD_BACK = new THREE.MeshStandardMaterial({ color: 0x6b6258, roughness: 0.8 });
const BILLBOARD_POST = new THREE.MeshStandardMaterial({ color: 0x5a4633, roughness: 0.9 });

function buildBillboards(
  map: MapData,
  terrain: Terrain,
  network: RoadNetwork,
  rand: () => number,
  blocked: (x: number, z: number, margin?: number) => boolean,
  inTown: (x: number, z: number, extra?: number) => boolean
): THREE.Group {
  const group = new THREE.Group();
  group.name = "billboards";
  let placed = 0;
  const MAX = 14;
  for (const path of network.paths) {
    if (placed >= MAX) break;
    if (path.samples.length < 30) continue; // long roads only
    if (rand() > 0.6) continue; // not every road gets one
    const i = Math.floor(path.samples.length * (0.3 + rand() * 0.4));
    const s = path.samples[i];
    if (s.x < map.coastX + 120) continue; // not down by the sea
    if (inTown(s.x, s.z, 50)) continue;
    const side = rand() < 0.5 ? 1 : -1;
    const off = path.half + 6 + rand() * 4;
    const bx = s.x - s.dirZ * off * side;
    const bz = s.z + s.dirX * off * side;
    if (blocked(bx, bz, 3) || inTown(bx, bz, 30)) continue;
    const y = terrain.height(bx, bz);
    // face the road: local +Z -> normal pointing back at the carriageway
    const ry = Math.atan2(s.dirZ * side, -s.dirX * side);
    const design = (placed + Math.floor(rand() * BILLBOARDS.length)) % BILLBOARDS.length;

    const g = new THREE.Group();
    g.position.set(bx, y, bz);
    g.rotation.y = ry;
    const PW = 4.2;
    const PH = 2.6;
    for (const px of [-PW * 0.36, PW * 0.36]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, 5, 0.18), BILLBOARD_POST);
      post.position.set(px, 2.5, 0);
      post.castShadow = true;
      g.add(post);
    }
    const panel = new THREE.Mesh(new THREE.BoxGeometry(PW, PH, 0.16), [
      BILLBOARD_EDGE,
      BILLBOARD_EDGE,
      BILLBOARD_EDGE,
      BILLBOARD_EDGE,
      new THREE.MeshStandardMaterial({ map: billboardTexture(design), roughness: 0.5 }),
      BILLBOARD_BACK,
    ]);
    panel.position.set(0, 3.5, 0);
    panel.castShadow = true;
    panel.receiveShadow = true;
    g.add(panel);
    group.add(g);
    placed++;
  }
  return group;
}

function buildSigns(map: MapData, terrain: Terrain, network: RoadNetwork): THREE.Group {
  const group = new THREE.Group();
  group.name = "signs";

  // ---- town entry signs: where a road crosses a town boundary ----
  for (const path of network.paths) {
    for (const town of map.towns) {
      for (let i = 1; i < path.samples.length; i++) {
        const a = path.samples[i - 1];
        const b = path.samples[i];
        const da = Math.hypot(a.x - town.x, a.z - town.z);
        const db = Math.hypot(b.x - town.x, b.z - town.z);
        const bound = town.radius + 14;
        const crossesIn = da > bound && db <= bound;
        const crossesOut = da <= bound && db > bound;
        if (!crossesIn && !crossesOut) continue;
        // entering direction
        const dirX = crossesIn ? b.dirX : -b.dirX;
        const dirZ = crossesIn ? b.dirZ : -b.dirZ;
        // sign on the right side of entering traffic
        const sx = b.x - dirZ * (path.half + 2.4);
        const sz = b.z + dirX * (path.half + 2.4);
        const y = terrain.height(sx, sz);
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.4, 6), POLE_MAT);
        pole.position.set(sx, y + 1.2, sz);
        group.add(pole);
        const board = new THREE.Mesh(
          new THREE.PlaneGeometry(2.4, 0.6),
          new THREE.MeshStandardMaterial({ map: signTexture(town.name, "town"), side: THREE.DoubleSide, roughness: 0.7 })
        );
        board.position.set(sx, y + 2.45, sz);
        board.rotation.y = Math.atan2(dirX, dirZ) + Math.PI;
        board.castShadow = true;
        group.add(board);
      }
    }
  }

  // ---- junction signposts: which towns lie down each exit ----
  // shortest distance from every node to every town
  const townDist: number[][] = map.towns.map((_, ti) => {
    const dist = map.nodes.map(() => Infinity);
    dist[ti] = 0;
    const seen = new Set<number>();
    for (;;) {
      let u = -1;
      let best = Infinity;
      for (let i = 0; i < dist.length; i++) if (!seen.has(i) && dist[i] < best) { best = dist[i]; u = i; }
      if (u < 0) break;
      seen.add(u);
      for (const p of network.paths) {
        const to = p.a === u ? p.b : p.b === u ? p.a : -1;
        if (to >= 0 && dist[u] + p.length < dist[to]) dist[to] = dist[u] + p.length;
      }
    }
    return dist;
  });

  map.nodes.forEach((node, ni) => {
    const exits = network.paths
      .map((p, pi) => ({ p, pi }))
      .filter(({ p }) => p.a === ni || p.b === ni);
    if (exits.length < 3) return; // signposts only at real junctions
    // collect plates: nearest town reachable via each exit (if it's on the shortest path)
    const plates: { text: string; yaw: number }[] = [];
    for (const { p } of exits) {
      const other = p.a === ni ? p.b : p.a;
      let bestTown = -1;
      let bestD = Infinity;
      map.towns.forEach((_, ti) => {
        if (ti === ni) return;
        const viaExit = p.length + townDist[ti][other];
        if (Math.abs(viaExit - townDist[ti][ni]) < 1 && townDist[ti][ni] < bestD && townDist[ti][ni] > 200) {
          bestD = townDist[ti][ni];
          bestTown = ti;
        }
      });
      if (bestTown >= 0 && plates.length < 4) {
        const s0 = p.a === ni ? p.samples[0] : p.samples[p.samples.length - 1];
        const sign = p.a === ni ? 1 : -1;
        plates.push({
          text: `${map.towns[bestTown].name}  ${(bestD / 1000).toFixed(0)}`,
          yaw: Math.atan2(s0.dirX * sign, s0.dirZ * sign),
        });
      }
    }
    if (plates.length === 0) return;
    const px = node.x + 9.5;
    const pz = node.z + 9.5;
    const y = terrain.height(px, pz);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 3.0, 6), POLE_MAT);
    pole.position.set(px, y + 1.5, pz);
    group.add(pole);
    plates.forEach((plate, i) => {
      const board = new THREE.Mesh(
        new THREE.PlaneGeometry(2.0, 0.42),
        new THREE.MeshStandardMaterial({ map: signTexture(plate.text, "dir"), side: THREE.DoubleSide, roughness: 0.7 })
      );
      // plate points along its road: rotate to be readable across it
      board.rotation.y = plate.yaw + Math.PI / 2;
      board.position.set(px, y + 2.85 - i * 0.5, pz);
      group.add(board);
    });
  });

  group.traverse((o) => (o.castShadow = true));
  return group;
}

// ====================================================================
// harbour: stone pier, fishing boats, buoys at the coastal town
// ====================================================================

function buildHarbour(map: MapData, terrain: Terrain, rand: () => number): THREE.Group {
  const group = new THREE.Group();
  group.name = "harbour";
  const town = map.towns[0];
  if (!town || town.x > map.coastX + 420) return group;

  const stone = new THREE.MeshStandardMaterial({ color: 0x9a917e, roughness: 0.9 });
  // pier from the beach out into the sea
  const pierLen = 150;
  const pierX0 = map.coastX + 55;
  const pier = new THREE.Mesh(new THREE.BoxGeometry(pierLen, 2.4, 7), stone);
  pier.position.set(pierX0 - pierLen / 2, 0.6, town.z);
  pier.castShadow = true;
  pier.receiveShadow = true;
  group.add(pier);
  // end platform + bollards
  const platform = new THREE.Mesh(new THREE.BoxGeometry(16, 2.6, 16), stone);
  platform.position.set(pierX0 - pierLen, 0.6, town.z);
  group.add(platform);
  const bollardMat = new THREE.MeshStandardMaterial({ color: 0x3a3a40, roughness: 0.5, metalness: 0.5 });
  for (let i = 0; i < 6; i++) {
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 0.5, 8), bollardMat);
    b.position.set(pierX0 - 18 - i * 24, 2.05, town.z + (i % 2 === 0 ? 2.9 : -2.9));
    group.add(b);
  }
  // lamp at the pier head
  const lampModel = buildModel("lamp");
  const lamp = new THREE.Mesh(lampModel.geo, BUILDING_MATERIAL);
  lamp.position.set(pierX0 - pierLen, 1.9, town.z + 5);
  group.add(lamp);
  if (lampModel.glow) {
    const lg = new THREE.Mesh(lampModel.glow, NIGHT_GLOW_MATERIAL);
    lg.position.copy(lamp.position);
    group.add(lg);
  }

  // fishing boats moored in the bay
  const HULLS = [0xc23b2e, 0x2a5d8f, 0xe8e4da, 0x2e7d4f, 0xd4842a];
  for (let i = 0; i < 7; i++) {
    const boat = new THREE.Group();
    const hullColor = HULLS[Math.floor(rand() * HULLS.length)];
    const hullMat = new THREE.MeshStandardMaterial({ color: hullColor, roughness: 0.55 });
    const hull = new THREE.Mesh(new THREE.BoxGeometry(4.2, 1.0, 1.7), hullMat);
    hull.position.y = 0.25;
    boat.add(hull);
    const bow = new THREE.Mesh(new THREE.ConeGeometry(0.85, 1.6, 4), hullMat);
    bow.rotation.z = -Math.PI / 2;
    bow.rotation.y = Math.PI / 4;
    bow.position.set(2.8, 0.25, 0);
    boat.add(bow);
    const deck = new THREE.Mesh(
      new THREE.BoxGeometry(3.6, 0.15, 1.3),
      new THREE.MeshStandardMaterial({ color: 0xb09467, roughness: 0.8 })
    );
    deck.position.y = 0.72;
    boat.add(deck);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.07, 3.4, 6), deck.material);
    mast.position.set(0.4, 2.2, 0);
    boat.add(mast);
    boat.position.set(
      map.coastX - 60 - rand() * 180,
      0.15,
      town.z + (rand() - 0.5) * 320
    );
    boat.rotation.y = rand() * Math.PI * 2;
    boat.rotation.z = (rand() - 0.5) * 0.04;
    boat.traverse((o) => (o.castShadow = true));
    // gentle bob + roll on the swell (animated by World.update)
    boat.userData.bob = { phase: rand() * 6.28, amp: 0.1 + rand() * 0.07, roll: 0.03 + rand() * 0.03 };
    group.add(boat);
  }

  // buoys
  const buoyMat = new THREE.MeshStandardMaterial({ color: 0xc23b2e, roughness: 0.5 });
  for (let i = 0; i < 8; i++) {
    const buoy = new THREE.Mesh(new THREE.SphereGeometry(0.45, 8, 6), buoyMat);
    buoy.position.set(map.coastX - 40 - rand() * 320, 0.25, town.z + (rand() - 0.5) * 600);
    buoy.userData.bob = { phase: rand() * 6.28, amp: 0.12 + rand() * 0.08, roll: 0 };
    group.add(buoy);
  }
  return group;
}

// ====================================================================
// lighthouse: a banded tower on the shore with a beam that sweeps at night
// (the pivot is tagged userData.beacon; World.update rotates it & fades the
//  beam in after dusk via the Environment's night amount)
// ====================================================================

function buildLighthouse(map: MapData, terrain: Terrain): THREE.Group {
  const group = new THREE.Group();
  group.name = "lighthouse";
  const town = map.towns[0];
  if (!town || town.x > map.coastX + 420) return group;

  const lx = map.coastX + 18;
  const lz = town.z - 150;
  const baseY = Math.max(0, terrain.height(lx, lz));

  // rocky outcrop it stands on
  const rock = new THREE.Mesh(
    new THREE.CylinderGeometry(6, 8.5, 3, 9),
    new THREE.MeshStandardMaterial({ color: 0x6f6a60, roughness: 1, flatShading: true })
  );
  rock.position.set(lx, baseY + 0.4, lz);
  rock.castShadow = rock.receiveShadow = true;
  group.add(rock);

  const baseTop = baseY + 1.8;
  const towerH = 24;
  const rBot = 3.4;
  const rTop = 2.4;
  const tower = new THREE.Mesh(
    new THREE.CylinderGeometry(rTop, rBot, towerH, 16),
    new THREE.MeshStandardMaterial({ color: 0xf3f0e8, roughness: 0.7 })
  );
  tower.position.set(lx, baseTop + towerH / 2, lz);
  tower.castShadow = true;
  group.add(tower);

  // red bands wrapped around the taper
  const redMat = new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.7 });
  for (let i = 0; i < 3; i++) {
    const f = 0.18 + i * 0.3; // fraction up the tower
    const rr = rBot + (rTop - rBot) * f;
    const band = new THREE.Mesh(new THREE.CylinderGeometry(rr + 0.06, rr + 0.06, 2.2, 16), redMat);
    band.position.set(lx, baseTop + towerH * f, lz);
    group.add(band);
  }

  // gallery ring + lantern cage
  const metal = new THREE.MeshStandardMaterial({ color: 0x33383d, roughness: 0.5, metalness: 0.4 });
  const gallery = new THREE.Mesh(new THREE.CylinderGeometry(3.0, 3.0, 0.8, 16), metal);
  gallery.position.set(lx, baseTop + towerH, lz);
  group.add(gallery);

  const lampY = baseTop + towerH + 2.0;
  const cage = new THREE.Mesh(new THREE.CylinderGeometry(2.0, 2.0, 3.2, 12, 1, true), metal);
  cage.position.set(lx, lampY, lz);
  group.add(cage);

  // the lamp itself - glows after dusk via the shared night-glow material
  const glow = new THREE.Mesh(new THREE.SphereGeometry(1.35, 12, 10), NIGHT_GLOW_MATERIAL);
  glow.position.set(lx, lampY, lz);
  group.add(glow);

  const roof = new THREE.Mesh(new THREE.ConeGeometry(2.4, 2.4, 12), new THREE.MeshStandardMaterial({ color: 0x2a2f34, roughness: 0.6 }));
  roof.position.set(lx, lampY + 2.6, lz);
  group.add(roof);

  // two opposite light beams on a pivot that World.update spins
  const beamGeo = new THREE.ConeGeometry(7, 130, 16, 1, true);
  beamGeo.translate(0, -65, 0); // apex at origin
  beamGeo.rotateZ(-Math.PI / 2); // lay it horizontal (points -X)
  const beamMat = new THREE.MeshBasicMaterial({
    color: 0xfff2c0,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    fog: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const pivot = new THREE.Group();
  pivot.position.set(lx, lampY, lz);
  pivot.userData.beacon = { speed: 0.6 };
  for (let s = 0; s < 2; s++) {
    const beam = new THREE.Mesh(beamGeo, beamMat);
    beam.rotation.y = s * Math.PI;
    pivot.add(beam);
  }
  group.add(pivot);

  return group;
}

// ====================================================================
// campanile: a stone bell tower at the main town, with a swinging bell
// (the bell pivot is tagged userData.swing; World.update rocks it)
// ====================================================================

function buildCampanile(map: MapData, terrain: Terrain): THREE.Group {
  const group = new THREE.Group();
  group.name = "campanile";
  if (!map.towns.length) return group;
  // the biggest town gets the tower; set it just off the piazza centre
  const town = map.towns.reduce((a, b) => (b.radius > a.radius ? b : a));
  const tx = town.x + 16;
  const tz = town.z + 10;
  const baseY = terrain.height(tx, tz);

  const stone = new THREE.MeshStandardMaterial({ color: 0xcabfa6, roughness: 0.9 });
  const shaftH = 24;
  const shaft = new THREE.Mesh(new THREE.BoxGeometry(4.6, shaftH, 4.6), stone);
  shaft.position.set(tx, baseY + shaftH / 2, tz);
  shaft.castShadow = shaft.receiveShadow = true;
  group.add(shaft);

  // belfry: a slightly wider stage with dark arched openings on each face
  const belfryY = baseY + shaftH + 2;
  const belfry = new THREE.Mesh(new THREE.BoxGeometry(5.2, 4, 5.2), stone);
  belfry.position.set(tx, belfryY, tz);
  belfry.castShadow = true;
  group.add(belfry);
  const dark = new THREE.MeshStandardMaterial({ color: 0x241f1b, roughness: 0.7 });
  for (let f = 0; f < 4; f++) {
    const a = (f / 4) * Math.PI * 2;
    const opening = new THREE.Mesh(new THREE.BoxGeometry(1.8, 2.6, 0.4), dark);
    opening.position.set(tx + Math.cos(a) * 2.55, belfryY + 0.2, tz + Math.sin(a) * 2.55);
    opening.rotation.y = a;
    group.add(opening);
  }

  // pyramidal cap + a small clock face
  const cap = new THREE.Mesh(
    new THREE.ConeGeometry(4.0, 3.6, 4),
    new THREE.MeshStandardMaterial({ color: 0x7a3b2a, roughness: 0.85 })
  );
  cap.position.set(tx, belfryY + 3.8, tz);
  cap.rotation.y = Math.PI / 4;
  cap.castShadow = true;
  group.add(cap);

  const clock = new THREE.Mesh(
    new THREE.CircleGeometry(1.1, 20),
    new THREE.MeshStandardMaterial({ color: 0xf2ead2, roughness: 0.8 })
  );
  clock.position.set(tx, baseY + shaftH - 3, tz + 2.34);
  group.add(clock);
  for (let h = 0; h < 2; h++) {
    const hand = new THREE.Mesh(new THREE.BoxGeometry(0.12, h === 0 ? 0.8 : 0.55, 0.05), dark);
    hand.position.set(tx, baseY + shaftH - 3, tz + 2.36);
    hand.rotation.z = h === 0 ? 0.6 : -1.9;
    group.add(hand);
  }

  // the bell, hung in the belfry. It idles with a gentle World-driven sway
  // (userData.swing); the main-loop carillon overrides it with a hard swing
  // during a peal. Named so the carillon can find it after every rebuild.
  const pivot = new THREE.Group();
  pivot.name = "bell";
  pivot.position.set(tx, belfryY + 1.6, tz);
  pivot.userData.swing = { axis: "x", amp: 0.08, speed: 1.0, phase: 0 };
  const bellMat = new THREE.MeshStandardMaterial({ color: 0x6e5a22, roughness: 0.45, metalness: 0.7 });
  const bell = new THREE.Mesh(new THREE.ConeGeometry(0.8, 1.5, 14), bellMat);
  bell.position.y = -1.6;
  pivot.add(bell);
  const crown = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 6), bellMat);
  crown.position.y = -0.85;
  pivot.add(crown);
  group.add(pivot);

  return group;
}

// ====================================================================
// windmill: a stone tower on a hill with sails that turn (userData.spin,
// rotated each frame by World.update)
// ====================================================================

function buildWindmill(
  map: MapData,
  terrain: Terrain,
  blocked: (x: number, z: number, margin?: number) => boolean,
  inTown: (x: number, z: number, extra?: number) => boolean
): THREE.Group {
  const group = new THREE.Group();
  group.name = "windmill";
  const rand = mulberry32(((map.seed ?? 12345) ^ 0x5151) >>> 0);
  const half = map.size / 2;

  // pick the highest clear spot among a few inland candidates (a hilltop)
  let best: { x: number; z: number } | null = null;
  let bestH = -1e9;
  for (let i = 0; i < 40; i++) {
    const x = map.coastX + 1200 + rand() * Math.max(200, half - map.coastX - 1300);
    const z = -half + 200 + rand() * (map.size - 400);
    if (blocked(x, z, 16) || inTown(x, z, 70)) continue;
    const h = terrain.height(x, z);
    if (h > bestH) {
      bestH = h;
      best = { x, z };
    }
  }
  if (!best) return group;

  const baseY = terrain.height(best.x, best.z);
  group.position.set(best.x, baseY, best.z);
  group.rotation.y = rand() * Math.PI * 2; // face a random way

  const stone = new THREE.MeshStandardMaterial({ color: 0xd8cdb6, roughness: 0.9 });
  const tower = new THREE.Mesh(new THREE.CylinderGeometry(2.8, 4.0, 12, 16), stone);
  tower.position.y = 6;
  tower.castShadow = tower.receiveShadow = true;
  group.add(tower);

  const roof = new THREE.Mesh(
    new THREE.ConeGeometry(3.4, 3.2, 16),
    new THREE.MeshStandardMaterial({ color: 0x6b4a2a, roughness: 0.8 })
  );
  roof.position.y = 13.4;
  roof.castShadow = true;
  group.add(roof);

  // a couple of small windows
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a2622, roughness: 0.7 });
  for (let i = 0; i < 3; i++) {
    const w = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.3, 0.3), dark);
    const a = (i / 3) * Math.PI * 2 + 0.5;
    w.position.set(Math.cos(a) * 3.4, 5 + i * 2.2, Math.sin(a) * 3.4);
    w.lookAt(w.position.x * 2, w.position.y, w.position.z * 2);
    group.add(w);
  }

  // sail assembly on a pivot at the front of the cap (axle along +X)
  const pivot = new THREE.Group();
  pivot.position.set(3.6, 11.5, 0);
  pivot.userData.spin = { axis: "x", speed: 0.5 };
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.45, 1.2, 10), dark);
  hub.rotation.z = Math.PI / 2; // axle along X
  pivot.add(hub);

  const sparMat = new THREE.MeshStandardMaterial({ color: 0x5a3f24, roughness: 0.8 });
  const clothMat = new THREE.MeshStandardMaterial({ color: 0xeae4d2, roughness: 0.85, side: THREE.DoubleSide });
  for (let k = 0; k < 4; k++) {
    const arm = new THREE.Group();
    arm.rotation.x = (k * Math.PI) / 2; // sails rotate in the Y-Z plane
    const spar = new THREE.Mesh(new THREE.BoxGeometry(0.22, 7.2, 0.22), sparMat);
    spar.position.y = 3.7;
    arm.add(spar);
    const cloth = new THREE.Mesh(new THREE.BoxGeometry(0.08, 6.2, 1.3), clothMat);
    cloth.position.set(0, 3.7, 0.85);
    arm.add(cloth);
    pivot.add(arm);
  }
  group.add(pivot);

  return group;
}

// ====================================================================
// animals: sheep flocks and cattle on the pastures
// ====================================================================

function buildAnimals(
  map: MapData,
  terrain: Terrain,
  rand: () => number,
  blocked: (x: number, z: number, m?: number) => boolean,
  inTown: (x: number, z: number, e?: number) => boolean
): THREE.Group {
  const group = new THREE.Group();
  group.name = "animals";
  const half = map.size / 2 - 100;

  const sheepGeo = (() => {
    const body = new THREE.IcosahedronGeometry(0.55, 1);
    body.scale(1.25, 0.9, 0.9);
    body.translate(0, 0.75, 0);
    const head = new THREE.IcosahedronGeometry(0.2, 1);
    head.translate(0.72, 0.72, 0);
    const geos = [colorGeo(body, 0xe8e3d8), colorGeo(head, 0x3a332c)];
    for (const [lx, lz] of [[0.35, 0.22], [0.35, -0.22], [-0.35, 0.22], [-0.35, -0.22]]) {
      const leg = new THREE.CylinderGeometry(0.05, 0.05, 0.45, 5);
      leg.translate(lx, 0.22, lz);
      geos.push(colorGeo(leg, 0x3a332c));
    }
    return mergeGeometries(geos.map((g) => (g.index ? g.toNonIndexed() : g)))!;
  })();

  const cowGeo = (() => {
    const body = new THREE.BoxGeometry(1.9, 1.0, 0.95);
    body.translate(0, 1.05, 0);
    const head = new THREE.BoxGeometry(0.55, 0.5, 0.45);
    head.translate(1.15, 1.25, 0);
    const geos = [colorGeo(body, 0xa97c50), colorGeo(head, 0x8a6342)];
    for (const [lx, lz] of [[0.7, 0.3], [0.7, -0.3], [-0.7, 0.3], [-0.7, -0.3]]) {
      const leg = new THREE.CylinderGeometry(0.09, 0.09, 0.6, 5);
      leg.translate(lx, 0.3, lz);
      geos.push(colorGeo(leg, 0x6e4f33));
    }
    return mergeGeometries(geos.map((g) => (g.index ? g.toNonIndexed() : g)))!;
  })();

  const sheepSpots: { x: number; z: number; rot: number; s: number }[] = [];
  const cowSpots: { x: number; z: number; rot: number; s: number }[] = [];
  for (let x = -half; x < half; x += 55) {
    for (let z = -half; z < half; z += 55) {
      if (rand() > 0.045) continue;
      const cx = x + (rand() - 0.5) * 30;
      const cz = z + (rand() - 0.5) * 30;
      if (cx < map.coastX + 150 || inTown(cx, cz, 40) || blocked(cx, cz, 18)) continue;
      if (terrain.fieldKind(cx, cz) !== "pasture") continue;
      const cows = rand() < 0.3;
      const count = cows ? 3 + Math.floor(rand() * 3) : 5 + Math.floor(rand() * 5);
      for (let i = 0; i < count; i++) {
        const px = cx + (rand() - 0.5) * 26;
        const pz = cz + (rand() - 0.5) * 26;
        if (blocked(px, pz, 8)) continue;
        (cows ? cowSpots : sheepSpots).push({ x: px, z: pz, rot: rand() * 6.28, s: 0.85 + rand() * 0.3 });
      }
    }
  }

  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
  const dummy = new THREE.Object3D();
  for (const [geo, spots] of [
    [sheepGeo, sheepSpots],
    [cowGeo, cowSpots],
  ] as const) {
    if (spots.length === 0) continue;
    const inst = new THREE.InstancedMesh(geo, mat, spots.length);
    spots.forEach((p, i) => {
      dummy.position.set(p.x, terrain.height(p.x, p.z), p.z);
      dummy.rotation.set(0, p.rot, 0);
      dummy.scale.setScalar(p.s);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
    });
    inst.castShadow = true;
    group.add(inst);
  }
  return group;
}

function colorGeo(geo: THREE.BufferGeometry, color: number): THREE.BufferGeometry {
  const c = new THREE.Color(color);
  const count = geo.attributes.position.count;
  const arr = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  return geo;
}

// ====================================================================
// hay bales on the wheat stubble (summer & autumn)
// ====================================================================

function buildHayBales(
  map: MapData,
  terrain: Terrain,
  rand: () => number,
  blocked: (x: number, z: number, m?: number) => boolean,
  inTown: (x: number, z: number, e?: number) => boolean
): THREE.Group {
  const group = new THREE.Group();
  group.name = "hay";
  if (terrain.season !== "summer" && terrain.season !== "autumn") return group;
  const half = map.size / 2 - 100;
  const spots: { x: number; z: number; rot: number }[] = [];
  for (let x = -half; x < half; x += 42) {
    for (let z = -half; z < half; z += 42) {
      if (rand() > 0.16) continue;
      const px = x + (rand() - 0.5) * 30;
      const pz = z + (rand() - 0.5) * 30;
      if (px < map.coastX + 150 || inTown(px, pz, 30) || blocked(px, pz, 12)) continue;
      if (terrain.fieldKind(px, pz) !== "wheat") continue;
      spots.push({ x: px, z: pz, rot: rand() * 6.28 });
    }
  }
  if (spots.length === 0) return group;
  const geo = new THREE.CylinderGeometry(1.05, 1.05, 1.6, 12);
  geo.rotateZ(Math.PI / 2);
  geo.translate(0, 1.05, 0);
  const mat = new THREE.MeshStandardMaterial({ color: 0xc9a85c, roughness: 1 });
  const inst = new THREE.InstancedMesh(geo, mat, spots.length);
  const dummy = new THREE.Object3D();
  spots.forEach((p, i) => {
    dummy.position.set(p.x, terrain.height(p.x, p.z) - 0.05, p.z);
    dummy.rotation.set(0, p.rot, 0);
    dummy.updateMatrix();
    inst.setMatrixAt(i, dummy.matrix);
  });
  inst.castShadow = true;
  group.add(inst);
  return group;
}

// ====================================================================
// sunflower fields (spring & summer) - the quintessential Tuscan crop
// ====================================================================

/** One low-poly sunflower: green stalk + two leaves + a sun-facing head. */
function sunflowerGeo(): THREE.BufferGeometry {
  const STALK = 0x53702a;
  const LEAF = 0x3f6322;
  const PETAL = 0xf4c20a;
  const CORE = 0x5a3a1c;
  const parts: THREE.BufferGeometry[] = [];

  const stalk = new THREE.CylinderGeometry(0.03, 0.055, 1.65, 5);
  stalk.translate(0, 0.82, 0);
  parts.push(colorGeo(stalk, STALK));

  for (let l = 0; l < 2; l++) {
    const ang = l === 0 ? 0.7 : -0.8;
    const leaf = new THREE.SphereGeometry(0.17, 5, 4);
    leaf.scale(1.8, 0.16, 0.7);
    leaf.translate(0.24, 0, 0);
    leaf.rotateY(ang);
    leaf.translate(0, 0.6 + l * 0.36, 0);
    parts.push(colorGeo(leaf, LEAF));
  }

  // head built facing +Z, then tilted up and lifted onto the stalk
  const head: THREE.BufferGeometry[] = [];
  const core = new THREE.CylinderGeometry(0.2, 0.2, 0.08, 14);
  core.rotateX(Math.PI / 2); // disc faces +Z
  head.push(colorGeo(core, CORE));
  const petalCount = 14;
  for (let k = 0; k < petalCount; k++) {
    const a = (k / petalCount) * Math.PI * 2;
    const petal = new THREE.BoxGeometry(0.09, 0.22, 0.03);
    petal.translate(0, 0.27, 0.02);
    petal.rotateZ(a);
    head.push(colorGeo(petal, PETAL));
  }
  const headGeo = mergeGeometries(head.map((g) => g.toNonIndexed()))!;
  headGeo.rotateX(-0.35); // tilt the face skyward
  headGeo.translate(0, 1.6, 0.12);
  parts.push(headGeo);

  return mergeGeometries(parts.map((g) => g.toNonIndexed()))!;
}

function buildSunflowers(
  map: MapData,
  terrain: Terrain,
  rand: () => number,
  blocked: (x: number, z: number, m?: number) => boolean,
  inTown: (x: number, z: number, e?: number) => boolean
): THREE.Group {
  const group = new THREE.Group();
  group.name = "sunflowers";
  if (terrain.season !== "summer" && terrain.season !== "spring") return group;

  const half = map.size / 2 - 100;
  const placements: { x: number; z: number; rot: number; s: number }[] = [];
  const CAP = 5000;

  // scatter rectangular patches of rows across the wheat/plowed fields
  for (let x = -half; x < half && placements.length < CAP; x += 120) {
    for (let z = -half; z < half && placements.length < CAP; z += 120) {
      const cx = x + (rand() - 0.5) * 90;
      const cz = z + (rand() - 0.5) * 90;
      if (cx < map.coastX + 170 || inTown(cx, cz, 45)) continue;
      const fk = terrain.fieldKind(cx, cz);
      if (fk !== "wheat" && fk !== "plowed") continue;
      if (rand() > 0.34) continue; // not every eligible field is in bloom
      const rows = 6 + Math.floor(rand() * 6);
      const cols = 7 + Math.floor(rand() * 8);
      const spacing = 1.5;
      const pang = rand() * Math.PI * 2;
      const ca = Math.cos(pang);
      const sa = Math.sin(pang);
      // whole field faces the morning sun (roughly east), tiny per-patch variance
      const faceYaw = Math.PI / 2 + (rand() - 0.5) * 0.5;
      for (let r = 0; r < rows && placements.length < CAP; r++) {
        for (let c = 0; c < cols; c++) {
          const lx = (c - cols / 2) * spacing + (rand() - 0.5) * 0.5;
          const lz = (r - rows / 2) * spacing + (rand() - 0.5) * 0.5;
          const px = cx + lx * ca - lz * sa;
          const pz = cz + lx * sa + lz * ca;
          if (px < map.coastX + 130 || inTown(px, pz, 25) || blocked(px, pz, 8)) continue;
          if (terrain.fieldKind(px, pz) !== fk) continue; // keep the patch within one field
          placements.push({ x: px, z: pz, rot: faceYaw + (rand() - 0.5) * 0.3, s: 0.85 + rand() * 0.4 });
        }
      }
    }
  }
  if (placements.length === 0) return group;

  const inst = new THREE.InstancedMesh(
    sunflowerGeo(),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }),
    placements.length
  );
  inst.name = "sunflowers";
  const dummy = new THREE.Object3D();
  placements.forEach((p, i) => {
    dummy.position.set(p.x, terrain.height(p.x, p.z) - 0.05, p.z);
    dummy.rotation.set(0, p.rot, 0);
    dummy.scale.setScalar(p.s);
    dummy.updateMatrix();
    inst.setMatrixAt(i, dummy.matrix);
  });
  // tens of thousands of tris - skip shadows like the grass tufts do
  inst.castShadow = false;
  inst.receiveShadow = false;
  group.add(inst);
  return group;
}

// ====================================================================
// telegraph poles + sagging wires along the main roads
// ====================================================================

function buildTelegraphPoles(terrain: Terrain, network: RoadNetwork, rand: () => number): THREE.Group {
  const group = new THREE.Group();
  group.name = "telegraph";

  const poleGeo = (() => {
    const post = new THREE.CylinderGeometry(0.09, 0.12, 7.2, 6);
    post.translate(0, 3.6, 0);
    const arm = new THREE.BoxGeometry(1.3, 0.1, 0.1);
    arm.translate(0, 6.7, 0);
    return mergeGeometries([colorGeo(post, 0x6b5236), colorGeo(arm, 0x5a4429)].map((g) => g.toNonIndexed()))!;
  })();
  const poleMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });

  const positions: { x: number; y: number; z: number }[] = [];
  const wireVerts: number[] = [];

  for (const path of network.paths) {
    if (path.kind !== "main" || path.length < 120) continue;
    if (rand() < 0.25) continue; // not every road has a line
    let prevTop: THREE.Vector3 | null = null;
    for (let d = 20; d < path.length - 20; d += 38) {
      // walk samples to distance d
      let i = 0;
      while (i < path.samples.length - 1 && path.samples[i].dist < d) i++;
      const s = path.samples[i];
      const px = s.x - s.dirZ * -(path.half + 3.4); // left side, consistent
      const pz = s.z + s.dirX * -(path.half + 3.4);
      const py = terrain.height(px, pz);
      positions.push({ x: px, y: py, z: pz });
      const top = new THREE.Vector3(px, py + 6.7, pz);
      if (prevTop && prevTop.distanceTo(top) < 55) {
        // sagging wire: two segments with a dip in the middle
        const mid = prevTop.clone().lerp(top, 0.5);
        mid.y -= 0.55;
        wireVerts.push(prevTop.x, prevTop.y, prevTop.z, mid.x, mid.y, mid.z);
        wireVerts.push(mid.x, mid.y, mid.z, top.x, top.y, top.z);
      }
      prevTop = top;
    }
  }

  if (positions.length) {
    const inst = new THREE.InstancedMesh(poleGeo, poleMat, positions.length);
    const dummy = new THREE.Object3D();
    positions.forEach((p, i) => {
      dummy.position.set(p.x, p.y, p.z);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
    });
    inst.castShadow = true;
    group.add(inst);
  }
  if (wireVerts.length) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(wireVerts, 3));
    const wires = new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({ color: 0x1c1c1c, transparent: true, opacity: 0.75 })
    );
    group.add(wires);
  }
  return group;
}

/**
 * Dense instanced grass tufts along the roadsides (where the rider actually
 * looks), tinted to match the underlying field. Two crossed alpha-tested
 * quads per tuft - tens of thousands render fine as one InstancedMesh.
 */
function buildGrass(map: MapData, terrain: Terrain, rand: () => number): THREE.InstancedMesh | null {
  const samples = terrain.getRoadSamples();
  if (samples.length === 0) return null;

  const placements: { x: number; z: number; s: number; tint: THREE.Color }[] = [];
  const cap = terrain.season === "winter" ? 30000 : 60000;
  const pal = {
    spring: { green: [0.36, 0.56, 0.24], gold: [0.5, 0.6, 0.3], dry: [0.42, 0.58, 0.26] },
    summer: { green: [0.42, 0.55, 0.28], gold: [0.72, 0.62, 0.34], dry: [0.55, 0.55, 0.3] },
    autumn: { green: [0.46, 0.48, 0.26], gold: [0.6, 0.5, 0.3], dry: [0.52, 0.46, 0.28] },
    winter: { green: [0.46, 0.5, 0.34], gold: [0.5, 0.48, 0.36], dry: [0.48, 0.48, 0.36] },
  }[terrain.season];
  const green = new THREE.Color(...(pal.green as [number, number, number]));
  const gold = new THREE.Color(...(pal.gold as [number, number, number]));
  const dry = new THREE.Color(...(pal.dry as [number, number, number]));
  for (let i = 0; i < samples.length && placements.length < cap; i += 2) {
    const s = samples[i];
    for (let k = 0; k < 3; k++) {
      const side = rand() < 0.5 ? 1 : -1;
      const off = 5 + Math.pow(rand(), 1.6) * 42; // denser near the verge
      const x = s.x - s.dirZ * off * side + (rand() - 0.5) * 6;
      const z = s.z + s.dirX * off * side + (rand() - 0.5) * 6;
      if (x < map.coastX + 40) continue;
      if (map.towns.some((t) => Math.hypot(x - t.x, z - t.z) < t.radius)) continue;
      const near = terrain.nearestRoad(x, z, 5);
      if (near && near.dist < 4.5) continue; // not on the asphalt
      const kind = terrain.fieldKind(x, z);
      const base = off < 11 ? green : kind === "wheat" ? gold : kind === "pasture" ? dry : green;
      const tint = base.clone().multiplyScalar(1.25 + rand() * 0.55);
      placements.push({ x, z, s: 0.6 + rand() * 0.8, tint });
    }
  }
  if (placements.length === 0) return null;

  // crossed quads, anchored at the ground
  const quad1 = new THREE.PlaneGeometry(1.1, 0.65);
  quad1.translate(0, 0.3, 0);
  const quad2 = quad1.clone();
  quad2.rotateY(Math.PI / 2);
  const geo = mergeGeometries([quad1, quad2])!;
  const mat = new THREE.MeshLambertMaterial({
    map: buildGrassTexture(),
    alphaTest: 0.45,
    side: THREE.DoubleSide,
  });
  const inst = new THREE.InstancedMesh(geo, mat, placements.length);
  inst.name = "inst-grass";
  const dummy = new THREE.Object3D();
  placements.forEach((p, i) => {
    dummy.position.set(p.x, terrain.height(p.x, p.z) - 0.04, p.z);
    dummy.rotation.set(0, rand() * Math.PI, 0);
    dummy.scale.setScalar(p.s);
    dummy.updateMatrix();
    inst.setMatrixAt(i, dummy.matrix);
    inst.setColorAt(i, p.tint);
  });
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  return inst;
}

/** Painted grass-blade sprite (transparent background, alpha-tested). */
function buildGrassTexture(): THREE.CanvasTexture {
  const W = 128;
  const H = 96;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, W, H);
  for (let b = 0; b < 26; b++) {
    const x0 = 6 + Math.random() * (W - 12);
    const lean = (Math.random() - 0.5) * 26;
    const h = 30 + Math.random() * 60;
    const g = 110 + Math.random() * 90;
    ctx.strokeStyle = `rgb(${g * 0.55}, ${g}, ${g * 0.4})`;
    ctx.lineWidth = 2.5 + Math.random() * 2;
    ctx.beginPath();
    ctx.moveTo(x0, H);
    ctx.quadraticCurveTo(x0 + lean * 0.3, H - h * 0.6, x0 + lean, H - h);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildTown(
  town: { x: number; z: number; radius: number },
  terrain: Terrain,
  rand: () => number,
  put: (t: SceneryType, p: Placement) => void,
  blocked: (x: number, z: number, m?: number) => boolean
): void {
  const { x: tx, z: tz, radius } = town;

  // church on the piazza, slightly off-center (villages get one too - it's Italy)
  const churchAngle = rand() * 6.28;
  const cx = tx + Math.cos(churchAngle) * radius * 0.3;
  const cz = tz + Math.sin(churchAngle) * radius * 0.3;
  if (!blocked(cx, cz, 17)) put("church", { x: cx, z: cz, rot: churchAngle + Math.PI, scale: radius > 110 ? 1 : 0.8 });

  // ---------- piazza life: fountain, statue, market, benches ----------
  // fountain near the center (kept off the through-roads)
  const fa = churchAngle + Math.PI * (0.6 + rand() * 0.8);
  const fx = tx + Math.cos(fa) * 16;
  const fz = tz + Math.sin(fa) * 16;
  if (!blocked(fx, fz, 7)) put("fountain", { x: fx, z: fz, rot: rand() * 6.28, scale: radius > 140 ? 1.1 : 0.85 });

  // statue for the bigger towns
  if (radius > 130) {
    const sa = fa + Math.PI * 0.5;
    const sx = tx + Math.cos(sa) * 24;
    const sz = tz + Math.sin(sa) * 24;
    if (!blocked(sx, sz, 5)) put("statue", { x: sx, z: sz, rot: sa + Math.PI, scale: 1 });
  }

  // market: rows of striped stalls on the piazza of larger towns
  if (radius > 120) {
    const ma = fa + Math.PI; // market square opposite the fountain
    const mcx = tx + Math.cos(ma) * 34;
    const mcz = tz + Math.sin(ma) * 34;
    const rows = radius > 160 ? 3 : 2;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < 3; col++) {
        const ox = (col - 1) * 7;
        const oz = (row - (rows - 1) / 2) * 8;
        const x = mcx + Math.cos(ma) * oz - Math.sin(ma) * ox;
        const z = mcz + Math.sin(ma) * oz + Math.cos(ma) * ox;
        if (!blocked(x, z, 6) && rand() < 0.85) {
          put("stall", { x, z, rot: ma + Math.PI / 2, scale: 0.95 + rand() * 0.15 });
        }
      }
    }
  }

  // benches around the piazza
  for (let b = 0; b < Math.round(radius / 30); b++) {
    const ba = rand() * 6.28;
    const br = 20 + rand() * 14;
    const bx = tx + Math.cos(ba) * br;
    const bz = tz + Math.sin(ba) * br;
    if (!blocked(bx, bz, 5)) put("bench", { x: bx, z: bz, rot: ba + Math.PI / 2, scale: 1 });
  }

  // houses in rough rings around the center - dense italian old town
  const rings = Math.max(2, Math.round(radius / 38));
  for (let ring = 1; ring <= rings; ring++) {
    const r = (radius * 0.92 * ring) / rings;
    const count = Math.round((2 * Math.PI * r) / 16);
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + rand() * 0.18 + ring * 0.45;
      const hr = r + (rand() - 0.5) * 9;
      const hx = tx + Math.cos(a) * hr;
      const hz = tz + Math.sin(a) * hr;
      if (Math.hypot(hx - cx, hz - cz) < 18) continue; // keep the piazza clear
      if (blocked(hx, hz, 10)) continue;
      if (rand() < 0.88) {
        put("house", { x: hx, z: hz, rot: a + Math.PI / 2 + (rand() - 0.5) * 0.2, scale: 0.85 + rand() * 0.3 });
      }
    }
  }

  // a watchtower at the edge of the larger towns
  if (radius > 110 && rand() < 0.8) {
    const ta = rand() * 6.28;
    const wx = tx + Math.cos(ta) * radius * 1.05;
    const wz = tz + Math.sin(ta) * radius * 1.05;
    if (!blocked(wx, wz, 10)) put("tower", { x: wx, z: wz, rot: ta, scale: 1 });
  }
}

export type TimeOfDay = "morning" | "noon" | "afternoon" | "sunset" | "night" | "cycle";

const TIME_PRESETS: Record<Exclude<TimeOfDay, "cycle">, { el: number; az: number }> = {
  morning: { el: 22, az: 118 },
  noon: { el: 56, az: 190 },
  afternoon: { el: 38, az: 245 },
  sunset: { el: 7, az: 254 },
  night: { el: -18, az: 300 },
};

const CYCLE_DAY_SECONDS = 480; // full day/night in 8 minutes

/**
 * Atmosphere & lighting: physical sky shader (also used as environment map
 * for PBR ambient), sun/moon with soft shadows that follow the rider,
 * reflective animated sea, distance haze. Supports fixed times of day and
 * an animated day/night cycle.
 */
export class Environment {
  private scene: THREE.Scene;
  private map: MapData;
  private sky: Sky;
  private envSky: Sky;
  private envScene: THREE.Scene;
  private pmrem: THREE.PMREMGenerator;
  private sun: THREE.DirectionalLight;
  private fill: THREE.HemisphereLight;
  private water: Water;
  private sunDir = new THREE.Vector3(0, 1, 0);
  private mode: TimeOfDay = "afternoon";
  private lastEnvMapAt = -999;
  private envDirty = true;
  /** true while the scene is moonlit (riders switch their lamps on) */
  isNight = false;

  /** 0 in daylight .. 1 deep night; drives stars, moon and the lighthouse beam */
  get nightAmount(): number {
    return this.starBase;
  }

  constructor(map: MapData, scene: THREE.Scene, renderer: THREE.WebGLRenderer) {
    this.scene = scene;
    this.map = map;

    this.sky = new Sky();
    this.sky.scale.setScalar(20000);
    const u = this.sky.material.uniforms;
    u.turbidity.value = 4;
    u.rayleigh.value = 2.0;
    u.mieCoefficient.value = 0.004;
    u.mieDirectionalG.value = 0.85;
    scene.add(this.sky);

    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envScene = new THREE.Scene();
    this.envSky = new Sky();
    this.envSky.scale.setScalar(20000);
    this.envSky.material.uniforms.turbidity.value = 6;
    this.envSky.material.uniforms.rayleigh.value = 1.6;
    this.envScene.add(this.envSky);

    scene.fog = new THREE.Fog(0xc9d9e6, 700, map.size * 1.9);

    this.sun = new THREE.DirectionalLight(0xfff0dc, 3.0);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const ext = 260;
    this.sun.shadow.camera.left = -ext;
    this.sun.shadow.camera.right = ext;
    this.sun.shadow.camera.top = ext;
    this.sun.shadow.camera.bottom = -ext;
    this.sun.shadow.camera.near = 50;
    this.sun.shadow.camera.far = 1600;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.5;
    this.sun.shadow.camera.updateProjectionMatrix();
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.fill = new THREE.HemisphereLight(0xbfd4ea, 0x8a7a55, 0.22);
    scene.add(this.fill);

    const waterGeo = new THREE.PlaneGeometry(map.size * 2.2, map.size * 2.2);
    this.water = new Water(waterGeo, {
      textureWidth: 512,
      textureHeight: 512,
      waterNormals: buildWaterNormals(),
      sunDirection: new THREE.Vector3(0, 1, 0),
      sunColor: 0xfff0dc,
      waterColor: 0x07273a,
      distortionScale: 2.0,
      fog: true,
    });
    this.water.rotation.x = -Math.PI / 2;
    this.water.position.y = 0.0;
    this.water.name = "sea";
    scene.add(this.water);

    this.buildHorizonHills();
    this.buildBirds();
    this.buildBalloons();
    this.buildShoreFoam();
    this.buildSeaBoats();
    this.buildStars();
    this.buildMoon();
    this.buildMeteor();
    this.buildClouds();
    this.buildFireflies();

    this.applySun(TIME_PRESETS.afternoon.el, TIME_PRESETS.afternoon.az);
  }

  /** Hazy hill silhouettes beyond the map edge - no more empty horizon. */
  private buildHorizonHills(): void {
    const n = new Noise2D(777);
    const SEGS = 160;
    const rInner = this.map.size * 0.78;
    const verts: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= SEGS; i++) {
      const a = (i / SEGS) * Math.PI * 2;
      const x = Math.cos(a);
      const z = Math.sin(a);
      // sea sits west (-x): keep that horizon flat, raise the land side
      const landness = smoothstep(-0.55, 0.15, x);
      const h = (40 + (n.fbm(Math.cos(a) * 2.2, Math.sin(a) * 2.2, 3) * 0.5 + 0.5) * 150) * landness;
      verts.push(x * rInner, -20, z * rInner);
      verts.push(x * (rInner + 1200), h, z * (rInner + 1200));
      if (i < SEGS) {
        const k = i * 2;
        idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mat = new THREE.MeshLambertMaterial({ color: 0x8a97a0, side: THREE.DoubleSide, fog: true });
    const hills = new THREE.Mesh(geo, mat);
    hills.name = "horizon-hills";
    this.scene.add(hills);
  }

  // ---------- birds: small flocks circling over the landscape ----------
  private flocks: { group: THREE.Group; cx: number; cz: number; r: number; h: number; speed: number; phase: number }[] = [];

  private buildBirds(): void {
    const rand = mulberry32(909);
    // simple "V" silhouette
    const birdGeo = new THREE.BufferGeometry();
    birdGeo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(
        [0, 0, 0, -0.6, 0.18, 0.5, 0, 0, 0.18, 0, 0, 0, -0.6, 0.18, -0.5, 0, 0, -0.18],
        3
      )
    );
    birdGeo.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({ color: 0x1f242b, side: THREE.DoubleSide });
    for (let f = 0; f < 3; f++) {
      const group = new THREE.Group();
      const count = 7 + Math.floor(rand() * 5);
      for (let b = 0; b < count; b++) {
        const bird = new THREE.Mesh(birdGeo, mat);
        bird.position.set((rand() - 0.5) * 40, (rand() - 0.5) * 8, (rand() - 0.5) * 40);
        bird.scale.setScalar(1.6 + rand());
        group.add(bird);
      }
      this.scene.add(group);
      this.flocks.push({
        group,
        cx: (rand() - 0.5) * this.map.size * 0.7,
        cz: (rand() - 0.5) * this.map.size * 0.7,
        r: 180 + rand() * 320,
        h: 70 + rand() * 90,
        speed: 0.03 + rand() * 0.025,
        phase: rand() * 6.28,
      });
    }
  }

  // ---------- hot-air balloons drifting over the valley ----------
  private balloons: { group: THREE.Group; cx: number; cz: number; r: number; h: number; speed: number; phase: number; bob: number }[] = [];

  private buildBalloons(): void {
    const rand = mulberry32(424242);
    const PALETTES: [number, number][] = [
      [0xd23b3b, 0xf4f0e8],
      [0x2f6fb0, 0xf4c20a],
      [0x2e7d4f, 0xf4f0e8],
      [0xe07b1a, 0x8a2b8f],
      [0xc0392b, 0x2f6fb0],
    ];

    // teardrop envelope profile (bottom -> top), reused for every balloon
    const R = 9;
    const H = 13;
    const steps = 14;
    const profile: THREE.Vector2[] = [];
    for (let s = 0; s <= steps; s++) {
      const tt = s / steps;
      const rr = Math.pow(Math.sin(tt * Math.PI * 0.92 + 0.04), 0.6) * R;
      profile.push(new THREE.Vector2(Math.max(0.02, rr), tt * H));
    }
    const gores = 12;

    for (let i = 0; i < 3; i++) {
      const g = new THREE.Group();
      const [c0, c1] = PALETTES[Math.floor(rand() * PALETTES.length)];
      const lathe = new THREE.LatheGeometry(profile, gores);
      // colour alternating gores for the classic striped envelope
      const pos = lathe.attributes.position;
      const colors = new Float32Array(pos.count * 3);
      const cA = new THREE.Color(c0);
      const cB = new THREE.Color(c1);
      const perLine = steps + 1;
      for (let li = 0; li <= gores; li++) {
        const c = li % 2 === 0 ? cA : cB;
        for (let si = 0; si < perLine; si++) {
          const idx = li * perLine + si;
          colors[idx * 3] = c.r;
          colors[idx * 3 + 1] = c.g;
          colors[idx * 3 + 2] = c.b;
        }
      }
      lathe.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      const env = new THREE.Mesh(
        lathe,
        new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.0, side: THREE.DoubleSide })
      );
      g.add(env);

      const basket = new THREE.Mesh(
        new THREE.BoxGeometry(2.2, 1.9, 2.2),
        new THREE.MeshStandardMaterial({ color: 0x6b4a26, roughness: 0.95 })
      );
      basket.position.y = -3.4;
      g.add(basket);

      // suspension ropes from basket corners up to the envelope skirt
      const rv: number[] = [];
      for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as [number, number][]) {
        rv.push(sx * 0.95, -2.4, sz * 0.95, sx * R * 0.42, 0.5, sz * R * 0.42);
      }
      const ropeGeo = new THREE.BufferGeometry();
      ropeGeo.setAttribute("position", new THREE.Float32BufferAttribute(rv, 3));
      g.add(new THREE.LineSegments(ropeGeo, new THREE.LineBasicMaterial({ color: 0x2a2a2a })));

      this.scene.add(g);
      this.balloons.push({
        group: g,
        cx: (rand() - 0.5) * this.map.size * 0.5,
        cz: (rand() - 0.5) * this.map.size * 0.5,
        r: 280 + rand() * 520,
        h: 150 + rand() * 120,
        speed: 0.006 + rand() * 0.006,
        phase: rand() * 6.28,
        bob: rand() * 6.28,
      });
    }
  }

  // ---------- surf: lacy foam washing along the shoreline ----------
  private shoreFoam: THREE.Mesh | null = null;
  private foamTex: THREE.Texture | null = null;

  private buildShoreFoam(): void {
    const len = this.map.size * 1.05;
    const geo = new THREE.PlaneGeometry(40, len);
    const tex = buildFoamTexture();
    tex.repeat.set(1, Math.max(8, Math.round(len / 70)));
    this.foamTex = tex;
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
      opacity: 0.78,
      fog: true,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(this.map.coastX + 18, 0.08, 0);
    mesh.renderOrder = 2;
    mesh.name = "shore-foam";
    this.scene.add(mesh);
    this.shoreFoam = mesh;
  }

  // ---------- fishing boats sailing the bay, trailing a foam wake ----------
  private seaBoats: {
    group: THREE.Group;
    wakeMat: THREE.MeshBasicMaterial;
    cx: number;
    cz: number;
    rx: number;
    rz: number;
    speed: number;
    phase: number;
    bobPh: number;
  }[] = [];

  private buildSeaBoats(): void {
    const rand = mulberry32(31337);
    const HULLS = [0xc23b2e, 0x2a5d8f, 0xe8e4da, 0x2e7d4f, 0xd4842a];
    const wakeTex = buildWakeTexture(); // shared by all boats
    for (let i = 0; i < 2; i++) {
      const group = new THREE.Group();
      const hullColor = HULLS[Math.floor(rand() * HULLS.length)];
      const hullMat = new THREE.MeshStandardMaterial({ color: hullColor, roughness: 0.55 });
      const hull = new THREE.Mesh(new THREE.BoxGeometry(5.2, 1.1, 2.0), hullMat); // bow = +X
      hull.position.y = 0.3;
      group.add(hull);
      const bow = new THREE.Mesh(new THREE.ConeGeometry(1.0, 1.9, 4), hullMat);
      bow.rotation.z = -Math.PI / 2;
      bow.rotation.y = Math.PI / 4;
      bow.position.set(3.4, 0.3, 0);
      group.add(bow);
      const deck = new THREE.Mesh(
        new THREE.BoxGeometry(4.4, 0.18, 1.5),
        new THREE.MeshStandardMaterial({ color: 0xb09467, roughness: 0.8 })
      );
      deck.position.y = 0.85;
      group.add(deck);
      const cabin = new THREE.Mesh(
        new THREE.BoxGeometry(1.6, 1.1, 1.3),
        new THREE.MeshStandardMaterial({ color: 0xf0ece2, roughness: 0.7 })
      );
      cabin.position.set(-0.8, 1.4, 0);
      group.add(cabin);
      const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 4.2, 6), deck.material);
      mast.position.set(0.8, 2.7, 0);
      group.add(mast);
      group.traverse((o) => (o.castShadow = true));

      // foam wake trailing the stern (local -X), laid flat just above the sea
      const wakeMat = new THREE.MeshBasicMaterial({
        map: wakeTex,
        transparent: true,
        depthWrite: false,
        opacity: 0.65,
        fog: true,
        side: THREE.DoubleSide,
      });
      const wake = new THREE.Mesh(buildWakeGeometry(), wakeMat);
      wake.position.y = -0.05;
      wake.renderOrder = 3;
      group.add(wake);

      this.scene.add(group);
      this.seaBoats.push({
        group,
        wakeMat,
        cx: this.map.coastX - 330,
        cz: (rand() - 0.5) * this.map.size * 0.2,
        rx: 150 + rand() * 90,
        rz: this.map.size * (0.3 + rand() * 0.12),
        speed: 0.02 + rand() * 0.012,
        phase: rand() * 6.28,
        bobPh: rand() * 6.28,
      });
    }
  }

  // ---------- stars: a dome of points that fades in after dusk ----------
  private stars: THREE.Points | null = null;
  private starBase = 0; // night-driven opacity, twinkled in update()

  private buildStars(): void {
    const rand = mulberry32(2025);
    const N = 1400;
    const R = 9000;
    const pos = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    const c = new THREE.Color();
    for (let i = 0; i < N; i++) {
      // upper hemisphere only, so nothing sits below the horizon
      const y = 0.05 + rand() * 0.95;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = rand() * Math.PI * 2;
      pos[i * 3] = Math.cos(theta) * r * R;
      pos[i * 3 + 1] = y * R;
      pos[i * 3 + 2] = Math.sin(theta) * r * R;
      const tint = rand();
      if (tint < 0.15) c.setHSL(0.6, 0.5, 0.85); // bluish
      else if (tint < 0.25) c.setHSL(0.08, 0.5, 0.85); // warm
      else c.setHSL(0, 0, 0.7 + rand() * 0.3); // white
      const b = 0.55 + rand() * 0.45;
      col[i * 3] = c.r * b;
      col[i * 3 + 1] = c.g * b;
      col[i * 3 + 2] = c.b * b;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    const mat = new THREE.PointsMaterial({
      size: 2.4,
      sizeAttenuation: false,
      map: buildStarSprite(),
      vertexColors: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false,
      blending: THREE.AdditiveBlending,
    });
    const stars = new THREE.Points(geo, mat);
    stars.name = "stars";
    stars.frustumCulled = false; // it's re-centred on the camera every frame
    this.scene.add(stars);
    this.stars = stars;
  }

  // ---------- moon disc, hung in the moonlight direction ----------
  private moon: THREE.Sprite | null = null;
  private moonDir = new THREE.Vector3();

  private buildMoon(): void {
    // same direction the night light comes from (applySun: el 42, az 70)
    this.moonDir.setFromSphericalCoords(
      1,
      Math.PI / 2 - THREE.MathUtils.degToRad(42),
      THREE.MathUtils.degToRad(70)
    );
    const mat = new THREE.SpriteMaterial({
      map: buildMoonTexture(),
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false,
    });
    const moon = new THREE.Sprite(mat);
    moon.scale.setScalar(620);
    moon.frustumCulled = false;
    this.scene.add(moon);
    this.moon = moon;
  }

  // ---------- a single reusable shooting star ----------
  private meteor: {
    line: THREE.Line;
    mat: THREE.LineBasicMaterial;
    active: boolean;
    nextAt: number;
    t0: number;
    a0: THREE.Vector3;
    dir: THREE.Vector3;
  } | null = null;

  private buildMeteor(): void {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3));
    const mat = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      fog: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const line = new THREE.Line(geo, mat);
    line.frustumCulled = false;
    this.scene.add(line);
    this.meteor = { line, mat, active: false, nextAt: 6, t0: 0, a0: new THREE.Vector3(), dir: new THREE.Vector3() };
  }

  // ---------- drifting cumulus clouds (daytime) ----------
  private clouds: { sprite: THREE.Sprite; x0: number; speed: number }[] = [];
  private cloudMat: THREE.SpriteMaterial | null = null;

  private buildClouds(): void {
    const rand = mulberry32(5150);
    const tex = buildCloudTexture();
    const span = this.map.size;
    // one shared material for every cloud - they all carry the same opacity
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.9, depthWrite: false, fog: true });
    this.cloudMat = mat;
    for (let i = 0; i < 16; i++) {
      const s = new THREE.Sprite(mat);
      const w = 420 + rand() * 560;
      s.scale.set(w, w * 0.55, 1);
      const x0 = (rand() * 2 - 1) * span;
      s.position.set(x0, 560 + rand() * 520, (rand() * 2 - 1) * span);
      s.frustumCulled = false;
      this.scene.add(s);
      this.clouds.push({ sprite: s, x0, speed: 3 + rand() * 5 });
    }
  }

  // ---------- fireflies drifting over the coastal fields at dusk ----------
  private fireflies: THREE.Points | null = null;
  private fireflyBase: Float32Array | null = null;
  private fireflyParams: { ax: number; ay: number; az: number; fx: number; fy: number; fz: number; br: number; bp: number }[] = [];

  private buildFireflies(): void {
    const rand = mulberry32(8088);
    const N = 240;
    const clusters = 6;
    const per = Math.ceil(N / clusters);
    const base = new Float32Array(N * 3);
    const col = new Float32Array(N * 3);
    let i = 0;
    for (let c = 0; c < clusters && i < N; c++) {
      // scatter swarms over the flat coastal plain (terrain is level here)
      const cx = this.map.coastX + 180 + rand() * 380;
      const cz = (rand() * 2 - 1) * this.map.size * 0.45;
      for (let k = 0; k < per && i < N; k++, i++) {
        base[i * 3] = cx + (rand() * 2 - 1) * 26;
        base[i * 3 + 1] = 1.0 + rand() * 2.4;
        base[i * 3 + 2] = cz + (rand() * 2 - 1) * 26;
        col[i * 3] = 0.7;
        col[i * 3 + 1] = 1.0;
        col[i * 3 + 2] = 0.35;
        this.fireflyParams.push({
          ax: 2 + rand() * 4,
          ay: 0.4 + rand() * 1.0,
          az: 2 + rand() * 4,
          fx: 0.3 + rand() * 0.5,
          fy: 0.6 + rand() * 0.8,
          fz: 0.3 + rand() * 0.5,
          br: 1.5 + rand() * 2.5,
          bp: rand() * 6.28,
        });
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(base.slice(), 3)); // live, animated
    geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
    this.fireflyBase = base; // pristine origins
    const mat = new THREE.PointsMaterial({
      size: 5,
      sizeAttenuation: true,
      map: buildStarSprite(),
      vertexColors: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: true,
      blending: THREE.AdditiveBlending,
    });
    const pts = new THREE.Points(geo, mat);
    pts.name = "fireflies";
    pts.frustumCulled = false;
    this.scene.add(pts);
    this.fireflies = pts;
  }

  setTimeOfDay(mode: TimeOfDay): void {
    this.mode = mode;
    if (mode !== "cycle") {
      const p = TIME_PRESETS[mode];
      this.applySun(p.el, p.az);
      this.envDirty = true;
    }
  }

  /** Position sun/moon and re-tune all lights for the given solar elevation. */
  private applySun(elDeg: number, azDeg: number): void {
    const night = elDeg <= 1.5;
    this.isNight = night;
    // at night the scene light becomes the moon, high in the east
    const lightEl = night ? 42 : elDeg;
    const lightAz = night ? 70 : azDeg;
    this.sunDir.setFromSphericalCoords(
      1,
      Math.PI / 2 - THREE.MathUtils.degToRad(lightEl),
      THREE.MathUtils.degToRad(lightAz)
    );
    // the sky shader always gets the true sun (below horizon = dark sky)
    const skySun = new THREE.Vector3().setFromSphericalCoords(
      1,
      Math.PI / 2 - THREE.MathUtils.degToRad(elDeg),
      THREE.MathUtils.degToRad(azDeg)
    );
    this.sky.material.uniforms.sunPosition.value.copy(skySun);
    this.envSky.material.uniforms.sunPosition.value.copy(skySun);

    const dayness = Math.max(0, Math.min(1, elDeg / 25)); // 0 night .. 1 high sun
    // windows & lanterns light up at dusk and stay lit through the night
    const glowFactor = elDeg <= 2 ? 1 : elDeg < 14 ? (14 - elDeg) / 12 : 0;
    NIGHT_GLOW_MATERIAL.emissiveIntensity = 2.6 * glowFactor;
    // stars come out as the sun sinks below the horizon
    this.starBase = Math.max(0, Math.min(1, (5 - elDeg) / 10));
    if (night) {
      this.sun.intensity = 0.55;
      this.sun.color.set(0x8fa8cf); // moonlight
      this.fill.intensity = 0.09;
      (this.scene.fog as THREE.Fog).color.set(0x0b1322);
      (this.water.material as THREE.ShaderMaterial).uniforms.sunColor.value.set(0x1c2940);
    } else {
      this.sun.intensity = 1.1 + 2.1 * dayness;
      this.sun.color.copy(new THREE.Color(0xffc890).lerp(new THREE.Color(0xfff0dc), dayness));
      this.fill.intensity = 0.08 + 0.16 * dayness;
      (this.scene.fog as THREE.Fog).color.copy(
        new THREE.Color(0xe5cfb4).lerp(new THREE.Color(0xc9d9e6), dayness)
      );
      (this.water.material as THREE.ShaderMaterial).uniforms.sunColor.value.set(0xfff0dc);
    }
    (this.water.material as THREE.ShaderMaterial).uniforms.sunDirection.value.copy(this.sunDir);
  }

  /** Refresh the PBR ambient (PMREM of the sky). Costs a few ms - throttled. */
  private refreshEnvMap(): void {
    const old = this.scene.environment;
    this.scene.environment = this.pmrem.fromScene(this.envScene as unknown as THREE.Scene, 0.02).texture;
    this.scene.environmentIntensity = 0.45;
    if (old) old.dispose();
  }

  update(t: number, focus: THREE.Vector3): void {
    (this.water.material as THREE.ShaderMaterial).uniforms.time.value = t * 0.5;
    // stars: keep the dome centred on the camera, twinkle the overall brightness
    if (this.stars) {
      this.stars.position.copy(focus);
      this.stars.visible = this.starBase > 0.01;
      if (this.stars.visible) {
        (this.stars.material as THREE.PointsMaterial).opacity = this.starBase * (0.8 + 0.2 * Math.sin(t * 1.5));
      }
    }
    // moon: hangs in the moonlight direction, fading in with the stars
    if (this.moon) {
      this.moon.visible = this.starBase > 0.01;
      if (this.moon.visible) {
        this.moon.position.copy(focus).addScaledVector(this.moonDir, 8500);
        (this.moon.material as THREE.SpriteMaterial).opacity = Math.min(1, this.starBase * 1.3);
      }
    }
    // shooting star: rare streak across the night sky
    const m = this.meteor;
    if (m) {
      if (!m.active && this.starBase > 0.5 && t > m.nextAt) {
        const yy = 0.45 + Math.random() * 0.5; // start high in the dome
        const rr = Math.sqrt(1 - yy * yy);
        const th = Math.random() * Math.PI * 2;
        m.a0.set(Math.cos(th) * rr, yy, Math.sin(th) * rr);
        // travel roughly tangent to the dome, drifting downward
        m.dir.set(Math.cos(Math.random() * Math.PI * 2), -0.15 - Math.random() * 0.2, Math.sin(Math.random() * Math.PI * 2));
        m.dir.addScaledVector(m.a0, -m.dir.dot(m.a0)).normalize();
        m.active = true;
        m.t0 = t;
      }
      if (m.active) {
        const p = (t - m.t0) / 0.8;
        if (p >= 1) {
          m.active = false;
          m.mat.opacity = 0;
          m.nextAt = t + 8 + Math.random() * 26;
        } else {
          const head = focus.clone().addScaledVector(m.a0, 8000).addScaledVector(m.dir, p * 2200);
          const tail = head.clone().addScaledVector(m.dir, -700);
          const pos = m.line.geometry.attributes.position as THREE.BufferAttribute;
          pos.setXYZ(0, head.x, head.y, head.z);
          pos.setXYZ(1, tail.x, tail.y, tail.z);
          pos.needsUpdate = true;
          m.mat.opacity = Math.sin(p * Math.PI) * this.starBase;
        }
      }
    }
    // clouds drift slowly east, wrapping across the map; thin out at night
    if (this.clouds.length) {
      const span2 = this.map.size * 2;
      if (this.cloudMat) this.cloudMat.opacity = 0.9 * (1 - 0.7 * this.starBase);
      for (const c of this.clouds) {
        c.sprite.position.x = (((c.x0 + t * c.speed + this.map.size) % span2) + span2) % span2 - this.map.size;
      }
    }
    // fireflies: drift and blink, fading in with the night
    if (this.fireflies && this.fireflyBase) {
      const fade = this.starBase;
      this.fireflies.visible = fade > 0.05;
      if (this.fireflies.visible) {
        (this.fireflies.material as THREE.PointsMaterial).opacity = Math.min(1, fade);
        const posAttr = this.fireflies.geometry.attributes.position as THREE.BufferAttribute;
        const colAttr = this.fireflies.geometry.attributes.color as THREE.BufferAttribute;
        const base = this.fireflyBase;
        const params = this.fireflyParams;
        for (let i = 0; i < params.length; i++) {
          const p = params[i];
          posAttr.setXYZ(
            i,
            base[i * 3] + Math.sin(t * p.fx + p.bp) * p.ax,
            base[i * 3 + 1] + Math.sin(t * p.fy + p.bp * 1.7) * p.ay,
            base[i * 3 + 2] + Math.cos(t * p.fz + p.bp) * p.az
          );
          const blink = 0.15 + 0.85 * Math.max(0, Math.sin(t * p.br + p.bp));
          colAttr.setXYZ(i, 0.7 * blink, 1.0 * blink, 0.35 * blink);
        }
        posAttr.needsUpdate = true;
        colAttr.needsUpdate = true;
      }
    }
    // birds circle their roosts, wings flapping
    for (const f of this.flocks) {
      const a = t * f.speed + f.phase;
      f.group.position.set(f.cx + Math.cos(a) * f.r, f.h + Math.sin(t * 0.3 + f.phase) * 8, f.cz + Math.sin(a) * f.r);
      f.group.rotation.y = -a - Math.PI / 2;
      f.group.children.forEach((bird, i) => {
        bird.rotation.x = Math.sin(t * 7 + i * 1.7) * 0.5; // flap
      });
    }
    // balloons drift in slow wide circles, bobbing on the thermals
    for (const b of this.balloons) {
      const a = t * b.speed + b.phase;
      b.group.position.set(
        b.cx + Math.cos(a) * b.r,
        b.h + Math.sin(t * 0.25 + b.bob) * 4,
        b.cz + Math.sin(a) * b.r
      );
      b.group.rotation.y = Math.sin(t * 0.1 + b.phase) * 0.15;
    }
    // surf washes in and out along the shore, foam streaks drifting north
    if (this.shoreFoam && this.foamTex) {
      this.foamTex.offset.y = -t * 0.035;
      this.shoreFoam.position.x = this.map.coastX + 18 + Math.sin(t * 0.45) * 3.5;
      const mat = this.shoreFoam.material as THREE.MeshBasicMaterial;
      mat.opacity = (this.isNight ? 0.3 : 0.78) * (0.7 + 0.3 * Math.sin(t * 0.9 + 1.3));
    }
    // fishing boats sail slow offshore loops, bow pointed along their heading
    for (const sb of this.seaBoats) {
      const a = t * sb.speed + sb.phase;
      sb.group.position.set(
        sb.cx + Math.cos(a) * sb.rx,
        0.12 + Math.sin(t * 0.8 + sb.bobPh) * 0.12,
        sb.cz + Math.sin(a) * sb.rz
      );
      // heading = ellipse tangent; bow is local +X, which maps to world
      // (cos y, 0, -sin y), so y = atan2(-vz, vx) keeps the bow leading
      sb.group.rotation.y = Math.atan2(-Math.cos(a) * sb.rz, -Math.sin(a) * sb.rx);
      sb.group.rotation.z = Math.sin(t * 0.7 + sb.bobPh) * 0.04;
      sb.wakeMat.opacity = this.isNight ? 0.32 : 0.58 + 0.12 * Math.sin(t * 1.6 + sb.bobPh);
    }
    if (this.mode === "cycle") {
      const phase = (t / CYCLE_DAY_SECONDS) % 1;
      const el = Math.sin(phase * Math.PI) * 60 - 4;
      const az = 95 + phase * 165;
      this.applySun(el, az);
      if (t - this.lastEnvMapAt > 4) {
        this.lastEnvMapAt = t;
        this.refreshEnvMap();
      }
    } else if (this.envDirty) {
      this.envDirty = false;
      this.refreshEnvMap();
    }
    // shadow frustum follows the action
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).addScaledVector(this.sunDir, 700);
  }
}

/** Tiling normal map for the water surface, generated from smooth noise. */
function buildWaterNormals(): THREE.Texture {
  const S = 512;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(S, S);
  const n = new Noise2D(4242);
  const hAt = (x: number, y: number) => {
    const fx = (x / S) * 8;
    const fy = (y / S) * 8;
    // sample wrapped so the texture tiles
    return (
      n.noise(Math.sin((fx / 8) * Math.PI * 2) * 2, Math.cos((fy / 8) * Math.PI * 2) * 2) +
      0.5 * n.noise(Math.sin((fx / 4) * Math.PI * 2) * 3 + 7, Math.cos((fy / 4) * Math.PI * 2) * 3)
    );
  };
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = hAt(x + 1, y) - hAt(x - 1, y);
      const dy = hAt(x, y + 1) - hAt(x, y - 1);
      const i = (y * S + x) * 4;
      img.data[i] = Math.max(0, Math.min(255, 128 + dx * 120));
      img.data[i + 1] = Math.max(0, Math.min(255, 128 + dy * 120));
      img.data[i + 2] = 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/**
 * Lacy foam strip for the shoreline: white pixels whose alpha peaks across the
 * waterline (U) and breaks into wave streaks along the shore (V). Tiles in V.
 */
function buildFoamTexture(): THREE.Texture {
  const W = 64; // across-shore (U)
  const H = 256; // along-shore (V)
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(W, H);
  const n = new Noise2D(2024);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = x / (W - 1);
      const v = y / (H - 1);
      // foam hugs the waterline, fading to open sea and dry sand
      const env = Math.exp(-Math.pow((u - 0.5) / 0.24, 2));
      // along-shore lace, sampled on a circle so it tiles seamlessly in V
      const ang = v * Math.PI * 2;
      const nv =
        n.noise(Math.cos(ang) * 2.5 + u * 3, Math.sin(ang) * 2.5) * 0.5 +
        0.5 +
        n.noise(Math.cos(ang) * 6 + 11, Math.sin(ang) * 6) * 0.25;
      const a = Math.max(0, Math.min(1, env * (nv - 0.35) * 2.6));
      const i = (y * W + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** Flat trapezoid trailing the stern (-X), narrow at the hull, fanning out astern. */
function buildWakeGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  // A,B at the stern (x=-2.8); C,D at the tail (x=-40), fanned wide
  const verts = new Float32Array([
    -2.8, 0, -0.8, // A
    -2.8, 0, 0.8, // B
    -40, 0, 6.5, // C
    -40, 0, -6.5, // D
  ]);
  const uv = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
  g.setAttribute("position", new THREE.BufferAttribute(verts, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.computeVertexNormals();
  return g;
}

/**
 * Foam wake texture: two bright diverging lines (the bow wake), churn between,
 * all tapering from strong at the stern (V=0) to nothing at the tail (V=1).
 */
function buildWakeTexture(): THREE.Texture {
  const W = 64; // across the wake (U)
  const H = 128; // stern -> tail (V)
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(W, H);
  const n = new Noise2D(70);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = x / (W - 1);
      const v = y / (H - 1);
      const taper = Math.pow(1 - v, 1.3); // fades astern
      const eL = Math.exp(-Math.pow((u - 0.16) / 0.1, 2));
      const eR = Math.exp(-Math.pow((u - 0.84) / 0.1, 2));
      const fill = 0.22 * Math.exp(-Math.pow((u - 0.5) / 0.4, 2));
      const churn = 0.5 + 0.5 * n.noise(u * 6, v * 10);
      const a = Math.max(0, Math.min(1, taper * ((eL + eR) * 0.9 + fill) * (0.5 + 0.7 * churn)));
      const i = (y * W + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

/** Soft round star sprite - a white radial gradient fading to transparent. */
function buildStarSprite(): THREE.Texture {
  const S = 32;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.35, "rgba(255,255,255,0.5)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  return new THREE.CanvasTexture(canvas);
}

/** Pale moon: soft halo, bright disc, a few faint maria blotches. */
function buildMoonTexture(): THREE.Texture {
  const S = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext("2d")!;
  // wide soft halo
  const halo = ctx.createRadialGradient(S / 2, S / 2, S * 0.18, S / 2, S / 2, S / 2);
  halo.addColorStop(0, "rgba(245,243,230,0.8)");
  halo.addColorStop(0.5, "rgba(228,232,240,0.12)");
  halo.addColorStop(1, "rgba(228,232,240,0)");
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, S, S);
  // bright disc
  const disc = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S * 0.3);
  disc.addColorStop(0, "rgba(250,249,240,1)");
  disc.addColorStop(0.8, "rgba(236,237,228,1)");
  disc.addColorStop(1, "rgba(236,237,228,0)");
  ctx.fillStyle = disc;
  ctx.fillRect(0, 0, S, S);
  // faint seas
  const rand = mulberry32(7);
  ctx.fillStyle = "#9fa6b0";
  for (let i = 0; i < 5; i++) {
    ctx.globalAlpha = 0.08 + rand() * 0.07;
    const a = rand() * Math.PI * 2;
    const d = rand() * S * 0.16;
    ctx.beginPath();
    ctx.arc(S / 2 + Math.cos(a) * d, S / 2 + Math.sin(a) * d, S * (0.03 + rand() * 0.05), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  return new THREE.CanvasTexture(canvas);
}

/** Soft cumulus puff: overlapping white lobes accumulated additively. */
function buildCloudTexture(): THREE.Texture {
  const W = 192;
  const H = 112;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const rand = mulberry32(99);
  ctx.globalCompositeOperation = "lighter";
  for (let k = 0; k < 18; k++) {
    // bias lobes to the upper half so the cloud keeps a flattish base
    const cx = W * (0.18 + 0.64 * rand());
    const cy = H * (0.3 + 0.45 * rand());
    const r = H * (0.16 + 0.22 * rand());
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, "rgba(255,255,255,0.42)");
    g.addColorStop(0.6, "rgba(255,255,255,0.16)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }
  return new THREE.CanvasTexture(canvas);
}

export { smoothstep };
