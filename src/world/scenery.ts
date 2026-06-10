import * as THREE from "three";
import { Sky } from "three/examples/jsm/objects/Sky.js";
import { Water } from "three/examples/jsm/objects/Water.js";
import type { MapData, SceneryItem, SceneryType } from "../types";
import { Terrain, smoothstep } from "./terrain";
import { mulberry32, Noise2D } from "./noise";
import { buildModel, vineRowGeometry, SHARED_MODEL_MATERIAL } from "./models";

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

  const vineRows: Placement[] = [];

  const blocked = (x: number, z: number, margin = 9): boolean => {
    const near = terrain.nearestRoad(x, z, margin);
    return near !== null && near.dist < margin;
  };
  const inTown = (x: number, z: number, extra = 0): boolean =>
    Math.hypot(x - map.town.x, z - map.town.z) < map.town.radius + extra;

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
        if (r < 0.55) vineRows.push({ x: jx, z: jz, rot: 0.524, scale: 1 });
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
  for (let f = 0; f < 9; f++) {
    const x = map.coastX + 250 + rand() * (half - map.coastX - 350);
    const z = -half + 100 + rand() * (2 * half - 200);
    if (blocked(x, z, 16) || inTown(x, z, 60)) continue;
    const rot = rand() * 6.28;
    put(rand() < 0.5 ? "villa" : "barn", { x, z, rot, scale: 1 });
    for (let c = 0; c < 4; c++) {
      put("cypress", { x: x + Math.cos(rot) * (10 + c * 4), z: z + Math.sin(rot) * (10 + c * 4), rot: 0, scale: 1 + rand() * 0.3 });
    }
  }

  // ---------- the town ----------
  buildTown(map, terrain, rand, put, blocked);

  // ---------- manual scenery from the world builder ----------
  for (const it of map.scenery) {
    put(it.type, { x: it.x, z: it.z, rot: it.rot, scale: it.scale });
  }

  // ---------- bake into instanced meshes ----------
  const dummy = new THREE.Object3D();
  const VEGETATION: SceneryType[] = ["cypress", "pine", "olive"];
  const jitterColor = new THREE.Color();
  for (const [type, list] of buckets) {
    const geo = buildModel(type);
    const inst = new THREE.InstancedMesh(geo, SHARED_MODEL_MATERIAL, list.length);
    inst.name = `inst-${type}`;
    const vegetate = VEGETATION.includes(type);
    list.forEach((p, i) => {
      dummy.position.set(p.x, terrain.height(p.x, p.z) - 0.1, p.z);
      dummy.rotation.set(0, p.rot, 0);
      dummy.scale.setScalar(p.scale);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
      // natural brightness/hue variation so no two plants look identical
      if (vegetate) {
        const b = 0.75 + rand() * 0.3;
        jitterColor.setRGB(b * (0.95 + rand() * 0.1), b, b * (0.9 + rand() * 0.1));
        inst.setColorAt(i, jitterColor);
      }
    });
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    inst.castShadow = true;
    inst.receiveShadow = true;
    group.add(inst);
  }
  if (vineRows.length > 0) {
    const inst = new THREE.InstancedMesh(vineRowGeometry(), SHARED_MODEL_MATERIAL, vineRows.length);
    inst.name = "inst-vines";
    vineRows.forEach((p, i) => {
      dummy.position.set(p.x, terrain.height(p.x, p.z), p.z);
      dummy.rotation.set(0, p.rot, 0);
      dummy.scale.setScalar(p.scale);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
      const b = 0.8 + rand() * 0.25;
      jitterColor.setRGB(b, b, b);
      inst.setColorAt(i, jitterColor);
    });
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    inst.castShadow = true;
    group.add(inst);
  }
  return group;
}

function buildTown(
  map: MapData,
  terrain: Terrain,
  rand: () => number,
  put: (t: SceneryType, p: Placement) => void,
  blocked: (x: number, z: number, m?: number) => boolean
): void {
  const { x: tx, z: tz, radius } = map.town;

  // church on the piazza, slightly off-center
  const churchAngle = rand() * 6.28;
  const cx = tx + Math.cos(churchAngle) * radius * 0.25;
  const cz = tz + Math.sin(churchAngle) * radius * 0.25;
  if (!blocked(cx, cz, 14)) put("church", { x: cx, z: cz, rot: churchAngle + Math.PI, scale: 1 });

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

  // a watchtower at the edge of town
  const ta = rand() * 6.28;
  const wx = tx + Math.cos(ta) * radius * 1.05;
  const wz = tz + Math.sin(ta) * radius * 1.05;
  if (!blocked(wx, wz, 10)) put("tower", { x: wx, z: wz, rot: ta, scale: 1 });
}

/**
 * Atmosphere & lighting: physical sky shader (also used as environment map
 * for PBR ambient), sun with soft shadows that follow the rider, reflective
 * animated sea, drifting clouds, distance haze.
 */
export function buildEnvironment(
  map: MapData,
  scene: THREE.Scene,
  renderer: THREE.WebGLRenderer
): (t: number, focus: THREE.Vector3) => void {
  // ---------- sky ----------
  const sky = new Sky();
  sky.scale.setScalar(20000);
  scene.add(sky);
  const sunDir = new THREE.Vector3();
  // late-afternoon sun out over the sea (west = -x)
  const elevation = THREE.MathUtils.degToRad(38);
  const azimuth = THREE.MathUtils.degToRad(245);
  sunDir.setFromSphericalCoords(1, Math.PI / 2 - elevation, azimuth);
  const u = sky.material.uniforms;
  u.turbidity.value = 4;
  u.rayleigh.value = 2.0;
  u.mieCoefficient.value = 0.004;
  u.mieDirectionalG.value = 0.85;
  u.sunPosition.value.copy(sunDir);

  // PBR ambient from the sky itself
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const envSky = new Sky();
  envSky.scale.setScalar(20000);
  envSky.material.uniforms.sunPosition.value.copy(sunDir);
  envSky.material.uniforms.turbidity.value = 6;
  envSky.material.uniforms.rayleigh.value = 1.6;
  envScene.add(envSky);
  scene.environment = pmrem.fromScene(envScene as unknown as THREE.Scene, 0.02).texture;
  scene.environmentIntensity = 0.45;

  scene.fog = new THREE.Fog(0xc9d9e6, 700, map.size * 1.9);

  // ---------- sun light + shadows ----------
  const sun = new THREE.DirectionalLight(0xfff0dc, 3.0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const ext = 260;
  sun.shadow.camera.left = -ext;
  sun.shadow.camera.right = ext;
  sun.shadow.camera.top = ext;
  sun.shadow.camera.bottom = -ext;
  sun.shadow.camera.near = 50;
  sun.shadow.camera.far = 1600;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.5;
  sun.shadow.camera.updateProjectionMatrix();
  scene.add(sun);
  scene.add(sun.target);

  const fill = new THREE.HemisphereLight(0xbfd4ea, 0x8a7a55, 0.22);
  scene.add(fill);

  // ---------- sea ----------
  const waterGeo = new THREE.PlaneGeometry(map.size * 2.2, map.size * 2.2);
  const water = new Water(waterGeo, {
    textureWidth: 512,
    textureHeight: 512,
    waterNormals: buildWaterNormals(),
    sunDirection: sunDir.clone(),
    sunColor: 0xfff0dc,
    waterColor: 0x07273a,
    distortionScale: 2.0,
    fog: true,
  });
  water.rotation.x = -Math.PI / 2;
  water.position.y = 0.0;
  water.name = "sea";
  scene.add(water);

  return (t: number, focus: THREE.Vector3) => {
    (water.material as THREE.ShaderMaterial).uniforms.time.value = t * 0.5;
    // shadow frustum follows the action
    sun.target.position.copy(focus);
    sun.position.copy(focus).addScaledVector(sunDir, 700);
  };
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
