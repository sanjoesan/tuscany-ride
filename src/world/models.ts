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
  const normalized = geos.map((g) => {
    const ng = g.index ? g.toNonIndexed() : g;
    ng.deleteAttribute("uv"); // not used; avoids attribute-set mismatches
    return ng;
  });
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
    case "cypress":
      // one tall stretched blob + tip = organic flame silhouette
      return mergeAll([
        cyl(0.1, 0.16, 0.7, TRUNK),
        blob(1.0, 0x2a451e, 0, 3.3, 0, 3.0, 0.06),
        blob(0.5, 0x2c4a20, 0, 6.5, 0, 2.0, 0.1),
      ]);

    case "pine": {
      // umbrella canopy from overlapping blobs
      return mergeAll([
        cyl(0.22, 0.34, 3.8, TRUNK),
        blob(2.3, 0x44632b, -1.1, 4.5, 0.4, 0.5),
        blob(2.5, 0x4d6e2f, 0.7, 4.9, -0.5, 0.5),
        blob(2.0, 0x3f5c26, 0.2, 4.4, 1.1, 0.5),
      ]);
    }

    case "olive":
      return mergeAll([
        cyl(0.16, 0.26, 1.2, 0x7a6648),
        cyl(0.1, 0.13, 0.9, 0x7a6648, 0.25, 0.9, 0.1),
        blob(1.1, 0x79885c, -0.5, 2.0, 0.3, 0.75),
        blob(1.25, 0x83926a, 0.5, 2.3, -0.3, 0.75),
        blob(0.9, 0x707f54, 0.1, 2.6, 0.5, 0.75),
      ]);

    case "house": {
      const w = 7, d = 9, h = 4.5;
      const plaster = PLASTER[Math.floor(Math.random() * PLASTER.length)];
      return mergeAll([
        box(w, h, d, plaster),
        roof(w + 0.7, 2.2, d + 0.7, TERRACOTTA, 0, h, 0),
        // door + windows as dark insets
        box(1.1, 2.2, 0.15, 0x4a3826, 0, 0, d / 2),
        box(0.9, 1.1, 0.15, 0x3a4a55, -2, 2.2, d / 2),
        box(0.9, 1.1, 0.15, 0x3a4a55, 2, 2.2, d / 2),
      ]);
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

/** One segment of a vineyard row (instanced many times). */
export function vineRowGeometry(): THREE.BufferGeometry {
  return mergeAll([
    box(7.5, 1.5, 0.45, 0x3f5f28, 0, 0.25, 0),
    cyl(0.05, 0.05, 1.7, 0x7a6648, -3.4, 0, 0),
    cyl(0.05, 0.05, 1.7, 0x7a6648, 3.4, 0, 0),
  ]);
}

export const SHARED_MODEL_MATERIAL = new THREE.MeshStandardMaterial({
  vertexColors: true,
  roughness: 0.92,
  metalness: 0,
});
