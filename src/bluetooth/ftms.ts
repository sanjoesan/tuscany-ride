/**
 * FTMS (Fitness Machine Service) smart trainer client using Web Bluetooth.
 * Reads power / cadence / speed from the Indoor Bike Data characteristic and
 * writes road grade to the trainer via the simulation-parameters command, so
 * climbing in the game makes the pedals heavier - real hill feeling.
 *
 * Falls back to the Cycling Power service (power meters / older trainers)
 * when FTMS is not available on the device.
 */
import type { Telemetry } from "../types";

const FTMS_SERVICE = 0x1826;
const INDOOR_BIKE_DATA = 0x2ad2;
const FTMS_CONTROL_POINT = 0x2ad9;
const CPS_SERVICE = 0x1818;
const CPS_MEASUREMENT = 0x2a63;

export interface TrainerEvents {
  onData: (t: Partial<Telemetry>) => void;
  onDisconnect: () => void;
  onStatus: (msg: string) => void;
}

export class FtmsTrainer {
  private device: BluetoothDevice | null = null;
  private controlPoint: BluetoothRemoteGATTCharacteristic | null = null;
  private events: TrainerEvents;
  private hasControl = false;
  private lastGradeSent = NaN;
  private gradeTimer: number | null = null;
  private pendingGrade = 0;
  /** crank-event state for cadence derived from CPS */
  private lastCrankRevs = -1;
  private lastCrankTime = 0;

  mode: "ftms" | "cps" | "none" = "none";

  constructor(events: TrainerEvents) {
    this.events = events;
  }

  get connected(): boolean {
    return this.device?.gatt?.connected ?? false;
  }

  get name(): string {
    return this.device?.name ?? "trainer";
  }

  async connect(): Promise<void> {
    if (!navigator.bluetooth) {
      throw new Error("Web Bluetooth not available - use Chrome or Edge (and https/localhost).");
    }
    this.events.onStatus("choose your trainer...");
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [FTMS_SERVICE] }, { services: [CPS_SERVICE] }],
      optionalServices: [FTMS_SERVICE, CPS_SERVICE],
    });
    this.device.addEventListener("gattserverdisconnected", () => {
      this.events.onDisconnect();
    });
    const server = await this.device.gatt!.connect();
    this.events.onStatus("connecting services...");

    try {
      const ftms = await server.getPrimaryService(FTMS_SERVICE);
      const data = await ftms.getCharacteristic(INDOOR_BIKE_DATA);
      await data.startNotifications();
      data.addEventListener("characteristicvaluechanged", (e) => {
        this.parseIndoorBikeData((e.target as BluetoothRemoteGATTCharacteristic).value!);
      });
      this.mode = "ftms";
      // take control so we may set simulation parameters
      try {
        this.controlPoint = await ftms.getCharacteristic(FTMS_CONTROL_POINT);
        await this.controlPoint.startNotifications();
        await this.controlPoint.writeValue(new Uint8Array([0x00])); // request control
        await delay(150);
        await this.controlPoint.writeValue(new Uint8Array([0x07])); // start/resume
        this.hasControl = true;
      } catch (err) {
        console.warn("FTMS control point unavailable - resistance control disabled", err);
      }
      this.events.onStatus(`connected: ${this.name}`);
      return;
    } catch {
      // no FTMS - try cycling power service
    }

    const cps = await server.getPrimaryService(CPS_SERVICE);
    const meas = await cps.getCharacteristic(CPS_MEASUREMENT);
    await meas.startNotifications();
    meas.addEventListener("characteristicvaluechanged", (e) => {
      this.parseCyclingPower((e.target as BluetoothRemoteGATTCharacteristic).value!);
    });
    this.mode = "cps";
    this.events.onStatus(`connected (power only): ${this.name}`);
  }

  disconnect(): void {
    if (this.gradeTimer !== null) {
      clearInterval(this.gradeTimer);
      this.gradeTimer = null;
    }
    this.device?.gatt?.disconnect();
  }

  /**
   * Queue the road grade (fraction, e.g. 0.05) to be sent to the trainer.
   * Writes are throttled to ~2 Hz because trainers reject rapid CP writes.
   */
  setGrade(grade: number): void {
    this.pendingGrade = grade;
    if (this.gradeTimer === null && this.hasControl) {
      this.gradeTimer = window.setInterval(() => this.flushGrade(), 500);
      void this.flushGrade();
    }
  }

  private async flushGrade(): Promise<void> {
    if (!this.controlPoint || !this.hasControl || !this.connected) return;
    const g = this.pendingGrade;
    if (Math.abs(g - this.lastGradeSent) < 0.002) return;
    this.lastGradeSent = g;
    // Set Indoor Bike Simulation Parameters (0x11):
    // s16 wind speed (0.001 m/s), s16 grade (0.01 %), u8 crr (0.0001), u8 cw (0.01 kg/m)
    const buf = new ArrayBuffer(7);
    const dv = new DataView(buf);
    dv.setUint8(0, 0x11);
    dv.setInt16(1, 0, true);
    dv.setInt16(3, Math.round(g * 10000), true); // fraction -> 0.01 %
    dv.setUint8(5, 40); // crr 0.004
    dv.setUint8(6, 51); // cw 0.51
    try {
      await this.controlPoint.writeValue(buf);
    } catch {
      // trainer busy - retry on next tick
      this.lastGradeSent = NaN;
    }
  }

  private parseIndoorBikeData(dv: DataView): void {
    const flags = dv.getUint16(0, true);
    let o = 2;
    const out: Partial<Telemetry> = {};
    if ((flags & 0x0001) === 0) {
      out.trainerSpeed = dv.getUint16(o, true) / 100; // km/h
      o += 2;
    }
    if (flags & 0x0002) o += 2; // average speed
    if (flags & 0x0004) {
      out.cadence = dv.getUint16(o, true) / 2;
      o += 2;
    }
    if (flags & 0x0008) o += 2; // average cadence
    if (flags & 0x0010) o += 3; // total distance u24
    if (flags & 0x0020) o += 2; // resistance level
    if (flags & 0x0040) {
      out.power = dv.getInt16(o, true);
      o += 2;
    }
    if (flags & 0x0080) o += 2; // average power
    if (flags & 0x0100) o += 5; // energy: total u16 + per hour u16 + per min u8
    if (flags & 0x0200) {
      out.heartRate = dv.getUint8(o);
      o += 1;
    }
    this.events.onData(out);
  }

  private parseCyclingPower(dv: DataView): void {
    const flags = dv.getUint16(0, true);
    let o = 2;
    const out: Partial<Telemetry> = { power: dv.getInt16(o, true) };
    o += 2;
    if (flags & 0x0001) o += 1; // pedal power balance
    if (flags & 0x0004) o += 2; // accumulated torque
    if (flags & 0x0010) o += 6; // wheel revolution data
    if (flags & 0x0020) {
      // crank revolution data -> cadence
      const revs = dv.getUint16(o, true);
      const time = dv.getUint16(o + 2, true); // 1/1024 s
      if (this.lastCrankRevs >= 0 && revs !== this.lastCrankRevs) {
        const dRevs = (revs - this.lastCrankRevs + 0x10000) % 0x10000;
        const dTime = ((time - this.lastCrankTime + 0x10000) % 0x10000) / 1024;
        if (dTime > 0) out.cadence = Math.min(200, (dRevs / dTime) * 60);
      }
      this.lastCrankRevs = revs;
      this.lastCrankTime = time;
    }
    this.events.onData(out);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
