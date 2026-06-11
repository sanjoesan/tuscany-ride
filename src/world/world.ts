import * as THREE from "three";
import type { MapData } from "../types";
import { Terrain, type Season } from "./terrain";
import { RoadNetwork } from "./road";
import { River } from "./river";
import { Route, generateRoutes } from "./routes";
import { buildScenery, Environment } from "./scenery";

/**
 * Owns everything that belongs to the current map: terrain, road network,
 * routes and scenery. Can be rebuilt in place when the world builder
 * changes the map.
 */
export class World {
  readonly scene: THREE.Scene;
  map: MapData;
  terrain!: Terrain;
  network!: RoadNetwork;
  river!: River;
  routes: Route[] = [];
  /** lower-resolution rebuilds while the editor drags things around */
  quality: "full" | "fast" = "full";
  season: Season = "summer";
  readonly environment: Environment;
  private worldGroup: THREE.Group | null = null;
  /** boats & buoys that bob on the sea (collected once per rebuild) */
  private bobbers: { obj: THREE.Object3D; baseY: number; baseRoll: number; phase: number; amp: number; roll: number }[] = [];

  constructor(scene: THREE.Scene, map: MapData, renderer: THREE.WebGLRenderer) {
    this.scene = scene;
    this.map = map;
    this.environment = new Environment(map, scene, renderer);
    this.rebuild();
  }

  /** Full regeneration from this.map (terrain, roads, routes, scenery). */
  rebuild(): void {
    if (this.worldGroup) {
      this.scene.remove(this.worldGroup);
      this.worldGroup.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
      });
    }
    this.terrain = new Terrain(this.map, this.quality, this.season);
    this.river = new River(this.map, this.terrain);
    this.terrain.setRiver(this.river.samples);
    this.network = new RoadNetwork(this.map, this.terrain);
    this.terrain.setRoad(this.network.allSamples);
    this.routes = generateRoutes(this.map, this.network);

    const group = new THREE.Group();
    group.name = "world";
    group.add(this.terrain.buildMesh());
    group.add(this.network.buildMesh());
    const riverMesh = this.river.buildMesh();
    if (riverMesh) group.add(riverMesh);
    group.add(this.river.buildBridges(this.network));
    group.add(buildScenery(this.map, this.terrain, this.network));
    this.scene.add(group);
    this.worldGroup = group;

    // collect the things that bob on the water for the per-frame animation
    this.bobbers = [];
    group.traverse((o) => {
      const b = o.userData.bob as { phase: number; amp: number; roll: number } | undefined;
      if (b) {
        this.bobbers.push({
          obj: o,
          baseY: o.position.y,
          baseRoll: o.rotation.z,
          phase: b.phase,
          amp: b.amp,
          roll: b.roll,
        });
      }
    });
  }

  setMap(map: MapData): void {
    this.map = map;
    this.rebuild();
  }

  update(t: number, focus: THREE.Vector3): void {
    this.environment.update(t, focus);
    for (const b of this.bobbers) {
      b.obj.position.y = b.baseY + Math.sin(t * 1.1 + b.phase) * b.amp;
      if (b.roll) b.obj.rotation.z = b.baseRoll + Math.sin(t * 0.9 + b.phase) * b.roll;
    }
  }
}
