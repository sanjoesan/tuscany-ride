import * as THREE from "three";
import { Noise2D } from "./noise";
import type { MapData } from "../types";

export interface RoadSample {
  x: number;
  y: number;
  z: number;
  /** cumulative distance along road, meters */
  dist: number;
  /** grade as fraction (0.05 = 5 %) */
  grade: number;
  /** unit direction of travel (xz) */
  dirX: number;
  dirZ: number;
}

const ROAD_HALF = 3.5; // paved half-width
const SHOULDER = 14; // distance over which terrain blends back to natural height

/**
 * Heightfield + biome colors for the Tuscany world.
 * Construction order: base height -> road elevation profile derived from it ->
 * final height conforms terrain to the road corridor.
 */
export class Terrain {
  readonly map: MapData;
  private noise: Noise2D;
  private fieldNoise: Noise2D;
  private roadSamples: RoadSample[] = [];
  private grid = new Map<number, number[]>(); // spatial hash cell -> sample indices
  private gridCell = 30;

  constructor(map: MapData) {
    this.map = map;
    this.noise = new Noise2D(map.seed);
    this.fieldNoise = new Noise2D(map.seed * 7 + 13);
  }

  /** Natural terrain height before the road is carved in. */
  baseHeight(x: number, z: number): number {
    const m = this.map;
    // how far inland are we (0 at the coast, 1 deep inland)
    const inland = smoothstep(m.coastX + 20, m.coastX + 750, x);
    // gentle large hills + smaller detail
    const hills = this.noise.fbm(x * 0.0011 + 31.7, z * 0.0011 - 12.3, 4) * m.hilliness;
    const detail = this.noise.fbm(x * 0.006, z * 0.006, 3) * m.hilliness * 0.12;
    let h = 2 + Math.max(0, hills * (0.18 + 0.82 * inland) + 0.55 * m.hilliness * inland) + detail * (0.3 + 0.7 * inland);

    // sea floor: below the waterline west of the coast
    const seaBlend = smoothstep(m.coastX + 40, m.coastX - 120, x); // 0 on land, 1 at sea
    h = lerp(h, -7, seaBlend);
    // beach strip flattens to just above water
    const beach = smoothstep(m.coastX + 130, m.coastX + 40, x) * (1 - seaBlend);
    h = lerp(h, 1.2, beach * 0.9);

    // flatten the town area
    const dt = Math.hypot(x - m.town.x, z - m.town.z);
    if (dt < m.town.radius * 1.6) {
      const townH = this.townHeight();
      const f = 1 - smoothstep(m.town.radius * 0.85, m.town.radius * 1.6, dt);
      h = lerp(h, townH, f);
    }
    return h;
  }

  townHeight(): number {
    const m = this.map;
    const inland = smoothstep(m.coastX + 20, m.coastX + 750, m.town.x);
    return 3 + 6 * inland;
  }

  /** Build the road elevation profile and the spatial hash used to conform terrain. */
  setRoad(samples: RoadSample[]): void {
    this.roadSamples = samples;
    this.grid.clear();
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      const key = this.cellKey(s.x, s.z);
      let arr = this.grid.get(key);
      if (!arr) {
        arr = [];
        this.grid.set(key, arr);
      }
      arr.push(i);
    }
  }

  getRoadSamples(): RoadSample[] {
    return this.roadSamples;
  }

  private cellKey(x: number, z: number): number {
    const cx = Math.floor(x / this.gridCell);
    const cz = Math.floor(z / this.gridCell);
    return cx * 73856093 + cz * 19349663;
  }

  /** Nearest road sample within `radius`, or null. */
  nearestRoad(x: number, z: number, radius = ROAD_HALF + SHOULDER): { sample: RoadSample; dist: number } | null {
    let best: RoadSample | null = null;
    let bestD = radius;
    const r = Math.ceil(radius / this.gridCell);
    const cx = Math.floor(x / this.gridCell);
    const cz = Math.floor(z / this.gridCell);
    for (let ix = cx - r; ix <= cx + r; ix++) {
      for (let iz = cz - r; iz <= cz + r; iz++) {
        const arr = this.grid.get(ix * 73856093 + iz * 19349663);
        if (!arr) continue;
        for (const idx of arr) {
          const s = this.roadSamples[idx];
          const d = Math.hypot(s.x - x, s.z - z);
          if (d < bestD) {
            bestD = d;
            best = s;
          }
        }
      }
    }
    return best ? { sample: best, dist: bestD } : null;
  }

  /** Final height: natural terrain blended flat under and next to the road. */
  height(x: number, z: number): number {
    let h = this.baseHeight(x, z);
    const near = this.nearestRoad(x, z);
    if (near) {
      const f = 1 - smoothstep(ROAD_HALF, ROAD_HALF + SHOULDER, near.dist);
      h = lerp(h, near.sample.y - 0.18, f); // road sits slightly above blended terrain
    }
    return h;
  }

  /**
   * Ground albedo at a world position, with realistic in-field detail:
   * vineyard row stripes, plow furrows, wheat grain, scrub patches,
   * wet/dry beach sand. Written per-pixel into the terrain texture.
   */
  color(x: number, z: number, h: number, slope: number, out: THREE.Color): void {
    const m = this.map;

    // fine grain used everywhere so nothing looks flat
    const grain = this.fieldNoise.noise(x * 0.35, z * 0.35) * 0.045 +
      this.fieldNoise.noise(x * 0.07, z * 0.07) * 0.05;

    if (h < 0.45) {
      const wet = smoothstep(0.45, -1.5, h);
      out.setRGB(0.62 - wet * 0.18 + grain, 0.55 - wet * 0.16 + grain, 0.42 - wet * 0.13 + grain);
      return;
    }
    const beach = smoothstep(m.coastX + 150, m.coastX + 60, x);
    if (beach > 0.55) {
      out.setRGB(0.78 + grain, 0.7 + grain, 0.52 + grain);
      return;
    }

    // field patchwork: rotated coords, jittered cell borders so edges aren't ruler-straight
    const jit = this.fieldNoise.noise(x * 0.03, z * 0.03) * 14;
    const rx = x * 0.866 - z * 0.5 + jit;
    const rz = x * 0.5 + z * 0.866 - jit;
    const cell = this.fieldNoise.noise(Math.floor(rx / 95) * 0.7919, Math.floor(rz / 80) * 0.6131);
    const v = this.fieldNoise.noise(x * 0.02, z * 0.02) * 0.05 + grain;

    if (slope > 3.2) {
      // dry macchia scrub on steep ground
      const patch = this.fieldNoise.noise(x * 0.05, z * 0.05) * 0.05;
      out.setRGB(0.42 + v + patch, 0.42 + v + patch, 0.28 + v);
    } else if (cell > 0.45) {
      // ripe wheat with faint tractor lines
      const lines = Math.sin(rz * 0.45) * 0.025;
      out.setRGB(0.76 + v + lines, 0.64 + v + lines, 0.32 + v);
    } else if (cell > 0.15) {
      // vineyard: green rows on warm earth, rows every ~3 m
      const row = 0.5 + 0.5 * Math.sin((rx / 3.0) * Math.PI * 2);
      const earth = { r: 0.52, g: 0.42, b: 0.3 };
      const vine = { r: 0.3, g: 0.42, b: 0.18 };
      const t = smoothstep(0.35, 0.75, row);
      out.setRGB(
        earth.r + (vine.r - earth.r) * t + v,
        earth.g + (vine.g - earth.g) * t + v,
        earth.b + (vine.b - earth.b) * t + v
      );
    } else if (cell > -0.15) {
      // plowed field: furrows every ~1.4 m
      const fur = Math.sin((rz / 1.4) * Math.PI * 2) * 0.045;
      out.setRGB(0.52 + v + fur, 0.4 + v + fur, 0.27 + v + fur);
    } else if (cell > -0.5) {
      // dry summer pasture: gold-green, large soft patches
      const patch = this.fieldNoise.noise(x * 0.045, z * 0.045) * 0.05;
      out.setRGB(0.55 + v + patch, 0.52 + v + patch, 0.3 + v);
    } else {
      out.setRGB(0.5 + v, 0.48 + v, 0.3 + v); // olive grove ground, dry grass
    }

    // town gets warm stone paving
    const dt = Math.hypot(x - m.town.x, z - m.town.z);
    if (dt < m.town.radius) {
      const f = 1 - smoothstep(m.town.radius * 0.7, m.town.radius, dt);
      out.lerp(new THREE.Color(0.55 + grain, 0.48 + grain, 0.4 + grain), f * 0.85);
    }
  }

  /** Which crop cell is at this position (used to spawn scenery that matches the ground). */
  fieldKind(x: number, z: number): "wheat" | "vineyard" | "plowed" | "pasture" | "olive" {
    const rx = x * 0.866 - z * 0.5;
    const rz = x * 0.5 + z * 0.866;
    const cell = this.fieldNoise.noise(Math.floor(rx / 95) * 0.7919, Math.floor(rz / 80) * 0.6131);
    if (cell > 0.45) return "wheat";
    if (cell > 0.15) return "vineyard";
    if (cell > -0.15) return "plowed";
    if (cell > -0.5) return "pasture";
    return "olive";
  }

  /**
   * Paint the whole-map albedo texture (pixel -> world via plane UV mapping).
   * Height/slope come from a coarse precomputed grid (bilinear) because
   * calling the full noise stack per pixel is far too slow.
   */
  private buildAlbedoTexture(resolution = 2048): THREE.CanvasTexture {
    const m = this.map;

    // coarse height grid (~9 m cells)
    const G = 256;
    const grid = new Float32Array((G + 1) * (G + 1));
    for (let gy = 0; gy <= G; gy++) {
      const z = (gy / G) * m.size - m.size / 2;
      for (let gx = 0; gx <= G; gx++) {
        const x = (gx / G) * m.size - m.size / 2;
        grid[gy * (G + 1) + gx] = this.baseHeight(x, z);
      }
    }
    const hAt = (fx: number, fy: number): number => {
      const gx = Math.min(G - 1, Math.max(0, fx * G));
      const gy = Math.min(G - 1, Math.max(0, fy * G));
      const ix = Math.floor(gx);
      const iy = Math.floor(gy);
      const tx = gx - ix;
      const ty = gy - iy;
      const i0 = iy * (G + 1) + ix;
      const i1 = i0 + (G + 1);
      return (
        grid[i0] * (1 - tx) * (1 - ty) + grid[i0 + 1] * tx * (1 - ty) +
        grid[i1] * (1 - tx) * ty + grid[i1 + 1] * tx * ty
      );
    };

    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = resolution;
    const ctx = canvas.getContext("2d")!;
    const img = ctx.createImageData(resolution, resolution);
    const data = img.data;
    const c = new THREE.Color();
    const cellM = m.size / G; // meters per grid cell, for slope scaling
    for (let py = 0; py < resolution; py++) {
      const fy = py / resolution;
      const z = fy * m.size - m.size / 2;
      for (let px = 0; px < resolution; px++) {
        const fx = px / resolution;
        const x = fx * m.size - m.size / 2;
        const h = hAt(fx, fy);
        const slope =
          (Math.abs(hAt(fx + 1 / G, fy) - hAt(fx - 1 / G, fy)) +
            Math.abs(hAt(fx, fy + 1 / G) - hAt(fx, fy - 1 / G))) * (8 / cellM);
        this.color(x, z, h, slope, c);
        const i = (py * resolution + px) * 4;
        data[i] = Math.max(0, Math.min(255, c.r * 255));
        data[i + 1] = Math.max(0, Math.min(255, c.g * 255));
        data[i + 2] = Math.max(0, Math.min(255, c.b * 255));
        data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    return tex;
  }

  /** Small tiling normal map for close-up ground detail. */
  private buildDetailNormal(size = 256): THREE.CanvasTexture {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d")!;
    const img = ctx.createImageData(size, size);
    const n = this.fieldNoise;
    const hAt = (x: number, y: number) =>
      n.noise((x % size) * 0.09, (y % size) * 0.09) + 0.5 * n.noise((x % size) * 0.23, (y % size) * 0.23);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = hAt(x + 1, y) - hAt(x - 1, y);
        const dy = hAt(x, y + 1) - hAt(x, y - 1);
        const i = (y * size + x) * 4;
        img.data[i] = Math.max(0, Math.min(255, 128 - dx * 90));
        img.data[i + 1] = Math.max(0, Math.min(255, 128 - dy * 90));
        img.data[i + 2] = 255;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(420, 420);
    return tex;
  }

  buildMesh(): THREE.Mesh {
    const m = this.map;
    const segs = 280;
    const geo = new THREE.PlaneGeometry(m.size, m.size, segs, segs);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, this.height(pos.getX(i), pos.getZ(i)));
    }
    geo.computeVertexNormals();
    const mat = new THREE.MeshStandardMaterial({
      map: this.buildAlbedoTexture(),
      normalMap: this.buildDetailNormal(),
      normalScale: new THREE.Vector2(0.55, 0.55),
      roughness: 1.0,
      metalness: 0,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.name = "terrain";
    return mesh;
  }
}

export function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export { ROAD_HALF, SHOULDER };
