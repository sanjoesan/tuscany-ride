import type { MapData } from "../types";

/**
 * The default map: "Toscana Classica".
 * West (negative x) is the Tyrrhenian sea with a beach, a small Italian town
 * sits near the coast, and the road loops inland through rolling farm hills.
 */
export function defaultMap(): MapData {
  return {
    name: "Toscana Classica",
    seed: 1337,
    size: 2400,
    hilliness: 70,
    coastX: -720,
    town: { x: -470, z: 140, radius: 150 },
    road: [
      [-500, 80],     // town main street
      [-585, -220],   // lungomare (coast road)
      [-470, -520],   // turning inland
      [-140, -690],   // through the wheat fields
      [280, -660],    // vineyard flats
      [640, -470],    // start of the climb
      [840, -120],    // high point in the hills
      [760, 290],     // ridge road
      [470, 590],     // descent between olive groves
      [60, 700],      // cypress alley
      [-310, 540],    // back towards the coast
      [-540, 330],    // beach approach into town
    ],
    scenery: [],
  };
}

const STORAGE_KEY = "roadgame.map";

export function loadSavedMap(): MapData | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const m = JSON.parse(raw) as MapData;
    if (!Array.isArray(m.road) || m.road.length < 3) return null;
    return { ...defaultMap(), ...m };
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
  const d = defaultMap();
  if (typeof m !== "object" || m === null) throw new Error("Not a map file");
  const map = m as Partial<MapData>;
  if (!Array.isArray(map.road) || map.road.length < 3) throw new Error("Map needs a road with at least 3 points");
  return {
    name: typeof map.name === "string" ? map.name : "Custom Map",
    seed: typeof map.seed === "number" ? map.seed : d.seed,
    size: typeof map.size === "number" ? Math.max(800, Math.min(6000, map.size)) : d.size,
    hilliness: typeof map.hilliness === "number" ? map.hilliness : d.hilliness,
    coastX: typeof map.coastX === "number" ? map.coastX : d.coastX,
    town: map.town && typeof map.town.x === "number" ? map.town : d.town,
    road: map.road.map((p) => [Number(p[0]), Number(p[1])] as [number, number]),
    scenery: Array.isArray(map.scenery) ? map.scenery : [],
  };
}
