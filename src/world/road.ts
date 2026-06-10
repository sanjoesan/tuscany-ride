import * as THREE from "three";
import type { MapData } from "../types";
import { Terrain, ROAD_HALF, type RoadSample } from "./terrain";

const SAMPLE_STEP = 5; // meters between road samples

/**
 * Closed-loop road built from the map's control points with a Catmull-Rom
 * spline. The elevation profile is the smoothed natural terrain height,
 * with the grade limited so climbs stay rideable.
 */
export class Road {
  readonly samples: RoadSample[] = [];
  readonly totalLength: number;
  readonly curve: THREE.CatmullRomCurve3;

  constructor(map: MapData, terrain: Terrain) {
    const pts = map.road.map(([x, z]) => new THREE.Vector3(x, 0, z));
    this.curve = new THREE.CatmullRomCurve3(pts, true, "centripetal", 0.5);

    // sample the curve roughly every SAMPLE_STEP meters
    const approxLen = this.curve.getLength();
    const n = Math.max(64, Math.round(approxLen / SAMPLE_STEP));
    const raw: { x: number; z: number; h: number }[] = [];
    for (let i = 0; i < n; i++) {
      const p = this.curve.getPointAt(i / n);
      raw.push({ x: p.x, z: p.z, h: terrain.baseHeight(p.x, p.z) });
    }

    // smooth elevations (circular moving average, two passes)
    let hs = raw.map((r) => r.h);
    for (let pass = 0; pass < 2; pass++) {
      const w = 8;
      const out = new Array<number>(n);
      for (let i = 0; i < n; i++) {
        let sum = 0;
        for (let k = -w; k <= w; k++) sum += hs[(i + k + n) % n];
        out[i] = sum / (2 * w + 1);
      }
      hs = out;
    }

    // limit grade to +-11% (forward and backward pass over the loop)
    const maxGrade = 0.11;
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 1; i <= n; i++) {
        const a = (i - 1) % n;
        const b = i % n;
        const d = Math.hypot(raw[b].x - raw[a].x, raw[b].z - raw[a].z);
        const dh = hs[b] - hs[a];
        if (Math.abs(dh) > d * maxGrade) hs[b] = hs[a] + Math.sign(dh) * d * maxGrade;
      }
      for (let i = n - 1; i >= 0; i--) {
        const a = (i + 1) % n;
        const b = i;
        const d = Math.hypot(raw[b].x - raw[a].x, raw[b].z - raw[a].z);
        const dh = hs[b] - hs[a];
        if (Math.abs(dh) > d * maxGrade) hs[b] = hs[a] + Math.sign(dh) * d * maxGrade;
      }
    }

    // build samples with cumulative distance, direction and grade
    let dist = 0;
    for (let i = 0; i < n; i++) {
      const a = raw[i];
      const b = raw[(i + 1) % n];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const d = Math.hypot(dx, dz) || 1;
      if (i > 0) {
        const prev = raw[i - 1];
        dist += Math.hypot(a.x - prev.x, a.z - prev.z);
      }
      const grade = (hs[(i + 1) % n] - hs[i]) / d;
      this.samples.push({
        x: a.x,
        y: hs[i],
        z: a.z,
        dist,
        grade,
        dirX: dx / d,
        dirZ: dz / d,
      });
    }
    const last = this.samples[n - 1];
    const first = this.samples[0];
    this.totalLength = last.dist + Math.hypot(first.x - last.x, first.z - last.z);
  }

  /** Interpolated state at distance s (wraps around the loop). */
  at(s: number): { pos: THREE.Vector3; dir: THREE.Vector3; grade: number } {
    const n = this.samples.length;
    let d = ((s % this.totalLength) + this.totalLength) % this.totalLength;
    // samples are near-uniformly spaced; start with an estimate then walk
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
    const grade = a.grade + (b.grade - a.grade) * t;
    return { pos, dir, grade };
  }

  /** Asphalt ribbon with a painted texture: grain, wheel tracks, edge + dashed center lines. */
  buildMesh(): THREE.Group {
    const group = new THREE.Group();
    group.name = "road";

    const n = this.samples.length;
    const verts: number[] = [];
    const uvs: number[] = [];
    const idx: number[] = [];
    const TILE_LEN = 14; // meters of road per texture repeat
    for (let i = 0; i <= n; i++) {
      const s = this.samples[i % n];
      const nx = -s.dirZ;
      const nz = s.dirX;
      const dist = i === n ? this.totalLength : s.dist;
      verts.push(s.x + nx * ROAD_HALF, s.y + 0.05, s.z + nz * ROAD_HALF);
      verts.push(s.x - nx * ROAD_HALF, s.y + 0.05, s.z - nz * ROAD_HALF);
      uvs.push(0, dist / TILE_LEN, 1, dist / TILE_LEN);
      if (i < n) {
        const a = i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      map: buildAsphaltTexture(),
      roughness: 0.92,
      metalness: 0,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    group.add(mesh);
    return group;
  }
}

/**
 * 512x512 asphalt tile. u spans the 7 m road width, v spans 14 m of length.
 * Painted: dark aggregate grain, slightly worn wheel tracks, white edge
 * lines and a dashed center line (dash appears once per tile -> 7 m cycle).
 */
function buildAsphaltTexture(): THREE.CanvasTexture {
  const S = 512;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext("2d")!;

  // base asphalt
  ctx.fillStyle = "#37373b";
  ctx.fillRect(0, 0, S, S);

  // aggregate grain
  const img = ctx.getImageData(0, 0, S, S);
  for (let i = 0; i < img.data.length; i += 4) {
    const px = (i / 4) % S;
    const n = (Math.random() - 0.5) * 26;
    // wheel tracks: subtle darkening at ~30 % and ~70 % of the width
    const u = px / S;
    const track =
      -10 * Math.exp(-((u - 0.3) ** 2) / 0.004) - 10 * Math.exp(-((u - 0.7) ** 2) / 0.004);
    img.data[i] += n + track;
    img.data[i + 1] += n + track;
    img.data[i + 2] += n + track + 2;
  }
  ctx.putImageData(img, 0, 0);

  // edge lines (slightly weathered)
  ctx.fillStyle = "rgba(230, 228, 220, 0.85)";
  ctx.fillRect(Math.round(S * 0.025), 0, Math.round(S * 0.018), S);
  ctx.fillRect(Math.round(S * 0.957), 0, Math.round(S * 0.018), S);

  // dashed center line: one 4 m dash per 14 m tile
  ctx.fillRect(Math.round(S * 0.491), 0, Math.round(S * 0.018), Math.round(S * 0.29));

  // wear speckles on the lines
  for (let i = 0; i < 600; i++) {
    const x = Math.random() * S;
    const y = Math.random() * S;
    ctx.fillStyle = `rgba(55, 55, 59, ${Math.random() * 0.5})`;
    ctx.fillRect(x, y, 2, 2);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export { SAMPLE_STEP };
