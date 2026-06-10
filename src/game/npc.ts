import * as THREE from "three";
import type { World } from "../world/world";
import type { EdgePath } from "../world/road";
import { Rider } from "./rider";
import { mulberry32 } from "../world/noise";

/**
 * Ambient life: NPC riders touring the routes, cars/trucks driving the road
 * network (right-hand traffic) and pedestrians strolling through the towns.
 * Everything is simulated locally - no multiplayer, by design.
 */

const JERSEYS = [0xd0312d, 0x2e9e4f, 0xf2b705, 0x8e44ad, 0x16a085, 0xe67e22, 0xecf0f1, 0x34495e];
const BIKES = [0x202024, 0xc0c0c8, 0x2255bb, 0x991111, 0x118855];
const CAR_COLORS = [0xb8332a, 0xe8e8ec, 0x2a4d8f, 0x333338, 0x7a8288, 0xc7b299, 0x4a7023];

interface NpcRider {
  rider: Rider;
  routeIdx: number;
  dist: number;
  /** flat-ground cruising speed m/s */
  cruise: number;
}

interface Vehicle {
  object: THREE.Group;
  wheels: THREE.Mesh[];
  pathIdx: number;
  reverse: boolean;
  s: number;
  speed: number;
}

interface Pedestrian {
  object: THREE.Group;
  town: number;
  target: THREE.Vector2;
  speed: number;
  phase: number;
}

export class NpcManager {
  private world: World;
  private group = new THREE.Group();
  private riders: NpcRider[] = [];
  private vehicles: Vehicle[] = [];
  private pedestrians: Pedestrian[] = [];
  private rand = mulberry32(20260610);

  constructor(world: World) {
    this.world = world;
    this.group.name = "npcs";
  }

  /** (Re)create all NPCs for the current world. */
  build(): void {
    this.dispose();
    this.group = new THREE.Group();
    this.group.name = "npcs";
    const rand = this.rand;

    // ---------- NPC riders ----------
    const riderCount = Math.min(10, this.world.routes.length);
    for (let i = 0; i < riderCount; i++) {
      const rider = new Rider(
        BIKES[Math.floor(rand() * BIKES.length)],
        JERSEYS[Math.floor(rand() * JERSEYS.length)]
      );
      const routeIdx = Math.floor(rand() * this.world.routes.length);
      const route = this.world.routes[routeIdx];
      this.group.add(rider.object);
      this.riders.push({
        rider,
        routeIdx,
        dist: rand() * route.totalLength,
        cruise: 7.2 + rand() * 3.6, // 26..39 km/h on the flat
      });
    }

    // ---------- cars & trucks ----------
    const paths = this.world.network.paths;
    if (paths.length > 0) {
      const vehicleCount = Math.min(14, Math.max(6, Math.round(this.world.network.totalKm / 3.5)));
      for (let i = 0; i < vehicleCount; i++) {
        const isTruck = rand() < 0.25;
        const { object, wheels } = isTruck ? buildTruck(rand) : buildCar(rand);
        const pathIdx = Math.floor(rand() * paths.length);
        this.group.add(object);
        this.vehicles.push({
          object,
          wheels,
          pathIdx,
          reverse: rand() < 0.5,
          s: rand() * paths[pathIdx].length,
          speed: (isTruck ? 11 : 14) + rand() * 4, // ~40-65 km/h
        });
      }
    }

    // ---------- pedestrians ----------
    this.world.map.towns.forEach((town, ti) => {
      const count = Math.round(town.radius / 22); // ~5-8 per town
      for (let i = 0; i < count; i++) {
        const object = buildPedestrian(rand);
        this.group.add(object);
        const a = rand() * Math.PI * 2;
        const r = rand() * town.radius * 0.8;
        object.position.set(town.x + Math.cos(a) * r, 0, town.z + Math.sin(a) * r);
        this.pedestrians.push({
          object,
          town: ti,
          target: new THREE.Vector2(town.x, town.z),
          speed: 1.0 + rand() * 0.7,
          phase: rand() * 6.28,
        });
      }
    });

    this.world.scene.add(this.group);
  }

  dispose(): void {
    this.world.scene.remove(this.group);
    this.riders = [];
    this.vehicles = [];
    this.pedestrians = [];
  }

  update(dt: number, t: number): void {
    const network = this.world.network;

    // ---------- riders follow their route, slowed by gradients ----------
    for (const r of this.riders) {
      const route = this.world.routes[r.routeIdx];
      if (!route) continue;
      const at = route.at(r.dist);
      // crude but plausible: each 1 % of climb costs ~9 % speed
      const factor = Math.max(0.3, Math.min(1.6, 1 - at.grade * 9));
      const v = r.cruise * factor;
      r.dist += v * dt;
      const right = new THREE.Vector3(at.dir.z, 0, -at.dir.x);
      r.rider.object.position.copy(at.pos).addScaledVector(right, 1.3);
      r.rider.object.position.y += 0.12;
      r.rider.object.rotation.set(0, Math.atan2(-at.dir.z, at.dir.x), 0);
      r.rider.object.rotateOnAxis(new THREE.Vector3(0, 0, 1), Math.atan(at.grade));
      r.rider.setLights(this.world.environment.isNight);
      r.rider.update(dt, v, v > 1 ? 82 : 0);
    }

    // ---------- vehicles drive the network ----------
    for (const v of this.vehicles) {
      const path = network.paths[v.pathIdx];
      if (!path) continue;
      v.s += v.speed * dt;
      if (v.s >= path.length) {
        // junction reached: pick the next road
        const node = v.reverse ? path.a : path.b;
        const options: { idx: number; reverse: boolean }[] = [];
        network.paths.forEach((p, pi) => {
          if (p.a === node && pi !== v.pathIdx) options.push({ idx: pi, reverse: false });
          if (p.b === node && pi !== v.pathIdx) options.push({ idx: pi, reverse: true });
        });
        if (options.length === 0) {
          // dead end: turn around
          v.reverse = !v.reverse;
          v.s = 0;
        } else {
          const next = options[Math.floor(this.rand() * options.length)];
          v.pathIdx = next.idx;
          v.reverse = next.reverse;
          v.s = 0;
        }
        continue;
      }
      const pos = samplePath(path, v.reverse ? path.length - v.s : v.s);
      const dirX = v.reverse ? -pos.dirX : pos.dirX;
      const dirZ = v.reverse ? -pos.dirZ : pos.dirZ;
      // right-hand traffic: offset to the right of the travel direction
      v.object.position.set(pos.x + dirZ * 1.9, pos.y + 0.12, pos.z - dirX * 1.9);
      v.object.rotation.set(0, Math.atan2(-dirZ, dirX), 0);
      v.object.rotateOnAxis(new THREE.Vector3(0, 0, 1), Math.atan(v.reverse ? -pos.grade : pos.grade));
      const spin = v.speed / 0.34;
      for (const w of v.wheels) w.rotation.z -= spin * dt;
    }

    // ---------- pedestrians stroll their town ----------
    for (const p of this.pedestrians) {
      const town = this.world.map.towns[p.town];
      if (!town) continue;
      const dx = p.target.x - p.object.position.x;
      const dz = p.target.y - p.object.position.z;
      const d = Math.hypot(dx, dz);
      if (d < 1.5) {
        const a = this.rand() * Math.PI * 2;
        const r = 12 + this.rand() * town.radius * 0.75;
        p.target.set(town.x + Math.cos(a) * r, town.z + Math.sin(a) * r);
        continue;
      }
      const vx = (dx / d) * p.speed;
      const vz = (dz / d) * p.speed;
      p.object.position.x += vx * dt;
      p.object.position.z += vz * dt;
      p.object.position.y = this.world.terrain.height(p.object.position.x, p.object.position.z);
      p.object.rotation.y = Math.atan2(vx, vz);
      // walking bob
      p.object.position.y += Math.abs(Math.sin(t * 4 + p.phase)) * 0.05;
      p.object.rotation.z = Math.sin(t * 4 + p.phase) * 0.04;
    }
  }
}

/** Interpolate along an edge path at distance s (clamped). */
function samplePath(path: EdgePath, s: number): { x: number; y: number; z: number; dirX: number; dirZ: number; grade: number } {
  const samples = path.samples;
  const n = samples.length;
  const d = Math.max(0, Math.min(path.length, s));
  let i = Math.min(n - 2, Math.floor((d / path.length) * (n - 1)));
  while (i < n - 2 && samples[i + 1].dist < d) i++;
  while (i > 0 && samples[i].dist > d) i--;
  const a = samples[i];
  const b = samples[i + 1];
  const seg = b.dist - a.dist || 1;
  const t = Math.min(1, Math.max(0, (d - a.dist) / seg));
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
    dirX: a.dirX + (b.dirX - a.dirX) * t,
    dirZ: a.dirZ + (b.dirZ - a.dirZ) * t,
    grade: a.grade + (b.grade - a.grade) * t,
  };
}

// ---------------- low-poly vehicles & people (built facing +X) ----------------

/** Car body paint with door seams, handles and a dark rocker panel. */
function buildCarBodyTexture(color: number): THREE.CanvasTexture {
  const W = 256;
  const H = 128;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  const c = new THREE.Color(color);
  ctx.fillStyle = `rgb(${c.r * 255}, ${c.g * 255}, ${c.b * 255})`;
  ctx.fillRect(0, 0, W, H);
  // glossy top highlight + dark rocker panel
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, "rgba(255,255,255,0.22)");
  grad.addColorStop(0.45, "rgba(255,255,255,0)");
  grad.addColorStop(0.88, "rgba(0,0,0,0)");
  grad.addColorStop(1, "rgba(0,0,0,0.4)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  // door seams + handles
  ctx.strokeStyle = "rgba(0,0,0,0.4)";
  ctx.lineWidth = 2;
  for (const x of [W * 0.36, W * 0.66]) {
    ctx.beginPath();
    ctx.moveTo(x, 8);
    ctx.lineTo(x, H - 6);
    ctx.stroke();
  }
  ctx.fillStyle = "rgba(30,30,30,0.7)";
  ctx.fillRect(W * 0.4, H * 0.32, 16, 4);
  ctx.fillRect(W * 0.7, H * 0.32, 16, 4);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildCar(rand: () => number): { object: THREE.Group; wheels: THREE.Mesh[] } {
  const g = new THREE.Group();
  const color = CAR_COLORS[Math.floor(rand() * CAR_COLORS.length)];
  const bodyMat = new THREE.MeshStandardMaterial({
    map: buildCarBodyTexture(color),
    roughness: 0.3,
    metalness: 0.55,
  });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x16161a, roughness: 0.8 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x8fa9bd, roughness: 0.12, metalness: 0.5 });

  const body = new THREE.Mesh(new THREE.BoxGeometry(3.9, 0.62, 1.72), bodyMat);
  body.position.y = 0.62;
  g.add(body);
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.6, 1.58), glassMat);
  cabin.position.set(-0.2, 1.2, 0);
  g.add(cabin);
  // headlights / taillights
  const headMat = new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0x887744, roughness: 0.3 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0xc01818, emissive: 0x550808, roughness: 0.4 });
  for (const side of [0.55, -0.55]) {
    const hl = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.14, 0.3), headMat);
    hl.position.set(1.96, 0.72, side);
    g.add(hl);
    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.12, 0.28), tailMat);
    tl.position.set(-1.96, 0.72, side);
    g.add(tl);
  }
  const wheels: THREE.Mesh[] = [];
  const wheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.24, 12);
  wheelGeo.rotateX(Math.PI / 2);
  for (const [x, z] of [[1.25, 0.82], [1.25, -0.82], [-1.25, 0.82], [-1.25, -0.82]]) {
    const w = new THREE.Mesh(wheelGeo, darkMat);
    w.position.set(x, 0.34, z);
    g.add(w);
    wheels.push(w);
  }
  g.traverse((o) => (o.castShadow = true));
  return { object: g, wheels };
}

function buildTruck(rand: () => number): { object: THREE.Group; wheels: THREE.Mesh[] } {
  const g = new THREE.Group();
  const cabColor = CAR_COLORS[Math.floor(rand() * CAR_COLORS.length)];
  const cabMat = new THREE.MeshStandardMaterial({ color: cabColor, roughness: 0.4, metalness: 0.4 });
  const boxMat = new THREE.MeshStandardMaterial({ color: 0xd8d4cc, roughness: 0.7 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x16161a, roughness: 0.8 });

  const cab = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.5, 2.1), cabMat);
  cab.position.set(2.2, 1.15, 0);
  g.add(cab);
  const box = new THREE.Mesh(new THREE.BoxGeometry(4.6, 2.2, 2.2), boxMat);
  box.position.set(-1, 1.55, 0);
  g.add(box);
  const wheels: THREE.Mesh[] = [];
  const wheelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.3, 12);
  wheelGeo.rotateX(Math.PI / 2);
  for (const [x, z] of [[2.2, 1.0], [2.2, -1.0], [-0.2, 1.0], [-0.2, -1.0], [-2.2, 1.0], [-2.2, -1.0]]) {
    const w = new THREE.Mesh(wheelGeo, darkMat);
    w.position.set(x, 0.42, z);
    g.add(w);
    wheels.push(w);
  }
  g.traverse((o) => (o.castShadow = true));
  return { object: g, wheels };
}

function buildPedestrian(rand: () => number): THREE.Group {
  const g = new THREE.Group();
  const shirt = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHSL(rand(), 0.5 + rand() * 0.3, 0.5),
    roughness: 0.8,
  });
  const pants = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHSL(0.6, 0.25, 0.2 + rand() * 0.3),
    roughness: 0.8,
  });
  const skin = new THREE.MeshStandardMaterial({ color: 0xd9a47e, roughness: 0.7 });

  const legs = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.13, 0.78, 8), pants);
  legs.position.y = 0.39;
  g.add(legs);
  const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.17, 0.62, 8), shirt);
  torso.position.y = 1.08;
  g.add(torso);
  const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.13, 1), skin);
  head.position.y = 1.55;
  g.add(head);
  g.traverse((o) => (o.castShadow = true));
  return g;
}
