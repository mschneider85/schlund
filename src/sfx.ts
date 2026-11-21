/** Synthetisierte Soundeffekte per Web Audio API (keine Audiodateien nötig) */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private last = 0;
  muted = false;

  resume() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  private tone(type: OscillatorType, f0: number, f1: number, dur: number, vol: number, delay = 0) {
    const c = this.ctx;
    if (!c || this.muted) return;
    const t = c.currentTime + delay;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  /** "Plopp" – je schwerer, desto tiefer */
  gulp(weight: number) {
    const c = this.ctx;
    if (!c) return;
    if (c.currentTime - this.last < 0.035 && weight < 1) return;
    this.last = c.currentTime;
    const f = 700 / (1 + weight * 0.9) * (0.9 + Math.random() * 0.2);
    this.tone('sine', f * 1.6, f * 0.6, 0.12 + weight * 0.05, Math.min(0.5, 0.18 + weight * 0.08));
    if (weight >= 1.5) this.tone('triangle', 90, 40, 0.35, 0.35);
  }

  levelUp() {
    [523, 659, 784, 1047].forEach((f, i) => this.tone('triangle', f, f, 0.14, 0.22, i * 0.07));
  }

  /** Countdown-Ton; `go` = Startsignal */
  tick(go: boolean) { this.tone('square', go ? 880 : 440, go ? 880 : 440, go ? 0.35 : 0.12, 0.15); }

  hurt() { this.tone('sawtooth', 300, 60, 0.6, 0.3); }

  end(win: boolean) {
    const notes = win ? [523, 659, 784, 1047, 1319] : [392, 330, 262];
    notes.forEach((f, i) => this.tone('square', f, f, 0.18, 0.12, i * 0.12));
  }
}
