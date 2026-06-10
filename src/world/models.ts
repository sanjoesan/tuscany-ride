import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { SceneryType } from "../types";

/**
 * Low-poly building & vegetation geometries. Every model is a single merged
 * BufferGeometry with vertex colors so each type can be drawn as one
 * InstancedMesh with a shared material.
 */

/** mergeGeometries requires all-indexed or all-non-indexed; normalize first. */
function mergeAll(geos: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const normalized = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  const merged = mergeGeometries(normalized);
  if (!merged) throw new Error("geometry merge failed");
  return merged;
}

function colored(geo: THREE.BufferGeometry, color: THREE.Color | number): THREE.BufferGeometry {
  const c = color instanceof THREE.Color ? color : new THREE.Color(color);
  const count = geo.attributes.position.count;
  const arr = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(arr, 3));
  return geo;
}

function box(w: number, h: number, d: number, color: number, x = 0, y = 0, z = 0): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y + h / 2, z);
  return colored(g, color);
}

/** Gable roof as a triangular prism. */
function roof(w: number, h: number, d: number, color: number, x = 0, y = 0, z = 0, rotY = 0): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(-w / 2, 0);
  shape.lineTo(w / 2, 0);
  shape.lineTo(0, h);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: false });
  g.translate(0, 0, -d / 2);
  if (rotY) g.rotateY(rotY);
  g.translate(x, y, z);
  return colored(g, color);
}

function cone(r: number, h: number, color: number, x = 0, y = 0, z = 0, seg = 7): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(r, h, seg);
  g.translate(x, y + h / 2, z);
  return colored(g, color);
}

function cyl(rt: number, rb: number, h: number, color: number, x = 0, y = 0, z = 0, seg = 6): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(rt, rb, h, seg);
  g.translate(x, y + h / 2, z);
  return colored(g, color);
}

/**
 * Foliage blob: smooth sphere normals + radial noise jitter so canopies get
 * an organic, slightly ragged silhouette instead of a perfect ball.
 */
function blob(r: number, color: number, x = 0, y = 0, z = 0, squashY = 1, ragged = 0.12): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(r, 2);
  {
    // displace vertices radially; same direction -> same offset (keeps welds)
    const p = g.attributes.position as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.set(p.getX(i), p.getY(i), p.getZ(i));
      const d = v.length();
      const k =
        1 +
        ragged *
          (Math.sin(v.x * 7.1 / r + 1.3) * 0.5 +
            Math.sin(v.y * 6.3 / r + 4.1) * 0.3 +
            Math.sin(v.z * 8.7 / r + 2.2) * 0.2);
      v.multiplyScalar(k / Math.max(d, 1e-6) * d);
      p.setXYZ(i, v.x, v.y, v.z);
    }
  }
  const pos = g.attributes.position as THREE.BufferAttribute;
  const normals = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    // smooth normal = sphere normal, corrected for the squash (inverse-transpose)
    v.set(pos.getX(i), pos.getY(i), pos.getZ(i)).normalize();
    v.y /= squashY;
    v.normalize();
    normals[i * 3] = v.x;
    normals[i * 3 + 1] = v.y;
    normals[i * 3 + 2] = v.z;
  }
  g.scale(1, squashY, 1);
  g.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  g.translate(x, y, z);
  return colored(g, color);
}

const TERRACOTTA = 0xb3552e;
const TERRACOTTA2 = 0xa14a28;
const PLASTER = [0xe8d5ae, 0xdfc492, 0xe6cdb5, 0xd9b98a, 0xe2d2c0];
const STONE = 0xb0a48e;
const TRUNK = 0x6e4f2e;

export function buildModel(type: SceneryType): THREE.BufferGeometry {
  switch (type) {
    case "cypress": {
      // one tall stretched blob + tip = organic flame silhouette
      const tall = 0.85 + Math.random() * 0.45;
      const slim = 0.85 + Math.random() * 0.3;
      return mergeAll([
        cyl(0.1, 0.16, 0.7, TRUNK),
        blob(1.0 * slim, 0x2a451e, 0, 3.3 * tall, 0, 3.0 * tall, 0.05 + Math.random() * 0.05),
        blob(0.5 * slim, 0x2c4a20, 0, 6.5 * tall, 0, 2.0, 0.1),
      ]);
    }

    case "pine": {
      // umbrella canopy from overlapping blobs
      const lean = (Math.random() - 0.5) * 1.2;
      const spread = 0.85 + Math.random() * 0.45;
      return mergeAll([
        cyl(0.22, 0.34, 3.4 + Math.random() * 1.2, TRUNK),
        blob(2.3 * spread, 0x44632b, -1.1 + lean, 4.5, 0.4, 0.5, 0.16),
        blob(2.5 * spread, 0x4d6e2f, 0.7 + lean, 4.9, -0.5, 0.5, 0.16),
        blob(2.0 * spread, 0x3f5c26, 0.2 + lean, 4.4, 1.1, 0.5, 0.16),
      ]);
    }

    case "olive": {
      const twist = Math.random() * 0.7;
      return mergeAll([
        cyl(0.16, 0.26, 1.2, 0x7a6648),
        cyl(0.1, 0.13, 0.9, 0x7a6648, 0.25, 0.9, 0.1),
        blob(0.9 + Math.random() * 0.4, 0x79885c, -0.5 - twist, 2.0, 0.3, 0.75, 0.18),
        blob(1.0 + Math.random() * 0.45, 0x83926a, 0.5 + twist, 2.3, -0.3, 0.75, 0.18),
        blob(0.8 + Math.random() * 0.3, 0x707f54, 0.1, 2.6, 0.5 - twist, 0.75, 0.18),
      ]);
    }

    case "house": {
      // randomized per call - bake several variants so streets aren't clones
      const w = 6 + Math.random() * 2.5;
      const d = 8 + Math.random() * 3;
      const h = 4 + Math.random() * 1.4;
      const plaster = PLASTER[Math.floor(Math.random() * PLASTER.length)];
      const roofC = Math.random() < 0.5 ? TERRACOTTA : TERRACOTTA2;
      const parts: THREE.BufferGeometry[] = [
        box(w, h, d, plaster),
        roof(w + 0.7, 1.8 + Math.random() * 0.9, d + 0.7, roofC, 0, h, 0),
        box(1.1, 2.2, 0.15, 0x4a3826, (Math.random() - 0.5) * (w * 0.4), 0, d / 2), // door
        cyl(0.22, 0.26, 1.1, 0xb39577, w * 0.25, h + 1.2, -d * 0.2, 6), // chimney
      ];
      // front windows with green shutters, upper floor
      const winN = 2 + Math.floor(Math.random() * 2);
      for (let i = 0; i < winN; i++) {
        const wx = -w / 2 + (w / (winN + 1)) * (i + 1);
        parts.push(box(0.85, 1.15, 0.15, 0x3a4a55, wx, h * 0.52, d / 2));
        parts.push(box(0.3, 1.15, 0.1, 0x2e4a2e, wx - 0.62, h * 0.52, d / 2));
        parts.push(box(0.3, 1.15, 0.1, 0x2e4a2e, wx + 0.62, h * 0.52, d / 2));
      }
      // side windows
      for (const side of [1, -1]) {
        for (let i = 0; i < 2; i++) {
          parts.push(box(0.15, 1.05, 0.85, 0x3a4a55, (w / 2) * side, h * 0.5, -d / 4 + (i * d) / 2.2));
        }
      }
      return mergeAll(parts);
    }

    case "villa": {
      const w = 10, d = 12, h = 6.5;
      return mergeAll([
        box(w, h, d, 0xe2c694),
        roof(w + 0.8, 2.6, d + 0.8, TERRACOTTA2, 0, h, 0),
        box(3.4, 9, 3.4, 0xd9bd8a, w / 2 - 1, 0, -d / 2 + 1),
        roof(4, 1.6, 4, TERRACOTTA, w / 2 - 1, 9, -d / 2 + 1),
        box(1.2, 2.4, 0.15, 0x4a3826, 0, 0, d / 2),
        box(0.9, 1.3, 0.15, 0x3a4a55, -3, 3.4, d / 2),
        box(0.9, 1.3, 0.15, 0x3a4a55, 3, 3.4, d / 2),
      ]);
    }

    case "barn": {
      const w = 8, d = 14, h = 4;
      return mergeAll([
        box(w, h, d, 0xc9a06a),
        roof(w + 0.8, 2.4, d + 0.8, TERRACOTTA2, 0, h, 0),
        box(2.6, 3, 0.2, 0x5a4630, 0, 0, d / 2),
      ]);
    }

    case "church": {
      const w = 11, d = 20, h = 8;
      return mergeAll([
        box(w, h, d, 0xe8dcc0), // nave
        roof(w + 0.8, 3.2, d + 0.8, TERRACOTTA, 0, h, 0),
        box(2, 4, 0.3, 0x4a3826, 0, 0, d / 2), // portal
        cyl(1.6, 1.6, 1.2, 0xe8dcc0, 0, h + 2.6, d / 2 - 2.5, 12), // rose window hint
        // campanile
        box(4, 19, 4, STONE, w / 2 + 3, 0, -d / 2 + 3),
        cone(3.1, 3.4, TERRACOTTA2, w / 2 + 3, 19, -d / 2 + 3, 4),
        box(1, 1.6, 0.3, 0x222222, w / 2 + 3, 16.4, -d / 2 + 3 + 1.9), // bell opening
      ]);
    }

    case "tower":
      return mergeAll([
        box(5, 16, 5, STONE),
        box(6, 1.4, 6, 0x9a8e78, 0, 16, 0),
        cone(3.4, 3, TERRACOTTA2, 0, 17.4, 0, 4),
      ]);
  }
}

/**
 * Tiling surface-detail normal map (stucco / bark / foliage grain) so the
 * flat-colored models catch light irregularly and stop looking lifeless.
 */
function buildDetailNormalMap(): THREE.CanvasTexture {
  const S = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(S, S);
  const h = new Float32Array(S * S);
  // value-noise-ish bumps from layered random blobs (tiles via wrap-around)
  for (let layer = 0; layer < 3; layer++) {
    const count = 220 * (layer + 1);
    const r = 18 / (layer + 1);
    for (let b = 0; b < count; b++) {
      const cx = Math.random() * S;
      const cy = Math.random() * S;
      const amp = (Math.random() - 0.4) / (layer + 1);
      const ri = Math.ceil(r);
      for (let dy = -ri; dy <= ri; dy++) {
        for (let dx = -ri; dx <= ri; dx++) {
          const d2 = (dx * dx + dy * dy) / (r * r);
          if (d2 > 1) continue;
          const x = (((cx + dx) % S) + S) % S;
          const y = (((cy + dy) % S) + S) % S;
          h[(y | 0) * S + (x | 0)] += amp * (1 - d2);
        }
      }
    }
  }
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = h[y * S + ((x + 1) % S)] - h[y * S + ((x - 1 + S) % S)];
      const dy = h[((y + 1) % S) * S + x] - h[((y - 1 + S) % S) * S + x];
      const i = (y * S + x) * 4;
      img.data[i] = Math.max(0, Math.min(255, 128 - dx * 110));
      img.data[i + 1] = Math.max(0, Math.min(255, 128 - dy * 110));
      img.data[i + 2] = 255;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 2);
  return tex;
}

/** Weathered plaster: light multiplicative texture with stains & streaks. */
function buildStuccoTexture(): THREE.CanvasTexture {
  const S = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#f2efe9";
  ctx.fillRect(0, 0, S, S);
  // patchy plaster discoloration
  for (let i = 0; i < 90; i++) {
    const a = 0.03 + Math.random() * 0.06;
    ctx.fillStyle = Math.random() < 0.6 ? `rgba(140,120,90,${a})` : `rgba(90,85,80,${a})`;
    const r = 8 + Math.random() * 36;
    ctx.beginPath();
    ctx.ellipse(Math.random() * S, Math.random() * S, r, r * (0.4 + Math.random()), Math.random() * 3, 0, 7);
    ctx.fill();
  }
  // vertical weather streaks from the top (under the eaves)
  for (let i = 0; i < 26; i++) {
    const x = Math.random() * S;
    const len = 20 + Math.random() * 70;
    const grad = ctx.createLinearGradient(0, 0, 0, len);
    grad.addColorStop(0, "rgba(95,85,70,0.16)");
    grad.addColorStop(1, "rgba(95,85,70,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(x, 0, 1.5 + Math.random() * 2.5, len);
  }
  // fine grain
  const img = ctx.getImageData(0, 0, S, S);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 14;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Leafy clumping: light/dark speckle that breaks up flat foliage. */
function buildFoliageTexture(): THREE.CanvasTexture {
  const S = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#e9efe2";
  ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 2400; i++) {
    const bright = Math.random();
    const v = bright < 0.5 ? 120 + Math.random() * 60 : 225 + Math.random() * 30;
    ctx.fillStyle = `rgba(${v * 0.92}, ${v}, ${v * 0.85}, ${0.25 + Math.random() * 0.4})`;
    const r = 2 + Math.random() * 7;
    ctx.beginPath();
    ctx.ellipse(Math.random() * S, Math.random() * S, r, r * 0.7, Math.random() * 3, 0, 7);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 2);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const detailNormal = buildDetailNormalMap();

export const BUILDING_MATERIAL = new THREE.MeshStandardMaterial({
  vertexColors: true,
  roughness: 0.94,
  metalness: 0,
  map: buildStuccoTexture(),
  normalMap: detailNormal,
  normalScale: new THREE.Vector2(0.5, 0.5),
});

export const PLANT_MATERIAL = new THREE.MeshStandardMaterial({
  vertexColors: true,
  roughness: 0.95,
  metalness: 0,
  map: buildFoliageTexture(),
  normalMap: detailNormal,
  normalScale: new THREE.Vector2(0.6, 0.6),
});

export const SHARED_MODEL_MATERIAL = BUILDING_MATERIAL;

export function modelMaterial(type: SceneryType): THREE.MeshStandardMaterial {
  return type === "cypress" || type === "pine" || type === "olive" ? PLANT_MATERIAL : BUILDING_MATERIAL;
}
