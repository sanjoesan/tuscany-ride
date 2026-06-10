import type { TownData, RoadNode, RoadEdge } from "../types";
import { mulberry32 } from "./noise";

/**
 * Procedural road network: towns, junction nodes and the roads between them.
 * Edges come from a Gabriel graph over the nodes, which gives a natural,
 * planar country-road network - roads only meet at junctions, so every
 * intersection is a real, rideable crossing.
 */

const TOWN_NAMES = [
  "Montefiore", "Borgo Marina", "Castellina", "San Vito", "Poggio Alto",
  "Pieve Vecchia", "Roccalta", "Santa Chiara", "Monteverdi", "Valdimora",
  "Campodoro", "Torre del Sole",
];

export interface NetworkData {
  towns: TownData[];
  nodes: RoadNode[];
  edges: RoadEdge[];
}

export function generateNetwork(seed: number, size: number, coastX: number): NetworkData {
  const rand = mulberry32(seed * 17 + 3);
  const half = size / 2 - 250;

  // ---------- towns ----------
  const townCount = Math.max(4, Math.min(6, Math.round(size / 1100)));
  const towns: TownData[] = [];
  const nameOffset = Math.floor(rand() * TOWN_NAMES.length);

  // one harbour town at the coast (the biggest)
  towns.push({
    x: coastX + 200,
    z: (rand() - 0.5) * half,
    radius: 170 + rand() * 50,
    name: TOWN_NAMES[nameOffset % TOWN_NAMES.length],
  });
  // the rest spread inland with minimum spacing
  let attempts = 0;
  while (towns.length < townCount && attempts < 400) {
    attempts++;
    const x = coastX + 500 + rand() * (half - coastX - 600);
    const z = -half + 200 + rand() * (2 * half - 400);
    if (towns.every((t) => Math.hypot(t.x - x, t.z - z) > size * 0.24)) {
      towns.push({
        x, z,
        radius: 115 + rand() * 80,
        name: TOWN_NAMES[(nameOffset + towns.length) % TOWN_NAMES.length],
      });
    }
  }

  // ---------- nodes: town piazzas + countryside junctions ----------
  const nodes: RoadNode[] = towns.map((t) => ({ x: t.x, z: t.z }));

  // guaranteed coastal chain ("lungomare") for flat seaside routes
  const coastalCount = Math.max(4, Math.round(size / 1400));
  for (let i = 0; i < coastalCount; i++) {
    const z = -half + 250 + ((2 * half - 500) * i) / (coastalCount - 1) + (rand() - 0.5) * 250;
    const x = coastX + 200 + rand() * 220;
    if (nodes.every((n) => Math.hypot(n.x - x, n.z - z) > 450)) nodes.push({ x, z });
  }

  // dense countryside junctions -> plenty of forks to turn at
  const junctionCount = Math.round(size / 250); // ~24 for 6 km
  attempts = 0;
  while (nodes.length < towns.length + junctionCount && attempts < 1200) {
    attempts++;
    const x = coastX + 150 + rand() * (half - coastX - 250);
    const z = -half + 120 + rand() * (2 * half - 240);
    if (nodes.every((n) => Math.hypot(n.x - x, n.z - z) > size * 0.085)) {
      nodes.push({ x, z });
    }
  }

  // ---------- edges: Gabriel graph (planar, natural road layout) ----------
  const edges: RoadEdge[] = [];
  const maxLen = size * 0.45;
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      if (d > maxLen) continue;
      // Gabriel criterion: no other node inside the circle with diameter ab
      const mx = (a.x + b.x) / 2;
      const mz = (a.z + b.z) / 2;
      const r2 = (d / 2) ** 2;
      let ok = true;
      for (let k = 0; k < nodes.length; k++) {
        if (k === i || k === j) continue;
        const n = nodes[k];
        if ((n.x - mx) ** 2 + (n.z - mz) ** 2 < r2 * 0.96) {
          ok = false;
          break;
        }
      }
      if (ok) edges.push({ a: i, b: j, via: [] });
    }
  }

  // ---------- ensure the graph is connected ----------
  const parent = nodes.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (i: number, j: number) => { parent[find(i)] = find(j); };
  for (const e of edges) union(e.a, e.b);
  for (let i = 1; i < nodes.length; i++) {
    if (find(i) !== find(0)) {
      // connect this component to the nearest node of the main component
      let best = -1;
      let bestD = Infinity;
      for (let j = 0; j < nodes.length; j++) {
        if (find(j) !== find(0)) continue;
        const d = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].z - nodes[j].z);
        if (d < bestD) { bestD = d; best = j; }
      }
      if (best >= 0) {
        edges.push({ a: i, b: best, via: [] });
        union(i, best);
      }
    }
  }

  // ---------- classify: main roads = the town-to-town backbone ----------
  // every edge used by some shortest path between two towns becomes a
  // two-lane "strada provinciale"; everything else is a narrow lane
  {
    const adj: { e: number; to: number; len: number }[][] = nodes.map(() => []);
    edges.forEach((e, ei) => {
      const len = Math.hypot(nodes[e.a].x - nodes[e.b].x, nodes[e.a].z - nodes[e.b].z);
      adj[e.a].push({ e: ei, to: e.b, len });
      adj[e.b].push({ e: ei, to: e.a, len });
    });
    const mainEdges = new Set<number>();
    for (let t1 = 0; t1 < towns.length; t1++) {
      // Dijkstra from town t1; mark path edges to every other town
      const dist = nodes.map(() => Infinity);
      const prevE = nodes.map(() => -1);
      const prevN = nodes.map(() => -1);
      dist[t1] = 0;
      const seen = new Set<number>();
      for (;;) {
        let u = -1;
        let best = Infinity;
        for (let i = 0; i < nodes.length; i++) {
          if (!seen.has(i) && dist[i] < best) { best = dist[i]; u = i; }
        }
        if (u < 0) break;
        seen.add(u);
        for (const { e, to, len } of adj[u]) {
          if (dist[u] + len < dist[to]) {
            dist[to] = dist[u] + len;
            prevE[to] = e;
            prevN[to] = u;
          }
        }
      }
      for (let t2 = t1 + 1; t2 < towns.length; t2++) {
        let n = t2;
        while (n !== t1 && prevE[n] >= 0) {
          mainEdges.add(prevE[n]);
          n = prevN[n];
        }
      }
    }
    edges.forEach((e, ei) => (e.kind = mainEdges.has(ei) ? "main" : "lane"));
  }

  // ---------- curve the roads: jittered via points ----------
  for (const e of edges) {
    const a = nodes[e.a];
    const b = nodes[e.b];
    const d = Math.hypot(a.x - b.x, a.z - b.z);
    const segs = Math.max(1, Math.round(d / 700));
    const nx = -(b.z - a.z) / d;
    const nz = (b.x - a.x) / d;
    for (let s = 1; s <= segs; s++) {
      const t = s / (segs + 1);
      const wobble = (rand() - 0.5) * d * 0.22;
      e.via.push([
        a.x + (b.x - a.x) * t + nx * wobble,
        a.z + (b.z - a.z) * t + nz * wobble,
      ]);
    }
  }

  // ---------- real town street grids: inner nodes + narrow streets ----------
  // bigger towns get more inner junctions; streets connect them to the
  // piazza and to each other, so you can actually turn inside a town
  for (let ti = 0; ti < towns.length; ti++) {
    const town = towns[ti];
    const innerCount = town.radius > 170 ? 5 : town.radius > 140 ? 3 : town.radius > 115 ? 2 : 1;
    const innerIdx: number[] = [];
    for (let i = 0; i < innerCount; i++) {
      const a = (i / innerCount) * Math.PI * 2 + rand() * 0.9;
      const r = town.radius * (0.45 + rand() * 0.3);
      const n = { x: town.x + Math.cos(a) * r, z: town.z + Math.sin(a) * r };
      innerIdx.push(nodes.length);
      nodes.push(n);
      // street to the piazza
      edges.push({ a: ti, b: nodes.length - 1, via: [], kind: "lane" });
    }
    // ring connections between neighboring inner nodes
    for (let i = 0; i + 1 < innerIdx.length; i++) {
      if (rand() < 0.75) edges.push({ a: innerIdx[i], b: innerIdx[i + 1], via: [], kind: "lane" });
    }
  }

  return { towns, nodes, edges };
}
