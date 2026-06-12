import * as THREE from "three";
import type { MapData } from "../types";
import { Terrain } from "./terrain";
import type { RoadNetwork } from "./road";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

export const RIVER_HALF = 5.5; // water half-width
const STEP = 6;

export interface RiverSample {
  x: number;
  z: number;
  /** water surface height */
  y: number;
  dirX: number;
  dirZ: number;
  dist: number;
  /** water half-width (widens toward the mouth) */
  half: number;
}

/**
 * A river from the hills to the sea. The water surface follows a smoothed,
 * strictly downhill profile; the terrain carves a bed underneath
 * (Terrain.height handles that via setRiver).
 */
export class River {
  readonly samples: RiverSample[] = [];

  constructor(map: MapData, terrain: Terrain) {
    const pts = map.river.map(([x, z]) => new THREE.Vector3(x, 0, z));
    if (pts.length < 2) return;
    const curve = new THREE.CatmullRomCurve3(pts, false, "centripetal", 0.5);
    const n = Math.max(16, Math.round(curve.getLength() / STEP));
    let hs: number[] = [];
    const raw: { x: number; z: number }[] = [];
    for (let i = 0; i <= n; i++) {
      const p = curve.getPointAt(i / n);
      raw.push({ x: p.x, z: p.z });
      hs.push(terrain.baseHeight(p.x, p.z) - 0.7);
    }
    // smooth, then enforce strictly downhill toward the sea
    for (let pass = 0; pass < 2; pass++) {
      const out = new Array<number>(n + 1);
      const w = 6;
      for (let i = 0; i <= n; i++) {
        let sum = 0;
        let cnt = 0;
        for (let k = -w; k <= w; k++) {
          const idx = i + k;
          if (idx < 0 || idx > n) continue;
          sum += hs[idx];
          cnt++;
        }
        out[i] = sum / cnt;
      }
      hs = out;
    }
    for (let i = 1; i <= n; i++) hs[i] = Math.min(hs[i], hs[i - 1]);
    // the mouth sits at sea level
    hs[n] = Math.min(hs[n], -0.4);
    for (let i = n - 1; i >= 0; i--) hs[i] = Math.max(hs[i], hs[i + 1]);

    let dist = 0;
    for (let i = 0; i <= n; i++) {
      const prev = raw[Math.max(0, i - 1)];
      const next = raw[Math.min(n, i + 1)];
      const dx = next.x - prev.x;
      const dz = next.z - prev.z;
      const dl = Math.hypot(dx, dz) || 1;
      if (i > 0) dist += Math.hypot(raw[i].x - prev.x, raw[i].z - prev.z);
      this.samples.push({
        x: raw[i].x,
        z: raw[i].z,
        y: hs[i],
        dirX: dx / dl,
        dirZ: dz / dl,
        dist,
        half: RIVER_HALF * (1 + (i / n) * 0.8),
      });
    }
  }

  /** Water ribbon (semi-transparent, picks up sky reflections via env map). */
  buildMesh(): THREE.Mesh | null {
    if (this.samples.length < 2) return null;
    const verts: number[] = [];
    const idx: number[] = [];
    this.samples.forEach((s, i) => {
      const nx = -s.dirZ;
      const nz = s.dirX;
      verts.push(s.x + nx * s.half, s.y, s.z + nz * s.half);
      verts.push(s.x - nx * s.half, s.y, s.z - nz * s.half);
      if (i < this.samples.length - 1) {
        const a = i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    // diffuse blue reads as water from every angle (reflective materials
    // turn concrete-grey under the hazy sky)
    const mat = new THREE.MeshLambertMaterial({
      color: 0x2576a3,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
    });
    mat.emissive = new THREE.Color(0x0b2e44);
    mat.emissiveIntensity = 0.35;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = "river";
    return mesh;
  }

  /**
   * Stone bridges wherever a road crosses the river: deck under the asphalt,
   * parapet walls, abutments down to the bed.
   */
  buildBridges(network: RoadNetwork): THREE.Group {
    const group = new THREE.Group();
    group.name = "bridges";
    if (this.samples.length < 2) return group;
    const stone = new THREE.MeshStandardMaterial({ color: 0xa49a86, roughness: 0.9 });

    for (const path of network.paths) {
      let inCross = false;
      let crossStart = 0;
      for (let i = 0; i < path.samples.length; i++) {
        const s = path.samples[i];
        const near = this.nearest(s.x, s.z);
        const within = near !== null && near.d < RIVER_HALF + 4;
        if (within && !inCross) {
          inCross = true;
          crossStart = i;
        } else if (!within && inCross) {
          inCross = false;
          const mid = path.samples[Math.floor((crossStart + i) / 2)];
          const len = Math.max(16, path.samples[i].dist - path.samples[crossStart].dist + 10);
          group.add(this.bridgeMesh(mid, len, path.half, stone));
        }
      }
    }
    return group;
  }

  /**
   * A stone mill house on the bank with a paddle wheel that dips into the
   * water and turns. The wheel pivot is tagged userData.spin so World.update
   * rotates it (axle = local X, oriented along the bank normal).
   */
  buildWatermill(terrain: Terrain, towns: MapData["towns"]): THREE.Group {
    const group = new THREE.Group();
    group.name = "watermill";
    const n = this.samples.length;
    if (n < 8) return group;

    // a mid-course sample, above the tidal mouth and clear of any town
    let s: RiverSample | null = null;
    for (let i = Math.floor(n * 0.4); i < Math.floor(n * 0.75); i++) {
      const c = this.samples[i];
      if (c.y < 1.0) continue;
      if (towns.some((t) => Math.hypot(c.x - t.x, c.z - t.z) < t.radius + 40)) continue;
      s = c;
      break;
    }
    if (!s) return group;

    const yaw = Math.atan2(-s.dirZ, s.dirX);
    const nx = -s.dirZ;
    const nz = s.dirX; // bank normal
    const bankX = s.x + nx * (s.half + 2.8);
    const bankZ = s.z + nz * (s.half + 2.8);
    const groundY = terrain.height(bankX, bankZ);

    // mill house
    const stone = new THREE.MeshStandardMaterial({ color: 0xb9ad94, roughness: 0.9 });
    const house = new THREE.Mesh(new THREE.BoxGeometry(7, 6, 6), stone);
    house.position.set(bankX, groundY + 3, bankZ);
    house.rotation.y = yaw;
    house.castShadow = house.receiveShadow = true;
    group.add(house);
    const roof = new THREE.Mesh(
      new THREE.ConeGeometry(5.4, 3, 4),
      new THREE.MeshStandardMaterial({ color: 0x8a4a30, roughness: 0.85 })
    );
    roof.position.set(bankX, groundY + 7.4, bankZ);
    roof.rotation.y = yaw + Math.PI / 4;
    roof.castShadow = true;
    group.add(roof);

    // paddle wheel at the waterline, axle along the bank normal
    const R = 3.4;
    const wheelX = s.x + nx * (s.half - 0.4);
    const wheelZ = s.z + nz * (s.half - 0.4);
    const pivot = new THREE.Group();
    pivot.position.set(wheelX, s.y + R - 1.0, wheelZ); // bottom ~1 m under the surface
    pivot.rotation.y = Math.atan2(-nz, nx); // local X = axle along the normal
    pivot.userData.spin = { axis: "x", speed: 0.7 };

    const wood = new THREE.MeshStandardMaterial({ color: 0x4a3a26, roughness: 0.85 });
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 1.4, 10), wood);
    hub.rotation.z = Math.PI / 2;
    pivot.add(hub);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(R, 0.18, 6, 24), wood);
    rim.rotation.y = Math.PI / 2; // ring into the Y-Z plane (axle = X)
    pivot.add(rim);
    const paddleMat = new THREE.MeshStandardMaterial({ color: 0x6b573a, roughness: 0.85, side: THREE.DoubleSide });
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.5, R, 0.12), wood);
      spoke.position.set(0, (Math.cos(a) * R) / 2, (Math.sin(a) * R) / 2);
      spoke.rotation.x = a;
      pivot.add(spoke);
      const paddle = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.1, 0.12), paddleMat);
      paddle.position.set(0, Math.cos(a) * R, Math.sin(a) * R);
      paddle.rotation.x = a;
      pivot.add(paddle);
    }
    group.add(pivot);

    return group;
  }

  private bridgeMesh(
    s: { x: number; y: number; z: number; dirX: number; dirZ: number },
    len: number,
    roadHalf: number,
    mat: THREE.MeshStandardMaterial
  ): THREE.Mesh {
    const w = roadHalf * 2 + 1.6;
    const parts: THREE.BufferGeometry[] = [];
    // deck slab just under the asphalt ribbon
    const deck = new THREE.BoxGeometry(len, 1.1, w);
    deck.translate(0, -0.62, 0);
    parts.push(deck);
    // parapets
    for (const side of [1, -1]) {
      const p = new THREE.BoxGeometry(len, 1.0, 0.35);
      p.translate(0, 0.42, (w / 2 - 0.2) * side);
      parts.push(p);
    }
    // abutments down into the bed
    for (const end of [1, -1]) {
      const a = new THREE.BoxGeometry(2.2, 5, w);
      a.translate((len / 2 - 1) * end, -2.8, 0);
      parts.push(a);
    }
    const geo = mergeGeometries(parts.map((g) => g.toNonIndexed()))!;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(s.x, s.y + 0.1, s.z);
    mesh.rotation.y = Math.atan2(-s.dirZ, s.dirX);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  /** nearest river sample (linear scan is fine: ~hundreds of samples) */
  nearest(x: number, z: number): { s: RiverSample; d: number } | null {
    let best: RiverSample | null = null;
    let bestD = Infinity;
    for (const s of this.samples) {
      const d = Math.hypot(s.x - x, s.z - z);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best ? { s: best, d: bestD } : null;
  }
}
