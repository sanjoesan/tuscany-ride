import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { World } from "../world/world";
import type { MapData, SceneryType } from "../types";
import { saveMapLocal, mapFromSeed } from "../world/mapData";
import { toast } from "../game/hud";

type Tool = "select" | "road" | "place" | "town";

const $ = (id: string) => document.getElementById(id)!;

interface RoadMarker {
  mesh: THREE.Mesh;
  kind: "node" | "via";
  node?: number;
  edge?: number;
  viaIdx?: number;
}

/**
 * The world builder. Operates on a working copy of the map; the world is
 * rebuilt live (in fast quality) so edits are immediately visible.
 * "Use & Exit" commits the copy, "Exit" restores the original.
 *
 * Road tool: blue = junctions (drag), orange = curve points (drag,
 * right-click deletes, double-click on the ground near a road inserts one).
 */
export class Editor {
  private world: World;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private controls: OrbitControls;
  private map: MapData;
  private original: string;
  private tool: Tool = "select";
  private raycaster = new THREE.Raycaster();
  private markers = new THREE.Group();
  private roadMarkers: RoadMarker[] = [];
  private sceneryMarkers: THREE.Mesh[] = [];
  private dragMarker: RoadMarker | null = null;
  private selectedScenery = -1;
  private rebuildTimer: number | null = null;
  private disposed = false;
  onExit: (applied: boolean) => void = () => {};

  private viaGeo = new THREE.SphereGeometry(5, 12, 10);
  private nodeGeo = new THREE.SphereGeometry(8, 12, 10);
  private viaMat = new THREE.MeshBasicMaterial({ color: 0xff8c1a });
  private nodeMat = new THREE.MeshBasicMaterial({ color: 0x3da5ff });
  private markerMatSel = new THREE.MeshBasicMaterial({ color: 0xffe14a });
  private sceneryMat = new THREE.MeshBasicMaterial({ color: 0x3db5ff, wireframe: true });

  constructor(world: World, camera: THREE.PerspectiveCamera, renderer: THREE.WebGLRenderer) {
    this.world = world;
    this.camera = camera;
    this.renderer = renderer;
    this.map = JSON.parse(JSON.stringify(world.map)) as MapData;
    this.original = JSON.stringify(world.map);

    this.controls = new OrbitControls(camera, renderer.domElement);
    this.controls.maxPolarAngle = Math.PI / 2 - 0.04;
    const t0 = this.map.towns[0];
    this.controls.target.set(t0.x, 0, t0.z);
    camera.position.set(t0.x + 350, 450, t0.z + 350);
    this.controls.update();

    this.world.scene.add(this.markers);
    this.refreshMarkers();
    this.bindUi();
    this.bindPointer();
    $("editor-panel").classList.remove("hidden");
    ($("ed-seed") as HTMLInputElement).value = String(this.map.seed);
    ($("ed-hill") as HTMLInputElement).value = String(this.map.hilliness);
    ($("ed-name") as HTMLInputElement).value = this.map.name;
  }

  // ---------------- UI ----------------
  private bindUi(): void {
    document.querySelectorAll<HTMLButtonElement>(".ed-tool").forEach((btn) => {
      btn.onclick = () => {
        document.querySelectorAll(".ed-tool").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        this.tool = btn.dataset.tool as Tool;
        $("ed-place-section").style.display = this.tool === "place" ? "" : "none";
        this.refreshMarkers();
      };
    });
    ($("ed-seed") as HTMLInputElement).onchange = (e) => {
      this.regenerate(Number((e.target as HTMLInputElement).value) | 0);
    };
    ($("ed-hill") as HTMLInputElement).onchange = (e) => {
      this.map.hilliness = Number((e.target as HTMLInputElement).value);
      this.scheduleRebuild(0);
    };
    ($("ed-name") as HTMLInputElement).onchange = (e) => {
      this.map.name = (e.target as HTMLInputElement).value || "Custom Map";
    };
    $("ed-regen").onclick = () => {
      this.regenerate((Math.random() * 100000) | 0);
    };
    $("ed-save").onclick = () => {
      const blob = new Blob([JSON.stringify(this.map, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${this.map.name.replace(/[^a-z0-9]+/gi, "_")}.json`;
      a.click();
      toast("Map saved as JSON");
    };
    $("ed-apply").onclick = () => {
      saveMapLocal(this.map);
      this.dispose(true);
    };
    $("ed-exit").onclick = () => {
      this.dispose(false);
    };
  }

  /** New seed = new towns, road network and terrain (keeps name + placed scenery). */
  private regenerate(seed: number): void {
    const fresh = mapFromSeed(seed, this.map.size, this.map.hilliness);
    this.map.seed = seed;
    this.map.towns = fresh.towns;
    this.map.nodes = fresh.nodes;
    this.map.edges = fresh.edges;
    this.map.coastX = fresh.coastX;
    ($("ed-seed") as HTMLInputElement).value = String(seed);
    this.scheduleRebuild(0);
  }

  // ---------------- pointer interaction ----------------
  private pointerDown = (e: PointerEvent) => {
    if (e.target !== this.renderer.domElement) return;
    const hit = this.pick(e);
    if (this.tool === "road" && e.button === 0) {
      const m = this.pickRoadMarker(e);
      if (m) {
        this.dragMarker = m;
        this.controls.enabled = false;
      }
    } else if (this.tool === "road" && e.button === 2) {
      const m = this.pickRoadMarker(e);
      if (m && m.kind === "via" && m.edge !== undefined && m.viaIdx !== undefined) {
        this.map.edges[m.edge].via.splice(m.viaIdx, 1);
        this.refreshMarkers();
        this.scheduleRebuild();
      }
    } else if (this.tool === "place" && e.button === 0 && hit) {
      const type = ($("ed-object-type") as HTMLSelectElement).value as SceneryType;
      this.map.scenery.push({ type, x: hit.x, z: hit.z, rot: Math.random() * Math.PI * 2, scale: 1 });
      this.selectedScenery = this.map.scenery.length - 1;
      this.refreshMarkers();
      this.scheduleRebuild();
    } else if (this.tool === "town" && e.button === 0 && hit) {
      // move the nearest town (and its piazza node) to the clicked spot
      let best = 0;
      let bestD = Infinity;
      this.map.towns.forEach((t, i) => {
        const d = Math.hypot(t.x - hit.x, t.z - hit.z);
        if (d < bestD) { bestD = d; best = i; }
      });
      this.map.towns[best].x = hit.x;
      this.map.towns[best].z = hit.z;
      this.map.nodes[best].x = hit.x; // towns are the first nodes
      this.map.nodes[best].z = hit.z;
      this.scheduleRebuild();
    } else if (this.tool === "select" && e.button === 0) {
      this.selectedScenery = this.pickSceneryMarker(e);
      this.refreshMarkers();
    }
  };

  private pointerMove = (e: PointerEvent) => {
    if (!this.dragMarker) return;
    const hit = this.pick(e);
    if (!hit) return;
    const m = this.dragMarker;
    if (m.kind === "node" && m.node !== undefined) {
      this.map.nodes[m.node].x = hit.x;
      this.map.nodes[m.node].z = hit.z;
      // dragging a town's piazza moves the town with it
      if (m.node < this.map.towns.length) {
        this.map.towns[m.node].x = hit.x;
        this.map.towns[m.node].z = hit.z;
      }
    } else if (m.kind === "via" && m.edge !== undefined && m.viaIdx !== undefined) {
      this.map.edges[m.edge].via[m.viaIdx] = [hit.x, hit.z];
    }
    m.mesh.position.set(hit.x, this.world.terrain.height(hit.x, hit.z) + 4, hit.z);
  };

  private pointerUp = () => {
    if (this.dragMarker) {
      this.dragMarker = null;
      this.controls.enabled = true;
      this.scheduleRebuild();
    }
  };

  private dblClick = (e: MouseEvent) => {
    if (this.tool !== "road") return;
    const hit = this.pick(e as PointerEvent);
    if (!hit) return;
    // insert a via point into the closest road
    const near = this.world.terrain.nearestRoad(hit.x, hit.z, 80);
    if (!near) return;
    let bestEdge = -1;
    let bestIdx = 0;
    let bestD = 90;
    this.map.edges.forEach((edge, ei) => {
      const pts = [
        [this.map.nodes[edge.a].x, this.map.nodes[edge.a].z] as [number, number],
        ...edge.via,
        [this.map.nodes[edge.b].x, this.map.nodes[edge.b].z] as [number, number],
      ];
      for (let i = 0; i < pts.length - 1; i++) {
        const mx = (pts[i][0] + pts[i + 1][0]) / 2;
        const mz = (pts[i][1] + pts[i + 1][1]) / 2;
        const d = Math.hypot(hit.x - mx, hit.z - mz);
        if (d < bestD) {
          bestD = d;
          bestEdge = ei;
          bestIdx = i; // insert after segment i => via index i
        }
      }
    });
    if (bestEdge >= 0) {
      this.map.edges[bestEdge].via.splice(bestIdx, 0, [hit.x, hit.z]);
      this.refreshMarkers();
      this.scheduleRebuild();
    }
  };

  private keyDown = (e: KeyboardEvent) => {
    if (this.selectedScenery < 0 || this.selectedScenery >= this.map.scenery.length) return;
    const it = this.map.scenery[this.selectedScenery];
    if (e.key === "Delete" || e.key === "Backspace") {
      this.map.scenery.splice(this.selectedScenery, 1);
      this.selectedScenery = -1;
    } else if (e.key === "r" || e.key === "R") {
      it.rot += Math.PI / 8;
    } else if (e.key === "+") {
      it.scale = Math.min(3, it.scale * 1.15);
    } else if (e.key === "-") {
      it.scale = Math.max(0.3, it.scale / 1.15);
    } else {
      return;
    }
    this.refreshMarkers();
    this.scheduleRebuild();
  };

  private ctxMenu = (e: Event) => e.preventDefault();

  private bindPointer(): void {
    const el = this.renderer.domElement;
    el.addEventListener("pointerdown", this.pointerDown);
    window.addEventListener("pointermove", this.pointerMove);
    window.addEventListener("pointerup", this.pointerUp);
    el.addEventListener("dblclick", this.dblClick);
    el.addEventListener("contextmenu", this.ctxMenu);
    window.addEventListener("keydown", this.keyDown);
  }

  private ndc(e: { clientX: number; clientY: number }): THREE.Vector2 {
    const rect = this.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
  }

  private pick(e: { clientX: number; clientY: number }): THREE.Vector3 | null {
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    const terrain = this.world.scene.getObjectByName("terrain");
    if (!terrain) return null;
    const hits = this.raycaster.intersectObject(terrain);
    return hits.length ? hits[0].point : null;
  }

  private pickRoadMarker(e: { clientX: number; clientY: number }): RoadMarker | null {
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    const hits = this.raycaster.intersectObjects(this.roadMarkers.map((m) => m.mesh));
    if (!hits.length) return null;
    return this.roadMarkers.find((m) => m.mesh === hits[0].object) ?? null;
  }

  private pickSceneryMarker(e: { clientX: number; clientY: number }): number {
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    const hits = this.raycaster.intersectObjects(this.sceneryMarkers);
    if (!hits.length) return -1;
    return this.sceneryMarkers.indexOf(hits[0].object as THREE.Mesh);
  }

  // ---------------- markers & rebuild ----------------
  private refreshMarkers(): void {
    this.markers.clear();
    this.roadMarkers = [];
    this.sceneryMarkers = [];
    const h = (x: number, z: number) => this.world.terrain.height(x, z) + 4;
    if (this.tool === "road" || this.tool === "town") {
      this.map.nodes.forEach((n, ni) => {
        const mesh = new THREE.Mesh(this.nodeGeo, this.nodeMat);
        mesh.position.set(n.x, h(n.x, n.z), n.z);
        this.markers.add(mesh);
        this.roadMarkers.push({ mesh, kind: "node", node: ni });
      });
    }
    if (this.tool === "road") {
      this.map.edges.forEach((edge, ei) => {
        edge.via.forEach(([x, z], vi) => {
          const mesh = new THREE.Mesh(this.viaGeo, this.viaMat);
          mesh.position.set(x, h(x, z), z);
          this.markers.add(mesh);
          this.roadMarkers.push({ mesh, kind: "via", edge: ei, viaIdx: vi });
        });
      });
    }
    if (this.tool === "select" || this.tool === "place") {
      this.map.scenery.forEach((it, i) => {
        const mesh = new THREE.Mesh(
          this.viaGeo,
          i === this.selectedScenery ? this.markerMatSel : this.sceneryMat
        );
        mesh.position.set(it.x, h(it.x, it.z) + 4, it.z);
        this.markers.add(mesh);
        this.sceneryMarkers.push(mesh);
      });
    }
  }

  private scheduleRebuild(delay = 350): void {
    if (this.rebuildTimer !== null) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = window.setTimeout(() => {
      this.rebuildTimer = null;
      this.world.setMap(JSON.parse(JSON.stringify(this.map)) as MapData);
      this.refreshMarkers();
    }, delay);
  }

  update(): void {
    if (!this.disposed) this.controls.update();
  }

  private dispose(applied: boolean): void {
    if (this.disposed) return;
    this.disposed = true;
    const el = this.renderer.domElement;
    el.removeEventListener("pointerdown", this.pointerDown);
    window.removeEventListener("pointermove", this.pointerMove);
    window.removeEventListener("pointerup", this.pointerUp);
    el.removeEventListener("dblclick", this.dblClick);
    el.removeEventListener("contextmenu", this.ctxMenu);
    window.removeEventListener("keydown", this.keyDown);
    this.controls.dispose();
    this.world.scene.remove(this.markers);
    $("editor-panel").classList.add("hidden");
    if (applied) {
      this.world.map = this.map;
      toast(`Map "${this.map.name}" applied`);
    } else {
      this.world.map = JSON.parse(this.original) as MapData;
    }
    // onExit triggers the full-quality rebuild in main.ts
    this.onExit(applied);
  }
}
