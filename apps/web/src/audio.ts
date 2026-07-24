/**
 * Sound design, fully synthesized with WebAudio — zero asset files, zero network requests.
 *
 * The brief is piece WEIGHT: short, physical, low. Synthesis keeps every sound tweakable in
 * code and gives the mobile app the same palette for free later (Expo AV can play rendered
 * buffers, or we re-synthesize with the same recipe).
 *
 * The AudioContext is created lazily on the first sound, because browsers refuse audio before
 * a user gesture — and the first sound always follows a tap.
 */

export type SoundName =
  | 'move' | 'capture' | 'check' | 'promote' | 'eliminate' | 'rotate' | 'gameover';

export class GameAudio {
  enabled = true;
  private ctx: AudioContext | null = null;

  private context(): AudioContext | null {
    if (this.ctx === null) {
      const Ctor = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
      if (Ctor === undefined) return null;
      this.ctx = new Ctor();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  play(name: SoundName): void {
    if (!this.enabled) return;
    const ctx = this.context();
    if (ctx === null) return;
    const t = ctx.currentTime + 0.005;

    switch (name) {
      case 'move':
        // A felt-bottomed piece set down: low sine thump plus a whisper of noise.
        this.thump(ctx, t, 150, 0.09, 0.5);
        this.noise(ctx, t, 0.03, 0.10, 1600);
        break;
      case 'capture':
        // Heavier: deeper thump, harder noise, a touch longer.
        this.thump(ctx, t, 105, 0.14, 0.85);
        this.noise(ctx, t, 0.06, 0.18, 900);
        break;
      case 'check':
        this.tone(ctx, t, 880, 0.10, 'triangle', 0.20);
        this.tone(ctx, t + 0.11, 659, 0.16, 'triangle', 0.16);
        break;
      case 'promote':
        this.tone(ctx, t, 523, 0.09, 'sine', 0.18);
        this.tone(ctx, t + 0.09, 659, 0.09, 'sine', 0.18);
        this.tone(ctx, t + 0.18, 784, 0.16, 'sine', 0.20);
        break;
      case 'eliminate':
        this.tone(ctx, t, 392, 0.16, 'sawtooth', 0.10);
        this.tone(ctx, t + 0.17, 311, 0.16, 'sawtooth', 0.10);
        this.tone(ctx, t + 0.34, 233, 0.30, 'sawtooth', 0.12);
        break;
      case 'rotate':
        this.noise(ctx, t, 0.28, 0.05, 500);
        break;
      case 'gameover':
        for (const [i, f] of [523, 659, 784, 1047].entries()) {
          this.tone(ctx, t + i * 0.10, f, 0.5, 'sine', 0.12);
        }
        break;
    }
  }

  private tone(
    ctx: AudioContext, at: number, freq: number, dur: number,
    type: OscillatorType, gain: number,
  ): void {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(gain, at + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  }

  /** Pitch-dropping sine — the body of a piece landing on the board. */
  private thump(ctx: AudioContext, at: number, freq: number, dur: number, gain: number): void {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, at);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.45, at + dur);
    g.gain.setValueAtTime(gain, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + dur + 0.02);
  }

  /** Low-passed noise burst — contact texture. */
  private noise(ctx: AudioContext, at: number, dur: number, gain: number, cutoff: number): void {
    const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(filter).connect(g).connect(ctx.destination);
    src.start(at);
  }
}
