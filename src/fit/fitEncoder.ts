/**
 * Minimal Garmin FIT activity encoder - no dependencies.
 * Produces files that Garmin Connect, Strava etc. import, including GPS
 * track, power, cadence, heart rate, speed, distance and altitude.
 */

// FIT base types
export const T = {
  enum: 0x00,
  u8: 0x02,
  s16: 0x83,
  u16: 0x84,
  s32: 0x85,
  u32: 0x86,
  u32z: 0x8c,
} as const;

const BASE_SIZE: Record<number, number> = {
  0x00: 1, 0x02: 1, 0x83: 2, 0x84: 2, 0x85: 4, 0x86: 4, 0x8c: 4,
};

export interface FitField {
  num: number;
  type: number;
  value: number;
}

const FIT_EPOCH_OFFSET = 631065600; // seconds between Unix epoch and FIT epoch (1989-12-31)

export function toFitTime(unixMs: number): number {
  return Math.round(unixMs / 1000) - FIT_EPOCH_OFFSET;
}

export function toSemicircles(deg: number): number {
  return Math.round((deg * 2147483648) / 180);
}

/** CRC-16 used by the FIT protocol. */
function crc16(bytes: Uint8Array, start = 0, end = bytes.length): number {
  const table = [
    0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401,
    0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400,
  ];
  let crc = 0;
  for (let i = start; i < end; i++) {
    const byte = bytes[i];
    let tmp = table[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ table[byte & 0xf];
    tmp = table[crc & 0xf];
    crc = (crc >> 4) & 0x0fff;
    crc = crc ^ tmp ^ table[(byte >> 4) & 0xf];
  }
  return crc;
}

export class FitEncoder {
  private chunks: number[] = [];
  /** local message type -> signature of its definition */
  private definitions = new Map<number, string>();

  /**
   * Write one message. The definition record is emitted automatically the
   * first time (or when the field layout for the local type changes).
   */
  writeMessage(localType: number, globalNum: number, fields: FitField[]): void {
    const sig = globalNum + ":" + fields.map((f) => `${f.num}/${f.type}`).join(",");
    if (this.definitions.get(localType) !== sig) {
      this.definitions.set(localType, sig);
      this.chunks.push(0x40 | localType); // definition header
      this.chunks.push(0); // reserved
      this.chunks.push(0); // little endian
      this.pushU16(globalNum);
      this.chunks.push(fields.length);
      for (const f of fields) {
        this.chunks.push(f.num, BASE_SIZE[f.type], f.type);
      }
    }
    this.chunks.push(localType); // data header
    for (const f of fields) {
      const size = BASE_SIZE[f.type];
      let v = Math.round(f.value);
      if (size === 1) {
        this.chunks.push(v & 0xff);
      } else if (size === 2) {
        this.pushU16(v & 0xffff);
      } else {
        // 4 bytes, handles signed via two's complement
        if (v < 0) v = v >>> 0;
        this.chunks.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
      }
    }
  }

  private pushU16(v: number): void {
    this.chunks.push(v & 0xff, (v >>> 8) & 0xff);
  }

  /** Final file bytes: header + data + CRC. */
  finish(): Uint8Array {
    const data = new Uint8Array(this.chunks);
    const header = new Uint8Array(14);
    const dv = new DataView(header.buffer);
    dv.setUint8(0, 14); // header size
    dv.setUint8(1, 0x10); // protocol 1.0
    dv.setUint16(2, 2132, true); // profile version
    dv.setUint32(4, data.length, true);
    header[8] = 0x2e; // .
    header[9] = 0x46; // F
    header[10] = 0x49; // I
    header[11] = 0x54; // T
    dv.setUint16(12, crc16(header, 0, 12), true);

    const out = new Uint8Array(header.length + data.length + 2);
    out.set(header, 0);
    out.set(data, header.length);
    const crc = crc16(out, 0, out.length - 2);
    out[out.length - 2] = crc & 0xff;
    out[out.length - 1] = (crc >>> 8) & 0xff;
    return out;
  }
}
