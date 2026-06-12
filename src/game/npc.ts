import * as THREE from "three";
import type { World } from "../world/world";
import { samplePath } from "../world/road";
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
  /** cruising speed m/s */
  speed: number;
  /** current speed (slows behind riders before overtaking) */
  curSpeed: number;
  /** lateral offset from the centerline (1.9 = own lane, ~4 = overtaking) */
  lane: number;
}

interface Pedestrian {
  object: THREE.Group;
  limbs: { legL: THREE.Object3D | null; legR: THREE.Object3D | null; armL: THREE.Object3D; armR: THREE.Object3D };
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
        const isTruck = rand() < 0.22;
        // most cars are little 1960s bubble cars; some are the bigger saloon
        const built = isTruck ? buildTruck(rand) : rand() < 0.62 ? buildBubbleCar(rand) : buildCar(rand);
        const { object, wheels } = built;
        const pathIdx = Math.floor(rand() * paths.length);
        this.group.add(object);
        const speed = (isTruck ? 11 : 14) + rand() * 4; // ~40-65 km/h
        this.vehicles.push({
          object,
          wheels,
          pathIdx,
          reverse: rand() < 0.5,
          s: rand() * paths[pathIdx].length,
          speed,
          curSpeed: speed,
          lane: 1.9,
        });
      }
    }

    // ---------- pedestrians ----------
    this.world.map.towns.forEach((town, ti) => {
      const count = Math.round(town.radius / 16); // ~8-13 per town
      for (let i = 0; i < count; i++) {
        const { object, limbs } = buildPedestrian(rand);
        this.group.add(object);
        const a = rand() * Math.PI * 2;
        const r = rand() * town.radius * 0.8;
        object.position.set(town.x + Math.cos(a) * r, 0, town.z + Math.sin(a) * r);
        this.pedestrians.push({
          object,
          limbs,
          town: ti,
          target: new THREE.Vector2(town.x, town.z),
          speed: 0.9 + rand() * 0.8,
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

  update(dt: number, t: number, player: { pos: THREE.Vector3; speed: number } | null = null): void {
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
      // right = forward x up (Europe rides on the right)
      r.rider.object.position
        .copy(at.pos)
        .addScaledVector(new THREE.Vector3(-at.dir.z, 0, at.dir.x), 1.3);
      r.rider.object.position.y += 0.12;
      r.rider.object.rotation.set(0, Math.atan2(-at.dir.z, at.dir.x), 0);
      r.rider.object.rotateOnAxis(new THREE.Vector3(0, 0, 1), Math.atan(at.grade));
      r.rider.setLights(this.world.environment.isNight);
      r.rider.update(dt, v, v > 1 ? 82 : 0);
    }

    // ---------- vehicles drive the network (and overtake riders) ----------
    for (const v of this.vehicles) {
      const path = network.paths[v.pathIdx];
      if (!path) continue;

      const pos = samplePath(path, v.reverse ? path.length - v.s : v.s);
      const dirX = v.reverse ? -pos.dirX : pos.dirX;
      const dirZ = v.reverse ? -pos.dirZ : pos.dirZ;

      // look ahead for cyclists in our lane: slow down, pull left to pass,
      // then merge back - like a real driver. On narrow lanes there is no
      // second lane: drive near the middle and give less clearance.
      const narrow = path.kind === "lane";
      let laneTarget = narrow ? 0.7 : 1.9;
      let speedTarget = narrow ? v.speed * 0.75 : v.speed;
      const consider = (rp: THREE.Vector3, rSpeed: number) => {
        // measured from the road centerline so the check is stable while
        // the car itself swings out
        const dx = rp.x - pos.x;
        const dz = rp.z - pos.z;
        const ahead = dx * dirX + dz * dirZ; // along travel
        const lateral = dx * -dirZ + dz * dirX; // + = right of travel
        const inOurLane = lateral > -0.5 && lateral < 3.6;
        if (inOurLane && ahead > -8 && ahead < 30) {
          laneTarget = narrow ? -1.3 : -1.5; // pull out to pass
          if (ahead > 4 && v.lane > 0.2) {
            // not pulled out yet - hang back behind the rider
            speedTarget = Math.min(speedTarget, Math.max(rSpeed * 0.9, 3));
          }
        }
      };
      if (player) consider(player.pos, player.speed);
      for (const r of this.riders) consider(r.rider.object.position, r.cruise);

      v.lane += (laneTarget - v.lane) * Math.min(1, dt * 1.8);
      v.curSpeed += (speedTarget - v.curSpeed) * Math.min(1, dt * 2.2);
      v.s += v.curSpeed * dt;

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
          // traffic prefers the main roads (3x weight)
          const weighted: typeof options = [];
          for (const o of options) {
            weighted.push(o);
            if (network.paths[o.idx].kind === "main") weighted.push(o, o);
          }
          const next = weighted[Math.floor(this.rand() * weighted.length)];
          v.pathIdx = next.idx;
          v.reverse = next.reverse;
          v.s = 0;
        }
        continue;
      }

      // right-hand traffic: right = forward x up = (-dirZ, dirX)
      v.object.position.set(
        pos.x - dirZ * v.lane,
        pos.y + 0.12,
        pos.z + dirX * v.lane
      );
      v.object.rotation.set(0, Math.atan2(-dirZ, dirX), 0);
      v.object.rotateOnAxis(new THREE.Vector3(0, 0, 1), Math.atan(v.reverse ? -pos.grade : pos.grade));
      const spin = v.curSpeed / 0.34;
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
      // proper walk: legs and arms swing in opposite phase + a slight bob
      p.phase += dt * p.speed * 3.4;
      const swing = Math.sin(p.phase);
      if (p.limbs.legL) p.limbs.legL.rotation.x = swing * 0.55;
      if (p.limbs.legR) p.limbs.legR.rotation.x = -swing * 0.55;
      p.limbs.armL.rotation.x = -swing * 0.45;
      p.limbs.armR.rotation.x = swing * 0.45;
      p.object.position.y += Math.abs(Math.sin(p.phase)) * 0.035;
    }
  }
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

// period pastels for the little bubble cars (Fiat 500 / 600 era)
const BUBBLE_COLORS = [0xe7ddc4, 0xa8c4c0, 0xc0392b, 0x7d9b6a, 0xd99a2b, 0x6b8cae, 0xf0ece2, 0xcf6a3a];

/** A rounded 1960s bubble car - short body, domed roof, round headlamps. */
function buildBubbleCar(rand: () => number): { object: THREE.Group; wheels: THREE.Mesh[] } {
  const g = new THREE.Group();
  const color = BUBBLE_COLORS[Math.floor(rand() * BUBBLE_COLORS.length)];
  const bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.35, metalness: 0.5 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x8fa9bd, roughness: 0.12, metalness: 0.5 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x16161a, roughness: 0.8 });
  const chromeMat = new THREE.MeshStandardMaterial({ color: 0xcccfd3, roughness: 0.3, metalness: 0.9 });

  const body = new THREE.Mesh(new THREE.BoxGeometry(2.7, 0.78, 1.42), bodyMat);
  body.position.y = 0.6;
  g.add(body);
  // round off the nose & tail with low domes
  for (const ex of [1.35, -1.35]) {
    const end = new THREE.Mesh(new THREE.SphereGeometry(0.72, 14, 10), bodyMat);
    end.scale.set(0.5, 0.55, 0.71);
    end.position.set(ex, 0.62, 0);
    g.add(end);
  }
  // greenhouse: glass band + a rounded body-colour roof dome
  const glass = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.5, 1.3), glassMat);
  glass.position.set(-0.1, 1.12, 0);
  g.add(glass);
  const roof = new THREE.Mesh(new THREE.SphereGeometry(0.86, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), bodyMat);
  roof.scale.set(0.92, 0.5, 0.78);
  roof.position.set(-0.15, 1.32, 0);
  g.add(roof);

  // round headlamps, simple taillights, chrome bumpers
  const headMat = new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0x887744, roughness: 0.3 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0xc01818, emissive: 0x550808, roughness: 0.4 });
  const lampGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.08, 12);
  lampGeo.rotateZ(Math.PI / 2);
  for (const side of [0.45, -0.45]) {
    const hl = new THREE.Mesh(lampGeo, headMat);
    hl.position.set(1.5, 0.74, side);
    g.add(hl);
    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.12, 0.2), tailMat);
    tl.position.set(-1.62, 0.74, side);
    g.add(tl);
  }
  for (const ex of [1.55, -1.55]) {
    const bumper = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 1.2), chromeMat);
    bumper.position.set(ex, 0.46, 0);
    g.add(bumper);
  }

  // four small wheels (same orientation as the other vehicles so rolling works)
  const wheels: THREE.Mesh[] = [];
  const wheelGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.22, 12);
  wheelGeo.rotateX(Math.PI / 2);
  for (const [x, z] of [[0.95, 0.66], [0.95, -0.66], [-0.95, 0.66], [-0.95, -0.66]]) {
    const w = new THREE.Mesh(wheelGeo, darkMat);
    w.position.set(x, 0.3, z);
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

const SKIN_TONES = [0xe8c39e, 0xd9a47e, 0xc98e66, 0xa66a44, 0x8d5524];

/** Articulated villager: swinging arms/legs, dresses, hats, varied colors. */
function buildPedestrian(rand: () => number): {
  object: THREE.Group;
  limbs: { legL: THREE.Object3D | null; legR: THREE.Object3D | null; armL: THREE.Object3D; armR: THREE.Object3D };
} {
  const g = new THREE.Group();
  const isWoman = rand() < 0.5;
  const shirtColor = new THREE.Color().setHSL(rand(), 0.45 + rand() * 0.35, 0.42 + rand() * 0.25);
  const shirt = new THREE.MeshStandardMaterial({ color: shirtColor, roughness: 0.85 });
  const pants = new THREE.MeshStandardMaterial({
    color: new THREE.Color().setHSL(0.58 + rand() * 0.1, 0.2 + rand() * 0.2, 0.2 + rand() * 0.25),
    roughness: 0.85,
  });
  const skin = new THREE.MeshStandardMaterial({
    color: SKIN_TONES[Math.floor(rand() * SKIN_TONES.length)],
    roughness: 0.7,
  });
  const hairMat = new THREE.MeshStandardMaterial({
    color: rand() < 0.25 ? 0xbfb6a8 : new THREE.Color().setHSL(0.08, 0.4, 0.08 + rand() * 0.25),
    roughness: 0.9,
  });

  let legL: THREE.Object3D | null = null;
  let legR: THREE.Object3D | null = null;

  if (isWoman && rand() < 0.7) {
    // dress: cone skirt, no visible legs
    const skirt = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.95, 10), shirt);
    skirt.position.y = 0.55;
    g.add(skirt);
  } else {
    // hip-pivoting legs
    for (const side of [1, -1]) {
      const hip = new THREE.Group();
      hip.position.set(0.09 * side, 0.82, 0);
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.055, 0.8, 7), pants);
      leg.position.y = -0.4;
      hip.add(leg);
      const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.07, 0.24), pants);
      shoe.position.set(0, -0.8, 0.05);
      hip.add(shoe);
      g.add(hip);
      if (side === 1) legL = hip;
      else legR = hip;
    }
  }

  // torso with shoulders
  const torso = new THREE.Mesh(new THREE.CylinderGeometry(0.17, isWoman ? 0.15 : 0.19, 0.55, 9), shirt);
  torso.position.y = 1.12;
  g.add(torso);

  // shoulder-pivoting arms with skin hands
  const mkArm = (side: number): THREE.Group => {
    const shoulder = new THREE.Group();
    shoulder.position.set(0.23 * side, 1.36, 0);
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.045, 0.55, 6), shirt);
    arm.position.y = -0.26;
    shoulder.add(arm);
    const hand = new THREE.Mesh(new THREE.IcosahedronGeometry(0.05, 1), skin);
    hand.position.y = -0.56;
    shoulder.add(hand);
    g.add(shoulder);
    return shoulder;
  };
  const armL = mkArm(1);
  const armR = mkArm(-1);

  // head, hair / hat
  const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.125, 1), skin);
  head.position.y = 1.56;
  g.add(head);
  if (rand() < 0.3) {
    // sun hat
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.21, 0.03, 12), hairMat);
    brim.position.y = 1.66;
    g.add(brim);
    const top = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.12, 0.1, 10), hairMat);
    top.position.y = 1.72;
    g.add(top);
  } else {
    const hair = new THREE.Mesh(new THREE.IcosahedronGeometry(0.13, 1), hairMat);
    hair.scale.set(1, 0.75, 1);
    hair.position.y = 1.62;
    g.add(hair);
  }

  g.traverse((o) => (o.castShadow = true));
  return { object: g, limbs: { legL, legR, armL, armR } };
}
