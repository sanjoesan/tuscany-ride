import * as THREE from "three";

/**
 * Low-poly cyclist with spinning wheels and pedaling legs.
 * Built from primitives so there are no asset downloads.
 */
export class Rider {
  readonly object: THREE.Group;
  private wheels: THREE.Mesh[] = [];
  private crank: THREE.Group;
  private legL: THREE.Group;
  private legR: THREE.Group;
  private crankAngle = 0;

  constructor(bikeColor = 0xd6452c, jerseyColor = 0x2270c9, withShadowBlob = true) {
    const g = new THREE.Group();
    g.name = "rider";

    const frameMat = new THREE.MeshStandardMaterial({ color: bikeColor, roughness: 0.35, metalness: 0.6 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x1c1c1f, roughness: 0.7, metalness: 0.3 });
    const skinMat = new THREE.MeshStandardMaterial({ color: 0xd9a47e, roughness: 0.75, metalness: 0 });
    const jerseyMat = new THREE.MeshStandardMaterial({
      map: buildJerseyTexture(jerseyColor),
      roughness: 0.6,
      metalness: 0,
    });
    const shortsMat = new THREE.MeshStandardMaterial({ color: 0x14141c, roughness: 0.65, metalness: 0 });

    // wheels: torus in the XY plane = vertical wheel rolling along +X
    const wheelGeo = new THREE.TorusGeometry(0.34, 0.045, 8, 20);
    for (const x of [0.52, -0.52]) {
      const w = new THREE.Mesh(wheelGeo, darkMat);
      w.position.set(x, 0.34, 0);
      // spokes (in the wheel plane)
      const spokes = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.6, 4), darkMat);
      w.add(spokes);
      const spokes2 = spokes.clone();
      spokes2.rotation.z = Math.PI / 2;
      w.add(spokes2);
      g.add(w);
      this.wheels.push(w);
    }

    // frame: down tube, top tube, seat tube
    const tube = (from: THREE.Vector3, to: THREE.Vector3, r = 0.03): THREE.Mesh => {
      const dir = to.clone().sub(from);
      const len = dir.length();
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, len, 6), frameMat);
      m.position.copy(from).addScaledVector(dir, 0.5);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
      return m;
    };
    const bb = new THREE.Vector3(0.05, 0.36, 0); // bottom bracket
    const seatTop = new THREE.Vector3(-0.18, 0.95, 0);
    const headTop = new THREE.Vector3(0.42, 0.95, 0);
    const rearHub = new THREE.Vector3(-0.52, 0.34, 0);
    const frontHub = new THREE.Vector3(0.52, 0.34, 0);
    g.add(tube(bb, seatTop));
    g.add(tube(bb, headTop));
    g.add(tube(seatTop, headTop));
    g.add(tube(bb, rearHub, 0.02));
    g.add(tube(seatTop, rearHub, 0.02));
    g.add(tube(headTop, frontHub, 0.025));
    // handlebar + saddle
    const bars = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.36, 6), darkMat);
    bars.rotation.x = Math.PI / 2;
    bars.position.set(0.44, 1.0, 0);
    g.add(bars);
    const saddle = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.05, 0.12), darkMat);
    saddle.position.set(-0.2, 1.0, 0);
    g.add(saddle);

    // crank
    this.crank = new THREE.Group();
    this.crank.position.copy(bb);
    g.add(this.crank);

    // rider body
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.24, 0.3), jerseyMat);
    torso.position.set(0.08, 1.18, 0);
    torso.rotation.z = 0.5;
    g.add(torso);
    const head = new THREE.Mesh(new THREE.IcosahedronGeometry(0.12, 1), skinMat);
    head.position.set(0.38, 1.4, 0);
    g.add(head);
    const helmet = new THREE.Mesh(new THREE.IcosahedronGeometry(0.13, 1), frameMat);
    helmet.scale.set(1, 0.7, 1);
    helmet.position.set(0.38, 1.45, 0);
    g.add(helmet);
    // arms
    const armGeo = new THREE.CylinderGeometry(0.045, 0.04, 0.42, 5);
    for (const side of [1, -1]) {
      const arm = new THREE.Mesh(armGeo, skinMat);
      arm.position.set(0.32, 1.15, 0.12 * side);
      arm.rotation.z = -0.9;
      g.add(arm);
    }

    // legs: hip-anchored groups so we can swing them while pedaling
    const mkLeg = (side: number): THREE.Group => {
      const leg = new THREE.Group();
      leg.position.set(-0.12, 1.02, 0.1 * side);
      const thigh = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.05, 0.4, 5), shortsMat);
      thigh.position.y = -0.2;
      leg.add(thigh);
      const shin = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.035, 0.4, 5), skinMat);
      shin.position.y = -0.55;
      leg.add(shin);
      g.add(leg);
      return leg;
    };
    this.legL = mkLeg(1);
    this.legR = mkLeg(-1);

    // soft contact shadow blob (cheaper than a casting rider)
    if (withShadowBlob) {
      const shadow = new THREE.Mesh(
        new THREE.CircleGeometry(0.85, 16),
        new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false })
      );
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.y = 0.03;
      shadow.scale.set(1.6, 1, 1);
      g.add(shadow);
    }

    this.object = g;
  }

  static jerseyCache = new Map<number, THREE.CanvasTexture>();

  /** advance animation: wheel spin from speed, leg cadence from rpm */
  update(dt: number, speedMs: number, cadenceRpm: number): void {
    const wheelOmega = speedMs / 0.34;
    for (const w of this.wheels) w.rotation.z -= wheelOmega * dt;
    this.crankAngle += (cadenceRpm / 60) * Math.PI * 2 * dt;
    this.legL.rotation.z = 0.45 + Math.sin(this.crankAngle) * 0.4;
    this.legR.rotation.z = 0.45 + Math.sin(this.crankAngle + Math.PI) * 0.4;
  }
}

/**
 * Cycling jersey: base color with darker side panels, white chest band with
 * "sponsor" blocks and a zipper line. Cached per color (NPCs share colors).
 */
function buildJerseyTexture(color: number): THREE.CanvasTexture {
  const cached = Rider.jerseyCache.get(color);
  if (cached) return cached;
  const S = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext("2d")!;
  const c = new THREE.Color(color);
  const css = (m: number) =>
    `rgb(${Math.min(255, c.r * 255 * m)}, ${Math.min(255, c.g * 255 * m)}, ${Math.min(255, c.b * 255 * m)})`;
  ctx.fillStyle = css(1);
  ctx.fillRect(0, 0, S, S);
  // darker side panels
  ctx.fillStyle = css(0.55);
  ctx.fillRect(0, 0, 14, S);
  ctx.fillRect(S - 14, 0, 14, S);
  // white chest band with sponsor blocks
  ctx.fillStyle = "#f2f2f2";
  ctx.fillRect(14, 46, S - 28, 26);
  ctx.fillStyle = css(0.8);
  ctx.fillRect(24, 52, 22, 14);
  ctx.fillStyle = "#2b2b2b";
  ctx.fillRect(56, 52, 30, 6);
  ctx.fillRect(56, 61, 18, 5);
  // zipper
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(S / 2, 0);
  ctx.lineTo(S / 2, S);
  ctx.stroke();
  // fabric grain
  const img = ctx.getImageData(0, 0, S, S);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 10;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  Rider.jerseyCache.set(color, tex);
  return tex;
}
