import * as THREE from "three";
import type { World } from "../world/world";
import type { Route } from "../world/routes";
import type { Telemetry } from "../types";
import { samplePath } from "../world/road";
import { BikePhysics } from "../sim/physics";
import { Rider } from "./rider";
import { Hud } from "./hud";
import { RideRecorder, gameToGps } from "../fit/recorder";

export interface TurnOption {
  pathIdx: number;
  reverse: boolean;
  /** departure angle relative to current heading: - = left, + = right */
  angle: number;
}

export type CameraMode = "fpv" | "chase" | "front" | "side";
const CAMERA_MODES: CameraMode[] = ["chase", "fpv", "front", "side"];

/**
 * Active ride: moves the rider along the road from live trainer power,
 * follows with the camera, records for FIT export and feeds the HUD.
 */
export class RideController {
  readonly physics = new BikePhysics();
  readonly recorder = new RideRecorder();
  readonly rider: Rider;
  private world: World;
  private route: Route | null = null;
  private camera: THREE.PerspectiveCamera;
  private hud: Hud;
  private telemetry: Telemetry;
  /** distance along the route, meters (route mode) */
  dist = 0;
  /** total ridden distance, meters */
  totalDist = 0;
  private rideTime = 0;
  // ---- free-roam state ----
  navMode: "route" | "free" = "route";
  private freePath = 0;
  private freeReverse = false;
  private freeS = 0;
  private turnOptions: TurnOption[] = [];
  private turnChoice = 0;
  /** HUD callback: junction ahead with these exits (null = no junction) */
  onTurnOptions: (options: TurnOption[] | null, selected: number) => void = () => {};
  private camMode: CameraMode = "chase";
  private camPos = new THREE.Vector3();
  private camTarget = new THREE.Vector3();
  private grade = 0;
  /** difficulty 0..1 scales how much of the slope is sent to the trainer */
  difficulty = 0.5;
  onGrade: (grade: number) => void = () => {};

  constructor(
    world: World,
    camera: THREE.PerspectiveCamera,
    hud: Hud,
    telemetry: Telemetry,
    bikeColor = 0xd6452c,
    jerseyColor = 0x2270c9
  ) {
    this.world = world;
    this.camera = camera;
    this.hud = hud;
    this.telemetry = telemetry;
    this.rider = new Rider(bikeColor, jerseyColor, true, true);
  }

  start(massKg: number, difficulty: number, route: Route): void {
    this.navMode = "route";
    this.route = route;
    this.hud.setPath(route.samples, route.totalLength);
    this.begin(massKg, difficulty);
  }

  /** Free roam: start at a node and turn wherever you like. */
  startFree(massKg: number, difficulty: number, startNode: number): void {
    this.navMode = "free";
    this.route = null;
    // leave the start node on its widest road
    let best = -1;
    let bestHalf = -1;
    this.world.network.paths.forEach((p, pi) => {
      if (p.a === startNode || p.b === startNode) {
        if (p.half > bestHalf) {
          bestHalf = p.half;
          best = pi;
        }
      }
    });
    this.freePath = Math.max(0, best);
    this.freeReverse = this.world.network.paths[this.freePath]?.b === startNode;
    this.freeS = 0;
    this.hud.setFreeMode(true);
    this.begin(massKg, difficulty);
  }

  private begin(massKg: number, difficulty: number): void {
    this.physics.massKg = massKg;
    this.physics.v = 0;
    this.difficulty = difficulty;
    this.dist = 0;
    this.totalDist = 0;
    this.rideTime = 0;
    this.turnOptions = [];
    this.world.scene.add(this.rider.object);
    this.hud.show();
    this.recorder.start();
    // place camera behind the start so the first frame isn't a jump cut
    const at = this.currentAt();
    this.camPos.copy(at.pos).addScaledVector(at.dir, -9).add(new THREE.Vector3(0, 4, 0));
  }

  /** Position/direction/grade either from the route or the free-roam edge. */
  private currentAt(): { pos: THREE.Vector3; dir: THREE.Vector3; grade: number } {
    if (this.navMode === "route" && this.route) return this.route.at(this.dist);
    const path = this.world.network.paths[this.freePath];
    const ps = samplePath(path, this.freeReverse ? path.length - this.freeS : this.freeS);
    const sign = this.freeReverse ? -1 : 1;
    return {
      pos: new THREE.Vector3(ps.x, ps.y, ps.z),
      dir: new THREE.Vector3(ps.dirX * sign, 0, ps.dirZ * sign).normalize(),
      grade: ps.grade * sign,
    };
  }

  /** true while the junction-exit chooser is showing (dev/testing) */
  get hasTurnOptions(): boolean {
    return this.turnOptions.length > 1;
  }

  /** cycle the highlighted exit at the junction ahead (-1 left, +1 right) */
  chooseTurn(delta: number): void {
    if (this.turnOptions.length === 0) return;
    this.turnChoice = Math.min(this.turnOptions.length - 1, Math.max(0, this.turnChoice + delta));
    this.onTurnOptions(this.turnOptions, this.turnChoice);
  }

  /** turn around on the spot */
  uTurn(): void {
    if (this.navMode !== "free") return;
    const path = this.world.network.paths[this.freePath];
    this.freeReverse = !this.freeReverse;
    this.freeS = path.length - this.freeS;
    this.turnOptions = [];
    this.onTurnOptions(null, 0);
  }

  /** advance along the free-roam network, handling junction crossings */
  private advanceFree(ds: number): void {
    const network = this.world.network;
    this.freeS += ds;
    let path = network.paths[this.freePath];

    // junction crossing
    while (this.freeS >= path.length) {
      const overshoot = this.freeS - path.length;
      const node = this.freeReverse ? path.a : path.b;
      if (this.turnOptions.length === 0) this.computeTurnOptions();
      const pick = this.turnOptions[this.turnChoice] as TurnOption | undefined;
      if (!pick) {
        this.freeReverse = !this.freeReverse; // safety net
        this.freeS = 0;
      } else {
        // (a dead end's only option is the same edge reversed = u-turn)
        this.freePath = pick.pathIdx;
        this.freeReverse = pick.reverse;
        this.freeS = overshoot;
      }
      path = network.paths[this.freePath];
      this.turnOptions = [];
      this.onTurnOptions(null, 0);
    }

    // approaching a junction: offer the exits
    const distToEnd = path.length - this.freeS;
    if (distToEnd < 75) {
      if (this.turnOptions.length === 0) {
        this.computeTurnOptions();
        this.onTurnOptions(this.turnOptions.length > 1 ? this.turnOptions : null, this.turnChoice);
      }
    } else if (this.turnOptions.length > 0) {
      this.turnOptions = [];
      this.onTurnOptions(null, 0);
    }
  }

  /** exits at the node we are heading towards, sorted left-to-right */
  private computeTurnOptions(): void {
    const network = this.world.network;
    const path = network.paths[this.freePath];
    const node = this.freeReverse ? path.a : path.b;
    const heading = this.currentAt().dir;
    const options: TurnOption[] = [];
    network.paths.forEach((p, pi) => {
      const fromA = p.a === node;
      const fromB = p.b === node;
      if (!fromA && !fromB) return;
      // skip going straight back onto the road we arrived on
      if (pi === this.freePath) return;
      const reverse = fromB;
      const s0 = reverse ? p.samples[p.samples.length - 1] : p.samples[0];
      const sign = reverse ? -1 : 1;
      const dx = s0.dirX * sign;
      const dz = s0.dirZ * sign;
      // signed angle from heading to departure direction (+ = right turn)
      const cross = heading.x * dz - heading.z * dx;
      const dot = heading.x * dx + heading.z * dz;
      options.push({ pathIdx: pi, reverse, angle: Math.atan2(cross, dot) });
    });
    options.sort((a, b) => a.angle - b.angle);
    if (options.length === 0) {
      // dead end: only choice is back
      options.push({ pathIdx: this.freePath, reverse: !this.freeReverse, angle: Math.PI });
    }
    this.turnOptions = options;
    // default: the straightest continuation
    let best = 0;
    options.forEach((o, i) => {
      if (Math.abs(o.angle) < Math.abs(options[best].angle)) best = i;
    });
    this.turnChoice = best;
  }

  stop(): void {
    this.world.scene.remove(this.rider.object);
    this.onTurnOptions(null, 0);
    this.hud.setFreeMode(false);
    this.hud.hide();
  }

  cycleCamera(): void {
    this.camMode = CAMERA_MODES[(CAMERA_MODES.indexOf(this.camMode) + 1) % CAMERA_MODES.length];
  }

  update(dt: number): void {
    const at = this.currentAt();
    this.grade = at.grade;

    const v = this.physics.step(this.telemetry.power, this.grade, dt);
    if (this.navMode === "route") {
      this.dist += v * dt;
    } else {
      this.advanceFree(v * dt);
    }
    this.totalDist += v * dt;
    this.rideTime += dt;

    // rider pose: in the right-hand lane, facing travel direction, tilted with the slope
    // (right = forward x up; Europe drives on the right)
    const right = new THREE.Vector3(-at.dir.z, 0, at.dir.x);
    const pos = at.pos.clone().addScaledVector(right, 1.4);
    pos.y += 0.12; // asphalt sits slightly above the sampled centerline
    this.rider.object.position.copy(pos);
    // bike model is built facing +X; align +X with the travel direction
    this.rider.object.rotation.set(0, Math.atan2(-at.dir.z, at.dir.x), 0);
    this.rider.object.rotateOnAxis(new THREE.Vector3(0, 0, 1), Math.atan(this.grade));
    this.rider.update(dt, v, this.telemetry.cadence);

    // camera
    const up = new THREE.Vector3(0, 1, 0);
    let targetPos: THREE.Vector3;
    let lookAt: THREE.Vector3;
    let lerpK = 1 - Math.exp(-dt * 3.2);
    if (this.camMode === "fpv") {
      // first person: eye height over the handlebars, subtle pedaling bob
      const bob = Math.sin(this.rideTime * (this.telemetry.cadence / 60) * Math.PI * 2) * 0.025;
      targetPos = pos.clone().addScaledVector(at.dir, 0.45).addScaledVector(up, 1.62 + bob);
      lookAt = pos.clone().addScaledVector(at.dir, 26).addScaledVector(up, 1.1 + Math.atan(this.grade) * 18);
      lerpK = 1 - Math.exp(-dt * 14); // tight, no rubber-banding
    } else if (this.camMode === "chase") {
      targetPos = pos.clone().addScaledVector(at.dir, -9).addScaledVector(up, 3.6);
      lookAt = pos.clone().addScaledVector(at.dir, 7).addScaledVector(up, 1.2);
    } else if (this.camMode === "front") {
      targetPos = pos.clone().addScaledVector(at.dir, 10).addScaledVector(up, 2.4);
      lookAt = pos.clone().addScaledVector(up, 1.1);
    } else {
      const side = new THREE.Vector3(-at.dir.z, 0, at.dir.x);
      targetPos = pos.clone().addScaledVector(side, 11).addScaledVector(up, 3).addScaledVector(at.dir, 2);
      lookAt = pos.clone().addScaledVector(up, 1);
    }
    this.rider.setBodyVisible(this.camMode !== "fpv");
    this.rider.setLights(this.world.environment.isNight);
    this.camPos.lerp(targetPos, lerpK);
    this.camTarget.lerp(lookAt, 1 - Math.exp(-dt * (this.camMode === "fpv" ? 14 : 5)));
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camTarget);

    // resistance to the trainer (scaled by difficulty; downhill sent as-is, halved)
    const sentGrade = this.grade >= 0 ? this.grade * this.difficulty : this.grade * 0.5;
    this.onGrade(sentGrade);

    // recording
    const gps = gameToGps(pos.x, pos.z);
    this.recorder.maybeSample({
      power: this.telemetry.power,
      cadence: this.telemetry.cadence,
      heartRate: this.telemetry.heartRate,
      speed: v,
      distance: this.totalDist,
      altitude: pos.y,
      lat: gps.lat,
      lon: gps.lon,
    });

    this.hud.update({
      power: this.telemetry.power,
      speedKmh: this.physics.kmh,
      cadence: this.telemetry.cadence,
      hr: this.telemetry.heartRate,
      grade: this.grade,
      distanceM: this.totalDist,
      timeS: this.rideTime,
      elevation: pos.y,
      rideDist: this.dist,
    });
  }
}
