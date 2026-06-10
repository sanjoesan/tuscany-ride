/**
 * Demo-mode trainer: produces plausible power/cadence without hardware.
 * Arrow up/down changes target power, arrow left/right nudges cadence.
 */
import type { Telemetry } from "../types";

export class VirtualTrainer {
  targetPower = 150;
  cadence = 85;
  private timer: number | null = null;
  private onData: (t: Partial<Telemetry>) => void;
  private keyHandler = (e: KeyboardEvent) => {
    if (e.key === "ArrowUp") this.targetPower = Math.min(900, this.targetPower + 10);
    else if (e.key === "ArrowDown") this.targetPower = Math.max(0, this.targetPower - 10);
    else if (e.key === "ArrowRight") this.cadence = Math.min(130, this.cadence + 2);
    else if (e.key === "ArrowLeft") this.cadence = Math.max(0, this.cadence - 2);
    else return;
    e.preventDefault();
  };

  constructor(onData: (t: Partial<Telemetry>) => void) {
    this.onData = onData;
  }

  start(): void {
    window.addEventListener("keydown", this.keyHandler);
    this.timer = window.setInterval(() => {
      const noise = (Math.random() - 0.5) * 14;
      const power = Math.max(0, Math.round(this.targetPower + noise));
      const cad = this.targetPower === 0 ? 0 : Math.round(this.cadence + (Math.random() - 0.5) * 3);
      const hr = Math.round(95 + Math.min(85, this.targetPower * 0.32) + (Math.random() - 0.5) * 4);
      this.onData({ power, cadence: cad, heartRate: hr });
    }, 500);
  }

  stop(): void {
    window.removeEventListener("keydown", this.keyHandler);
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}
