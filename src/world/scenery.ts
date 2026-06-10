import * as THREE from "three";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import { Water } from "three/examples/jsm/objects/Water.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { MapData, SceneryType } from "../types";
import { Terrain, smoothstep } from "./terrain";
import { mulberry32, Noise2D } from "./noise";
import { buildModel, modelMaterial } from "./models";

interface Placement {
  x: number;
  z: number;
  rot: number;
  scale: number;
}

/**
 * Populates the world: procedural vegetation/vineyards derived from the seed,
 * a generated Italian town, plus the manually placed items from the map.
 */
export function buildScenery(map: MapData, terrain: Terrain): THREE.Group {
  const group = new THREE.Group();
  group.name = "scenery";
  const rand = mulberry32(map.seed * 31 + 7);
  const half = map.size / 2 - 30;

  const buckets = new Map<SceneryType, Placement[]>();
  const put = (type: SceneryType, p: Placement) => {
    let arr = buckets.get(type);
    if (!arr) {
      arr = [];
      buckets.set(type, arr);
    }
    arr.push(p);
  };

  const blocked = (x: number, z: number, margin = 9): boolean => {
    const near = terrain.nearestRoad(x, z, margin);
    return near !== null && near.dist < margin;
  };
  const inTown = (x: number, z: number, extra = 0): boolean =>
    map.towns.some((t) => Math.hypot(x - t.x, z - t.z) < t.radius + extra);

  // ---------- countryside grid ----------
  const step = 13;
  for (let x = -half; x < half; x += step) {
    for (let z = -half; z < half; z += step) {
      const jx = x + (rand() - 0.5) * step * 0.8;
      const jz = z + (rand() - 0.5) * step * 0.8;
      if (jx < map.coastX + 50 || inTown(jx, jz, 14) || blocked(jx, jz)) continue;
      const kind = terrain.fieldKind(jx, jz);
      const r = rand();
      if (kind === "olive") {
        if (r < 0.5) put("olive", { x: jx, z: jz, rot: rand() * 6.28, scale: 0.8 + rand() * 0.5 });
      } else if (kind === "vineyard") {
        // rows are painted into the ground texture; the odd olive at field edges
        if (r < 0.015) put("olive", { x: jx, z: jz, rot: rand() * 6.28, scale: 0.9 });
      } else if (kind === "pasture") {
        if (r < 0.025) put("pine", { x: jx, z: jz, rot: rand() * 6.28, scale: 0.8 + rand() * 0.6 });
        else if (r < 0.04) put("olive", { x: jx, z: jz, rot: rand() * 6.28, scale: 0.9 });
      } else if (kind === "wheat" || kind === "plowed") {
        if (r < 0.008) put("cypress", { x: jx, z: jz, rot: rand() * 6.28, scale: 0.9 + rand() * 0.5 });
      }
    }
  }

  // ---------- cypress alleys + roadside trees ----------
  const samples = terrain.getRoadSamples();
  for (let i = 0; i < samples.length; i += 6) {
    const s = samples[i];
    if (s.x < map.coastX + 60) continue;
    if (inTown(s.x, s.z, 6)) continue;
    const r = rand();
    if (r < 0.45) {
      const side = r < 0.225 ? 1 : -1;
      const nx = -s.dirZ * side;
      const nz = s.dirX * side;
      const off = 6 + rand() * 2;
      const px = s.x + nx * off;
      const pz = s.z + nz * off;
      if (!inTown(px, pz, 4)) {
        put("cypress", { x: px, z: pz, rot: rand() * 6.28, scale: 0.85 + rand() * 0.5 });
      }
    }
  }

  // ---------- beach pines ----------
  for (let z = -half; z < half; z += 26) {
    if (rand() < 0.5) {
      const x = map.coastX + 65 + rand() * 70;
      if (!blocked(x, z) && !inTown(x, z, 10)) {
        put("pine", { x, z, rot: rand() * 6.28, scale: 0.9 + rand() * 0.6 });
      }
    }
  }

  // ---------- scattered farms ----------
  const farmCount = Math.round(map.size / 240);
  for (let f = 0; f < farmCount; f++) {
    const x = map.coastX + 250 + rand() * (half - map.coastX - 350);
    const z = -half + 100 + rand() * (2 * half - 200);
    if (blocked(x, z, 16) || inTown(x, z, 60)) continue;
    const rot = rand() * 6.28;
    put(rand() < 0.5 ? "villa" : "barn", { x, z, rot, scale: 1 });
    for (let c = 0; c < 4; c++) {
      put("cypress", { x: x + Math.cos(rot) * (10 + c * 4), z: z + Math.sin(rot) * (10 + c * 4), rot: 0, scale: 1 + rand() * 0.3 });
    }
  }

  // ---------- towns ----------
  for (const town of map.towns) {
    buildTown(town, terrain, rand, put, blocked);
  }

  // ---------- streets: houses lining the roads inside towns ----------
  const roadSamples = terrain.getRoadSamples();
  for (let i = 0; i < roadSamples.length; i += 4) {
    const s = roadSamples[i];
    const town = map.towns.find((t) => Math.hypot(s.x - t.x, s.z - t.z) < t.radius);
    if (!town) continue;
    // keep the piazza in front of the church free
    if (Math.hypot(s.x - town.x, s.z - town.z) < 26) continue;
    for (const side of [1, -1]) {
      if (rand() > 0.62) continue;
      const nx = -s.dirZ * side;
      const nz = s.dirX * side;
      const off = 9.5 + rand() * 2.5;
      const hx = s.x + nx * off;
      const hz = s.z + nz * off;
      if (blocked(hx, hz, 8)) continue;
      // face the street
      const rot = Math.atan2(-nz, -nx) + Math.PI / 2;
      put("house", { x: hx, z: hz, rot, scale: 0.85 + rand() * 0.35 });
    }
  }

  // ---------- manual scenery from the world builder ----------
  for (const it of map.scenery) {
    put(it.type, { x: it.x, z: it.z, rot: it.rot, scale: it.scale });
  }

  // ---------- bake into instanced meshes ----------
  // several geometry variants per type (the builders randomize proportions),
  // so streets and groves are not armies of clones
  const dummy = new THREE.Object3D();
  const VEGETATION: SceneryType[] = ["cypress", "pine", "olive"];
  const BUILDINGS: SceneryType[] = ["house", "villa", "barn"];
  const jitterColor = new THREE.Color();
  for (const [type, list] of buckets) {
    const vegetate = VEGETATION.includes(type);
    const building = BUILDINGS.includes(type);
    const variants = type === "house" ? 5 : vegetate ? 4 : 1;
    for (let v = 0; v < variants; v++) {
      const sub = list.filter((_, i) => i % variants === v);
      if (sub.length === 0) continue;
      const inst = new THREE.InstancedMesh(buildModel(type), modelMaterial(type), sub.length);
      inst.name = `inst-${type}-${v}`;
      sub.forEach((p, i) => {
        dummy.position.set(p.x, terrain.height(p.x, p.z) - 0.1, p.z);
        dummy.rotation.set(0, p.rot, 0);
        dummy.scale.setScalar(p.scale);
        dummy.updateMatrix();
        inst.setMatrixAt(i, dummy.matrix);
        // natural variation so no two plants / houses look identical
        if (vegetate) {
          const b = 0.72 + rand() * 0.36;
          jitterColor.setRGB(b * (0.92 + rand() * 0.16), b, b * (0.88 + rand() * 0.14));
          inst.setColorAt(i, jitterColor);
        } else if (building) {
          const b = 0.86 + rand() * 0.2;
          jitterColor.setRGB(b, b * (0.96 + rand() * 0.07), b * (0.9 + rand() * 0.1));
          inst.setColorAt(i, jitterColor);
        }
      });
      if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
      inst.castShadow = true;
      inst.receiveShadow = true;
      group.add(inst);
    }
  }
  // ---------- grass tufts near the roads ----------
  const grass = buildGrass(map, terrain, rand);
  if (grass) group.add(grass);

  return group;
}

/**
 * Dense instanced grass tufts along the roadsides (where the rider actually
 * looks), tinted to match the underlying field. Two crossed alpha-tested
 * quads per tuft - tens of thousands render fine as one InstancedMesh.
 */
function buildGrass(map: MapData, terrain: Terrain, rand: () => number): THREE.InstancedMesh | null {
  const samples = terrain.getRoadSamples();
  if (samples.length === 0) return null;

  const placements: { x: number; z: number; s: number; tint: THREE.Color }[] = [];
  const cap = terrain.season === "winter" ? 30000 : 60000;
  const pal = {
    spring: { green: [0.36, 0.56, 0.24], gold: [0.5, 0.6, 0.3], dry: [0.42, 0.58, 0.26] },
    summer: { green: [0.42, 0.55, 0.28], gold: [0.72, 0.62, 0.34], dry: [0.55, 0.55, 0.3] },
    autumn: { green: [0.46, 0.48, 0.26], gold: [0.6, 0.5, 0.3], dry: [0.52, 0.46, 0.28] },
    winter: { green: [0.46, 0.5, 0.34], gold: [0.5, 0.48, 0.36], dry: [0.48, 0.48, 0.36] },
  }[terrain.season];
  const green = new THREE.Color(...(pal.green as [number, number, number]));
  const gold = new THREE.Color(...(pal.gold as [number, number, number]));
  const dry = new THREE.Color(...(pal.dry as [number, number, number]));
  for (let i = 0; i < samples.length && placements.length < cap; i += 2) {
    const s = samples[i];
    for (let k = 0; k < 3; k++) {
      const side = rand() < 0.5 ? 1 : -1;
      const off = 5 + Math.pow(rand(), 1.6) * 42; // denser near the verge
      const x = s.x - s.dirZ * off * side + (rand() - 0.5) * 6;
      const z = s.z + s.dirX * off * side + (rand() - 0.5) * 6;
      if (x < map.coastX + 40) continue;
      if (map.towns.some((t) => Math.hypot(x - t.x, z - t.z) < t.radius)) continue;
      const near = terrain.nearestRoad(x, z, 5);
      if (near && near.dist < 4.5) continue; // not on the asphalt
      const kind = terrain.fieldKind(x, z);
      const base = off < 11 ? green : kind === "wheat" ? gold : kind === "pasture" ? dry : green;
      const tint = base.clone().multiplyScalar(1.25 + rand() * 0.55);
      placements.push({ x, z, s: 0.6 + rand() * 0.8, tint });
    }
  }
  if (placements.length === 0) return null;

  // crossed quads, anchored at the ground
  const quad1 = new THREE.PlaneGeometry(1.1, 0.65);
  quad1.translate(0, 0.3, 0);
  const quad2 = quad1.clone();
  quad2.rotateY(Math.PI / 2);
  const geo = mergeGeometries([quad1, quad2])!;
  const mat = new THREE.MeshLambertMaterial({
    map: buildGrassTexture(),
    alphaTest: 0.45,
    side: THREE.DoubleSide,
  });
  const inst = new THREE.InstancedMesh(geo, mat, placements.length);
  inst.name = "inst-grass";
  const dummy = new THREE.Object3D();
  placements.forEach((p, i) => {
    dummy.position.set(p.x, terrain.height(p.x, p.z) - 0.04, p.z);
    dummy.rotation.set(0, rand() * Math.PI, 0);
    dummy.scale.setScalar(p.s);
    dummy.updateMatrix();
    inst.setMatrixAt(i, dummy.matrix);
    inst.setColorAt(i, p.tint);
  });
  if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
  return inst;
}

/** Painted grass-blade sprite (transparent background, alpha-tested). */
function buildGrassTexture(): THREE.CanvasTexture {
  const W = 128;
  const H = 96;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, W, H);
  for (let b = 0; b < 26; b++) {
    const x0 = 6 + Math.random() * (W - 12);
    const lean = (Math.random() - 0.5) * 26;
    const h = 30 + Math.random() * 60;
    const g = 110 + Math.random() * 90;
    ctx.strokeStyle = `rgb(${g * 0.55}, ${g}, ${g * 0.4})`;
    ctx.lineWidth = 2.5 + Math.random() * 2;
    ctx.beginPath();
    ctx.moveTo(x0, H);
    ctx.quadraticCurveTo(x0 + lean * 0.3, H - h * 0.6, x0 + lean, H - h);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function buildTown(
  town: { x: number; z: number; radius: number },
  terrain: Terrain,
  rand: () => number,
  put: (t: SceneryType, p: Placement) => void,
  blocked: (x: number, z: number, m?: number) => boolean
): void {
  const { x: tx, z: tz, radius } = town;

  // church on the piazza, slightly off-center (villages get one too - it's Italy)
  const churchAngle = rand() * 6.28;
  const cx = tx + Math.cos(churchAngle) * radius * 0.3;
  const cz = tz + Math.sin(churchAngle) * radius * 0.3;
  if (!blocked(cx, cz, 14)) put("church", { x: cx, z: cz, rot: churchAngle + Math.PI, scale: radius > 110 ? 1 : 0.8 });

  // houses in rough rings around the center - dense italian old town
  const rings = Math.max(2, Math.round(radius / 38));
  for (let ring = 1; ring <= rings; ring++) {
    const r = (radius * 0.92 * ring) / rings;
    const count = Math.round((2 * Math.PI * r) / 16);
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + rand() * 0.18 + ring * 0.45;
      const hr = r + (rand() - 0.5) * 9;
      const hx = tx + Math.cos(a) * hr;
      const hz = tz + Math.sin(a) * hr;
      if (Math.hypot(hx - cx, hz - cz) < 18) continue; // keep the piazza clear
      if (blocked(hx, hz, 8)) continue;
      if (rand() < 0.88) {
        put("house", { x: hx, z: hz, rot: a + Math.PI / 2 + (rand() - 0.5) * 0.2, scale: 0.85 + rand() * 0.4 });
      }
    }
  }

  // a watchtower at the edge of the larger towns
  if (radius > 110 && rand() < 0.8) {
    const ta = rand() * 6.28;
    const wx = tx + Math.cos(ta) * radius * 1.05;
    const wz = tz + Math.sin(ta) * radius * 1.05;
    if (!blocked(wx, wz, 10)) put("tower", { x: wx, z: wz, rot: ta, scale: 1 });
  }
}

export type TimeOfDay = "morning" | "noon" | "afternoon" | "sunset" | "night" | "cycle";

const TIME_PRESETS: Record<Exclude<TimeOfDay, "cycle">, { el: number; az: number }> = {
  morning: { el: 22, az: 118 },
  noon: { el: 56, az: 190 },
  afternoon: { el: 38, az: 245 },
  sunset: { el: 7, az: 254 },
  night: { el: -18, az: 300 },
};

const CYCLE_DAY_SECONDS = 480; // full day/night in 8 minutes

/**
 * Atmosphere & lighting: physical sky shader (also used as environment map
 * for PBR ambient), sun/moon with soft shadows that follow the rider,
 * reflective animated sea, distance haze. Supports fixed times of day and
 * an animated day/night cycle.
 */
export class Environment {
  private scene: THREE.Scene;
  private map: MapData;
  private sky: Sky;
  private envSky: Sky;
  private envScene: THREE.Scene;
  private pmrem: THREE.PMREMGenerator;
  private sun: THREE.DirectionalLight;
  private fill: THREE.HemisphereLight;
  private water: Water;
  private sunDir = new THREE.Vector3(0, 1, 0);
  private mode: TimeOfDay = "afternoon";
  private lastEnvMapAt = -999;
  private envDirty = true;

  constructor(map: MapData, scene: THREE.Scene, renderer: THREE.WebGLRenderer) {
    this.scene = scene;
    this.map = map;

    this.sky = new Sky();
    this.sky.scale.setScalar(20000);
    const u = this.sky.material.uniforms;
    u.turbidity.value = 4;
    u.rayleigh.value = 2.0;
    u.mieCoefficient.value = 0.004;
    u.mieDirectionalG.value = 0.85;
    scene.add(this.sky);

    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.envScene = new THREE.Scene();
    this.envSky = new Sky();
    this.envSky.scale.setScalar(20000);
    this.envSky.material.uniforms.turbidity.value = 6;
    this.envSky.material.uniforms.rayleigh.value = 1.6;
    this.envScene.add(this.envSky);

    scene.fog = new THREE.Fog(0xc9d9e6, 700, map.size * 1.9);

    this.sun = new THREE.DirectionalLight(0xfff0dc, 3.0);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    const ext = 260;
    this.sun.shadow.camera.left = -ext;
    this.sun.shadow.camera.right = ext;
    this.sun.shadow.camera.top = ext;
    this.sun.shadow.camera.bottom = -ext;
    this.sun.shadow.camera.near = 50;
    this.sun.shadow.camera.far = 1600;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.5;
    this.sun.shadow.camera.updateProjectionMatrix();
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.fill = new THREE.HemisphereLight(0xbfd4ea, 0x8a7a55, 0.22);
    scene.add(this.fill);

    const waterGeo = new THREE.PlaneGeometry(map.size * 2.2, map.size * 2.2);
    this.water = new Water(waterGeo, {
      textureWidth: 512,
      textureHeight: 512,
      waterNormals: buildWaterNormals(),
      sunDirection: new THREE.Vector3(0, 1, 0),
      sunColor: 0xfff0dc,
      waterColor: 0x07273a,
      distortionScale: 2.0,
      fog: true,
    });
    this.water.rotation.x = -Math.PI / 2;
    this.water.position.y = 0.0;
    this.water.name = "sea";
    scene.add(this.water);

    this.applySun(TIME_PRESETS.afternoon.el, TIME_PRESETS.afternoon.az);
  }

  setTimeOfDay(mode: TimeOfDay): void {
    this.mode = mode;
    if (mode !== "cycle") {
      const p = TIME_PRESETS[mode];
      this.applySun(p.el, p.az);
      this.envDirty = true;
    }
  }

  /** Position sun/moon and re-tune all lights for the given solar elevation. */
  private applySun(elDeg: number, azDeg: number): void {
    const night = elDeg <= 1.5;
    // at night the scene light becomes the moon, high in the east
    const lightEl = night ? 42 : elDeg;
    const lightAz = night ? 70 : azDeg;
    this.sunDir.setFromSphericalCoords(
      1,
      Math.PI / 2 - THREE.MathUtils.degToRad(lightEl),
      THREE.MathUtils.degToRad(lightAz)
    );
    // the sky shader always gets the true sun (below horizon = dark sky)
    const skySun = new THREE.Vector3().setFromSphericalCoords(
      1,
      Math.PI / 2 - THREE.MathUtils.degToRad(elDeg),
      THREE.MathUtils.degToRad(azDeg)
    );
    this.sky.material.uniforms.sunPosition.value.copy(skySun);
    this.envSky.material.uniforms.sunPosition.value.copy(skySun);

    const dayness = Math.max(0, Math.min(1, elDeg / 25)); // 0 night .. 1 high sun
    if (night) {
      this.sun.intensity = 0.55;
      this.sun.color.set(0x8fa8cf); // moonlight
      this.fill.intensity = 0.09;
      (this.scene.fog as THREE.Fog).color.set(0x0b1322);
      (this.water.material as THREE.ShaderMaterial).uniforms.sunColor.value.set(0x1c2940);
    } else {
      this.sun.intensity = 1.1 + 2.1 * dayness;
      this.sun.color.copy(new THREE.Color(0xffc890).lerp(new THREE.Color(0xfff0dc), dayness));
      this.fill.intensity = 0.08 + 0.16 * dayness;
      (this.scene.fog as THREE.Fog).color.copy(
        new THREE.Color(0xe5cfb4).lerp(new THREE.Color(0xc9d9e6), dayness)
      );
      (this.water.material as THREE.ShaderMaterial).uniforms.sunColor.value.set(0xfff0dc);
    }
    (this.water.material as THREE.ShaderMaterial).uniforms.sunDirection.value.copy(this.sunDir);
  }

  /** Refresh the PBR ambient (PMREM of the sky). Costs a few ms - throttled. */
  private refreshEnvMap(): void {
    const old = this.scene.environment;
    this.scene.environment = this.pmrem.fromScene(this.envScene as unknown as THREE.Scene, 0.02).texture;
    this.scene.environmentIntensity = 0.45;
    if (old) old.dispose();
  }

  update(t: number, focus: THREE.Vector3): void {
    (this.water.material as THREE.ShaderMaterial).uniforms.time.value = t * 0.5;
    if (this.mode === "cycle") {
      const phase = (t / CYCLE_DAY_SECONDS) % 1;
      const el = Math.sin(phase * Math.PI) * 60 - 4;
      const az = 95 + phase * 165;
      this.applySun(el, az);
      if (t - this.lastEnvMapAt > 4) {
        this.lastEnvMapAt = t;
        this.refreshEnvMap();
      }
    } else if (this.envDirty) {
      this.envDirty = false;
      this.refreshEnvMap();
    }
    // shadow frustum follows the action
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).addScaledVector(this.sunDir, 700);
  }
}

/** Tiling normal map for the water surface, generated from smooth noise. */
function buildWaterNormals(): THREE.Texture {
  const S = 512;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(S, S);
  const n = new Noise2D(4242);
  const hAt = (x: number, y: number) => {
    const fx = (x / S) * 8;
    const fy = (y / S) * 8;
    // sample wrapped so the texture tiles
    return (
      n.noise(Math.sin((fx / 8) * Math.PI * 2) * 2, Math.cos((fy / 8) * Math.PI * 2) * 2) +
      0.5 * n.noise(Math.sin((fx / 4) * Math.PI * 2) * 3 + 7, Math.cos((fy / 4) * Math.PI * 2) * 3)
    );
  };
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = hAt(x + 1, y) - hAt(x - 1, y);
      const dy = hAt(x, y + 1) - hAt(x, y - 1);
      const i = (y * S + x) * 4;
      img.data[i] = Math.max(0, Math.min(255, 128 + dx * 120));
      img.data[i + 1] = Math.max(0, Math.min(255, 128 + dy * 120));
      img.data[i + 2] = 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

export { smoothstep };
