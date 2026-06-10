import * as THREE from "three";
import { defaultMap, loadSavedMap, saveMapLocal, clearSavedMap, validateMap } from "./world/mapData";
import { World } from "./world/world";
import { RideController } from "./game/ride";
import { Hud, showSummary, toast } from "./game/hud";
import { FtmsTrainer } from "./bluetooth/ftms";
import { HeartRateSensor } from "./bluetooth/heartRate";
import { VirtualTrainer } from "./bluetooth/virtualTrainer";
import { Editor } from "./editor/editor";
import { NpcManager } from "./game/npc";
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

// ---------------- telemetry ----------------
const telemetry: Telemetry = { power: 0, cadence: 0, heartRate: 0, trainerSpeed: 0 };
let powerTimeout: number | null = null;

function onTrainerData(d: Partial<Telemetry>): void {
  if (d.power !== undefined) {
    telemetry.power = d.power;
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

// ---------------- modes & world (built deferred, behind a loading screen) ----------------
type Mode = "menu" | "riding" | "editor";
let mode: Mode = "menu";
const hud = new Hud();
let world: World;
let npcs: NpcManager;
let ride: RideController | null = null;
let editor: Editor | null = null;
let selectedRoute = Number(localStorage.getItem("roadgame.route") ?? 0);
let menuAngle = 0;

function populateRoutePicker(): void {
  const sel = $("route-select") as HTMLSelectElement;
  sel.innerHTML = "";
  const free = document.createElement("option");
  free.value = "-1";
  free.textContent = "🧭 Free ride - explore the network, turn anywhere";
  sel.append(free);
  world.routes.forEach((r, i) => {
    const opt = document.createElement("option");
    const h = Math.floor(r.stats.estMinutes / 60);
    const min = r.stats.estMinutes % 60;
    const time = h > 0 ? `${h}h${String(min).padStart(2, "0")}` : `${min} min`;
    opt.value = String(i);
    opt.textContent = `${r.name} - ${r.stats.distanceKm.toFixed(1)} km · ~${time}`;
    sel.append(opt);
  });
  if (selectedRoute >= world.routes.length) selectedRoute = 0;
  sel.value = String(selectedRoute);
  updateRouteInfo();
  sel.onchange = () => {
    selectedRoute = Number(sel.value);
    localStorage.setItem("roadgame.route", sel.value);
    updateRouteInfo();
  };
}

function updateRouteInfo(): void {
  if (selectedRoute === -1) {
    $("route-info").textContent =
      `Free ride on ${world.network.totalKm.toFixed(0)} km of roads: ←/→ picks the turn at junctions, U turns around`;
    return;
  }
  const r = world.routes[selectedRoute];
  if (!r) return;
  $("route-info").textContent =
    `${r.stats.distanceKm.toFixed(1)} km · ${r.stats.gainM} m climbing · max ${r.stats.maxGradePct}% · ~${r.stats.estMinutes} min at 29 km/h`;
}

function startRide(): void {
  const freeRide = selectedRoute === -1;
  const route = world.routes[freeRide ? 0 : selectedRoute];
  if (!route && !freeRide) return;
  const weight = Number(($("inp-weight") as HTMLInputElement).value) || 75;
  const bikeWeight = Number(($("inp-bike-weight") as HTMLInputElement).value) || 9;
  const difficulty = Number(($("inp-difficulty") as HTMLInputElement).value) / 100;
  saveSettings();

  const bikeColor = parseInt(($("inp-bike-color") as HTMLInputElement).value.slice(1), 16);
  const jerseyColor = parseInt(($("inp-jersey") as HTMLInputElement).value.slice(1), 16);
  ride = new RideController(world, camera, hud, telemetry, bikeColor, jerseyColor);
  ride.onGrade = (g) => trainer.setGrade(g);
  ride.onTurnOptions = (options, sel) =>
    hud.showTurns(options ? options.map((o) => o.angle) : null, sel);
  if (freeRide) {
    ride.startFree(weight + bikeWeight, difficulty, 0);
    toast("Free ride - ←/→ choose the turn, U turns around. Buon viaggio!");
  } else {
    ride.start(weight + bikeWeight, difficulty, route);
    toast(`${route.name} - ${route.stats.distanceKm.toFixed(1)} km. Buon viaggio!`);
  }
  $("menu").classList.add("hidden");
  mode = "riding";
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
  npcs.dispose();
  world.quality = "fast";
  world.rebuild();
  editor = new Editor(world, camera, renderer);
  editor.onExit = () => {
    editor = null;
    mode = "menu";
    world.quality = "full";
    world.rebuild();
    npcs.build();
    populateRoutePicker();
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
    jersey: ($("inp-jersey") as HTMLInputElement).value,
    bikeColor: ($("inp-bike-color") as HTMLInputElement).value,
    time: ($("inp-time") as HTMLSelectElement).value,
    season: ($("inp-season") as HTMLSelectElement).value,
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
    if (s.jersey) ($("inp-jersey") as HTMLInputElement).value = s.jersey;
    if (s.bikeColor) ($("inp-bike-color") as HTMLInputElement).value = s.bikeColor;
    if (s.time) ($("inp-time") as HTMLSelectElement).value = s.time;
    if (s.season) ($("inp-season") as HTMLSelectElement).value = s.season;
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
    npcs.build();
    populateRoutePicker();
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
  npcs.build();
  populateRoutePicker();
  $("map-name").textContent = world.map.name;
  toast("Back to Toscana Grande");
};

window.addEventListener("keydown", (e) => {
  if (mode !== "riding" || !ride) return;
  if (e.key === "c" || e.key === "C") ride.cycleCamera();
  else if (e.key === "ArrowLeft") {
    ride.chooseTurn(-1);
    e.preventDefault();
  } else if (e.key === "ArrowRight") {
    ride.chooseTurn(1);
    e.preventDefault();
  } else if (e.key === "u" || e.key === "U" || e.key === "Backspace") {
    ride.uTurn();
  }
});

// ---------------- gamepad: stick = turn, B = u-turn, RT = demo power ----------------
let gpPrevAxis = 0;
let gpPrevB = false;
let gpPrevY = false;
function pollGamepad(): void {
  const gp = navigator.getGamepads?.()[0];
  if (!gp || mode !== "riding" || !ride) return;
  const axis = gp.axes[0] ?? 0;
  if (axis < -0.55 && gpPrevAxis >= -0.55) ride.chooseTurn(-1);
  if (axis > 0.55 && gpPrevAxis <= 0.55) ride.chooseTurn(1);
  gpPrevAxis = axis;
  const b = gp.buttons[1]?.pressed ?? false;
  if (b && !gpPrevB) ride.uTurn();
  gpPrevB = b;
  const y = gp.buttons[3]?.pressed ?? false;
  if (y && !gpPrevY) ride.cycleCamera();
  gpPrevY = y;
  // right trigger drives the virtual trainer in demo mode
  const rt = gp.buttons[7]?.value ?? 0;
  if (virtual && rt > 0.04) virtual.targetPower = Math.round(rt * 500);
}

($("inp-time") as HTMLSelectElement).onchange = (e) => {
  world?.environment.setTimeOfDay((e.target as HTMLSelectElement).value as never);
  saveSettings();
};

($("inp-season") as HTMLSelectElement).onchange = (e) => {
  if (!world) return;
  const season = (e.target as HTMLSelectElement).value as typeof world.season;
  $("loading").classList.remove("hidden");
  setTimeout(() => {
    world.season = season;
    world.rebuild();
    npcs.build();
    $("loading").classList.add("hidden");
    toast(`Season: ${season}`);
  }, 50);
  saveSettings();
};

// ---------------- main loop ----------------
const clock = new THREE.Clock();

function animate(): void {
  requestAnimationFrame(animate);
  if (!world) return;
  const dt = Math.min(clock.getDelta(), 0.1);
  const t = clock.elapsedTime;
  world.update(t, camera.position);
  pollGamepad();
  if (mode !== "editor") {
    npcs?.update(
      dt,
      t,
      mode === "riding" && ride
        ? { pos: ride.rider.object.position, speed: ride.physics.v }
        : null
    );
  }

  if (mode === "riding" && ride) {
    ride.update(dt);
  } else if (mode === "editor" && editor) {
    editor.update();
  } else {
    // menu: slow scenic orbit above the first town
    menuAngle += dt * 0.05;
    const town = world.map.towns[0];
    const r = town.radius + 380;
    camera.position.set(
      town.x + Math.cos(menuAngle) * r,
      190 + Math.sin(menuAngle * 0.7) * 30,
      town.z + Math.sin(menuAngle) * r
    );
    camera.lookAt(town.x, 20, town.z);
  }

  renderer.render(scene, camera);
}

// ---------------- boot: build the world behind the loading screen ----------------
setTimeout(() => {
  world = new World(scene, loadSavedMap() ?? defaultMap(), renderer);
  // apply persisted season/time before first frame
  const seasonSel = ($("inp-season") as HTMLSelectElement).value as typeof world.season;
  if (seasonSel !== "summer") {
    world.season = seasonSel;
    world.rebuild();
  }
  world.environment.setTimeOfDay(($("inp-time") as HTMLSelectElement).value as never);
  npcs = new NpcManager(world);
  npcs.build();
  $("map-name").textContent = world.map.name;
  populateRoutePicker();
  $("loading").classList.add("hidden");

  // dev helpers for automated screenshots: #noui hides the menu, #autoride starts a demo ride,
  // #route=N / #time=night / #season=autumn force a specific setup
  if (location.hash.includes("noui")) $("menu").classList.add("hidden");
  const routeM = /route=(-?\d+)/.exec(location.hash);
  if (routeM) selectedRoute = Math.max(-1, Math.min(world.routes.length - 1, Number(routeM[1])));
  const timeM = /time=(\w+)/.exec(location.hash);
  if (timeM) world.environment.setTimeOfDay(timeM[1] as never);
  const seasonM = /season=(\w+)/.exec(location.hash);
  if (seasonM) {
    world.season = seasonM[1] as typeof world.season;
    world.rebuild();
    npcs.build();
  }
  if (location.hash.includes("autoride")) {
    virtual = new VirtualTrainer(onTrainerData);
    virtual.start();
    telemetry.power = 180;
    telemetry.cadence = 88;
    updateStartButton();
    startRide();
    const ff = Number(/autoride=(\d+)/.exec(location.hash)?.[1] ?? 0);
    if (ff > 0 && ride) {
      for (let i = 0; i < ff * 10; i++) (ride as RideController).update(0.1);
    }
    if (location.hash.includes("stopAtTurn") && ride) {
      const r2 = ride as RideController;
      for (let i = 0; i < 4000 && !r2.hasTurnOptions; i++) r2.update(0.1);
    }
    if (location.hash.includes("cam2") && ride) {
      (ride as RideController).cycleCamera();
      (ride as RideController).cycleCamera();
      (ride as RideController).update(0.5);
    }
  }
}, 60);

animate();
