/**
 * Métronome Web Audio : les clics sont planifiés un peu en avance sur l'horloge audio
 * (et non avec setTimeout seul), ce qui garantit un tempo régulier même si la page est occupée.
 */
export class Metronome {
  private ctx?: AudioContext;
  private timer?: ReturnType<typeof setInterval>;
  private nextClick = 0;
  private bpm = 170;
  private volume = 0.5;

  /** À appeler depuis un geste utilisateur (clic) : les navigateurs l'exigent pour l'audio. */
  unlock(): void {
    const ctx = this.context();
    if (ctx.state === 'suspended') void ctx.resume();
  }

  get running(): boolean {
    return this.timer !== undefined;
  }

  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v));
  }

  setBpm(bpm: number): void {
    if (bpm > 0) this.bpm = bpm;
  }

  start(bpm: number): void {
    this.setBpm(bpm);
    if (this.running) return;
    const ctx = this.context();
    if (ctx.state === 'suspended') void ctx.resume();
    this.nextClick = ctx.currentTime + 0.05;
    this.schedule();
    this.timer = setInterval(() => this.schedule(), 25);
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  private context(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    return this.ctx;
  }

  private schedule(): void {
    const ctx = this.context();
    // Rattrapage si l'onglet a été mis en veille : on repart de maintenant.
    if (this.nextClick < ctx.currentTime - 0.2) this.nextClick = ctx.currentTime + 0.02;
    while (this.nextClick < ctx.currentTime + 0.12) {
      this.click(this.nextClick);
      this.nextClick += 60 / this.bpm;
    }
  }

  private click(t: number): void {
    if (this.volume <= 0) return;
    const ctx = this.context();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 1600;
    gain.gain.setValueAtTime(this.volume, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.035);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.04);
  }
}
