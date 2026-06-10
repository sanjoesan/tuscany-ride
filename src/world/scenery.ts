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
  group.add(buildHarbour(map, terrain, rand));
  group.add(buildAnimals(map, terrain, rand, blocked, inTown));
  group.add(buildHayBales(map, terrain, rand, blocked, inTown));
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
    group.add(boat);
  }

  // buoys
  const buoyMat = new THREE.MeshStandardMaterial({ color: 0xc23b2e, roughness: 0.5 });
  for (let i = 0; i < 8; i++) {
    const buoy = new THREE.Mesh(new THREE.SphereGeometry(0.45, 8, 6), buoyMat);
    buoy.position.set(map.coastX - 40 - rand() * 320, 0.25, town.z + (rand() - 0.5) * 600);
    group.add(buoy);
  }
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
    // birds circle their roosts, wings flapping
    for (const f of this.flocks) {
      const a = t * f.speed + f.phase;
      f.group.position.set(f.cx + Math.cos(a) * f.r, f.h + Math.sin(t * 0.3 + f.phase) * 8, f.cz + Math.sin(a) * f.r);
      f.group.rotation.y = -a - Math.PI / 2;
      f.group.children.forEach((bird, i) => {
        bird.rotation.x = Math.sin(t * 7 + i * 1.7) * 0.5; // flap
      });
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

export { smoothstep };
