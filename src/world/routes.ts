import type { MapData } from "../types";
import { RoadNetwork, SampledPath } from "./road";
import type { RoadSample } from "./terrain";
import { mulberry32 } from "./noise";

/**
 * Route generation: ~50 named circuits over the road network, derived
 * deterministically from the map seed. Each route starts at a town (or
 * junction), wanders the network and returns to its start - lengths span
 * roughly 30 minutes to 2 hours of riding.
 */

export interface RouteStats {
  distanceKm: number;
  gainM: number;
  maxGradePct: number;
  estMinutes: number;
}

export class Route extends SampledPath {
  name = "";
  startNode = 0;
  stats: RouteStats = { distanceKm: 0, gainM: 0, maxGradePct: 0, estMinutes: 0 };
}

interface Step {
  path: number; // index into network.paths
  reverse: boolean;
}

export function generateRoutes(map: MapData, network: RoadNetwork, count = 50): Route[] {
  const rand = mulberry32(map.seed * 101 + 7);
  const adj: { path: number; to: number }[][] = map.nodes.map(() => []);
  network.paths.forEach((p, pi) => {
    adj[p.a].push({ path: pi, to: p.b });
    adj[p.b].push({ path: pi, to: p.a });
  });

  // steepest grade of each road, so flat routes can avoid the climbs
  const pathMaxG = network.paths.map((p) => p.samples.reduce((m, s) => Math.max(m, Math.abs(s.grade)), 0));

  // shortest paths back home via Dijkstra (lazy, cached); the "flat" variant
  // makes steep roads expensive so coastal routes come home along the coast
  const spCache = new Map<string, { dist: number[]; prevPath: number[]; prevNode: number[] }>();
  const dijkstra = (src: number, flat: boolean) => {
    const key = `${src}:${flat}`;
    let c = spCache.get(key);
    if (c) return c;
    const cost = (pi: number) =>
      network.paths[pi].length * (flat ? 1 + pathMaxG[pi] * 60 : 1);
    const dist = map.nodes.map(() => Infinity);
    const prevPath = map.nodes.map(() => -1);
    const prevNode = map.nodes.map(() => -1);
    dist[src] = 0;
    const visited = new Set<number>();
    for (;;) {
      let u = -1;
      let best = Infinity;
      for (let i = 0; i < dist.length; i++) {
        if (!visited.has(i) && dist[i] < best) {
          best = dist[i];
          u = i;
        }
      }
      if (u < 0) break;
      visited.add(u);
      for (const { path, to } of adj[u]) {
        const nd = dist[u] + cost(path);
        if (nd < dist[to]) {
          dist[to] = nd;
          prevPath[to] = path;
          prevNode[to] = u;
        }
      }
    }
    c = { dist, prevPath, prevNode };
    spCache.set(key, c);
    return c;
  };

  const townNodes = map.towns.map((_, i) => i); // towns are the first nodes
  const routes: Route[] = [];

  for (let r = 0; r < count; r++) {
    // length targets spread 12..55 km (≈ 30 min .. 2 h), shuffled by interleaving
    const frac = ((r * 17) % count) / (count - 1);
    const targetM = 12000 + frac * 43000;
    // every third route stays flat: it starts at the harbour town and
    // avoids steep roads, giving easy 0-5 % coastal spins
    const flat = r % 3 === 0;
    const start = flat ? 0 : (townNodes[r % townNodes.length] ?? r % map.nodes.length);

    // random walk until ~3/4 of the budget, then shortest-path home
    const steps: Step[] = [];
    let here = start;
    let length = 0;
    let lastPath = -1;
    let guard = 0;
    while (length < targetM * 0.72 && guard++ < 400) {
      let options = adj[here].filter((o) => o.path !== lastPath);
      if (flat) {
        // prefer flat roads ahead; turning back beats climbing a pass
        const flatAhead = options.filter((o) => pathMaxG[o.path] < 0.055);
        const flatAny = adj[here].filter((o) => pathMaxG[o.path] < 0.055);
        options = flatAhead.length ? flatAhead : flatAny.length ? flatAny : options;
      }
      const pick = (options.length ? options : adj[here])[
        Math.floor(rand() * (options.length ? options.length : adj[here].length))
      ];
      if (!pick) break;
      steps.push({ path: pick.path, reverse: network.paths[pick.path].a !== here });
      length += network.paths[pick.path].length;
      lastPath = pick.path;
      here = pick.to;
    }
    // home via shortest path
    const sp = dijkstra(start, flat);
    while (here !== start && sp.prevPath[here] >= 0) {
      const pi = sp.prevPath[here];
      const from = sp.prevNode[here];
      steps.push({ path: pi, reverse: network.paths[pi].b !== here });
      length += network.paths[pi].length;
      here = from;
    }
    // the "home" segment above is in reverse order; fix by rebuilding properly
    if (steps.length === 0) continue;
    const route = buildRoute(map, network, start, fixHomeOrder(steps, network, start));
    if (route) {
      nameRoute(route, map, r, routes);
      routes.push(route);
    }
  }
  routes.sort((a, b) => a.stats.distanceKm - b.stats.distanceKm);
  return routes;
}

/**
 * The shortest-path-home steps were appended target->...->start; walk the
 * whole step list from the start node and orient every edge correctly.
 */
function fixHomeOrder(steps: Step[], network: RoadNetwork, start: number): Step[] {
  // split: walk part is already ordered; find where the ordered walk breaks
  const ordered: Step[] = [];
  let here = start;
  let i = 0;
  for (; i < steps.length; i++) {
    const p = network.paths[steps[i].path];
    if (p.a === here) {
      ordered.push({ path: steps[i].path, reverse: false });
      here = p.b;
    } else if (p.b === here) {
      ordered.push({ path: steps[i].path, reverse: true });
      here = p.a;
    } else {
      break; // start of the home segment (was appended back-to-front)
    }
  }
  const home = steps.slice(i).reverse();
  for (const s of home) {
    const p = network.paths[s.path];
    if (p.a === here) {
      ordered.push({ path: s.path, reverse: false });
      here = p.b;
    } else if (p.b === here) {
      ordered.push({ path: s.path, reverse: true });
      here = p.a;
    }
  }
  return ordered;
}

function buildRoute(map: MapData, network: RoadNetwork, start: number, steps: Step[]): Route | null {
  if (steps.length === 0) return null;
  const route = new Route();
  route.startNode = start;
  const samples: RoadSample[] = [];
  let dist = 0;
  for (const step of steps) {
    const p = network.paths[step.path];
    const src = step.reverse ? [...p.samples].reverse() : p.samples;
    for (let i = 0; i < src.length - 1; i++) {
      const s = src[i];
      samples.push({
        x: s.x,
        y: s.y,
        z: s.z,
        dist,
        grade: step.reverse ? -s.grade : s.grade,
        dirX: step.reverse ? -s.dirX : s.dirX,
        dirZ: step.reverse ? -s.dirZ : s.dirZ,
      });
      const nxt = src[i + 1];
      dist += Math.hypot(nxt.x - s.x, nxt.z - s.z);
    }
  }
  if (samples.length < 10) return null;
  route.samples = samples;
  route.totalLength = dist;

  // stats
  let gain = 0;
  let maxG = 0;
  for (let i = 1; i < samples.length; i++) {
    const dh = samples[i].y - samples[i - 1].y;
    if (dh > 0) gain += dh;
    maxG = Math.max(maxG, Math.abs(samples[i].grade));
  }
  const km = dist / 1000;
  route.stats = {
    distanceKm: km,
    gainM: Math.round(gain),
    maxGradePct: Math.round(maxG * 1000) / 10,
    // ~29 km/h on the flat; climbing costs extra
    estMinutes: Math.round(((km + gain / 130) / 29) * 60),
  };
  return route;
}

const PREFIX_FLAT = ["Costa di", "Lungomare di", "Pianura di", "Giro di"];
const PREFIX_MED = ["Giro di", "Anello di", "Strada di", "Colline di"];
const PREFIX_HARD = ["Passo di", "Salita di", "Muro di", "Cima di"];
const ROMAN = ["", " II", " III", " IV", " V", " VI", " VII", " VIII", " IX", " X"];

function nameRoute(route: Route, map: MapData, idx: number, existing: Route[]): void {
  const town = map.towns[route.startNode]?.name ?? map.towns[0].name;
  const hardness =
    route.stats.maxGradePct >= 7.5 || route.stats.gainM > 550
      ? PREFIX_HARD
      : route.stats.gainM > 220
        ? PREFIX_MED
        : PREFIX_FLAT;
  const base = `${hardness[idx % hardness.length]} ${town}`;
  let n = 0;
  let name = base;
  while (existing.some((r) => r.name === name) && n < 9) {
    n++;
    name = base + ROMAN[n];
  }
  route.name = name;
}
