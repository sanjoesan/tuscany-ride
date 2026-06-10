import * as THREE from "three";
import type { MapData } from "../types";
import { Terrain } from "./terrain";
import { RoadNetwork } from "./road";
import { Route, generateRoutes } from "./routes";
import { buildScenery, buildEnvironment } from "./scenery";

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
  routes: Route[] = [];
  /** lower-resolution rebuilds while the editor drags things around */
  quality: "full" | "fast" = "full";
  private worldGroup: THREE.Group | null = null;
  private envUpdate: ((t: number, focus: THREE.Vector3) => void) | null = null;

  constructor(scene: THREE.Scene, map: MapData, renderer: THREE.WebGLRenderer) {
    this.scene = scene;
    this.map = map;
    this.envUpdate = buildEnvironment(map, scene, renderer);
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
    this.terrain = new Terrain(this.map, this.quality);
    this.network = new RoadNetwork(this.map, this.terrain);
    this.terrain.setRoad(this.network.allSamples);
    this.routes = generateRoutes(this.map, this.network);

    const group = new THREE.Group();
    group.name = "world";
    group.add(this.terrain.buildMesh());
    group.add(this.network.buildMesh());
    group.add(buildScenery(this.map, this.terrain));
    this.scene.add(group);
    this.worldGroup = group;
  }

  setMap(map: MapData): void {
    this.map = map;
    this.rebuild();
  }

  update(t: number, focus: THREE.Vector3): void {
    this.envUpdate?.(t, focus);
  }
}
