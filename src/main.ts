import * as THREE from "three";
import { defaultMap, loadSavedMap, saveMapLocal, clearSavedMap, validateMap } from "./world/mapData";
import { World } from "./world/world";
import { RideController } from "./game/ride";
import { Hud, showSummary, toast } from "./game/hud";
import { FtmsTrainer } from "./bluetooth/ftms";
import { HeartRateSensor } from "./bluetooth/heartRate";
import { VirtualTrainer } from "./bluetooth/virtualTrainer";
import { Editor } from "./editor/editor";
import type { Telemetry } from "./types";

const $ = (id: string) => document.getElementById(id)!;

// ---------------- renderer / scene ----------------
const canvas = $("scene") as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.62;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.5, 30000);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

const world = new World(scene, loadSavedMap() ?? defaultMap(), renderer);
$("map-name").textContent = world.map.name;

// ---------------- telemetry ----------------
const telemetry: Telemetry = { power: 0, cadence: 0, heartRate: 0, trainerSpeed: 0 };
let powerTimeout: number | null = null;

function onTrainerData(d: Partial<Telemetry>): void {
  if (d.power !== undefined) {
    telemetry.power = d.power;
    // zero power if no update arrives for a while (trainer stopped sending)
    if (powerTimeout !== null) clearTimeout(powerTimeout);
    powerTimeout = window.setTimeout(() => (telemetry.power = 0), 4000);
  }
  if (d.cadence !== undefined) telemetry.cadence = d.cadence;
  if (d.heartRate !== undefined && d.heartRate > 0 && !hr.connected) telemetry.heartRate = d.heartRate;
  if (d.trainerSpeed !== undefined) telemetry.trainerSpeed = d.trainerSpeed;
}

const trainer = new FtmsTrainer({
  onData: onTrainerData,
  onDisconnect: () => {
    setStatus("trainer-status", "disconnected", false);
    toast("Trainer disconnected");
    updateStartButton();
  },
  onStatus: (msg) => setStatus("trainer-status", msg, true),
});

const hr = new HeartRateSensor();
hr.onHeartRate = (bpm) => (telemetry.heartRate = bpm);
hr.onDisconnect = () => setStatus("hr-status", "disconnected", false);

let virtual: VirtualTrainer | null = null;

function setStatus(id: string, msg: string, ok: boolean): void {
  const el = $(id);
  el.textContent = msg;
  el.classList.toggle("ok", ok);
}

function updateStartButton(): void {
  ($("btn-start-ride") as HTMLButtonElement).disabled = !(trainer.connected || virtual !== null);
}

// ---------------- modes ----------------
type Mode = "menu" | "riding" | "editor";
let mode: Mode = "menu";
const hud = new Hud();
let ride: RideController | null = null;
let editor: Editor | null = null;

// menu flythrough camera state
let menuAngle = 0;

function startRide(): void {
  const weight = Number(($("inp-weight") as HTMLInputElement).value) || 75;
  const bikeWeight = Number(($("inp-bike-weight") as HTMLInputElement).value) || 9;
  const difficulty = Number(($("inp-difficulty") as HTMLInputElement).value) / 100;
  saveSettings();

  ride = new RideController(world, camera, hud, telemetry);
  ride.onGrade = (g) => trainer.setGrade(g);
  ride.start(weight + bikeWeight, difficulty);
  $("menu").classList.add("hidden");
  mode = "riding";
  toast(`Ride started on "${world.map.name}" - buon viaggio!`);
}

function endRide(): void {
  if (!ride) return;
  ride.stop();
  mode = "menu";
  const stats = ride.recorder.stats();
  if (stats.durationS >= 5) {
    showSummary(stats);
  } else {
    $("menu").classList.remove("hidden");
    toast("Ride too short to save");
  }
}

function openEditor(): void {
  $("menu").classList.add("hidden");
  mode = "editor";
  editor = new Editor(world, camera, renderer);
  editor.onExit = () => {
    editor = null;
    mode = "menu";
    $("menu").classList.remove("hidden");
    $("map-name").textContent = world.map.name;
  };
}

// ---------------- settings persistence ----------------
function saveSettings(): void {
  const s = {
    weight: ($("inp-weight") as HTMLInputElement).value,
    bike: ($("inp-bike-weight") as HTMLInputElement).value,
    diff: ($("inp-difficulty") as HTMLInputElement).value,
    ftp: ($("inp-ftp") as HTMLInputElement).value,
  };
  localStorage.setItem("roadgame.settings", JSON.stringify(s));
}

function loadSettings(): void {
  try {
    const raw = localStorage.getItem("roadgame.settings");
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s.weight) ($("inp-weight") as HTMLInputElement).value = s.weight;
    if (s.bike) ($("inp-bike-weight") as HTMLInputElement).value = s.bike;
    if (s.diff) ($("inp-difficulty") as HTMLInputElement).value = s.diff;
    if (s.ftp) ($("inp-ftp") as HTMLInputElement).value = s.ftp;
  } catch {
    /* ignore */
  }
}
loadSettings();

// ---------------- UI wiring ----------------
$("btn-connect-trainer").onclick = async () => {
  try {
    await trainer.connect();
    updateStartButton();
  } catch (err) {
    setStatus("trainer-status", "not connected", false);
    if ((err as Error).name !== "NotFoundError") toast(`Bluetooth: ${(err as Error).message}`, 4500);
  }
};

$("btn-connect-hr").onclick = async () => {
  try {
    await hr.connect();
    setStatus("hr-status", `connected: ${hr.name}`, true);
  } catch (err) {
    if ((err as Error).name !== "NotFoundError") toast(`Bluetooth: ${(err as Error).message}`, 4500);
  }
};

$("btn-demo").onclick = () => {
  if (virtual) {
    virtual.stop();
    virtual = null;
    ($("btn-demo") as HTMLButtonElement).textContent = "🎮 Demo Mode (no trainer)";
  } else {
    virtual = new VirtualTrainer(onTrainerData);
    virtual.start();
    ($("btn-demo") as HTMLButtonElement).textContent = "🎮 Demo Mode: ON";
    toast("Demo mode - arrow keys change power/cadence");
  }
  updateStartButton();
};

$("btn-start-ride").onclick = startRide;
$("btn-end-ride").onclick = endRide;
$("btn-editor").onclick = openEditor;

$("btn-export-fit").onclick = () => {
  if (!ride) return;
  const name = ride.recorder.download();
  toast(`Saved ${name} - upload it to Garmin Connect`, 5000);
};

$("btn-back-menu").onclick = () => {
  $("summary").classList.add("hidden");
  $("menu").classList.remove("hidden");
};

($("inp-load-map") as HTMLInputElement).onchange = async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    const map = validateMap(JSON.parse(await file.text()));
    world.setMap(map);
    saveMapLocal(map);
    $("map-name").textContent = map.name;
    toast(`Map "${map.name}" loaded`);
  } catch (err) {
    toast(`Could not load map: ${(err as Error).message}`, 4500);
  }
  (e.target as HTMLInputElement).value = "";
};

$("btn-reset-map").onclick = () => {
  clearSavedMap();
  world.setMap(defaultMap());
  $("map-name").textContent = world.map.name;
  toast("Back to Toscana Classica");
};

window.addEventListener("keydown", (e) => {
  if (mode === "riding" && (e.key === "c" || e.key === "C")) ride?.cycleCamera();
});

// dev helpers for automated screenshots: #noui hides the menu, #autoride starts a demo ride
if (location.hash.includes("noui")) $("menu").classList.add("hidden");
if (location.hash.includes("autoride")) {
  virtual = new VirtualTrainer(onTrainerData);
  virtual.start();
  telemetry.power = 180;
  telemetry.cadence = 88;
  updateStartButton();
  startRide();
  // optional fast-forward: #autoride=120 simulates 120 s before the first frame
  const ff = Number(/autoride=(\d+)/.exec(location.hash)?.[1] ?? 0);
  const r = ride as RideController | null; // assigned inside startRide()
  if (ff > 0 && r) {
    for (let i = 0; i < ff * 10; i++) r.update(0.1);
  }
  if (location.hash.includes("cam2") && r) {
    r.cycleCamera();
    r.cycleCamera(); // side view, for shadow/model inspection
    r.update(0.5);
  }
}

// ---------------- main loop ----------------
const clock = new THREE.Clock();

function animate(): void {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);
  const t = clock.elapsedTime;
  world.update(t, camera.position);

  if (mode === "riding" && ride) {
    ride.update(dt);
  } else if (mode === "editor" && editor) {
    editor.update();
  } else {
    // menu: slow scenic orbit above the town
    menuAngle += dt * 0.05;
    const m = world.map;
    const r = m.town.radius + 320;
    camera.position.set(
      m.town.x + Math.cos(menuAngle) * r,
      170 + Math.sin(menuAngle * 0.7) * 30,
      m.town.z + Math.sin(menuAngle) * r
    );
    camera.lookAt(m.town.x, 20, m.town.z);
  }

  renderer.render(scene, camera);
}
animate();
