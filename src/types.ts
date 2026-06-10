/** Shared data types for map, telemetry and ride recording. */

export type SceneryType =
  | "cypress"
  | "pine"
  | "olive"
  | "house"
  | "villa"
  | "barn"
  | "church"
  | "tower";

export interface SceneryItem {
  type: SceneryType;
  x: number;
  z: number;
  /** rotation around Y in radians */
  rot: number;
  scale: number;
}

export interface MapData {
  name: string;
  /** terrain noise seed */
  seed: number;
  /** world is size x size meters, centered on origin */
  size: number;
  /** hill amplitude in meters */
  hilliness: number;
  /** x coordinate where land meets the sea (sea occupies x < coastX) */
  coastX: number;
  /** closed-loop road control points [x, z] */
  road: [number, number][];
  town: { x: number; z: number; radius: number };
  /** manually placed scenery (world builder); procedural scenery is derived from seed */
  scenery: SceneryItem[];
}

/** Live values coming from the trainer / sensors. */
export interface Telemetry {
  /** watts */
  power: number;
  /** rpm */
  cadence: number;
  /** bpm, 0 = unknown */
  heartRate: number;
  /** km/h as reported by trainer (informational; game speed is physics-based) */
  trainerSpeed: number;
}

export interface RideSample {
  /** ms since epoch */
  t: number;
  power: number;
  cadence: number;
  heartRate: number;
  /** m/s simulated */
  speed: number;
  /** meters total */
  distance: number;
  /** meters above sea level */
  altitude: number;
  lat: number;
  lon: number;
}

export interface RideStats {
  startTime: number;
  durationS: number;
  distanceM: number;
  avgPower: number;
  maxPower: number;
  avgCadence: number;
  avgHr: number;
  maxHr: number;
  avgSpeedKmh: number;
  maxSpeedKmh: number;
  elevationGainM: number;
  calories: number;
}
