import type { MapData, TownData } from "../types";
import { generateNetwork } from "./network";
import { mulberry32 } from "./noise";

/**
 * The default map: "Toscana Grande" - a 6 x 6 km region with the Tyrrhenian
 * sea in the west, several towns and villages, and a country-road network
 * full of junctions. Towns, junctions and roads all derive from the seed.
 */
export function defaultMap(): MapData {
  return mapFromSeed(1337);
}

export function mapFromSeed(seed: number, size = 6000, hilliness = 75): MapData {
  const coastX = -size * 0.31;
  const net = generateNetwork(seed, size, coastX);
  return {
    name: "Toscana Grande",
    seed,
    size,
    hilliness,
    coastX,
    towns: net.towns,
    nodes: net.nodes,
    edges: net.edges,
    river: generateRiver(seed, size, coastX, net.towns),
    scenery: [],
  };
}

/**
 * A river course from the eastern hills down to the sea, meandering and
 * keeping clear of the towns.
 */
function generateRiver(seed: number, size: number, coastX: number, towns: TownData[]): [number, number][] {
  const rand = mulberry32(seed * 53 + 11);
  const half = size / 2;
  for (let attempt = 0; attempt < 24; attempt++) {
    const srcX = size * 0.28 + rand() * size * 0.16;
    const srcZ = (rand() - 0.5) * size * 0.65;
    const mouthZ = srcZ + (rand() - 0.5) * size * 0.4;
    const pts: [number, number][] = [];
    const n = 9;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = srcX + (coastX - 140 - srcX) * t;
      const meander = i === 0 || i === n ? 0 : Math.sin(t * Math.PI * 3 + rand() * 2) * size * 0.05 + (rand() - 0.5) * size * 0.04;
      const z = srcZ + (mouthZ - srcZ) * t + meander;
      pts.push([x, Math.max(-half + 150, Math.min(half - 150, z))]);
    }
    // the mouth reaches into the sea
    pts.push([coastX - 220, mouthZ]);
    // reject courses that run through a town
    const ok = towns.every((t) =>
      pts.every(([x, z]) => Math.hypot(x - t.x, z - t.z) > t.radius + 70)
    );
    if (ok) return pts;
  }
  // fallback: straight course through the middle
  return [
    [size * 0.3, 0],
    [size * 0.1, size * 0.05],
    [coastX + 600, -size * 0.04],
    [coastX - 220, 0],
  ];
}

const STORAGE_KEY = "roadgame.map.v2";

export function loadSavedMap(): MapData | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return validateMap(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function saveMapLocal(map: MapData): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
}

export function clearSavedMap(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function validateMap(m: unknown): MapData {
  if (typeof m !== "object" || m === null) throw new Error("Not a map file");
  const map = m as Partial<MapData>;
  if (!Array.isArray(map.nodes) || !Array.isArray(map.edges) || map.edges.length < 1) {
    throw new Error("Map needs a road network (nodes + edges) - old single-road maps are not supported");
  }
  const seed = typeof map.seed === "number" ? map.seed : 1337;
  const size = typeof map.size === "number" ? Math.max(2000, Math.min(12000, map.size)) : 6000;
  const d = mapFromSeed(seed, size);
  const nodes = map.nodes.map((n) => ({ x: Number(n.x), z: Number(n.z) }));
  for (const e of map.edges) {
    if (typeof e.a !== "number" || typeof e.b !== "number" || e.a >= nodes.length || e.b >= nodes.length) {
      throw new Error("Map has an invalid road edge");
    }
  }
  return {
    name: typeof map.name === "string" ? map.name : "Custom Map",
    seed,
    size,
    hilliness: typeof map.hilliness === "number" ? map.hilliness : d.hilliness,
    coastX: typeof map.coastX === "number" ? map.coastX : d.coastX,
    towns: Array.isArray(map.towns) && map.towns.length ? map.towns : d.towns,
    nodes,
    edges: map.edges.map((e) => ({ a: e.a, b: e.b, via: Array.isArray(e.via) ? e.via : [], kind: e.kind })),
    river: Array.isArray(map.river) && map.river.length >= 2 ? map.river : d.river,
    scenery: Array.isArray(map.scenery) ? map.scenery : [],
  };
}
