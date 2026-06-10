import type { MapData } from "../types";
import { generateNetwork } from "./network";

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
    scenery: [],
  };
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
    edges: map.edges.map((e) => ({ a: e.a, b: e.b, via: Array.isArray(e.via) ? e.via : [] })),
    scenery: Array.isArray(map.scenery) ? map.scenery : [],
  };
}
