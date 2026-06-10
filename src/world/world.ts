import * as THREE from "three";
import type { MapData } from "../types";
import { Terrain } from "./terrain";
import { Road } from "./road";
import { buildScenery, buildEnvironment } from "./scenery";

/**
 * Owns everything that belongs to the current map: terrain, road, scenery.
 * Can be rebuilt in place when the world builder changes the map.
 */
export class World {
  readonly scene: THREE.Scene;
  map: MapData;
  terrain!: Terrain;
  road!: Road;
  private worldGroup: THREE.Group | null = null;
  private envUpdate: ((t: number, focus: THREE.Vector3) => void) | null = null;

  constructor(scene: THREE.Scene, map: MapData, renderer: THREE.WebGLRenderer) {
    this.scene = scene;
    this.map = map;
    this.envUpdate = buildEnvironment(map, scene, renderer);
    this.rebuild();
  }

  /** Full regeneration from this.map (terrain, road, scenery). */
  rebuild(): void {
    if (this.worldGroup) {
      this.scene.remove(this.worldGroup);
      this.worldGroup.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
      });
    }
    this.terrain = new Terrain(this.map);
    this.road = new Road(this.map, this.terrain);
    this.terrain.setRoad(this.road.samples);

    const group = new THREE.Group();
    group.name = "world";
    group.add(this.terrain.buildMesh());
    group.add(this.road.buildMesh());
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
