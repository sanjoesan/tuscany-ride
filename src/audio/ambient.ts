/**
 * Procedural ambient soundscape - wind, a rolling sea swell and the odd bird,
 * all synthesised with the Web Audio API. No audio files, so the game stays
 * fully self-contained and offline.
 *
 * The AudioContext is created lazily inside start(), which MUST be called from
 * a user gesture (a click or key press) or browsers block it (autoplay policy).
 * Importing this module never touches the audio API, so headless tools are safe.
 */
export class AmbientAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private seaLevel: GainNode | null = null;
  private windLevel: GainNode | null = null;
  private cicadaLevel: GainNode | null = null;
  private cicadasOn = false;
  private birdTimer: number | null = null;
  private muted: boolean;
  private night = false;
  private readonly level = 0.55;

  constructor() {
    this.muted = localStorage.getItem("roadgame.muted") === "1";
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** Build (once) and resume the graph. Call from a user-gesture handler. */
  start(): void {
    try {
      if (!this.ctx) this.build();
      if (this.ctx && this.ctx.state === "suspended") void this.ctx.resume();
    } catch {
      /* audio is a non-essential nicety - never let it break the ride */
    }
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    localStorage.setItem("roadgame.muted", this.muted ? "1" : "0");
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : this.level, this.ctx.currentTime, 0.12);
    }
    return this.muted;
  }

  /** Birds fall quiet after dusk. Cheap - safe to call every frame. */
  setNight(night: boolean): void {
    this.night = night;
  }

  /** Cicada chorus on summer days. Cheap & idempotent - safe to call every frame. */
  setCicadas(on: boolean): void {
    if (!this.ctx || !this.cicadaLevel || on === this.cicadasOn) return;
    this.cicadasOn = on;
    this.cicadaLevel.gain.setTargetAtTime(on ? 0.13 : 0, this.ctx.currentTime, 0.8);
  }

  /**
   * One struck church-bell tone: a stack of inharmonic partials (hum, prime,
   * tierce, quint, nominal...) with fast attacks and long, partial-dependent
   * decays. Called by the carillon controller on each swing of the campanile.
   */
  bellToll(f0 = 300): void {
    if (!this.ctx || !this.master || this.muted) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const partials = [
      { r: 0.5, g: 0.25, d: 3.4 }, // hum
      { r: 1.0, g: 0.5, d: 2.9 }, // prime
      { r: 1.19, g: 0.26, d: 2.1 }, // tierce (minor third - the brooding bell colour)
      { r: 1.5, g: 0.2, d: 1.7 }, // quint
      { r: 2.0, g: 0.18, d: 1.3 }, // nominal
      { r: 2.66, g: 0.1, d: 0.8 },
      { r: 3.36, g: 0.07, d: 0.5 },
    ];
    const out = ctx.createGain();
    out.gain.value = 0.5;
    out.connect(this.master);
    for (const p of partials) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = f0 * p.r;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(p.g, now + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0008, now + p.d);
      osc.connect(g).connect(out);
      osc.start(now);
      osc.stop(now + p.d + 0.1);
    }
  }

  /**
   * Adapt the mix to where the rider is. `coastDist` is metres inland from the
   * waterline (<=0 at/over the sea); `speedKmh` is the current ground speed.
   * Surf swells near the shore and fades ~1.2 km inland; wind rises with speed.
   * Smoothed via setTargetAtTime - fine to call a few times a second.
   */
  setScene(coastDist: number, speedKmh: number): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const near = 1 - smoothstep(120, 1200, Math.max(0, coastDist));
    if (this.seaLevel) this.seaLevel.gain.setTargetAtTime(0.05 + 0.4 * near, now, 0.6);
    const fast = Math.min(1, Math.max(0, speedKmh) / 45);
    if (this.windLevel) this.windLevel.gain.setTargetAtTime(0.24 + 0.4 * fast, now, 0.5);
  }

  // -------------------------------------------------------------------

  private build(): void {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    this.ctx = ctx;

    const master = ctx.createGain();
    master.gain.value = this.muted ? 0 : this.level;
    master.connect(ctx.destination);
    this.master = master;

    const noise = this.noiseBuffer(ctx, 2.3);

    // Each layer is: source -> filter -> swing (LFO wobble) -> level (scene
    // control, set by setScene) -> master. The LFO drives the swing's base so
    // the wobble scales with the layer; the level node is what we ride up/down
    // by proximity & speed without the wobble ever clipping to zero.

    // wind: airy band-passed noise that slowly breathes; louder at speed
    const wind = ctx.createBufferSource();
    wind.buffer = noise;
    wind.loop = true;
    const windFilt = ctx.createBiquadFilter();
    windFilt.type = "bandpass";
    windFilt.frequency.value = 480;
    windFilt.Q.value = 0.6;
    const windSwing = ctx.createGain();
    const windLevel = ctx.createGain();
    windLevel.gain.value = 0.3;
    wind.connect(windFilt).connect(windSwing).connect(windLevel).connect(master);
    wind.start();
    this.windLevel = windLevel;
    this.lfo(ctx, 0.06, 0.2, windSwing.gain, 0.5);
    this.lfo(ctx, 0.045, 220, windFilt.frequency, 480);

    // sea: a low rumble with a rolling ~9 s swell; louder near the coast
    const sea = ctx.createBufferSource();
    sea.buffer = noise;
    sea.loop = true;
    const seaFilt = ctx.createBiquadFilter();
    seaFilt.type = "lowpass";
    seaFilt.frequency.value = 360;
    seaFilt.Q.value = 0.7;
    const seaSwing = ctx.createGain();
    const seaLevel = ctx.createGain();
    seaLevel.gain.value = 0.25;
    sea.connect(seaFilt).connect(seaSwing).connect(seaLevel).connect(master);
    sea.start();
    this.seaLevel = seaLevel;
    this.lfo(ctx, 0.11, 0.18, seaSwing.gain, 0.55);

    // cicadas: a high band-passed buzz (white noise) with a fast tremolo and a
    // slow chorus swell. Off until setCicadas(true) on a summer day.
    const white = this.whiteNoise(ctx, 1.5);
    const cic = ctx.createBufferSource();
    cic.buffer = white;
    cic.loop = true;
    const cicHi = ctx.createBiquadFilter();
    cicHi.type = "highpass";
    cicHi.frequency.value = 3500;
    const cicBp = ctx.createBiquadFilter();
    cicBp.type = "bandpass";
    cicBp.frequency.value = 5200;
    cicBp.Q.value = 1.6;
    const trem = ctx.createGain();
    const swell = ctx.createGain();
    const cicLevel = ctx.createGain();
    cicLevel.gain.value = 0;
    cic.connect(cicHi).connect(cicBp).connect(trem).connect(swell).connect(cicLevel).connect(master);
    cic.start();
    this.cicadaLevel = cicLevel;
    this.lfo(ctx, 52, 0.5, trem.gain, 0.5); // fast tremolo = the buzz
    this.lfo(ctx, 0.13, 0.4, swell.gain, 0.6); // slow chorus swell

    this.scheduleBirds();
  }

  /** Flat white noise loop, for the high-frequency cicada buzz. */
  private whiteNoise(ctx: AudioContext, seconds: number): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  /** A short loop of leaky-integrated noise - bounded, low, surf-like. */
  private noiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.2;
    }
    return buf;
  }

  /** Drive an AudioParam with a slow sine so the layer never sits still. */
  private lfo(ctx: AudioContext, freq: number, depth: number, param: AudioParam, base: number): void {
    param.value = base;
    const osc = ctx.createOscillator();
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.value = depth;
    osc.connect(g).connect(param);
    osc.start();
  }

  private scheduleBirds(): void {
    const tick = (): void => {
      if (this.ctx && !this.muted && !this.night && Math.random() < 0.6) this.chirp();
      this.birdTimer = window.setTimeout(tick, 2500 + Math.random() * 4500);
    };
    this.birdTimer = window.setTimeout(tick, 1500 + Math.random() * 2000);
  }

  /** A brief warbling chirp built from a couple of fast pitch blips. */
  private chirp(): void {
    if (!this.ctx || !this.master) return;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const notes = 2 + Math.floor(Math.random() * 3);
    const baseF = 2200 + Math.random() * 1800;
    const g = ctx.createGain();
    g.gain.value = 0;
    g.connect(this.master);
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.connect(g);
    let tt = now;
    for (let i = 0; i < notes; i++) {
      const f = baseF * (1 + (Math.random() - 0.5) * 0.3);
      osc.frequency.setValueAtTime(f, tt);
      g.gain.setValueAtTime(0.0001, tt);
      g.gain.exponentialRampToValueAtTime(0.06, tt + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0008, tt + 0.09);
      tt += 0.09 + Math.random() * 0.05;
    }
    osc.start(now);
    osc.stop(tt + 0.05);
  }
}

/** Hermite smoothstep: 0 below `a`, 1 above `b`, eased in between. */
function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
