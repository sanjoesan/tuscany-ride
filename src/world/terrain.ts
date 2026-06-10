import * as THREE from "three";
import { Noise2D } from "./noise";
import type { MapData } from "../types";
import type { RiverSample } from "./river";

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
  /** paved half-width of this road (main 3.5, lane 2.2) */
  half?: number;
}

const ROAD_HALF = 3.5; // paved half-width
const SHOULDER = 30; // outer search radius for road influence on terrain

/**
 * Heightfield + biome colors for the Tuscany world.
 * Construction order: base height -> road elevation profile derived from it ->
 * final height conforms terrain to the road corridor.
 */
export type Season = "spring" | "summer" | "autumn" | "winter";

type RGB = [number, number, number];
interface SeasonPalette {
  wheat: RGB;
  pasture: RGB;
  vine: RGB;
  vineEarth: RGB;
  plow: RGB;
  olive: RGB;
  scrub: RGB;
  verge: RGB;
}

/** Tuscany through the year: field colors per season. */
export const SEASON_PALETTES: Record<Season, SeasonPalette> = {
  spring: {
    wheat: [0.45, 0.58, 0.27], // young green wheat
    pasture: [0.38, 0.55, 0.23],
    vine: [0.3, 0.48, 0.19],
    vineEarth: [0.5, 0.41, 0.29],
    plow: [0.45, 0.35, 0.24],
    olive: [0.42, 0.5, 0.26],
    scrub: [0.36, 0.44, 0.25],
    verge: [0.3, 0.5, 0.18],
  },
  summer: {
    wheat: [0.76, 0.64, 0.32], // ripe gold
    pasture: [0.55, 0.52, 0.3],
    vine: [0.3, 0.42, 0.18],
    vineEarth: [0.52, 0.42, 0.3],
    plow: [0.52, 0.4, 0.27],
    olive: [0.5, 0.48, 0.3],
    scrub: [0.42, 0.42, 0.28],
    verge: [0.33, 0.47, 0.2],
  },
  autumn: {
    wheat: [0.6, 0.49, 0.3], // stubble
    pasture: [0.5, 0.45, 0.27],
    vine: [0.55, 0.3, 0.12], // vines turn red and gold
    vineEarth: [0.48, 0.38, 0.27],
    plow: [0.44, 0.34, 0.24],
    olive: [0.46, 0.43, 0.28],
    scrub: [0.44, 0.4, 0.26],
    verge: [0.38, 0.42, 0.2],
  },
  winter: {
    wheat: [0.5, 0.44, 0.33], // bare fields
    pasture: [0.46, 0.48, 0.34],
    vine: [0.4, 0.34, 0.26], // bare rows
    vineEarth: [0.46, 0.4, 0.32],
    plow: [0.42, 0.35, 0.27],
    olive: [0.44, 0.46, 0.32],
    scrub: [0.4, 0.42, 0.3],
    verge: [0.4, 0.44, 0.3],
  },
};

export class Terrain {
  readonly map: MapData;
  /** "fast" lowers texture/mesh resolution for live editing in the builder */
  quality: "full" | "fast";
  season: Season;
  private noise: Noise2D;
  private fieldNoise: Noise2D;
  private roadSamples: RoadSample[] = [];
  private grid = new Map<number, number[]>(); // spatial hash cell -> sample indices
  private gridCell = 30;
  private riverSamples: RiverSample[] = [];
  private riverGrid = new Map<number, number[]>();
  /** extra flatten width beyond the asphalt (>= one terrain-grid cell) */
  private spacingPad: number;
  /** outer search radius for road influence */
  private maxBlend: number;

  constructor(map: MapData, quality: "full" | "fast" = "full", season: Season = "summer") {
    this.map = map;
    this.quality = quality;
    this.season = season;
    this.noise = new Noise2D(map.seed);
    this.fieldNoise = new Noise2D(map.seed * 7 + 13);
    // the flattened corridor must span at least one terrain-grid cell on
    // each side, otherwise hillside triangles poke through the asphalt
    const spacing = map.size / this.meshSegments();
    this.spacingPad = Math.max(7, spacing * 1.0);
    this.maxBlend = ROAD_HALF + this.spacingPad + 15;
  }

  meshSegments(): number {
    return this.quality === "fast"
      ? 260
      : Math.min(560, Math.max(280, Math.round(this.map.size / 11)));
  }

  /** Natural terrain height before the road is carved in. */
  baseHeight(x: number, z: number): number {
    const m = this.map;
    // how far inland are we (0 at the coast, 1 deep inland) - the first
    // ~650 m stay a flat coastal plain so easy 0-5 % routes exist
    const inland = smoothstep(m.coastX + 650, m.coastX + 1900, x);
    // gentle large hills + smaller detail
    const hills = this.noise.fbm(x * 0.0011 + 31.7, z * 0.0011 - 12.3, 4) * m.hilliness;
    const detail = this.noise.fbm(x * 0.006, z * 0.006, 3) * m.hilliness * 0.12;
    let h = 2 + Math.max(0, hills * (0.18 + 0.82 * inland) + 0.55 * m.hilliness * inland) + detail * (0.12 + 0.88 * inland);

    // sea floor: below the waterline west of the coast
    const seaBlend = smoothstep(m.coastX + 40, m.coastX - 120, x); // 0 on land, 1 at sea
    h = lerp(h, -7, seaBlend);
    // beach strip flattens to just above water
    const beach = smoothstep(m.coastX + 130, m.coastX + 40, x) * (1 - seaBlend);
    h = lerp(h, 1.2, beach * 0.9);

    // flatten every town area
    for (const town of m.towns) {
      const dt = Math.hypot(x - town.x, z - town.z);
      if (dt < town.radius * 1.6) {
        const f = 1 - smoothstep(town.radius * 0.85, town.radius * 1.6, dt);
        h = lerp(h, this.townHeight(town), f);
      }
    }
    return h;
  }

  townHeight(town: { x: number; z: number }): number {
    const m = this.map;
    const inland = smoothstep(m.coastX + 20, m.coastX + 750, town.x);
    const hills = this.noise.fbm(town.x * 0.0011 + 31.7, town.z * 0.0011 - 12.3, 2) * m.hilliness;
    return Math.max(3, 3 + 6 * inland + Math.max(0, hills * 0.5 * inland));
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

  /** Register the river course so the terrain carves its bed. */
  setRiver(samples: RiverSample[]): void {
    this.riverSamples = samples;
    this.riverGrid.clear();
    samples.forEach((s, i) => {
      const key = this.cellKey(s.x, s.z);
      let arr = this.riverGrid.get(key);
      if (!arr) {
        arr = [];
        this.riverGrid.set(key, arr);
      }
      arr.push(i);
    });
  }

  /** Nearest river sample within `radius`, or null. */
  nearestRiver(x: number, z: number, radius = 40): { sample: RiverSample; dist: number } | null {
    let best: RiverSample | null = null;
    let bestD = radius;
    const r = Math.ceil(radius / this.gridCell);
    const cx = Math.floor(x / this.gridCell);
    const cz = Math.floor(z / this.gridCell);
    for (let ix = cx - r; ix <= cx + r; ix++) {
      for (let iz = cz - r; iz <= cz + r; iz++) {
        const arr = this.riverGrid.get(ix * 73856093 + iz * 19349663);
        if (!arr) continue;
        for (const idx of arr) {
          const s = this.riverSamples[idx];
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

  private cellKey(x: number, z: number): number {
    const cx = Math.floor(x / this.gridCell);
    const cz = Math.floor(z / this.gridCell);
    return cx * 73856093 + cz * 19349663;
  }

  /** Nearest road sample within `radius`, or null. */
  nearestRoad(x: number, z: number, radius = SHOULDER): { sample: RoadSample; dist: number } | null {
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
    const near = this.nearestRoad(x, z, this.maxBlend);
    if (near) {
      const flat = (near.sample.half ?? ROAD_HALF) + this.spacingPad;
      const f = 1 - smoothstep(flat, flat + 15, near.dist);
      h = lerp(h, near.sample.y - 0.3, f); // corridor carved below the asphalt
    }
    // the river carves its bed last - it cuts under roads (bridges span it)
    const rv = this.nearestRiver(x, z);
    if (rv) {
      const bed = rv.sample.y - 1.5;
      const f = 1 - smoothstep(rv.sample.half, rv.sample.half + 12, rv.dist);
      if (f > 0) h = lerp(h, Math.min(h, bed), f);
    }
    return h;
  }

  /**
   * Ground albedo at a world position, with realistic in-field detail:
   * vineyard row stripes, plow furrows, wheat grain, scrub patches,
   * wet/dry beach sand. Written per-pixel into the terrain texture.
   */
  color(
    x: number,
    z: number,
    h: number,
    slope: number,
    out: THREE.Color,
    roadDist: number | null = null,
    riverNear: { dist: number; y: number; half: number } | null = null
  ): void {
    const m = this.map;

    // fine grain used everywhere so nothing looks flat
    const grain = this.fieldNoise.noise(x * 0.35, z * 0.35) * 0.045 +
      this.fieldNoise.noise(x * 0.07, z * 0.07) * 0.05;

    if (h < 0.45) {
      const wet = smoothstep(0.45, -1.5, h);
      out.setRGB(0.62 - wet * 0.18 + grain, 0.55 - wet * 0.16 + grain, 0.42 - wet * 0.13 + grain);
      return;
    }

    // river: pebble bed under water, lush banks beside it
    if (riverNear) {
      if (h < riverNear.y + 0.25) {
        out.setRGB(0.5 + grain, 0.46 + grain, 0.38 + grain); // wet pebbles
        return;
      }
      if (riverNear.dist < riverNear.half + 26) {
        const f = (1 - smoothstep(riverNear.half + 2, riverNear.half + 26, riverNear.dist)) * 0.75;
        const gg = grain * 1.4;
        const lush = new THREE.Color(0.27 + gg, 0.45 + gg, 0.17 + gg);
        const rest = new THREE.Color();
        this.color(x, z, h, slope, rest, roadDist, null);
        out.copy(lush).lerp(rest, 1 - f);
        return;
      }
    }
    const beach = smoothstep(m.coastX + 150, m.coastX + 60, x);
    if (beach > 0.55) {
      out.setRGB(0.78 + grain, 0.7 + grain, 0.52 + grain);
      return;
    }

    // grass verge along the roads
    if (roadDist !== null && roadDist < 12) {
      const f = (1 - smoothstep(4.5, 12, roadDist)) * 0.7;
      const gg = grain * 1.5;
      const vg = SEASON_PALETTES[this.season].verge;
      out.setRGB(vg[0] + gg, vg[1] + gg, vg[2] + gg);
      const rest = new THREE.Color();
      this.color(x, z, h, slope, rest, null);
      out.lerp(rest, 1 - f);
      return;
    }

    // field patchwork: rotated coords, jittered cell borders so edges aren't ruler-straight
    const jit = this.fieldNoise.noise(x * 0.03, z * 0.03) * 14;
    const rx = x * 0.866 - z * 0.5 + jit;
    const rz = x * 0.5 + z * 0.866 - jit;
    const cell = this.fieldNoise.noise(Math.floor(rx / 95) * 0.7919, Math.floor(rz / 80) * 0.6131);
    const v = this.fieldNoise.noise(x * 0.02, z * 0.02) * 0.05 + grain;

    const pal = SEASON_PALETTES[this.season];
    if (slope > 3.2) {
      // macchia scrub on steep ground
      const patch = this.fieldNoise.noise(x * 0.05, z * 0.05) * 0.05;
      out.setRGB(pal.scrub[0] + v + patch, pal.scrub[1] + v + patch, pal.scrub[2] + v);
    } else if (cell > 0.45) {
      // wheat field with faint tractor lines
      const lines = Math.sin(rz * 0.45) * 0.025;
      out.setRGB(pal.wheat[0] + v + lines, pal.wheat[1] + v + lines, pal.wheat[2] + v);
    } else if (cell > 0.15) {
      // vineyard: rows on warm earth, every ~3 m
      const row = 0.5 + 0.5 * Math.sin((rx / 3.0) * Math.PI * 2);
      const t = smoothstep(0.35, 0.75, row);
      out.setRGB(
        pal.vineEarth[0] + (pal.vine[0] - pal.vineEarth[0]) * t + v,
        pal.vineEarth[1] + (pal.vine[1] - pal.vineEarth[1]) * t + v,
        pal.vineEarth[2] + (pal.vine[2] - pal.vineEarth[2]) * t + v
      );
    } else if (cell > -0.15) {
      // plowed field: furrows every ~1.4 m
      const fur = Math.sin((rz / 1.4) * Math.PI * 2) * 0.045;
      out.setRGB(pal.plow[0] + v + fur, pal.plow[1] + v + fur, pal.plow[2] + v + fur);
    } else if (cell > -0.5) {
      // pasture: large soft patches
      const patch = this.fieldNoise.noise(x * 0.045, z * 0.045) * 0.05;
      out.setRGB(pal.pasture[0] + v + patch, pal.pasture[1] + v + patch, pal.pasture[2] + v);
    } else {
      out.setRGB(pal.olive[0] + v, pal.olive[1] + v, pal.olive[2] + v); // olive grove ground
    }

    // towns get warm stone paving; the piazza a pale circular cobble pattern
    for (const town of m.towns) {
      const dt = Math.hypot(x - town.x, z - town.z);
      if (dt < 30) {
        const ring = Math.sin(dt * 1.15) * 0.03; // concentric cobble bands
        out.setRGB(0.63 + grain + ring, 0.58 + grain + ring, 0.49 + grain + ring);
        return;
      }
      if (dt < town.radius) {
        const f = 1 - smoothstep(town.radius * 0.7, town.radius, dt);
        out.lerp(new THREE.Color(0.55 + grain, 0.48 + grain, 0.4 + grain), f * 0.85);
      }
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
  private buildAlbedoTexture(): THREE.CanvasTexture {
    const m = this.map;
    const resolution = this.quality === "fast" ? 1024 : m.size > 4000 ? 3072 : 2048;

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

    // coarse presence grids so we only do exact distance checks near roads/river
    const P = 200;
    const presence = new Uint8Array(P * P);
    for (const s of this.roadSamples) {
      const gx = Math.floor(((s.x + m.size / 2) / m.size) * P);
      const gz = Math.floor(((s.z + m.size / 2) / m.size) * P);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          const ix = gx + dx;
          const iz = gz + dz;
          if (ix >= 0 && ix < P && iz >= 0 && iz < P) presence[iz * P + ix] = 1;
        }
      }
    }
    const riverPres = new Uint8Array(P * P);
    for (const s of this.riverSamples) {
      const gx = Math.floor(((s.x + m.size / 2) / m.size) * P);
      const gz = Math.floor(((s.z + m.size / 2) / m.size) * P);
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          const ix = gx + dx;
          const iz = gz + dz;
          if (ix >= 0 && ix < P && iz >= 0 && iz < P) riverPres[iz * P + ix] = 1;
        }
      }
    }

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
        let roadDist: number | null = null;
        if (presence[Math.floor(fy * P) * P + Math.floor(fx * P)]) {
          const near = this.nearestRoad(x, z, 14);
          if (near) roadDist = near.dist;
        }
        let riverNear: { dist: number; y: number; half: number } | null = null;
        if (riverPres[Math.floor(fy * P) * P + Math.floor(fx * P)]) {
          const nr = this.nearestRiver(x, z, 42);
          if (nr) riverNear = { dist: nr.dist, y: nr.sample.y, half: nr.sample.half };
        }
        this.color(x, z, h, slope, c, roadDist, riverNear);
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
    const segs = this.meshSegments();
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
