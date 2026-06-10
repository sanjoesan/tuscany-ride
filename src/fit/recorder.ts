import type { RideSample, RideStats } from "../types";
import { FitEncoder, T, toFitTime, toSemicircles } from "./fitEncoder";

/**
 * Records one sample per second during the ride and turns the result into a
 * Garmin-compatible .FIT activity. Game coordinates are mapped to real GPS
 * coordinates on the Tuscan coast so Garmin Connect shows a proper map.
 */

// Anchor: Castiglione della Pescaia, Tuscany, Italy
const LAT0 = 42.765;
const LON0 = 10.882;

export function gameToGps(x: number, z: number): { lat: number; lon: number } {
  const lat = LAT0 - z / 111320;
  const lon = LON0 + x / (111320 * Math.cos((LAT0 * Math.PI) / 180));
  return { lat, lon };
}

export class RideRecorder {
  samples: RideSample[] = [];
  startTime = 0;
  private lastSampleT = 0;

  start(): void {
    this.samples = [];
    this.startTime = Date.now();
    this.lastSampleT = 0;
  }

  /** Call every frame; stores at most one sample per second. */
  maybeSample(s: Omit<RideSample, "t">): void {
    const now = Date.now();
    if (now - this.lastSampleT < 1000) return;
    this.lastSampleT = now;
    this.samples.push({ t: now, ...s });
  }

  stats(): RideStats {
    const n = this.samples.length;
    const sum = (f: (s: RideSample) => number) => this.samples.reduce((a, s) => a + f(s), 0);
    const max = (f: (s: RideSample) => number) => this.samples.reduce((a, s) => Math.max(a, f(s)), 0);
    const avgPower = n ? sum((s) => s.power) / n : 0;
    let gain = 0;
    for (let i = 1; i < n; i++) {
      const d = this.samples[i].altitude - this.samples[i - 1].altitude;
      if (d > 0) gain += d;
    }
    const durationS = n ? (this.samples[n - 1].t - this.samples[0].t) / 1000 : 0;
    return {
      startTime: this.startTime,
      durationS,
      distanceM: n ? this.samples[n - 1].distance : 0,
      avgPower,
      maxPower: max((s) => s.power),
      avgCadence: n ? sum((s) => s.cadence) / n : 0,
      avgHr: n ? sum((s) => s.heartRate) / n : 0,
      maxHr: max((s) => s.heartRate),
      avgSpeedKmh: n ? (sum((s) => s.speed) / n) * 3.6 : 0,
      maxSpeedKmh: max((s) => s.speed) * 3.6,
      elevationGainM: gain,
      calories: Math.round((avgPower * durationS) / 1000 / 4.184 * 1.05), // kJ -> kcal at ~24% efficiency
    };
  }

  /** Build the .FIT activity file. */
  toFit(): Uint8Array {
    const enc = new FitEncoder();
    const stats = this.stats();
    const startFit = toFitTime(this.startTime);
    const endFit = toFitTime(this.samples.length ? this.samples[this.samples.length - 1].t : this.startTime);

    // file_id
    enc.writeMessage(0, 0, [
      { num: 0, type: T.enum, value: 4 }, // activity file
      { num: 1, type: T.u16, value: 255 }, // manufacturer: development
      { num: 2, type: T.u16, value: 1 },
      { num: 3, type: T.u32z, value: (Math.random() * 0xfffffff) | 1 },
      { num: 4, type: T.u32, value: startFit },
    ]);

    // timer start event
    enc.writeMessage(1, 21, [
      { num: 253, type: T.u32, value: startFit },
      { num: 0, type: T.enum, value: 0 }, // timer
      { num: 1, type: T.enum, value: 0 }, // start
    ]);

    // records
    for (const s of this.samples) {
      enc.writeMessage(2, 20, [
        { num: 253, type: T.u32, value: toFitTime(s.t) },
        { num: 0, type: T.s32, value: toSemicircles(s.lat) },
        { num: 1, type: T.s32, value: toSemicircles(s.lon) },
        { num: 2, type: T.u16, value: Math.round((s.altitude + 500) * 5) },
        { num: 3, type: T.u8, value: Math.min(255, Math.round(s.heartRate)) },
        { num: 4, type: T.u8, value: Math.min(254, Math.round(s.cadence)) },
        { num: 5, type: T.u32, value: Math.round(s.distance * 100) },
        { num: 6, type: T.u16, value: Math.round(s.speed * 1000) },
        { num: 7, type: T.u16, value: Math.round(s.power) },
      ]);
    }

    // timer stop event
    enc.writeMessage(1, 21, [
      { num: 253, type: T.u32, value: endFit },
      { num: 0, type: T.enum, value: 0 },
      { num: 1, type: T.enum, value: 4 }, // stop_all
    ]);

    const elapsedMs = Math.round(stats.durationS * 1000);

    // lap (one big lap)
    enc.writeMessage(3, 19, [
      { num: 253, type: T.u32, value: endFit },
      { num: 254, type: T.u16, value: 0 }, // message_index
      { num: 2, type: T.u32, value: startFit }, // start_time
      { num: 7, type: T.u32, value: elapsedMs },
      { num: 8, type: T.u32, value: elapsedMs },
      { num: 9, type: T.u32, value: Math.round(stats.distanceM * 100) },
      { num: 0, type: T.enum, value: 9 }, // event: lap
      { num: 1, type: T.enum, value: 1 }, // event_type: stop
    ]);

    // session
    enc.writeMessage(4, 18, [
      { num: 253, type: T.u32, value: endFit },
      { num: 254, type: T.u16, value: 0 },
      { num: 2, type: T.u32, value: startFit },
      { num: 7, type: T.u32, value: elapsedMs },
      { num: 8, type: T.u32, value: elapsedMs },
      { num: 9, type: T.u32, value: Math.round(stats.distanceM * 100) },
      { num: 5, type: T.enum, value: 2 }, // sport: cycling
      { num: 6, type: T.enum, value: 58 }, // sub sport: virtual activity
      { num: 14, type: T.u16, value: Math.round((stats.avgSpeedKmh / 3.6) * 1000) },
      { num: 15, type: T.u16, value: Math.round((stats.maxSpeedKmh / 3.6) * 1000) },
      { num: 20, type: T.u16, value: Math.round(stats.avgPower) },
      { num: 21, type: T.u16, value: Math.round(stats.maxPower) },
      { num: 18, type: T.u8, value: Math.min(254, Math.round(stats.avgCadence)) },
      { num: 16, type: T.u8, value: Math.min(255, Math.round(stats.avgHr)) },
      { num: 17, type: T.u8, value: Math.min(255, Math.round(stats.maxHr)) },
      { num: 22, type: T.u16, value: Math.round(stats.elevationGainM) },
      { num: 11, type: T.u16, value: stats.calories },
      { num: 25, type: T.u16, value: 0 }, // first_lap_index
      { num: 26, type: T.u16, value: 1 }, // num_laps
      { num: 0, type: T.enum, value: 8 }, // event: session
      { num: 1, type: T.enum, value: 1 }, // event_type: stop
    ]);

    // activity
    enc.writeMessage(5, 34, [
      { num: 253, type: T.u32, value: endFit },
      { num: 0, type: T.u32, value: elapsedMs },
      { num: 1, type: T.u16, value: 1 }, // num_sessions
      { num: 2, type: T.enum, value: 0 }, // type: manual
      { num: 3, type: T.enum, value: 26 }, // event: activity
      { num: 4, type: T.enum, value: 1 }, // event_type: stop
      { num: 5, type: T.u32, value: endFit - new Date().getTimezoneOffset() * 60 },
    ]);

    return enc.finish();
  }

  /** Trigger a browser download of the FIT file. */
  download(): string {
    const bytes = this.toFit();
    const d = new Date(this.startTime);
    const pad = (v: number) => String(v).padStart(2, "0");
    const name = `TuscanyRide_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.fit`;
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return name;
  }
}
