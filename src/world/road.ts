import * as THREE from "three";
import type { MapData } from "../types";
import { Terrain, ROAD_HALF, type RoadSample } from "./terrain";

const SAMPLE_STEP = 5; // meters between road samples
const MAX_GRADE = 0.1; // roads never exceed 10 %
const JUNCTION_R = 7.5; // junction pad radius

/** One road of the network, sampled a -> b. */
export interface EdgePath {
  edge: number;
  a: number;
  b: number;
  samples: RoadSample[];
  length: number;
}

/** Common lookup over a list of samples (used by Route). */
export class SampledPath {
  samples: RoadSample[] = [];
  totalLength = 0;

  /** Interpolated state at distance s (wraps; routes are circuits). */
  at(s: number): { pos: THREE.Vector3; dir: THREE.Vector3; grade: number } {
    const n = this.samples.length;
    const d = ((s % this.totalLength) + this.totalLength) % this.totalLength;
    let i = Math.min(n - 1, Math.floor((d / this.totalLength) * n));
    while (i < n - 1 && this.samples[i + 1].dist < d) i++;
    while (i > 0 && this.samples[i].dist > d) i--;
    const a = this.samples[i];
    const b = this.samples[(i + 1) % n];
    const segLen = (i === n - 1 ? this.totalLength : b.dist) - a.dist || 1;
    const t = Math.min(1, Math.max(0, (d - a.dist) / segLen));
    const pos = new THREE.Vector3(
      a.x + (b.x - a.x) * t,
      a.y + (b.y - a.y) * t,
      a.z + (b.z - a.z) * t
    );
    const dir = new THREE.Vector3(
      a.dirX + (b.dirX - a.dirX) * t,
      0,
      a.dirZ + (b.dirZ - a.dirZ) * t
    ).normalize();
    return { pos, dir, grade: a.grade + (b.grade - a.grade) * t };
  }
}

/**
 * The whole road network: an elevation-consistent sampled path per edge
 * (edges meeting at a node share the node's height, so junctions are smooth)
 * plus meshes for the asphalt ribbons and junction pads.
 */
export class RoadNetwork {
  readonly map: MapData;
  readonly nodeY: number[] = [];
  readonly paths: EdgePath[] = [];
  /** every sample of every edge + junction pads - used to conform terrain */
  readonly allSamples: RoadSample[] = [];

  constructor(map: MapData, terrain: Terrain) {
    this.map = map;

    // node elevations: smoothed terrain around the junction...
    for (const n of map.nodes) {
      let sum = 0;
      let cnt = 0;
      for (let dx = -20; dx <= 20; dx += 10) {
        for (let dz = -20; dz <= 20; dz += 10) {
          sum += terrain.baseHeight(n.x + dx, n.z + dz);
          cnt++;
        }
      }
      this.nodeY.push(sum / cnt);
    }
    // ...then relaxed so no road is forced beyond ~8.5 % between junctions
    // (leaves headroom for the 10 % limit along the road itself). Only the
    // higher node moves - down, like a road cutting - so flat coastal
    // junctions are never dragged uphill.
    for (let iter = 0; iter < 80; iter++) {
      let moved = false;
      for (const e of map.edges) {
        const a = map.nodes[e.a];
        const b = map.nodes[e.b];
        const len = Math.hypot(a.x - b.x, a.z - b.z) * 1.08; // roads curve a bit
        const cap = len * 0.085;
        const dh = this.nodeY[e.b] - this.nodeY[e.a];
        if (Math.abs(dh) > cap) {
          const excess = Math.abs(dh) - cap;
          if (dh > 0) this.nodeY[e.b] -= excess;
          else this.nodeY[e.a] -= excess;
          moved = true;
        }
      }
      if (!moved) break;
    }

    // sample every edge
    map.edges.forEach((e, ei) => {
      const pts = [
        new THREE.Vector3(map.nodes[e.a].x, 0, map.nodes[e.a].z),
        ...e.via.map(([x, z]) => new THREE.Vector3(x, 0, z)),
        new THREE.Vector3(map.nodes[e.b].x, 0, map.nodes[e.b].z),
      ];
      const curve = new THREE.CatmullRomCurve3(pts, false, "centripetal", 0.5);
      const approxLen = curve.getLength();
      const n = Math.max(8, Math.round(approxLen / SAMPLE_STEP));
      const raw: { x: number; z: number }[] = [];
      let hs: number[] = [];
      for (let i = 0; i <= n; i++) {
        const p = curve.getPointAt(i / n);
        raw.push({ x: p.x, z: p.z });
        hs.push(terrain.baseHeight(p.x, p.z));
      }

      // smooth (open-ended moving average), then pin ends to node heights
      for (let pass = 0; pass < 2; pass++) {
        const w = 8;
        const out = new Array<number>(n + 1);
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
      // blend endpoints toward node heights over the first/last ~80 m
      const ya = this.nodeY[e.a];
      const yb = this.nodeY[e.b];
      const blendN = Math.min(Math.floor(n / 2), Math.round(80 / SAMPLE_STEP));
      for (let i = 0; i <= n; i++) {
        if (i <= blendN) {
          const t = i / blendN;
          hs[i] = ya * (1 - t) + hs[i] * t;
        }
        if (n - i <= blendN) {
          const t = (n - i) / blendN;
          hs[i] = yb * (1 - t) + hs[i] * t;
        }
      }
      hs[0] = ya;
      hs[n] = yb;

      // limit grade to MAX_GRADE while keeping the endpoints fixed
      for (let pass = 0; pass < 4; pass++) {
        for (let i = 1; i <= n; i++) {
          const d = Math.hypot(raw[i].x - raw[i - 1].x, raw[i].z - raw[i - 1].z) || 1;
          const dh = hs[i] - hs[i - 1];
          if (Math.abs(dh) > d * MAX_GRADE) hs[i] = hs[i - 1] + Math.sign(dh) * d * MAX_GRADE;
        }
        hs[n] = yb;
        for (let i = n - 1; i >= 0; i--) {
          const d = Math.hypot(raw[i].x - raw[i + 1].x, raw[i].z - raw[i + 1].z) || 1;
          const dh = hs[i] - hs[i + 1];
          if (Math.abs(dh) > d * MAX_GRADE) hs[i] = hs[i + 1] + Math.sign(dh) * d * MAX_GRADE;
        }
        hs[0] = ya;
      }

      // build samples with distance / direction / grade
      const samples: RoadSample[] = [];
      let dist = 0;
      for (let i = 0; i <= n; i++) {
        const prev = raw[Math.max(0, i - 1)];
        const next = raw[Math.min(n, i + 1)];
        const dx = next.x - prev.x;
        const dz = next.z - prev.z;
        const dl = Math.hypot(dx, dz) || 1;
        if (i > 0) dist += Math.hypot(raw[i].x - raw[i - 1].x, raw[i].z - raw[i - 1].z);
        const hNext = hs[Math.min(n, i + 1)];
        const hPrev = hs[Math.max(0, i - 1)];
        samples.push({
          x: raw[i].x,
          y: hs[i],
          z: raw[i].z,
          dist,
          grade: (hNext - hPrev) / dl,
          dirX: dx / dl,
          dirZ: dz / dl,
        });
      }
      const path: EdgePath = { edge: ei, a: e.a, b: e.b, samples, length: dist };
      this.paths.push(path);
      this.allSamples.push(...samples);
    });

    // junction pads: extra conform samples so terrain flattens around nodes
    map.nodes.forEach((node, ni) => {
      const y = this.nodeY[ni];
      this.allSamples.push({ x: node.x, y, z: node.z, dist: 0, grade: 0, dirX: 1, dirZ: 0 });
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        this.allSamples.push({
          x: node.x + Math.cos(a) * JUNCTION_R * 0.7,
          y,
          z: node.z + Math.sin(a) * JUNCTION_R * 0.7,
          dist: 0,
          grade: 0,
          dirX: 1,
          dirZ: 0,
        });
      }
    });
  }

  /** total km of road in the network */
  get totalKm(): number {
    return this.paths.reduce((a, p) => a + p.length, 0) / 1000;
  }

  buildMesh(): THREE.Group {
    const group = new THREE.Group();
    group.name = "road";
    const asphaltTex = buildAsphaltTexture();
    const ribbonMat = new THREE.MeshStandardMaterial({
      map: asphaltTex,
      roughness: 0.92,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    const padMat = new THREE.MeshStandardMaterial({ color: 0x37373b, roughness: 0.93 });

    const TILE_LEN = 14;
    for (const path of this.paths) {
      const verts: number[] = [];
      const uvs: number[] = [];
      const idx: number[] = [];
      path.samples.forEach((s, i) => {
        const nx = -s.dirZ;
        const nz = s.dirX;
        verts.push(s.x + nx * ROAD_HALF, s.y + 0.12, s.z + nz * ROAD_HALF);
        verts.push(s.x - nx * ROAD_HALF, s.y + 0.12, s.z - nz * ROAD_HALF);
        uvs.push(0, s.dist / TILE_LEN, 1, s.dist / TILE_LEN);
        if (i < path.samples.length - 1) {
          const a = i * 2;
          idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
      geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, ribbonMat);
      mesh.receiveShadow = true;
      group.add(mesh);
    }

    // junction pads on top so the line markings don't cross the junctions
    const padGeo = new THREE.CircleGeometry(JUNCTION_R, 22);
    padGeo.rotateX(-Math.PI / 2);
    this.map.nodes.forEach((node, ni) => {
      const pad = new THREE.Mesh(padGeo, padMat);
      pad.position.set(node.x, this.nodeY[ni] + 0.18, node.z);
      pad.receiveShadow = true;
      group.add(pad);
    });
    return group;
  }
}

/**
 * 512x512 asphalt tile. u spans the 7 m road width, v spans 14 m of length.
 * Painted: dark aggregate grain, slightly worn wheel tracks, white edge
 * lines and a dashed center line.
 */
function buildAsphaltTexture(): THREE.CanvasTexture {
  const S = 512;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext("2d")!;

  ctx.fillStyle = "#37373b";
  ctx.fillRect(0, 0, S, S);

  const img = ctx.getImageData(0, 0, S, S);
  for (let i = 0; i < img.data.length; i += 4) {
    const px = (i / 4) % S;
    const n = (Math.random() - 0.5) * 26;
    const u = px / S;
    const track =
      -10 * Math.exp(-((u - 0.3) ** 2) / 0.004) - 10 * Math.exp(-((u - 0.7) ** 2) / 0.004);
    img.data[i] += n + track;
    img.data[i + 1] += n + track;
    img.data[i + 2] += n + track + 2;
  }
  ctx.putImageData(img, 0, 0);

  ctx.fillStyle = "rgba(230, 228, 220, 0.85)";
  ctx.fillRect(Math.round(S * 0.025), 0, Math.round(S * 0.018), S);
  ctx.fillRect(Math.round(S * 0.957), 0, Math.round(S * 0.018), S);
  ctx.fillRect(Math.round(S * 0.491), 0, Math.round(S * 0.018), Math.round(S * 0.29));

  for (let i = 0; i < 600; i++) {
    ctx.fillStyle = `rgba(55, 55, 59, ${Math.random() * 0.5})`;
    ctx.fillRect(Math.random() * S, Math.random() * S, 2, 2);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export { SAMPLE_STEP, MAX_GRADE, JUNCTION_R };
