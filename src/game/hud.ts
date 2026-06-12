import type { RoadSample } from "../world/terrain";
import type { RideStats } from "../types";

const $ = (id: string) => document.getElementById(id)!;

export class Hud {
  private profileCtx: CanvasRenderingContext2D;
  private profile: { d: number; y: number; grade: number }[] = [];
  private minY = 0;
  private maxY = 1;
  private total = 1;

  constructor() {
    this.profileCtx = ($("profile-canvas") as HTMLCanvasElement).getContext("2d")!;
  }

  show(): void {
    $("hud").classList.remove("hidden");
  }

  hide(): void {
    $("hud").classList.add("hidden");
    this.showTurns(null, 0);
  }

  /** free roam has no fixed route - hide the elevation profile */
  setFreeMode(free: boolean): void {
    ($("profile-canvas") as HTMLCanvasElement).style.display = free ? "none" : "";
  }

  /** junction arrows: one glyph per exit, the chosen one highlighted */
  showTurns(angles: number[] | null, selected: number): void {
    const el = $("turn-ui");
    if (!angles || angles.length === 0) {
      el.classList.add("hidden");
      return;
    }
    el.classList.remove("hidden");
    el.innerHTML = angles
      .map((a, i) => {
        const glyph =
          a < -2.4 ? "&#10550;" : a < -0.5 ? "&#8624;" : a <= 0.5 ? "&#8593;" : a <= 2.4 ? "&#8625;" : "&#10551;";
        return `<span class="turn-arrow${i === selected ? " sel" : ""}">${glyph}</span>`;
      })
      .join("");
  }

  setPath(samples: RoadSample[], totalLength: number): void {
    this.profile = samples.map((s) => ({ d: s.dist, y: s.y, grade: s.grade }));
    this.total = totalLength;
    this.minY = Infinity;
    this.maxY = -Infinity;
    for (const p of this.profile) {
      if (p.y < this.minY) this.minY = p.y;
      if (p.y > this.maxY) this.maxY = p.y;
    }
  }

  update(v: {
    power: number; speedKmh: number; cadence: number; hr: number;
    grade: number; distanceM: number; timeS: number; elevation: number; rideDist: number;
  }): void {
    $("hud-power").textContent = String(Math.round(v.power));
    $("hud-speed").textContent = v.speedKmh.toFixed(1);
    $("hud-cadence").textContent = String(Math.round(v.cadence));
    $("hud-hr").textContent = v.hr > 0 ? String(Math.round(v.hr)) : "--";
    const g = v.grade * 100;
    const gradeEl = $("hud-grade");
    gradeEl.textContent = `${g >= 0 ? "" : ""}${g.toFixed(1)}%`;
    gradeEl.style.color = g > 6 ? "#ff6b5e" : g > 2.5 ? "#f7b733" : g < -2 ? "#6fc1ff" : "#fff";
    $("hud-distance").textContent = (v.distanceM / 1000).toFixed(2);
    const min = Math.floor(v.timeS / 60);
    const hrs = Math.floor(min / 60);
    const sec = Math.floor(v.timeS % 60);
    $("hud-time").textContent = hrs > 0
      ? `${hrs}:${String(min % 60).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
      : `${min}:${String(sec).padStart(2, "0")}`;
    $("hud-elevation").textContent = String(Math.round(v.elevation));
    this.drawProfile(v.rideDist);
  }

  /** "r,g,b" for a gradient, so the climbs ahead read at a glance */
  private gradeRGB(g: number): string {
    const a = Math.abs(g) * 100;
    if (g < -0.005) return "95,168,224"; // descent
    if (a < 3) return "92,196,106"; // easy
    if (a < 6) return "224,169,58"; // rolling
    if (a < 9) return "224,107,42"; // steep
    return "210,59,59"; // very steep
  }

  private drawProfile(rideDist: number): void {
    if (this.profile.length === 0) return; // free ride has no fixed route
    const ctx = this.profileCtx;
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    ctx.clearRect(0, 0, w, h);
    const range = Math.max(10, this.maxY - this.minY);
    const py = (y: number) => h - 8 - ((y - this.minY) / range) * (h - 18);
    const d0 = ((rideDist % this.total) + this.total) % this.total;

    // gradient-coloured columns; the stretch already ridden is dimmed
    const STEP = 2;
    let si = 0;
    for (let x = 0; x < w; x += STEP) {
      const d = (x / (w - 1)) * this.total;
      while (si < this.profile.length - 1 && this.profile[si + 1].d < d) si++;
      const p = this.profile[si];
      const top = py(p.y);
      ctx.fillStyle = `rgba(${this.gradeRGB(p.grade)},${d < d0 ? 0.3 : 0.92})`;
      ctx.fillRect(x, top, STEP, h - top);
    }

    // rider marker
    const idx = this.profile.findIndex((p) => p.d >= d0);
    const yy = idx >= 0 ? this.profile[idx].y : this.profile[0].y;
    const mx = (d0 / this.total) * w;
    ctx.beginPath();
    ctx.arc(mx, py(yy), 4.5, 0, Math.PI * 2);
    ctx.fillStyle = "#ff4a3d";
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

export function showSummary(stats: RideStats): void {
  const fmt = (v: number, digits = 0) => v.toFixed(digits);
  const min = Math.floor(stats.durationS / 60);
  const sec = Math.floor(stats.durationS % 60);
  const rows: [string, string][] = [
    [`${min}:${String(sec).padStart(2, "0")}`, "TIME"],
    [`${(stats.distanceM / 1000).toFixed(2)} km`, "DISTANCE"],
    [`${fmt(stats.elevationGainM)} m`, "CLIMBED"],
    [`${fmt(stats.avgPower)} W`, "AVG POWER"],
    [`${fmt(stats.maxPower)} W`, "MAX POWER"],
    [`${fmt(stats.avgSpeedKmh, 1)} km/h`, "AVG SPEED"],
    [`${fmt(stats.avgCadence)} rpm`, "AVG CADENCE"],
    [stats.avgHr > 0 ? `${fmt(stats.avgHr)} bpm` : "--", "AVG HR"],
    [`${stats.calories} kcal`, "CALORIES"],
  ];
  const grid = $("summary-stats");
  grid.innerHTML = rows
    .map(([v, l]) => `<div class="stat"><b>${v}</b><span>${l}</span></div>`)
    .join("");
  $("summary").classList.remove("hidden");
}

export function toast(msg: string, ms = 2600): void {
  const el = $("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  window.clearTimeout((el as any)._t);
  (el as any)._t = window.setTimeout(() => el.classList.add("hidden"), ms);
}
