/**
 * Power -> speed simulation using the standard road cycling model:
 *   P = (F_gravity + F_rolling + F_aero) * v
 * integrated as a dynamic system so accelerations feel natural.
 */

const G = 9.81;
const RHO = 1.2; // air density kg/m^3
const CRR = 0.004; // rolling resistance (good road tires on asphalt)
const CDA = 0.32; // m^2, road bike on the hoods

export class BikePhysics {
  /** total mass rider + bike, kg */
  massKg = 84;
  /** current speed m/s */
  v = 0;

  /**
   * Advance the simulation.
   * @param powerW rider power in watts
   * @param grade slope as fraction (0.05 = 5 %)
   * @param dt timestep seconds
   */
  step(powerW: number, grade: number, dt: number): number {
    const theta = Math.atan(grade);
    const m = this.massKg;
    // resistive forces at current speed
    const fGrav = m * G * Math.sin(theta);
    const fRoll = m * G * CRR * Math.cos(theta) * (this.v > 0.1 ? 1 : 0);
    const fAero = 0.5 * RHO * CDA * this.v * this.v * Math.sign(this.v);
    // propulsive force: P/v with a floor so starting from standstill works
    const fProp = powerW > 0 ? powerW / Math.max(this.v, 1.2) : 0;
    const a = (fProp - fGrav - fRoll - fAero) / m;
    this.v += a * dt;
    // freewheeling downhill is fine; rolling backwards is not
    if (this.v < 0) this.v = 0;
    // hard cap for sanity (~ 100 km/h)
    if (this.v > 28) this.v = 28;
    return this.v;
  }

  get kmh(): number {
    return this.v * 3.6;
  }
}
