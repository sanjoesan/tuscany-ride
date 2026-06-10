import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { World } from "../world/world";
import type { MapData, SceneryType } from "../types";
import { saveMapLocal } from "../world/mapData";
import { toast } from "../game/hud";

type Tool = "select" | "road" | "place" | "town";

const $ = (id: string) => document.getElementById(id)!;

/**
 * The world builder. Operates on a working copy of the map; the world is
 * rebuilt live so edits are immediately visible. "Use & Exit" commits the
 * copy, "Exit" restores the original.
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
  private roadMarkers: THREE.Mesh[] = [];
  private sceneryMarkers: THREE.Mesh[] = [];
  private dragIndex = -1;
  private selectedScenery = -1;
  private rebuildTimer: number | null = null;
  private disposed = false;
  onExit: (applied: boolean) => void = () => {};

  private markerGeo = new THREE.SphereGeometry(3.2, 12, 10);
  private markerMat = new THREE.MeshBasicMaterial({ color: 0xff8c1a });
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
    this.controls.target.set(this.map.town.x, 0, this.map.town.z);
    camera.position.set(this.map.town.x + 250, 320, this.map.town.z + 250);
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
      this.map.seed = Number((e.target as HTMLInputElement).value) | 0;
      this.scheduleRebuild(0);
    };
    ($("ed-hill") as HTMLInputElement).onchange = (e) => {
      this.map.hilliness = Number((e.target as HTMLInputElement).value);
      this.scheduleRebuild(0);
    };
    ($("ed-name") as HTMLInputElement).onchange = (e) => {
      this.map.name = (e.target as HTMLInputElement).value || "Custom Map";
    };
    $("ed-regen").onclick = () => {
      this.map.seed = (Math.random() * 100000) | 0;
      ($("ed-seed") as HTMLInputElement).value = String(this.map.seed);
      this.scheduleRebuild(0);
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
      this.world.setMap(JSON.parse(this.original) as MapData);
      this.dispose(false);
    };
  }

  // ---------------- pointer interaction ----------------
  private pointerDown = (e: PointerEvent) => {
    if (e.target !== this.renderer.domElement) return;
    const hit = this.pick(e);
    if (this.tool === "road" && e.button === 0) {
      const mi = this.pickMarker(e, this.roadMarkers);
      if (mi >= 0) {
        this.dragIndex = mi;
        this.controls.enabled = false;
      }
    } else if (this.tool === "road" && e.button === 2) {
      const mi = this.pickMarker(e, this.roadMarkers);
      if (mi >= 0 && this.map.road.length > 3) {
        this.map.road.splice(mi, 1);
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
      this.map.town.x = hit.x;
      this.map.town.z = hit.z;
      this.scheduleRebuild();
    } else if (this.tool === "select" && e.button === 0) {
      this.selectedScenery = this.pickMarker(e, this.sceneryMarkers);
      this.refreshMarkers();
    }
  };

  private pointerMove = (e: PointerEvent) => {
    if (this.dragIndex < 0) return;
    const hit = this.pick(e);
    if (!hit) return;
    this.map.road[this.dragIndex] = [hit.x, hit.z];
    const m = this.roadMarkers[this.dragIndex];
    m.position.set(hit.x, this.world.terrain.height(hit.x, hit.z) + 3, hit.z);
  };

  private pointerUp = () => {
    if (this.dragIndex >= 0) {
      this.dragIndex = -1;
      this.controls.enabled = true;
      this.scheduleRebuild();
    }
  };

  private dblClick = (e: MouseEvent) => {
    if (this.tool !== "road") return;
    const hit = this.pick(e as PointerEvent);
    if (!hit) return;
    // insert a control point into the closest segment
    let best = -1;
    let bestD = 60;
    const r = this.map.road;
    for (let i = 0; i < r.length; i++) {
      const a = r[i];
      const b = r[(i + 1) % r.length];
      const mx = (a[0] + b[0]) / 2;
      const mz = (a[1] + b[1]) / 2;
      const d = Math.hypot(hit.x - mx, hit.z - mz);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) {
      this.map.road.splice(best + 1, 0, [hit.x, hit.z]);
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

  private pick(e: { clientX: number; clientY: number }): THREE.Vector3 | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const terrain = this.world.scene.getObjectByName("terrain");
    if (!terrain) return null;
    const hits = this.raycaster.intersectObject(terrain);
    return hits.length ? hits[0].point : null;
  }

  private pickMarker(e: { clientX: number; clientY: number }, list: THREE.Mesh[]): number {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(list);
    if (!hits.length) return -1;
    return list.indexOf(hits[0].object as THREE.Mesh);
  }

  // ---------------- markers & rebuild ----------------
  private refreshMarkers(): void {
    this.markers.clear();
    this.roadMarkers = [];
    this.sceneryMarkers = [];
    if (this.tool === "road") {
      for (const [x, z] of this.map.road) {
        const m = new THREE.Mesh(this.markerGeo, this.markerMat);
        m.position.set(x, this.world.terrain.height(x, z) + 3, z);
        this.markers.add(m);
        this.roadMarkers.push(m);
      }
    }
    if (this.tool === "select" || this.tool === "place") {
      this.map.scenery.forEach((it, i) => {
        const m = new THREE.Mesh(
          this.markerGeo,
          i === this.selectedScenery ? this.markerMatSel : this.sceneryMat
        );
        m.position.set(it.x, this.world.terrain.height(it.x, it.z) + 6, it.z);
        this.markers.add(m);
        this.sceneryMarkers.push(m);
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
      this.world.setMap(this.map);
      toast(`Map "${this.map.name}" applied`);
    }
    this.onExit(applied);
  }
}
