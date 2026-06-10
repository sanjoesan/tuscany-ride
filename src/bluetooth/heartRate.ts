/** Bluetooth LE heart-rate strap (standard Heart Rate Service). */

export class HeartRateSensor {
  private device: BluetoothDevice | null = null;
  onHeartRate: (bpm: number) => void = () => {};
  onDisconnect: () => void = () => {};

  get connected(): boolean {
    return this.device?.gatt?.connected ?? false;
  }

  get name(): string {
    return this.device?.name ?? "HR sensor";
  }

  async connect(): Promise<void> {
    if (!navigator.bluetooth) {
      throw new Error("Web Bluetooth not available - use Chrome or Edge.");
    }
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: ["heart_rate"] }],
    });
    this.device.addEventListener("gattserverdisconnected", () => this.onDisconnect());
    const server = await this.device.gatt!.connect();
    const svc = await server.getPrimaryService("heart_rate");
    const ch = await svc.getCharacteristic("heart_rate_measurement");
    await ch.startNotifications();
    ch.addEventListener("characteristicvaluechanged", (e) => {
      const dv = (e.target as BluetoothRemoteGATTCharacteristic).value!;
      const flags = dv.getUint8(0);
      const bpm = flags & 0x01 ? dv.getUint16(1, true) : dv.getUint8(1);
      this.onHeartRate(bpm);
    });
  }

  disconnect(): void {
    this.device?.gatt?.disconnect();
  }
}
