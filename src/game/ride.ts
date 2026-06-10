import * as THREE from "three";
import type { World } from "../world/world";
import type { Route } from "../world/routes";
import type { Telemetry } from "../types";
import { BikePhysics } from "../sim/physics";
import { Rider } from "./rider";
import { Hud } from "./hud";
import { RideRecorder, gameToGps } from "../fit/recorder";

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
  private route!: Route;
  private camera: THREE.PerspectiveCamera;
  private hud: Hud;
  private telemetry: Telemetry;
  /** distance along the road loop, meters */
  dist = 0;
  /** total ridden distance, meters */
  totalDist = 0;
  private rideTime = 0;
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
    this.route = route;
    this.physics.massKg = massKg;
    this.physics.v = 0;
    this.difficulty = difficulty;
    this.dist = 0;
    this.totalDist = 0;
    this.rideTime = 0;
    this.world.scene.add(this.rider.object);
    this.hud.setPath(route.samples, route.totalLength);
    this.hud.show();
    this.recorder.start();
    // place camera behind the start so the first frame isn't a jump cut
    const at = route.at(0);
    this.camPos.copy(at.pos).addScaledVector(at.dir, -9).add(new THREE.Vector3(0, 4, 0));
  }

  stop(): void {
    this.world.scene.remove(this.rider.object);
    this.hud.hide();
  }

  cycleCamera(): void {
    this.camMode = CAMERA_MODES[(CAMERA_MODES.indexOf(this.camMode) + 1) % CAMERA_MODES.length];
  }

  update(dt: number): void {
    const at = this.route.at(this.dist);
    this.grade = at.grade;

    const v = this.physics.step(this.telemetry.power, this.grade, dt);
    this.dist += v * dt;
    this.totalDist += v * dt;
    this.rideTime += dt;

    // rider pose: in the right-hand lane, facing travel direction, tilted with the slope
    const right = new THREE.Vector3(at.dir.z, 0, -at.dir.x);
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
