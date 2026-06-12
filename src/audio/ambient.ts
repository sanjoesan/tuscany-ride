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
  private windGain: GainNode | null = null;
  private seaGain: GainNode | null = null;
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

    // wind: airy band-passed noise that slowly breathes
    const wind = ctx.createBufferSource();
    wind.buffer = noise;
    wind.loop = true;
    const windFilt = ctx.createBiquadFilter();
    windFilt.type = "bandpass";
    windFilt.frequency.value = 480;
    windFilt.Q.value = 0.6;
    const windGain = ctx.createGain();
    wind.connect(windFilt).connect(windGain).connect(master);
    wind.start();
    this.windGain = windGain;
    this.lfo(ctx, 0.06, 0.07, windGain.gain, 0.17);
    this.lfo(ctx, 0.045, 220, windFilt.frequency, 480);

    // sea: a low rumble with a rolling ~9 s swell
    const sea = ctx.createBufferSource();
    sea.buffer = noise;
    sea.loop = true;
    const seaFilt = ctx.createBiquadFilter();
    seaFilt.type = "lowpass";
    seaFilt.frequency.value = 360;
    seaFilt.Q.value = 0.7;
    const seaGain = ctx.createGain();
    sea.connect(seaFilt).connect(seaGain).connect(master);
    sea.start();
    this.seaGain = seaGain;
    this.lfo(ctx, 0.11, 0.16, seaGain.gain, 0.22);

    this.scheduleBirds();
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
